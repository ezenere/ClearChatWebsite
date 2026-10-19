"""Painel admin — apresentação: formatação pt-BR, cotas em MB/GB, CSP estrita, estáticos, todas as páginas
renderizando e desconectar um dispositivo só. Rode a partir de backend/: `pytest -c pyproject.toml ../admin/tests`
(usa o mesmo TEST_DATABASE_URL dos testes do backend; o banco é migrado aqui se preciso)."""

from __future__ import annotations

import os
import re
import uuid
from datetime import UTC, datetime, timedelta
from types import SimpleNamespace

import httpx
import pytest
from clearchat_admin import ui
from clearchat_admin.main import CSP, create_admin_app
from sqlalchemy import text

from clearchat_server.config import Settings
from clearchat_server.db import migrate
from clearchat_server.mail import Mailer

TEST_DB = os.environ.get("TEST_DATABASE_URL", "postgresql+asyncpg://postgres@127.0.0.1:55432/clearchat_test")
TOKEN = "admin-token-0123456789-0123456789-abcdef"


# ------------------------------------------------------------------ unidades puras
def test_number_and_size_formatting():
    assert ui.num(1234567) == "1.234.567"
    assert ui.num(1.5, 1) == "1,5"
    assert ui.human(137) == "137 B"
    assert ui.human(1536) == "1,5 KB"
    assert ui.human(250 * 1024**2) == "250 MB"
    assert ui.human(None) == "—"


def test_relative_dates():
    now = datetime(2026, 10, 19, 12, 0, tzinfo=UTC)
    assert ui.relative(now - timedelta(seconds=20), now) == "agora"
    assert ui.relative(now - timedelta(minutes=5), now) == "há 5 min"
    assert ui.relative(now - timedelta(hours=1), now) == "há 1 h"
    assert ui.relative(now - timedelta(days=3), now) == "há 3 dias"
    assert ui.relative(now + timedelta(days=2), now) == "em 2 dias"
    assert ui.relative(None) == "nunca"
    assert 'datetime="' in ui.ago(now) and "title=" in ui.ago(now)


def test_quota_parse_and_split():
    assert ui.parse_quota("") is None
    assert ui.parse_quota("  ") is None
    assert ui.parse_quota("3") == 3
    assert ui.parse_quota("64", "MB") == 64 * 1024**2
    assert ui.parse_quota("1,5", "GB") == int(1.5 * 1024**3)
    for bad in ("-1", "abc", "1e9", "1.2.3"):
        with pytest.raises(ValueError):
            ui.parse_quota(bad, "MB")
    with pytest.raises(ValueError):
        ui.parse_quota("1", "PB")
    assert ui.quota_split(None) == ("", "GB")
    assert ui.quota_split(5 * 1024**3) == ("5", "GB")
    assert ui.quota_split(200 * 1024**2) == ("200", "MB")
    assert ui.quota_split(1536 * 1024) == ("1,5", "MB")
    assert ui.quota_split(int(1.5 * 1024**3)) == ("1,5", "GB")
    assert ui.quota_split(1000 * 1024 + 1) == (str(1000 * 1024 + 1), "B")
    assert ui.quota_split(100) == ("100", "B")


def test_quota_status():
    def user(**kw):
        base = dict(
            usage_records=0, quota_records=None, usage_record_bytes=0, quota_record_bytes=None,
            usage_blob_bytes=0, quota_blob_bytes=None, quota_devices=None,
        )  # fmt: skip
        return SimpleNamespace(**{**base, **kw})

    assert ui.quota_status(user(), 2)["tone"] == "none"
    assert ui.quota_status(user(usage_records=10, quota_records=100), 0)["tone"] == "ok"
    assert ui.quota_status(user(usage_records=85, quota_records=100), 0)["tone"] == "warning"
    assert ui.quota_status(user(usage_records=100, quota_records=100), 0)["tone"] == "danger"
    assert ui.quota_status(user(quota_devices=2), 3)["tone"] == "danger"
    assert ui.quota_status(user(usage_blob_bytes=1, quota_blob_bytes=0), 0)["tone"] == "danger"


def test_bar_width_and_initials():
    assert ui.bar_width(0, 10) == "0%"
    assert ui.bar_width(1, 1000) == "1.50%"  # mínimo visível
    assert ui.bar_width(5, 10) == "50.00%"
    assert ui.bar_width(5, 0) == "0%"
    assert ui.initials("Ana Maria Souza") == "AS"
    assert ui.initials("", "z@x.com") == "Z"


# ------------------------------------------------------------------ app (Postgres)
@pytest.fixture(scope="module")
def _db() -> None:
    try:
        migrate(TEST_DB)
    except OSError as e:  # pragma: no cover
        pytest.skip(f"Postgres de teste indisponível: {e}")


@pytest.fixture
async def admin(tmp_path, _db):
    settings = Settings(
        _env_file=None,  # type: ignore[call-arg]
        public_base_url="http://clear.test",
        server_secret="test-server-secret-0123456789abcdefghij",
        admin_token=TOKEN,
        database_url=TEST_DB,
        mail_backend="memory",
        blob_storage_dir=str(tmp_path / "blobs"),
        jobs_enabled=False,
        notify_listener_enabled=False,
        log_level="warning",
    )
    app = create_admin_app(settings, mailer=Mailer(settings))
    async with app.router.lifespan_context(app):
        async with app.state.engine.begin() as c:
            await c.execute(text("TRUNCATE users, invites, rate_counters, activity RESTART IDENTITY CASCADE"))
        client = httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://localhost:8190")
        r = await client.post("/login", data={"token": TOKEN})
        assert r.status_code == 303
        page = (await client.get("/")).text
        m = re.search(r'name="csrf" value="([^"]+)"', page)
        assert m is not None
        client.csrf = m.group(1)  # type: ignore[attr-defined]
        yield app, client
        await client.aclose()


async def _seed(app):
    uid = uuid.uuid4()
    async with app.state.engine.begin() as c:
        await c.execute(
            text(
                "INSERT INTO users (id, email, name, keys_ready, usage_records, usage_record_bytes) "
                "VALUES (:u, 'ui@example.com', 'Ana UI', true, 2, 2048)"
            ),
            {"u": uid},
        )
        await c.execute(
            text(
                "INSERT INTO records (user_id, type, id, rev, seq, size) VALUES (:u, 'chat', 'c1', 1, 1, 1024), (:u, 'message', 'm1', 1, 2, 1024)"
            ),
            {"u": uid},
        )
        ids = []
        for name in ("PC de casa", "Celular"):
            d = (
                await c.execute(
                    text(
                        "INSERT INTO devices (user_id, name, platform, client, app_version, last_seen_at) "
                        "VALUES (:u, :n, 'Linux', 'desktop', '0.6.0', now()) RETURNING id"
                    ),
                    {"u": uid, "n": name},
                )
            ).scalar_one()
            ids.append(d)
        await c.execute(
            text("INSERT INTO invites (token_hash, email, expires_at) VALUES (:h, NULL, now() + interval '3 days')"),
            {"h": uuid.uuid4().bytes * 2},
        )
    return uid, ids


async def test_csp_static_and_pages(admin):
    app, client = admin
    uid, _ = await _seed(app)
    r = await client.get("/login")
    assert r.headers["content-security-policy"] == CSP
    assert "'unsafe-inline'" not in CSP and "http" not in CSP
    assert r.headers["x-frame-options"] == "DENY" and r.headers["cache-control"] == "no-store"
    for path, kind in (
        ("/static/admin.css", "text/css"),
        ("/static/admin.js", "javascript"),
        ("/static/inter-latin-wght.woff2", "font/woff2"),
    ):
        s = await client.get(path)
        assert s.status_code == 200 and kind in s.headers["content-type"]
        assert "no-store" not in s.headers.get("cache-control", "")
    for path in ("/", "/users", "/users?q=ana", f"/users/{uid}", "/users/new", "/invites", "/settings"):
        page = await client.get(path)
        assert page.status_code == 200, path
        html = page.text
        # nada inline que a CSP bloquearia
        assert "<style" not in html and " style=" not in html and "javascript:" not in html, path
        assert not re.search(r"<script(?![^>]*\bsrc=)", html), path
        assert re.search(r"\son[a-z]+=\"", html) is None, path
    detail = (await client.get(f"/users/{uid}")).text
    assert "Ana UI" in detail and "ui@example.com" in detail and "2,0 KB" in detail
    assert (await client.get("/users/nao-existe")).status_code == 404


async def test_quota_units_and_single_device_revoke(admin):
    app, client = admin
    uid, (d1, d2) = await _seed(app)
    r = await client.post(
        f"/users/{uid}/quotas",
        data={
            "csrf": client.csrf,
            "quota_record_bytes": "1,5",
            "quota_record_bytes_unit": "GB",
            "quota_blob_bytes": "200",
            "quota_blob_bytes_unit": "MB",
            "quota_records": "",
            "quota_devices": "3",
        },
    )
    assert r.status_code == 303
    async with app.state.engine.connect() as c:
        row = (await c.execute(text("SELECT * FROM users WHERE id = :u"), {"u": uid})).one()
    assert row.quota_record_bytes == int(1.5 * 1024**3) and row.quota_blob_bytes == 200 * 1024**2
    assert row.quota_records is None and row.quota_devices == 3
    page = (await client.get(f"/users/{uid}")).text
    assert 'value="200"' in page and 'value="1,5"' in page

    r = await client.post(
        f"/users/{uid}/quotas", data={"csrf": client.csrf, "quota_blob_bytes": "x", "quota_blob_bytes_unit": "MB"}
    )
    assert r.status_code == 400
    r = await client.post(f"/users/{uid}/devices/{d1}/revoke", data={"csrf": "errado"})
    assert r.status_code == 403
    r = await client.post(f"/users/{uid}/devices/{d1}/revoke", data={"csrf": client.csrf})
    assert r.status_code == 303
    async with app.state.engine.connect() as c:
        rows = (await c.execute(text("SELECT id, revoked_at FROM devices WHERE user_id = :u"), {"u": uid})).all()
    revoked = {r.id: r.revoked_at is not None for r in rows}
    assert revoked == {d1: True, d2: False}
