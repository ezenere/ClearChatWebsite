"""Coordenação de host por chat (§8): janela de escrita, queda com tolerância, troca de host
(next_turn / force com timeout), fixar host, comandos remotos em trânsito (sem fila guardada) e relay
do stream ao vivo (§11). Estado durável em `chat_states`; timers e comandos em trânsito em memória."""

from __future__ import annotations

import asyncio
import contextlib
import logging
import time
import uuid
from collections import defaultdict, deque
from collections.abc import Callable
from dataclasses import dataclass
from datetime import timedelta
from typing import Any

from sqlalchemy.ext.asyncio import AsyncConnection, AsyncEngine

from ..chatstate import ensure_state, host_status, load_state, lock_state, lock_user, next_ssq, serialize
from ..config import Settings
from ..db import execute, fetchall, fetchone
from ..errors import ApiError
from ..sync.envelope import parse_envelope
from ..util import RECORD_ID_RE, iso, utcnow
from .hub import Conn, Hub

log = logging.getLogger("clearchat.host")

PURPOSES = {"run", "edit", "replay"}
TAKEOVER_MODES = {"next_turn", "force"}
COMMAND_KINDS = {
    "send",
    "force",
    "queue.force",
    "queue.remove",
    "stop",
    "stop_subagents",
    "approval",
    "smart_override",
    "question",
    "retry",
    "regenerate",
    "message.edit",
    "message.delete",
    "compact",
    "memory.extract",
}
COMMAND_MAX_BYTES = 1024 * 1024
STREAM_MAX_BYTES = 256 * 1024
STREAM_MAX_RATE = 50  # eventos/s por chat (acima disso o servidor descarta)

# colunas que o coordenador pode alterar (nomes internos, nunca vindos do cliente)
STATE_COLS = {
    "host_device_id",
    "epoch",
    "pinned",
    "window_purpose",
    "window_since",
    "host_dropped_at",
    "host_grace_deadline",
    "handover_to",
    "handover_mode",
    "handover_requested_at",
    "handover_deadline",
}
EPOCH_INC = object()

Post = list[Callable[[], None]]


@dataclass
class PendingCommand:
    user_id: uuid.UUID
    cmd_id: str
    chat_id: str
    sender: uuid.UUID
    host: uuid.UUID
    timer: asyncio.Task[None] | None = None


def _chat_id(v: Any) -> str:
    if not isinstance(v, str) or not RECORD_ID_RE.match(v):
        raise ApiError("invalid_request", details={"field": "chat_id"})
    return v


def _cmd_id(v: Any) -> str:
    if not isinstance(v, str) or not RECORD_ID_RE.match(v):
        raise ApiError("invalid_request", details={"field": "cmd_id"})
    return v


def _opt_int(v: Any, field: str) -> int | None:
    if v is None:
        return None
    if not isinstance(v, int) or isinstance(v, bool):
        raise ApiError("invalid_request", details={"field": field})
    return v


def _env_size_ok(env: Any, limit: int) -> None:
    if isinstance(env, dict) and isinstance(env.get("c"), str) and len(env["c"]) * 3 // 4 > limit:
        raise ApiError("payload_too_large", details={"limit": limit})


class Coordinator:
    def __init__(self, engine: AsyncEngine, hub: Hub, settings: Settings) -> None:
        self.engine = engine
        self.hub = hub
        self.settings = settings
        self.grace_timers: dict[tuple[uuid.UUID, str], asyncio.Task[None]] = {}
        self.force_timers: dict[tuple[uuid.UUID, str], asyncio.Task[None]] = {}
        self.pending: dict[tuple[uuid.UUID, str], PendingCommand] = {}
        self.pending_revocations: dict[uuid.UUID, list[dict[str, Any]]] = defaultdict(list)
        self._stream_rate: dict[tuple[uuid.UUID, str], deque[float]] = {}
        self._closing = False

    # ------------------------------------------------------------------ utilidades
    def broadcast_state(self, user_id: uuid.UUID, state: dict[str, Any]) -> None:
        self.hub.send_user(user_id, {"t": "chat.state", **state})

    def _run(self, post: Post) -> None:
        for fn in post:
            try:
                fn()
            except Exception:
                log.exception("erro numa ação pós-commit")

    async def _update(
        self,
        conn: AsyncConnection,
        user_id: uuid.UUID,
        chat_id: str,
        sets: dict[str, Any],
        event: dict[str, Any] | None,
    ) -> dict[str, Any]:
        """Atualiza o estado do chat com um ssq novo e devolve o ChatState serializado."""
        ssq = await next_ssq(conn, user_id)
        parts = []
        params: dict[str, Any] = {"u": user_id, "c": chat_id, "ssq": ssq}
        for n, (col, val) in enumerate(sets.items()):
            assert col in STATE_COLS
            if val is EPOCH_INC:
                parts.append("epoch = epoch + 1")
            else:
                parts.append(f"{col} = :p{n}")
                params[f"p{n}"] = val
        parts += ["ssq = :ssq", "updated_at = now()"]
        await execute(conn, f"UPDATE chat_states SET {', '.join(parts)} WHERE user_id = :u AND chat_id = :c", params)
        row = await load_state(conn, user_id, chat_id)
        return serialize(row, self.hub.is_online, event)

    async def _state_json(self, conn: AsyncConnection, user_id: uuid.UUID, chat_id: str) -> dict[str, Any] | None:
        row = await load_state(conn, user_id, chat_id)
        return None if row is None else serialize(row, self.hub.is_online)

    async def _err(self, conn: AsyncConnection, code: str, user_id: uuid.UUID, chat_id: str) -> ApiError:
        st = await self._state_json(conn, user_id, chat_id)
        details: dict[str, Any] = {"chat_id": chat_id}
        if st is not None:
            details["state"] = st
            if code == "chat_diverged":
                details["diverged"] = st["diverged"]
        return ApiError(code, details=details)

    async def _chat_deleted(self, conn: AsyncConnection, user_id: uuid.UUID, chat_id: str) -> bool:
        row = await fetchone(
            conn,
            "SELECT deleted FROM records WHERE user_id = :u AND type = 'chat' AND id = :c",
            {"u": user_id, "c": chat_id},
        )
        return row is not None and bool(row.deleted)

    def _cancel(self, timers: dict[tuple[uuid.UUID, str], asyncio.Task[None]], key: tuple[uuid.UUID, str]) -> None:
        t = timers.pop(key, None)
        if t is not None and t is not asyncio.current_task():
            t.cancel()

    def _schedule(
        self,
        timers: dict[tuple[uuid.UUID, str], asyncio.Task[None]],
        key: tuple[uuid.UUID, str],
        delay: float,
        fn: Callable[[uuid.UUID, str], Any],
    ) -> None:
        self._cancel(timers, key)

        async def runner() -> None:
            try:
                await asyncio.sleep(max(0.0, delay))
                if timers.get(key) is asyncio.current_task():
                    timers.pop(key, None)
                await fn(*key)
            except asyncio.CancelledError:
                pass
            except Exception:
                log.exception("erro num timer de host")

        timers[key] = asyncio.create_task(runner())

    def _revoke_msg(self, device_id: uuid.UUID, msg: dict[str, Any]) -> None:
        """host.revoked agora (se online) ou na próxima conexão."""
        if not self.hub.send_device(device_id, msg):
            lst = self.pending_revocations[device_id]
            lst[:] = [m for m in lst if m.get("chat_id") != msg.get("chat_id")] + [msg]

    async def _grant(
        self, conn: AsyncConnection, user_id: uuid.UUID, st: Any, new_host: uuid.UUID, reason: str, post: Post
    ) -> dict[str, Any]:
        """Concede o host a `new_host` (epoch+1, janela fechada, troca limpa)."""
        old = st.host_device_id
        state = await self._update(
            conn,
            user_id,
            st.chat_id,
            {
                "host_device_id": new_host,
                "epoch": EPOCH_INC,
                "window_purpose": None,
                "window_since": None,
                "host_dropped_at": None if self.hub.is_online(new_host) else utcnow(),
                "host_grace_deadline": None,
                "handover_to": None,
                "handover_mode": None,
                "handover_requested_at": None,
                "handover_deadline": None,
            },
            {"kind": "host_changed", "device_id": str(new_host), "reason": reason},
        )
        key = (user_id, st.chat_id)
        epoch, head, chat_id = state["epoch"], state["head"], st.chat_id

        def after() -> None:
            self._cancel(self.grace_timers, key)
            self._cancel(self.force_timers, key)
            self.broadcast_state(user_id, state)
            self.hub.send_device(new_host, {"t": "host.granted", "chat_id": chat_id, "epoch": epoch, "head": head})
            if old is not None and old != new_host:
                self._revoke_msg(old, {"t": "host.revoked", "chat_id": chat_id, "epoch": epoch, "reason": reason})

        post.append(after)
        return state

    # ------------------------------------------------------------------ host.begin / end
    async def host_begin(self, c: Conn, data: dict[str, Any]) -> dict[str, Any]:
        chat_id = _chat_id(data.get("chat_id"))
        epoch = _opt_int(data.get("epoch"), "epoch")
        purpose = data.get("purpose")
        if purpose not in PURPOSES:
            raise ApiError("invalid_request", details={"field": "purpose"})
        post: Post = []
        async with self.engine.begin() as conn:
            await lock_user(conn, c.user_id)
            if await self._chat_deleted(conn, c.user_id, chat_id):
                raise ApiError("not_found", details={"chat_id": chat_id})
            st = await ensure_state(conn, c.user_id, chat_id)
            if st.divergence_id is not None:
                raise await self._err(conn, "chat_diverged", c.user_id, chat_id)
            became = False
            if st.host_device_id is None:
                if not c.can_host:
                    raise await self._err(conn, "cannot_host", c.user_id, chat_id)
                state = await self._update(
                    conn,
                    c.user_id,
                    chat_id,
                    {
                        "host_device_id": c.device_id,
                        "epoch": EPOCH_INC,
                        "window_purpose": purpose,
                        "window_since": utcnow(),
                        "host_dropped_at": None,
                        "host_grace_deadline": None,
                    },
                    {"kind": "turn_started", "device_id": str(c.device_id)},
                )
                became = True
            elif st.host_device_id == c.device_id:
                if st.handover_to is not None and st.handover_to != c.device_id:
                    raise await self._err(conn, "handover_pending", c.user_id, chat_id)
                if epoch is not None and epoch != int(st.epoch):
                    raise await self._err(conn, "not_host", c.user_id, chat_id)
                if st.window_purpose is not None:
                    return {"epoch": int(st.epoch), "head": int(st.head), "became_host": False}
                state = await self._update(
                    conn,
                    c.user_id,
                    chat_id,
                    {
                        "window_purpose": purpose,
                        "window_since": utcnow(),
                        "host_dropped_at": None,
                        "host_grace_deadline": None,
                    },
                    {"kind": "turn_started", "device_id": str(c.device_id)},
                )
            else:
                raise await self._err(conn, "not_host", c.user_id, chat_id)
        self.broadcast_state(c.user_id, state)
        self._run(post)
        return {"epoch": state["epoch"], "head": state["head"], "became_host": became}

    async def host_end(self, c: Conn, data: dict[str, Any]) -> dict[str, Any]:
        chat_id = _chat_id(data.get("chat_id"))
        epoch = _opt_int(data.get("epoch"), "epoch")
        state = None
        async with self.engine.begin() as conn:
            await lock_user(conn, c.user_id)
            st = await lock_state(conn, c.user_id, chat_id)
            if st is None or st.host_device_id != c.device_id or (epoch is not None and epoch != int(st.epoch)):
                if st is None:
                    raise ApiError("not_host", details={"chat_id": chat_id})
                raise await self._err(conn, "not_host", c.user_id, chat_id)
            pending = st.handover_to is not None
            if st.window_purpose is not None:
                state = await self._update(
                    conn,
                    c.user_id,
                    chat_id,
                    {"window_purpose": None, "window_since": None},
                    {"kind": "turn_ended", "device_id": str(c.device_id)},
                )
        if state is not None:
            self.broadcast_state(c.user_id, state)
        return {"handover_pending": pending}

    # ------------------------------------------------------------------ troca de host
    async def host_takeover(self, c: Conn, data: dict[str, Any]) -> dict[str, Any]:
        chat_id = _chat_id(data.get("chat_id"))
        mode = data.get("mode", "next_turn")
        if mode not in TAKEOVER_MODES:
            raise ApiError("invalid_request", details={"field": "mode"})
        confirm = data.get("confirm_pinned") is True
        post: Post = []
        async with self.engine.begin() as conn:
            await lock_user(conn, c.user_id)
            if await self._chat_deleted(conn, c.user_id, chat_id):
                raise ApiError("not_found", details={"chat_id": chat_id})
            st = await ensure_state(conn, c.user_id, chat_id)
            if not c.can_host:
                raise await self._err(conn, "cannot_host", c.user_id, chat_id)
            if st.divergence_id is not None:
                raise await self._err(conn, "chat_diverged", c.user_id, chat_id)
            if st.pinned and not confirm:
                raise await self._err(conn, "host_pinned", c.user_id, chat_id)
            if st.host_device_id == c.device_id:
                return {"status": "granted", "epoch": int(st.epoch), "head": int(st.head)}
            status = host_status(st, self.hub.is_online)
            if st.host_device_id is None or status == "offline":
                state = await self._grant(conn, c.user_id, st, c.device_id, "takeover", post)
                ack = {"status": "granted", "epoch": state["epoch"], "head": state["head"]}
            else:
                if st.handover_to is not None and st.handover_to != c.device_id:
                    raise await self._err(conn, "handover_pending", c.user_id, chat_id)
                deadline = None
                if mode == "force" and status == "online":
                    deadline = utcnow() + timedelta(seconds=self.settings.handover_force_timeout_s)
                same = st.handover_to == c.device_id and st.handover_mode == mode
                state = await self._update(
                    conn,
                    c.user_id,
                    chat_id,
                    {
                        "handover_to": c.device_id,
                        "handover_mode": mode,
                        "handover_requested_at": st.handover_requested_at if same else utcnow(),
                        "handover_deadline": st.handover_deadline if same else deadline,
                    },
                    {"kind": "handover_requested", "device_id": str(c.device_id)},
                )
                host = st.host_device_id
                key = (c.user_id, chat_id)
                req_msg = {
                    "t": "host.handover_request",
                    "chat_id": chat_id,
                    "epoch": int(st.epoch),
                    "to_device_id": str(c.device_id),
                    "to_name": c.device_name,
                    "mode": mode,
                }

                def after() -> None:
                    self.broadcast_state(c.user_id, state)
                    if status == "online":
                        self.hub.send_device(host, req_msg)
                        if deadline is not None and not same:
                            self._schedule(
                                self.force_timers, key, self.settings.handover_force_timeout_s, self._force_expired
                            )

                post.append(after)
                ack = {"status": "pending"}
        self._run(post)
        return ack

    async def handover_cancel(self, c: Conn, data: dict[str, Any]) -> dict[str, Any]:
        chat_id = _chat_id(data.get("chat_id"))
        state = None
        async with self.engine.begin() as conn:
            await lock_user(conn, c.user_id)
            st = await lock_state(conn, c.user_id, chat_id)
            if st is not None and st.handover_to is not None and c.device_id in (st.handover_to, st.host_device_id):
                state = await self._update(
                    conn,
                    c.user_id,
                    chat_id,
                    {
                        "handover_to": None,
                        "handover_mode": None,
                        "handover_requested_at": None,
                        "handover_deadline": None,
                    },
                    {"kind": "handover_cancelled", "device_id": str(c.device_id)},
                )
        if state is not None:
            self._cancel(self.force_timers, (c.user_id, chat_id))
            self.broadcast_state(c.user_id, state)
        return {}

    async def host_release(self, c: Conn, data: dict[str, Any]) -> dict[str, Any]:
        chat_id = _chat_id(data.get("chat_id"))
        epoch = _opt_int(data.get("epoch"), "epoch")
        fwd_raw = data.get("forwarded") or []
        if not isinstance(fwd_raw, list) or len(fwd_raw) > 500:
            raise ApiError("invalid_request", details={"field": "forwarded"})
        forwarded = []
        for n, f in enumerate(fwd_raw):
            if not isinstance(f, dict):
                raise ApiError("invalid_request", details={"field": f"forwarded[{n}]"})
            _env_size_ok(f.get("env"), COMMAND_MAX_BYTES)
            env = parse_envelope(f.get("env"), f"forwarded[{n}].env")
            forwarded.append((_cmd_id(f.get("cmd_id")), env.to_json()))
        post: Post = []
        new_host: uuid.UUID | None = None
        async with self.engine.begin() as conn:
            await lock_user(conn, c.user_id)
            st = await lock_state(conn, c.user_id, chat_id)
            if st is None or st.host_device_id != c.device_id or (epoch is not None and epoch != int(st.epoch)):
                if st is None:
                    raise ApiError("not_host", details={"chat_id": chat_id})
                raise await self._err(conn, "not_host", c.user_id, chat_id)
            if st.handover_to is not None:
                new_host = st.handover_to
                await self._grant(conn, c.user_id, st, st.handover_to, "handover", post)
            else:
                state = await self._update(
                    conn,
                    c.user_id,
                    chat_id,
                    {
                        "host_device_id": None,
                        "epoch": EPOCH_INC,
                        "window_purpose": None,
                        "window_since": None,
                        "host_dropped_at": None,
                        "host_grace_deadline": None,
                    },
                    {"kind": "host_changed", "device_id": str(c.device_id), "reason": "released"},
                )
                post.append(lambda: self.broadcast_state(c.user_id, state))
        self._run(post)
        # repassa a fila local do host antigo ao novo host (em trânsito, como qualquer comando)
        now = iso(utcnow())
        for cmd_id, fenv in forwarded:
            target = self.hub.get(new_host)
            if target is None:
                c.send({"t": "remote.failed", "chat_id": chat_id, "cmd_id": cmd_id, "code": "host_offline"})
                continue
            self._track(c.user_id, cmd_id, chat_id, c.device_id, target.device_id)
            target.send(
                {
                    "t": "remote.command",
                    "chat_id": chat_id,
                    "cmd_id": cmd_id,
                    "kind": "send",
                    "env": fenv,
                    "from_device_id": str(c.device_id),
                    "created_at": now,
                }
            )
        return {}

    async def host_pin(self, c: Conn, data: dict[str, Any]) -> dict[str, Any]:
        chat_id = _chat_id(data.get("chat_id"))
        pinned = data.get("pinned")
        if not isinstance(pinned, bool):
            raise ApiError("invalid_request", details={"field": "pinned"})
        async with self.engine.begin() as conn:
            await lock_user(conn, c.user_id)
            await ensure_state(conn, c.user_id, chat_id)
            state = await self._update(
                conn,
                c.user_id,
                chat_id,
                {"pinned": pinned},
                {"kind": "pinned" if pinned else "unpinned", "device_id": str(c.device_id)},
            )
        self.broadcast_state(c.user_id, state)
        return {"ssq": state["ssq"]}

    async def _force_expired(self, user_id: uuid.UUID, chat_id: str) -> None:
        post: Post = []
        async with self.engine.begin() as conn:
            await lock_user(conn, user_id)
            st = await lock_state(conn, user_id, chat_id)
            if (
                st is None
                or st.handover_to is None
                or st.handover_mode != "force"
                or st.handover_deadline is None
                or st.handover_deadline > utcnow() + timedelta(milliseconds=50)
            ):
                return
            await self._grant(conn, user_id, st, st.handover_to, "takeover", post)
        self._run(post)

    # ------------------------------------------------------------------ conexão / queda
    async def on_connect(self, c: Conn, active_windows: Any) -> tuple[list[str], list[str], list[dict[str, Any]]]:
        claimed: dict[str, int | None] = {}
        if isinstance(active_windows, list):
            for aw in active_windows[:1000]:
                if isinstance(aw, dict) and isinstance(aw.get("chat_id"), str):
                    ep = aw.get("epoch")
                    claimed[aw["chat_id"]] = ep if isinstance(ep, int) and not isinstance(ep, bool) else None
        resumed: list[str] = []
        lost: list[str] = []
        after_welcome: list[dict[str, Any]] = []
        states: list[dict[str, Any]] = []
        force_keys: list[tuple[uuid.UUID, str]] = []
        async with self.engine.begin() as conn:
            await lock_user(conn, c.user_id)
            rows = await fetchall(
                conn,
                "SELECT * FROM chat_states WHERE user_id = :u AND (host_device_id = :d OR chat_id = ANY(CAST(:c AS text[]))) "
                "ORDER BY chat_id FOR UPDATE",
                {"u": c.user_id, "d": c.device_id, "c": list(claimed)},
            )
            for st in rows:
                if st.host_device_id != c.device_id:
                    if st.chat_id in claimed:
                        lost.append(st.chat_id)
                        after_welcome.append(
                            {"t": "host.revoked", "chat_id": st.chat_id, "epoch": int(st.epoch), "reason": "takeover"}
                        )
                    continue
                sets: dict[str, Any] = {}
                event: dict[str, Any] | None = None
                if st.host_dropped_at is not None or st.host_grace_deadline is not None:
                    sets.update(host_dropped_at=None, host_grace_deadline=None)
                    event = {"kind": "host_back", "device_id": str(c.device_id)}
                window_open = st.window_purpose is not None
                if st.chat_id in claimed:
                    if window_open and claimed[st.chat_id] == int(st.epoch):
                        resumed.append(st.chat_id)
                    else:
                        lost.append(st.chat_id)
                        if window_open:
                            sets.update(window_purpose=None, window_since=None)
                            event = event or {"kind": "turn_ended", "device_id": str(c.device_id)}
                elif window_open:
                    sets.update(window_purpose=None, window_since=None)
                    event = event or {"kind": "turn_ended", "device_id": str(c.device_id)}
                if st.handover_to is not None and st.handover_to != c.device_id:
                    deadline_needed = st.handover_mode == "force" and st.handover_deadline is None
                    if deadline_needed:
                        sets["handover_deadline"] = utcnow() + timedelta(seconds=self.settings.handover_force_timeout_s)
                        force_keys.append((c.user_id, st.chat_id))
                    to = await fetchone(conn, "SELECT name FROM devices WHERE id = :d", {"d": st.handover_to})
                    after_welcome.append(
                        {
                            "t": "host.handover_request",
                            "chat_id": st.chat_id,
                            "epoch": int(st.epoch),
                            "to_device_id": str(st.handover_to),
                            "to_name": to.name if to else "",
                            "mode": st.handover_mode,
                        }
                    )
                if sets:
                    states.append(await self._update(conn, c.user_id, st.chat_id, sets, event))
            claimed_missing = [ch for ch in claimed if ch not in {r.chat_id for r in rows}]
            lost.extend(claimed_missing)
        for chat_id in resumed + lost:
            self._cancel(self.grace_timers, (c.user_id, chat_id))
        for st_json in states:
            self._cancel(self.grace_timers, (c.user_id, st_json["chat_id"]))
            self.broadcast_state(c.user_id, st_json)
        for key in force_keys:
            self._schedule(self.force_timers, key, self.settings.handover_force_timeout_s, self._force_expired)
        revs = self.pending_revocations.pop(c.device_id, [])
        seen = {m["chat_id"] for m in after_welcome if m["t"] == "host.revoked"}
        after_welcome = [m for m in revs if m["chat_id"] not in seen] + after_welcome
        return resumed, lost, after_welcome

    async def on_disconnect(self, c: Conn) -> None:
        if self._closing:
            return
        # comandos em trânsito para este host: falham agora (nunca reentregues)
        for key, pc in list(self.pending.items()):
            if pc.host == c.device_id and pc.user_id == c.user_id:
                self._fail(key, "host_offline")
        grace = self.settings.host_drop_grace_s
        states: list[dict[str, Any]] = []
        async with self.engine.begin() as conn:
            await lock_user(conn, c.user_id)
            if self.hub.is_online(c.device_id):  # reconectou nesse meio-tempo
                return
            rows = await fetchall(
                conn,
                "SELECT chat_id FROM chat_states WHERE user_id = :u AND host_device_id = :d AND host_dropped_at IS NULL "
                "ORDER BY chat_id FOR UPDATE",
                {"u": c.user_id, "d": c.device_id},
            )
            now = utcnow()
            for r in rows:
                states.append(
                    await self._update(
                        conn,
                        c.user_id,
                        r.chat_id,
                        {"host_dropped_at": now, "host_grace_deadline": now + timedelta(seconds=grace)},
                        None,
                    )
                )
        for st in states:
            self._schedule(self.grace_timers, (c.user_id, st["chat_id"]), grace, self._grace_expired)
            self.broadcast_state(c.user_id, st)

    async def _grace_expired(self, user_id: uuid.UUID, chat_id: str) -> None:
        post: Post = []
        async with self.engine.begin() as conn:
            await lock_user(conn, user_id)
            st = await lock_state(conn, user_id, chat_id)
            if (
                st is None
                or st.host_device_id is None
                or self.hub.is_online(st.host_device_id)
                or st.host_grace_deadline is None
                or st.host_grace_deadline > utcnow() + timedelta(milliseconds=50)
            ):
                return
            dropped = await self._update(
                conn,
                user_id,
                chat_id,
                {"window_purpose": None, "window_since": None, "host_grace_deadline": None},
                {"kind": "host_dropped", "device_id": str(st.host_device_id)},
            )
            post.append(lambda: self.broadcast_state(user_id, dropped))
            if st.handover_to is not None:
                st2 = await lock_state(conn, user_id, chat_id)
                await self._grant(conn, user_id, st2, st.handover_to, "takeover", post)
        self._run(post)

    async def boot(self) -> None:
        """Reinício do servidor (§8.3 (4)): todas as conexões caíram; hosts que estavam conectados (ou em
        tolerância) ganham SERVER_RESTART_GRACE_S a partir do boot. Trocas forçadas pendentes são reagendadas."""
        restart = self.settings.server_restart_grace_s
        now = utcnow()
        async with self.engine.begin() as conn:
            hosted = await fetchall(
                conn,
                "SELECT user_id, chat_id, host_dropped_at, host_grace_deadline FROM chat_states "
                "WHERE host_device_id IS NOT NULL AND (host_dropped_at IS NULL OR host_grace_deadline IS NOT NULL) "
                "ORDER BY user_id, chat_id FOR UPDATE",
            )
            for r in hosted:
                deadline = max(r.host_grace_deadline or now, now + timedelta(seconds=restart))
                await self._update(
                    conn,
                    r.user_id,
                    r.chat_id,
                    {"host_dropped_at": r.host_dropped_at or now, "host_grace_deadline": deadline},
                    None,
                )
                self._schedule(
                    self.grace_timers, (r.user_id, r.chat_id), (deadline - now).total_seconds(), self._grace_expired
                )
            forced = await fetchall(
                conn, "SELECT user_id, chat_id, handover_deadline FROM chat_states WHERE handover_deadline IS NOT NULL"
            )
            for r in forced:
                delay = max((r.handover_deadline - now).total_seconds(), 0.0)
                self._schedule(self.force_timers, (r.user_id, r.chat_id), delay, self._force_expired)

    async def shutdown(self) -> None:
        self._closing = True
        for timers in (self.grace_timers, self.force_timers):
            for t in timers.values():
                t.cancel()
            timers.clear()
        for pc in self.pending.values():
            if pc.timer is not None:
                pc.timer.cancel()
        self.pending.clear()

    def forget_user(self, user_id: uuid.UUID) -> None:
        """Conta apagada / chaves zeradas: descarta timers e comandos em memória."""
        for timers in (self.grace_timers, self.force_timers):
            for key in [k for k in timers if k[0] == user_id]:
                self._cancel(timers, key)
        for key in [k for k in self.pending if k[0] == user_id]:
            pc = self.pending.pop(key)
            if pc.timer is not None:
                pc.timer.cancel()

    # ------------------------------------------------------------------ comandos remotos (§8.6)
    def _track(self, user_id: uuid.UUID, cmd_id: str, chat_id: str, sender: uuid.UUID, host: uuid.UUID) -> None:
        key = (user_id, cmd_id)
        old = self.pending.pop(key, None)
        if old is not None and old.timer is not None:
            old.timer.cancel()
        pc = PendingCommand(user_id, cmd_id, chat_id, sender, host)

        async def timeout() -> None:
            try:
                await asyncio.sleep(self.settings.command_result_timeout_s)
            except asyncio.CancelledError:
                return
            if self.pending.get(key) is pc:
                pc.timer = None
                self._fail(key, "command_timeout")

        pc.timer = asyncio.create_task(timeout())
        self.pending[key] = pc

    def _fail(self, key: tuple[uuid.UUID, str], code: str) -> None:
        pc = self.pending.pop(key, None)
        if pc is None:
            return
        if pc.timer is not None and pc.timer is not asyncio.current_task():
            pc.timer.cancel()
        self.hub.send_device(
            pc.sender, {"t": "remote.failed", "chat_id": pc.chat_id, "cmd_id": pc.cmd_id, "code": code}
        )

    async def remote_send(self, c: Conn, data: dict[str, Any]) -> dict[str, Any]:
        chat_id = _chat_id(data.get("chat_id"))
        cmd_id = _cmd_id(data.get("cmd_id"))
        kind = data.get("kind")
        if kind not in COMMAND_KINDS:
            raise ApiError("invalid_request", details={"field": "kind"})
        _env_size_ok(data.get("env"), COMMAND_MAX_BYTES)
        env = parse_envelope(data.get("env"), "env")
        async with self.engine.connect() as conn:
            st = await load_state(conn, c.user_id, chat_id)
            if st is not None and st.divergence_id is not None:
                raise ApiError(
                    "chat_diverged",
                    details={"chat_id": chat_id, "diverged": serialize(st, self.hub.is_online)["diverged"]},
                )
            if st is None or st.host_device_id is None:
                raise ApiError("no_host", details={"chat_id": chat_id})
            if st.host_device_id == c.device_id:
                raise ApiError("invalid_request", details={"reason": "sender_is_host", "chat_id": chat_id})
            host_conn = self.hub.get(st.host_device_id)
            if host_conn is None:
                raise ApiError("host_offline", details={"chat_id": chat_id, "state": serialize(st, self.hub.is_online)})
        self._track(c.user_id, cmd_id, chat_id, c.device_id, host_conn.device_id)
        host_conn.send(
            {
                "t": "remote.command",
                "chat_id": chat_id,
                "cmd_id": cmd_id,
                "kind": kind,
                "env": env.to_json(),
                "from_device_id": str(c.device_id),
                "created_at": iso(utcnow()),
            }
        )
        return {"status": "delivered"}

    async def remote_result(self, c: Conn, data: dict[str, Any]) -> dict[str, Any]:
        chat_id = _chat_id(data.get("chat_id"))
        cmd_id = _cmd_id(data.get("cmd_id"))
        _env_size_ok(data.get("env"), COMMAND_MAX_BYTES)
        env = parse_envelope(data.get("env"), "env")
        key = (c.user_id, cmd_id)
        pc = self.pending.get(key)
        if pc is not None and pc.host == c.device_id and pc.chat_id == chat_id:
            self.pending.pop(key, None)
            if pc.timer is not None:
                pc.timer.cancel()
            self.hub.send_device(
                pc.sender, {"t": "remote.result", "chat_id": chat_id, "cmd_id": cmd_id, "env": env.to_json()}
            )
        return {}

    # ------------------------------------------------------------------ stream ao vivo (§11)
    async def _host_of(self, user_id: uuid.UUID, chat_id: str) -> Any:
        async with self.engine.connect() as conn:
            return await fetchone(
                conn,
                "SELECT host_device_id, epoch, window_purpose FROM chat_states WHERE user_id = :u AND chat_id = :c",
                {"u": user_id, "c": chat_id},
            )

    async def stream_event(self, c: Conn, data: dict[str, Any]) -> None:
        """Do host, sem ack. Eventos inválidos são descartados em silêncio."""
        chat_id, epoch, n, env = data.get("chat_id"), data.get("epoch"), data.get("n"), data.get("env")
        if not isinstance(chat_id, str) or not RECORD_ID_RE.match(chat_id):
            return
        if not isinstance(epoch, int) or not isinstance(n, int) or isinstance(n, bool) or n < 1:
            return
        if isinstance(env, dict) and isinstance(env.get("c"), str) and len(env["c"]) * 3 // 4 > STREAM_MAX_BYTES:
            return
        try:
            e = parse_envelope(env, "env")
        except ApiError:
            return
        key = (c.user_id, chat_id)
        now = time.monotonic()
        dq = self._stream_rate.setdefault(key, deque())
        while dq and now - dq[0] > 1.0:
            dq.popleft()
        if len(dq) >= STREAM_MAX_RATE:
            return
        dq.append(now)
        st = await self._host_of(c.user_id, chat_id)
        if st is None or st.host_device_id != c.device_id or int(st.epoch) != epoch:
            return
        msg = {
            "t": "stream.event",
            "chat_id": chat_id,
            "epoch": epoch,
            "n": n,
            "env": e.to_json(),
            "device_id": str(c.device_id),
        }
        for sub in self.hub.subscribers(c.user_id, chat_id):
            if sub is not c:
                sub.send(msg)

    async def request_snapshot(self, c: Conn, chat_id: str) -> None:
        st = await self._host_of(c.user_id, chat_id)
        if st is None or st.host_device_id is None or st.host_device_id == c.device_id:
            return
        self.hub.send_device(
            st.host_device_id,
            {"t": "stream.resync_request", "chat_id": chat_id, "requester_device_id": str(c.device_id)},
        )

    async def stream_subscribe(self, c: Conn, chat_ids: Any) -> dict[str, Any]:
        if not isinstance(chat_ids, list) or len(chat_ids) > 200:
            raise ApiError("invalid_request", details={"field": "chat_ids"})
        ids = [_chat_id(x) for x in chat_ids]
        for chat_id in ids:
            c.subscriptions.add(chat_id)
        for chat_id in ids:
            with contextlib.suppress(Exception):
                await self.request_snapshot(c, chat_id)
        return {}

    async def stream_unsubscribe(self, c: Conn, chat_ids: Any) -> dict[str, Any]:
        if not isinstance(chat_ids, list):
            raise ApiError("invalid_request", details={"field": "chat_ids"})
        for x in chat_ids:
            c.subscriptions.discard(x)
        return {}

    async def stream_resync(self, c: Conn, data: dict[str, Any]) -> dict[str, Any]:
        chat_id = _chat_id(data.get("chat_id"))
        await self.request_snapshot(c, chat_id)
        return {}
