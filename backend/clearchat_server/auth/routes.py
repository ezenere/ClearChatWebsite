"""Autenticação (§5, §6.3): cadastro e login por código, convites, refresh rotativo, logout, reauth."""

from __future__ import annotations

import re
import uuid
from typing import Any

from fastapi import APIRouter, BackgroundTasks, Depends, Request, Response
from fastapi.responses import JSONResponse

from ..chatstate import load_state, serialize
from ..context import AppContext, get_ctx, request_ip
from ..db import execute, fetchone
from ..errors import ApiError
from ..keys.routes import keys_response
from ..mail import code_mail, existing_account_mail
from ..ratelimit import HOUR, Limit
from ..security import sha256, token_hash
from ..services.accounts import log_activity, revoke_devices
from ..util import normalize_email, utcnow, valid_email
from .codes import issue_code, request_limits, verify_code
from .deps import current_principal
from .tokens import Principal, create_device, find_reused_refresh, issue_tokens
from .turnstile import verify_turnstile

router = APIRouter()

PLATFORM_RE = re.compile(r"\A[a-z0-9_-]{1,32}\Z")
REFRESH_COOKIE = "cc_refresh"


async def _body(request: Request) -> dict[str, Any]:
    try:
        body = await request.json()
    except ValueError as e:
        raise ApiError("invalid_request", details={"reason": "json"}) from e
    if not isinstance(body, dict):
        raise ApiError("invalid_request")
    return body


def _email(body: dict[str, Any]) -> str:
    raw = body.get("email")
    if not isinstance(raw, str):
        raise ApiError("invalid_request", details={"field": "email"})
    email = normalize_email(raw)
    if not valid_email(email):
        raise ApiError("invalid_request", details={"field": "email"})
    return email


def _device(body: dict[str, Any]) -> dict[str, Any]:
    d = body.get("device")
    if not isinstance(d, dict):
        raise ApiError("invalid_request", details={"field": "device"})
    name, platform, client, version, can_host = (
        d.get("name"),
        d.get("platform"),
        d.get("client"),
        d.get("app_version"),
        d.get("can_host"),
    )
    if not isinstance(name, str) or not 1 <= len(name.strip()) <= 64:
        raise ApiError("invalid_request", details={"field": "device.name"})
    if not isinstance(platform, str) or not PLATFORM_RE.match(platform):
        raise ApiError("invalid_request", details={"field": "device.platform"})
    if client not in ("desktop", "mobile", "web"):  # 'gateway' é reservado (§21): v1 recusa
        raise ApiError("invalid_request", details={"field": "device.client"})
    if not isinstance(version, str) or not 1 <= len(version) <= 64:
        raise ApiError("invalid_request", details={"field": "device.app_version"})
    if not isinstance(can_host, bool):
        raise ApiError("invalid_request", details={"field": "device.can_host"})
    return {"name": name.strip(), "platform": platform, "client": client, "app_version": version, "can_host": can_host}


async def _captcha(ctx: AppContext, body: dict[str, Any], action: str, ip: str | None) -> None:
    inst = await ctx.instance.get()
    if inst.captcha_active(ctx.settings):
        tok = body.get("turnstile_token")
        await verify_turnstile(ctx.http, ctx.settings, tok if isinstance(tok, str) else None, action, ip)


def _cookie_path(ctx: AppContext) -> str:
    return f"{ctx.settings.base_path}/api/v1/auth"


def _set_refresh_cookie(ctx: AppContext, resp: Response, token: str) -> None:
    resp.set_cookie(
        REFRESH_COOKIE,
        token,
        max_age=ctx.settings.refresh_token_ttl_days * 86400,
        path=_cookie_path(ctx),
        httponly=True,
        secure=ctx.settings.is_https,
        samesite="strict",
    )


def _auth_response(
    ctx: AppContext, status: int, tokens: dict[str, Any], user: Any, device_id: uuid.UUID, client: str
) -> Response:
    body = dict(tokens)
    refresh = body["refresh_token"]
    if client == "web":
        body.pop("refresh_token")
    body.update(
        {
            "user": {"id": str(user.id), "email": str(user.email), "name": user.name},
            "device_id": str(device_id),
            "keys_ready": bool(user.keys_ready),
            "keys": keys_response(user),
        }
    )
    resp = JSONResponse(body, status_code=status)
    if client == "web":
        _set_refresh_cookie(ctx, resp, refresh)
    return resp


async def _check_device_quota(conn: Any, user: Any) -> None:
    if user.quota_devices is None:
        return
    n = await fetchone(
        conn, "SELECT count(*) AS n FROM devices WHERE user_id = :u AND revoked_at IS NULL", {"u": user.id}
    )
    used = int(n.n) if n else 0
    if used + 1 > int(user.quota_devices):
        raise ApiError("quota_exceeded", details={"kind": "devices", "used": used, "limit": int(user.quota_devices)})


async def _invite_row(conn: Any, token: Any, email: str | None) -> Any:
    if not isinstance(token, str) or not 10 <= len(token) <= 128:
        return None
    row = await fetchone(conn, "SELECT * FROM invites WHERE token_hash = :h", {"h": sha256(token.encode())})
    if row is None or row.used_at is not None or row.revoked_at is not None or row.expires_at <= utcnow():
        return None
    if email is not None and row.email is not None and str(row.email).lower() != email:
        return None
    return row


# Códigos fantasmas: quando nenhum e-mail com código é enviado (login de conta inexistente ou banida,
# cadastro de conta existente), um código aleatório é gravado mesmo assim e nunca enviado. Só erros contra
# um código vivo contam para o bloqueio do verify (codes.verify_code); sem o fantasma, chegar (ou não) ao
# bloqueio revelaria se a conta existe. Ninguém conhece o fantasma, e as rotas de verify recusam o uso dele
# (conta inexistente/banida no login, conta já existente no cadastro) com o mesmo `code_invalid`.


# ---------------------------------------------------------------- convites
@router.get("/auth/invite/{token}")
async def invite_info(token: str, ctx: AppContext = Depends(get_ctx)) -> Any:
    async with ctx.engine.connect() as conn:
        row = await _invite_row(conn, token, None)
    if row is None:
        return {"valid": False}
    out: dict[str, Any] = {"valid": True}
    if row.email is not None:
        out["email"] = str(row.email)
    return out


# ---------------------------------------------------------------- cadastro
@router.post("/auth/signup/start", status_code=202)
async def signup_start(request: Request, background: BackgroundTasks, ctx: AppContext = Depends(get_ctx)) -> Any:
    body = await _body(request)
    email = _email(body)
    name = body.get("name")
    if not isinstance(name, str) or not 1 <= len(name.strip()) <= 100:
        raise ApiError("invalid_request", details={"field": "name"})
    name = name.strip()
    ip = request_ip(request)
    await _captcha(ctx, body, "signup", ip)
    inst = await ctx.instance.get()
    invite_token = body.get("invite_token")
    invite_id = None
    async with ctx.engine.connect() as conn:
        if invite_token is not None:
            inv = await _invite_row(conn, invite_token, email)
            if inv is None:
                raise ApiError("invite_invalid")
            invite_id = inv.id
        elif not inst.signup_open:
            raise ApiError("signup_closed")
    await request_limits(ctx, email, ip)
    async with ctx.engine.begin() as conn:
        user = await fetchone(conn, "SELECT id, status FROM users WHERE email = :e", {"e": email})
        if user is None:
            code = await issue_code(conn, ctx, email, "signup", pending_name=name, invite_id=invite_id, ip=ip)
            background.add_task(
                ctx.mailer.send, code_mail(email, code, "signup", inst.instance_name, ctx.settings.email_code_ttl_s)
            )
        else:
            if user.status == "active":
                login_url = f"{ctx.settings.public_base_url}/login"
                background.add_task(ctx.mailer.send, existing_account_mail(email, inst.instance_name, login_url))
            # conta banida: nada é enviado (resposta idêntica)
            await issue_code(conn, ctx, email, "signup", ip=ip)  # código fantasma (ver "Códigos fantasmas")
    return {"ok": True}


@router.post("/auth/signup/verify", status_code=201)
async def signup_verify(request: Request, ctx: AppContext = Depends(get_ctx)) -> Response:
    body = await _body(request)
    email = _email(body)
    device = _device(body)
    ip = request_ip(request)
    row = await verify_code(ctx, email, body.get("code"), "signup", ip)
    inst = await ctx.instance.get()
    s = ctx.settings
    async with ctx.engine.begin() as conn:
        if await fetchone(conn, "SELECT 1 FROM users WHERE email = :e", {"e": email}) is not None:
            raise ApiError("code_invalid")
        created_by = "signup"
        if row.invite_id is not None:
            inv = await fetchone(conn, "SELECT * FROM invites WHERE id = :i FOR UPDATE", {"i": row.invite_id})
            if inv is None or inv.used_at is not None or inv.revoked_at is not None or inv.expires_at <= utcnow():
                raise ApiError("invite_invalid")
            if inv.email is not None and str(inv.email).lower() != email:
                raise ApiError("invite_invalid")
            created_by = "invite"
        elif not inst.signup_open:
            raise ApiError("signup_closed")
        user = await fetchone(
            conn,
            "INSERT INTO users (email, name, created_by, quota_record_bytes, quota_records, quota_blob_bytes, "
            "quota_devices, last_seen_at) VALUES (:e, :n, :cb, :q1, :q2, :q3, :q4, now()) RETURNING *",
            {
                "e": email,
                "n": row.pending_name or email.split("@")[0],
                "cb": created_by,
                "q1": s.default_quota_record_bytes,
                "q2": s.default_quota_records,
                "q3": s.default_quota_blob_bytes,
                "q4": s.default_quota_devices,
            },
        )
        assert user is not None
        if row.invite_id is not None:
            await execute(
                conn,
                "UPDATE invites SET used_at = now(), used_by = :u WHERE id = :i",
                {"u": user.id, "i": row.invite_id},
            )
        await _check_device_quota(conn, user)
        device_id = await create_device(conn, user.id, device, ip)
        tokens = await issue_tokens(conn, s, user.id, device_id)
        await log_activity(conn, "signup", user.id, device_id, ip, {"via": created_by})
    return _auth_response(ctx, 201, tokens, user, device_id, device["client"])


# ---------------------------------------------------------------- login
@router.post("/auth/code/request", status_code=202)
async def code_request(request: Request, background: BackgroundTasks, ctx: AppContext = Depends(get_ctx)) -> Any:
    body = await _body(request)
    email = _email(body)
    ip = request_ip(request)
    await _captcha(ctx, body, "login", ip)
    await request_limits(ctx, email, ip)
    inst = await ctx.instance.get()
    async with ctx.engine.begin() as conn:
        user = await fetchone(conn, "SELECT id, status FROM users WHERE email = :e", {"e": email})
        if user is not None and user.status == "active":
            code = await issue_code(conn, ctx, email, "login", user_id=user.id, ip=ip)
            background.add_task(
                ctx.mailer.send, code_mail(email, code, "login", inst.instance_name, ctx.settings.email_code_ttl_s)
            )
        else:
            await issue_code(conn, ctx, email, "login", ip=ip)  # código fantasma (ver "Códigos fantasmas")
    return {"ok": True}


@router.post("/auth/code/verify")
async def code_verify(request: Request, ctx: AppContext = Depends(get_ctx)) -> Response:
    body = await _body(request)
    email = _email(body)
    device = _device(body)
    ip = request_ip(request)
    await verify_code(ctx, email, body.get("code"), "login", ip)
    async with ctx.engine.begin() as conn:
        user = await fetchone(conn, "SELECT * FROM users WHERE email = :e FOR UPDATE", {"e": email})
        if user is None or user.status != "active":
            raise ApiError("code_invalid")
        await _check_device_quota(conn, user)
        device_id = await create_device(conn, user.id, device, ip)
        tokens = await issue_tokens(conn, ctx.settings, user.id, device_id)
        await execute(conn, "UPDATE users SET last_seen_at = now() WHERE id = :u", {"u": user.id})
        await log_activity(conn, "login", user.id, device_id, ip, {"client": device["client"]})
    return _auth_response(ctx, 200, tokens, user, device_id, device["client"])


# ---------------------------------------------------------------- tokens
@router.post("/auth/refresh")
async def refresh(request: Request, ctx: AppContext = Depends(get_ctx)) -> Response:
    try:
        body = await request.json()
    except ValueError:
        body = {}
    token = body.get("refresh_token") if isinstance(body, dict) else None
    from_cookie = False
    if not token:
        token = request.cookies.get(REFRESH_COOKIE)
        from_cookie = True
    if not isinstance(token, str) or not token.startswith("ccr_") or len(token) > 100:
        raise ApiError("unauthorized")
    h = token_hash(token)
    async with ctx.engine.connect() as conn:
        dev = await fetchone(
            conn,
            "SELECT d.id, d.user_id, d.client, d.revoked_at, d.refresh_expires_at, u.status FROM devices d "
            "JOIN users u ON u.id = d.user_id WHERE d.refresh_hash = :h",
            {"h": h},
        )
        reused = None
        if dev is None:  # algum refresh já rotacionado deste dispositivo (qualquer geração)?
            reused = await find_reused_refresh(conn, h)
    if dev is None:
        if reused is not None:
            async with ctx.engine.begin() as conn:
                _, chats = await revoke_devices(conn, reused.user_id, [reused.id])
                await log_activity(conn, "refresh_reused", reused.user_id, reused.id, request_ip(request))
            await _after_revoke(ctx, reused.user_id, [reused.id], chats)
            raise ApiError("refresh_reused")
        raise ApiError("unauthorized")
    if dev.revoked_at is not None:
        raise ApiError("device_revoked")
    if dev.status != "active":
        raise ApiError("account_disabled")
    if dev.refresh_expires_at is None or dev.refresh_expires_at <= utcnow():
        raise ApiError("unauthorized", details={"reason": "expired"})
    await ctx.limiter.hit([Limit(f"refresh:device:{dev.id}", 60, HOUR)])
    async with ctx.engine.begin() as conn:
        locked = await fetchone(
            conn,
            "SELECT id FROM devices WHERE id = :d AND refresh_hash = :h AND revoked_at IS NULL FOR UPDATE",
            {"d": dev.id, "h": h},
        )
        if locked is None:  # rotacionado por outra requisição no meio-tempo
            raise ApiError("unauthorized")
        tokens = await issue_tokens(conn, ctx.settings, dev.user_id, dev.id, rotate_from=h)
    refresh_token = tokens["refresh_token"]
    if dev.client == "web" or from_cookie:
        tokens.pop("refresh_token")
    resp = JSONResponse(tokens)
    if dev.client == "web" or from_cookie:
        _set_refresh_cookie(ctx, resp, refresh_token)
    return resp


async def _after_revoke(ctx: AppContext, user_id: uuid.UUID, device_ids: list[uuid.UUID], chats: list[str]) -> None:
    # revogado nunca mais conecta: os host.revoked guardados para ele saem da memória
    ctx.coordinator.forget_devices(device_ids)
    for d in device_ids:
        ctx.hub.close_device(d, 4403, "device_revoked")
    if chats:
        async with ctx.engine.connect() as conn:
            for chat_id in chats:
                row = await load_state(conn, user_id, chat_id)
                if row is not None:
                    ctx.coordinator.broadcast_state(
                        user_id, serialize(row, ctx.hub.is_online, {"kind": "host_changed", "reason": "device_revoked"})
                    )


@router.post("/auth/logout", status_code=204)
async def logout(
    request: Request, p: Principal = Depends(current_principal), ctx: AppContext = Depends(get_ctx)
) -> Response:
    async with ctx.engine.begin() as conn:
        ids, chats = await revoke_devices(conn, p.user_id, [p.device_id])
        await log_activity(conn, "logout", p.user_id, p.device_id, request_ip(request))
    await _after_revoke(ctx, p.user_id, ids, chats)
    resp = Response(status_code=204)
    resp.delete_cookie(REFRESH_COOKIE, path=_cookie_path(ctx))
    return resp


@router.post("/auth/reauth/request", status_code=202)
async def reauth_request(
    request: Request,
    background: BackgroundTasks,
    p: Principal = Depends(current_principal),
    ctx: AppContext = Depends(get_ctx),
) -> Any:
    body = await _body(request)
    purpose = body.get("purpose")
    if purpose not in ("delete_account", "reset_keys"):
        raise ApiError("invalid_request", details={"field": "purpose"})
    await ctx.limiter.hit([Limit(f"reauth:user:{p.user_id}", 5, HOUR)])
    inst = await ctx.instance.get()
    async with ctx.engine.begin() as conn:
        code = await issue_code(conn, ctx, p.email, purpose, user_id=p.user_id, ip=request_ip(request))
    background.add_task(
        ctx.mailer.send, code_mail(p.email, code, purpose, inst.instance_name, ctx.settings.email_code_ttl_s)
    )
    return {"ok": True}
