"""Blobs CCB1: upload/download, integridade da moldura, idempotência, upload interrompido, Range, cotas, GC."""

from __future__ import annotations

import asyncio
import hashlib
import json
import secrets
from urllib.parse import urlsplit

from conftest import VECTORS, chat, msg
from sqlalchemy import text

from clearchat_server.jobs import run_gc
from clearchat_server.sync.blobs import check_framing

BLOBS = json.loads((VECTORS / "blobs.json").read_text())


def ccb1(plain_len: int, log2: int = 10) -> bytes:
    cs = 1 << log2
    n = max(1, -(-plain_len // cs))
    out = b"CCB1" + bytes([log2]) + secrets.token_bytes(16)
    for i in range(n):
        size = cs if i < n - 1 else plain_len - (n - 1) * cs
        out += secrets.token_bytes(size + 16)
    return out


def bid() -> str:
    return secrets.token_hex(32)


async def put(srv, s, blob_id, data, sha=None):
    sha = sha or hashlib.sha256(data).hexdigest()
    return await srv.http.put(
        f"/api/v1/blobs/{blob_id}",
        content=data,
        headers={**s.h, "X-Content-SHA256": sha, "Content-Type": "application/octet-stream"},
    )


def test_framing_rules_and_vectors():
    for case in BLOBS["cases"]:
        ct = bytes.fromhex(case["ciphertext_hex"])
        assert len(ct) == case["ciphertext_len"]
        assert check_framing(ct[:21], len(ct)) is None, case["name"]
        assert hashlib.sha256(ct).hexdigest() == case["ciphertext_sha256_hex"]
    for plen in (0, 1, 1023, 1024, 1025, 2048, 5000):
        b = ccb1(plen)
        assert check_framing(b[:21], len(b)) is None, plen
    b = ccb1(2048)
    assert check_framing(b[:21], len(b) + 5) == "bad_chunk_layout"  # sobra < tag
    assert check_framing(b"XXXX" + b[4:21], len(b)) == "bad_magic"
    assert check_framing(b[:4] + bytes([9]) + b[5:21], len(b)) == "bad_chunk_size"
    assert check_framing(b[:21], 30) == "too_short"


async def test_upload_download_check(srv):
    s = await srv.signup()
    case = BLOBS["cases"][0]
    data = bytes.fromhex(case["ciphertext_hex"])
    blob_id = case["blob_id"]
    r = await srv.http.post("/api/v1/blobs/check", json={"ids": [blob_id]}, headers=s.h)
    assert r.json() == {"present": [], "missing": [blob_id]}
    r = await put(srv, s, blob_id, data)
    assert r.status_code == 201
    r = await put(srv, s, blob_id, data)  # idempotente
    assert r.status_code == 200
    r = await srv.http.post("/api/v1/blobs/check", json={"ids": [blob_id, bid()]}, headers=s.h)
    assert r.json()["present"] == [blob_id]
    r = await srv.http.get(f"/api/v1/blobs/{blob_id}", headers=s.h)
    assert r.status_code == 200 and r.content == data
    assert r.headers["x-content-sha256"] == case["ciphertext_sha256_hex"]
    assert r.headers["content-type"] == "application/octet-stream"
    # Range (retomada do download)
    r = await srv.http.get(f"/api/v1/blobs/{blob_id}", headers={**s.h, "Range": "bytes=100-199"})
    assert r.status_code == 206 and r.content == data[100:200]
    # isolamento entre usuários
    other = await srv.signup()
    assert (await srv.http.get(f"/api/v1/blobs/{blob_id}", headers=other.h)).status_code == 404
    acc = (await srv.http.get("/api/v1/account", headers=s.h)).json()
    assert acc["usage"]["blobs"] == 1 and acc["usage"]["blob_bytes"] == len(data)


async def test_upload_integrity_errors(srv):
    s = await srv.signup()
    data = ccb1(3000)
    r = await put(srv, s, bid(), data, sha="0" * 64)
    assert r.status_code == 400 and r.json()["error"]["details"]["reason"] == "sha256_mismatch"
    bad = b"NOPE" + data[4:]
    r = await put(srv, s, bid(), bad)
    assert r.status_code == 400 and r.json()["error"]["details"]["framing"] == "bad_magic"
    r = await put(srv, s, bid(), ccb1(2048) + b"x" * 5)  # sobra de 5 bytes depois de chunks cheios
    assert r.status_code == 400 and r.json()["error"]["details"]["reason"] == "bad_framing"
    r = await srv.http.put(f"/api/v1/blobs/{bid()}", content=data, headers=s.h)
    assert r.status_code == 400  # sem X-Content-SHA256
    r = await put(srv, s, "../../etc/passwd", data)
    assert r.status_code in (400, 404)
    r = await put(srv, s, "A" * 64, data)
    assert r.status_code == 400
    # nada ficou no disco
    root = srv.ctx.blobs.user_dir(s.user_id)
    assert not root.exists() or not [p for p in root.rglob("*") if p.is_file()]


async def test_interrupted_upload_leaves_nothing_and_retry_works(srv):
    s = await srv.signup()
    data = ccb1(200_000, 14)
    blob_id = bid()
    u = urlsplit(srv.base)
    reader, writer = await asyncio.open_connection(u.hostname, u.port)
    head = (
        f"PUT /api/v1/blobs/{blob_id} HTTP/1.1\r\nHost: {u.netloc}\r\nAuthorization: Bearer {s.access}\r\n"
        f"X-Content-SHA256: {hashlib.sha256(data).hexdigest()}\r\nContent-Type: application/octet-stream\r\n"
        f"Content-Length: {len(data)}\r\n\r\n"
    ).encode()
    writer.write(head + data[:50_000])
    await writer.drain()
    await asyncio.sleep(0.2)
    writer.close()
    await asyncio.sleep(0.3)
    root = srv.ctx.blobs.user_dir(s.user_id)
    assert not root.exists() or not [p for p in root.rglob("*") if p.is_file()]
    async with srv.ctx.engine.connect() as c:
        assert (await c.execute(text("SELECT count(*) FROM blobs"))).scalar() == 0
    r = await put(srv, s, blob_id, data)
    assert r.status_code == 201
    assert (await srv.http.get(f"/api/v1/blobs/{blob_id}", headers=s.h)).content == data


async def test_blob_quota(srv):
    s = await srv.signup()
    async with srv.ctx.engine.begin() as c:
        await c.execute(text("UPDATE users SET quota_blob_bytes = 5000 WHERE id = :u"), {"u": s.user_id})
    assert (await put(srv, s, bid(), ccb1(3000))).status_code == 201
    r = await put(srv, s, bid(), ccb1(3000))
    assert r.status_code == 413 and r.json()["error"]["details"]["kind"] == "blob_bytes"


async def test_push_requires_blobs_and_gc(srv):
    s = await srv.signup()
    b1, b2 = bid(), bid()
    r = await srv.push(s, [chat("c1"), msg("m1", "c1", blobs=[b1])], chat_bases={"c1": 0})
    assert r.status_code == 409 and r.json()["error"] == {
        "code": "blob_missing",
        "message": r.json()["error"]["message"],
        "details": {"missing": [b1]},
    }
    await put(srv, s, b1, ccb1(100))
    await put(srv, s, b2, ccb1(100))  # nunca referenciado
    r = await srv.push(s, [chat("c1"), msg("m1", "c1", blobs=[b1])], chat_bases={"c1": 0})
    assert r.status_code == 200
    ch = r.json()
    assert ch["chat_heads"] == {"c1": 2}
    feed = (await srv.http.get("/api/v1/sync/changes?since=0", headers=s.h)).json()["changes"]
    assert feed[1]["blobs"] == [b1]
    async with srv.ctx.engine.begin() as c:
        await c.execute(
            text(
                "UPDATE blobs SET unreferenced_since = now() - interval '25 hours' WHERE unreferenced_since IS NOT NULL"
            )
        )
    out = await run_gc(srv.ctx)
    assert out["blobs"] == 1
    assert (await srv.http.get(f"/api/v1/blobs/{b1}", headers=s.h)).status_code == 200
    assert (await srv.http.get(f"/api/v1/blobs/{b2}", headers=s.h)).status_code == 404
    # o arquivo do órfão sai do disco junto (unlink numa thread, fora do event loop)
    assert not srv.ctx.blobs.path(s.user_id, b2).exists()
    assert srv.ctx.blobs.path(s.user_id, b1).exists()
    # apagar o chat solta a referência; depois da tolerância o blob vai embora
    r = await srv.push(s, [chat("c1", base_rev=1, deleted=True)])
    assert r.status_code == 200
    async with srv.ctx.engine.begin() as c:
        await c.execute(
            text(
                "UPDATE blobs SET unreferenced_since = now() - interval '25 hours' WHERE unreferenced_since IS NOT NULL"
            )
        )
    assert (await run_gc(srv.ctx))["blobs"] == 1
    acc = (await srv.http.get("/api/v1/account", headers=s.h)).json()
    assert acc["usage"]["blobs"] == 0 and acc["usage"]["blob_bytes"] == 0
    assert not srv.ctx.blobs.path(s.user_id, b1).exists()
