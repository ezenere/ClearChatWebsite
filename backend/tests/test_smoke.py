from __future__ import annotations

from conftest import chat, msg


async def test_info(srv):
    r = await srv.http.get("/api/info")
    assert r.status_code == 200
    b = r.json()
    assert b["protocol"] == {"min": 1, "max": 1, "version": "1.1.1"}
    assert b["features"]["captcha"] is None
    assert b["links"]["signup"] == "http://clear.test/signup"


async def test_signup_push_pull_ws(srv):
    s = await srv.signup()
    assert s.body["keys_ready"] is False and s.body["keys"] is None
    c, w = await srv.ws(s)
    assert w["head"] == 0
    r = await srv.push(s, [chat("c1"), msg("m1", "c1")], chat_bases={"c1": 0})
    assert r.status_code == 200, r.text
    assert r.json()["head"] == 2
    ev = await c.event("sync.changes")
    assert [x["seq"] for x in ev["changes"]] == [1, 2]
    r = await srv.http.get("/api/v1/sync/changes?since=0", headers=s.h)
    assert r.json()["head"] == 2 and len(r.json()["changes"]) == 2
