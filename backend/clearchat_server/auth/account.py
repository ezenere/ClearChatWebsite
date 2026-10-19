"""Conta (§6.4) e dispositivos (§6.6)."""

from __future__ import annotations

import uuid
from typing import Any

from fastapi import APIRouter, Depends, Request, Response

from ..context import AppContext, get_ctx, request_ip
from ..db import execute, fetchall, fetchone
from ..errors import ApiError
from ..services.accounts import delete_user, log_activity, revoke_devices
from ..util import iso
from .codes import verify_code
from .deps import current_principal
from .routes import _after_revoke, _body
from .tokens import Principal

router = APIRouter()


async def account_json(ctx: AppContext, user_id: uuid.UUID) -> dict[str, Any]:
    async with ctx.engine.connect() as conn:
        u = await fetchone(
            conn,
            "SELECT u.*, (SELECT count(*) FROM devices d WHERE d.user_id = u.id AND d.revoked_at IS NULL) AS n_devices "
            "FROM users u WHERE u.id = :u",
            {"u": user_id},
        )
    assert u is not None
    return {
        "id": str(u.id),
        "email": str(u.email),
        "name": u.name,
        "created_at": iso(u.created_at),
        "keys_ready": bool(u.keys_ready),
        "usage": {
            "record_bytes": int(u.usage_record_bytes),
            "records": int(u.usage_records),
            "blob_bytes": int(u.usage_blob_bytes),
            "blobs": int(u.usage_blobs),
            "devices": int(u.n_devices),
        },
        "quotas": {
            "record_bytes": u.quota_record_bytes,
            "records": u.quota_records,
            "blob_bytes": u.quota_blob_bytes,
            "devices": u.quota_devices,
        },
    }


@router.get("/account")
async def get_account(p: Principal = Depends(current_principal), ctx: AppContext = Depends(get_ctx)) -> Any:
    return await account_json(ctx, p.user_id)


@router.patch("/account")
async def patch_account(
    request: Request, p: Principal = Depends(current_principal), ctx: AppContext = Depends(get_ctx)
) -> Any:
    body = await _body(request)
    name = body.get("name")
    if not isinstance(name, str) or not 1 <= len(name.strip()) <= 100:
        raise ApiError("invalid_request", details={"field": "name"})
    async with ctx.engine.begin() as conn:
        await execute(conn, "UPDATE users SET name = :n WHERE id = :u", {"n": name.strip(), "u": p.user_id})
    return await account_json(ctx, p.user_id)


@router.delete("/account", status_code=204)
async def delete_account(
    request: Request, p: Principal = Depends(current_principal), ctx: AppContext = Depends(get_ctx)
) -> Response:
    body = await _body(request)
    ip = request_ip(request)
    await verify_code(ctx, p.email, body.get("code"), "delete_account", ip)
    async with ctx.engine.begin() as conn:
        await delete_user(conn, p.user_id)
        await log_activity(conn, "account_deleted", None, None, ip, {"by": "user"})
    ctx.blobs.remove_user(p.user_id)
    ctx.coordinator.forget_user(p.user_id)
    ctx.hub.close_user(p.user_id, 4403, "account_deleted", final={"t": "account.deleted"})
    return Response(status_code=204)


# ---------------------------------------------------------------- dispositivos
@router.get("/devices")
async def list_devices(p: Principal = Depends(current_principal), ctx: AppContext = Depends(get_ctx)) -> Any:
    async with ctx.engine.connect() as conn:
        rows = await fetchall(
            conn,
            "SELECT * FROM devices WHERE user_id = :u AND revoked_at IS NULL ORDER BY created_at",
            {"u": p.user_id},
        )
    return [
        {
            "id": str(r.id),
            "name": r.name,
            "platform": r.platform,
            "client": r.client,
            "app_version": r.app_version,
            "can_host": bool(r.can_host),
            "created_at": iso(r.created_at),
            "last_seen_at": iso(r.last_seen_at),
            "last_ip": str(r.last_ip) if r.last_ip is not None else None,
            "online": ctx.hub.is_online(r.id),
            "current": r.id == p.device_id,
        }
        for r in rows
    ]


def _device_id(raw: str) -> uuid.UUID:
    try:
        return uuid.UUID(raw)
    except ValueError as e:
        raise ApiError("not_found") from e


@router.patch("/devices/{device_id}")
async def patch_device(
    device_id: str, request: Request, p: Principal = Depends(current_principal), ctx: AppContext = Depends(get_ctx)
) -> Any:
    did = _device_id(device_id)
    body = await _body(request)
    name = body.get("name")
    if not isinstance(name, str) or not 1 <= len(name.strip()) <= 64:
        raise ApiError("invalid_request", details={"field": "name"})
    async with ctx.engine.begin() as conn:
        n = await execute(
            conn,
            "UPDATE devices SET name = :n WHERE id = :d AND user_id = :u AND revoked_at IS NULL",
            {"n": name.strip(), "d": did, "u": p.user_id},
        )
    if not n:
        raise ApiError("not_found")
    c = ctx.hub.get(did)
    if c is not None:
        c.device_name = name.strip()
    return {"id": str(did), "name": name.strip()}


@router.delete("/devices/{device_id}", status_code=204)
async def delete_device(
    device_id: str, request: Request, p: Principal = Depends(current_principal), ctx: AppContext = Depends(get_ctx)
) -> Response:
    did = _device_id(device_id)
    async with ctx.engine.begin() as conn:
        ids, chats = await revoke_devices(conn, p.user_id, [did])
        if not ids:
            raise ApiError("not_found")
        await log_activity(conn, "device_revoked", p.user_id, did, request_ip(request), {"by_device": str(p.device_id)})
    await _after_revoke(ctx, p.user_id, ids, chats)
    return Response(status_code=204)
