"""Rotas REST de sync (§6.7)."""

from __future__ import annotations

import uuid
from typing import Any

from fastapi import APIRouter, Depends, Query, Request

from ..auth.deps import current_principal
from ..auth.tokens import Principal
from ..chatstate import load_state, load_states_since, serialize
from ..context import AppContext, get_ctx
from ..db import fetchval
from ..errors import ApiError
from ..util import RECORD_ID_RE, TYPE_RE
from . import records

router = APIRouter()

PUSH_MAX_BYTES = 32 * 1024 * 1024


def payload_flag(v: Any) -> bool:
    if v is None:
        return True
    if isinstance(v, bool):
        return v
    return str(v).lower() not in ("0", "false", "no")


async def after_push(ctx: AppContext, user_id: uuid.UUID, outcome: records.PushOutcome) -> None:
    """Depois do COMMIT: `sync.changes` para todas as conexões do usuário e `chat.state` dos chats que
    mudaram de host."""
    if outcome.replayed or not outcome.changes:
        return
    ctx.hub.send_user(
        user_id,
        {"t": "sync.changes", "changes": records.limit_inline(outcome.changes), "head": outcome.response["head"]},
    )
    if outcome.state_events:
        async with ctx.engine.connect() as conn:
            for chat_id, event in outcome.state_events:
                row = await load_state(conn, user_id, chat_id)
                if row is not None:
                    ctx.coordinator.broadcast_state(user_id, serialize(row, ctx.hub.is_online, event))


async def _json_body(request: Request, limit: int) -> Any:
    clen = request.headers.get("content-length")
    if clen is not None and clen.isdigit() and int(clen) > limit:
        raise ApiError("payload_too_large", details={"limit": limit})
    raw = b""
    async for chunk in request.stream():
        raw += chunk
        if len(raw) > limit:
            raise ApiError("payload_too_large", details={"limit": limit})
    try:
        import json

        return json.loads(raw)
    except ValueError as e:
        raise ApiError("invalid_request", details={"reason": "json"}) from e


@router.get("/sync/changes")
async def sync_changes(
    since: int = Query(0),
    limit: int | None = Query(None),
    payload: str | None = Query(None),
    p: Principal = Depends(current_principal),
    ctx: AppContext = Depends(get_ctx),
) -> Any:
    return await records.pull(ctx.engine, p.user_id, since, limit, payload_flag(payload))


@router.post("/sync/push")
async def sync_push(
    request: Request, p: Principal = Depends(current_principal), ctx: AppContext = Depends(get_ctx)
) -> Any:
    body = await _json_body(request, PUSH_MAX_BYTES)
    try:
        outcome = await records.push(ctx.engine, p.user_id, p.device_id, p.can_host, body, ctx.hub.is_online)
    except ApiError as e:
        for st in e.broadcast:
            ctx.coordinator.broadcast_state(p.user_id, st)
        raise
    await after_push(ctx, p.user_id, outcome)
    return outcome.response


@router.get("/records")
async def list_records(
    type: str | None = Query(None),
    scope: str | None = Query(None),
    after: int = Query(0),
    limit: int | None = Query(None),
    payload: str | None = Query(None),
    p: Principal = Depends(current_principal),
    ctx: AppContext = Depends(get_ctx),
) -> Any:
    if type is not None and not TYPE_RE.match(type):
        raise ApiError("invalid_request", details={"field": "type"})
    if scope is not None and not RECORD_ID_RE.match(scope):
        raise ApiError("invalid_request", details={"field": "scope"})
    return await records.list_records(ctx.engine, p.user_id, type, scope, after, limit, payload_flag(payload))


@router.post("/records/fetch")
async def records_fetch(
    request: Request, p: Principal = Depends(current_principal), ctx: AppContext = Depends(get_ctx)
) -> Any:
    body = await _json_body(request, 1024 * 1024)
    if not isinstance(body, dict):
        raise ApiError("invalid_request")
    return await records.fetch_records(ctx.engine, p.user_id, body.get("items"))


@router.get("/chat-states")
async def chat_states(
    since: int = Query(0), p: Principal = Depends(current_principal), ctx: AppContext = Depends(get_ctx)
) -> Any:
    if since < 0:
        raise ApiError("invalid_request", details={"field": "since"})
    async with ctx.engine.connect() as conn:
        cursor = await fetchval(conn, "SELECT state_seq FROM users WHERE id = :u", {"u": p.user_id})
        rows = await load_states_since(conn, p.user_id, since)
    return {"chat_states": [serialize(r, ctx.hub.is_online) for r in rows], "state_cursor": int(cursor or 0)}


@router.post("/chats/{chat_id}/divergence/resolve")
async def divergence_resolve(
    chat_id: str, request: Request, p: Principal = Depends(current_principal), ctx: AppContext = Depends(get_ctx)
) -> Any:
    if not RECORD_ID_RE.match(chat_id):
        raise ApiError("invalid_request", details={"field": "chat_id"})
    body = await _json_body(request, PUSH_MAX_BYTES)
    out = await records.resolve_divergence(
        ctx.engine, p.user_id, p.device_id, p.can_host, chat_id, body, ctx.hub.is_online
    )
    if out.changes:
        ctx.hub.send_user(
            p.user_id,
            {"t": "sync.changes", "changes": records.limit_inline(out.changes), "head": out.response.get("head")},
        )
    if out.state is not None:
        ctx.coordinator.broadcast_state(p.user_id, out.state)
    return out.response
