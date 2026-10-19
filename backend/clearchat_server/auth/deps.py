"""Dependência de autenticação (Bearer cca_…)."""

from __future__ import annotations

from fastapi import Depends, Request

from ..context import AppContext, get_ctx, request_ip
from ..errors import ApiError
from .tokens import Principal, authenticate, client_version, touch_device


def bearer(request: Request) -> str | None:
    h = request.headers.get("authorization", "")
    if h[:7].lower() == "bearer ":
        return h[7:].strip()
    return None


async def current_principal(request: Request, ctx: AppContext = Depends(get_ctx)) -> Principal:
    token = bearer(request)
    if not token:
        raise ApiError("unauthorized")
    async with ctx.engine.begin() as conn:
        p = await authenticate(conn, token)
        await touch_device(
            conn,
            p.device_id,
            p.user_id,
            request_ip(request),
            client_version(request.headers.get("x-clearchat-client"), p.client),
        )
    return p
