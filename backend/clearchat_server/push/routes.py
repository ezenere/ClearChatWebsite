"""Rotas de push (§22.2, §22.3): token do dispositivo e envio."""

from __future__ import annotations

import uuid
from typing import Any

from fastapi import APIRouter, Depends, Request, Response

from ..auth.deps import current_principal
from ..auth.routes import _body
from ..auth.tokens import Principal
from ..context import AppContext, get_ctx
from ..db import execute
from ..errors import ApiError
from ..ratelimit import HOUR, Limit
from ..sync.envelope import parse_envelope
from .service import (
    CLIENT_KINDS,
    PUSH_MAX_ENV_BYTES,
    PUSH_MAX_TO,
    TAG_RE,
    TOKEN_MAX_CHARS,
    env_json,
    push_targets,
)

router = APIRouter()


@router.put("/devices/current/push", status_code=204)
async def put_push_token(
    request: Request, p: Principal = Depends(current_principal), ctx: AppContext = Depends(get_ctx)
) -> Response:
    await ctx.limiter.hit([Limit(f"push-token:device:{p.device_id}", 30, HOUR)])
    body = await _body(request)
    provider = body.get("provider")
    if provider != "fcm":  # 'apns' reservado (§22.1)
        raise ApiError("invalid_request", details={"field": "provider"})
    token = body.get("token")
    if not isinstance(token, str) or not 1 <= len(token) <= TOKEN_MAX_CHARS or token != token.strip():
        raise ApiError("invalid_request", details={"field": "token"})
    async with ctx.engine.begin() as conn:
        # um token pertence a um dispositivo só: o mesmo aparelho reinstalado/noutra conta deixa de
        # receber os avisos do dispositivo antigo (que nunca mais decifraria nada)
        await execute(
            conn,
            "UPDATE devices SET push_token = NULL, push_provider = NULL, push_updated_at = now() "
            "WHERE push_token = :t AND id <> :d",
            {"t": token, "d": p.device_id},
        )
        await execute(
            conn,
            "UPDATE devices SET push_provider = :p, push_token = :t, push_updated_at = now() WHERE id = :d",
            {"p": provider, "t": token, "d": p.device_id},
        )
    return Response(status_code=204)


@router.delete("/devices/current/push", status_code=204)
async def delete_push_token(p: Principal = Depends(current_principal), ctx: AppContext = Depends(get_ctx)) -> Response:
    async with ctx.engine.begin() as conn:
        await execute(
            conn,
            "UPDATE devices SET push_token = NULL, push_provider = NULL, push_updated_at = now() "
            "WHERE id = :d AND push_token IS NOT NULL",
            {"d": p.device_id},
        )
    return Response(status_code=204)


def _parse_to(raw: Any) -> list[uuid.UUID] | None:
    if raw == "all":
        return None
    if not isinstance(raw, list) or len(raw) > PUSH_MAX_TO or not all(isinstance(x, str) for x in raw):
        raise ApiError("invalid_request", details={"field": "to"})
    out: list[uuid.UUID] = []
    for x in raw:
        try:
            out.append(uuid.UUID(x))
        except ValueError as e:
            raise ApiError("invalid_request", details={"field": "to"}) from e
    return out


@router.post("/push")
async def send_push(
    request: Request, p: Principal = Depends(current_principal), ctx: AppContext = Depends(get_ctx)
) -> Any:
    push = ctx.push
    if not push.configured:
        raise ApiError("push_unavailable")
    await ctx.limiter.hit([Limit(f"push:device:{p.device_id}", 120, HOUR), Limit(f"push:user:{p.user_id}", 300, HOUR)])
    body = await _body(request)
    kind = body.get("kind")
    if not isinstance(kind, str) or kind not in CLIENT_KINDS:
        raise ApiError("invalid_request", details={"field": "kind"})
    tag = body.get("tag")
    if not isinstance(tag, str) or not TAG_RE.match(tag):
        raise ApiError("invalid_request", details={"field": "tag"})
    to = _parse_to(body.get("to"))
    env = body.get("env")
    if kind == "dismiss":
        if env is not None:
            raise ApiError("invalid_request", details={"field": "env", "reason": "dismiss"})
        env_s = ""
    else:
        if env is None:
            raise ApiError("invalid_request", details={"field": "env", "reason": "required"})
        # repassa a forma canônica (só v/k/n/c); o teto vale para o JSON do envelope (§22.3, §17.1)
        env_s = env_json(parse_envelope(env, max_bytes=PUSH_MAX_ENV_BYTES).to_json())
        if len(env_s.encode()) > PUSH_MAX_ENV_BYTES:
            raise ApiError("payload_too_large", details={"field": "env", "limit": PUSH_MAX_ENV_BYTES})
    async with ctx.engine.connect() as conn:
        targets = await push_targets(conn, p.user_id, p.device_id, to)
    push.dispatch(targets, kind, tag, env_s, from_device=p.device_id)
    return {"sent": len(targets)}
