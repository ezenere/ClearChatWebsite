"""Host de execução (§8): janela, modos de escrita, queda com tolerância ("o dispositivo remoto caiu"),
comandos remotos (relay, timeout, host_offline, sem fila), troca de host (fim do turno / forçada com
fallback), fixar host, stream ao vivo, revogação e reinício do servidor."""

from __future__ import annotations

import asyncio
import uuid

from conftest import chat, env, msg


async def setup(srv, chat_ids=("c1",)):
    a = await srv.signup("host@example.com")
    b = await srv.login("host@example.com", name="Notebook")
    for cid in chat_ids:
        r = await srv.push(a, [chat(cid)])
        assert r.status_code == 200
    ca, _ = await srv.ws(a)
    cb, _ = await srv.ws(b)
    return a, b, ca, cb


def ev_kind(kind):
    return lambda m: (m.get("event") or {}).get("kind") == kind


async def test_begin_end_and_write_modes(srv):
    a, b, ca, cb = await setup(srv)
    r = await ca.ack("host.begin", chat_id="c1", epoch=None, purpose="run")
    assert r["became_host"] is True and r["epoch"] == 1 and r["head"] == 0
    st = await cb.event("chat.state", pred=ev_kind("turn_started"))
    assert st["host"]["device_id"] == a.device_id and st["host"]["status"] == "online"
    assert st["host"]["name"] == "PC" and st["window"]["purpose"] == "run" and st["epoch"] == 1
    # idempotente
    assert (await ca.ack("host.begin", chat_id="c1", epoch=1, purpose="run"))["became_host"] is False
    # modo (A): janela do host
    r = await srv.push(a, [msg("m1", "c1")], chat_bases={"c1": 0}, host_epochs={"c1": 1})
    assert r.status_code == 200 and r.json()["chat_heads"] == {"c1": 2}
    # outro dispositivo com janela aberta → chat_busy; com epoch → not_host
    r = await srv.push(b, [msg("m2", "c1")], chat_bases={"c1": 2})
    assert r.status_code == 409 and r.json()["error"]["code"] == "chat_busy"
    r = await srv.push(b, [msg("m2", "c1")], chat_bases={"c1": 2}, host_epochs={"c1": 1})
    assert r.json()["error"]["code"] == "not_host" and r.json()["error"]["details"]["state"]["epoch"] == 1
    # base à frente → stale_base; sem chat_bases → invalid_request
    r = await srv.push(a, [msg("m2", "c1")], chat_bases={"c1": 9}, host_epochs={"c1": 1})
    assert r.json()["error"]["code"] == "stale_base"
    r = await srv.push(a, [msg("m2", "c1")])
    assert r.json()["error"]["code"] == "invalid_request"
    # apagar o chat rodando → chat_busy
    r = await srv.push(b, [chat("c1", base_rev=1, deleted=True)])
    assert r.json()["error"]["code"] == "chat_busy"
    # outros pedidos de host
    e = await cb.err("host.begin", chat_id="c1", epoch=None, purpose="run")
    assert e["code"] == "not_host" and e["details"]["state"]["host"]["device_id"] == a.device_id
    e = await ca.err("host.begin", chat_id="c1", epoch=7, purpose="run")
    assert e["code"] == "not_host"
    e = await ca.err("host.begin", chat_id="c1", epoch=1, purpose="bogus")
    assert e["code"] == "invalid_request"
    r = await ca.ack("host.end", chat_id="c1", epoch=1)
    assert r["handover_pending"] is False
    st = await cb.event("chat.state", pred=ev_kind("turn_ended"))
    assert st["window"] is None and st["host"]["device_id"] == a.device_id
    e = await cb.err("host.end", chat_id="c1", epoch=1)
    assert e["code"] == "not_host"
    # modo (B): replay sem janela, por qualquer dispositivo; o host não muda
    r = await srv.push(b, [msg("m2", "c1")], chat_bases={"c1": 2})
    assert r.status_code == 200
    states = (await srv.http.get("/api/v1/chat-states", headers=b.h)).json()
    (st,) = states["chat_states"]
    assert st["host"]["device_id"] == a.device_id and st["head"] == 3 and states["state_cursor"] >= st["ssq"]


async def test_web_cannot_host_and_replay_sets_host(srv):
    a = await srv.signup("w@example.com")
    w = await srv.login("w@example.com", client="web", can_host=False, name="Navegador")
    await srv.push(a, [chat("c2")])
    cw, _ = await srv.ws(w)
    e = await cw.err("host.begin", chat_id="c2", epoch=None, purpose="run")
    assert e["code"] == "cannot_host"
    e = await cw.err("host.takeover", chat_id="c2", mode="force", confirm_pinned=False)
    assert e["code"] == "cannot_host"
    # replay de quem pode hospedar num chat sem host → vira host
    r = await srv.push(a, [chat("c3"), msg("x1", "c3")], chat_bases={"c3": 0})
    assert r.status_code == 200
    st = await cw.event("chat.state", pred=ev_kind("host_changed"))
    assert st["chat_id"] == "c3" and st["host"]["device_id"] == a.device_id and st["epoch"] == 1
    # web sem host online: comando → no_host / host_offline
    e = await cw.err("remote.send", chat_id="c2", cmd_id="k1", kind="send", env=env())
    assert e["code"] == "no_host"
    e = await cw.err("remote.send", chat_id="c3", cmd_id="k2", kind="send", env=env())
    assert e["code"] == "host_offline"


async def test_drop_grace_and_resume(srv):
    a, b, ca, cb = await setup(srv)
    await ca.ack("host.begin", chat_id="c1", epoch=None, purpose="run")
    await ca.close()
    st = await cb.event("chat.state", pred=lambda m: m.get("host") and m["host"]["status"] == "grace")
    assert st["window"] is not None and "event" not in st
    ca2, w = await srv.ws(a, active_windows=[{"chat_id": "c1", "epoch": 1}])
    assert w["resumed_windows"] == ["c1"] and w["lost_windows"] == []
    st = await cb.event("chat.state", pred=ev_kind("host_back"))
    assert st["host"]["status"] == "online" and st["window"]["purpose"] == "run"
    await asyncio.sleep(0.7)  # o timer da tolerância foi cancelado
    await cb.no_event("chat.state", pred=ev_kind("host_dropped"))
    r = await srv.push(a, [msg("m1", "c1")], chat_bases={"c1": 0}, host_epochs={"c1": 1})
    assert r.status_code == 200


async def test_drop_grace_expired_remote_caiu(srv):
    a, b, ca, cb = await setup(srv)
    await ca.ack("host.begin", chat_id="c1", epoch=None, purpose="run")
    await ca.close()
    st = await cb.event("chat.state", pred=ev_kind("host_dropped"), timeout=3)
    assert st["event"]["device_id"] == a.device_id
    assert st["host"]["status"] == "offline" and st["host"]["name"] == "PC" and st["window"] is None
    # o host continua sendo o host (offline) até alguém assumir
    _ca2, w = await srv.ws(a, active_windows=[{"chat_id": "c1", "epoch": 1}])
    assert w["lost_windows"] == ["c1"] and w["resumed_windows"] == []
    st = await cb.event("chat.state", pred=ev_kind("host_back"))
    assert st["host"]["device_id"] == a.device_id and st["host"]["status"] == "online"


async def test_remote_command_relay(srv):
    a, b, ca, cb = await setup(srv)
    await ca.ack("host.begin", chat_id="c1", epoch=None, purpose="run")
    await ca.ack("host.end", chat_id="c1", epoch=1)
    e1 = env()
    r = await cb.ack("remote.send", chat_id="c1", cmd_id="cmd-1", kind="send", env=e1)
    assert r["status"] == "delivered"
    cmd = await ca.event("remote.command")
    assert cmd["cmd_id"] == "cmd-1" and cmd["kind"] == "send" and cmd["env"] == e1
    assert cmd["from_device_id"] == b.device_id and cmd["created_at"].endswith("Z")
    e2 = env()
    await ca.ack("remote.result", chat_id="c1", cmd_id="cmd-1", env=e2)
    res = await cb.event("remote.result")
    assert res == {"t": "remote.result", "chat_id": "c1", "cmd_id": "cmd-1", "env": e2}
    await asyncio.sleep(0.7)
    await cb.no_event("remote.failed")
    # validação
    assert (await cb.err("remote.send", chat_id="c1", cmd_id="x", kind="rm -rf", env=env()))[
        "code"
    ] == "invalid_request"
    assert (await ca.err("remote.send", chat_id="c1", cmd_id="x", kind="send", env=env()))["code"] == "invalid_request"
    big = env(1024 * 1024 + 10)
    assert (await cb.err("remote.send", chat_id="c1", cmd_id="x", kind="send", env=big))["code"] == "payload_too_large"


async def test_remote_command_timeout(srv):
    a, b, ca, cb = await setup(srv)
    await ca.ack("host.begin", chat_id="c1", epoch=None, purpose="run")
    await cb.ack("remote.send", chat_id="c1", cmd_id="slow", kind="stop", env=env())
    await ca.event("remote.command")
    f = await cb.event("remote.failed", timeout=3)
    assert f == {"t": "remote.failed", "chat_id": "c1", "cmd_id": "slow", "code": "command_timeout"}
    # resultado atrasado é ignorado
    await ca.ack("remote.result", chat_id="c1", cmd_id="slow", env=env())
    await cb.no_event("remote.result")


async def test_host_drops_mid_command_and_no_queue(srv):
    a, b, ca, cb = await setup(srv)
    await ca.ack("host.begin", chat_id="c1", epoch=None, purpose="run")
    await cb.ack("remote.send", chat_id="c1", cmd_id="c-1", kind="send", env=env())
    await ca.event("remote.command")
    await ca.close()
    f = await cb.event("remote.failed", timeout=1)
    assert f["code"] == "host_offline" and f["cmd_id"] == "c-1"
    # host em tolerância ou offline: erro na hora, nada é guardado
    e = await cb.err("remote.send", chat_id="c1", cmd_id="c-2", kind="send", env=env())
    assert e["code"] == "host_offline"
    await cb.event("chat.state", pred=ev_kind("host_dropped"), timeout=3)
    e = await cb.err("remote.send", chat_id="c1", cmd_id="c-3", kind="send", env=env())
    assert e["code"] == "host_offline"
    ca2, _ = await srv.ws(a)
    await ca2.no_event("remote.command", timeout=0.4)  # sem entrega na reconexão


async def test_takeover_offline_is_immediate(srv):
    a, b, ca, cb = await setup(srv)
    await ca.ack("host.begin", chat_id="c1", epoch=None, purpose="run")
    await ca.close()
    await cb.event("chat.state", pred=ev_kind("host_dropped"), timeout=3)
    r = await cb.ack("host.takeover", chat_id="c1", mode="next_turn", confirm_pinned=False)
    assert r == {"t": "ack", "re": r["re"], "status": "granted", "epoch": 2, "head": 0}
    g = await cb.event("host.granted")
    assert g["epoch"] == 2 and g["chat_id"] == "c1"
    st = await cb.event("chat.state", pred=ev_kind("host_changed"))
    assert st["host"]["device_id"] == b.device_id and st["window"] is None
    # o antigo volta e recebe host.revoked
    ca2, w = await srv.ws(a, active_windows=[{"chat_id": "c1", "epoch": 1}])
    assert w["lost_windows"] == ["c1"]
    (cs,) = [x for x in w["chat_states"] if x["chat_id"] == "c1"]
    assert cs["host"]["device_id"] == b.device_id
    rv = await ca2.event("host.revoked")
    assert rv["chat_id"] == "c1" and rv["reason"] == "takeover"
    # escrita atrasada do antigo host com epoch velho → not_host
    r = await srv.push(a, [msg("late", "c1")], chat_bases={"c1": 0}, host_epochs={"c1": 1})
    assert r.json()["error"]["code"] == "not_host"


async def test_handover_next_turn_with_forwarded_queue(srv):
    a, b, ca, cb = await setup(srv)
    await ca.ack("host.begin", chat_id="c1", epoch=None, purpose="run")
    r = await cb.ack("host.takeover", chat_id="c1", mode="next_turn", confirm_pinned=False)
    assert r["status"] == "pending"
    req = await ca.event("host.handover_request")
    assert req["to_device_id"] == b.device_id and req["to_name"] == "Notebook" and req["mode"] == "next_turn"
    st = await cb.event("chat.state", pred=ev_kind("handover_requested"))
    assert st["handover"]["to_device_id"] == b.device_id and st["handover"]["mode"] == "next_turn"
    await asyncio.sleep(0.8)  # next_turn não tem timeout com o host online
    await cb.no_event("host.granted", timeout=0.1)
    r = await ca.ack("host.end", chat_id="c1", epoch=1)
    assert r["handover_pending"] is True
    e = await ca.err("host.begin", chat_id="c1", epoch=1, purpose="run")
    assert e["code"] == "handover_pending"
    fwd = env()
    await ca.ack("host.release", chat_id="c1", epoch=1, forwarded=[{"cmd_id": "fwd-1", "env": fwd}])
    rv = await ca.event("host.revoked")
    assert rv["reason"] == "handover" and rv["epoch"] == 2
    g = await cb.event("host.granted")
    assert g["epoch"] == 2
    cmd = await cb.event("remote.command")
    assert (
        cmd["cmd_id"] == "fwd-1"
        and cmd["kind"] == "send"
        and cmd["from_device_id"] == a.device_id
        and cmd["env"] == fwd
    )
    await cb.ack("remote.result", chat_id="c1", cmd_id="fwd-1", env=env())
    assert (await ca.event("remote.result"))["cmd_id"] == "fwd-1"
    st = await ca.event("chat.state", pred=ev_kind("host_changed"))
    assert st["host"]["device_id"] == b.device_id and st["handover"] is None
    # o novo host roda
    r = await cb.ack("host.begin", chat_id="c1", epoch=2, purpose="run")
    assert r["became_host"] is False


async def test_handover_force_fallback_timeout(srv):
    a, b, ca, cb = await setup(srv)
    await ca.ack("host.begin", chat_id="c1", epoch=None, purpose="run")
    r = await cb.ack("host.takeover", chat_id="c1", mode="force", confirm_pinned=False)
    assert r["status"] == "pending"
    req = await ca.event("host.handover_request")
    assert req["mode"] == "force"
    # o host não libera: o servidor concede depois de HANDOVER_FORCE_TIMEOUT_S (0,6 s no teste)
    g = await cb.event("host.granted", timeout=3)
    assert g["epoch"] == 2
    rv = await ca.event("host.revoked")
    assert rv["reason"] == "takeover"
    r = await srv.push(a, [msg("late", "c1")], chat_bases={"c1": 0}, host_epochs={"c1": 1})
    assert r.json()["error"]["code"] == "not_host"


async def test_upgrade_next_turn_to_force_and_cancel(srv):
    a, b, ca, cb = await setup(srv)
    await ca.ack("host.begin", chat_id="c1", epoch=None, purpose="run")
    await cb.ack("host.takeover", chat_id="c1", mode="next_turn", confirm_pinned=False)
    await ca.event("host.handover_request")
    await cb.ack("host.handover_cancel", chat_id="c1")
    st = await ca.event("chat.state", pred=ev_kind("handover_cancelled"))
    assert st["handover"] is None
    await cb.ack("host.takeover", chat_id="c1", mode="next_turn", confirm_pinned=False)
    await cb.ack("host.takeover", chat_id="c1", mode="force", confirm_pinned=False)  # "Forçar agora"
    req = await ca.event("host.handover_request", pred=lambda m: m["mode"] == "force")
    assert req["to_device_id"] == b.device_id
    await cb.event("host.granted", timeout=3)
    # um terceiro dispositivo não pode pedir enquanto há troca pendente para outro
    c = await srv.login("host@example.com", name="Terceiro")
    cc, _ = await srv.ws(c)
    await cb.ack("host.end", chat_id="c1", epoch=2)
    await ca.ack("host.takeover", chat_id="c1", mode="next_turn", confirm_pinned=False)
    e = await cc.err("host.takeover", chat_id="c1", mode="next_turn", confirm_pinned=False)
    assert e["code"] == "handover_pending"


async def test_takeover_during_grace_then_granted(srv):
    a, b, ca, cb = await setup(srv)
    await ca.ack("host.begin", chat_id="c1", epoch=None, purpose="run")
    await ca.close()
    await cb.event("chat.state", pred=lambda m: m.get("host") and m["host"]["status"] == "grace")
    r = await cb.ack("host.takeover", chat_id="c1", mode="next_turn", confirm_pinned=False)
    assert r["status"] == "pending"
    await cb.event("chat.state", pred=ev_kind("host_dropped"), timeout=3)
    g = await cb.event("host.granted", timeout=2)
    assert g["epoch"] == 2


async def test_pinned_host(srv):
    a, b, ca, cb = await setup(srv)
    await ca.ack("host.begin", chat_id="c1", epoch=None, purpose="run")
    r = await cb.ack("host.pin", chat_id="c1", pinned=True)
    st = await ca.event("chat.state", pred=ev_kind("pinned"))
    assert st["pinned"] is True and st["ssq"] == r["ssq"]
    e = await cb.err("host.takeover", chat_id="c1", mode="force", confirm_pinned=False)
    assert e["code"] == "host_pinned"
    r = await cb.ack("host.takeover", chat_id="c1", mode="force", confirm_pinned=True)
    assert r["status"] == "pending"


async def test_stream_relay(srv):
    a, b, ca, cb = await setup(srv)
    w = await srv.login("host@example.com", client="web", can_host=False, name="Web")
    cw, _ = await srv.ws(w)
    await ca.ack("host.begin", chat_id="c1", epoch=None, purpose="run")
    await cb.ack("stream.subscribe", chat_ids=["c1"])
    rr = await ca.event("stream.resync_request")
    assert rr == {"t": "stream.resync_request", "chat_id": "c1", "requester_device_id": b.device_id}
    e1 = env()
    await ca.send({"t": "stream.event", "chat_id": "c1", "epoch": 1, "n": 1, "env": e1})
    ev = await cb.event("stream.event")
    assert ev == {"t": "stream.event", "chat_id": "c1", "epoch": 1, "n": 1, "env": e1, "device_id": a.device_id}
    await cw.no_event("stream.event")  # não inscrito
    await ca.no_event("stream.event")  # o próprio host não recebe de volta
    # quem não é host, epoch errado, envelope inválido: descartados
    await cb.send({"t": "stream.event", "chat_id": "c1", "epoch": 1, "n": 2, "env": env()})
    await ca.send({"t": "stream.event", "chat_id": "c1", "epoch": 9, "n": 2, "env": env()})
    await ca.send({"t": "stream.event", "chat_id": "c1", "epoch": 1, "n": 2, "env": {"v": 1}})
    await cb.no_event("stream.event")
    await cb.ack("stream.resync", chat_id="c1")
    assert (await ca.event("stream.resync_request"))["requester_device_id"] == b.device_id
    await cb.ack("stream.unsubscribe", chat_ids=["c1"])
    await ca.send({"t": "stream.event", "chat_id": "c1", "epoch": 1, "n": 3, "env": env()})
    await cb.no_event("stream.event")
    # inscrição no hello também pede snapshot
    _cw2, _ = await srv.ws(w, subscriptions=["c1"])
    assert (await ca.event("stream.resync_request"))["requester_device_id"] == w.device_id


async def test_stream_snapshot_allowed_without_window(srv):
    a, b, ca, cb = await setup(srv)
    await ca.ack("host.begin", chat_id="c1", epoch=None, purpose="run")
    await ca.ack("host.end", chat_id="c1", epoch=1)
    await cb.ack("stream.subscribe", chat_ids=["c1"])
    await ca.event("stream.resync_request")
    await ca.send({"t": "stream.event", "chat_id": "c1", "epoch": 1, "n": 1, "env": env()})
    assert (await cb.event("stream.event"))["n"] == 1


async def test_revoking_host_device_clears_host(srv):
    a, b, ca, cb = await setup(srv)
    await ca.ack("host.begin", chat_id="c1", epoch=None, purpose="run")
    r = await srv.http.delete(f"/api/v1/devices/{a.device_id}", headers=b.h)
    assert r.status_code == 204
    assert await ca.wait_closed() == 4403
    st = await cb.event("chat.state", pred=lambda m: m.get("host") is None)
    assert st["window"] is None and st["epoch"] == 2


async def test_server_restart_grace(make_server):
    srv = await make_server()
    a = await srv.signup("r@example.com")
    await srv.push(a, [chat("c1")])
    ca, _ = await srv.ws(a)
    await ca.ack("host.begin", chat_id="c1", epoch=None, purpose="run")
    srv.clients.remove(ca)
    await srv.stop()
    assert await ca.wait_closed() == 1001
    srv2 = await make_server()
    st = (await srv2.http.get("/api/v1/chat-states", headers=a.h)).json()["chat_states"][0]
    assert st["host"]["status"] == "grace" and st["window"]["purpose"] == "run"
    # reconecta dentro da tolerância de reinício e retoma a janela
    _c, w = await srv2.ws(a, active_windows=[{"chat_id": "c1", "epoch": 1}])
    assert w["resumed_windows"] == ["c1"]
    st = (await srv2.http.get("/api/v1/chat-states", headers=a.h)).json()["chat_states"][0]
    assert st["host"]["status"] == "online"
    _ = uuid


async def test_server_restart_grace_expires(make_server):
    srv = await make_server()
    a = await srv.signup("r2@example.com")
    await srv.push(a, [chat("c1")])
    ca, _ = await srv.ws(a)
    await ca.ack("host.begin", chat_id="c1", epoch=None, purpose="run")
    srv.clients.remove(ca)
    await srv.stop()
    srv2 = await make_server()
    await asyncio.sleep(1.3)
    st = (await srv2.http.get("/api/v1/chat-states", headers=a.h)).json()["chat_states"][0]
    assert st["host"]["status"] == "offline" and st["window"] is None
