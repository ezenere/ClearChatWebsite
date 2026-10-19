"""Cascata + re-escopo no mesmo push não desconta o filho duas vezes; recontagem dos contadores de uso
(`recompute-usage`) conserta deriva antiga; disco dos blobs fora do event loop (correções da auditoria)."""

from __future__ import annotations

import asyncio
import hashlib
import os
import shutil
import time
import uuid
from pathlib import Path
from typing import Any

from conftest import env, item, make_settings
from sqlalchemy import text
from test_blobs import bid, ccb1, put

from clearchat_server import cli
from clearchat_server.sync.blobs import BlobStore
from clearchat_server.sync.usage import recompute_all


async def usage_vs_actual(srv: Any, user_id: str) -> tuple[tuple[int, int], tuple[int, int]]:
    async with srv.ctx.engine.connect() as c:
        u = (
            await c.execute(text("SELECT usage_records, usage_record_bytes FROM users WHERE id = :u"), {"u": user_id})
        ).one()
        a = (
            await c.execute(
                text("SELECT count(*), COALESCE(sum(size), 0) FROM records WHERE user_id = :u AND NOT deleted"),
                {"u": user_id},
            )
        ).one()
    return (int(u[0]), int(u[1])), (int(a[0]), int(a[1]))


async def test_rescoped_child_with_parent_delete_keeps_counters_exact(srv):
    s = await srv.signup()
    blob = ccb1(100)
    b = bid()
    assert (await put(srv, s, b, blob)).status_code == 201
    r = await srv.push(
        s,
        [
            item("memory_collection", "c0", env=env(40)),
            item("memory", "m", "c0", env=env(2000), blobs=[b]),
            item("memory", "stay", "c0", env=env(300)),
        ],
    )
    assert r.status_code == 200, r.text
    used, actual = await usage_vs_actual(srv, s.user_id)
    assert used == actual == (3, 2340)
    m_rev = 1
    for i in range(1, 5):
        prev, cur = f"c{i - 1}", f"c{i}"
        assert (await srv.push(s, [item("memory_collection", cur, env=env(40))])).status_code == 200
        r = await srv.push(
            s,
            [
                item("memory_collection", prev, base_rev=1, deleted=True),
                item("memory", "m", cur, base_rev=m_rev, env=env(2000), blobs=[b]),
            ],
        )
        assert r.status_code == 200, r.text
        m_rev += 1
        used, actual = await usage_vs_actual(srv, s.user_id)
        assert used == actual, (i, used, actual)
    # "stay" saiu na cascata do c0; m continua vivo, no c4, com a referência ao blob
    assert actual == (2, 2040)
    async with srv.ctx.engine.connect() as c:
        row = (
            await c.execute(text("SELECT scope_id, rev, deleted FROM records WHERE type = 'memory' AND id = 'm'"))
        ).one()
        stay = (await c.execute(text("SELECT count(*) FROM records WHERE id = 'stay'"))).scalar()
        refs = (await c.execute(text("SELECT count(*) FROM record_blobs WHERE record_id = 'm'"))).scalar()
        unref = (await c.execute(text("SELECT unreferenced_since FROM blobs WHERE blob_id = :b"), {"b": b})).scalar()
    assert tuple(row) == ("c4", 5, False) and stay == 0 and refs == 1 and unref is None
    # a cota continua valendo: 2 vivos + 2 novos > 3
    async with srv.ctx.engine.begin() as c:
        await c.execute(text("UPDATE users SET quota_records = 3 WHERE id = :u"), {"u": s.user_id})
    r = await srv.push(s, [item("provider", "a"), item("provider", "b")])
    assert r.status_code == 413 and r.json()["error"]["details"] == {"kind": "records", "used": 2, "limit": 3}


async def test_recompute_usage_repairs_drift(srv):
    s = await srv.signup()
    s2 = await srv.signup()
    await srv.push(s, [item("provider", "a", env=env(100)), item("provider", "b", env=env(50))])
    await srv.push(s, [item("provider", "b", base_rev=1, deleted=True)])
    data = ccb1(10)
    assert (await put(srv, s, bid(), data)).status_code == 201
    async with srv.ctx.engine.begin() as c:
        await c.execute(
            text(
                "UPDATE users SET usage_records = 7, usage_record_bytes = 999, usage_blobs = 0, "
                "usage_blob_bytes = 3 WHERE id = :u"
            ),
            {"u": s.user_id},
        )
    out = await recompute_all(srv.ctx.engine)
    assert out["fixed"] == 1 and out["checked"] == 2
    assert out["changes"][s.user_id] == {
        "usage_records": (7, 1),
        "usage_record_bytes": (999, 100),
        "usage_blobs": (0, 1),
        "usage_blob_bytes": (3, len(data)),
    }
    used, actual = await usage_vs_actual(srv, s.user_id)
    assert used == actual == (1, 100)
    # idempotente; um usuário só
    assert (await recompute_all(srv.ctx.engine, uuid.UUID(s2.user_id)))["fixed"] == 0
    assert (await recompute_all(srv.ctx.engine))["fixed"] == 0


def test_recompute_usage_cli(tmp_path: Path, monkeypatch, capsys):
    """`python -m clearchat_server recompute-usage` (Settings dos testes, nunca o .env real)."""
    from clearchat_server.db import make_engine
    from clearchat_server.services.accounts import create_user

    settings = make_settings(tmp_path)
    monkeypatch.setattr(cli, "Settings", lambda: settings)

    async def seed() -> str:
        engine = make_engine(settings.database_url, 2)
        try:
            async with engine.begin() as c:
                uid = await create_user(c, f"cli{uuid.uuid4().hex[:8]}@example.com", "Cli", settings)
                await c.execute(
                    text(
                        "INSERT INTO records (user_id, type, id, rev, seq, size) VALUES (:u, 'provider', 'p', 1, 1, 77)"
                    ),
                    {"u": uid},
                )
                await c.execute(text("UPDATE users SET usage_records = 5 WHERE id = :u"), {"u": uid})
            return str(uid)
        finally:
            await engine.dispose()

    uid = asyncio.run(seed())
    cli.main(["recompute-usage", "--user", uid])
    out = capsys.readouterr().out
    assert f"{uid} usage_records: 5 → 1 usage_record_bytes: 0 → 77" in out
    assert "1 usuário(s) conferido(s), 1 corrigido(s)" in out


async def test_remove_user_is_immediate_and_rmtree_runs_off_loop(tmp_path: Path, monkeypatch):
    store = BlobStore(make_settings(tmp_path))
    uid = uuid.uuid4()
    d = store.user_dir(uid)
    for i in range(50):
        p = d / f"{i:02x}" / f"f{i}"
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_bytes(b"x")
    on_loop: list[bool] = []
    real = shutil.rmtree

    def spy(path: Any, *a: Any, **kw: Any) -> None:
        try:
            asyncio.get_running_loop()
            on_loop.append(True)
        except RuntimeError:
            on_loop.append(False)
        real(path, *a, **kw)

    monkeypatch.setattr(shutil, "rmtree", spy)
    store.remove_user(uid)
    assert not d.exists()  # a pasta sai do caminho na hora (rename)
    await store.drain()
    assert on_loop == [False]  # o rmtree rodou numa thread, não no event loop
    assert not list(store.root.glob(".trash-*"))
    store.remove_user(uuid.uuid4())  # pasta inexistente: nada a fazer


async def test_startup_sweep_removes_only_stale_tmp(tmp_path: Path):
    settings = make_settings(tmp_path)
    root = Path(settings.blob_storage_dir)
    sub = root / str(uuid.uuid4()) / "ab"
    sub.mkdir(parents=True)
    old_tmp = sub / f"{'ab' * 32}.tmp-{uuid.uuid4().hex}"
    new_tmp = sub / f"{'ab' * 32}.tmp-{uuid.uuid4().hex}"
    blob = sub / ("ab" * 32)
    for p in (old_tmp, new_tmp, blob):
        p.write_bytes(b"x")
    past = time.time() - 2 * 3600
    os.utime(old_tmp, (past, past))
    os.utime(blob, (past, past))
    trash = root / f".trash-{uuid.uuid4().hex}" / "x"
    trash.mkdir(parents=True)
    store = BlobStore(settings)  # varredura em segundo plano na subida
    await store.drain()
    assert not old_tmp.exists() and new_tmp.exists() and blob.exists()
    assert not trash.parent.exists()
    assert hashlib.sha256(blob.read_bytes()).hexdigest()  # blob intacto


async def test_usage_decrement_clamps_at_zero_with_old_drift(srv):
    """Deriva antiga para baixo + CHECK (>= 0) da 0002: o push não pode virar 500; o contador para em 0."""
    s = await srv.signup()
    await srv.push(s, [item("provider", "a", env=env(100))])
    async with srv.ctx.engine.begin() as c:
        await c.execute(
            text("UPDATE users SET usage_records = 0, usage_record_bytes = 0 WHERE id = :u"), {"u": s.user_id}
        )
        has_check = (
            await c.execute(text("SELECT count(*) FROM pg_constraint WHERE conname LIKE 'users_usage_%_nonneg'"))
        ).scalar()
    assert has_check == 4  # banco dos testes migrado até a head (0002)
    r = await srv.push(s, [item("provider", "a", base_rev=1, deleted=True)])
    assert r.status_code == 200, r.text
    used, actual = await usage_vs_actual(srv, s.user_id)
    assert used == actual == (0, 0)
