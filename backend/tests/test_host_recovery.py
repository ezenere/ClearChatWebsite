"""Recuperação de host em conjunto (queda, volta, fim da tolerância, reinício): O(1) comandos SQL e um timer
por usuário, não por chat, com os mesmos broadcasts de antes; teto de chat_states por usuário; GC de
chat_states órfãos."""

from __future__ import annotations

import asyncio
import contextlib
import uuid
from datetime import timedelta

from conftest import TEST_DB, chat
from sqlalchemy import event, text
from sqlalchemy.ext.asyncio import create_async_engine

from clearchat_server.jobs import run_gc
from clearchat_server.util import utcnow

N = 40


@contextlib.contextmanager
def count_sql(engine):
    seen: list[str] = []

    def on(conn, cursor, statement, params, context, executemany):
        seen.append(statement)

    event.listen(engine.sync_engine, "before_cursor_execute", on)
    try:
        yield seen
    finally:
        event.remove(engine.sync_engine, "before_cursor_execute", on)


async def fetch(q: str, **params):
    e = create_async_engine(TEST_DB)
    async with e.connect() as c:
        rows = (await c.execute(text(q), params)).fetchall()
    await e.dispose()
    return rows


async def sql(q: str, **params) -> int:
    e = create_async_engine(TEST_DB)
    async with e.begin() as c:
        n = (await c.execute(text(q), params)).rowcount
    await e.dispose()
    return n


def kind(k):
    return lambda m: (m.get("event") or {}).get("kind") == k


async def collect(c, n, pred=None, timeout=5):
    out = []
    for _ in range(n):
        out.append(await c.event("chat.state", timeout=timeout, pred=pred))
    return out


async def hosting(srv, email, n=N, windows=True):
    a = await srv.signup(email)
    b = await srv.login(email, name="Notebook")
    ca, _ = await srv.ws(a)
    cb, _ = await srv.ws(b)
    for i in range(n):
        # chat sem registro (host.begin não exige o registro do chat — §8)
        await ca.ack("host.begin", chat_id=f"p{i:03d}", epoch=None, purpose="run")
        if not windows:
            await ca.ack("host.end", chat_id=f"p{i:03d}", epoch=1)
    await asyncio.sleep(0.1)
    cb.drain()
    return a, b, ca, cb


async def test_drop_and_grace_are_set_based(make_server):
    srv = await make_server(host_drop_grace_s=0.8)
    a, b, ca, cb = await hosting(srv, "drop@example.com")
    with count_sql(srv.ctx.engine) as seen:
        await ca.close()
        sts = await collect(cb, N)
    assert len(seen) <= 6, seen  # antes: 3 por chat
    assert [s["chat_id"] for s in sts] == [f"p{i:03d}" for i in range(N)]
    assert all(s["host"]["status"] == "grace" and "event" not in s for s in sts)
    ssqs = [s["ssq"] for s in sts]
    assert ssqs == list(range(ssqs[0], ssqs[0] + N))
    # um timer por usuário, não por chat
    assert list(srv.ctx.coordinator.grace_timers) == [(uuid.UUID(a.user_id), "*")]
    with count_sql(srv.ctx.engine) as seen:
        drops = await collect(cb, N, kind("host_dropped"))
    assert len(seen) <= 8, seen
    assert [s["chat_id"] for s in drops] == [f"p{i:03d}" for i in range(N)]
    assert all(s["host"]["status"] == "offline" and s["window"] is None for s in drops)
    assert all(s["event"]["device_id"] == a.device_id for s in drops)
    assert [s["ssq"] for s in drops] == list(range(ssqs[-1] + 1, ssqs[-1] + 1 + N))
    assert not srv.ctx.coordinator.grace_timers
    (seq,) = (await fetch("SELECT state_seq FROM users WHERE id = :u", u=uuid.UUID(a.user_id)))[0]
    assert seq == drops[-1]["ssq"]


async def test_reconnect_is_set_based(make_server):
    srv = await make_server(host_drop_grace_s=5)
    a, b, ca, cb = await hosting(srv, "back@example.com")
    await ca.close()
    await collect(cb, N)
    with count_sql(srv.ctx.engine) as seen:
        _ca2, w = await srv.ws(a, active_windows=[{"chat_id": "p000", "epoch": 1}, {"chat_id": "p001", "epoch": 9}])
        backs = await collect(cb, N, kind("host_back"))
    assert len(seen) <= 20, seen  # hello inteiro; antes: 3 por chat só no on_connect
    assert w["resumed_windows"] == ["p000"] and set(w["lost_windows"]) == {"p001"}
    by = {s["chat_id"]: s for s in backs}
    assert by["p000"]["window"]["purpose"] == "run"  # retomada
    assert by["p001"]["window"] is None and by["p002"]["window"] is None  # perdida / não declarada
    assert all(s["host"]["status"] == "online" for s in backs)
    assert [s["ssq"] for s in backs] == sorted(s["ssq"] for s in backs)
    # o timer de varredura que sobrou não derruba nada (os chats voltaram)
    await asyncio.sleep(0.2)
    await cb.no_event("chat.state", pred=kind("host_dropped"), timeout=0.3)


async def test_grace_expiry_grants_pending_handovers_in_bulk(make_server):
    srv = await make_server(host_drop_grace_s=0.6)
    a, b, ca, cb = await hosting(srv, "ho@example.com", n=6)
    for cid in ("p000", "p003"):
        r = await cb.ack("host.takeover", chat_id=cid, mode="next_turn", confirm_pinned=False)
        assert r["status"] == "pending"
    await asyncio.sleep(0.1)
    cb.drain()
    await ca.close()
    await collect(cb, 6)  # queda (tolerância)
    got = await collect(cb, 8, timeout=3)  # 6 quedas + 2 trocas
    order = [(s["chat_id"], (s.get("event") or {}).get("kind")) for s in got]
    assert order == [
        ("p000", "host_dropped"),
        ("p000", "host_changed"),
        ("p001", "host_dropped"),
        ("p002", "host_dropped"),
        ("p003", "host_dropped"),
        ("p003", "host_changed"),
        ("p004", "host_dropped"),
        ("p005", "host_dropped"),
    ]
    assert [s["ssq"] for s in got] == list(range(got[0]["ssq"], got[0]["ssq"] + 8))
    changed = [s for s in got if s["event"]["kind"] == "host_changed"]
    assert all(s["host"]["device_id"] == b.device_id and s["event"]["reason"] == "takeover" for s in changed)
    assert all(s["epoch"] == 2 and s["handover"] is None for s in changed)
    granted = {(await cb.event("host.granted"))["chat_id"] for _ in range(2)}
    assert granted == {"p000", "p003"}
    # o host antigo volta e fica sabendo que perdeu os dois
    ca2, w = await srv.ws(a, active_windows=[{"chat_id": "p000", "epoch": 1}])
    assert "p000" in w["lost_windows"]
    revs = {(await ca2.event("host.revoked"))["chat_id"] for _ in range(2)}
    assert revs == {"p000", "p003"}


async def test_boot_is_set_based_with_one_timer_per_user(make_server):
    srv = await make_server()
    a = await srv.signup("boot@example.com")
    ca, _ = await srv.ws(a)
    for i in range(N):
        await ca.ack("host.begin", chat_id=f"p{i:03d}", epoch=None, purpose="run")
    srv.clients.remove(ca)
    await srv.stop()
    srv2 = await make_server(server_restart_grace_s=1.5)
    uid = uuid.UUID(a.user_id)
    assert list(srv2.ctx.coordinator.grace_timers) == [(uid, "*")]
    rows = await fetch("SELECT ssq, host_dropped_at, host_grace_deadline FROM chat_states WHERE user_id = :u", u=uid)
    assert len({r.ssq for r in rows}) == N and all(r.host_dropped_at and r.host_grace_deadline for r in rows)
    (seq,) = (await fetch("SELECT state_seq FROM users WHERE id = :u", u=uid))[0]
    assert seq == max(r.ssq for r in rows)
    # de novo, contando: O(1) comandos (antes: 3 por chat, com a api ainda fora do ar)
    with count_sql(srv2.ctx.engine) as seen:
        await srv2.ctx.coordinator.boot()
    assert len(seen) <= 4, seen
    sts = (await srv2.http.get("/api/v1/chat-states", headers=a.h)).json()["chat_states"]
    assert len(sts) == N and all(s["host"]["status"] == "grace" and s["window"]["purpose"] == "run" for s in sts)
    await asyncio.sleep(1.9)
    sts = (await srv2.http.get("/api/v1/chat-states", headers=a.h)).json()["chat_states"]
    assert all(s["host"]["status"] == "offline" and s["window"] is None for s in sts)


async def test_boot_reschedules_forced_handover_per_user(make_server):
    srv = await make_server(handover_force_timeout_s=30)
    a = await srv.signup("bootf@example.com")
    b = await srv.login("bootf@example.com", name="Notebook")
    ca, _ = await srv.ws(a)
    cb, _ = await srv.ws(b)
    for cid in ("f1", "f2"):
        await ca.ack("host.begin", chat_id=cid, epoch=None, purpose="run")
        assert (await cb.ack("host.takeover", chat_id=cid, mode="force", confirm_pinned=False))["status"] == "pending"
    srv.clients.remove(ca)
    srv.clients.remove(cb)
    await srv.stop()
    # prazo da troca forçada já perto de vencer quando o servidor volta
    await sql(
        "UPDATE chat_states SET handover_deadline = :t WHERE user_id = :u",
        t=utcnow() + timedelta(seconds=0.5),
        u=uuid.UUID(a.user_id),
    )
    srv2 = await make_server(server_restart_grace_s=10)
    assert (uuid.UUID(a.user_id), "*") in srv2.ctx.coordinator.force_timers
    await asyncio.sleep(1.0)
    sts = (await srv2.http.get("/api/v1/chat-states", headers=a.h)).json()["chat_states"]
    assert {s["chat_id"]: s["host"]["device_id"] for s in sts} == {"f1": b.device_id, "f2": b.device_id}


async def test_chat_states_cap_per_user(make_server):
    srv = await make_server(max_chat_states_per_user=3)
    a = await srv.signup("cap@example.com")
    ca, _ = await srv.ws(a)
    for cid in ("k0", "k1", "k2"):
        await ca.ack("host.begin", chat_id=cid, epoch=None, purpose="run")
    for t, extra in (
        ("host.begin", {"epoch": None, "purpose": "run"}),
        ("host.takeover", {"mode": "next_turn", "confirm_pinned": False}),
        ("host.pin", {"pinned": True}),
    ):
        e = await ca.err(t, chat_id="k9", **extra)
        assert e["code"] == "quota_exceeded" and e["details"] == {"kind": "chat_states", "used": 3, "limit": 3}
    # chats que já têm estado continuam funcionando
    await ca.ack("host.pin", chat_id="k0", pinned=True)
    await ca.ack("host.end", chat_id="k1", epoch=1)
    await ca.ack("host.begin", chat_id="k1", epoch=1, purpose="edit")
    rows = await fetch("SELECT chat_id FROM chat_states WHERE user_id = :u ORDER BY chat_id", u=uuid.UUID(a.user_id))
    assert [r.chat_id for r in rows] == ["k0", "k1", "k2"]


async def test_chat_states_cap_zero_is_unlimited(make_server):
    srv = await make_server(max_chat_states_per_user=0)
    a = await srv.signup("nocap@example.com")
    ca, _ = await srv.ws(a)
    for i in range(5):
        await ca.ack("host.pin", chat_id=f"n{i}", pinned=True)


async def test_gc_removes_orphan_chat_states(srv):
    a = await srv.signup("gc@example.com")
    assert (await srv.push(a, [chat("real")])).status_code == 200
    ca, _ = await srv.ws(a)
    await ca.ack("host.pin", chat_id="ghost", pinned=True)  # sem registro, sem host
    await ca.ack("host.pin", chat_id="real", pinned=True)  # com registro
    await ca.ack("host.begin", chat_id="hosted", epoch=None, purpose="run")  # sem registro, mas com host
    await ca.ack("host.pin", chat_id="fresh", pinned=True)  # sem registro, recente
    uid = uuid.UUID(a.user_id)
    await sql(
        "UPDATE chat_states SET updated_at = now() - interval '25 hours' WHERE user_id = :u AND chat_id <> 'fresh'",
        u=uid,
    )
    out = await run_gc(srv.ctx)
    assert out["chat_states"] == 1
    rows = await fetch("SELECT chat_id FROM chat_states WHERE user_id = :u ORDER BY chat_id", u=uid)
    assert [r.chat_id for r in rows] == ["fresh", "hosted", "real"]
