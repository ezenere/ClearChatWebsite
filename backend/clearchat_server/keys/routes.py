"""Chaves (§6.5): wraps da DEK (senha e recuperação), verifier e prova de posse."""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, Request, Response

from ..auth.codes import verify_code
from ..auth.deps import current_principal
from ..auth.tokens import Principal
from ..context import AppContext, get_ctx, request_ip
from ..db import execute, fetchone
from ..errors import ApiError
from ..security import ct_equal, sha256
from ..services.accounts import log_activity, wipe_user_data
from ..sync.envelope import parse_b64_len, parse_kdf, parse_wrap
from ..util import b64u_encode

router = APIRouter()


def keys_response(u: Any) -> dict[str, Any] | None:
    if not u.keys_ready:
        return None
    kdf = dict(u.kdf)
    return {
        "key_version": int(u.key_version),
        "keys_rev": int(u.keys_rev),
        "password": {
            "kdf": kdf,
            "salt": b64u_encode(bytes(u.pw_salt)),
            "wrap": {"n": b64u_encode(bytes(u.pw_wrap_nonce)), "c": b64u_encode(bytes(u.pw_wrap_ct))},
        },
        "recovery": {
            "kdf": {"alg": "hkdf-sha256"},
            "salt": b64u_encode(bytes(u.rk_salt)),
            "wrap": {"n": b64u_encode(bytes(u.rk_wrap_nonce)), "c": b64u_encode(bytes(u.rk_wrap_ct))},
        },
    }


def _password_slot(body: Any) -> tuple[dict[str, Any], bytes, bytes, bytes]:
    if not isinstance(body, dict):
        raise ApiError("invalid_request", details={"field": "password"})
    kdf = parse_kdf(body.get("kdf"))
    salt = parse_b64_len(body.get("salt"), 16, "password.salt")
    n, c = parse_wrap(body.get("wrap"), "password.wrap")
    return kdf, salt, n, c


def _recovery_slot(body: Any) -> tuple[bytes, bytes, bytes]:
    if not isinstance(body, dict) or not isinstance(body.get("kdf"), dict) or body["kdf"].get("alg") != "hkdf-sha256":
        raise ApiError("invalid_request", details={"field": "recovery.kdf"})
    salt = parse_b64_len(body.get("salt"), 16, "recovery.salt")
    n, c = parse_wrap(body.get("wrap"), "recovery.wrap")
    return salt, n, c


def _check_proof(u: Any, key_proof: Any) -> None:
    try:
        proof = parse_b64_len(key_proof, 32, "key_proof")
    except ApiError as e:
        raise ApiError("key_proof_invalid") from e
    if u.key_verifier is None or not ct_equal(sha256(proof), bytes(u.key_verifier)):
        raise ApiError("key_proof_invalid")


async def _body(request: Request) -> Any:
    try:
        return await request.json()
    except ValueError as e:
        raise ApiError("invalid_request", details={"reason": "json"}) from e


@router.get("/keys")
async def get_keys(p: Principal = Depends(current_principal), ctx: AppContext = Depends(get_ctx)) -> Any:
    async with ctx.engine.connect() as conn:
        u = await fetchone(conn, "SELECT * FROM users WHERE id = :u", {"u": p.user_id})
    kr = keys_response(u)
    if kr is None:
        raise ApiError("keys_not_ready")
    return kr


@router.post("/keys/setup")
async def keys_setup(
    request: Request, p: Principal = Depends(current_principal), ctx: AppContext = Depends(get_ctx)
) -> Any:
    body = await _body(request)
    if not isinstance(body, dict):
        raise ApiError("invalid_request")
    kdf, pw_salt, pw_n, pw_c = _password_slot(body.get("password"))
    rk_salt, rk_n, rk_c = _recovery_slot(body.get("recovery"))
    verifier = parse_b64_len(body.get("verifier"), 32, "verifier")
    import json

    async with ctx.engine.begin() as conn:
        u = await fetchone(conn, "SELECT keys_ready FROM users WHERE id = :u FOR UPDATE", {"u": p.user_id})
        assert u is not None
        if u.keys_ready:
            raise ApiError("keys_already_set")
        await execute(
            conn,
            "UPDATE users SET keys_ready = true, key_version = 1, keys_rev = keys_rev + 1, kdf = CAST(:kdf AS jsonb), "
            "pw_salt = :ps, pw_wrap_nonce = :pn, pw_wrap_ct = :pc, rk_salt = :rs, rk_wrap_nonce = :rn, rk_wrap_ct = :rc, "
            "key_verifier = :v WHERE id = :u",
            {
                "u": p.user_id,
                "kdf": json.dumps(kdf),
                "ps": pw_salt,
                "pn": pw_n,
                "pc": pw_c,
                "rs": rk_salt,
                "rn": rk_n,
                "rc": rk_c,
                "v": verifier,
            },
        )
        await log_activity(conn, "keys_setup", p.user_id, p.device_id, request_ip(request))
        u2 = await fetchone(conn, "SELECT * FROM users WHERE id = :u", {"u": p.user_id})
    kr = keys_response(u2)
    assert kr is not None
    ctx.hub.send_user(p.user_id, {"t": "keys.changed", "keys_rev": kr["keys_rev"]})
    return kr


async def _replace_slot(request: Request, p: Principal, ctx: AppContext, slot: str) -> Any:
    body = await _body(request)
    if not isinstance(body, dict):
        raise ApiError("invalid_request")
    import json

    async with ctx.engine.begin() as conn:
        u = await fetchone(conn, "SELECT * FROM users WHERE id = :u FOR UPDATE", {"u": p.user_id})
        if u is None or not u.keys_ready:
            raise ApiError("keys_not_ready")
        _check_proof(u, body.get("key_proof"))
        if slot == "password":
            kdf, s, n, c = _password_slot(body.get("password"))
            await execute(
                conn,
                "UPDATE users SET kdf = CAST(:kdf AS jsonb), pw_salt = :s, pw_wrap_nonce = :n, pw_wrap_ct = :c, "
                "keys_rev = keys_rev + 1 WHERE id = :u",
                {"u": p.user_id, "kdf": json.dumps(kdf), "s": s, "n": n, "c": c},
            )
        else:
            s, n, c = _recovery_slot(body.get("recovery"))
            await execute(
                conn,
                "UPDATE users SET rk_salt = :s, rk_wrap_nonce = :n, rk_wrap_ct = :c, keys_rev = keys_rev + 1 WHERE id = :u",
                {"u": p.user_id, "s": s, "n": n, "c": c},
            )
        await log_activity(conn, f"{slot}_changed", p.user_id, p.device_id, request_ip(request))
        u2 = await fetchone(conn, "SELECT * FROM users WHERE id = :u", {"u": p.user_id})
    kr = keys_response(u2)
    assert kr is not None
    ctx.hub.send_user(p.user_id, {"t": "keys.changed", "keys_rev": kr["keys_rev"]})
    return kr


@router.put("/keys/password")
async def keys_password(
    request: Request, p: Principal = Depends(current_principal), ctx: AppContext = Depends(get_ctx)
) -> Any:
    return await _replace_slot(request, p, ctx, "password")


@router.put("/keys/recovery")
async def keys_recovery(
    request: Request, p: Principal = Depends(current_principal), ctx: AppContext = Depends(get_ctx)
) -> Any:
    return await _replace_slot(request, p, ctx, "recovery")


@router.post("/keys/reset", status_code=204)
async def keys_reset(
    request: Request, p: Principal = Depends(current_principal), ctx: AppContext = Depends(get_ctx)
) -> Response:
    body = await _body(request)
    if not isinstance(body, dict):
        raise ApiError("invalid_request")
    await verify_code(ctx, p.email, body.get("code"), "reset_keys", request_ip(request))
    async with ctx.engine.begin() as conn:
        await fetchone(conn, "SELECT id FROM users WHERE id = :u FOR UPDATE", {"u": p.user_id})
        await wipe_user_data(conn, p.user_id)
        await execute(
            conn,
            "UPDATE users SET keys_ready = false, keys_rev = keys_rev + 1, kdf = NULL, pw_salt = NULL, "
            "pw_wrap_nonce = NULL, pw_wrap_ct = NULL, rk_salt = NULL, rk_wrap_nonce = NULL, rk_wrap_ct = NULL, "
            "key_verifier = NULL WHERE id = :u",
            {"u": p.user_id},
        )
        await log_activity(conn, "keys_reset", p.user_id, p.device_id, request_ip(request))
    ctx.blobs.remove_user(p.user_id)
    ctx.coordinator.forget_user(p.user_id)
    ctx.hub.close_user(p.user_id, 4403, "keys_reset", final={"t": "keys.reset"})
    return Response(status_code=204)
