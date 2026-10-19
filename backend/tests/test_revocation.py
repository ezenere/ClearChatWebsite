"""Revogação chegando aos sockets: corrida no hello, requisições já na fila depois do 4403, defesa em
profundidade nos handlers, revogação serializada com host.begin (trava do usuário), host.revoked guardados
liberados, conferência periódica contra o banco (NOTIFY perdido)."""

from __future__ import annotations

import asyncio
import contextlib
import uuid

from conftest import TEST_DB, WSClient, chat, env
from sqlalchemy import text
from sqlalchemy.ext.asyncio import create_async_engine

import clearchat_server.realtime.ws as wsmod
from clearchat_server.jobs import handle_event, reconcile_connections
from clearchat_server.realtime import coordinator as coordmod
from clearchat_server.services.accounts import revoke_devices


async def sql(q: str, **params) -> None:
    e = create_async_engine(TEST_DB)
    async with e.begin() as c:
        await c.execute(text(q), params)
    await e.dispose()


async def fetch(q: str, **params):
    e = create_async_engine(TEST_DB)
    async with e.connect() as c:
        rows = (await c.execute(text(q), params)).fetchall()
    await e.dispose()
    return rows


async def two_devices(srv, email="rev@example.com"):
    a = await srv.signup(email)
    b = await srv.login(email, name="Notebook")
    return a, b


# ---------------------------------------------------------------- corrida no hello
async def test_revoked_between_authenticate_and_register_closes_4403(srv, monkeypatch):
    a, b = await two_devices(srv)
    real = wsmod.authenticate

    async def racing_authenticate(conn, token):
        p = await real(conn, token)
        # a revogação grava (e tenta fechar o socket, que ainda não está no hub) logo depois do authenticate
        await sql("UPDATE devices SET revoked_at = now() WHERE id = :d", d=p.device_id)
        srv.ctx.hub.close_device(p.device_id, 4403, "device_revoked")
        return p

    monkeypatch.setattr(wsmod, "authenticate", racing_authenticate)
    c = WSClient(srv, b)
    srv.clients.append(c)
    try:
        r = await c.connect()
    except Exception:
        r = None
    assert r is None or r["t"] != "welcome"
    assert await c.wait_closed() == 4403
    assert srv.ctx.hub.get(uuid.UUID(b.device_id)) is None


async def test_banned_between_authenticate_and_register_closes_4403(srv, monkeypatch):
    a, b = await two_devices(srv)
    real = wsmod.authenticate

    async def racing_authenticate(conn, token):
        p = await real(conn, token)
        await sql("UPDATE users SET status = 'banned' WHERE id = :u", u=p.user_id)
        return p

    monkeypatch.setattr(wsmod, "authenticate", racing_authenticate)
    c = WSClient(srv, a)
    srv.clients.append(c)
    with contextlib.suppress(Exception):
        await c.connect()
    assert await c.wait_closed() == 4403


# ---------------------------------------------------------------- fila depois do 4403
async def test_queued_frames_after_revoke_do_not_run(srv, monkeypatch):
    a, b = await two_devices(srv)
    await srv.push(a, [chat("c1")])
    ca, _ = await srv.ws(a)
    await ca.ack("host.begin", chat_id="c1", epoch=None, purpose="run")
    await ca.ack("host.end", chat_id="c1", epoch=1)
    cb, _ = await srv.ws(b)

    gate, started = asyncio.Event(), asyncio.Event()

    async def slow_pull(ctx, c, d):
        started.set()
        await gate.wait()
        return {}

    monkeypatch.setitem(wsmod.HANDLERS, "sync.pull", slow_pull)
    # B: uma requisição lenta em andamento e, atrás dela, comandos remotos, host.begin e push na fila
    await cb.send({"t": "sync.pull", "id": "slow", "since": 0})
    await asyncio.wait_for(started.wait(), 3)
    for n in range(3):
        await cb.send(
            {"t": "remote.send", "id": f"r{n}", "chat_id": "c1", "cmd_id": f"x{n}", "kind": "send", "env": env()}
        )
    await cb.send({"t": "host.begin", "id": "hb", "chat_id": "c2", "epoch": None, "purpose": "run"})
    await cb.send({"t": "host.pin", "id": "pin", "chat_id": "c3", "pinned": True})
    await asyncio.sleep(0.1)
    r = await srv.http.delete(f"/api/v1/devices/{b.device_id}", headers=a.h)
    assert r.status_code == 204
    assert await cb.wait_closed() == 4403
    # saiu do hub sem esperar a requisição em andamento
    assert srv.ctx.hub.get(uuid.UUID(b.device_id)) is None
    gate.set()
    await asyncio.sleep(0.3)
    await ca.no_event("remote.command", timeout=0.3)
    rows = await fetch("SELECT chat_id, host_device_id FROM chat_states WHERE chat_id IN ('c2', 'c3')")
    assert rows == []
    assert not [k for k in srv.ctx.coordinator.pending if k[1].startswith("x")]


async def test_frames_after_revoke_flag_are_not_dispatched(srv):
    a, b = await two_devices(srv)
    await srv.push(a, [chat("c1")])
    ca, _ = await srv.ws(a)
    await ca.ack("host.begin", chat_id="c1", epoch=None, purpose="run")
    cb, _ = await srv.ws(b)
    conn = srv.ctx.hub.get(uuid.UUID(b.device_id))
    # revogado em memória, com o 4403 ainda não enviado: o que chegar não é mais tratado
    conn.revoked = True
    await cb.send({"t": "remote.send", "id": "r", "chat_id": "c1", "cmd_id": "late", "kind": "send", "env": env()})
    await ca.no_event("remote.command", timeout=0.4)


# ---------------------------------------------------------------- defesa em profundidade
async def test_handlers_refuse_revoked_device_even_without_close(srv):
    a, b = await two_devices(srv)
    await srv.push(a, [chat("c1")])
    ca, _ = await srv.ws(a)
    await ca.ack("host.begin", chat_id="c1", epoch=None, purpose="run")
    await ca.ack("host.end", chat_id="c1", epoch=1)
    cb, _ = await srv.ws(b)
    # revogação gravada, mas o fechamento do socket se perdeu (ex.: NOTIFY do painel com o LISTEN fora)
    await sql("UPDATE devices SET revoked_at = now() WHERE id = :d", d=uuid.UUID(b.device_id))
    assert (await cb.err("host.begin", chat_id="c2", epoch=None, purpose="run"))["code"] == "device_revoked"
    assert (await cb.err("host.takeover", chat_id="c1", mode="force", confirm_pinned=True))["code"] == "device_revoked"
    e = await cb.err("remote.send", chat_id="c1", cmd_id="k1", kind="send", env=env())
    assert e["code"] == "device_revoked"
    e = await cb.err("sync.push", push_id=str(uuid.uuid4()), items=[chat("c9")])
    assert e["code"] == "device_revoked"
    await ca.no_event("remote.command", timeout=0.3)
    rows = await fetch("SELECT chat_id FROM chat_states WHERE chat_id = 'c2'")
    assert rows == []
    assert (await fetch("SELECT count(*) FROM records WHERE id = 'c9'"))[0][0] == 0
    # conta banida idem
    await sql("UPDATE devices SET revoked_at = NULL WHERE id = :d", d=uuid.UUID(b.device_id))
    await sql("UPDATE users SET status = 'banned' WHERE id = :u", u=uuid.UUID(b.user_id))
    assert (await cb.err("host.begin", chat_id="c2", epoch=None, purpose="run"))["code"] == "account_disabled"


async def test_revoke_serializes_with_concurrent_host_begin(srv):
    """Regressão: revoke_devices trava a linha do usuário antes de mexer em devices/chat_states. Um host.begin
    concorrente espera o commit e então vê o dispositivo revogado — nunca vira host depois do SELECT de
    release_hosted_chats (o que deixaria um dispositivo revogado como host)."""
    a, b = await two_devices(srv, "race@example.com")
    await srv.push(a, [chat("c1")])
    cb, _ = await srv.ws(b)
    uid, did = uuid.UUID(b.user_id), uuid.UUID(b.device_id)
    async with srv.ctx.engine.begin() as conn:
        ids, chats = await revoke_devices(conn, uid, [did])
        assert ids == [did] and chats == []
        begin = asyncio.create_task(cb.req("host.begin", chat_id="c1", epoch=None, purpose="run"))
        await asyncio.sleep(0.4)
        assert not begin.done()  # parado na trava do usuário
    r = await begin
    assert r["t"] == "error" and r["code"] == "device_revoked", r
    rows = await fetch("SELECT host_device_id FROM chat_states WHERE chat_id = 'c1'")
    assert all(row[0] != did for row in rows)


# ---------------------------------------------------------------- host.revoked guardados
async def revocation_queued_for(srv, a, b, ca, cb):
    """A hospeda c1, cai; B assume → um host.revoked fica guardado para A."""
    await ca.ack("host.begin", chat_id="c1", epoch=None, purpose="run")
    await ca.close()
    await cb.event("chat.state", pred=lambda m: (m.get("event") or {}).get("kind") == "host_dropped", timeout=3)
    await cb.ack("host.takeover", chat_id="c1", mode="next_turn", confirm_pinned=False)
    pr = srv.ctx.coordinator.pending_revocations
    assert uuid.UUID(a.device_id) in pr and list(pr[uuid.UUID(a.device_id)][1]) == ["c1"]


async def setup_hosts(srv, email):
    a, b = await two_devices(srv, email)
    await srv.push(a, [chat("c1")])
    ca, _ = await srv.ws(a)
    cb, _ = await srv.ws(b)
    await revocation_queued_for(srv, a, b, ca, cb)
    return a, b, ca, cb


async def test_pending_revocations_released_on_device_delete(srv):
    a, b, _, _ = await setup_hosts(srv, "pr1@example.com")
    assert (await srv.http.delete(f"/api/v1/devices/{a.device_id}", headers=b.h)).status_code == 204
    assert uuid.UUID(a.device_id) not in srv.ctx.coordinator.pending_revocations


async def test_pending_revocations_released_on_logout(srv):
    a, b, _, _ = await setup_hosts(srv, "pr2@example.com")
    assert (await srv.http.post("/api/v1/auth/logout", headers=a.h)).status_code == 204
    assert uuid.UUID(a.device_id) not in srv.ctx.coordinator.pending_revocations


async def test_pending_revocations_released_on_account_delete(srv):
    a, b, _, _ = await setup_hosts(srv, "pr3@example.com")
    r = await srv.http.post("/api/v1/auth/reauth/request", json={"purpose": "delete_account"}, headers=b.h)
    assert r.status_code in (200, 202, 204), r.text
    await srv.flush_mail()
    code = srv.last_code("pr3@example.com", "delete_account")
    r = await srv.http.request("DELETE", "/api/v1/account", json={"code": code}, headers=b.h)
    assert r.status_code in (200, 204), r.text
    assert uuid.UUID(a.device_id) not in srv.ctx.coordinator.pending_revocations


async def test_pending_revocations_released_on_admin_events(srv):
    a, b, _, _ = await setup_hosts(srv, "pr4@example.com")
    await handle_event(srv.ctx, {"kind": "devices_revoked", "user_id": a.user_id, "device_ids": [a.device_id]})
    assert uuid.UUID(a.device_id) not in srv.ctx.coordinator.pending_revocations
    # ban / conta apagada no painel: forget_user tira os de todos os dispositivos do usuário
    pr = srv.ctx.coordinator.pending_revocations
    other = uuid.uuid4()
    srv.ctx.coordinator._revoke_msg(uuid.UUID(a.user_id), other, {"t": "host.revoked", "chat_id": "z", "epoch": 1})
    keep = uuid.uuid4()
    srv.ctx.coordinator._revoke_msg(uuid.uuid4(), keep, {"t": "host.revoked", "chat_id": "z", "epoch": 1})
    await handle_event(srv.ctx, {"kind": "user_banned", "user_id": a.user_id})
    assert other not in pr and keep in pr


def test_revoke_queue_dedupes_by_chat_and_is_capped():
    hub = type("H", (), {"send_device": lambda self, d, m: False})()
    co = coordmod.Coordinator.__new__(coordmod.Coordinator)
    co.hub = hub
    co.pending_revocations = {}
    u, d = uuid.uuid4(), uuid.uuid4()
    for n in range(coordmod.REVOKE_QUEUE_MAX + 10):
        co._revoke_msg(u, d, {"t": "host.revoked", "chat_id": f"c{n}", "epoch": 1})
    q = co.pending_revocations[d][1]
    assert len(q) == coordmod.REVOKE_QUEUE_MAX and "c0" not in q
    # o mesmo chat de novo: troca a mensagem e vai para o fim (sem duplicar)
    co._revoke_msg(u, d, {"t": "host.revoked", "chat_id": "c20", "epoch": 2})
    assert len(q) == coordmod.REVOKE_QUEUE_MAX and list(q)[-1] == "c20" and q["c20"]["epoch"] == 2


# ---------------------------------------------------------------- conferência contra o banco
async def test_reconcile_closes_sockets_revoked_behind_its_back(srv):
    a, b = await two_devices(srv, "rc@example.com")
    ca, _ = await srv.ws(a)
    cb, _ = await srv.ws(b)
    other = await srv.signup("rc-other@example.com")
    co, _ = await srv.ws(other)
    assert await reconcile_connections(srv.ctx) == 0
    await sql("UPDATE devices SET revoked_at = now() WHERE id = :d", d=uuid.UUID(b.device_id))
    srv.ctx.coordinator._revoke_msg(uuid.UUID(b.user_id), uuid.UUID(b.device_id), {"t": "x", "chat_id": "q"})
    assert await reconcile_connections(srv.ctx) == 1
    assert await cb.wait_closed() == 4403
    assert uuid.UUID(b.device_id) not in srv.ctx.coordinator.pending_revocations
    assert (await ca.req("ping"))["t"] == "pong" and (await co.req("ping"))["t"] == "pong"
    # conta banida → todos os sockets dela
    await sql("UPDATE users SET status = 'banned' WHERE id = :u", u=uuid.UUID(a.user_id))
    await reconcile_connections(srv.ctx)
    assert await ca.wait_closed() == 4403
    # conta apagada → account.deleted e 4403
    await sql("DELETE FROM users WHERE id = :u", u=uuid.UUID(other.user_id))
    await reconcile_connections(srv.ctx)
    assert (await co.event("account.deleted")) == {"t": "account.deleted"}
    assert await co.wait_closed() == 4403


async def test_listener_reconciles_periodically(make_server):
    srv = await make_server(notify_listener_enabled=True, ws_reconcile_interval_s=0.2)
    a, b = await two_devices(srv, "rcl@example.com")
    cb, _ = await srv.ws(b)
    # revogação sem NOTIFY (perdida com o LISTEN fora): a conferência periódica fecha o socket
    await sql("UPDATE devices SET revoked_at = now() WHERE id = :d", d=uuid.UUID(b.device_id))
    assert await cb.wait_closed(5) == 4403
