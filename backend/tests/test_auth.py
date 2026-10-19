"""Cadastro/login por código, tentativas, expiração, limites, bloqueio, não-enumeração, Turnstile, convites."""

from __future__ import annotations

import ipaddress
from datetime import timedelta
from types import SimpleNamespace

import httpx
from conftest import SECRET, rand_ip
from sqlalchemy import text

from clearchat_server.util import client_ip


def ipk():
    return {"X-Real-IP": rand_ip()}


async def test_login_code_flow_and_single_use(srv):
    s = await srv.signup("ana@example.com")
    r = await srv.http.post("/api/v1/auth/code/request", json={"email": "  ANA@example.com "}, headers=ipk())
    assert r.status_code == 202 and r.json() == {"ok": True}
    await srv.flush_mail()
    code = srv.last_code("ana@example.com", "login")
    dev = srv.device()
    r = await srv.http.post(
        "/api/v1/auth/code/verify", json={"email": "ana@example.com", "code": code, "device": dev}, headers=ipk()
    )
    assert r.status_code == 200
    b = r.json()
    assert (
        b["user"]["id"] == s.user_id and b["access_token"].startswith("cca_") and b["refresh_token"].startswith("ccr_")
    )
    assert b["device_id"] != s.device_id
    # uso único
    r = await srv.http.post(
        "/api/v1/auth/code/verify", json={"email": "ana@example.com", "code": code, "device": dev}, headers=ipk()
    )
    assert r.status_code == 400 and r.json()["error"]["code"] == "code_invalid"


async def test_new_code_invalidates_previous(srv):
    await srv.signup("b@example.com")
    for _ in range(2):
        await srv.http.post("/api/v1/auth/code/request", json={"email": "b@example.com"}, headers=ipk())
        await srv.flush_mail()
    codes = [m.meta["code"] for m in srv.mails("b@example.com") if m.kind == "code:login"]
    assert len(codes) == 2
    if codes[0] != codes[1]:
        r = await srv.http.post(
            "/api/v1/auth/code/verify",
            json={"email": "b@example.com", "code": codes[0], "device": srv.device()},
            headers=ipk(),
        )
        assert r.json()["error"]["code"] == "code_invalid"
    r = await srv.http.post(
        "/api/v1/auth/code/verify",
        json={"email": "b@example.com", "code": codes[1], "device": srv.device()},
        headers=ipk(),
    )
    assert r.status_code == 200


async def test_max_attempts_burns_code(srv):
    await srv.signup("c@example.com")
    await srv.http.post("/api/v1/auth/code/request", json={"email": "c@example.com"}, headers=ipk())
    await srv.flush_mail()
    code = srv.last_code("c@example.com", "login")
    wrong = "000000" if code != "000000" else "111111"
    for _ in range(5):
        r = await srv.http.post(
            "/api/v1/auth/code/verify",
            json={"email": "c@example.com", "code": wrong, "device": srv.device()},
            headers=ipk(),
        )
        assert r.json()["error"]["code"] == "code_invalid"
    r = await srv.http.post(
        "/api/v1/auth/code/verify", json={"email": "c@example.com", "code": code, "device": srv.device()}, headers=ipk()
    )
    assert r.status_code == 400 and r.json()["error"]["code"] == "code_invalid"


async def test_code_expiry(srv):
    await srv.signup("d@example.com")
    await srv.http.post("/api/v1/auth/code/request", json={"email": "d@example.com"}, headers=ipk())
    await srv.flush_mail()
    code = srv.last_code("d@example.com", "login")
    async with srv.ctx.engine.begin() as c:
        await c.execute(text("UPDATE email_codes SET expires_at = now() - interval '1 second'"))
    r = await srv.http.post(
        "/api/v1/auth/code/verify", json={"email": "d@example.com", "code": code, "device": srv.device()}, headers=ipk()
    )
    assert r.json()["error"]["code"] == "code_invalid"


async def test_no_enumeration(srv):
    await srv.signup("exists@example.com")
    srv.mailer.outbox.clear()
    a = await srv.http.post("/api/v1/auth/code/request", json={"email": "exists@example.com"}, headers=ipk())
    b = await srv.http.post("/api/v1/auth/code/request", json={"email": "nobody@example.com"}, headers=ipk())
    assert (a.status_code, a.json()) == (b.status_code, b.json()) == (202, {"ok": True})
    await srv.flush_mail()
    assert srv.mails("nobody@example.com") == []
    assert len(srv.mails("exists@example.com")) == 1
    # verify com e-mail inexistente → mesmo erro
    r = await srv.http.post(
        "/api/v1/auth/code/verify",
        json={"email": "nobody@example.com", "code": "123456", "device": srv.device()},
        headers=ipk(),
    )
    assert r.status_code == 400 and r.json()["error"]["code"] == "code_invalid"
    # cadastro com e-mail existente → 202 idêntico + e-mail "você já tem conta"
    a = await srv.http.post(
        "/api/v1/auth/signup/start", json={"email": "exists@example.com", "name": "X"}, headers=ipk()
    )
    b = await srv.http.post("/api/v1/auth/signup/start", json={"email": "new@example.com", "name": "X"}, headers=ipk())
    assert (a.status_code, a.json()) == (b.status_code, b.json()) == (202, {"ok": True})
    await srv.flush_mail()
    assert srv.mails("exists@example.com")[-1].kind == "existing_account"
    assert srv.mails("new@example.com")[-1].kind == "code:signup"


async def test_banned_gets_no_code(srv):
    s = await srv.signup("ban@example.com")
    async with srv.ctx.engine.begin() as c:
        await c.execute(text("UPDATE users SET status = 'banned' WHERE id = :u"), {"u": s.user_id})
    srv.mailer.outbox.clear()
    r = await srv.http.post("/api/v1/auth/code/request", json={"email": "ban@example.com"}, headers=ipk())
    assert r.status_code == 202
    await srv.flush_mail()
    assert srv.mails("ban@example.com") == []
    r = await srv.http.get("/api/v1/account", headers=s.h)
    assert r.status_code == 403 and r.json()["error"]["code"] == "account_disabled"


async def test_rate_limit_per_email(srv):
    ip = ipk()
    codes = []
    for _ in range(6):
        r = await srv.http.post("/api/v1/auth/code/request", json={"email": "rl@example.com"}, headers=ipk())
        codes.append(r.status_code)
    assert codes[:5] == [202] * 5 and codes[5] == 429
    assert int(r.headers["Retry-After"]) > 0 and r.json()["error"]["details"]["retry_after"] > 0
    # outro e-mail, mesmo IP: ok
    r = await srv.http.post("/api/v1/auth/code/request", json={"email": "other@example.com"}, headers=ip)
    assert r.status_code == 202


async def test_rate_limit_per_ip_trusted_proxy(srv):
    ip = ipk()
    statuses = []
    for i in range(21):
        r = await srv.http.post("/api/v1/auth/code/request", json={"email": f"x{i}@example.com"}, headers=ip)
        statuses.append(r.status_code)
    assert statuses[:20] == [202] * 20 and statuses[20] == 429


async def test_verify_lockout_after_15_failures(srv):
    await srv.signup("lock@example.com")
    for _round in range(3):
        await srv.http.post("/api/v1/auth/code/request", json={"email": "lock@example.com"}, headers=ipk())
        for _ in range(5):
            r = await srv.http.post(
                "/api/v1/auth/code/verify",
                json={"email": "lock@example.com", "code": "999999x", "device": srv.device()},
                headers=ipk(),
            )
            assert r.status_code == 400
        # o limite de 10 verify/h por e-mail chegaria antes: simula a passagem do tempo
        async with srv.ctx.engine.begin() as c:
            await c.execute(text("DELETE FROM rate_counters WHERE bucket LIKE 'verify:%'"))
    # 15 falhas → bloqueado (mesmo com o código certo)
    async with srv.ctx.engine.begin() as c:
        await c.execute(text("DELETE FROM rate_counters WHERE bucket LIKE 'code_req%'"))
    await srv.http.post("/api/v1/auth/code/request", json={"email": "lock@example.com"}, headers=ipk())
    await srv.flush_mail()
    code = srv.last_code("lock@example.com", "login")
    r = await srv.http.post(
        "/api/v1/auth/code/verify",
        json={"email": "lock@example.com", "code": code, "device": srv.device()},
        headers=ipk(),
    )
    assert r.status_code == 429
    assert 3000 < int(r.headers["Retry-After"]) <= 3600


async def test_verify_rate_limit_per_email(srv):
    statuses = []
    for _ in range(11):
        r = await srv.http.post(
            "/api/v1/auth/code/verify",
            json={"email": "v@example.com", "code": "123456", "device": srv.device()},
            headers=ipk(),
        )
        statuses.append(r.status_code)
    assert statuses[:10] == [400] * 10 and statuses[10] == 429


async def test_validation_errors(srv):
    r = await srv.http.post("/api/v1/auth/code/request", json={"email": "not-an-email"})
    assert r.status_code == 400 and r.json()["error"]["code"] == "invalid_request"
    r = await srv.http.post(
        "/api/v1/auth/code/verify",
        json={"email": "a@example.com", "code": "1", "device": {**srv.device(), "client": "gateway"}},
    )
    assert r.json()["error"]["code"] == "invalid_request"  # 'gateway' reservado
    r = await srv.http.get("/api/v1/account", headers={"X-ClearChat-Protocol": "2", "Authorization": "Bearer cca_x"})
    assert r.status_code == 426 and r.json()["error"]["code"] == "protocol_unsupported"


# ---------------------------------------------------------------- Turnstile
def turnstile_stub(calls):
    def handler(request: httpx.Request) -> httpx.Response:
        form = dict(x.split("=", 1) for x in request.content.decode().split("&"))
        calls.append(form)
        tok = form.get("response", "")
        if tok == "good-login":
            return httpx.Response(200, json={"success": True, "hostname": "clear.test", "action": "login"})
        if tok == "good-signup":
            return httpx.Response(200, json={"success": True, "hostname": "clear.test", "action": "signup"})
        if tok == "wrong-host":
            return httpx.Response(200, json={"success": True, "hostname": "evil.test", "action": "login"})
        if tok == "boom":
            raise httpx.ConnectError("down")
        return httpx.Response(200, json={"success": False, "error-codes": ["invalid-input-response"]})

    return handler


async def test_turnstile_on(make_server):
    calls = []
    srv = await make_server(
        turnstile=turnstile_stub(calls), turnstile_site_key="0x4AAA-site", turnstile_secret_key="0x4AAA-secret"
    )
    info = (await srv.http.get("/api/info")).json()
    assert info["features"]["captcha"] == {"provider": "turnstile", "siteKey": "0x4AAA-site"}
    for tok in (None, "bad", "wrong-host", "good-signup", "boom"):
        body = {"email": "t@example.com"}
        if tok:
            body["turnstile_token"] = tok
        r = await srv.http.post("/api/v1/auth/code/request", json=body, headers=ipk())
        assert r.status_code == 400 and r.json()["error"]["code"] == "captcha_failed", tok
    r = await srv.http.post(
        "/api/v1/auth/code/request",
        json={"email": "t@example.com", "turnstile_token": "good-login"},
        headers={"X-Real-IP": "10.9.9.9"},
    )
    assert r.status_code == 202
    assert calls[-1]["secret"] == "0x4AAA-secret" and calls[-1]["remoteip"] == "10.9.9.9"
    r = await srv.http.post(
        "/api/v1/auth/signup/start",
        json={"email": "t2@example.com", "name": "T", "turnstile_token": "good-signup"},
        headers=ipk(),
    )
    assert r.status_code == 202


async def test_turnstile_disabled_in_panel(make_server):
    calls = []
    srv = await make_server(turnstile=turnstile_stub(calls), turnstile_site_key="s", turnstile_secret_key="k")
    async with srv.ctx.engine.begin() as c:
        await c.execute(text("INSERT INTO instance_settings (key, value) VALUES ('captcha_enabled', 'false')"))
    info = (await srv.http.get("/api/info")).json()
    assert info["features"]["captcha"] is None
    r = await srv.http.post("/api/v1/auth/code/request", json={"email": "t@example.com"}, headers=ipk())
    assert r.status_code == 202 and calls == []


# ---------------------------------------------------------------- cadastro fechado e convites
async def test_signup_closed_and_invites(make_server):
    srv = await make_server(initial_signup_open=False)
    info = (await srv.http.get("/api/info")).json()
    assert info["features"]["signupOpen"] is False and "signup" not in info["links"]
    r = await srv.http.post("/api/v1/auth/signup/start", json={"email": "z@example.com", "name": "Z"}, headers=ipk())
    assert r.status_code == 403 and r.json()["error"]["code"] == "signup_closed"

    from clearchat_server.services.accounts import create_invite

    async with srv.ctx.engine.begin() as c:
        _, tok_any = await create_invite(c, None, "qualquer", 7)
        _, tok_bound = await create_invite(c, "bound@example.com", None, 7)
    assert (await srv.http.get(f"/api/v1/auth/invite/{tok_any}")).json() == {"valid": True}
    assert (await srv.http.get(f"/api/v1/auth/invite/{tok_bound}")).json() == {
        "valid": True,
        "email": "bound@example.com",
    }
    assert (await srv.http.get("/api/v1/auth/invite/nope-nope-nope")).json() == {"valid": False}

    r = await srv.http.post(
        "/api/v1/auth/signup/start",
        json={"email": "other@example.com", "name": "O", "invite_token": tok_bound},
        headers=ipk(),
    )
    assert r.status_code == 400 and r.json()["error"]["code"] == "invite_invalid"
    r = await srv.http.post(
        "/api/v1/auth/signup/start",
        json={"email": "z@example.com", "name": "Z", "invite_token": tok_any},
        headers=ipk(),
    )
    assert r.status_code == 202
    await srv.flush_mail()
    r = await srv.http.post(
        "/api/v1/auth/signup/verify",
        json={"email": "z@example.com", "code": srv.last_code("z@example.com"), "device": srv.device("web", False)},
        headers=ipk(),
    )
    assert r.status_code == 201
    assert "refresh_token" not in r.json() and "cc_refresh" in r.headers.get("set-cookie", "")
    assert (await srv.http.get(f"/api/v1/auth/invite/{tok_any}")).json() == {"valid": False}  # consumido
    r = await srv.http.post(
        "/api/v1/auth/signup/start",
        json={"email": "y@example.com", "name": "Y", "invite_token": tok_any},
        headers=ipk(),
    )
    assert r.json()["error"]["code"] == "invite_invalid"


def test_client_ip_trust():
    s = SimpleNamespace(
        trusted_networks=[ipaddress.ip_network("127.0.0.1/32"), ipaddress.ip_network("172.31.250.1/32")]
    )
    h = {"x-real-ip": "203.0.113.5", "x-forwarded-for": "1.1.1.1, 198.51.100.7"}
    assert client_ip("127.0.0.1", h, s) == "203.0.113.5"
    assert client_ip("172.31.250.1", {"x-forwarded-for": "1.1.1.1, 198.51.100.7"}, s) == "198.51.100.7"
    assert client_ip("8.8.8.8", h, s) == "8.8.8.8"  # par não confiável: cabeçalhos ignorados
    assert client_ip("127.0.0.1", {"x-real-ip": "garbage"}, s) == "127.0.0.1"
    _ = (SECRET, timedelta)
