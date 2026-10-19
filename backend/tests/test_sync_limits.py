"""Limites de bytes nas leituras do sync (pull/list/fetch em duas fases, orçamento PAGE_BYTES), teto por
registro no push, leitor de corpo linear e regex de validação ancoradas em \\A…\\Z (correções da auditoria)."""

from __future__ import annotations

import contextlib
import secrets
import time
from typing import Any

import pytest
from conftest import env, item
from sqlalchemy import event
from starlette.requests import Request

from clearchat_server.errors import ApiError
from clearchat_server.sync import records
from clearchat_server.sync.routes import PUSH_MAX_BYTES, _json_body
from clearchat_server.util import B64U_RE, BLOB_ID_RE, HEX64_RE, RECORD_ID_RE, TYPE_RE, valid_email


@contextlib.contextmanager
def capture_sql(srv: Any):
    """Captura (sql, params) de toda consulta que toca `records` no engine do servidor em processo."""
    seen: list[tuple[str, Any]] = []

    def on_exec(conn, cursor, statement, parameters, context, executemany):  # type: ignore[no-untyped-def]
        if "records" in statement:
            seen.append((statement, parameters))

    eng = srv.ctx.engine.sync_engine
    event.listen(eng, "before_cursor_execute", on_exec)
    try:
        yield seen
    finally:
        event.remove(eng, "before_cursor_execute", on_exec)


def payload_queries(seen: list[tuple[str, Any]]) -> list[tuple[str, Any]]:
    return [(q, p) for q, p in seen if "ciphertext" in q and q.lstrip().upper().startswith("SELECT")]


async def test_payload0_reads_never_select_ciphertext(srv):
    s = await srv.signup()
    assert (await srv.push(s, [item("provider", f"p{i}", env=env(2000)) for i in range(5)])).status_code == 200
    with capture_sql(srv) as seen:
        r = (await srv.http.get("/api/v1/sync/changes?since=0&payload=0", headers=s.h)).json()
        assert len(r["changes"]) == 5 and all(c.get("omitted") and "env" not in c for c in r["changes"])
        r = (await srv.http.get("/api/v1/records?payload=0", headers=s.h)).json()
        assert len(r["records"]) == 5 and all(c.get("omitted") and "env" not in c for c in r["records"])
    assert [q for q, _ in seen if "FROM records" in q], "esperava consultas em records"
    assert not [q for q, _ in seen if "ciphertext" in q or "nonce" in q], seen


async def test_payload_pull_and_list_stop_at_page_bytes(srv, monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setattr(records, "PAGE_BYTES", 250)
    s = await srv.signup()
    assert (await srv.push(s, [item("provider", f"p{i}", env=env(100)) for i in range(5)])).status_code == 200
    with capture_sql(srv) as seen:
        r = (await srv.http.get("/api/v1/sync/changes?since=0", headers=s.h)).json()
    # 100 + 100 cabe em 250; o terceiro passaria → para, has_more, next aponta o último devolvido
    assert [c["id"] for c in r["changes"]] == ["p0", "p1"] and r["has_more"] and r["next"] == 2
    assert all("env" in c for c in r["changes"])
    (q, params), *rest = payload_queries(seen)
    assert not rest and sorted(params[2]) == ["p0", "p1"], params  # ciphertext só dos 2 da página
    r = (await srv.http.get("/api/v1/sync/changes?since=2", headers=s.h)).json()
    assert [c["id"] for c in r["changes"]] == ["p2", "p3"] and r["has_more"]
    # /records: mesmo orçamento
    with capture_sql(srv) as seen:
        r = (await srv.http.get("/api/v1/records?type=provider", headers=s.h)).json()
    assert [c["id"] for c in r["records"]] == ["p0", "p1"] and r["has_more"] and r["next"] == 2
    (q, params), *rest = payload_queries(seen)
    assert not rest and sorted(params[2]) == ["p0", "p1"]
    # registro maior que a página inteira: vem sozinho (o primeiro entra sempre), sem travar o feed
    assert (await srv.push(s, [item("provider", "big", env=env(1000))])).status_code == 200
    r = (await srv.http.get("/api/v1/sync/changes?since=5", headers=s.h)).json()
    assert [c["id"] for c in r["changes"]] == ["big"] and "env" in r["changes"][0] and not r["has_more"]


async def test_fetch_respects_page_budget(srv, monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setattr(records, "PAGE_BYTES", 250)
    s = await srv.signup()
    assert (await srv.push(s, [item("provider", f"p{i}", env=env(100)) for i in range(5)])).status_code == 200
    await srv.push(s, [item("provider", "p4", base_rev=1, deleted=True)])
    want = [{"type": "provider", "id": f"p{i}"} for i in range(5)] + [{"type": "provider", "id": "nope"}]
    with capture_sql(srv) as seen:
        r = (await srv.http.post("/api/v1/records/fetch", json={"items": want}, headers=s.h)).json()
    recs = {c["id"]: c for c in r["records"]}
    assert set(recs) == {"p0", "p1", "p2", "p3", "p4"}
    assert "env" in recs["p0"] and "env" in recs["p1"]
    assert recs["p2"].get("omitted") is True and "env" not in recs["p2"]
    assert recs["p3"].get("omitted") is True and "env" not in recs["p3"]
    assert recs["p4"]["deleted"] is True and "env" not in recs["p4"] and "omitted" not in recs["p4"]
    (q, params), *rest = payload_queries(seen)
    assert not rest and sorted(params[2]) == ["p0", "p1"], params
    # o cliente pede de novo os omitidos e avança
    r = (
        await srv.http.post(
            "/api/v1/records/fetch", json={"items": [{"type": "provider", "id": i} for i in ("p2", "p3")]}, headers=s.h
        )
    ).json()
    assert all("env" in c for c in r["records"]) and len(r["records"]) == 2


async def test_push_conflict_still_returns_current_payload(srv):
    s = await srv.signup()
    await srv.push(s, [item("provider", "p1"), item("provider", "p2")])
    await srv.push(s, [item("provider", "p1", base_rev=1)])
    with capture_sql(srv) as seen:
        r = await srv.push(s, [item("provider", "p1", base_rev=1), item("provider", "p2", base_rev=1)])
    assert r.status_code == 409
    (c,) = r.json()["error"]["details"]["conflicts"]
    assert c["id"] == "p1" and c["current"]["rev"] == 2 and "env" in c["current"]
    # o ciphertext só é lido para o registro em conflito (o estado atual do lote vem sem payload)
    (q, params), *rest = payload_queries(seen)
    assert not rest and params[2] == ["p1"], params


async def test_oversized_record_rejected(make_server):
    srv = await make_server(record_max_bytes=1000)
    s = await srv.signup()
    r = await srv.push(s, [item("provider", "big", env=env(1001))])
    assert r.status_code == 413, r.text
    e = r.json()["error"]
    assert e["code"] == "payload_too_large" and e["details"] == {"field": "items[0].env", "limit": 1000}
    assert (await srv.push(s, [item("provider", "ok", env=env(1000))])).status_code == 200
    # o padrão fica bem acima de qualquer registro legítimo
    assert srv.settings.record_max_bytes == 1000
    assert records.MAX_RECORD_BYTES == 16 * 1024 * 1024


def _request(chunks: list[bytes]) -> Request:
    msgs = [{"type": "http.request", "body": c, "more_body": True} for c in chunks]
    msgs.append({"type": "http.request", "body": b"", "more_body": False})
    it = iter(msgs)

    async def receive() -> dict[str, Any]:
        return next(it)

    return Request({"type": "http", "method": "POST", "headers": [], "path": "/"}, receive)


async def test_json_body_reader_is_linear():
    # 32 MiB em 8192 pedaços de 4 KiB: com `bytes +=` isto custava segundos (cópia quadrática); linear ≪ 1 s
    chunk = b"x" * 4096
    n = PUSH_MAX_BYTES // len(chunk)
    t0 = time.perf_counter()
    with pytest.raises(ApiError) as ei:
        await _json_body(_request([chunk] * n), PUSH_MAX_BYTES)
    elapsed = time.perf_counter() - t0
    assert ei.value.code == "invalid_request"
    assert elapsed < 1.0, elapsed
    # e um JSON de verdade picado em pedaços de 1 byte ainda é lido inteiro
    raw = b'{"a": [1, 2, 3], "b": "x"}'
    assert await _json_body(_request([raw[i : i + 1] for i in range(len(raw))]), 1024) == {"a": [1, 2, 3], "b": "x"}
    with pytest.raises(ApiError) as ei:
        await _json_body(_request([b"x" * 600, b"x" * 600]), 1000)
    assert ei.value.code == "payload_too_large"


async def test_blob_id_with_trailing_newline_rejected(srv):
    good = secrets.token_hex(32)
    assert BLOB_ID_RE.match(good) and not BLOB_ID_RE.match(good + "\n")
    s = await srv.signup()
    r = await srv.http.post("/api/v1/blobs/check", json={"ids": [good + "\n"]}, headers=s.h)
    assert r.status_code == 400 and r.json()["error"]["code"] == "invalid_request"
    r = await srv.push(s, [item("provider", "p1", blobs=[good + "\n"])])
    assert r.status_code == 400 and r.json()["error"]["details"]["field"] == "items[0].blobs"
    r = await srv.http.put(f"/api/v1/blobs/{good}%0A", content=b"x" * 40, headers={**s.h, "X-Content-SHA256": good})
    assert r.status_code == 400 and r.json()["error"]["details"]["field"] == "blob_id"


async def test_ids_and_types_with_trailing_newline_rejected(srv):
    # "$" aceitaria o "\n" no fim; as regex de validação usam \A…\Z
    for rx, good in ((RECORD_ID_RE, "abc"), (TYPE_RE, "provider"), (HEX64_RE, "a" * 64), (B64U_RE, "AAEC")):
        assert rx.match(good) and not rx.match(good + "\n"), rx.pattern
    assert valid_email("ana@example.com") and not valid_email("ana@example.com\n")
    s = await srv.signup()
    r = await srv.push(s, [item("provider", "abc\n")])
    assert r.status_code == 400, r.text
    e = r.json()["error"]
    assert e["code"] == "invalid_request" and e["details"]["field"] == "items[0].id"
    r = await srv.push(s, [item("message", "m1", "c1\n")], chat_bases={"c1": 0})
    assert r.status_code == 400 and r.json()["error"]["details"]["field"] == "items[0].scope"
    r = await srv.push(s, [item("provider\n", "p1")])
    assert r.status_code == 400 and r.json()["error"]["details"]["field"] == "items[0].type"
    r = await srv.http.get("/api/v1/records", params={"type": "provider\n"}, headers=s.h)
    assert r.status_code == 400 and r.json()["error"]["details"]["field"] == "type"
    r = await srv.http.get("/api/v1/records", params={"scope": "c1\n"}, headers=s.h)
    assert r.status_code == 400 and r.json()["error"]["details"]["field"] == "scope"
    # nada foi gravado
    assert (await srv.http.get("/api/v1/records", headers=s.h)).json()["records"] == []
