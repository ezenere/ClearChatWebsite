"""Chats só ao vivo (SYNC_PROTOCOL §23): capacidades no hello, vínculos em memória (anúncio, lista,
atualizações, remoção, tolerância de queda, prazo de reanúncio, settling_s), exclusividade com os chats
online (`live_conflict`), conversão ao vivo → online pelo push do host, roteamento de comandos e do
stream pelo vínculo, limites e limites de taxa."""

from __future__ import annotations

import asyncio
import json
import uuid
from typing import Any

from conftest import TEST_DB, chat, env, msg
from sqlalchemy import text
from sqlalchemy.ext.asyncio import create_async_engine

CAPS = ["live_chats"]
EPOCH = 1793923200000


def item(chat_id: str, arev: int = 1, epoch: int = EPOCH, running: bool = False, **kw: Any) -> dict[str, Any]:
    return {"chat_id": chat_id, "epoch": epoch, "arev": arev, "running": running, "env": kw.pop("env", env(60)), **kw}


async def family(srv: Any) -> tuple[Any, Any, Any, Any]:
    """Host (desktop) e visualizador com caps; conexões abertas."""
    a = await srv.signup("live@example.com")
    b = await srv.login("live@example.com", name="Notebook")
    ca, wa = await srv.ws(a, caps=CAPS)
    cb, wb = await srv.ws(b, caps=CAPS)
    assert wa["caps"] == CAPS and wb["caps"] == CAPS
    return a, b, ca, cb


async def sql(q: str, **params: Any) -> list[Any]:
    e = create_async_engine(TEST_DB)
    async with e.begin() as c:
        res = await c.execute(text(q), params)
        rows = list(res.fetchall()) if res.returns_rows else []
    await e.dispose()
    return rows


async def test_info_and_caps(srv):
    info = (await srv.http.get("/api/info")).json()
    assert info["features"]["liveChats"] is True and info["protocol"]["version"] == "1.8.0"
    a = await srv.signup()
    b = await srv.login(a.email, name="Outro")
    # capacidade desconhecida é ignorada; sem caps → lista vazia no welcome
    _, w = await srv.ws(a, caps=["coisa_nova", "live_chats"])
    assert w["caps"] == ["live_chats"]
    cb, w = await srv.ws(b)
    assert w["caps"] == []
    # sem a capacidade, live.* é recusado
    for t, extra in (("live.announce", {"full": True, "chats": []}), ("live.list", {})):
        e = await cb.err(t, **extra)
        assert e["code"] == "invalid_request" and e["details"]["reason"] == "caps_required"


async def test_disabled_instance(make_server):
    srv = await make_server(live_chats_enabled=False)
    assert (await srv.http.get("/api/info")).json()["features"]["liveChats"] is False
    a = await srv.signup()
    c, w = await srv.ws(a, caps=CAPS)
    assert w["caps"] == []
    assert (await c.err("live.announce", full=True, chats=[]))["code"] == "invalid_request"


async def test_announce_list_update_and_removed(srv):
    a, b, ca, cb = await family(srv)
    legacy = await srv.login(a.email, name="Antigo")
    cl, _ = await srv.ws(legacy)
    e1 = env(80)
    r = await ca.ack("live.announce", full=True, chats=[item("c1", env=e1), item("c2", running=True)])
    assert r["accepted"] == ["c1", "c2"] and r["rejected"] == []
    up = await cb.event("live.update")
    by = {x["chat_id"]: x for x in up["chats"]}
    lc = by["c1"]
    assert set(lc) == {"chat_id", "epoch", "arev", "running", "env", "host", "announced_at"}
    assert lc["env"] == e1 and lc["epoch"] == EPOCH and lc["arev"] == 1 and lc["running"] is False
    assert lc["host"] == {"device_id": a.device_id, "name": "PC", "platform": "linux", "status": "online"}
    assert by["c2"]["running"] is True
    # o host não recebe o próprio anúncio; conexão sem caps nunca recebe live.*
    await ca.no_event("live.update")
    await cl.no_event("live.update")
    # lista: sem os chats do próprio dispositivo
    lst = await cb.ack("live.list")
    assert [x["chat_id"] for x in lst["chats"]] == ["c1", "c2"] and isinstance(lst["settling_s"], int)
    assert (await ca.ack("live.list"))["chats"] == []
    # mesma arev (ou menor) no mesmo epoch: aceito, sem efeito
    r = await ca.ack("live.announce", full=False, chats=[item("c1", arev=1, running=True)])
    assert r["accepted"] == ["c1"]
    await cb.no_event("live.update")
    assert (await cb.ack("live.list"))["chats"][0]["running"] is False
    r = await ca.ack("live.announce", full=False, chats=[item("c1", arev=3, running=True)])
    up = await cb.event("live.update")
    assert up["chats"][0]["arev"] == 3 and up["chats"][0]["running"] is True
    await ca.ack("live.announce", full=False, chats=[item("c1", arev=2)])
    await cb.no_event("live.update")
    # epoch novo (app reiniciado): qualquer arev vale
    await ca.ack("live.announce", full=False, chats=[item("c1", arev=1, epoch=EPOCH + 5)])
    up = await cb.event("live.update")
    assert up["chats"][0]["epoch"] == EPOCH + 5 and up["chats"][0]["arev"] == 1
    # itens inválidos vão para rejected (o resto do frame segue)
    big = {"v": 1, "k": 1, "n": env()["n"], "c": "A" * 3000}
    r = await ca.ack(
        "live.announce",
        full=False,
        chats=[
            item("c3", epoch=0),
            item("c4", epoch=2**53),
            item("c5", arev=0),
            item("c6", env=big),
            item("c7", env={"v": 1}),
            item("c8"),
            item("c8"),
            {"chat_id": 7},
            item("bad id!"),
        ],
    )
    assert r["accepted"] == ["c8"]
    assert [x["chat_id"] for x in r["rejected"]] == ["c3", "c4", "c5", "c6", "c7", "c8", None, "bad id!"]
    assert {x["code"] for x in r["rejected"]} == {"invalid_request"}
    await cb.event("live.update")
    e = await ca.err("live.announce", full="sim", chats=[])
    assert e["code"] == "invalid_request"
    # full: o que não veio na lista sai (withdrawn)
    await ca.ack("live.announce", full=True, chats=[item("c2", running=True), item("c8")])
    rm = await cb.event("live.removed")
    assert rm == {"t": "live.removed", "host_device_id": a.device_id, "chat_ids": ["c1"], "reason": "withdrawn"}
    # withdraw: deleted / quit (todos)
    await ca.ack("live.withdraw", chat_ids=["c8", "nao-existe"], reason="deleted")
    rm = await cb.event("live.removed")
    assert rm["chat_ids"] == ["c8"] and rm["reason"] == "deleted"
    assert (await ca.err("live.withdraw", chat_ids=None, reason="outro"))["code"] == "invalid_request"
    await ca.ack("live.withdraw", chat_ids=None, reason="quit")
    rm = await cb.event("live.removed")
    assert rm["chat_ids"] == ["c2"] and rm["reason"] == "host_quit"
    assert (await cb.ack("live.list"))["chats"] == []
    await cl.no_event("live.removed")
    # nada no banco: nenhum registro nem estado
    assert await sql("SELECT 1 FROM records WHERE user_id = :u", u=uuid.UUID(a.user_id)) == []
    assert await sql("SELECT 1 FROM chat_states WHERE user_id = :u", u=uuid.UUID(a.user_id)) == []


async def test_host_drop_grace_then_removed(srv):
    a, b, ca, cb = await family(srv)
    await ca.ack("live.announce", full=True, chats=[item("c1")])
    await cb.event("live.update")
    await ca.close()
    h = await cb.event("live.host")
    assert h == {"t": "live.host", "host_device_id": a.device_id, "status": "grace"}
    lst = await cb.ack("live.list")
    assert lst["chats"][0]["host"]["status"] == "grace"
    # comando com o host em tolerância → host_offline
    e = await cb.err("remote.send", chat_id="c1", cmd_id="k1", kind="history.list", env=env())
    assert e["code"] == "host_offline"
    rm = await cb.event("live.removed", timeout=3)
    assert rm["reason"] == "host_dropped" and rm["chat_ids"] == ["c1"]
    assert (await cb.ack("live.list"))["chats"] == []
    e = await cb.err("remote.send", chat_id="c1", cmd_id="k2", kind="send", env=env())
    assert e["code"] == "no_host"


async def test_reconnect_within_grace_and_reannounce_deadline(srv):
    a, b, ca, cb = await family(srv)
    await ca.ack("live.announce", full=True, chats=[item("c1"), item("c2")])
    await cb.event("live.update")
    await ca.close()
    await cb.event("live.host", pred=lambda m: m["status"] == "grace")
    ca, _ = await srv.ws(a, caps=CAPS)
    await cb.event("live.host", pred=lambda m: m["status"] == "online")
    # reanuncia só c2 (parcial): c1 sai quando vence o prazo depois do welcome
    await ca.ack("live.announce", full=False, chats=[item("c2", arev=1)])
    rm = await cb.event("live.removed", timeout=3)
    assert rm["chat_ids"] == ["c1"] and rm["reason"] == "withdrawn"
    await cb.no_event("live.removed", timeout=0.8)
    assert [x["chat_id"] for x in (await cb.ack("live.list"))["chats"]] == ["c2"]
    # reconexão com full: nada sai por prazo
    await ca.close()
    ca, _ = await srv.ws(a, caps=CAPS)
    await ca.ack("live.announce", full=True, chats=[item("c2", arev=2)])
    await cb.no_event("live.removed", timeout=0.9)


async def test_supersede_and_quit_without_grace(srv):
    a, b, ca, cb = await family(srv)
    await ca.ack("live.announce", full=True, chats=[item("c1")])
    await cb.event("live.update")
    # outra conexão do mesmo dispositivo (superseded): sem tolerância, com prazo de reanúncio
    ca2, _ = await srv.ws(a, caps=CAPS)
    await ca.wait_closed()
    await ca2.ack("live.announce", full=True, chats=[item("c1", arev=2)])
    await cb.no_event("live.host", timeout=0.3)
    await ca2.ack("live.withdraw", chat_ids=None, reason="quit")
    await cb.event("live.removed", pred=lambda m: m["reason"] == "host_quit")
    await ca2.close()
    await cb.no_event("live.host", timeout=0.3)


async def test_settling_after_restart(make_server):
    srv = await make_server(server_restart_grace_s=30)
    a = await srv.signup()
    c, _ = await srv.ws(a, caps=CAPS)
    s = (await c.ack("live.list"))["settling_s"]
    assert 25 <= s <= 30
    srv2 = await make_server(server_restart_grace_s=0.2)
    a2 = await srv2.signup()
    c2, _ = await srv2.ws(a2, caps=CAPS)
    await asyncio.sleep(0.3)
    assert (await c2.ack("live.list"))["settling_s"] == 0


async def test_conflicts(srv):
    a, b, ca, cb = await family(srv)
    # chat online (registro) e chat só com chat_states → exists_online; tombstone não conta
    assert (await srv.push(a, [chat("on1")])).status_code == 200
    await ca.ack("host.begin", chat_id="st1", epoch=None, purpose="run")
    assert (await srv.push(a, [chat("gone1")])).status_code == 200
    assert (await srv.push(a, [chat("gone1", base_rev=1, deleted=True)])).status_code == 200
    r = await ca.ack("live.announce", full=False, chats=[item("on1"), item("st1"), item("gone1"), item("c1")])
    assert r["accepted"] == ["gone1", "c1"]
    assert r["rejected"] == [
        {"chat_id": "on1", "code": "live_conflict", "reason": "exists_online"},
        {"chat_id": "st1", "code": "live_conflict", "reason": "exists_online"},
    ]
    # outro dispositivo anunciando o mesmo id → other_host
    r = await cb.ack("live.announce", full=False, chats=[item("c1")])
    assert r["rejected"] == [{"chat_id": "c1", "code": "live_conflict", "reason": "other_host"}]
    # nada de chat_states num chat ao vivo
    for t, extra in (
        ("host.begin", {"epoch": None, "purpose": "run"}),
        ("host.takeover", {"mode": "next_turn", "confirm_pinned": True}),
        ("host.pin", {"pinned": True}),
    ):
        for c in (ca, cb):
            e = await c.err(t, chat_id="c1", **extra)
            assert e["code"] == "live_conflict" and e["details"] == {"chat_id": "c1", "reason": "live"}, (t, e)
    r = await srv.http.post(
        "/api/v1/chats/c1/divergence/resolve", json={"divergence_id": str(uuid.uuid4()), "keep": "online"}, headers=b.h
    )
    assert r.status_code == 409 and r.json()["error"]["code"] == "live_conflict"
    # push de outro dispositivo: chat ou conteúdo do chat ao vivo → o lote inteiro é recusado
    for items, extra in (
        ([chat("c1")], {}),
        ([chat("x9"), msg("m1", "c1")], {"chat_bases": {"c1": 0}}),
        ([item_session("s1", "c1")], {"chat_bases": {"c1": 0}}),
    ):
        r = await srv.push(b, items, **extra)
        assert r.status_code == 409, r.text
        err = r.json()["error"]
        assert err["code"] == "live_conflict" and err["details"] == {"chat_id": "c1", "reason": "live"}
    e = await cb.err("sync.push", push_id=str(uuid.uuid4()), items=[chat("c1")])
    assert e["code"] == "live_conflict"
    assert (
        await sql("SELECT id FROM records WHERE user_id = :u AND id = ANY(:i)", u=uuid.UUID(a.user_id), i=["x9", "c1"])
        == []
    )
    assert await sql("SELECT 1 FROM chat_states WHERE user_id = :u AND chat_id = 'c1'", u=uuid.UUID(a.user_id)) == []


def item_session(sid: str, cid: str) -> dict[str, Any]:
    return {
        "type": "session",
        "id": sid,
        "scope": cid,
        "base_rev": 0,
        "rev": 1,
        "deleted": False,
        "env": env(),
        "blobs": [],
    }


async def test_saved_online_by_host_push(srv):
    a, b, ca, cb = await family(srv)
    await ca.ack("live.announce", full=True, chats=[item("c1"), item("c2")])
    await cb.event("live.update")
    # ao vivo → online pelo REST: chat no primeiro lote, replay com chat_bases 0 → o host vira host
    r = await srv.push(a, [chat("c1"), msg("m1", "c1")], chat_bases={"c1": 0})
    assert r.status_code == 200, r.text
    rm = await cb.event("live.removed")
    assert rm == {"t": "live.removed", "host_device_id": a.device_id, "chat_ids": ["c1"], "reason": "saved_online"}
    st = await cb.event("chat.state", pred=lambda m: m["chat_id"] == "c1")
    assert st["host"]["device_id"] == a.device_id
    # pelo WebSocket também
    r = await ca.ack("sync.push", push_id=str(uuid.uuid4()), items=[chat("c2")])
    rm = await cb.event("live.removed")
    assert rm["chat_ids"] == ["c2"] and rm["reason"] == "saved_online"
    assert (await cb.ack("live.list"))["chats"] == []
    # agora é online: anunciar de novo → exists_online
    r = await ca.ack("live.announce", full=False, chats=[item("c1", arev=9)])
    assert r["rejected"][0]["reason"] == "exists_online"
    # online → ao vivo: tombstone do chat e anúncio
    r = await srv.push(a, [chat("c1", base_rev=1, deleted=True)])
    assert r.status_code == 200
    r = await ca.ack("live.announce", full=False, chats=[item("c1", epoch=EPOCH + 1)])
    assert r["accepted"] == ["c1"]
    assert (await cb.event("live.update"))["chats"][0]["chat_id"] == "c1"


async def test_routing_commands_and_stream(srv):
    a, b, ca, cb = await family(srv)
    await ca.ack("live.announce", full=True, chats=[item("c1")])
    await cb.event("live.update")
    # comando de histórico → host; resultado → quem pediu
    e1 = env(100)
    r = await cb.ack("remote.send", chat_id="c1", cmd_id="cmd-h1", kind="history.list", env=e1)
    assert r["status"] == "delivered"
    cmd = await ca.event("remote.command")
    assert cmd["kind"] == "history.list" and cmd["env"] == e1 and cmd["from_device_id"] == b.device_id
    e2 = env(200)
    await ca.ack("remote.result", chat_id="c1", cmd_id="cmd-h1", env=e2)
    res = await cb.event("remote.result")
    assert res["env"] == e2 and res["cmd_id"] == "cmd-h1"
    for kind in ("history.changes", "history.item", "chat.update", "attach.put", "attach.get", "send", "fs.read"):
        assert (await cb.ack("remote.send", chat_id="c1", cmd_id=f"k-{kind}", kind=kind, env=env()))[
            "status"
        ] == "delivered"
        assert (await ca.event("remote.command"))["kind"] == kind
    # o próprio host não manda comando ao seu chat
    e = await ca.err("remote.send", chat_id="c1", cmd_id="self", kind="send", env=env())
    assert e["code"] == "invalid_request"
    # kinds só de chats ao vivo exigem vínculo
    assert (await srv.push(a, [chat("on1")])).status_code == 200
    await ca.ack("host.begin", chat_id="on1", epoch=None, purpose="run")
    for kind in ("history.list", "chat.update", "attach.put"):
        e = await cb.err("remote.send", chat_id="on1", cmd_id=f"x-{kind}", kind=kind, env=env())
        assert e["code"] == "invalid_request" and e["details"]["reason"] == "not_live"
    e = await cb.err("remote.send", chat_id="nada", cmd_id="x-nada", kind="history.list", env=env())
    assert e["code"] == "invalid_request"
    # stream: inscrição pede snapshot ao host do vínculo; eventos validados pelo epoch ao vivo
    await cb.ack("stream.subscribe", chat_ids=["c1"])
    rq = await ca.event("stream.resync_request")
    assert rq == {"t": "stream.resync_request", "chat_id": "c1", "requester_device_id": b.device_id}
    await cb.ack("stream.resync", chat_id="c1")
    await ca.event("stream.resync_request")
    ev = env(50)
    await ca.send({"t": "stream.event", "chat_id": "c1", "epoch": EPOCH, "n": 1, "env": ev})
    got = await cb.event("stream.event")
    assert got["epoch"] == EPOCH and got["env"] == ev and got["device_id"] == a.device_id
    await ca.send({"t": "stream.event", "chat_id": "c1", "epoch": EPOCH + 1, "n": 2, "env": env()})
    await cb.send({"t": "stream.event", "chat_id": "c1", "epoch": EPOCH, "n": 2, "env": env()})
    await cb.no_event("stream.event")
    # epoch novo no anúncio → o stream passa a valer nele
    await ca.ack("live.announce", full=False, chats=[item("c1", epoch=EPOCH + 1)])
    await ca.send({"t": "stream.event", "chat_id": "c1", "epoch": EPOCH + 1, "n": 1, "env": env()})
    assert (await cb.event("stream.event"))["epoch"] == EPOCH + 1


async def test_limits(make_server):
    srv = await make_server(live_max_chats_per_host=2, live_max_chats_per_user=3)
    a = await srv.signup()
    b = await srv.login(a.email, name="B")
    ca, _ = await srv.ws(a, caps=CAPS)
    cb, _ = await srv.ws(b, caps=CAPS)
    r = await ca.ack("live.announce", full=True, chats=[item("a1"), item("a2"), item("a3")])
    assert r["accepted"] == ["a1", "a2"]
    assert r["rejected"] == [{"chat_id": "a3", "code": "quota_exceeded", "kind": "live_chats", "limit": 2}]
    r = await cb.ack("live.announce", full=True, chats=[item("b1"), item("b2")])
    assert r["accepted"] == ["b1"] and r["rejected"][0]["limit"] == 3
    # atualizar um vínculo existente não conta como novo
    assert (await ca.ack("live.announce", full=False, chats=[item("a1", arev=2)]))["accepted"] == ["a1"]
    e = await ca.err("live.announce", full=False, chats=[item(f"z{i}") for i in range(1001)])
    assert e["code"] == "invalid_request"


async def test_rate_limits_and_refresh(srv):
    a, b, ca, cb = await family(srv)
    await ca.ack("live.announce", full=True, chats=[item("c1")])
    # refresh: pedido de reanúncio ao host indicado (ou a todos)
    await cb.ack("live.refresh", host_device_id=a.device_id)
    rq = await ca.event("live.refresh_request")
    assert rq == {"t": "live.refresh_request", "requester_device_id": b.device_id}
    await cb.ack("live.refresh")
    await ca.event("live.refresh_request")
    assert (await cb.err("live.refresh", host_device_id="não-uuid"))["code"] == "invalid_request"
    for _ in range(4):
        await cb.ack("live.refresh")
    e = await cb.err("live.refresh")
    assert e["code"] == "rate_limited"
    # live.list: 10/min por conexão
    for _ in range(10):
        await ca.ack("live.list")
    assert (await ca.err("live.list"))["code"] == "rate_limited"
    # announce + withdraw: 10 frames/s
    codes = []
    for i in range(12):
        r = await ca.req("live.announce", full=False, chats=[item("c1", arev=2 + i)])
        codes.append(r.get("code", r["t"]))
    assert codes.count("rate_limited") >= 1 and codes[0] == "ack"
    await asyncio.sleep(1.1)
    await ca.ack("live.withdraw", chat_ids=[], reason="withdrawn")


async def test_announce_abuse_closes_4429(srv):
    a = await srv.signup()
    c, _ = await srv.ws(a, caps=CAPS)
    for _ in range(40):
        await c.send({"t": "live.withdraw", "id": "x", "chat_ids": [], "reason": "withdrawn"})
    assert await c.wait_closed() == 4429


async def test_revoked_host_and_keys_reset(srv):
    a, b, ca, cb = await family(srv)
    await ca.ack("live.announce", full=True, chats=[item("c1")])
    await cb.event("live.update")
    r = await srv.http.delete(f"/api/v1/devices/{a.device_id}", headers=b.h)
    assert r.status_code == 204, r.text
    rm = await cb.event("live.removed")
    assert rm["reason"] == "device_revoked" and rm["chat_ids"] == ["c1"]
    assert await ca.wait_closed() == 4403
    await cb.no_event("live.host", timeout=0.3)
    # conta com vínculos e keys.reset: os vínculos somem com as conexões
    cb2 = await cb.ack("live.announce", full=True, chats=[item("b1")])
    assert cb2["accepted"] == ["b1"]
    assert srv.ctx.coordinator.live.bindings
    srv.ctx.coordinator.forget_user(uuid.UUID(b.user_id))
    assert srv.ctx.coordinator.live.bindings == {} and srv.ctx.coordinator.live.hosts == {}


async def test_announce_env_not_logged_or_persisted(srv, caplog):
    a, b, ca, cb = await family(srv)
    e = env(90)
    await ca.ack("live.announce", full=True, chats=[item("c1", env=e)])
    await cb.event("live.update")
    await ca.close()
    await cb.event("live.removed", timeout=3)
    assert e["c"] not in caplog.text
    rows = await sql("SELECT * FROM activity")
    assert e["c"] not in json.dumps([list(map(str, r)) for r in rows])
