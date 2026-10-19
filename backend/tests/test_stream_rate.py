"""Taxa do stream ao vivo (§11): o estado de taxa fica na conexão, só para chats que ela hospeda (autorização
antes de alocar), com teto de chats por conexão, chave vazia removida e tudo liberado ao desconectar. Quem não
é host não deixa estado nenhum, por mais chat_ids distintos que mande."""

from __future__ import annotations

import asyncio
import time
import uuid

from conftest import chat, env

from clearchat_server.realtime import coordinator as coordmod


async def setup(srv, chat_ids=("c1",)):
    a = await srv.signup("stream@example.com")
    b = await srv.login("stream@example.com", name="Notebook")
    for cid in chat_ids:
        r = await srv.push(a, [chat(cid)])
        assert r.status_code == 200
    ca, _ = await srv.ws(a)
    cb, _ = await srv.ws(b)
    return a, b, ca, cb


def conn_of(srv, s):
    c = srv.ctx.hub.get(uuid.UUID(s.device_id))
    assert c is not None
    return c


def ev(chat_id, n, epoch=1):
    return {"t": "stream.event", "chat_id": chat_id, "epoch": epoch, "n": n, "env": env()}


async def received(c, t="stream.event", settle=0.3):
    await asyncio.sleep(settle)
    got = [m for m in c.events if m.get("t") == t]
    c.drain(t)
    return got


async def test_non_host_unique_chat_ids_leave_no_rate_state(srv):
    a, b, ca, cb = await setup(srv)
    await ca.ack("host.begin", chat_id="c1", epoch=None, purpose="run")
    # chats que não existem (nem linha em chat_states) e um chat que existe mas tem outro host
    for i in range(2000):
        await cb.send(ev(f"nope-{i:05d}-" + "x" * 100, 1))
    for n in range(1, 2 * coordmod.STREAM_MAX_RATE):
        await cb.send(ev("c1", n))
    assert (await cb.req("ping"))["t"] == "pong"  # stream.event roda em linha: tudo acima já foi tratado
    assert conn_of(srv, b).stream_rate == {}
    assert conn_of(srv, a).stream_rate == {}
    assert not hasattr(srv.ctx.coordinator, "_stream_rate")  # nada global no processo
    # epoch errado do próprio host também não aloca
    await ca.send(ev("c1", 1, epoch=9))
    assert (await ca.req("ping"))["t"] == "pong"
    assert conn_of(srv, a).stream_rate == {}


async def test_rate_limit_still_drops_above_max_for_real_host(srv, monkeypatch):
    a, b, ca, cb = await setup(srv)
    await ca.ack("host.begin", chat_id="c1", epoch=None, purpose="run")
    await cb.ack("stream.subscribe", chat_ids=["c1"])
    await ca.event("stream.resync_request")
    calls = 0
    real = srv.ctx.coordinator._host_of

    async def counting(user_id, chat_id):
        nonlocal calls
        calls += 1
        return await real(user_id, chat_id)

    monkeypatch.setattr(srv.ctx.coordinator, "_host_of", counting)
    total = coordmod.STREAM_MAX_RATE + 30
    t0 = time.monotonic()
    for n in range(1, total + 1):
        await ca.send(ev("c1", n))
    assert (await ca.req("ping"))["t"] == "pong"
    assert time.monotonic() - t0 < 1.0  # tudo dentro da janela de 1 s
    got = await received(cb)
    assert [m["n"] for m in got] == list(range(1, coordmod.STREAM_MAX_RATE + 1))
    # acima da taxa o servidor descarta sem ir ao banco
    assert calls == coordmod.STREAM_MAX_RATE
    rate = conn_of(srv, a).stream_rate
    assert list(rate) == ["c1"] and len(rate["c1"]) == coordmod.STREAM_MAX_RATE
    # passada a janela, volta a aceitar (a chave vencida é refeita, não acumula)
    await asyncio.sleep(1.1)
    await ca.send(ev("c1", total + 1))
    assert (await cb.event("stream.event"))["n"] == total + 1
    assert len(rate["c1"]) == 1


async def test_host_rate_state_is_capped_and_freed_on_disconnect(srv, monkeypatch):
    monkeypatch.setattr(coordmod, "STREAM_MAX_CHATS", 3)
    chats = [f"c{i}" for i in range(1, 6)]
    a, b, ca, cb = await setup(srv, chat_ids=chats)
    for cid in chats:
        await ca.ack("host.begin", chat_id=cid, epoch=None, purpose="run")
    await cb.ack("stream.subscribe", chat_ids=chats)
    for _ in chats:
        await ca.event("stream.resync_request")
    for cid in chats:
        await ca.send(ev(cid, 1))
    assert (await ca.req("ping"))["t"] == "pong"
    got = await received(cb)
    # no teto de chats por conexão, o evento de um chat novo é descartado (os já em andamento seguem)
    assert sorted(m["chat_id"] for m in got) == ["c1", "c2", "c3"]
    host = conn_of(srv, a)
    assert sorted(host.stream_rate) == ["c1", "c2", "c3"]
    await ca.send(ev("c1", 2))
    assert (await cb.event("stream.event"))["chat_id"] == "c1"
    # depois de 1 s as chaves vencidas saem e cabe um chat novo
    await asyncio.sleep(1.1)
    await ca.send(ev("c4", 2))
    assert (await cb.event("stream.event"))["chat_id"] == "c4"
    assert sorted(host.stream_rate) == ["c4"]
    # ao desconectar, o estado vai embora com a conexão
    await ca.close()
    for _ in range(50):
        if srv.ctx.hub.get(uuid.UUID(a.device_id)) is None:
            break
        await asyncio.sleep(0.05)
    assert srv.ctx.hub.get(uuid.UUID(a.device_id)) is None
    assert host.stream_rate == {}
