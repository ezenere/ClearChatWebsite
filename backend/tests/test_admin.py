"""Painel admin: Host/token/CSRF/limite de login, usuários e armazenamento, cotas, ban (fecha WebSockets via
NOTIFY), apagar conta, convites, configurações da instância refletidas no /api/info."""

from __future__ import annotations

import asyncio
import hashlib
import random
import re
import secrets

import httpx
import pytest
from clearchat_admin.main import create_admin_app
from conftest import chat, item, make_settings
from sqlalchemy import text

from clearchat_server.mail import Mailer

TOKEN = "admin-token-0123456789-0123456789-abcdef"


class Admin:
    def __init__(self, app, base="http://localhost:8190"):
        self.app = app
        self.client = httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url=base, follow_redirects=False)
        self.csrf = ""

    async def login(self, token=TOKEN):
        r = await self.client.post("/login", data={"token": token})
        if r.status_code == 303:
            page = (await self.client.get("/")).text
            self.csrf = re.search(r'name="csrf" value="([^"]+)"', page).group(1)
        return r

    async def post(self, url, **data):
        return await self.client.post(url, data={"csrf": self.csrf, **data})


@pytest.fixture
async def admin(tmp_path):
    settings = make_settings(tmp_path)
    app = create_admin_app(settings, mailer=Mailer(settings))
    async with app.router.lifespan_context(app):
        a = Admin(app)
        yield a
        await a.client.aclose()


async def test_requires_token_and_localhost(tmp_path):
    with pytest.raises(SystemExit):
        create_admin_app(make_settings(tmp_path, admin_token="short"))
    app = create_admin_app(make_settings(tmp_path))
    async with app.router.lifespan_context(app):
        evil = httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://evil.example:8190")
        assert (await evil.get("/login")).status_code == 403
        local = httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://127.0.0.1:8190")
        assert (await local.get("/login")).status_code == 200
        assert (await local.get("/")).status_code == 303  # sem sessão → login


async def test_login_rate_limit_and_csrf(admin):
    for _ in range(5):
        r = await admin.login("wrong-token")
        assert r.status_code == 401
    r = await admin.login()
    assert r.status_code == 429
    async with admin.app.state.engine.begin() as c:
        await c.execute(text("DELETE FROM rate_counters"))
    r = await admin.login()
    assert r.status_code == 303
    assert "HttpOnly" in r.headers["set-cookie"] and "SameSite=strict" in r.headers["set-cookie"]
    r = await admin.client.post("/settings", data={"csrf": "bad", "instance_name": "X"})
    assert r.status_code == 403
    # cookie adulterado não vale
    admin.client.cookies.set("cc_admin", "garbage")
    assert (await admin.client.get("/")).status_code == 303


async def test_users_storage_quota_ban_delete(make_server, admin):
    srv = await make_server(notify_listener_enabled=True)
    s = await srv.signup("adm@example.com", name="Ana")
    await srv.push(s, [chat("c1"), item("provider", "p1"), item("provider", "p2")])
    data = b"CCB1" + bytes([10]) + secrets.token_bytes(16) + secrets.token_bytes(116)
    bid = secrets.token_hex(32)
    r = await srv.http.put(
        f"/api/v1/blobs/{bid}", content=data, headers={**s.h, "X-Content-SHA256": hashlib.sha256(data).hexdigest()}
    )
    assert r.status_code == 201
    await admin.login()
    page = (await admin.client.get("/users?q=adm")).text
    assert "adm@example.com" in page
    page = (await admin.client.get(f"/users/{s.user_id}")).text
    assert "provider" in page and "chat" in page and "137 B" in page
    dash = (await admin.client.get("/")).text
    assert "signup" in dash

    # cotas: aplicadas pela api
    r = await admin.post(
        f"/users/{s.user_id}/quotas", quota_records="3", quota_record_bytes="", quota_blob_bytes="", quota_devices=""
    )
    assert r.status_code == 303
    r = await srv.push(s, [item("provider", "p3")])
    assert r.status_code == 413 and r.json()["error"]["details"]["kind"] == "records"
    r = await admin.post(f"/users/{s.user_id}/quotas", quota_records="-1")
    assert r.status_code == 400

    # banir: fecha o WebSocket (4403) via NOTIFY e login não envia código
    await asyncio.sleep(0.3)  # LISTEN pronto
    c, _ = await srv.ws(s)
    r = await admin.post(f"/users/{s.user_id}/ban", reason="spam")
    assert r.status_code == 303
    assert await c.wait_closed(5) == 4403
    assert (await srv.http.get("/api/v1/account", headers=s.h)).status_code in (401, 403)
    srv.mailer.outbox.clear()
    await srv.http.post("/api/v1/auth/code/request", json={"email": "adm@example.com"})
    await srv.flush_mail()
    assert srv.mails("adm@example.com") == []
    r = await admin.post(f"/users/{s.user_id}/unban")
    assert r.status_code == 303
    s2 = await srv.login("adm@example.com")

    # apagar exige o e-mail exato; remove blobs do disco
    r = await admin.post(f"/users/{s.user_id}/delete", confirm_email="wrong@example.com")
    assert r.status_code == 400
    assert srv.ctx.blobs.path(s.user_id, bid).exists()
    c2, _ = await srv.ws(s2)
    r = await admin.post(f"/users/{s.user_id}/delete", confirm_email="ADM@example.com")
    assert r.status_code == 303
    assert (await c2.event("account.deleted", timeout=5)) == {"t": "account.deleted"}
    assert await c2.wait_closed(5) == 4403
    assert not srv.ctx.blobs.user_dir(s.user_id).exists()
    async with srv.ctx.engine.connect() as conn:
        assert (await conn.execute(text("SELECT count(*) FROM records"))).scalar() == 0


async def test_create_user_invites_and_settings(make_server, admin):
    srv = await make_server(notify_listener_enabled=True, instance_settings_cache_s=60)
    await admin.login()
    r = await admin.post("/users/new", email="New@Example.com", name="Novo", send_welcome="1")
    assert r.status_code == 303
    assert admin.app.state.mailer.outbox[-1].kind == "welcome"
    s = await srv.login("new@example.com")
    assert s.body["keys_ready"] is False
    r = await admin.post("/users/new", email="new@example.com", name="Dup")
    assert r.status_code == 400

    # configurações: cadastro fechado + landing off + nome; a api invalida o cache via NOTIFY
    assert (await srv.http.get("/api/info")).json()["features"]["signupOpen"] is True
    await asyncio.sleep(0.3)
    r = await admin.post("/settings", instance_name="Minha Instância", landing_enabled="")
    assert r.status_code == 303
    await asyncio.sleep(0.5)
    info = (await srv.http.get("/api/info")).json()
    assert info["name"] == "Minha Instância"
    assert info["features"]["signupOpen"] is False and info["features"]["landing"] is False
    assert info["features"]["captcha"] is None and "signup" not in info["links"]
    r = await srv.http.post("/api/v1/auth/signup/start", json={"email": "z@example.com", "name": "Z"})
    assert r.json()["error"]["code"] == "signup_closed"

    # convites
    r = await admin.post("/invites", email="inv@example.com", note="amigo", days="3", send_email="1")
    assert r.status_code == 200
    link = re.search(r'<code id="invite-link">([^<]+)</code>', r.text).group(1)
    token = link.split("invite=")[1]
    assert link.startswith("http://clear.test/signup?invite=")
    assert admin.app.state.mailer.outbox[-1].kind == "invite"
    assert (await srv.http.get(f"/api/v1/auth/invite/{token}")).json() == {"valid": True, "email": "inv@example.com"}
    page = (await admin.client.get("/invites")).text
    invite_id = re.search(r"/invites/([0-9a-f-]{36})/revoke", page).group(1)
    r = await admin.post(f"/invites/{invite_id}/revoke")
    assert r.status_code == 303
    assert (await srv.http.get(f"/api/v1/auth/invite/{token}")).json() == {"valid": False}


# consulta antiga da visão geral (subconsultas por dia): a nova DEVE devolver exatamente o mesmo
OLD_DASHBOARD_DAYS_SQL = (
    "WITH d AS (SELECT generate_series(current_date - 13, current_date, interval '1 day')::date AS day) "
    "SELECT d.day, "
    "(SELECT count(*) FROM activity a WHERE a.kind = 'login' AND a.at::date = d.day) AS logins, "
    "(SELECT count(*) FROM activity a WHERE a.kind = 'signup' AND a.at::date = d.day) AS signups, "
    "(SELECT count(*) FROM activity a WHERE a.kind IN ('login_failed', 'refresh_reused') "
    "  AND a.at::date = d.day) AS failures, "
    "(SELECT COALESCE(sum(pushes), 0) FROM usage_daily u WHERE u.day = d.day) AS pushes, "
    "(SELECT COALESCE(sum(blob_uploads), 0) FROM usage_daily u WHERE u.day = d.day) AS uploads, "
    "(SELECT count(DISTINCT user_id) FROM usage_daily u WHERE u.day = d.day) AS active "
    "FROM d ORDER BY d.day DESC"
)


async def test_dashboard_days_query_unchanged(make_server, admin):
    from clearchat_admin.main import DASHBOARD_DAYS_SQL

    srv = await make_server()
    users = [(await srv.signup()).user_id for _ in range(3)]
    kinds = ["login", "signup", "login_failed", "refresh_reused", "logout", "password_changed", "keys_setup"]
    rnd = random.Random(7)
    async with admin.app.state.engine.begin() as c:
        for _ in range(400):
            # de 20 dias atrás a 2 dias no futuro, com horários perto da meia-noite também
            at_sql = "date_trunc('day', now()) - make_interval(days => :d) + make_interval(secs => :s)"
            await c.execute(
                text(f"INSERT INTO activity (user_id, kind, at) VALUES (:u, :k, {at_sql})"),
                {
                    "u": rnd.choice([*users, None]),
                    "k": rnd.choice(kinds),
                    "d": rnd.randint(-2, 20),
                    "s": rnd.choice([0, 1, 43200, 86399, rnd.uniform(0, 86400)]),
                },
            )
        for u in users:
            for d in range(-1, 18):
                if rnd.random() < 0.6:
                    await c.execute(
                        text(
                            "INSERT INTO usage_daily (user_id, day, pushes, blob_uploads) "
                            "VALUES (:u, current_date - CAST(:d AS integer), :p, :b) "
                            "ON CONFLICT (user_id, day) DO UPDATE SET pushes = EXCLUDED.pushes"
                        ),
                        {"u": u, "d": d, "p": rnd.randint(0, 50), "b": rnd.randint(0, 5)},
                    )
    async with admin.app.state.engine.connect() as c:
        for tz in ("UTC", "America/Sao_Paulo", "Asia/Tokyo"):
            await c.execute(text(f"SET TIME ZONE '{tz}'"))
            old = [tuple(r) for r in (await c.execute(text(OLD_DASHBOARD_DAYS_SQL))).all()]
            new = [tuple(r) for r in (await c.execute(text(DASHBOARD_DAYS_SQL))).all()]
            assert len(new) == 14 and new == old, tz
            assert sum(r[1] + r[2] + r[3] for r in new) > 0
        await c.rollback()
    await admin.login()
    r = await admin.client.get("/")
    assert r.status_code == 200


async def test_admin_cookie_secure_only_over_https(tmp_path):
    async def login_cookie(settings, base):
        app = create_admin_app(settings, mailer=Mailer(settings))
        async with app.router.lifespan_context(app):
            async with app.state.engine.begin() as c:
                await c.execute(text("DELETE FROM rate_counters"))
            client = httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url=base)
            r = await client.post("/login", data={"token": TOKEN})
            await client.aclose()
            assert r.status_code == 303
            return r.headers["set-cookie"]

    # http (túnel SSH / rede local): sem Secure, senão o navegador descartaria o cookie
    assert "secure" not in (await login_cookie(make_settings(tmp_path), "http://localhost:8190")).lower()
    # atrás de um proxy TLS (ADMIN_HTTPS=true) ou com TLS direto: Secure
    assert "secure" in (await login_cookie(make_settings(tmp_path, admin_https=True), "http://localhost:8190")).lower()
    assert "secure" in (await login_cookie(make_settings(tmp_path), "https://localhost:8190")).lower()
