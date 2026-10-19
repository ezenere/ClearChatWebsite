"""Jobs periódicos (GC e expirações) e ouvinte de eventos do painel admin (LISTEN/NOTIFY)."""

from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import uuid
from datetime import datetime, timedelta
from typing import Any

from ..auth.tokens import prune_refresh_history
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
            # estado de chat que nunca ganhou registro (host.begin/pin de chat_id qualquer) ou cujo chat já
            # sumiu de vez: sem host, janela, troca nem divergência e parado há CHAT_STATE_ORPHAN_GRACE_H
            "chat_states": (
                "DELETE FROM chat_states cs WHERE cs.updated_at < :t AND cs.host_device_id IS NULL "
                "AND cs.window_purpose IS NULL AND cs.handover_to IS NULL AND cs.divergence_id IS NULL "
                "AND NOT EXISTS (SELECT 1 FROM records r WHERE r.user_id = cs.user_id AND r.type = 'chat' "
                "AND r.id = cs.chat_id)",
                now - timedelta(hours=s.chat_state_orphan_grace_h),
            ),
        }
        for name, (sql, t) in simple.items():
            out[name] = await execute(conn, sql, {"t": t})
        # histórico de rotação de refresh (detecção de reuso): só até a validade de cada token
        out["refresh_history"] = await prune_refresh_history(conn, now)
    # unlink fora do event loop (podem ser milhares de arquivos)
    await ctx.blobs.remove_many_async(files)
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
        ids: list[uuid.UUID] = []
        for d in payload.get("device_ids") or []:
            with contextlib.suppress(ValueError):
                ids.append(uuid.UUID(str(d)))
        ctx.coordinator.forget_devices(ids)
        for dev in ids:
            ctx.hub.close_device(dev, 4403, "device_revoked")
        chats = payload.get("chats") or []
        if chats:
            async with ctx.engine.connect() as conn:
                for chat_id in chats:
                    row = await load_state(conn, user_id, str(chat_id))
                    if row is not None:
                        ctx.coordinator.broadcast_state(user_id, serialize(row, ctx.hub.is_online))


async def reconcile_connections(ctx: AppContext) -> int:
    """Converge as conexões vivas para o banco (a fonte da verdade): dispositivo revogado, conta banida ou
    apagada → fecha 4403 como o handle_event faria. Cobre NOTIFYs perdidos com o LISTEN fora do ar (o
    pg_notify não é reentregue). Devolve quantas conexões mandou fechar."""
    conns = [c for cs in list(ctx.hub.by_user.values()) for c in cs]
    if not conns:
        return 0
    async with ctx.engine.connect() as conn:
        devices = {
            r.id: r.revoked_at
            for r in await fetchall(
                conn,
                "SELECT id, revoked_at FROM devices WHERE id = ANY(CAST(:d AS uuid[]))",
                {"d": list({c.device_id for c in conns})},
            )
        }
        users = {
            r.id: r.status
            for r in await fetchall(
                conn,
                "SELECT id, status FROM users WHERE id = ANY(CAST(:u AS uuid[]))",
                {"u": list({c.user_id for c in conns})},
            )
        }
    closed = 0
    for user_id in {c.user_id for c in conns}:
        status = users.get(user_id)
        if status == "active":
            continue
        closed += len(ctx.hub.user_conns(user_id))
        ctx.coordinator.forget_user(user_id)
        if status is None:
            ctx.hub.close_user(user_id, 4403, "account_deleted", final={"t": "account.deleted"})
        else:
            ctx.hub.close_user(user_id, 4403, "account_disabled")
    for c in conns:
        if users.get(c.user_id) == "active" and (c.device_id not in devices or devices[c.device_id] is not None):
            closed += 1
            ctx.coordinator.forget_devices([c.device_id])
            ctx.hub.close_device(c.device_id, 4403, "device_revoked")
    if closed:
        log.warning("conexões com acesso revogado fechadas na conferência", extra={"closed": closed})
    return closed


async def notify_listener(ctx: AppContext) -> None:
    import asyncpg

    dsn = ctx.settings.database_url.replace("postgresql+asyncpg://", "postgresql://", 1)
    loop = asyncio.get_running_loop()
    pending: set[asyncio.Task[None]] = set()
    last_reconcile = 0.0

    def event_done(t: asyncio.Task[None]) -> None:
        pending.discard(t)
        if not t.cancelled() and t.exception() is not None:
            log.error("falha ao tratar evento do painel", exc_info=t.exception())

    async def reconcile(force: bool = False) -> None:
        nonlocal last_reconcile
        if not force and loop.time() - last_reconcile < ctx.settings.ws_reconcile_interval_s:
            return
        last_reconcile = loop.time()
        try:
            await reconcile_connections(ctx)
        except Exception:
            log.exception("falha ao conferir as conexões contra o banco")

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
                    t.add_done_callback(event_done)

            await conn.add_listener(EVENTS_CHANNEL, on_notify)
            # o que foi notificado enquanto o LISTEN estava fora se perdeu: confere tudo agora e, depois,
            # periodicamente (WS_RECONCILE_INTERVAL_S)
            await reconcile(force=True)
            while not conn.is_closed():
                await asyncio.sleep(min(5.0, ctx.settings.ws_reconcile_interval_s))
                await conn.execute("SELECT 1")
                await reconcile()
        except asyncio.CancelledError:
            if conn is not None:
                with contextlib.suppress(Exception):
                    await conn.close()
            raise
        except Exception as e:
            log.warning("LISTEN caiu; tentando de novo", extra={"error": type(e).__name__})
            await reconcile()  # mesmo sem LISTEN, a conferência periódica continua
            await asyncio.sleep(3)
        finally:
            if conn is not None and not conn.is_closed():
                with contextlib.suppress(Exception):
                    await conn.close()
