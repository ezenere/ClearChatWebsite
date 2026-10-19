"""Jobs periódicos (GC e expirações) e ouvinte de eventos do painel admin (LISTEN/NOTIFY)."""

from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import uuid
from datetime import datetime, timedelta
from typing import Any

from ..chatstate import load_state, serialize
from ..context import AppContext
from ..db import execute, fetchall, fetchval
from ..services.accounts import EVENTS_CHANNEL
from ..util import utcnow

log = logging.getLogger("clearchat.jobs")
GC_LOCK_KEY = 0x6363_6763  # "ccgc"


async def run_gc(ctx: AppContext, now: datetime | None = None) -> dict[str, int]:
    """Uma passada de GC. Usa pg_try_advisory_xact_lock para nunca rodar em dobro."""
    s = ctx.settings
    now = now or utcnow()
    out: dict[str, int] = {}
    files: list[tuple[uuid.UUID, str]] = []
    async with ctx.engine.begin() as conn:
        if not await fetchval(conn, "SELECT pg_try_advisory_xact_lock(:k)", {"k": GC_LOCK_KEY}):
            return {"skipped": 1}
        # tombstones antigos → sobe o piso do usuário (cursores abaixo dele → 410 cursor_expired)
        rows = await fetchall(
            conn,
            "WITH d AS (DELETE FROM records WHERE deleted AND updated_at < :t RETURNING user_id, seq) "
            "SELECT user_id, max(seq) AS m, count(*) AS n FROM d GROUP BY user_id",
            {"t": now - timedelta(days=s.tombstone_retention_days)},
        )
        for r in rows:
            await execute(
                conn,
                "UPDATE users SET tombstone_floor = GREATEST(tombstone_floor, :m) WHERE id = :u",
                {"u": r.user_id, "m": int(r.m)},
            )
        out["tombstones"] = sum(int(r.n) for r in rows)
        # blobs sem referência viva há mais de BLOB_ORPHAN_GRACE_H
        orphans = await fetchall(
            conn,
            "DELETE FROM blobs b WHERE b.unreferenced_since < :t AND NOT EXISTS (SELECT 1 FROM record_blobs rb "
            "WHERE rb.user_id = b.user_id AND rb.blob_id = b.blob_id) RETURNING user_id, blob_id, size",
            {"t": now - timedelta(hours=s.blob_orphan_grace_h)},
        )
        per_user: dict[uuid.UUID, tuple[int, int]] = {}
        for o in orphans:
            n, b = per_user.get(o.user_id, (0, 0))
            per_user[o.user_id] = (n + 1, b + int(o.size))
            files.append((o.user_id, o.blob_id))
        for uid, (n, b) in per_user.items():
            await execute(
                conn,
                "UPDATE users SET usage_blobs = GREATEST(usage_blobs - :n, 0), "
                "usage_blob_bytes = GREATEST(usage_blob_bytes - :b, 0) WHERE id = :u",
                {"u": uid, "n": n, "b": b},
            )
        out["blobs"] = len(orphans)
        simple = {
            "push_receipts": (
                "DELETE FROM push_receipts WHERE created_at < :t",
                now - timedelta(days=s.push_receipt_ttl_days),
            ),
            "email_codes": ("DELETE FROM email_codes WHERE expires_at < :t", now - timedelta(days=1)),
            "rate_counters": ("DELETE FROM rate_counters WHERE window_start < :t", now - timedelta(days=2)),
            "activity": ("DELETE FROM activity WHERE at < :t", now - timedelta(days=s.activity_retention_days)),
            "access_tokens": ("DELETE FROM access_tokens WHERE expires_at < :t", now),
            "lockouts": ("DELETE FROM lockouts WHERE until < :t", now - timedelta(days=7)),
        }
        for name, (sql, t) in simple.items():
            out[name] = await execute(conn, sql, {"t": t})
    for uid, blob_id in files:
        ctx.blobs.remove(uid, blob_id)
    if any(out.values()):
        log.info("gc", extra=out)
    return out


async def gc_loop(ctx: AppContext) -> None:
    while True:
        await asyncio.sleep(ctx.settings.gc_interval_s)
        try:
            await run_gc(ctx)
        except Exception:
            log.exception("falha no GC")


# ---------------------------------------------------------------- eventos do painel admin
async def handle_event(ctx: AppContext, payload: dict[str, Any]) -> None:
    kind = payload.get("kind")
    if kind == "settings_changed":
        ctx.instance.invalidate()
        return
    try:
        user_id = uuid.UUID(str(payload.get("user_id")))
    except ValueError:
        return
    if kind == "user_banned":
        ctx.coordinator.forget_user(user_id)
        ctx.hub.close_user(user_id, 4403, "account_disabled")
    elif kind == "user_deleted":
        ctx.coordinator.forget_user(user_id)
        ctx.hub.close_user(user_id, 4403, "account_deleted", final={"t": "account.deleted"})
    elif kind == "devices_revoked":
        for d in payload.get("device_ids") or []:
            with contextlib.suppress(ValueError):
                ctx.hub.close_device(uuid.UUID(str(d)), 4403, "device_revoked")
        chats = payload.get("chats") or []
        if chats:
            async with ctx.engine.connect() as conn:
                for chat_id in chats:
                    row = await load_state(conn, user_id, str(chat_id))
                    if row is not None:
                        ctx.coordinator.broadcast_state(user_id, serialize(row, ctx.hub.is_online))


async def notify_listener(ctx: AppContext) -> None:
    import asyncpg

    dsn = ctx.settings.database_url.replace("postgresql+asyncpg://", "postgresql://", 1)
    loop = asyncio.get_running_loop()
    pending: set[asyncio.Task[None]] = set()
    while True:
        conn = None
        try:
            conn = await asyncpg.connect(dsn)

            def on_notify(_c: Any, _pid: int, _ch: str, data: str) -> None:
                try:
                    payload = json.loads(data)
                except ValueError:
                    return
                if isinstance(payload, dict):
                    t = loop.create_task(handle_event(ctx, payload))
                    pending.add(t)
                    t.add_done_callback(pending.discard)

            await conn.add_listener(EVENTS_CHANNEL, on_notify)
            while not conn.is_closed():
                await asyncio.sleep(5)
                await conn.execute("SELECT 1")
        except asyncio.CancelledError:
            if conn is not None:
                with contextlib.suppress(Exception):
                    await conn.close()
            raise
        except Exception as e:
            log.warning("LISTEN caiu; tentando de novo", extra={"error": type(e).__name__})
            await asyncio.sleep(3)
        finally:
            if conn is not None and not conn.is_closed():
                with contextlib.suppress(Exception):
                    await conn.close()
