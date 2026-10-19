"""WebSocket: handshake, códigos de fechamento, acks/erros, ping, resume (cursor/state_cursor), supersede."""

from __future__ import annotations

import asyncio
import json

from conftest import chat, item
from websockets.asyncio.client import connect as ws_connect
from websockets.exceptions import ConnectionClosed


async def raw_close_code(srv, frames, wait=3.0):
    ws = await ws_connect(srv.ws_url, ping_interval=None)
    for f in frames:
        await ws.send(json.dumps(f) if isinstance(f, dict) else f)
    try:
        async with asyncio.timeout(wait):
            async for _ in ws:
                pass
    except TimeoutError:
        await ws.close()
    except ConnectionClosed:
        pass
    return ws.close_code


async def test_handshake_errors(srv):
    s = await srv.signup()
    assert await raw_close_code(srv, []) == 4002  # sem hello em 1 s (teste)
    assert await raw_close_code(srv, [{"t": "ping"}]) == 4000
    assert await raw_close_code(srv, ["not json"]) == 4000
    assert await raw_close_code(srv, [{"t": "hello", "id": "1", "protocol": 2, "access_token": s.access}]) == 4001
    assert await raw_close_code(srv, [{"t": "hello", "id": "1", "protocol": 1, "access_token": "cca_bad"}]) == 4401
    await srv.http.delete(f"/api/v1/devices/{s.device_id}", headers=s.h)
    assert await raw_close_code(srv, [{"t": "hello", "id": "1", "protocol": 1, "access_token": s.access}]) == 4401


async def test_welcome_ping_errors_and_unknown(srv):
    s = await srv.signup()
    await srv.push(s, [item("provider", "p1")])
    c, w = await srv.ws(s)
    assert w["protocol"] == 1 and w["user_id"] == s.user_id and w["device_id"] == s.device_id
    assert w["head"] == 1 and w["keys_rev"] == 0 and w["server_time"].endswith("Z")
    assert w["resumed_windows"] == [] and w["lost_windows"] == []
    pong = await c.req("ping", ts=123)
    assert pong == {"t": "pong", "re": "2", "ts": 123}
    e = await c.err("nope.nope")
    assert e["code"] == "invalid_request" and e["re"] == "3"
    await c.send({"t": "sync.pull", "since": 0})  # sem id
    ev = await c.event("error")
    assert ev["details"]["reason"] == "missing_id"
    e = await c.err("sync.pull", since=-1)
    assert e["code"] == "invalid_request"


async def test_superseded(srv):
    s = await srv.signup()
    c1, _ = await srv.ws(s)
    c2, _ = await srv.ws(s)
    assert await c1.wait_closed() == 4409
    assert (await c2.req("ping"))["t"] == "pong"
    devs = (await srv.http.get("/api/v1/devices", headers=s.h)).json()
    assert devs[0]["online"] is True


async def test_resume_from_cursor_and_state_cursor(srv):
    s = await srv.signup()
    c, w = await srv.ws(s)
    await srv.push(s, [chat("c1"), chat("c2")])
    await c.ack("host.pin", chat_id="c1", pinned=True)
    a2 = await c.ack("host.pin", chat_id="c2", pinned=True)
    await c.close()
    c2, w2 = await srv.ws(s, cursor=1, state_cursor=a2["ssq"] - 1)
    assert w2["head"] == 2
    assert [st["chat_id"] for st in w2["chat_states"]] == ["c2"] and w2["state_cursor"] == a2["ssq"]
    p = await c2.ack("sync.pull", since=1)
    assert [x["id"] for x in p["changes"]] == ["c2"]
    await c2.close()
    _c3, w3 = await srv.ws(s, state_cursor=0)
    assert {st["chat_id"] for st in w3["chat_states"]} == {"c1", "c2"}
    assert all(st["pinned"] for st in w3["chat_states"])


async def test_idle_timeout(make_server):
    srv = await make_server(ws_idle_timeout_s=0.6)
    s = await srv.signup()
    c, _ = await srv.ws(s)
    assert await c.wait_closed(3) == 1000


async def test_ws_rate_limit_per_user(srv):
    s = await srv.signup()
    codes = []
    for _ in range(31):
        c, w = None, None
        from conftest import WSClient

        c = WSClient(srv, s)
        try:
            w = await c.connect()
        except Exception:
            w = None
        codes.append(w["t"] if w else (await c.wait_closed()))
        await c.close()
    assert codes[:30] == ["welcome"] * 30 and codes[30] == 4429
