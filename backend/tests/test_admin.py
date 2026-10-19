"""Painel admin: Host/token/CSRF/limite de login, usuários e armazenamento, cotas, ban (fecha WebSockets via
NOTIFY), apagar conta, convites, configurações da instância refletidas no /api/info."""

from __future__ import annotations

import asyncio
import hashlib
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
