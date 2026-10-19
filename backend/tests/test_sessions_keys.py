"""Sessões (refresh rotativo, reuso, cookie web, logout), dispositivos, conta, chaves (setup, prova de posse,
troca de wrap, reset)."""

from __future__ import annotations

import json

from conftest import VECTORS, b64u, chat, rand_ip
from sqlalchemy import text

KEYS = json.loads((VECTORS / "keys.json").read_text())
KDF = {"alg": "argon2id", "v": 19, "m": 65536, "t": 3, "p": 1, "len": 32}


def setup_body():
    pw = dict(next(w for w in KEYS["wraps"] if w["slot"] == "password")["wrap"])
    rk = dict(next(w for w in KEYS["wraps"] if w["slot"] == "recovery")["wrap"])
    return {
        "password": {"kdf": KDF, "salt": "AAECAwQFBgcICQoLDA0ODw", "wrap": pw},
        "recovery": {"kdf": {"alg": "hkdf-sha256"}, "salt": "8OHSw7Sllod4aVpLPC0eDw", "wrap": rk},
        "verifier": KEYS["verifier"],
    }


async def test_refresh_rotation_and_reuse_detection(srv):
    s = await srv.signup()
    c, _ = await srv.ws(s)
    r = await srv.http.post("/api/v1/auth/refresh", json={"refresh_token": s.refresh})
    assert r.status_code == 200
    t1 = r.json()
    assert t1["refresh_token"] != s.refresh and t1["access_token"].startswith("cca_")
    assert t1["access_expires_in"] == 3600 and t1["refresh_expires_in"] == 60 * 86400
    # o access antigo continua válido até expirar; o novo funciona
    assert (
        await srv.http.get("/api/v1/account", headers={"Authorization": f"Bearer {t1['access_token']}"})
    ).status_code == 200
    # reutilizar o refresh antigo → dispositivo revogado
    r = await srv.http.post("/api/v1/auth/refresh", json={"refresh_token": s.refresh})
    assert r.status_code == 401 and r.json()["error"]["code"] == "refresh_reused"
    assert await c.wait_closed() == 4403
    r = await srv.http.post("/api/v1/auth/refresh", json={"refresh_token": t1["refresh_token"]})
    assert r.status_code in (401, 403)
    r = await srv.http.get("/api/v1/account", headers={"Authorization": f"Bearer {t1['access_token']}"})
    assert r.status_code == 401


async def test_refresh_family_reuse_revokes_device(srv):
    """Regressão: R0 apresentado depois de duas rotações (R0→R1→R2) também é reuso e revoga o dispositivo."""
    s = await srv.signup()
    c, _ = await srv.ws(s)
    r1 = (await srv.http.post("/api/v1/auth/refresh", json={"refresh_token": s.refresh})).json()
    r2 = (await srv.http.post("/api/v1/auth/refresh", json={"refresh_token": r1["refresh_token"]})).json()
    assert r2["refresh_token"] not in (s.refresh, r1["refresh_token"])
    r = await srv.http.post("/api/v1/auth/refresh", json={"refresh_token": s.refresh})
    assert r.status_code == 401 and r.json()["error"]["code"] == "refresh_reused"
    assert await c.wait_closed() == 4403
    # o ladrão (com R2) também perdeu a sessão
    r = await srv.http.post("/api/v1/auth/refresh", json={"refresh_token": r2["refresh_token"]})
    assert r.status_code in (401, 403)
    r = await srv.http.get("/api/v1/account", headers={"Authorization": f"Bearer {r2['access_token']}"})
    assert r.status_code == 401
    async with srv.ctx.engine.connect() as conn:
        kinds = (await conn.execute(text("SELECT kind FROM activity WHERE kind = 'refresh_reused'"))).all()
    assert len(kinds) == 1


async def test_refresh_history_prune(srv):
    from datetime import timedelta

    from clearchat_server.auth.tokens import prune_refresh_history
    from clearchat_server.jobs import run_gc
    from clearchat_server.util import utcnow

    s = await srv.signup()
    r1 = (await srv.http.post("/api/v1/auth/refresh", json={"refresh_token": s.refresh})).json()
    await srv.http.post("/api/v1/auth/refresh", json={"refresh_token": r1["refresh_token"]})
    async with srv.ctx.engine.begin() as conn:
        assert (await conn.execute(text("SELECT count(*) FROM device_refresh_history"))).scalar() == 2
        assert await prune_refresh_history(conn, utcnow()) == 0
    # o GC periódico faz a poda: nada antes da validade, tudo depois
    assert (await run_gc(srv.ctx))["refresh_history"] == 0
    assert (await run_gc(srv.ctx, utcnow() + timedelta(days=61)))["refresh_history"] == 2
    # depois da validade, R0 nem seria aceito: sem histórico ele é só um token desconhecido
    r = await srv.http.post("/api/v1/auth/refresh", json={"refresh_token": s.refresh})
    assert r.status_code == 401 and r.json()["error"]["code"] == "unauthorized"


async def test_access_token_expiry(srv):
    s = await srv.signup()
    async with srv.ctx.engine.begin() as c:
        await c.execute(text("UPDATE access_tokens SET expires_at = now() - interval '1 second'"))
    r = await srv.http.get("/api/v1/account", headers=s.h)
    assert r.status_code == 401 and r.json()["error"]["details"]["reason"] == "expired"
    assert (await srv.http.get("/api/v1/account")).status_code == 401


async def test_web_cookie_refresh_and_logout(srv):
    s = await srv.signup(client="web", can_host=True)  # web nunca hospeda
    assert s.refresh is None
    devs = (await srv.http.get("/api/v1/devices", headers=s.h)).json()
    assert devs[0]["can_host"] is False and devs[0]["current"] is True
    jar_cookie = srv.http.cookies.get("cc_refresh")
    assert jar_cookie
    r = await srv.http.post("/api/v1/auth/refresh", json={})  # site: corpo vazio, refresh no cookie
    assert r.status_code == 200 and "refresh_token" not in r.json()
    assert srv.http.cookies.get("cc_refresh") != jar_cookie
    h = {"Authorization": f"Bearer {r.json()['access_token']}"}
    assert (await srv.http.post("/api/v1/auth/logout", headers=h)).status_code == 204
    assert (await srv.http.get("/api/v1/account", headers=h)).status_code in (401, 403)


async def test_devices_list_rename_revoke(srv):
    a = await srv.signup("dev@example.com")
    b = await srv.login("dev@example.com", name="Notebook")
    cb, _ = await srv.ws(b)
    devs = (await srv.http.get("/api/v1/devices", headers=a.h)).json()
    assert {d["name"] for d in devs} == {"PC", "Notebook"}
    nb = next(d for d in devs if d["name"] == "Notebook")
    assert nb["online"] is True and nb["current"] is False and nb["last_ip"]
    r = await srv.http.patch(f"/api/v1/devices/{b.device_id}", json={"name": "Note"}, headers=a.h)
    assert r.status_code == 200
    r = await srv.http.delete(f"/api/v1/devices/{b.device_id}", headers=a.h)
    assert r.status_code == 204
    assert await cb.wait_closed() == 4403
    r = await srv.http.get("/api/v1/account", headers=b.h)
    assert r.status_code == 401
    assert (await srv.http.delete(f"/api/v1/devices/{b.device_id}", headers=a.h)).status_code == 404


async def test_device_quota(srv):
    s = await srv.signup("q@example.com")
    async with srv.ctx.engine.begin() as c:
        await c.execute(text("UPDATE users SET quota_devices = 1 WHERE id = :u"), {"u": s.user_id})
    r = await srv.http.post(
        "/api/v1/auth/code/request", json={"email": "q@example.com"}, headers={"X-Real-IP": rand_ip()}
    )
    await srv.flush_mail()
    r = await srv.http.post(
        "/api/v1/auth/code/verify",
        json={"email": "q@example.com", "code": srv.last_code("q@example.com", "login"), "device": srv.device()},
    )
    assert r.status_code == 413 and r.json()["error"]["details"] == {"kind": "devices", "used": 1, "limit": 1}


async def test_account_get_patch_delete(srv):
    s = await srv.signup("acc@example.com", name="Ana")
    c, _ = await srv.ws(s)
    acc = (await srv.http.get("/api/v1/account", headers=s.h)).json()
    assert acc["email"] == "acc@example.com" and acc["usage"]["devices"] == 1
    assert acc["quotas"] == {"record_bytes": None, "records": None, "blob_bytes": None, "devices": None}
    acc = (await srv.http.patch("/api/v1/account", json={"name": "Ana B"}, headers=s.h)).json()
    assert acc["name"] == "Ana B"
    r = await srv.http.request("DELETE", "/api/v1/account", json={"code": "123456"}, headers=s.h)
    assert r.json()["error"]["code"] == "code_invalid"
    assert (
        await srv.http.post("/api/v1/auth/reauth/request", json={"purpose": "delete_account"}, headers=s.h)
    ).status_code == 202
    await srv.flush_mail()
    code = srv.last_code("acc@example.com", "delete_account")
    r = await srv.http.request("DELETE", "/api/v1/account", json={"code": code}, headers=s.h)
    assert r.status_code == 204
    ev = await c.event("account.deleted")
    assert ev == {"t": "account.deleted"}
    assert await c.wait_closed() == 4403
    async with srv.ctx.engine.connect() as conn:
        n = (await conn.execute(text("SELECT count(*) FROM users"))).scalar()
    assert n == 0


async def test_reauth_rate_limit(srv):
    s = await srv.signup()
    st = [
        (await srv.http.post("/api/v1/auth/reauth/request", json={"purpose": "reset_keys"}, headers=s.h)).status_code
        for _ in range(6)
    ]
    assert st == [202] * 5 + [429]


async def test_keys_setup_get_and_change(srv):
    s = await srv.signup()
    r = await srv.http.get("/api/v1/keys", headers=s.h)
    assert r.status_code == 409 and r.json()["error"]["code"] == "keys_not_ready"
    other, _ = await srv.ws(s)
    r = await srv.http.post("/api/v1/keys/setup", json=setup_body(), headers=s.h)
    assert r.status_code == 200, r.text
    kr = r.json()
    assert kr["key_version"] == 1 and kr["keys_rev"] == 1
    assert kr["password"]["wrap"] == setup_body()["password"]["wrap"]
    assert (await other.event("keys.changed"))["keys_rev"] == 1
    assert (await srv.http.post("/api/v1/keys/setup", json=setup_body(), headers=s.h)).json()["error"][
        "code"
    ] == "keys_already_set"
    # login novo devolve keys
    s2 = await srv.login(s.email)
    assert s2.body["keys_ready"] is True and s2.body["keys"]["recovery"]["kdf"] == {"alg": "hkdf-sha256"}

    new_pw = {
        "kdf": {**KDF, "m": 131072},
        "salt": b64u(b"\x01" * 16),
        "wrap": {"n": b64u(b"\x02" * 12), "c": b64u(b"\x03" * 48)},
    }
    r = await srv.http.put(
        "/api/v1/keys/password", json={"key_proof": b64u(b"\x00" * 32), "password": new_pw}, headers=s.h
    )
    assert r.status_code == 403 and r.json()["error"]["code"] == "key_proof_invalid"
    r = await srv.http.put(
        "/api/v1/keys/password", json={"key_proof": KEYS["key_proof"], "password": new_pw}, headers=s.h
    )
    assert r.status_code == 200 and r.json()["keys_rev"] == 2 and r.json()["password"]["kdf"]["m"] == 131072
    assert (await other.event("keys.changed"))["keys_rev"] == 2
    new_rk = {
        "kdf": {"alg": "hkdf-sha256"},
        "salt": b64u(b"\x04" * 16),
        "wrap": {"n": b64u(b"\x05" * 12), "c": b64u(b"\x06" * 48)},
    }
    r = await srv.http.put(
        "/api/v1/keys/recovery", json={"key_proof": KEYS["key_proof"], "recovery": new_rk}, headers=s.h
    )
    assert r.status_code == 200 and r.json()["keys_rev"] == 3


async def test_keys_change_rate_limit(srv):
    """Regressão: troca de wrap (senha/recuperação) limitada a 10/h por conta → a 11ª é 429 rate_limited."""
    s = await srv.signup()
    assert (await srv.http.post("/api/v1/keys/setup", json=setup_body(), headers=s.h)).status_code == 200
    pw = setup_body()["password"]
    rk = setup_body()["recovery"]
    st = []
    for i in range(10):
        if i % 2:
            r = await srv.http.put(
                "/api/v1/keys/recovery", json={"key_proof": KEYS["key_proof"], "recovery": rk}, headers=s.h
            )
        else:
            r = await srv.http.put(
                "/api/v1/keys/password", json={"key_proof": KEYS["key_proof"], "password": pw}, headers=s.h
            )
        st.append(r.status_code)
    assert st == [200] * 10
    r = await srv.http.put("/api/v1/keys/password", json={"key_proof": KEYS["key_proof"], "password": pw}, headers=s.h)
    assert r.status_code == 429 and r.json()["error"]["code"] == "rate_limited"
    assert int(r.headers["Retry-After"]) > 0
    # é por conta: outra conta continua livre
    s2 = await srv.signup()
    assert (await srv.http.post("/api/v1/keys/setup", json=setup_body(), headers=s2.h)).status_code == 200
    r = await srv.http.put("/api/v1/keys/password", json={"key_proof": KEYS["key_proof"], "password": pw}, headers=s2.h)
    assert r.status_code == 200


async def test_keys_validation(srv):
    s = await srv.signup()
    bad_cases = []
    b = setup_body()
    b["password"]["kdf"] = {**KDF, "m": 1024}  # abaixo do mínimo (anti-downgrade)
    bad_cases.append(b)
    b = setup_body()
    b["password"]["kdf"] = {**KDF, "t": 11}
    bad_cases.append(b)
    b = setup_body()
    b["password"]["salt"] = b64u(b"\x00" * 15)
    bad_cases.append(b)
    b = setup_body()
    b["recovery"]["wrap"]["c"] = b64u(b"\x00" * 47)
    bad_cases.append(b)
    b = setup_body()
    b["verifier"] = "not base64!!"
    bad_cases.append(b)
    b = setup_body()
    b["recovery"]["kdf"] = {"alg": "argon2id"}
    bad_cases.append(b)
    for body in bad_cases:
        r = await srv.http.post("/api/v1/keys/setup", json=body, headers=s.h)
        assert r.status_code == 400 and r.json()["error"]["code"] == "invalid_request", body


async def test_keys_reset_wipes_data(srv):
    s = await srv.signup("reset@example.com")
    assert (await srv.http.post("/api/v1/keys/setup", json=setup_body(), headers=s.h)).status_code == 200
    r = await srv.push(s, [chat("c1")])
    assert r.status_code == 200
    c, _ = await srv.ws(s)
    await srv.http.post("/api/v1/auth/reauth/request", json={"purpose": "reset_keys"}, headers=s.h)
    await srv.flush_mail()
    r = await srv.http.post(
        "/api/v1/keys/reset", json={"code": srv.last_code("reset@example.com", "reset_keys")}, headers=s.h
    )
    assert r.status_code == 204
    assert await c.event("keys.reset") == {"t": "keys.reset"}
    assert await c.wait_closed() == 4403
    # a sessão continua válida (dispositivos não são revogados): o cliente reconecta e refaz o setup
    _c2, w2 = await srv.ws(s)
    assert w2["keys_rev"] == 2
    acc = (await srv.http.get("/api/v1/account", headers=s.h)).json()
    assert acc["keys_ready"] is False and acc["usage"]["records"] == 0
    # cursor antigo → 410 (dados apagados sem tombstones)
    r = await srv.http.get("/api/v1/sync/changes?since=0", headers=s.h)
    assert r.status_code == 410 and r.json()["error"]["code"] == "cursor_expired"
    r = await srv.http.get("/api/v1/records", headers=s.h)
    assert r.json()["records"] == [] and r.json()["head"] == 1
