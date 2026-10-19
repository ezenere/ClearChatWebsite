"""Operações de conta compartilhadas entre a api e o painel admin (só banco; os efeitos em tempo real —
fechar WebSockets, broadcasts — ficam com quem chama)."""

from __future__ import annotations

import json
import uuid
from typing import Any

from sqlalchemy.ext.asyncio import AsyncConnection

from ..chatstate import next_ssq
from ..db import execute, fetchall, fetchval

EVENTS_CHANNEL = "clearchat_events"


async def log_activity(
    conn: AsyncConnection,
    kind: str,
    user_id: uuid.UUID | None = None,
    device_id: uuid.UUID | None = None,
    ip: str | None = None,
    meta: dict[str, Any] | None = None,
) -> None:
    await execute(
        conn,
        "INSERT INTO activity (user_id, device_id, kind, ip, meta) VALUES (:u, :d, :k, CAST(:ip AS inet), CAST(:m AS jsonb))",
        {"u": user_id, "d": device_id, "k": kind, "ip": ip, "m": json.dumps(meta) if meta is not None else None},
    )


async def notify(conn: AsyncConnection, payload: dict[str, Any]) -> None:
    """NOTIFY para a api (eventos do painel admin: ban, apagar conta, configurações)."""
    await execute(conn, "SELECT pg_notify(:ch, :p)", {"ch": EVENTS_CHANNEL, "p": json.dumps(payload)})


async def release_hosted_chats(conn: AsyncConnection, user_id: uuid.UUID, device_ids: list[uuid.UUID]) -> list[str]:
    """§8.3 (5): dispositivo revogado deixa de ser host (host = null) e de ser destino de troca."""
    if not device_ids:
        return []
    rows = await fetchall(
        conn,
        "SELECT chat_id FROM chat_states WHERE user_id = :u AND (host_device_id = ANY(CAST(:d AS uuid[])) "
        "OR handover_to = ANY(CAST(:d AS uuid[]))) ORDER BY chat_id FOR UPDATE",
        {"u": user_id, "d": device_ids},
    )
    chats = [r.chat_id for r in rows]
    if not chats:
        return []
    first = await next_ssq(conn, user_id, len(chats))
    for i, chat_id in enumerate(chats):
        await execute(
            conn,
            "UPDATE chat_states SET "
            "host_device_id = CASE WHEN host_device_id = ANY(CAST(:d AS uuid[])) THEN NULL ELSE host_device_id END, "
            "epoch = CASE WHEN host_device_id = ANY(CAST(:d AS uuid[])) THEN epoch + 1 ELSE epoch END, "
            "window_purpose = CASE WHEN host_device_id = ANY(CAST(:d AS uuid[])) THEN NULL ELSE window_purpose END, "
            "window_since = CASE WHEN host_device_id = ANY(CAST(:d AS uuid[])) THEN NULL ELSE window_since END, "
            "host_dropped_at = CASE WHEN host_device_id = ANY(CAST(:d AS uuid[])) THEN NULL ELSE host_dropped_at END, "
            "host_grace_deadline = CASE WHEN host_device_id = ANY(CAST(:d AS uuid[])) "
            "  THEN NULL ELSE host_grace_deadline END, "
            "handover_to = NULL, handover_mode = NULL, handover_requested_at = NULL, handover_deadline = NULL, "
            "ssq = :s, updated_at = now() WHERE user_id = :u AND chat_id = :c",
            {"u": user_id, "c": chat_id, "d": device_ids, "s": first + i},
        )
    return chats


async def revoke_devices(
    conn: AsyncConnection, user_id: uuid.UUID, device_ids: list[uuid.UUID] | None = None
) -> tuple[list[uuid.UUID], list[str]]:
    """Revoga dispositivos (todos, se `device_ids` for None). Devolve (revogados, chats alterados)."""
    if device_ids is None:
        rows = await fetchall(conn, "SELECT id FROM devices WHERE user_id = :u AND revoked_at IS NULL", {"u": user_id})
    else:
        rows = await fetchall(
            conn,
            "SELECT id FROM devices WHERE user_id = :u AND revoked_at IS NULL AND id = ANY(CAST(:d AS uuid[]))",
            {"u": user_id, "d": device_ids},
        )
    ids = [r.id for r in rows]
    if not ids:
        return [], []
    await execute(
        conn,
        "UPDATE devices SET revoked_at = now(), refresh_hash = NULL, refresh_expires_at = NULL "
        "WHERE id = ANY(CAST(:d AS uuid[]))",
        {"d": ids},
    )
    await execute(conn, "DELETE FROM access_tokens WHERE device_id = ANY(CAST(:d AS uuid[]))", {"d": ids})
    chats = await release_hosted_chats(conn, user_id, ids)
    return ids, chats


async def wipe_user_data(conn: AsyncConnection, user_id: uuid.UUID) -> None:
    """Apaga todos os registros, blobs (linhas), estados de chat e recibos (keys/reset). Os arquivos de
    blob são apagados por quem chama. O seq continua monotônico; o piso de tombstones sobe até ele
    (cursores antigos → 410 cursor_expired → resync)."""
    await execute(conn, "DELETE FROM records WHERE user_id = :u", {"u": user_id})
    await execute(conn, "DELETE FROM blobs WHERE user_id = :u", {"u": user_id})
    await execute(conn, "DELETE FROM chat_states WHERE user_id = :u", {"u": user_id})
    await execute(conn, "DELETE FROM divergence_discards WHERE user_id = :u", {"u": user_id})
    await execute(conn, "DELETE FROM push_receipts WHERE user_id = :u", {"u": user_id})
    await execute(
        conn,
        "UPDATE users SET usage_record_bytes = 0, usage_records = 0, usage_blob_bytes = 0, usage_blobs = 0, "
        "tombstone_floor = seq WHERE id = :u",
        {"u": user_id},
    )


async def delete_user(conn: AsyncConnection, user_id: uuid.UUID) -> bool:
    n = await fetchval(
        conn, "WITH d AS (DELETE FROM users WHERE id = :u RETURNING 1) SELECT count(*) FROM d", {"u": user_id}
    )
    return bool(n)


async def ban_user(conn: AsyncConnection, user_id: uuid.UUID, reason: str | None) -> list[uuid.UUID]:
    await execute(
        conn,
        "UPDATE users SET status = 'banned', banned_at = now(), banned_reason = :r WHERE id = :u",
        {"u": user_id, "r": reason},
    )
    # códigos pendentes deixam de valer
    await execute(
        conn,
        "UPDATE email_codes SET invalidated_at = now() WHERE user_id = :u AND consumed_at IS NULL "
        "AND invalidated_at IS NULL",
        {"u": user_id},
    )
    ids, _ = await revoke_devices(conn, user_id)
    return ids


async def unban_user(conn: AsyncConnection, user_id: uuid.UUID) -> None:
    await execute(
        conn, "UPDATE users SET status = 'active', banned_at = NULL, banned_reason = NULL WHERE id = :u", {"u": user_id}
    )


async def create_user(
    conn: AsyncConnection, email: str, name: str, settings: Any, created_by: str = "admin"
) -> uuid.UUID:
    """Usuário só com e-mail + nome (keys_ready = false): entra por código e define a senha no /setup."""
    row = await fetchval(
        conn,
        "INSERT INTO users (email, name, created_by, quota_record_bytes, quota_records, quota_blob_bytes, quota_devices) "
        "VALUES (:e, :n, :cb, :q1, :q2, :q3, :q4) RETURNING id",
        {
            "e": email,
            "n": name,
            "cb": created_by,
            "q1": settings.default_quota_record_bytes,
            "q2": settings.default_quota_records,
            "q3": settings.default_quota_blob_bytes,
            "q4": settings.default_quota_devices,
        },
    )
    return uuid.UUID(str(row))


async def create_invite(conn: AsyncConnection, email: str | None, note: str | None, days: int) -> tuple[uuid.UUID, str]:
    """Convite de uso único (§5.3): token opaco de 32 bytes; guardado só como SHA-256."""
    import secrets
    from datetime import timedelta

    from ..security import sha256
    from ..util import b64u_encode, utcnow

    token = b64u_encode(secrets.token_bytes(32))
    iid = await fetchval(
        conn,
        "INSERT INTO invites (token_hash, email, note, expires_at) VALUES (:h, :e, :n, :x) RETURNING id",
        {"h": sha256(token.encode()), "e": email, "n": note, "x": utcnow() + timedelta(days=days)},
    )
    return uuid.UUID(str(iid)), token
