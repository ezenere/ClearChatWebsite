"""Recontagem dos contadores de uso (`users.usage_*`) a partir das tabelas — conserta deriva antiga (§7.10).

Cada usuário numa transação própria, com a linha de `users` travada (FOR UPDATE, o mesmo lock do push e do
upload de blob): a contagem roda depois do lock, então nada commitado no meio fica de fora."""

from __future__ import annotations

import uuid
from typing import Any

from sqlalchemy.ext.asyncio import AsyncEngine

from ..db import execute, fetchall, fetchone

USAGE_COLS = ("usage_records", "usage_record_bytes", "usage_blobs", "usage_blob_bytes")


async def recompute_user(engine: AsyncEngine, user_id: uuid.UUID) -> dict[str, Any] | None:
    """Recalcula e grava. Devolve {coluna: (antes, depois)} só do que mudou, ou None se o usuário não existe."""
    async with engine.begin() as conn:
        before = await fetchone(
            conn, f"SELECT {', '.join(USAGE_COLS)} FROM users WHERE id = :u FOR UPDATE", {"u": user_id}
        )
        if before is None:
            return None
        after = await fetchone(
            conn,
            "SELECT (SELECT count(*) FROM records WHERE user_id = :u AND NOT deleted) AS usage_records, "
            "(SELECT COALESCE(sum(size), 0) FROM records WHERE user_id = :u AND NOT deleted) AS usage_record_bytes, "
            "(SELECT count(*) FROM blobs WHERE user_id = :u) AS usage_blobs, "
            "(SELECT COALESCE(sum(size), 0) FROM blobs WHERE user_id = :u) AS usage_blob_bytes",
            {"u": user_id},
        )
        assert after is not None
        diff = {
            c: (int(getattr(before, c)), int(getattr(after, c)))
            for c in USAGE_COLS
            if int(getattr(before, c)) != int(getattr(after, c))
        }
        if diff:
            await execute(
                conn,
                "UPDATE users SET usage_records = :r, usage_record_bytes = :rb, usage_blobs = :b, "
                "usage_blob_bytes = :bb WHERE id = :u",
                {
                    "u": user_id,
                    "r": int(after.usage_records),
                    "rb": int(after.usage_record_bytes),
                    "b": int(after.usage_blobs),
                    "bb": int(after.usage_blob_bytes),
                },
            )
    return diff


async def recompute_all(engine: AsyncEngine, user_id: uuid.UUID | None = None) -> dict[str, Any]:
    """Recalcula um usuário (`user_id`) ou todos. → {checked, fixed, changes: {user_id: diff}}"""
    if user_id is not None:
        ids = [user_id]
    else:
        async with engine.connect() as conn:
            ids = [r.id for r in await fetchall(conn, "SELECT id FROM users ORDER BY id")]
    changes: dict[str, Any] = {}
    for uid in ids:
        diff = await recompute_user(engine, uid)
        if diff:
            changes[str(uid)] = diff
    return {"checked": len(ids), "fixed": len(changes), "changes": changes}
