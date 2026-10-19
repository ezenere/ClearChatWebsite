"""Divergência (§9): detecção por base < head (só com conteúdo de outro dispositivo depois da base),
bloqueios enquanto divergente, resolução online/local, divergence_discarded, divergence_mismatch,
terceiro dispositivo."""

from __future__ import annotations

import uuid

from conftest import chat, env, item, msg

from clearchat_server.sync import records


def ev_kind(kind):
    return lambda m: (m.get("event") or {}).get("kind") == kind


async def diverged_setup(srv):
    a = await srv.signup("div@example.com")
    d = await srv.login("div@example.com", name="Offline")
    r = await srv.push(a, [chat("c1"), msg("m1", "c1")], chat_bases={"c1": 0})
    assert r.status_code == 200  # head 2, host = a
    ca, _ = await srv.ws(a)
    cd, _ = await srv.ws(d)
    # a roda online: head avança
    await ca.ack("host.begin", chat_id="c1", epoch=1, purpose="run")
    r = await srv.push(a, [msg("m2", "c1")], chat_bases={"c1": 2}, host_epochs={"c1": 1})
    assert r.json()["chat_heads"] == {"c1": 3}
    await ca.ack("host.end", chat_id="c1", epoch=1)
    # d rodou offline a partir de head=2 e agora sobe (replay) → diverge
    r = await srv.push(d, [msg("m3", "c1")], chat_bases={"c1": 2})
    assert r.status_code == 409
    err = r.json()["error"]
    assert err["code"] == "chat_diverged"
    dv = err["details"]["diverged"]
    assert dv["device_id"] == d.device_id and dv["base"] == 2 and dv["head"] == 3 and dv["device_name"] == "Offline"
    st = await ca.event("chat.state", pred=ev_kind("diverged"))
    assert st["diverged"]["divergence_id"] == dv["divergence_id"]
    return a, d, ca, cd, dv


async def test_diverged_blocks_writes_and_commands(srv):
    a, d, ca, cd, dv = await diverged_setup(srv)
    # nada é salvo online para o chat: conteúdo, registro chat, host.begin, comandos, takeover
    r = await srv.push(a, [msg("m4", "c1")], chat_bases={"c1": 3})
    assert r.json()["error"]["code"] == "chat_diverged"
    r = await srv.push(a, [chat("c1", base_rev=1)])
    assert r.json()["error"]["code"] == "chat_diverged"
    assert (await ca.err("host.begin", chat_id="c1", epoch=1, purpose="run"))["code"] == "chat_diverged"
    assert (await cd.err("remote.send", chat_id="c1", cmd_id="k", kind="send", env=env()))["code"] == "chat_diverged"
    assert (await cd.err("host.takeover", chat_id="c1", mode="force", confirm_pinned=True))["code"] == "chat_diverged"
    # um terceiro dispositivo com versão própria espera (não abre outra divergência)
    t = await srv.login("div@example.com", name="Terceiro")
    r = await srv.push(t, [msg("m5", "c1")], chat_bases={"c1": 1})
    assert r.json()["error"]["code"] == "chat_diverged"
    assert r.json()["error"]["details"]["diverged"]["divergence_id"] == dv["divergence_id"]
    # registros de outros chats continuam
    assert (await srv.push(a, [item("provider", "p1")])).status_code == 200
    # a exclusão do chat ainda é permitida
    assert (await srv.push(a, [chat("c1", base_rev=1, deleted=True)])).status_code == 200


async def test_resolve_keep_online_then_discarded(srv):
    a, d, ca, cd, dv = await diverged_setup(srv)
    r = await srv.http.post(
        "/api/v1/chats/c1/divergence/resolve", json={"divergence_id": str(uuid.uuid4()), "keep": "online"}, headers=a.h
    )
    assert r.status_code == 409 and r.json()["error"]["code"] == "divergence_mismatch"
    r = await srv.http.post(
        "/api/v1/chats/c1/divergence/resolve",
        json={"divergence_id": dv["divergence_id"], "keep": "online"},
        headers=a.h,
    )
    assert r.status_code == 200 and r.json()["state"]["diverged"] is None
    st = await cd.event("chat.state", pred=ev_kind("resolved"))
    assert st["diverged"] is None and st["host"]["device_id"] == a.device_id
    # d volta a mandar a mesma versão (mesma base) → divergence_discarded
    r = await srv.push(d, [msg("m3", "c1")], chat_bases={"c1": 2})
    assert r.status_code == 409 and r.json()["error"]["code"] == "divergence_discarded"
    assert r.json()["error"]["details"]["divergence_id"] == dv["divergence_id"]
    # depois de baixar a versão online, d sincroniza normalmente
    r = await srv.push(d, [msg("m6", "c1")], chat_bases={"c1": 3})
    assert r.status_code == 200
    # resolver de novo com o id velho → mismatch
    r = await srv.http.post(
        "/api/v1/chats/c1/divergence/resolve",
        json={"divergence_id": dv["divergence_id"], "keep": "online"},
        headers=a.h,
    )
    assert r.json()["error"]["code"] == "divergence_mismatch"


async def test_resolve_keep_local(srv):
    a, d, ca, cd, dv = await diverged_setup(srv)
    body = {
        "divergence_id": dv["divergence_id"],
        "keep": "local",
        "push_id": str(uuid.uuid4()),
        "items": [msg("m3", "c1"), msg("m2", "c1", base_rev=1, deleted=True)],
    }
    # só D pode manter a versão local
    r = await srv.http.post("/api/v1/chats/c1/divergence/resolve", json=body, headers=a.h)
    assert r.status_code == 409 and r.json()["error"]["code"] == "divergence_mismatch"
    # itens fora do chat são recusados
    bad = {**body, "items": [item("provider", "p1")]}
    r = await srv.http.post("/api/v1/chats/c1/divergence/resolve", json=bad, headers=d.h)
    assert r.status_code == 400
    # conflito de revisão → nada aplicado
    bad = {**body, "push_id": str(uuid.uuid4()), "items": [msg("m2", "c1", base_rev=0)]}
    r = await srv.http.post("/api/v1/chats/c1/divergence/resolve", json=bad, headers=d.h)
    assert r.json()["error"]["code"] == "conflict"
    r = await srv.http.post("/api/v1/chats/c1/divergence/resolve", json=body, headers=d.h)
    assert r.status_code == 200, r.text
    out = r.json()
    assert out["chat_heads"] == {"c1": out["head"]} and out["state"]["diverged"] is None
    assert out["state"]["head"] == out["head"]
    # idempotente pelo push_id
    r2 = await srv.http.post("/api/v1/chats/c1/divergence/resolve", json=body, headers=d.h)
    assert r2.json() == out
    ch = await ca.event("sync.changes", pred=lambda m: any(c["id"] == "m3" for c in m["changes"]))
    assert {(c["id"], c["deleted"]) for c in ch["changes"]} == {("m3", False), ("m2", True)}
    st = await ca.event("chat.state", pred=ev_kind("resolved"))
    assert st["host"]["device_id"] == a.device_id  # o host não muda
    # o chat volta a aceitar escrita com o head novo
    await ca.ack("host.begin", chat_id="c1", epoch=1, purpose="run")
    r = await srv.push(a, [msg("m7", "c1")], chat_bases={"c1": out["head"]}, host_epochs={"c1": 1})
    assert r.status_code == 200


async def test_keep_local_without_host_makes_d_host(srv):
    a = await srv.signup("nh@example.com", client="web", can_host=False)
    d = await srv.login("nh@example.com", name="D")
    # web cria o chat e escreve conteúdo (replay) sem virar host
    r = await srv.push(a, [chat("c1"), msg("m1", "c1")], chat_bases={"c1": 0})
    assert r.status_code == 200
    r = await srv.push(a, [msg("m2", "c1")], chat_bases={"c1": 2})
    assert r.status_code == 200
    r = await srv.push(d, [msg("mx", "c1")], chat_bases={"c1": 2})
    dv = r.json()["error"]["details"]["diverged"]
    r = await srv.http.post(
        "/api/v1/chats/c1/divergence/resolve",
        json={"divergence_id": dv["divergence_id"], "keep": "local", "items": [msg("mx", "c1")]},
        headers=d.h,
    )
    assert r.status_code == 200 and r.json()["state"]["host"]["device_id"] == d.device_id


# ---------------------------------------------------------------- base velha do próprio dispositivo
async def chat_state(srv, s, chat_id):
    r = await srv.http.get("/api/v1/chat-states?since=0", headers=s.h)
    assert r.status_code == 200
    return next(st for st in r.json()["chat_states"] if st["chat_id"] == chat_id)


async def test_same_device_batches_with_stale_base_do_not_diverge(srv):
    # chat novo grande enviado em vários lotes, todos com a chat_bases calculada antes do 1º (0)
    a = await srv.signup("lotes@example.com")
    ca, _ = await srv.ws(a)
    r = await srv.push(a, [chat("c1"), msg("m1", "c1"), msg("m2", "c1")], chat_bases={"c1": 0})
    assert r.status_code == 200 and r.json()["chat_heads"] == {"c1": 3}
    r = await srv.push(a, [msg("m3", "c1"), msg("m4", "c1")], chat_bases={"c1": 0})
    assert r.status_code == 200, r.text
    assert r.json()["head"] == 5 and r.json()["chat_heads"] == {"c1": 5}
    # base intermediária também velha, e edição de um registro do próprio lote anterior
    r = await srv.push(a, [msg("m5", "c1"), msg("m1", "c1", base_rev=1)], chat_bases={"c1": 3})
    assert r.status_code == 200, r.text
    assert r.json()["chat_heads"] == {"c1": 7}
    st = await chat_state(srv, a, "c1")
    assert st["diverged"] is None and st["head"] == 7 and st["host"]["device_id"] == a.device_id
    await ca.no_event("chat.state", pred=ev_kind("diverged"))
    # a re-checagem de mark_divergence segue a mesma regra: nada de outro dispositivo → não marca
    err, broadcast = await records.mark_divergence(
        srv.ctx.engine, uuid.UUID(a.user_id), uuid.UUID(a.device_id), "c1", 0, lambda _d: True
    )
    assert broadcast is None and err.details["diverged"] is None
    assert (await chat_state(srv, a, "c1"))["diverged"] is None


async def test_same_device_stale_base_still_runs_host_checks(srv):
    # a exceção só pula a divergência: o resto segue como b == head (aqui: host_epochs de quem não é host)
    w = await srv.signup("web-lotes@example.com", client="web", can_host=False)
    r = await srv.push(w, [chat("c1"), msg("m1", "c1")], chat_bases={"c1": 0})
    assert r.status_code == 200
    r = await srv.push(w, [msg("m2", "c1")], chat_bases={"c1": 0}, host_epochs={"c1": 1})
    assert r.status_code == 409 and r.json()["error"]["code"] == "not_host"
    r = await srv.push(w, [msg("m2", "c1")], chat_bases={"c1": 0})
    assert r.status_code == 200 and r.json()["chat_heads"] == {"c1": 3}
    assert (await chat_state(srv, w, "c1"))["host"] is None  # web não vira host


async def test_other_device_after_base_still_diverges(srv):
    a = await srv.signup("outro@example.com")
    b = await srv.login("outro@example.com", name="B")
    r = await srv.push(a, [chat("c1"), msg("m1", "c1")], chat_bases={"c1": 0})
    assert r.status_code == 200  # head 2
    r = await srv.push(b, [msg("m2", "c1")], chat_bases={"c1": 2})
    assert r.status_code == 200  # head 3 (b)
    # a ainda manda com a base de antes do 1º lote: no meio há conteúdo de b → diverge como antes
    r = await srv.push(a, [msg("m3", "c1")], chat_bases={"c1": 0})
    assert r.status_code == 409
    err = r.json()["error"]
    assert err["code"] == "chat_diverged"
    dv = err["details"]["diverged"]
    assert dv["device_id"] == a.device_id and dv["base"] == 0 and dv["head"] == 3


async def test_other_device_tombstone_after_base_still_diverges(srv):
    a = await srv.signup("tomb@example.com")
    b = await srv.login("tomb@example.com", name="B")
    r = await srv.push(a, [chat("c1"), msg("m1", "c1"), msg("m2", "c1")], chat_bases={"c1": 0})
    assert r.status_code == 200  # head 3
    r = await srv.push(a, [msg("m3", "c1")], chat_bases={"c1": 3})
    assert r.status_code == 200  # head 4 (a)
    # b só apagou uma mensagem (tombstone também é escrita de conteúdo) e a volta com base 3
    r = await srv.push(b, [msg("m1", "c1", base_rev=1, deleted=True)], chat_bases={"c1": 4})
    assert r.status_code == 200  # head 5 (b)
    r = await srv.push(a, [msg("m4", "c1")], chat_bases={"c1": 3})
    assert r.status_code == 409 and r.json()["error"]["code"] == "chat_diverged"
    dv = r.json()["error"]["details"]["diverged"]
    assert dv["device_id"] == a.device_id and dv["base"] == 3 and dv["head"] == 5


async def test_discarded_base_wins_over_same_device_exemption(srv):
    a, d, ca, cd, dv = await diverged_setup(srv)
    r = await srv.http.post(
        "/api/v1/chats/c1/divergence/resolve",
        json={"divergence_id": dv["divergence_id"], "keep": "online"},
        headers=a.h,
    )
    assert r.status_code == 200
    # d baixa a versão online e passa a escrever com o head certo, inclusive por cima da m2 de a: agora
    # todo conteúdo depois da base 2 é de d — mesmo assim a base descartada continua descartada
    r = await srv.push(d, [msg("m6", "c1")], chat_bases={"c1": 3})
    assert r.status_code == 200
    head = r.json()["chat_heads"]["c1"]
    r = await srv.push(d, [msg("m2", "c1", base_rev=1)], chat_bases={"c1": head})
    assert r.status_code == 200
    r = await srv.push(d, [msg("m3", "c1")], chat_bases={"c1": 2})
    assert r.status_code == 409 and r.json()["error"]["code"] == "divergence_discarded"
    assert r.json()["error"]["details"]["divergence_id"] == dv["divergence_id"]
