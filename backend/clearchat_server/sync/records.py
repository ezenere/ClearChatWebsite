"""Registros: pull (§7.3), push atômico e idempotente (§7.4), regras de host/replay (§8.4),
detecção e resolução de divergência (§9), cascatas (§7.7) e cotas (§7.10)."""

from __future__ import annotations

import json
import uuid
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any, TypeGuard

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncConnection, AsyncEngine

from ..chatstate import ensure_state, load_state, lock_user, next_ssq, serialize
from ..db import execute, fetchall, fetchone
from ..errors import ApiError
from ..util import BLOB_ID_RE, RECORD_ID_RE, b64u_encode, iso, utcnow
from .envelope import Envelope, parse_envelope

KNOWN_TYPES = {"provider", "setting", "preset", "memory_collection", "memory", "chat", "session", "message", "skill"}
SCOPE_NULL = {"provider", "setting", "preset", "memory_collection", "skill"}
CONTENT = {"session", "message"}
MAX_ITEMS = 500
PULL_DEFAULT = 500
PULL_MAX = 1000
PAGE_BYTES = 8 * 1024 * 1024
INLINE_EVENT_BYTES = 256 * 1024

RECORD_COLS = (
    "seq, type, id, scope_id, rev, deleted, env_v, key_version, nonce, ciphertext, size, blobs, device_id, updated_at"
)

IsOnline = Callable[[uuid.UUID], bool]


# ---------------------------------------------------------------- serialização
def change_from_row(row: Any, payload: bool = True) -> dict[str, Any]:
    ch: dict[str, Any] = {
        "seq": int(row.seq),
        "type": row.type,
        "id": row.id,
        "scope": row.scope_id,
        "rev": int(row.rev),
        "deleted": bool(row.deleted),
        "size": int(row.size),
        "blobs": list(row.blobs or []),
        "device_id": str(row.device_id) if row.device_id else None,
        "updated_at": iso(row.updated_at),
    }
    if not row.deleted:
        if payload and row.ciphertext is not None:
            ch["env"] = {
                "v": int(row.env_v),
                "k": int(row.key_version),
                "n": b64u_encode(bytes(row.nonce)),
                "c": b64u_encode(bytes(row.ciphertext)),
            }
        else:
            ch["omitted"] = True
    return ch


def _env_len(ch: dict[str, Any]) -> int:
    env = ch.get("env")
    return len(env["c"]) + len(env["n"]) + 16 if env else 0


def limit_inline(changes: list[dict[str, Any]], budget: int = INLINE_EVENT_BYTES) -> list[dict[str, Any]]:
    """Payload inline até `budget` bytes por mensagem; o resto vai com `omitted: true` (§10.5)."""
    out = []
    used = 0
    for ch in changes:
        n = _env_len(ch)
        if n and used + n > budget:
            ch = {k: v for k, v in ch.items() if k != "env"}
            ch["omitted"] = True
        else:
            used += n
        out.append(ch)
    return out


# ---------------------------------------------------------------- leitura
async def _repeatable(engine: AsyncEngine) -> AsyncConnection:
    conn = await engine.connect()
    await conn.execution_options(isolation_level="REPEATABLE READ")
    await conn.begin()
    return conn


async def pull(engine: AsyncEngine, user_id: uuid.UUID, since: int, limit: int | None, payload: bool) -> dict[str, Any]:
    limit = PULL_DEFAULT if limit is None else limit
    if since < 0 or limit < 1:
        raise ApiError("invalid_request", details={"field": "since/limit"})
    limit = min(limit, PULL_MAX)
    conn = await _repeatable(engine)
    try:
        user = await fetchone(conn, "SELECT seq, tombstone_floor FROM users WHERE id = :u", {"u": user_id})
        assert user is not None
        if since < int(user.tombstone_floor):
            raise ApiError("cursor_expired", details={"floor": int(user.tombstone_floor)})
        rows = await fetchall(
            conn,
            f"SELECT {RECORD_COLS} FROM records WHERE user_id = :u AND seq > :s ORDER BY seq LIMIT :l",
            {"u": user_id, "s": since, "l": limit + 1},
        )
    finally:
        await conn.close()
    head = int(user.seq)
    changes: list[dict[str, Any]] = []
    used = 0
    has_more = False
    for row in rows:
        if len(changes) >= limit or (changes and payload and used + int(row.size) > PAGE_BYTES):
            has_more = True
            break
        used += int(row.size) if payload else 0
        changes.append(change_from_row(row, payload))
    nxt = changes[-1]["seq"] if changes else head
    return {"changes": changes, "next": nxt, "has_more": has_more, "head": head}


async def list_records(
    engine: AsyncEngine,
    user_id: uuid.UUID,
    rtype: str | None,
    scope: str | None,
    after: int,
    limit: int | None,
    payload: bool,
) -> dict[str, Any]:
    limit = min(PULL_DEFAULT if limit is None else limit, PULL_MAX)
    if limit < 1 or after < 0:
        raise ApiError("invalid_request")
    where = "user_id = :u AND NOT deleted AND seq > :a"
    params: dict[str, Any] = {"u": user_id, "a": after, "l": limit + 1}
    if rtype is not None:
        where += " AND type = :t"
        params["t"] = rtype
    if scope is not None:
        where += " AND scope_id = :s"
        params["s"] = scope
    conn = await _repeatable(engine)
    try:
        head = int((await fetchone(conn, "SELECT seq FROM users WHERE id = :u", {"u": user_id})).seq)  # type: ignore[union-attr]
        rows = await fetchall(conn, f"SELECT {RECORD_COLS} FROM records WHERE {where} ORDER BY seq LIMIT :l", params)
    finally:
        await conn.close()
    out: list[dict[str, Any]] = []
    used = 0
    has_more = False
    for row in rows:
        if len(out) >= limit or (out and payload and used + int(row.size) > PAGE_BYTES):
            has_more = True
            break
        used += int(row.size) if payload else 0
        out.append(change_from_row(row, payload))
    nxt = out[-1]["seq"] if out else after
    return {"records": out, "next": nxt, "has_more": has_more, "head": head}


async def fetch_records(engine: AsyncEngine, user_id: uuid.UUID, items: Any) -> dict[str, Any]:
    if not isinstance(items, list) or len(items) > MAX_ITEMS:
        raise ApiError("invalid_request", details={"field": "items"})
    types, ids = [], []
    for it in items:
        if not isinstance(it, dict) or not isinstance(it.get("type"), str) or not isinstance(it.get("id"), str):
            raise ApiError("invalid_request", details={"field": "items"})
        types.append(it["type"])
        ids.append(it["id"])
    if not items:
        return {"records": []}
    async with engine.connect() as conn:
        rows = await fetchall(
            conn,
            f"SELECT {RECORD_COLS} FROM records WHERE user_id = :u AND (type, id) IN "
            "(SELECT * FROM unnest(CAST(:t AS text[]), CAST(:i AS text[]))) ORDER BY seq",
            {"u": user_id, "t": types, "i": ids},
        )
    return {"records": [change_from_row(r, True) for r in rows]}


# ---------------------------------------------------------------- parsing do push
@dataclass
class Item:
    type: str
    id: str
    scope: str | None
    base_rev: int
    rev: int
    deleted: bool
    env: Envelope | None
    blobs: list[str]


@dataclass
class PushReq:
    push_id: uuid.UUID | None
    items: list[Item]
    chat_bases: dict[str, int]
    host_epochs: dict[str, int]


def _int(x: Any) -> TypeGuard[int]:
    return isinstance(x, int) and not isinstance(x, bool)


def _bad(field: str, reason: str = "invalid", **extra: Any) -> ApiError:
    return ApiError("invalid_request", details={"field": field, "reason": reason, **extra})


def parse_item(raw: Any, idx: int) -> Item:
    f = f"items[{idx}]"
    if not isinstance(raw, dict):
        raise _bad(f)
    t, rid, scope = raw.get("type"), raw.get("id"), raw.get("scope")
    if not isinstance(t, str) or t not in KNOWN_TYPES:
        raise _bad(f + ".type", "unknown_type")
    if not isinstance(rid, str) or not RECORD_ID_RE.match(rid):
        raise _bad(f + ".id")
    if scope is not None and (not isinstance(scope, str) or not RECORD_ID_RE.match(scope)):
        raise _bad(f + ".scope")
    if t in SCOPE_NULL and scope is not None:
        raise _bad(f + ".scope", "must_be_null")
    if t not in SCOPE_NULL and scope is None:
        raise _bad(f + ".scope", "required")
    if t == "chat" and scope != rid:
        raise _bad(f + ".scope", "chat_scope_must_equal_id")
    base_rev, rev, deleted = raw.get("base_rev"), raw.get("rev"), raw.get("deleted", False)
    if not _int(base_rev) or base_rev < 0 or not _int(rev) or rev != base_rev + 1 or rev > 2_000_000_000:
        raise _bad(f + ".rev", "rev_must_be_base_rev_plus_1")
    if not isinstance(deleted, bool):
        raise _bad(f + ".deleted")
    blobs = raw.get("blobs", [])
    if (
        not isinstance(blobs, list)
        or len(blobs) > 1000
        or any(not isinstance(b, str) or not BLOB_ID_RE.match(b) for b in blobs)
    ):
        raise _bad(f + ".blobs")
    env: Envelope | None = None
    if deleted:
        if raw.get("env") is not None or blobs:
            raise _bad(f, "tombstone_without_env_and_blobs")
        if t == "setting":
            raise _bad(f, "setting_is_never_deleted")
    else:
        env = parse_envelope(raw.get("env"), f + ".env")
    return Item(t, rid, scope, base_rev, rev, deleted, env, list(dict.fromkeys(blobs)))


def parse_push(body: Any, *, require_push_id: bool = True) -> PushReq:
    if not isinstance(body, dict):
        raise _bad("body")
    push_id: uuid.UUID | None = None
    pid = body.get("push_id")
    if pid is not None or require_push_id:
        try:
            push_id = uuid.UUID(str(pid))
        except ValueError as e:
            raise _bad("push_id") from e
    items_raw = body.get("items")
    if not isinstance(items_raw, list) or (require_push_id and not items_raw):
        raise _bad("items")
    if len(items_raw) > MAX_ITEMS:
        raise _bad("items", "too_many", limit=MAX_ITEMS)
    items = [parse_item(r, i) for i, r in enumerate(items_raw)]
    keys = [(i.type, i.id) for i in items]
    if len(set(keys)) != len(keys):
        raise _bad("items", "duplicate_record")

    def _map(name: str) -> dict[str, int]:
        v = body.get(name) or {}
        if not isinstance(v, dict) or any(not isinstance(k, str) or not _int(x) or x < 0 for k, x in v.items()):
            raise _bad(name)
        return dict(v)

    return PushReq(push_id, items, _map("chat_bases"), _map("host_epochs"))


# ---------------------------------------------------------------- aplicação
class DivergenceDetected(Exception):
    def __init__(self, chat_id: str, base: int) -> None:
        super().__init__(chat_id)
        self.chat_id = chat_id
        self.base = base


@dataclass
class PushOutcome:
    response: dict[str, Any]
    changes: list[dict[str, Any]] = field(default_factory=list)
    state_events: list[tuple[str, dict[str, Any]]] = field(default_factory=list)  # (chat_id, event)
    replayed: bool = False


async def _check_blobs(conn: AsyncConnection, user_id: uuid.UUID, items: list[Item]) -> None:
    wanted = sorted({b for i in items for b in i.blobs})
    if not wanted:
        return
    rows = await fetchall(
        conn,
        "SELECT blob_id FROM blobs WHERE user_id = :u AND blob_id = ANY(CAST(:b AS text[]))",
        {"u": user_id, "b": wanted},
    )
    have = {r.blob_id for r in rows}
    missing = [b for b in wanted if b not in have]
    if missing:
        raise ApiError("blob_missing", details={"missing": missing})


async def _load_current(conn: AsyncConnection, user_id: uuid.UUID, items: list[Item]) -> dict[tuple[str, str], Any]:
    rows = await fetchall(
        conn,
        f"SELECT {RECORD_COLS} FROM records WHERE user_id = :u AND (type, id) IN "
        "(SELECT * FROM unnest(CAST(:t AS text[]), CAST(:i AS text[])))",
        {"u": user_id, "t": [i.type for i in items], "i": [i.id for i in items]},
    )
    return {(r.type, r.id): r for r in rows}


async def _check_scopes(conn: AsyncConnection, user_id: uuid.UUID, items: list[Item]) -> None:
    batch = {(i.type, i.id): i for i in items}
    need: dict[str, set[str]] = {"chat": set(), "memory_collection": set()}
    for i in items:
        if i.type in CONTENT:
            need["chat"].add(i.scope or "")
        elif i.type == "memory":
            need["memory_collection"].add(i.scope or "")
    existing: dict[tuple[str, str], bool] = {}
    for t, ids in need.items():
        if ids:
            rows = await fetchall(
                conn,
                "SELECT id, deleted FROM records WHERE user_id = :u AND type = :t AND id = ANY(CAST(:i AS text[]))",
                {"u": user_id, "t": t, "i": sorted(ids)},
            )
            for r in rows:
                existing[(t, r.id)] = bool(r.deleted)
    conflicts = []
    for i in items:
        parent_type = "chat" if i.type in CONTENT else "memory_collection" if i.type == "memory" else None
        if parent_type is None:
            continue
        key = (parent_type, i.scope or "")
        if key in batch:
            if batch[key].deleted:
                conflicts.append({"type": i.type, "id": i.id, "reason": "scope_deleted"})
            continue
        if key not in existing:
            conflicts.append({"type": i.type, "id": i.id, "reason": "scope_missing"})
        elif existing[key]:
            conflicts.append({"type": i.type, "id": i.id, "reason": "scope_deleted"})
    if conflicts:
        raise ApiError("conflict", details={"conflicts": conflicts})


def _check_revs(items: list[Item], current: dict[tuple[str, str], Any]) -> None:
    conflicts = []
    for i in items:
        cur = current.get((i.type, i.id))
        cur_rev = int(cur.rev) if cur is not None else 0
        if i.base_rev != cur_rev:
            c: dict[str, Any] = {
                "type": i.type,
                "id": i.id,
                "reason": "gone" if cur is not None and cur.deleted else "rev_mismatch",
            }
            if cur is not None:
                c["current"] = change_from_row(cur, True)
            conflicts.append(c)
    if conflicts:
        raise ApiError("conflict", details={"conflicts": conflicts})


async def _write(
    conn: AsyncConnection,
    user: Any,
    device_id: uuid.UUID,
    items: list[Item],
    current: dict[tuple[str, str], Any],
) -> tuple[list[dict[str, Any]], int, dict[str, int]]:
    """Cotas + escrita. Devolve (changes, head, max seq de conteúdo por chat)."""
    user_id = user.id
    rec_delta = 0
    bytes_delta = 0
    for i in items:
        cur = current.get((i.type, i.id))
        old_live = cur is not None and not cur.deleted
        rec_delta += (0 if i.deleted else 1) - (1 if old_live else 0)
        bytes_delta += (0 if i.deleted or i.env is None else len(i.env.ct)) - (
            int(cur.size) if cur is not None and not cur.deleted else 0
        )

    # cascatas (§7.7): chat → session/message do escopo; memory_collection → memory
    cascades: list[tuple[str, list[str]]] = []
    for i in items:
        if i.deleted and i.type == "chat":
            cascades.append((i.id, ["session", "message"]))
        elif i.deleted and i.type == "memory_collection":
            cascades.append((i.id, ["memory"]))
    cascade_blobs: set[str] = set()
    for scope, types in cascades:
        agg = await fetchone(
            conn,
            "SELECT count(*) FILTER (WHERE NOT deleted) AS n, COALESCE(sum(size) FILTER (WHERE NOT deleted), 0) AS b "
            "FROM records WHERE user_id = :u AND scope_id = :s AND type = ANY(CAST(:t AS text[]))",
            {"u": user_id, "s": scope, "t": types},
        )
        assert agg is not None
        rec_delta -= int(agg.n)
        bytes_delta -= int(agg.b)

    if (
        rec_delta > 0
        and user.quota_records is not None
        and int(user.usage_records) + rec_delta > int(user.quota_records)
    ):
        raise ApiError(
            "quota_exceeded",
            details={"kind": "records", "used": int(user.usage_records), "limit": int(user.quota_records)},
        )
    if (
        bytes_delta > 0
        and user.quota_record_bytes is not None
        and int(user.usage_record_bytes) + bytes_delta > int(user.quota_record_bytes)
    ):
        raise ApiError(
            "quota_exceeded",
            details={
                "kind": "record_bytes",
                "used": int(user.usage_record_bytes),
                "limit": int(user.quota_record_bytes),
            },
        )

    for scope, types in cascades:
        rows = await fetchall(
            conn,
            "SELECT DISTINCT rb.blob_id FROM record_blobs rb JOIN records r ON r.user_id = rb.user_id "
            "AND r.type = rb.type AND r.id = rb.record_id WHERE r.user_id = :u AND r.scope_id = :s "
            "AND r.type = ANY(CAST(:t AS text[]))",
            {"u": user_id, "s": scope, "t": types},
        )
        cascade_blobs.update(r.blob_id for r in rows)
        await execute(
            conn,
            "DELETE FROM records WHERE user_id = :u AND scope_id = :s AND type = ANY(CAST(:t AS text[]))",
            {"u": user_id, "s": scope, "t": types},
        )
        if types == ["session", "message"]:
            await execute(
                conn, "DELETE FROM chat_states WHERE user_id = :u AND chat_id = :c", {"u": user_id, "c": scope}
            )
            await execute(
                conn, "DELETE FROM divergence_discards WHERE user_id = :u AND chat_id = :c", {"u": user_id, "c": scope}
            )

    k = len(items)
    last = int(
        (
            await fetchone(conn, "UPDATE users SET seq = seq + :k WHERE id = :u RETURNING seq", {"u": user_id, "k": k})
        ).seq  # type: ignore[union-attr]
    )
    first = last - k + 1
    now = utcnow()
    params = []
    changes = []
    chat_heads: dict[str, int] = {}
    for n, i in enumerate(items):
        seq = first + n
        params.append(
            {
                "u": user_id,
                "t": i.type,
                "i": i.id,
                "s": i.scope,
                "r": i.rev,
                "q": seq,
                "del": i.deleted,
                "v": i.env.v if i.env else None,
                "k": i.env.k if i.env else None,
                "n": i.env.nonce if i.env else None,
                "c": i.env.ct if i.env else None,
                "z": len(i.env.ct) if i.env else 0,
                "b": i.blobs,
                "d": device_id,
                "now": now,
            }
        )
        ch: dict[str, Any] = {
            "seq": seq,
            "type": i.type,
            "id": i.id,
            "scope": i.scope,
            "rev": i.rev,
            "deleted": i.deleted,
            "size": len(i.env.ct) if i.env else 0,
            "blobs": i.blobs,
            "device_id": str(device_id),
            "updated_at": iso(now),
        }
        if i.env:
            ch["env"] = i.env.to_json()
        changes.append(ch)
        if i.type in CONTENT and i.scope:
            chat_heads[i.scope] = seq
    await conn.execute(
        text(
            "INSERT INTO records (user_id, type, id, scope_id, rev, seq, deleted, env_v, key_version, nonce, "
            "ciphertext, size, blobs, device_id, created_at, updated_at) VALUES (:u, :t, :i, :s, :r, :q, :del, :v, :k, "
            "CAST(:n AS bytea), CAST(:c AS bytea), :z, CAST(:b AS text[]), :d, :now, :now) "
            "ON CONFLICT (user_id, type, id) DO UPDATE SET scope_id = EXCLUDED.scope_id, rev = EXCLUDED.rev, "
            "seq = EXCLUDED.seq, deleted = EXCLUDED.deleted, env_v = EXCLUDED.env_v, "
            "key_version = EXCLUDED.key_version, nonce = EXCLUDED.nonce, ciphertext = EXCLUDED.ciphertext, "
            "size = EXCLUDED.size, blobs = EXCLUDED.blobs, device_id = EXCLUDED.device_id, updated_at = EXCLUDED.updated_at"
        ),
        params,
    )
    # referências de blob
    affected_blobs = set(cascade_blobs)
    for i in items:
        cur = current.get((i.type, i.id))
        if cur is not None:
            affected_blobs.update(cur.blobs or [])
        affected_blobs.update(i.blobs)
    await execute(
        conn,
        "DELETE FROM record_blobs WHERE user_id = :u AND (type, record_id) IN "
        "(SELECT * FROM unnest(CAST(:t AS text[]), CAST(:i AS text[])))",
        {"u": user_id, "t": [i.type for i in items], "i": [i.id for i in items]},
    )
    rb = [{"u": user_id, "t": i.type, "i": i.id, "b": b} for i in items for b in i.blobs]
    if rb:
        await conn.execute(
            text("INSERT INTO record_blobs (user_id, type, record_id, blob_id) VALUES (:u, :t, :i, :b)"), rb
        )
    if affected_blobs:
        await execute(
            conn,
            "UPDATE blobs b SET unreferenced_since = CASE WHEN EXISTS (SELECT 1 FROM record_blobs rb "
            "WHERE rb.user_id = b.user_id AND rb.blob_id = b.blob_id) THEN NULL "
            "ELSE COALESCE(b.unreferenced_since, now()) END "
            "WHERE b.user_id = :u AND b.blob_id = ANY(CAST(:b AS text[]))",
            {"u": user_id, "b": sorted(affected_blobs)},
        )
    push_bytes = sum(len(i.env.ct) for i in items if i.env)
    await execute(
        conn,
        "UPDATE users SET usage_records = usage_records + :rd, usage_record_bytes = usage_record_bytes + :bd WHERE id = :u",
        {"u": user_id, "rd": rec_delta, "bd": bytes_delta},
    )
    await execute(
        conn,
        "INSERT INTO usage_daily (user_id, day, pushes, push_items, push_bytes) VALUES (:u, current_date, 1, :n, :b) "
        "ON CONFLICT (user_id, day) DO UPDATE SET pushes = usage_daily.pushes + 1, "
        "push_items = usage_daily.push_items + EXCLUDED.push_items, push_bytes = usage_daily.push_bytes + EXCLUDED.push_bytes",
        {"u": user_id, "n": k, "b": push_bytes},
    )
    return changes, last, chat_heads


def _results(changes: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return [{"type": c["type"], "id": c["id"], "rev": c["rev"], "seq": c["seq"]} for c in changes]


async def _receipt(conn: AsyncConnection, user_id: uuid.UUID, push_id: uuid.UUID | None) -> dict[str, Any] | None:
    if push_id is None:
        return None
    row = await fetchone(
        conn, "SELECT response FROM push_receipts WHERE user_id = :u AND push_id = :p", {"u": user_id, "p": push_id}
    )
    return None if row is None else dict(row.response)


async def _store_receipt(
    conn: AsyncConnection, user_id: uuid.UUID, push_id: uuid.UUID | None, resp: dict[str, Any]
) -> None:
    if push_id is None:
        return
    await execute(
        conn,
        "INSERT INTO push_receipts (user_id, push_id, response) VALUES (:u, :p, CAST(:r AS jsonb))",
        {"u": user_id, "p": push_id, "r": json.dumps(resp)},
    )


async def _state_error(
    conn: AsyncConnection, code: str, user_id: uuid.UUID, chat_id: str, is_online: IsOnline, **extra: Any
) -> ApiError:
    row = await load_state(conn, user_id, chat_id)
    details: dict[str, Any] = {"chat_id": chat_id, **extra}
    if row is not None:
        st = serialize(row, is_online)
        if code == "chat_diverged":
            details["diverged"] = st["diverged"]
        details["state"] = st
    return ApiError(code, details=details)


async def push(
    engine: AsyncEngine,
    user_id: uuid.UUID,
    device_id: uuid.UUID,
    can_host: bool,
    body: Any,
    is_online: IsOnline,
) -> PushOutcome:
    req = parse_push(body)
    try:
        async with engine.begin() as conn:
            user = await lock_user(conn, user_id)
            stored = await _receipt(conn, user_id, req.push_id)
            if stored is not None:
                return PushOutcome(stored, replayed=True)
            outcome = await _push_tx(conn, user, device_id, can_host, req, is_online)
            await _store_receipt(conn, user_id, req.push_id, outcome.response)
            return outcome
    except DivergenceDetected as d:
        err, event_state = await mark_divergence(engine, user_id, device_id, d.chat_id, d.base, is_online)
        if event_state is not None:
            err.broadcast.append(event_state)
        raise err from None


async def _push_tx(
    conn: AsyncConnection, user: Any, device_id: uuid.UUID, can_host: bool, req: PushReq, is_online: IsOnline
) -> PushOutcome:
    user_id = user.id
    items = req.items
    await _check_blobs(conn, user_id, items)
    await _check_scopes(conn, user_id, items)

    content_chats = sorted({i.scope for i in items if i.type in CONTENT and i.scope})
    chat_ops = {i.id: i.deleted for i in items if i.type == "chat"}
    all_chats = sorted(set(content_chats) | set(chat_ops))
    states: dict[str, Any] = {}
    if all_chats:
        rows = await fetchall(
            conn,
            "SELECT * FROM chat_states WHERE user_id = :u AND chat_id = ANY(CAST(:c AS text[])) ORDER BY chat_id FOR UPDATE",
            {"u": user_id, "c": all_chats},
        )
        states = {r.chat_id: r for r in rows}

    for chat_id, deleted in sorted(chat_ops.items()):
        st = states.get(chat_id)
        if st is None:
            continue
        if deleted and st.window_purpose is not None:
            raise await _state_error(conn, "chat_busy", user_id, chat_id, is_online)
        if not deleted and st.divergence_id is not None:
            raise await _state_error(conn, "chat_diverged", user_id, chat_id, is_online)

    become_host: list[str] = []
    for chat_id in content_chats:
        if chat_id not in req.chat_bases:
            raise ApiError("invalid_request", details={"field": "chat_bases", "chat_id": chat_id, "reason": "required"})
        b = req.chat_bases[chat_id]
        st = states.get(chat_id)
        head = int(st.head) if st is not None else 0
        if st is not None and st.divergence_id is not None:
            raise await _state_error(conn, "chat_diverged", user_id, chat_id, is_online)
        if b > head:
            raise ApiError("stale_base", details={"chat_id": chat_id, "head": head})
        if b < head:
            disc = await fetchone(
                conn,
                "SELECT divergence_id FROM divergence_discards WHERE user_id = :u AND chat_id = :c AND device_id = :d "
                "AND base = :b",
                {"u": user_id, "c": chat_id, "d": device_id, "b": b},
            )
            if disc is not None:
                raise ApiError(
                    "divergence_discarded", details={"chat_id": chat_id, "divergence_id": str(disc.divergence_id)}
                )
            raise DivergenceDetected(chat_id, b)
        he = req.host_epochs.get(chat_id)
        is_host = st is not None and st.host_device_id == device_id
        if he is not None and not (is_host and st is not None and he == int(st.epoch)):
            raise await _state_error(conn, "not_host", user_id, chat_id, is_online)
        window_open = st is not None and st.window_purpose is not None
        if window_open:
            if not (is_host and is_online(device_id)):
                raise await _state_error(conn, "chat_busy", user_id, chat_id, is_online)
        elif (st is None or st.host_device_id is None) and can_host:
            become_host.append(chat_id)  # modo (B) replay: chat sem host → quem enviou vira host

    current = await _load_current(conn, user_id, items)
    _check_revs(items, current)
    changes, head, chat_heads = await _write(conn, user, device_id, items, current)

    events: list[tuple[str, dict[str, Any]]] = []
    for chat_id, chead in chat_heads.items():
        st = states.get(chat_id)
        if st is None:
            ssq = await next_ssq(conn, user_id)
            becomes = chat_id in become_host
            await execute(
                conn,
                "INSERT INTO chat_states (user_id, chat_id, head, host_device_id, epoch, ssq) VALUES (:u, :c, :h, :d, :e, :s)",
                {
                    "u": user_id,
                    "c": chat_id,
                    "h": chead,
                    "d": device_id if becomes else None,
                    "e": 1 if becomes else 0,
                    "s": ssq,
                },
            )
            if becomes:
                events.append((chat_id, {"kind": "host_changed", "device_id": str(device_id)}))
        elif chat_id in become_host:
            ssq = await next_ssq(conn, user_id)
            await execute(
                conn,
                "UPDATE chat_states SET head = :h, host_device_id = :d, epoch = epoch + 1, host_dropped_at = NULL, "
                "host_grace_deadline = NULL, ssq = :s, updated_at = now() WHERE user_id = :u AND chat_id = :c",
                {"u": user_id, "c": chat_id, "h": chead, "d": device_id, "s": ssq},
            )
            events.append((chat_id, {"kind": "host_changed", "device_id": str(device_id)}))
        else:
            await execute(
                conn,
                "UPDATE chat_states SET head = :h, updated_at = now() WHERE user_id = :u AND chat_id = :c",
                {"u": user_id, "c": chat_id, "h": chead},
            )
    resp = {"results": _results(changes), "head": head, "chat_heads": chat_heads}
    return PushOutcome(resp, changes, events)


async def mark_divergence(
    engine: AsyncEngine, user_id: uuid.UUID, device_id: uuid.UUID, chat_id: str, base: int, is_online: IsOnline
) -> tuple[ApiError, dict[str, Any] | None]:
    """Grava `diverged` (§9.1) numa transação própria. Devolve (erro chat_diverged, estado p/ broadcast)."""
    async with engine.begin() as conn:
        await lock_user(conn, user_id)
        st = await ensure_state(conn, user_id, chat_id)
        broadcast = None
        if st.divergence_id is None and base < int(st.head):
            ssq = await next_ssq(conn, user_id)
            await execute(
                conn,
                "UPDATE chat_states SET divergence_id = :id, diverged_device_id = :d, diverged_base = :b, "
                "diverged_head = head, diverged_at = now(), ssq = :s, updated_at = now() "
                "WHERE user_id = :u AND chat_id = :c",
                {"u": user_id, "c": chat_id, "id": uuid.uuid4(), "d": device_id, "b": base, "s": ssq},
            )
            row = await load_state(conn, user_id, chat_id)
            broadcast = serialize(row, is_online, {"kind": "diverged", "device_id": str(device_id)})
        row = await load_state(conn, user_id, chat_id)
        st_json = serialize(row, is_online)
    err = ApiError("chat_diverged", details={"chat_id": chat_id, "diverged": st_json["diverged"], "state": st_json})
    return err, broadcast


@dataclass
class ResolveOutcome:
    response: dict[str, Any]
    changes: list[dict[str, Any]]
    state: dict[str, Any] | None


async def resolve_divergence(
    engine: AsyncEngine,
    user_id: uuid.UUID,
    device_id: uuid.UUID,
    can_host: bool,
    chat_id: str,
    body: Any,
    is_online: IsOnline,
) -> ResolveOutcome:
    if not isinstance(body, dict):
        raise _bad("body")
    try:
        div_id = uuid.UUID(str(body.get("divergence_id")))
    except ValueError as e:
        raise _bad("divergence_id") from e
    keep = body.get("keep")
    if keep not in ("online", "local"):
        raise _bad("keep")
    items_raw = body.get("items")
    if keep == "online" and items_raw:
        raise _bad("items", "must_be_empty_for_keep_online")
    req = parse_push({"push_id": body.get("push_id"), "items": items_raw or []}, require_push_id=False)
    for it in req.items:
        ok = (it.type in CONTENT and it.scope == chat_id) or (it.type == "chat" and it.id == chat_id and not it.deleted)
        if not ok:
            raise _bad("items", "only_this_chat_content")

    async with engine.begin() as conn:
        user = await lock_user(conn, user_id)
        stored = await _receipt(conn, user_id, req.push_id)
        if stored is not None:
            return ResolveOutcome(stored, [], None)
        st = await fetchone(
            conn,
            "SELECT * FROM chat_states WHERE user_id = :u AND chat_id = :c FOR UPDATE",
            {"u": user_id, "c": chat_id},
        )
        if st is None or st.divergence_id is None or st.divergence_id != div_id:
            raise ApiError("divergence_mismatch", details={"chat_id": chat_id})
        changes: list[dict[str, Any]] = []
        resp: dict[str, Any] = {}
        if keep == "online":
            await execute(
                conn,
                "INSERT INTO divergence_discards (user_id, chat_id, device_id, base, divergence_id) "
                "VALUES (:u, :c, :d, :b, :id) ON CONFLICT (user_id, chat_id, device_id, base) "
                "DO UPDATE SET divergence_id = EXCLUDED.divergence_id, created_at = now()",
                {"u": user_id, "c": chat_id, "d": st.diverged_device_id, "b": st.diverged_base, "id": div_id},
            )
            new_head = int(st.head)
        else:
            if st.diverged_device_id != device_id:
                raise ApiError("divergence_mismatch", details={"chat_id": chat_id, "reason": "wrong_device"})
            new_head = int(st.head)
            if req.items:
                await _check_blobs(conn, user_id, req.items)
                await _check_scopes(conn, user_id, req.items)
                current = await _load_current(conn, user_id, req.items)
                _check_revs(req.items, current)
                changes, _head, heads = await _write(conn, user, device_id, req.items, current)
                new_head = heads.get(chat_id, new_head)
                resp = {"results": _results(changes), "head": _head, "chat_heads": {chat_id: new_head}}
        becomes = keep == "local" and st.host_device_id is None and can_host
        ssq = await next_ssq(conn, user_id)
        await execute(
            conn,
            "UPDATE chat_states SET divergence_id = NULL, diverged_device_id = NULL, diverged_base = NULL, "
            "diverged_head = NULL, diverged_at = NULL, head = :h, ssq = :s, updated_at = now(), "
            "host_device_id = CASE WHEN :become THEN CAST(:d AS uuid) ELSE host_device_id END, "
            "epoch = CASE WHEN :become THEN epoch + 1 ELSE epoch END "
            "WHERE user_id = :u AND chat_id = :c",
            {"u": user_id, "c": chat_id, "h": new_head, "s": ssq, "become": becomes, "d": device_id},
        )
        row = await load_state(conn, user_id, chat_id)
        state = serialize(row, is_online, {"kind": "resolved", "device_id": str(device_id)})
        resp["state"] = {k: v for k, v in state.items() if k != "event"}
        await _store_receipt(conn, user_id, req.push_id, resp)
    return ResolveOutcome(resp, changes, state)
