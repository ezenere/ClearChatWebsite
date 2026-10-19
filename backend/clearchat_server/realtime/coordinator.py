"""Coordenação de host por chat (§8): janela de escrita, queda com tolerância, troca de host
(next_turn / force com timeout), fixar host, comandos remotos em trânsito (sem fila guardada) e relay
do stream ao vivo (§11). Estado durável em `chat_states`; timers e comandos em trânsito em memória.
Queda, reinício e fim de tolerância trabalham em conjunto (O(1) comandos e um timer por usuário), nunca
chat a chat."""

from __future__ import annotations

import asyncio
import contextlib
import functools
import logging
import time
import uuid
from collections import deque
from collections.abc import Callable
from dataclasses import dataclass
from datetime import timedelta
from typing import Any

from sqlalchemy.ext.asyncio import AsyncConnection, AsyncEngine

from ..chatstate import (
    STATE_SELECT,
    ensure_state,
    host_status,
    load_state,
    lock_state,
    lock_user,
    next_ssq,
    serialize,
)
from ..config import Settings
from ..db import execute, fetchall, fetchone, fetchval
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
STREAM_MAX_CHATS = 256  # chats com estado de taxa por conexão (acima, o evento de um chat novo é descartado)
REVOKE_QUEUE_MAX = 5000  # host.revoked guardados por dispositivo offline (acima, os mais antigos saem)
SWEEP = "*"  # chave dos timers por usuário (não casa com RECORD_ID_RE: nunca colide com um chat_id)

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


def _stream_rate_ok(rate: dict[str, deque[float]], chat_id: str, now: float) -> bool:
    """Janela de 1 s do chat: tira o que venceu (chave vazia sai do dicionário) e diz se ainda cabe um evento."""
    dq = rate.get(chat_id)
    if dq is None:
        return True
    while dq and now - dq[0] > 1.0:
        dq.popleft()
    if not dq:
        del rate[chat_id]
        return True
    return len(dq) < STREAM_MAX_RATE


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


async def revoked_reason(conn: AsyncConnection, device_id: uuid.UUID) -> str | None:
    """Motivo do 4403 se o dispositivo/conta perdeu o acesso depois do hello; None = segue valendo."""
    row = await fetchone(
        conn,
        "SELECT d.revoked_at, u.status FROM devices d JOIN users u ON u.id = d.user_id WHERE d.id = :d",
        {"d": device_id},
    )
    if row is None:  # conta apagada (os dispositivos vão junto)
        return "account_deleted"
    if row.revoked_at is not None:
        return "device_revoked"
    if row.status != "active":
        return "account_disabled"
    return None


def access_error(reason: str) -> ApiError:
    return ApiError("device_revoked" if reason == "device_revoked" else "account_disabled")


class Coordinator:
    def __init__(self, engine: AsyncEngine, hub: Hub, settings: Settings) -> None:
        self.engine = engine
        self.hub = hub
        self.settings = settings
        self.grace_timers: dict[tuple[uuid.UUID, str], asyncio.Task[None]] = {}
        self.force_timers: dict[tuple[uuid.UUID, str], asyncio.Task[None]] = {}
        self.pending: dict[tuple[uuid.UUID, str], PendingCommand] = {}
        # device_id → (user_id, chat_id → host.revoked): um por chat, para quando o dispositivo voltar
        self.pending_revocations: dict[uuid.UUID, tuple[uuid.UUID, dict[str, dict[str, Any]]]] = {}
        # ("grace" | "force", user_id) → quando vence o timer de varredura do usuário (time.monotonic)
        self._sweep_due: dict[tuple[str, uuid.UUID], float] = {}
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

    async def _assert_active(self, conn: AsyncConnection, c: Conn) -> None:
        """Defesa em profundidade: revogação/ban já gravados barram o pedido mesmo que o 4403 ainda não
        tenha chegado ao socket (requisição em andamento, NOTIFY perdido)."""
        reason = await revoked_reason(conn, c.device_id)
        if reason is not None:
            raise access_error(reason)

    async def _ensure(self, conn: AsyncConnection, user_id: uuid.UUID, chat_id: str) -> Any:
        """ensure_state com o teto de chat_states por usuário (só ao criar uma linha nova)."""
        return await ensure_state(conn, user_id, chat_id, cap=self.settings.max_chat_states_per_user or None)

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

    def _schedule_sweep(self, kind: str, user_id: uuid.UUID, delay: float) -> None:
        """Um timer de varredura por usuário (não por chat). Se já houver um que vence antes, ele fica: a
        varredura reagenda sozinha para o próximo prazo."""
        timers, fn = (
            (self.grace_timers, self._grace_sweep) if kind == "grace" else (self.force_timers, self._force_sweep)
        )
        key = (user_id, SWEEP)
        due = time.monotonic() + max(0.0, delay)
        cur = self._sweep_due.get((kind, user_id))
        if key in timers and cur is not None and cur <= due:
            return
        self._sweep_due[(kind, user_id)] = due
        self._schedule(timers, key, delay, fn)

    def _revoke_msg(self, user_id: uuid.UUID, device_id: uuid.UUID, msg: dict[str, Any]) -> None:
        """host.revoked agora (se online) ou na próxima conexão (o último por chat; no máximo
        REVOKE_QUEUE_MAX por dispositivo)."""
        if self.hub.send_device(device_id, msg):
            return
        _, q = self.pending_revocations.setdefault(device_id, (user_id, {}))
        q.pop(msg["chat_id"], None)  # o mais novo vai para o fim
        q[msg["chat_id"]] = msg
        if len(q) > REVOKE_QUEUE_MAX:
            q.pop(next(iter(q)))

    async def _grant(
        self, conn: AsyncConnection, user_id: uuid.UUID, st: Any, new_host: uuid.UUID, reason: str, post: Post
    ) -> dict[str, Any]:
        """Concede o host a `new_host` (epoch+1, janela fechada, troca limpa)."""
        ssq = await next_ssq(conn, user_id)
        (state,) = await self._grant_many(conn, user_id, [(st, new_host, ssq)], reason, post)
        return state

    async def _grant_many(
        self,
        conn: AsyncConnection,
        user_id: uuid.UUID,
        grants: list[tuple[Any, uuid.UUID, int]],
        reason: str,
        post: Post,
    ) -> list[dict[str, Any]]:
        """Concede o host de vários chats num UPDATE só: `grants` = (linha travada, novo host, ssq já
        reservado). Devolve os ChatStates na mesma ordem e põe em `post` as ações de cada um."""
        now = utcnow()
        chats = [st.chat_id for st, _, _ in grants]
        await execute(
            conn,
            "UPDATE chat_states cs SET host_device_id = v.h, epoch = cs.epoch + 1, window_purpose = NULL, "
            "window_since = NULL, host_dropped_at = v.dr, host_grace_deadline = NULL, handover_to = NULL, "
            "handover_mode = NULL, handover_requested_at = NULL, handover_deadline = NULL, ssq = v.s, "
            "updated_at = now() "
            "FROM unnest(CAST(:c AS text[]), CAST(:h AS uuid[]), CAST(:dr AS timestamptz[]), CAST(:s AS bigint[])) "
            "AS v(chat_id, h, dr, s) WHERE cs.user_id = :u AND cs.chat_id = v.chat_id",
            {
                "u": user_id,
                "c": chats,
                "h": [h for _, h, _ in grants],
                "dr": [None if self.hub.is_online(h) else now for _, h, _ in grants],
                "s": [s for _, _, s in grants],
            },
        )
        rows = await fetchall(
            conn,
            STATE_SELECT + "WHERE cs.user_id = :u AND cs.chat_id = ANY(CAST(:c AS text[]))",
            {"u": user_id, "c": chats},
        )
        by_chat = {r.chat_id: r for r in rows}
        states: list[dict[str, Any]] = []
        for st, new_host, _ in grants:
            state = serialize(
                by_chat[st.chat_id],
                self.hub.is_online,
                {"kind": "host_changed", "device_id": str(new_host), "reason": reason},
            )
            states.append(state)
            post.append(self._after_grant(user_id, st.host_device_id, new_host, state, reason))
        return states

    def _after_grant(
        self, user_id: uuid.UUID, old: uuid.UUID | None, new_host: uuid.UUID, state: dict[str, Any], reason: str
    ) -> Callable[[], None]:
        chat_id, epoch, head = state["chat_id"], state["epoch"], state["head"]

        def after() -> None:
            self._cancel(self.force_timers, (user_id, chat_id))
            self.broadcast_state(user_id, state)
            self.hub.send_device(new_host, {"t": "host.granted", "chat_id": chat_id, "epoch": epoch, "head": head})
            if old is not None and old != new_host:
                self._revoke_msg(
                    user_id, old, {"t": "host.revoked", "chat_id": chat_id, "epoch": epoch, "reason": reason}
                )

        return after

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
            await self._assert_active(conn, c)
            if await self._chat_deleted(conn, c.user_id, chat_id):
                raise ApiError("not_found", details={"chat_id": chat_id})
            st = await self._ensure(conn, c.user_id, chat_id)
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
            await self._assert_active(conn, c)
            if await self._chat_deleted(conn, c.user_id, chat_id):
                raise ApiError("not_found", details={"chat_id": chat_id})
            st = await self._ensure(conn, c.user_id, chat_id)
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
            await self._ensure(conn, c.user_id, chat_id)
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
            ho = {
                st.handover_to
                for st in rows
                if st.host_device_id == c.device_id and st.handover_to is not None and st.handover_to != c.device_id
            }
            names: dict[uuid.UUID, str] = {}
            if ho:
                names = {
                    r.id: r.name
                    for r in await fetchall(
                        conn, "SELECT id, name FROM devices WHERE id = ANY(CAST(:d AS uuid[]))", {"d": list(ho)}
                    )
                }
            # mudanças de cada chat: (chat_id, limpa a queda, fecha a janela, prazo da troca forçada, evento)
            changes: list[tuple[str, bool, bool, Any, dict[str, Any] | None]] = []
            for st in rows:
                if st.host_device_id != c.device_id:
                    if st.chat_id in claimed:
                        lost.append(st.chat_id)
                        after_welcome.append(
                            {"t": "host.revoked", "chat_id": st.chat_id, "epoch": int(st.epoch), "reason": "takeover"}
                        )
                    continue
                clear_drop = close_window = False
                deadline = None
                event: dict[str, Any] | None = None
                if st.host_dropped_at is not None or st.host_grace_deadline is not None:
                    clear_drop = True
                    event = {"kind": "host_back", "device_id": str(c.device_id)}
                window_open = st.window_purpose is not None
                if st.chat_id in claimed:
                    if window_open and claimed[st.chat_id] == int(st.epoch):
                        resumed.append(st.chat_id)
                    else:
                        lost.append(st.chat_id)
                        if window_open:
                            close_window = True
                            event = event or {"kind": "turn_ended", "device_id": str(c.device_id)}
                elif window_open:
                    close_window = True
                    event = event or {"kind": "turn_ended", "device_id": str(c.device_id)}
                if st.handover_to is not None and st.handover_to != c.device_id:
                    if st.handover_mode == "force" and st.handover_deadline is None:
                        deadline = utcnow() + timedelta(seconds=self.settings.handover_force_timeout_s)
                        force_keys.append((c.user_id, st.chat_id))
                    after_welcome.append(
                        {
                            "t": "host.handover_request",
                            "chat_id": st.chat_id,
                            "epoch": int(st.epoch),
                            "to_device_id": str(st.handover_to),
                            "to_name": names.get(st.handover_to, ""),
                            "mode": st.handover_mode,
                        }
                    )
                if clear_drop or close_window or deadline is not None:
                    changes.append((st.chat_id, clear_drop, close_window, deadline, event))
            if changes:
                # tudo num UPDATE (O(1) comandos por conexão): ssq em sequência na ordem de chat_id, como antes
                first = await next_ssq(conn, c.user_id, len(changes))
                await execute(
                    conn,
                    "UPDATE chat_states cs SET "
                    "host_dropped_at = CASE WHEN v.cd THEN NULL ELSE cs.host_dropped_at END, "
                    "host_grace_deadline = CASE WHEN v.cd THEN NULL ELSE cs.host_grace_deadline END, "
                    "window_purpose = CASE WHEN v.cw THEN NULL ELSE cs.window_purpose END, "
                    "window_since = CASE WHEN v.cw THEN NULL ELSE cs.window_since END, "
                    "handover_deadline = COALESCE(v.hd, cs.handover_deadline), ssq = v.s, updated_at = now() "
                    "FROM unnest(CAST(:c AS text[]), CAST(:cd AS boolean[]), CAST(:cw AS boolean[]), "
                    "CAST(:hd AS timestamptz[]), CAST(:s AS bigint[])) AS v(chat_id, cd, cw, hd, s) "
                    "WHERE cs.user_id = :u AND cs.chat_id = v.chat_id",
                    {
                        "u": c.user_id,
                        "c": [ch[0] for ch in changes],
                        "cd": [ch[1] for ch in changes],
                        "cw": [ch[2] for ch in changes],
                        "hd": [ch[3] for ch in changes],
                        "s": [first + i for i in range(len(changes))],
                    },
                )
                events = {ch[0]: ch[4] for ch in changes}
                got = await fetchall(
                    conn,
                    STATE_SELECT + "WHERE cs.user_id = :u AND cs.ssq BETWEEN :a AND :b ORDER BY cs.ssq",
                    {"u": c.user_id, "a": first, "b": first + len(changes) - 1},
                )
                states = [serialize(r, self.hub.is_online, events[r.chat_id]) for r in got]
            claimed_missing = [ch for ch in claimed if ch not in {r.chat_id for r in rows}]
            lost.extend(claimed_missing)
        # a varredura de tolerância do usuário reconfere tudo no banco: os chats deste host já não vencem
        for st_json in states:
            self.broadcast_state(c.user_id, st_json)
        for key in force_keys:
            self._schedule(self.force_timers, key, self.settings.handover_force_timeout_s, self._force_expired)
        _, q = self.pending_revocations.pop(c.device_id, (c.user_id, {}))
        seen = {m["chat_id"] for m in after_welcome if m["t"] == "host.revoked"}
        after_welcome = [m for m in q.values() if m["chat_id"] not in seen] + after_welcome
        return resumed, lost, after_welcome

    async def on_disconnect(self, c: Conn) -> None:
        if self._closing:
            return
        # comandos em trânsito para este host: falham agora (nunca reentregues)
        for key, pc in list(self.pending.items()):
            if pc.host == c.device_id and pc.user_id == c.user_id:
                self._fail(key, "host_offline")
        grace = self.settings.host_drop_grace_s
        rows: list[Any] = []
        async with self.engine.begin() as conn:
            await lock_user(conn, c.user_id)
            if self.hub.is_online(c.device_id):  # reconectou nesse meio-tempo
                return
            # todos os chats deste host de uma vez (O(1) comandos por queda): ssq em sequência na ordem de
            # chat_id. Quem escreve em chat_states trava antes a linha do usuário, então o conjunto não muda
            p = {"u": c.user_id, "d": c.device_id}
            n = int(
                await fetchval(
                    conn,
                    "SELECT count(*) FROM chat_states WHERE user_id = :u AND host_device_id = :d "
                    "AND host_dropped_at IS NULL",
                    p,
                )
            )
            if n:
                now = utcnow()
                first = await next_ssq(conn, c.user_id, n)
                await execute(
                    conn,
                    "WITH t AS (SELECT chat_id, row_number() OVER (ORDER BY chat_id) - 1 AS k FROM chat_states "
                    "WHERE user_id = :u AND host_device_id = :d AND host_dropped_at IS NULL) "
                    "UPDATE chat_states cs SET host_dropped_at = :now, host_grace_deadline = :dl, ssq = :first + t.k, "
                    "updated_at = now() FROM t WHERE cs.user_id = :u AND cs.chat_id = t.chat_id",
                    {**p, "now": now, "dl": now + timedelta(seconds=grace), "first": first},
                )
                rows = await fetchall(
                    conn,
                    STATE_SELECT + "WHERE cs.user_id = :u AND cs.ssq BETWEEN :a AND :b ORDER BY cs.ssq",
                    {"u": c.user_id, "a": first, "b": first + n - 1},
                )
        for row in rows:
            self.broadcast_state(c.user_id, serialize(row, self.hub.is_online))
        if rows:
            self._schedule_sweep("grace", c.user_id, grace)

    async def _grace_sweep(self, user_id: uuid.UUID, _key: str = SWEEP) -> None:
        """Fim da tolerância (§8.3): todos os chats do usuário com o prazo vencido e o host fora, numa
        transação e O(1) comandos (caiu → janela fechada; troca pendente → novo host). Reagenda para o
        próximo prazo, se houver."""
        self._sweep_due.pop(("grace", user_id), None)
        post: Post = []
        async with self.engine.begin() as conn:
            await lock_user(conn, user_id)
            limit = utcnow() + timedelta(milliseconds=50)
            rows = [
                r
                for r in await fetchall(
                    conn,
                    "SELECT * FROM chat_states WHERE user_id = :u AND host_device_id IS NOT NULL "
                    "AND host_grace_deadline IS NOT NULL AND host_grace_deadline <= :t ORDER BY chat_id FOR UPDATE",
                    {"u": user_id, "t": limit},
                )
                if not self.hub.is_online(r.host_device_id)
            ]
            if rows:
                # ssq como se fosse chat a chat: queda e, logo depois, a concessão da troca pendente
                s = await next_ssq(conn, user_id, len(rows) + sum(1 for r in rows if r.handover_to is not None))
                drops: list[tuple[str, int]] = []
                grants: list[tuple[Any, uuid.UUID, int]] = []
                for r in rows:
                    drops.append((r.chat_id, s))
                    s += 1
                    if r.handover_to is not None:
                        grants.append((r, r.handover_to, s))
                        s += 1
                chats = [ch for ch, _ in drops]
                await execute(
                    conn,
                    "UPDATE chat_states cs SET window_purpose = NULL, window_since = NULL, host_grace_deadline = NULL, "
                    "ssq = v.s, updated_at = now() FROM unnest(CAST(:c AS text[]), CAST(:s AS bigint[])) AS v(chat_id, s) "
                    "WHERE cs.user_id = :u AND cs.chat_id = v.chat_id",
                    {"u": user_id, "c": chats, "s": [x for _, x in drops]},
                )
                dropped = {
                    r.chat_id: serialize(
                        r, self.hub.is_online, {"kind": "host_dropped", "device_id": str(r.host_device_id)}
                    )
                    for r in await fetchall(
                        conn,
                        STATE_SELECT + "WHERE cs.user_id = :u AND cs.chat_id = ANY(CAST(:c AS text[]))",
                        {"u": user_id, "c": chats},
                    )
                }
                granted: dict[str, Callable[[], None]] = {}
                if grants:
                    gpost: Post = []
                    gstates = await self._grant_many(conn, user_id, grants, "takeover", gpost)
                    granted = {st["chat_id"]: fn for st, fn in zip(gstates, gpost, strict=True)}
                for ch in chats:  # mesma ordem de antes, chat a chat: caiu → novo host
                    post.append(functools.partial(self.broadcast_state, user_id, dropped[ch]))
                    if ch in granted:
                        post.append(granted[ch])
            nxt = await fetchval(
                conn,
                "SELECT min(host_grace_deadline) FROM chat_states WHERE user_id = :u AND host_device_id IS NOT NULL "
                "AND host_grace_deadline > :t",
                {"u": user_id, "t": limit},
            )
        self._run(post)
        if nxt is not None:
            self._schedule_sweep("grace", user_id, (nxt - utcnow()).total_seconds())

    async def _force_sweep(self, user_id: uuid.UUID, _key: str = SWEEP) -> None:
        """Trocas forçadas vencidas do usuário (reagendadas no boot), numa transação."""
        self._sweep_due.pop(("force", user_id), None)
        post: Post = []
        async with self.engine.begin() as conn:
            await lock_user(conn, user_id)
            limit = utcnow() + timedelta(milliseconds=50)
            rows = await fetchall(
                conn,
                "SELECT * FROM chat_states WHERE user_id = :u AND handover_to IS NOT NULL AND handover_mode = 'force' "
                "AND handover_deadline IS NOT NULL AND handover_deadline <= :t ORDER BY chat_id FOR UPDATE",
                {"u": user_id, "t": limit},
            )
            if rows:
                s = await next_ssq(conn, user_id, len(rows))
                await self._grant_many(
                    conn, user_id, [(r, r.handover_to, s + i) for i, r in enumerate(rows)], "takeover", post
                )
            nxt = await fetchval(
                conn,
                "SELECT min(handover_deadline) FROM chat_states WHERE user_id = :u AND handover_deadline > :t",
                {"u": user_id, "t": limit},
            )
        self._run(post)
        if nxt is not None:
            self._schedule_sweep("force", user_id, (nxt - utcnow()).total_seconds())

    async def boot(self) -> None:
        """Reinício do servidor (§8.3 (4)): todas as conexões caíram; hosts que estavam conectados (ou em
        tolerância) ganham SERVER_RESTART_GRACE_S a partir do boot. Trocas forçadas pendentes são reagendadas.
        Tudo em O(1) comandos (ssq novos por usuário, na ordem de chat_id) e um timer por usuário: a subida
        não cresce com o número de chats."""
        restart = self.settings.server_restart_grace_s
        now = utcnow()
        async with self.engine.begin() as conn:
            await execute(
                conn,
                "WITH t AS (SELECT user_id, chat_id, row_number() OVER (PARTITION BY user_id ORDER BY chat_id) AS k "
                "FROM chat_states WHERE host_device_id IS NOT NULL "
                "AND (host_dropped_at IS NULL OR host_grace_deadline IS NOT NULL)), "
                "n AS (SELECT user_id, count(*) AS n FROM t GROUP BY user_id), "
                "u AS (UPDATE users SET state_seq = users.state_seq + n.n FROM n WHERE users.id = n.user_id "
                "RETURNING users.id, users.state_seq - n.n AS base) "
                "UPDATE chat_states cs SET host_dropped_at = COALESCE(cs.host_dropped_at, :now), "
                "host_grace_deadline = GREATEST(COALESCE(cs.host_grace_deadline, :now), :dl), ssq = u.base + t.k, "
                "updated_at = now() FROM t JOIN u ON u.id = t.user_id "
                "WHERE cs.user_id = t.user_id AND cs.chat_id = t.chat_id",
                {"now": now, "dl": now + timedelta(seconds=restart)},
            )
            hosted = await fetchall(
                conn,
                "SELECT user_id, min(host_grace_deadline) AS due FROM chat_states "
                "WHERE host_device_id IS NOT NULL AND host_grace_deadline IS NOT NULL GROUP BY user_id",
            )
            forced = await fetchall(
                conn,
                "SELECT user_id, min(handover_deadline) AS due FROM chat_states WHERE handover_deadline IS NOT NULL "
                "GROUP BY user_id",
            )
        for r in hosted:
            self._schedule_sweep("grace", r.user_id, (r.due - now).total_seconds())
        for r in forced:
            self._schedule_sweep("force", r.user_id, (r.due - now).total_seconds())

    async def shutdown(self) -> None:
        self._closing = True
        for timers in (self.grace_timers, self.force_timers):
            for t in timers.values():
                t.cancel()
            timers.clear()
        self._sweep_due.clear()
        for pc in self.pending.values():
            if pc.timer is not None:
                pc.timer.cancel()
        self.pending.clear()

    def forget_user(self, user_id: uuid.UUID) -> None:
        """Conta apagada / banida / chaves zeradas: descarta timers, comandos e host.revoked em memória."""
        for timers in (self.grace_timers, self.force_timers):
            for key in [k for k in timers if k[0] == user_id]:
                self._cancel(timers, key)
        for sk in [k for k in self._sweep_due if k[1] == user_id]:
            del self._sweep_due[sk]
        for key in [k for k in self.pending if k[0] == user_id]:
            pc = self.pending.pop(key)
            if pc.timer is not None:
                pc.timer.cancel()
        for d in [d for d, (u, _) in self.pending_revocations.items() if u == user_id]:
            del self.pending_revocations[d]

    def forget_devices(self, device_ids: list[uuid.UUID]) -> None:
        """Dispositivos revogados nunca mais conectam: os host.revoked guardados para eles saem."""
        for d in device_ids:
            self.pending_revocations.pop(d, None)

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
            await self._assert_active(conn, c)
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
        # estado de taxa por conexão (Conn.stream_rate, some com ela), só para chats que ela hospeda: um host
        # já acima da taxa neste chat é descartado sem ir ao banco; quem não é host nunca aloca nada
        rate = c.stream_rate
        if not _stream_rate_ok(rate, chat_id, time.monotonic()):
            return
        # autorização (uma linha por chave primária) ANTES de guardar qualquer estado novo
        st = await self._host_of(c.user_id, chat_id)
        if st is None or st.host_device_id != c.device_id or int(st.epoch) != epoch:
            return
        now = time.monotonic()
        if not _stream_rate_ok(rate, chat_id, now):
            return
        dq = rate.get(chat_id)
        if dq is None:
            if len(rate) >= STREAM_MAX_CHATS:
                for k in [k for k, v in rate.items() if not v or now - v[-1] > 1.0]:
                    del rate[k]
                if len(rate) >= STREAM_MAX_CHATS:
                    return
            dq = rate[chat_id] = deque()
        dq.append(now)
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
