"""Push/pull com seq, idempotência, conflitos de revisão, tombstones, cascatas, cursor expirado, cotas,
validação de envelope (vetores)."""

from __future__ import annotations

import json
import uuid
from datetime import timedelta

from conftest import VECTORS, chat, env, item, msg
from sqlalchemy import text

from clearchat_server.jobs import run_gc
from clearchat_server.util import utcnow

RECORDS = json.loads((VECTORS / "records.json").read_text())


async def test_seq_contiguous_and_pull_pages(srv):
    s = await srv.signup()
    items = [item("provider", f"p{i}") for i in range(5)]
    r = await srv.push(s, items)
    assert r.status_code == 200
    body = r.json()
    assert [x["seq"] for x in body["results"]] == [1, 2, 3, 4, 5] and body["head"] == 5
    r = await srv.push(s, [item("setting", "defaultModel")])
    assert r.json()["results"][0]["seq"] == 6
    # páginas
    r = (await srv.http.get("/api/v1/sync/changes?since=0&limit=4", headers=s.h)).json()
    assert [c["seq"] for c in r["changes"]] == [1, 2, 3, 4] and r["has_more"] and r["next"] == 4 and r["head"] == 6
    r = (await srv.http.get("/api/v1/sync/changes?since=4&limit=4", headers=s.h)).json()
    assert [c["seq"] for c in r["changes"]] == [5, 6] and not r["has_more"] and r["next"] == 6
    ch = r["changes"][-1]
    assert ch["type"] == "setting" and ch["rev"] == 1 and ch["env"]["v"] == 1 and ch["device_id"] == s.device_id
    assert ch["updated_at"].endswith("Z") and ch["size"] == 40
    r = (await srv.http.get("/api/v1/sync/changes?since=6", headers=s.h)).json()
    assert r == {"changes": [], "next": 6, "has_more": False, "head": 6}
    # payload=0 → omitted
    r = (await srv.http.get("/api/v1/sync/changes?since=0&payload=0", headers=s.h)).json()
    assert all(c.get("omitted") and "env" not in c for c in r["changes"])
    # fetch
    r = (
        await srv.http.post("/api/v1/records/fetch", json={"items": [{"type": "provider", "id": "p1"}]}, headers=s.h)
    ).json()
    assert r["records"][0]["id"] == "p1" and "env" in r["records"][0]
    # cada registro aparece uma vez (última revisão)
    await srv.push(s, [item("provider", "p0", base_rev=1)])
    r = (await srv.http.get("/api/v1/sync/changes?since=0", headers=s.h)).json()
    assert [c["id"] for c in r["changes"]].count("p0") == 1 and r["changes"][-1]["rev"] == 2


async def test_setting_ids_not_filtered(srv):
    # protocolo 1.4.0 (§4.3.2): ids de setting novos do app passam sem mudar o servidor (LWW inteiro,
    # nunca tombstone); só o padrão de id vale
    s = await srv.signup()
    ids = ["smartApproveDefaults", "autoTitle", "toolOutputSpillChars"]
    r = await srv.push(s, [item("setting", i) for i in ids])
    assert r.status_code == 200 and [x["seq"] for x in r.json()["results"]] == [1, 2, 3]
    r = await srv.push(s, [item("setting", "autoTitle", base_rev=1)])
    assert r.status_code == 200 and r.json()["results"][0]["rev"] == 2
    r = (await srv.http.get("/api/v1/sync/changes?since=0", headers=s.h)).json()
    assert sorted(c["id"] for c in r["changes"]) == sorted(ids)
    r = await srv.push(s, [item("setting", "autoTitle", base_rev=2, deleted=True)])
    assert r.status_code == 400


async def test_idempotent_push(srv):
    s = await srv.signup()
    body = {"push_id": str(uuid.uuid4()), "items": [item("provider", "p1")]}
    r1 = await srv.http.post("/api/v1/sync/push", json=body, headers=s.h)
    r2 = await srv.http.post("/api/v1/sync/push", json=body, headers=s.h)
    assert r1.status_code == r2.status_code == 200 and r1.json() == r2.json()
    head = (await srv.http.get("/api/v1/sync/changes?since=0", headers=s.h)).json()["head"]
    assert head == 1


async def test_rev_conflicts_and_tombstones(srv):
    s = await srv.signup()
    await srv.push(s, [item("provider", "p1")])
    await srv.push(s, [item("provider", "p1", base_rev=1)])
    r = await srv.push(s, [item("provider", "p1", base_rev=1), item("provider", "p2")])
    assert r.status_code == 409
    e = r.json()["error"]
    assert e["code"] == "conflict"
    (c,) = e["details"]["conflicts"]
    assert c["reason"] == "rev_mismatch" and c["current"]["rev"] == 2 and "env" in c["current"]
    # lote atômico: p2 não entrou
    assert (
        await srv.http.post("/api/v1/records/fetch", json={"items": [{"type": "provider", "id": "p2"}]}, headers=s.h)
    ).json()["records"] == []
    # exclusão
    r = await srv.push(s, [item("provider", "p1", base_rev=2, deleted=True)])
    assert r.status_code == 200
    ch = (await srv.http.get("/api/v1/sync/changes?since=2", headers=s.h)).json()["changes"][-1]
    assert ch["deleted"] is True and "env" not in ch and "omitted" not in ch and ch["size"] == 0
    # editar algo apagado sem ter visto a exclusão → gone
    r = await srv.push(s, [item("provider", "p1", base_rev=2)])
    assert r.json()["error"]["details"]["conflicts"][0]["reason"] == "gone"
    # recriar de propósito (base_rev = rev do tombstone)
    r = await srv.push(s, [item("provider", "p1", base_rev=3)])
    assert r.status_code == 200 and r.json()["results"][0]["rev"] == 4
    # GET /records não traz tombstones
    await srv.push(
        s,
        [
            item("provider", "p9"),
        ],
    )
    await srv.push(s, [item("provider", "p9", base_rev=1, deleted=True)])
    recs = (await srv.http.get("/api/v1/records?type=provider", headers=s.h)).json()
    assert [x["id"] for x in recs["records"]] == ["p1"]


async def test_push_validation(srv):
    s = await srv.signup()
    bad = [
        item("unknown_type", "x"),
        item("provider", "x", scope="nope"),
        item("memory", "x"),  # scope obrigatório
        {**item("chat", "c1", "c2")},
        {**item("provider", "x"), "rev": 3},
        {**item("provider", "x", deleted=True), "env": env()},
        item("setting", "defaultModel", deleted=True),
        item("provider", "bad|id"),
        {**item("provider", "x"), "env": {"v": 2, "k": 1, "n": env()["n"], "c": env()["c"]}},
        {**item("provider", "x"), "env": {"v": 1, "k": 1, "n": "AAAA", "c": env()["c"]}},  # nonce 3 bytes
        {**item("provider", "x"), "env": {"v": 1, "k": 1, "n": env()["n"], "c": "AAAAAAAAAAAAAAAAAAAA"}},  # 15 bytes
        {**item("provider", "x"), "env": {"v": 1, "k": 1, "n": env()["n"] + "=", "c": env()["c"]}},  # padding
        {**item("provider", "x"), "blobs": ["XYZ"]},
    ]
    for it in bad:
        r = await srv.push(s, [it])
        assert r.status_code == 400 and r.json()["error"]["code"] == "invalid_request", it
    r = await srv.push(s, [item("provider", "x"), item("provider", "x")])
    assert r.status_code == 400
    r = await srv.push(s, [item("provider", f"p{i}") for i in range(501)])
    assert r.status_code == 400


async def test_envelope_test_vectors(srv):
    """Os envelopes dos vetores (válidos e os que só falham na decifragem) passam na validação de formato."""
    s = await srv.signup()
    envs = [c["envelope"] for c in RECORDS["cases"]] + [c["envelope"] for c in RECORDS["must_fail"]]
    rt = json.loads((VECTORS / "realtime.json").read_text())
    envs += [c["envelope"] for c in rt["cases"]]
    for n, e in enumerate(envs):
        r = await srv.push(s, [item("provider", f"v{n}", env=e)])
        assert r.status_code == 200, (e, r.text)
    got = (await srv.http.get("/api/v1/sync/changes?since=0", headers=s.h)).json()["changes"]
    assert got[0]["env"] == envs[0] and got[0]["size"] == RECORDS["cases"][0]["ciphertext_size"]


async def test_scopes_and_cascades(srv):
    s = await srv.signup()
    r = await srv.push(s, [msg("m1", "nochat")], chat_bases={"nochat": 0})
    assert r.json()["error"]["details"]["conflicts"][0]["reason"] == "scope_missing"
    r = await srv.push(s, [item("memory", "mem1", "col1")])
    assert r.json()["error"]["details"]["conflicts"][0]["reason"] == "scope_missing"
    r = await srv.push(
        s, [chat("c1"), item("session", "s1", "c1"), msg("m1", "c1"), msg("m2", "c1")], chat_bases={"c1": 0}
    )
    assert r.status_code == 200, r.text
    await srv.push(
        s, [item("memory_collection", "col1"), item("memory", "mem1", "col1"), item("memory", "mem2", "col1")]
    )
    acc = (await srv.http.get("/api/v1/account", headers=s.h)).json()
    assert acc["usage"]["records"] == 7
    # apagar o chat apaga sessões e mensagens; só o tombstone do chat vai ao feed
    r = await srv.push(s, [chat("c1", base_rev=1, deleted=True)])
    assert r.status_code == 200
    feed = (await srv.http.get("/api/v1/sync/changes?since=0", headers=s.h)).json()["changes"]
    assert {(c["type"], c["id"]) for c in feed} == {
        ("chat", "c1"),
        ("memory_collection", "col1"),
        ("memory", "mem1"),
        ("memory", "mem2"),
    }
    r = await srv.push(s, [msg("m3", "c1")], chat_bases={"c1": 0})
    assert r.json()["error"]["details"]["conflicts"][0]["reason"] == "scope_deleted"
    r = await srv.push(s, [item("memory_collection", "col1", base_rev=1, deleted=True)])
    assert r.status_code == 200
    acc = (await srv.http.get("/api/v1/account", headers=s.h)).json()
    assert acc["usage"]["records"] == 0 and acc["usage"]["record_bytes"] == 0
    async with srv.ctx.engine.connect() as c:
        n = (
            await c.execute(text("SELECT count(*) FROM records WHERE type IN ('session','message','memory')"))
        ).scalar()
        cs = (await c.execute(text("SELECT count(*) FROM chat_states"))).scalar()
    assert n == 0 and cs == 0


async def test_tombstone_gc_and_cursor_expired(srv):
    s = await srv.signup()
    await srv.push(s, [item("provider", "p1"), item("provider", "p2")])
    await srv.push(s, [item("provider", "p1", base_rev=1, deleted=True)])
    async with srv.ctx.engine.begin() as c:
        await c.execute(text("UPDATE records SET updated_at = now() - interval '181 days' WHERE deleted"))
    out = await run_gc(srv.ctx)
    assert out["tombstones"] == 1
    r = await srv.http.get("/api/v1/sync/changes?since=0", headers=s.h)
    assert r.status_code == 410 and r.json()["error"]["code"] == "cursor_expired"
    r = await srv.http.get("/api/v1/sync/changes?since=3", headers=s.h)
    assert r.status_code == 200
    # resync completo via /records
    recs = (await srv.http.get("/api/v1/records", headers=s.h)).json()
    assert [x["id"] for x in recs["records"]] == ["p2"] and recs["head"] == 3
    _ = (utcnow, timedelta)


async def test_quotas(srv):
    s = await srv.signup()
    async with srv.ctx.engine.begin() as c:
        await c.execute(
            text("UPDATE users SET quota_records = 2, quota_record_bytes = 100 WHERE id = :u"), {"u": s.user_id}
        )
    r = await srv.push(s, [item("provider", "a"), item("provider", "b"), item("provider", "c")])
    assert r.status_code == 413 and r.json()["error"]["details"] == {"kind": "records", "used": 0, "limit": 2}
    r = await srv.push(s, [item("provider", "a", env=env(120))])
    assert r.status_code == 413 and r.json()["error"]["details"]["kind"] == "record_bytes"
    assert (await srv.push(s, [item("provider", "a"), item("provider", "b")])).status_code == 200
    # apagar libera espaço
    assert (
        await srv.push(s, [item("provider", "a", base_rev=1, deleted=True), item("provider", "c")])
    ).status_code == 200


async def test_ws_push_pull_fetch(srv):
    s = await srv.signup()
    c, _ = await srv.ws(s)
    other, _ = await srv.ws(await srv.login(s.email))
    a = await c.ack("sync.push", push_id=str(uuid.uuid4()), items=[item("provider", "p1")])
    assert a["head"] == 1 and a["results"][0]["seq"] == 1
    ev = await other.event("sync.changes")
    assert ev["head"] == 1 and ev["changes"][0]["id"] == "p1"
    ev = await c.event("sync.changes")  # inclusive a conexão que enviou
    e = await c.err("sync.push", push_id=str(uuid.uuid4()), items=[item("provider", "p1")])
    assert e["code"] == "conflict" and e["details"]["conflicts"][0]["reason"] == "rev_mismatch"
    p = await c.ack("sync.pull", since=0)
    assert p["head"] == 1 and len(p["changes"]) == 1
    f = await c.ack("sync.fetch", items=[{"type": "provider", "id": "p1"}])
    assert f["records"][0]["rev"] == 1


async def test_big_change_is_omitted_in_event(srv):
    s = await srv.signup()
    c, _ = await srv.ws(s)
    big = env(150 * 1024)  # ~200 KiB em base64
    r = await srv.push(s, [item("provider", "a", env=big), item("provider", "b", env=env(100 * 1024))])
    assert r.status_code == 200
    ev = await c.event("sync.changes")
    assert "env" in ev["changes"][0] and ev["changes"][1].get("omitted") is True
