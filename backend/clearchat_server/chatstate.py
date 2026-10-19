"""Estado de host/divergência por chat (`chat_states`, §8.2) e serialização `ChatState`."""

from __future__ import annotations

import uuid
from collections.abc import Callable
from typing import Any

from sqlalchemy.ext.asyncio import AsyncConnection

from .db import execute, fetchall, fetchone, fetchval
from .util import iso, utcnow

STATE_SELECT = (
    "SELECT cs.*, hd.name AS host_name, hd.platform AS host_platform, ho.name AS handover_name, "
    "dd.name AS diverged_name "
    "FROM chat_states cs "
    "LEFT JOIN devices hd ON hd.id = cs.host_device_id "
    "LEFT JOIN devices ho ON ho.id = cs.handover_to "
    "LEFT JOIN devices dd ON dd.id = cs.diverged_device_id "
)


async def next_ssq(conn: AsyncConnection, user_id: uuid.UUID, n: int = 1) -> int:
    """Reserva `n` valores de ssq; devolve o primeiro. Trava a linha do usuário."""
    last = await fetchval(
        conn, "UPDATE users SET state_seq = state_seq + :n WHERE id = :u RETURNING state_seq", {"u": user_id, "n": n}
    )
    return int(last) - n + 1


async def lock_user(conn: AsyncConnection, user_id: uuid.UUID) -> Any:
    return await fetchone(conn, "SELECT * FROM users WHERE id = :u FOR UPDATE", {"u": user_id})


async def lock_state(conn: AsyncConnection, user_id: uuid.UUID, chat_id: str) -> Any:
    return await fetchone(
        conn, "SELECT * FROM chat_states WHERE user_id = :u AND chat_id = :c FOR UPDATE", {"u": user_id, "c": chat_id}
    )


async def ensure_state(conn: AsyncConnection, user_id: uuid.UUID, chat_id: str) -> Any:
    """Linha travada do chat (cria se não existir, com ssq novo)."""
    row = await lock_state(conn, user_id, chat_id)
    if row is None:
        ssq = await next_ssq(conn, user_id)
        await execute(
            conn,
            "INSERT INTO chat_states (user_id, chat_id, ssq) VALUES (:u, :c, :s) ON CONFLICT DO NOTHING",
            {"u": user_id, "c": chat_id, "s": ssq},
        )
        row = await lock_state(conn, user_id, chat_id)
    return row


async def load_state(conn: AsyncConnection, user_id: uuid.UUID, chat_id: str) -> Any:
    return await fetchone(
        conn, STATE_SELECT + "WHERE cs.user_id = :u AND cs.chat_id = :c", {"u": user_id, "c": chat_id}
    )


async def load_states_since(conn: AsyncConnection, user_id: uuid.UUID, since: int) -> list[Any]:
    return await fetchall(
        conn, STATE_SELECT + "WHERE cs.user_id = :u AND cs.ssq > :s ORDER BY cs.ssq", {"u": user_id, "s": since}
    )


def host_status(row: Any, is_online: Callable[[uuid.UUID], bool]) -> str | None:
    if row.host_device_id is None:
        return None
    if is_online(row.host_device_id):
        return "online"
    if row.host_grace_deadline is not None and row.host_grace_deadline > utcnow():
        return "grace"
    return "offline"


def serialize(row: Any, is_online: Callable[[uuid.UUID], bool], event: dict[str, Any] | None = None) -> dict[str, Any]:
    st = host_status(row, is_online)
    out: dict[str, Any] = {
        "chat_id": row.chat_id,
        "ssq": int(row.ssq),
        "epoch": int(row.epoch),
        "head": int(row.head),
        "pinned": bool(row.pinned),
        "host": None
        if row.host_device_id is None
        else {
            "device_id": str(row.host_device_id),
            "name": row.host_name or "",
            "platform": row.host_platform or "",
            "status": st,
        },
        "window": None
        if row.window_purpose is None
        else {"purpose": row.window_purpose, "since": iso(row.window_since)},
        "handover": None
        if row.handover_to is None
        else {
            "to_device_id": str(row.handover_to),
            "to_name": row.handover_name or "",
            "mode": row.handover_mode,
            "requested_at": iso(row.handover_requested_at),
        },
        "diverged": None
        if row.divergence_id is None
        else {
            "divergence_id": str(row.divergence_id),
            "device_id": str(row.diverged_device_id),
            "device_name": row.diverged_name or "",
            "base": int(row.diverged_base),
            "head": int(row.diverged_head),
            "since": iso(row.diverged_at),
        },
    }
    if event is not None:
        out["event"] = {k: v for k, v in event.items() if v is not None}
    return out
