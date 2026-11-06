"""Notificações push (SYNC_PROTOCOL §22): token por dispositivo, POST /push (validação, destinos, limites),
mensagem ao FCM (HTTP v1 com conta de serviço — FCM e endpoint OAuth2 falsos, chave RSA gerada no teste),
limpeza de tokens e o aviso "host caiu" do servidor com histerese (§22.6)."""

from __future__ import annotations

import asyncio
import base64
import json
import re
import time
import uuid
from datetime import timedelta
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs

import httpx
import pytest
from conftest import TEST_DB, env
from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import padding, rsa
from sqlalchemy import text
from sqlalchemy.ext.asyncio import create_async_engine

from clearchat_server.push.fcm import classify_error
from clearchat_server.util import utcnow

PROJECT = "proj-test"
TOKEN_URI = "https://oauth.fake.test/token"
FCM_BASE = "https://fcm.fake.test"
TAG = "5f0c1e2d3a4b5c6d7e8f901a2b3c4d5e"


def _b64d(s: str) -> bytes:
    return base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))


class FakeFcm:
    """Endpoint OAuth2 (confere o JWT RS256 com a chave pública) + FCM HTTP v1 (grava as mensagens)."""

    def __init__(self, tmp: Path) -> None:
        self.key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
        pem = self.key.private_bytes(
            serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption()
        ).decode()
        self.sa_path = tmp / "service-account.json"
        self.sa_path.write_text(
            json.dumps(
                {
                    "type": "service_account",
                    "project_id": PROJECT,
                    "private_key_id": "kid-1",
                    "private_key": pem,
                    "client_email": f"svc@{PROJECT}.iam.gserviceaccount.com",
                    "token_uri": TOKEN_URI,
                }
            )
        )
        self.token_hits = 0
        self.access = ""
        self.messages: list[dict[str, Any]] = []
        # token do aparelho → (status, corpo) da resposta do FCM
        self.responses: dict[str, tuple[int, dict[str, Any]]] = {}
        self.expire_access = False

    def settings(self) -> dict[str, Any]:
        return {"fcm_service_account_file": str(self.sa_path), "fcm_base_url": FCM_BASE}

    def handler(self, request: httpx.Request) -> httpx.Response:
        if str(request.url) == TOKEN_URI:
            form = parse_qs(request.content.decode())
            assert form["grant_type"] == ["urn:ietf:params:oauth:grant-type:jwt-bearer"]
            h, c, s = form["assertion"][0].split(".")
            header, claims = json.loads(_b64d(h)), json.loads(_b64d(c))
            assert header == {"alg": "RS256", "typ": "JWT", "kid": "kid-1"}
            assert claims["iss"] == f"svc@{PROJECT}.iam.gserviceaccount.com"
            assert claims["aud"] == TOKEN_URI
            assert claims["scope"] == "https://www.googleapis.com/auth/firebase.messaging"
            assert claims["exp"] - claims["iat"] == 3600 and abs(claims["iat"] - time.time()) < 60
            try:
                self.key.public_key().verify(_b64d(s), f"{h}.{c}".encode(), padding.PKCS1v15(), hashes.SHA256())
            except InvalidSignature:
                return httpx.Response(400, json={"error": "invalid_grant"})
            self.token_hits += 1
            self.access = f"ya29.fake-{self.token_hits}"
            return httpx.Response(200, json={"access_token": self.access, "expires_in": 3599, "token_type": "Bearer"})
        if request.url.host == "fcm.fake.test":
            assert request.url.path == f"/v1/projects/{PROJECT}/messages:send"
            if self.expire_access:
                self.expire_access = False
                return httpx.Response(401, json={"error": {"code": 401, "status": "UNAUTHENTICATED"}})
            if request.headers.get("authorization") != f"Bearer {self.access}":
                return httpx.Response(401, json={"error": {"code": 401, "status": "UNAUTHENTICATED"}})
            body = json.loads(request.content)
            self.messages.append(body)
            st, resp = self.responses.get(body["message"]["token"], (200, {"name": f"projects/{PROJECT}/messages/1"}))
            return httpx.Response(st, json=resp)
        return httpx.Response(404)

    def to(self, token: str) -> list[dict[str, Any]]:
        return [m["message"] for m in self.messages if m["message"]["token"] == token]

    def kinds(self, kind: str) -> list[dict[str, Any]]:
        return [m["message"] for m in self.messages if m["message"]["data"]["kind"] == kind]


UNREGISTERED = (
    404,
    {
        "error": {
            "code": 404,
            "message": "Requested entity was not found.",
            "status": "NOT_FOUND",
            "details": [{"@type": "type.googleapis.com/google.firebase.fcm.v1.FcmError", "errorCode": "UNREGISTERED"}],
        }
    },
)
INVALID_TOKEN = (
    400,
    {
        "error": {
            "code": 400,
            "message": "The registration token is not a valid FCM registration token",
            "status": "INVALID_ARGUMENT",
            "details": [
                {"@type": "type.googleapis.com/google.firebase.fcm.v1.FcmError", "errorCode": "INVALID_ARGUMENT"},
                {
                    "@type": "type.googleapis.com/google.rpc.BadRequest",
                    "fieldViolations": [{"field": "message.token", "description": "Invalid registration token"}],
                },
            ],
        }
    },
)
INVALID_OTHER = (
    400,
    {
        "error": {
            "code": 400,
            "status": "INVALID_ARGUMENT",
            "details": [
                {
                    "@type": "type.googleapis.com/google.rpc.BadRequest",
                    "fieldViolations": [{"field": "message.android.ttl", "description": "Invalid"}],
                }
            ],
        }
    },
)
UNAVAILABLE = (503, {"error": {"code": 503, "status": "UNAVAILABLE"}})


@pytest.fixture
def fcm(tmp_path: Path) -> FakeFcm:
    return FakeFcm(tmp_path)


@pytest.fixture
async def psrv(make_server: Any, fcm: FakeFcm) -> Any:
    return await make_server(http_handler=fcm.handler, **fcm.settings())


async def sql(q: str, **params: Any) -> list[Any]:
    e = create_async_engine(TEST_DB)
    async with e.begin() as c:
        res = await c.execute(text(q), params)
        rows = list(res.fetchall()) if res.returns_rows else []
    await e.dispose()
    return rows


async def register(srv: Any, s: Any, token: str) -> None:
    r = await srv.http.put("/api/v1/devices/current/push", json={"provider": "fcm", "token": token}, headers=s.h)
    assert r.status_code == 204, r.text


async def devices(srv: Any, s: Any) -> dict[str, dict[str, Any]]:
    r = await srv.http.get("/api/v1/devices", headers=s.h)
    assert r.status_code == 200
    return {d["id"]: d for d in r.json()}


async def send(srv: Any, s: Any, **body: Any) -> httpx.Response:
    b = {"kind": "approval", "tag": TAG, "to": "all", "env": env(60)}
    b.update(body)
    return await srv.http.post("/api/v1/push", json=b, headers=s.h)


async def family(srv: Any) -> tuple[Any, Any, Any]:
    """Conta com um desktop (remetente) e dois celulares com token."""
    pc = await srv.signup()
    p1 = await srv.login(pc.email, client="mobile", can_host=False, name="Celular 1")
    p2 = await srv.login(pc.email, client="mobile", can_host=False, name="Celular 2")
    await register(srv, p1, "tok-phone-1")
    await register(srv, p2, "tok-phone-2")
    return pc, p1, p2


# ---------------------------------------------------------------- instância sem push


async def test_unconfigured_instance(srv):
    r = await srv.http.get("/api/info")
    assert r.json()["features"]["push"] is None
    s = await srv.signup()
    r = await send(srv, s)
    assert r.status_code == 503 and r.json()["error"]["code"] == "push_unavailable"
    # registrar token é aceito (fica guardado para quando a instância ligar o push)
    await register(srv, s, "tok-x")
    assert (await devices(srv, s))[s.device_id]["push"] is True


async def test_bad_service_account_disables_push(make_server, tmp_path):
    bad = tmp_path / "bad.json"
    bad.write_text('{"type": "authorized_user"}')
    srv = await make_server(fcm_service_account_file=str(bad))
    assert (await srv.http.get("/api/info")).json()["features"]["push"] is None
    srv2 = await make_server(fcm_service_account_file=str(tmp_path / "missing.json"))
    assert (await srv2.http.get("/api/info")).json()["features"]["push"] is None


# ---------------------------------------------------------------- token do dispositivo


async def test_info_and_token_registration(psrv):
    r = await psrv.http.get("/api/info")
    assert r.json()["features"]["push"] == {"providers": ["fcm"]}
    assert r.json()["protocol"]["version"] == "1.7.0"
    pc = await psrv.signup()
    phone = await psrv.login(pc.email, client="mobile", can_host=False, name="Celular")
    devs = await devices(psrv, pc)
    assert devs[pc.device_id]["push"] is False and devs[phone.device_id]["push"] is False
    url = "/api/v1/devices/current/push"
    for bad in (
        {"provider": "apns", "token": "t"},
        {"provider": "fcm"},
        {"provider": "fcm", "token": ""},
        {"provider": "fcm", "token": "x" * 4097},
        {"provider": "fcm", "token": 12},
        {"provider": "fcm", "token": " t "},
    ):
        r = await psrv.http.put(url, json=bad, headers=phone.h)
        assert r.status_code == 400 and r.json()["error"]["code"] == "invalid_request", bad
    assert (await psrv.http.put(url, json={"provider": "fcm", "token": "x" * 4096}, headers=phone.h)).status_code == 204
    await register(psrv, phone, "tok-a")
    await register(psrv, phone, "tok-a")  # idempotente
    assert (await devices(psrv, pc))[phone.device_id]["push"] is True
    r = await psrv.http.delete(url, headers=phone.h)
    assert r.status_code == 204
    assert (await psrv.http.delete(url, headers=phone.h)).status_code == 204  # idempotente
    assert (await devices(psrv, pc))[phone.device_id]["push"] is False
    # sem autenticação
    assert (await psrv.http.put(url, json={"provider": "fcm", "token": "t"})).status_code == 401


async def test_same_token_moves_to_new_device(psrv):
    a = await psrv.signup()
    phone_a = await psrv.login(a.email, client="mobile", can_host=False)
    await register(psrv, phone_a, "tok-shared")
    # o app foi reinstalado e entrou noutra conta: o token sai do dispositivo antigo
    b = await psrv.signup()
    phone_b = await psrv.login(b.email, client="mobile", can_host=False)
    await register(psrv, phone_b, "tok-shared")
    assert (await devices(psrv, a))[phone_a.device_id]["push"] is False
    assert (await devices(psrv, b))[phone_b.device_id]["push"] is True
    assert (await send(psrv, a)).json() == {"sent": 0}


async def test_token_rate_limit(psrv):
    s = await psrv.signup()
    for i in range(30):
        await register(psrv, s, f"tok-{i}")
    r = await psrv.http.put("/api/v1/devices/current/push", json={"provider": "fcm", "token": "t"}, headers=s.h)
    assert r.status_code == 429 and r.json()["error"]["code"] == "rate_limited" and "Retry-After" in r.headers


async def test_revoke_and_logout_drop_token(psrv, fcm):
    pc, p1, p2 = await family(psrv)
    r = await psrv.http.delete(f"/api/v1/devices/{p1.device_id}", headers=pc.h)
    assert r.status_code == 204
    r = await psrv.http.post("/api/v1/auth/logout", headers=p2.h)
    assert r.status_code == 204
    rows = await sql(
        "SELECT push_token FROM devices WHERE id = ANY(CAST(:d AS uuid[]))", d=[p1.device_id, p2.device_id]
    )
    assert [r.push_token for r in rows] == [None, None]
    assert (await send(psrv, pc)).json() == {"sent": 0}
    await psrv.ctx.push.drain()
    assert fcm.messages == []


# ---------------------------------------------------------------- envio


async def test_fanout_message_shape(psrv, fcm):
    pc, p1, p2 = await family(psrv)
    e = env(80)
    r = await send(psrv, pc, kind="approval", env=e)
    assert r.status_code == 200 and r.json() == {"sent": 2}
    await psrv.ctx.push.drain()
    assert sorted(m["message"]["token"] for m in fcm.messages) == ["tok-phone-1", "tok-phone-2"]
    m = fcm.to("tok-phone-1")[0]
    assert set(m) == {"token", "data", "android"}
    assert m["android"] == {"collapse_key": TAG, "priority": "high", "ttl": "3600s"}
    d = m["data"]
    assert set(d) == {"v", "kind", "tag", "env", "sent_at"} and all(isinstance(v, str) for v in d.values())
    assert d["v"] == "1" and d["kind"] == "approval" and d["tag"] == TAG
    assert json.loads(d["env"]) == e
    assert re.fullmatch(r"\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z", d["sent_at"])
    # access token em cache: um só pedido ao endpoint OAuth2
    assert fcm.token_hits == 1
    # TTL e prioridade por kind
    fcm.messages.clear()
    for kind, ttl in (("question", "3600s"), ("retry", "3600s"), ("reply", "86400s"), ("error", "86400s")):
        assert (await send(psrv, pc, kind=kind, to=[p1.device_id])).json() == {"sent": 1}
        await psrv.ctx.push.drain()
        last = fcm.messages[-1]["message"]
        assert last["data"]["kind"] == kind and last["android"]["ttl"] == ttl and last["android"]["priority"] == "high"
    r = await send(psrv, pc, kind="dismiss", env=None)
    assert r.json() == {"sent": 2}
    await psrv.ctx.push.drain()
    dm = fcm.kinds("dismiss")
    assert len(dm) == 2 and all(m["data"]["env"] == "" for m in dm)
    assert all(m["android"] == {"collapse_key": TAG, "priority": "normal", "ttl": "3600s"} for m in dm)
    assert fcm.token_hits == 1


async def test_to_list_and_sender_excluded(psrv, fcm):
    pc, p1, p2 = await family(psrv)
    other = await psrv.signup()
    other_phone = await psrv.login(other.email, client="mobile", can_host=False)
    await register(psrv, other_phone, "tok-other")
    # celular manda para "all": o próprio celular fica de fora
    assert (await send(psrv, p1)).json() == {"sent": 1}
    await psrv.ctx.push.drain()
    assert [m["message"]["token"] for m in fcm.messages] == ["tok-phone-2"]
    fcm.messages.clear()
    # lista: id de outro usuário, dispositivo sem token e id inexistente são ignorados
    r = await send(psrv, pc, to=[p2.device_id, other_phone.device_id, pc.device_id, str(uuid.uuid4())])
    assert r.json() == {"sent": 1}
    assert (await send(psrv, pc, to=[])).json() == {"sent": 0}
    await psrv.ctx.push.drain()
    assert [m["message"]["token"] for m in fcm.messages] == ["tok-phone-2"]


async def test_validation(psrv, fcm):
    pc, p1, _ = await family(psrv)

    async def bad(field: str, status: int = 400, **body: Any) -> None:
        r = await send(psrv, pc, **body)
        assert r.status_code == status, (body, r.text)
        err = r.json()["error"]
        assert err["code"] == ("invalid_request" if status == 400 else "payload_too_large")
        assert err["details"].get("field") == field

    await bad("kind", kind="host_offline")  # só o servidor gera
    await bad("kind", kind="nope")
    await bad("kind", kind=None)
    await bad("tag", tag=TAG.upper())
    await bad("tag", tag=TAG[:-1])
    await bad("tag", tag=TAG + "0")
    await bad("tag", tag=TAG[:-1] + "\n")
    await bad("to", to="todos")
    await bad("to", to=[p1.device_id] * 21)
    await bad("to", to=["não-é-uuid"])
    await bad("to", to=[1])
    await bad("env", env=None)
    await bad("env", env={"v": 2, "k": 1, "n": "x", "c": "y"})
    await bad("env", kind="dismiss", env=env())
    await bad("env", 413, env=env(1600))  # JSON do envelope > 2048
    # no limite: ~2048 bytes de JSON passam
    big = env(1480)
    assert len(json.dumps(big, separators=(",", ":"))) <= 2048
    assert (await send(psrv, pc, env=big)).status_code == 200
    r = await psrv.http.post("/api/v1/push", content=b"[]", headers={**pc.h, "Content-Type": "application/json"})
    assert r.status_code == 400
    r = await psrv.http.post("/api/v1/push", json={"kind": "approval"})
    assert r.status_code == 401
    await psrv.ctx.push.drain()
    assert len(fcm.messages) == 2  # só o envio válido (2 celulares)


async def test_rate_limits(psrv):
    pc, p1, _ = await family(psrv)
    for _ in range(120):
        assert (await send(psrv, pc, to=[])).status_code == 200
    r = await send(psrv, pc, to=[])
    assert r.status_code == 429 and r.json()["error"]["code"] == "rate_limited"
    assert int(r.headers["Retry-After"]) >= 1
    # outro dispositivo da mesma conta ainda pode (121 da conta < 300)…
    assert (await send(psrv, p1, to=[])).status_code == 200
    # …até o teto da conta (300/h)
    win = utcnow().replace(minute=0, second=0, microsecond=0)
    await sql(
        "UPDATE rate_counters SET count = 300 WHERE bucket = :b AND window_start = :w",
        b=f"push:user:{pc.user_id}:3600",
        w=win,
    )
    r = await send(psrv, p1, to=[])
    assert r.status_code == 429


async def test_rate_limit_multiplier(make_server, fcm):
    srv = await make_server(http_handler=fcm.handler, rate_limit_multiplier=2, **fcm.settings())
    s = await srv.signup()
    for _ in range(121):
        assert (await send(srv, s, to=[])).status_code == 200


async def test_fcm_errors_clean_tokens(make_server, fcm):
    # 6 logins na mesma conta passam do limite de código por e-mail (5/h): multiplicador só aqui
    psrv = await make_server(http_handler=fcm.handler, rate_limit_multiplier=4, **fcm.settings())
    pc = await psrv.signup()
    phones = {}
    for name in ("unreg", "invalid", "other400", "down", "ok"):
        p = await psrv.login(pc.email, client="mobile", can_host=False, name=name)
        await register(psrv, p, f"tok-{name}")
        phones[name] = p
    fcm.responses = {
        "tok-unreg": UNREGISTERED,
        "tok-invalid": INVALID_TOKEN,
        "tok-other400": INVALID_OTHER,
        "tok-down": UNAVAILABLE,
    }
    assert (await send(psrv, pc)).json() == {"sent": 5}
    await psrv.ctx.push.drain()
    devs = await devices(psrv, pc)
    assert {n: devs[p.device_id]["push"] for n, p in phones.items()} == {
        "unreg": False,
        "invalid": False,
        "other400": True,
        "down": True,
        "ok": True,
    }
    assert (await send(psrv, pc)).json() == {"sent": 3}


async def test_token_reregistered_during_send_is_kept(psrv, fcm):
    pc = await psrv.signup()
    phone = await psrv.login(pc.email, client="mobile", can_host=False)
    await register(psrv, phone, "tok-old")
    fcm.responses = {"tok-old": UNREGISTERED}
    await send(psrv, pc)
    # o app trocou o token antes de a resposta do FCM chegar: o novo fica
    await register(psrv, phone, "tok-new")
    await psrv.ctx.push.drain()
    rows = await sql("SELECT push_token FROM devices WHERE id = :d", d=phone.device_id)
    assert rows[0].push_token == "tok-new"


async def test_access_token_refresh_on_401(psrv, fcm):
    pc, _, _ = await family(psrv)
    await send(psrv, pc, to=[])  # nada a enviar: nem pede token
    assert fcm.token_hits == 0
    await send(psrv, pc)
    await psrv.ctx.push.drain()
    assert fcm.token_hits == 1 and len(fcm.messages) == 2
    fcm.expire_access = True
    await send(psrv, pc)
    await psrv.ctx.push.drain()
    assert fcm.token_hits == 2 and len(fcm.messages) == 4


def test_classify_error():
    assert classify_error(*UNREGISTERED) == "invalid_token"
    assert classify_error(*INVALID_TOKEN) == "invalid_token"
    assert classify_error(*INVALID_OTHER) == "error"
    assert classify_error(*UNAVAILABLE) == "error"
    assert classify_error(404, None) == "invalid_token"
    assert classify_error(500, "x") == "error"


async def test_fcm_timeout_does_not_block_request(make_server, fcm):
    async def slow(request: httpx.Request) -> httpx.Response:
        if request.url.host == "fcm.fake.test":
            await asyncio.sleep(5)
        return fcm.handler(request)

    srv = await make_server(http_handler=slow, fcm_timeout_s=0.3, **fcm.settings())
    pc, _, _ = await family(srv)
    t0 = time.monotonic()
    r = await send(srv, pc)
    assert r.status_code == 200 and r.json() == {"sent": 2}
    assert time.monotonic() - t0 < 1.0
    # o envio expira no teto curto (3 × FCM_TIMEOUT_S) e o servidor segue respondendo
    assert (await srv.http.get("/api/info")).status_code == 200
    t0 = time.monotonic()
    await srv.ctx.push.drain()
    assert time.monotonic() - t0 < 2.0 and fcm.messages == []


# ---------------------------------------------------------------- host caiu (§22.6)

HOST_FAST = {
    "host_drop_grace_s": 0.3,
    "host_offline_push_delay_s": 1.0,
    "host_offline_push_cooldown_s": 30,
}


@pytest.fixture
async def hsrv(make_server: Any, fcm: FakeFcm) -> Any:
    return await make_server(http_handler=fcm.handler, **fcm.settings(), **HOST_FAST)


async def host_setup(srv: Any) -> tuple[Any, Any, Any]:
    host = await srv.signup(name="Ana")
    phone = await srv.login(host.email, client="mobile", can_host=False, name="Celular")
    await register(srv, phone, "tok-phone")
    ch, _ = await srv.ws(host)
    await ch.ack("host.begin", chat_id="c1", epoch=None, purpose="run")
    return host, phone, ch


async def drop(srv: Any, c: Any) -> None:
    await c.close()


async def reconnect(srv: Any, s: Any, run: bool = True) -> Any:
    c, _ = await srv.ws(s)
    if run:
        await c.ack("host.begin", chat_id="c1", epoch=1, purpose="run")
    return c


async def wait_kind(fcm: FakeFcm, kind: str, n: int = 1, timeout: float = 4) -> list[dict[str, Any]]:
    t0 = time.monotonic()
    while time.monotonic() - t0 < timeout:
        got = fcm.kinds(kind)
        if len(got) >= n:
            return got
        await asyncio.sleep(0.05)
    raise AssertionError(f"esperava {n} aviso(s) {kind}, chegaram {len(fcm.kinds(kind))}")


async def test_host_offline_flapping_then_long_drop(hsrv, fcm):
    host, phone, ch = await host_setup(hsrv)
    # quedas curtas (mais longas que a tolerância, mais curtas que a espera do aviso) → nada
    for _ in range(3):
        await drop(hsrv, ch)
        await asyncio.sleep(0.6)
        ch = await reconnect(hsrv, host)
    await asyncio.sleep(1.2)
    await hsrv.ctx.push.drain()
    assert fcm.messages == []
    # queda longa com o chat rodando → um aviso
    await drop(hsrv, ch)
    (m,) = await wait_kind(fcm, "host_offline")
    assert m["token"] == "tok-phone"
    d = m["data"]
    assert d["env"] == "" and d["chat_id"] == "c1" and d["device_name"] == "PC" and d["v"] == "1"
    assert re.fullmatch(r"[0-9a-f]{32}", d["tag"])
    assert m["android"] == {"collapse_key": d["tag"], "priority": "high", "ttl": "3600s"}
    await asyncio.sleep(1.2)
    assert len(fcm.kinds("host_offline")) == 1  # um por queda, não um por varredura/chat
    # volta → dismiss da mesma tag
    ch = await reconnect(hsrv, host)
    (dm,) = await wait_kind(fcm, "dismiss")
    assert dm["data"]["tag"] == d["tag"] and dm["android"]["priority"] == "normal" and dm["data"]["env"] == ""
    # outra queda longa dentro do intervalo mínimo → nada
    await drop(hsrv, ch)
    await asyncio.sleep(2.0)
    await hsrv.ctx.push.drain()
    assert len(fcm.kinds("host_offline")) == 1
    # sem aviso mostrado, a volta não manda dismiss
    ch = await reconnect(hsrv, host)
    await asyncio.sleep(0.3)
    await hsrv.ctx.push.drain()
    assert len(fcm.kinds("dismiss")) == 1
    # passado o intervalo (simulado no banco): avisa de novo, com a MESMA tag do dispositivo
    await sql(
        "UPDATE devices SET offline_push_at = :t WHERE id = :d",
        t=utcnow() - timedelta(seconds=31),
        d=host.device_id,
    )
    await drop(hsrv, ch)
    got = await wait_kind(fcm, "host_offline", 2)
    assert got[1]["data"]["tag"] == d["tag"]


async def test_host_offline_needs_running_chat(hsrv, fcm):
    host, phone, ch = await host_setup(hsrv)
    await ch.ack("host.end", chat_id="c1", epoch=1)
    await drop(hsrv, ch)
    await asyncio.sleep(1.8)
    await hsrv.ctx.push.drain()
    assert fcm.messages == []


async def test_host_offline_cancelled_by_takeover(hsrv, fcm):
    host, phone, ch = await host_setup(hsrv)
    other = await hsrv.login(host.email, name="Notebook")
    co, _ = await hsrv.ws(other)
    await drop(hsrv, ch)
    await co.event("chat.state", pred=lambda m: (m.get("event") or {}).get("kind") == "host_dropped")
    # outro dispositivo assume o chat antes da espera acabar: o chat não está mais parado no host caído
    await co.ack("host.takeover", chat_id="c1", mode="force", confirm_pinned=False)
    await asyncio.sleep(1.2)
    await hsrv.ctx.push.drain()
    assert fcm.kinds("host_offline") == []


async def test_host_offline_without_push_targets_or_revoked(hsrv, fcm):
    host, phone, ch = await host_setup(hsrv)
    # revogar o host durante a espera cancela o aviso
    await drop(hsrv, ch)
    await asyncio.sleep(0.5)
    r = await hsrv.http.delete(f"/api/v1/devices/{host.device_id}", headers=phone.h)
    assert r.status_code == 204
    await asyncio.sleep(1.0)
    await hsrv.ctx.push.drain()
    assert fcm.messages == []
