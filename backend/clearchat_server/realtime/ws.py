"""Endpoint WebSocket `<base>/ws` (§10): hello/welcome, requisições com ack/error, eventos."""

from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import time
from collections.abc import Awaitable, Callable
from typing import Any

from fastapi import WebSocket

from .. import PROTOCOL_MAJOR
from ..auth.tokens import authenticate
from ..chatstate import load_states_since, serialize
from ..context import AppContext, ws_ctx
from ..db import execute, fetchone
from ..errors import ApiError
from ..ratelimit import Limit
from ..sync import records
from ..sync.routes import after_push, payload_flag
from ..util import client_ip, iso, utcnow
from .hub import Conn

log = logging.getLogger("clearchat.ws")

WS_MAX_FRAME = 4 * 1024 * 1024
CLOSE_PROTOCOL = 4000
CLOSE_UNSUPPORTED = 4001
CLOSE_HELLO_TIMEOUT = 4002
CLOSE_UNAUTHORIZED = 4401
CLOSE_FORBIDDEN = 4403
CLOSE_SUPERSEDED = 4409
CLOSE_RATE = 4429

Handler = Callable[[AppContext, Conn, dict[str, Any]], Awaitable[dict[str, Any]]]


async def _close(ws: WebSocket, code: int, reason: str = "") -> None:
    with contextlib.suppress(Exception):
        await ws.close(code=code, reason=reason)


def _error_frame(re: Any, err: ApiError) -> dict[str, Any]:
    out: dict[str, Any] = {"t": "error", "code": err.code, "message": err.message, "details": err.details}
    if re is not None:
        out["re"] = re
    return out


# ---------------------------------------------------------------- handlers (fila sequencial)
async def h_pull(ctx: AppContext, c: Conn, d: dict[str, Any]) -> dict[str, Any]:
    since, limit = d.get("since", 0), d.get("limit")
    if not isinstance(since, int) or (limit is not None and not isinstance(limit, int)):
        raise ApiError("invalid_request", details={"field": "since/limit"})
    return await records.pull(ctx.engine, c.user_id, since, limit, payload_flag(d.get("payload")))


async def h_fetch(ctx: AppContext, c: Conn, d: dict[str, Any]) -> dict[str, Any]:
    return await records.fetch_records(ctx.engine, c.user_id, d.get("items"))


async def h_push(ctx: AppContext, c: Conn, d: dict[str, Any]) -> dict[str, Any]:
    body = {k: v for k, v in d.items() if k not in ("t", "id")}
    try:
        outcome = await records.push(ctx.engine, c.user_id, c.device_id, c.can_host, body, ctx.hub.is_online)
    except ApiError as e:
        for st in e.broadcast:
            ctx.coordinator.broadcast_state(c.user_id, st)
        raise
    await after_push(ctx, c.user_id, outcome)
    return outcome.response


HANDLERS: dict[str, Handler] = {
    "sync.pull": h_pull,
    "sync.fetch": h_fetch,
    "sync.push": h_push,
    "host.begin": lambda ctx, c, d: ctx.coordinator.host_begin(c, d),
    "host.end": lambda ctx, c, d: ctx.coordinator.host_end(c, d),
    "host.takeover": lambda ctx, c, d: ctx.coordinator.host_takeover(c, d),
    "host.handover_cancel": lambda ctx, c, d: ctx.coordinator.handover_cancel(c, d),
    "host.release": lambda ctx, c, d: ctx.coordinator.host_release(c, d),
    "host.pin": lambda ctx, c, d: ctx.coordinator.host_pin(c, d),
    "remote.send": lambda ctx, c, d: ctx.coordinator.remote_send(c, d),
    "stream.subscribe": lambda ctx, c, d: ctx.coordinator.stream_subscribe(c, d.get("chat_ids")),
    "stream.unsubscribe": lambda ctx, c, d: ctx.coordinator.stream_unsubscribe(c, d.get("chat_ids")),
    "stream.resync": lambda ctx, c, d: ctx.coordinator.stream_resync(c, d),
}
# rápidos, só memória: tratados na hora (não esperam a fila)
INLINE: dict[str, Handler] = {
    "remote.result": lambda ctx, c, d: ctx.coordinator.remote_result(c, d),
}


async def _dispatch(ctx: AppContext, c: Conn, handler: Handler, msg: dict[str, Any]) -> None:
    re = msg.get("id")
    try:
        res = await handler(ctx, c, msg)
        c.send({"t": "ack", "re": re, **res})
    except ApiError as e:
        c.send(_error_frame(re, e))
    except Exception:
        log.exception("erro inesperado no WebSocket", extra={"t": msg.get("t")})
        c.send(_error_frame(re, ApiError("internal")))


async def _worker(ctx: AppContext, c: Conn, q: asyncio.Queue[tuple[Handler, dict[str, Any]] | None]) -> None:
    while True:
        item = await q.get()
        if item is None:
            return
        await _dispatch(ctx, c, item[0], item[1])


async def _watchdog(ctx: AppContext, c: Conn) -> None:
    idle = ctx.settings.ws_idle_timeout_s
    while not c.closed:
        await asyncio.sleep(min(1.0, idle / 4))
        if time.monotonic() - c.last_frame_at > idle:
            log.info("conexão ociosa; fechando", extra={"device_id": str(c.device_id)})
            c.close(1000, "idle_timeout")
            return


# ---------------------------------------------------------------- endpoint
async def ws_endpoint(ws: WebSocket) -> None:
    ctx = ws_ctx(ws)
    await ws.accept()
    ip = client_ip(ws.client.host if ws.client else None, ws.headers, ctx.settings)
    try:
        first = await asyncio.wait_for(ws.receive(), timeout=ctx.settings.ws_hello_timeout_s)
    except TimeoutError:
        await _close(ws, CLOSE_HELLO_TIMEOUT, "hello_timeout")
        return
    if first.get("type") == "websocket.disconnect":
        return
    try:
        hello = json.loads(first.get("text") or "")
    except ValueError:
        hello = None
    if not isinstance(hello, dict) or hello.get("t") != "hello":
        await _close(ws, CLOSE_PROTOCOL, "protocol_error")
        return
    if hello.get("protocol") != PROTOCOL_MAJOR:
        with contextlib.suppress(Exception):
            await ws.send_text(
                json.dumps(
                    _error_frame(hello.get("id"), ApiError("protocol_unsupported", details={"min": 1, "max": 1}))
                )
            )
        await _close(ws, CLOSE_UNSUPPORTED, "unsupported_protocol")
        return
    try:
        async with ctx.engine.begin() as conn:
            p = await authenticate(conn, hello.get("access_token"))
    except ApiError as e:
        code = CLOSE_FORBIDDEN if e.code in ("device_revoked", "account_disabled") else CLOSE_UNAUTHORIZED
        await _close(ws, code, e.code)
        return
    try:
        await ctx.limiter.hit([Limit(f"ws:user:{p.user_id}", 30, 60)])
    except ApiError:
        await _close(ws, CLOSE_RATE, "rate_limited")
        return

    c = Conn(ws, p.user_id, p.device_id, p.device_name, p.platform, p.client, p.can_host)
    old = ctx.hub.register(c)
    if old is not None:
        old.close(CLOSE_SUPERSEDED, "superseded")
    queue: asyncio.Queue[tuple[Handler, dict[str, Any]] | None] = asyncio.Queue()
    tasks: list[asyncio.Task[None]] = []
    try:
        resumed, lost, after = await ctx.coordinator.on_connect(c, hello.get("active_windows"))
        state_cursor = hello.get("state_cursor")
        if not isinstance(state_cursor, int) or isinstance(state_cursor, bool) or state_cursor < 0:
            state_cursor = 0
        async with ctx.engine.begin() as conn:
            user = await fetchone(conn, "SELECT seq, state_seq, keys_rev FROM users WHERE id = :u", {"u": p.user_id})
            states = await load_states_since(conn, p.user_id, state_cursor)
            await execute(
                conn,
                "UPDATE devices SET last_seen_at = now(), last_ip = COALESCE(CAST(:ip AS inet), last_ip) WHERE id = :d",
                {"d": p.device_id, "ip": ip},
            )
        assert user is not None
        c.send_front(
            {
                "t": "welcome",
                "re": hello.get("id"),
                "protocol": PROTOCOL_MAJOR,
                "user_id": str(p.user_id),
                "device_id": str(p.device_id),
                "head": int(user.seq),
                "server_time": iso(utcnow()),
                "chat_states": [serialize(r, ctx.hub.is_online) for r in states],
                "state_cursor": int(user.state_seq),
                "resumed_windows": resumed,
                "lost_windows": lost,
                "keys_rev": int(user.keys_rev),
            }
        )
        c.start()
        for m in after:
            c.send(m)
        subs = hello.get("subscriptions")
        if isinstance(subs, list) and subs:
            with contextlib.suppress(ApiError):
                await ctx.coordinator.stream_subscribe(c, subs)
        tasks.append(asyncio.create_task(_worker(ctx, c, queue)))
        tasks.append(asyncio.create_task(_watchdog(ctx, c)))
        log.info("ws conectado", extra={"user_id": str(p.user_id), "device_id": str(p.device_id)})

        while True:
            msg = await ws.receive()
            if msg.get("type") == "websocket.disconnect":
                break
            c.last_frame_at = time.monotonic()
            text = msg.get("text")
            if text is None:
                c.send(_error_frame(None, ApiError("invalid_request", details={"reason": "binary_frame"})))
                continue
            try:
                data = json.loads(text)
            except ValueError:
                c.send(_error_frame(None, ApiError("invalid_request", details={"reason": "json"})))
                continue
            if not isinstance(data, dict) or not isinstance(data.get("t"), str):
                c.send(_error_frame(None, ApiError("invalid_request")))
                continue
            t = data["t"]
            if len(text) > WS_MAX_FRAME:
                c.send(_error_frame(data.get("id"), ApiError("payload_too_large", details={"limit": WS_MAX_FRAME})))
                continue
            if t == "ping":
                pong: dict[str, Any] = {"t": "pong"}
                if "id" in data:
                    pong["re"] = data["id"]
                if "ts" in data:
                    pong["ts"] = data["ts"]
                c.send(pong)
            elif t == "stream.event":
                await ctx.coordinator.stream_event(c, data)
            elif t in INLINE or t in HANDLERS:
                if "id" not in data:
                    c.send(_error_frame(None, ApiError("invalid_request", details={"reason": "missing_id", "t": t})))
                elif t in INLINE:
                    await _dispatch(ctx, c, INLINE[t], data)
                else:
                    queue.put_nowait((HANDLERS[t], data))
            else:
                c.send(
                    _error_frame(
                        data.get("id"), ApiError("invalid_request", details={"reason": "unknown_type", "t": t})
                    )
                )
    except Exception:
        log.exception("erro na conexão WebSocket")
    finally:
        queue.put_nowait(None)
        if len(tasks) > 1:
            tasks[1].cancel()  # watchdog
        for t_ in tasks:
            # o worker termina a requisição em andamento (ex.: um push) antes de sair
            with contextlib.suppress(asyncio.CancelledError, Exception):
                await asyncio.wait_for(t_, 30)
        was_current = ctx.hub.unregister(c)
        c.close(1000)
        with contextlib.suppress(asyncio.TimeoutError):
            await asyncio.wait_for(c.done.wait(), 1)
        await c.stop()
        if was_current:
            try:
                await ctx.coordinator.on_disconnect(c)
            except Exception:
                log.exception("erro ao tratar queda do dispositivo")
        log.info("ws desconectado", extra={"device_id": str(p.device_id)})
