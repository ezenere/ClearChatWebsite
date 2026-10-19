"""Limites da conexão WebSocket: fila de requisições (quantidade e bytes → 4429), frame grande recusado antes
do parse, fila de envio também no send_front, ws_max_size do uvicorn no limite do protocolo."""

from __future__ import annotations

import asyncio
import json
import uuid
from types import SimpleNamespace

import clearchat_server.realtime.ws as wsmod
from clearchat_server.realtime import hub as hubmod
from clearchat_server.realtime.hub import Conn


def slow_handler(gate: asyncio.Event, calls: list[str]):
    async def h(ctx, c, d):
        calls.append(d["id"])
        await gate.wait()
        return {}

    return h


async def test_inbound_queue_count_overflow_closes_4429(srv, monkeypatch):
    gate, calls = asyncio.Event(), []
    monkeypatch.setitem(wsmod.HANDLERS, "sync.pull", slow_handler(gate, calls))
    s = await srv.signup()
    c, _ = await srv.ws(s)
    # 1 em andamento + WS_MAX_PENDING na fila; o seguinte estoura
    for n in range(wsmod.WS_MAX_PENDING + 2):
        await c.send({"t": "sync.pull", "id": f"p{n}", "since": 0})
    assert await c.wait_closed(5) == 4429
    gate.set()
    await asyncio.sleep(0.2)
    # o que estava na fila foi descartado (nunca teve ack): no máximo a requisição em andamento rodou
    assert calls in ([], ["p0"])
    assert srv.ctx.hub.get(uuid.UUID(s.device_id)) is None


async def test_inbound_queue_bytes_overflow_closes_4429(srv, monkeypatch):
    gate, calls = asyncio.Event(), []
    monkeypatch.setitem(wsmod.HANDLERS, "sync.pull", slow_handler(gate, calls))
    s = await srv.signup()
    c, _ = await srv.ws(s)
    pad = "x" * (wsmod.WS_MAX_FRAME - 1024)
    # a primeira entra em andamento; 4 frames de ~4 MiB na fila passam de WS_MAX_PENDING_BYTES (16 MiB)
    n_frames = wsmod.WS_MAX_PENDING_BYTES // len(pad) + 2
    assert n_frames < wsmod.WS_MAX_PENDING
    for n in range(n_frames):
        await c.send({"t": "sync.pull", "id": f"b{n}", "since": 0, "pad": pad})
    assert await c.wait_closed(10) == 4429
    gate.set()
    await asyncio.sleep(0.2)
    assert calls in ([], ["b0"])


async def test_queue_within_limits_still_runs_everything_in_order(srv, monkeypatch):
    gate, calls = asyncio.Event(), []
    monkeypatch.setitem(wsmod.HANDLERS, "sync.pull", slow_handler(gate, calls))
    s = await srv.signup()
    c, _ = await srv.ws(s)
    for n in range(20):
        await c.send({"t": "sync.pull", "id": f"q{n}", "since": 0})
    await asyncio.sleep(0.2)
    gate.set()
    pong = await c.req("ping")
    assert pong["t"] == "pong"
    await asyncio.sleep(0.2)
    assert calls == [f"q{n}" for n in range(20)]
    assert c.close_code is None


async def test_oversized_frame_rejected_before_parse(srv, monkeypatch):
    parsed: list[int] = []
    real_loads = json.loads

    def spy(text, *a, **kw):
        parsed.append(len(text))
        return real_loads(text, *a, **kw)

    s = await srv.signup()
    c, _ = await srv.ws(s)
    monkeypatch.setattr(wsmod.json, "loads", spy)
    # nem é JSON válido: se o parse rodasse antes, o erro seria invalid_request/json
    await c.ws.send("{" + "x" * wsmod.WS_MAX_FRAME)
    ev = await c.event("error")
    assert ev["code"] == "payload_too_large" and ev["details"]["limit"] == wsmod.WS_MAX_FRAME and "re" not in ev
    assert all(n <= wsmod.WS_MAX_FRAME for n in parsed)
    monkeypatch.undo()
    assert (await c.req("ping"))["t"] == "pong"


async def test_send_front_applies_queue_caps():
    c = Conn(SimpleNamespace(), None, None, "PC", "linux", "desktop", True)  # type: ignore[arg-type]
    c.send_front({"t": "welcome", "blob": "x" * (hubmod.MAX_QUEUE_BYTES + 1)})
    assert c._close == (4429, "rate_limited") and not c._buf and c._bytes == 0
    # depois de fechar, nada mais entra na fila (nem pela frente)
    c.send_front({"t": "welcome"})
    assert not c._buf

    c2 = Conn(SimpleNamespace(), None, None, "PC", "linux", "desktop", True)  # type: ignore[arg-type]
    for n in range(hubmod.MAX_QUEUE_MSGS):
        c2.send({"n": n})
    assert c2._close is None
    c2.send_front({"t": "welcome"})
    assert c2._close == (4429, "rate_limited")


def test_uvicorn_ws_max_size_is_protocol_limit(monkeypatch):
    import sys

    import uvicorn

    import clearchat_server.__main__ as entry
    import clearchat_server.main as appmod

    seen = {}

    def fake_run(self, *a, **kw):
        seen["ws_max_size"] = self.config.ws_max_size

    monkeypatch.setattr(appmod, "create_app", lambda: SimpleNamespace(state=SimpleNamespace()))
    monkeypatch.setattr(uvicorn.Server, "run", fake_run)
    monkeypatch.setattr(sys, "argv", ["clearchat_server"])
    entry.main()
    assert wsmod.WS_MAX_FRAME < seen["ws_max_size"] <= wsmod.WS_MAX_FRAME + 128 * 1024
