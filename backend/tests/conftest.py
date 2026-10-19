"""Infra de testes: Postgres real (TEST_DATABASE_URL), uvicorn em processo numa porta livre, cliente HTTP
e cliente WebSocket de verdade. Timers do protocolo encurtados nos Settings de teste."""

from __future__ import annotations

import asyncio
import base64
import contextlib
import json
import os
import random
import secrets
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import httpx
import pytest
import uvicorn
from sqlalchemy import text
from sqlalchemy.ext.asyncio import create_async_engine
from websockets.asyncio.client import connect as ws_connect
from websockets.exceptions import ConnectionClosed

from clearchat_server.config import Settings
from clearchat_server.db import migrate
from clearchat_server.mail import Mailer
from clearchat_server.main import create_app

TEST_DB = os.environ.get("TEST_DATABASE_URL", "postgresql+asyncpg://postgres@127.0.0.1:55432/clearchat_test")
VECTORS = Path(__file__).resolve().parents[2] / "docs" / "test-vectors"
SECRET = "test-server-secret-0123456789abcdefghij"


def b64u(b: bytes) -> str:
    return base64.urlsafe_b64encode(b).rstrip(b"=").decode()


def env(size: int = 40) -> dict[str, Any]:
    """Envelope bem formado (conteúdo aleatório — o servidor nunca decifra)."""
    return {"v": 1, "k": 1, "n": b64u(secrets.token_bytes(12)), "c": b64u(secrets.token_bytes(size))}


def rand_ip() -> str:
    return f"10.{random.randint(0, 255)}.{random.randint(0, 255)}.{random.randint(1, 254)}"


@pytest.fixture(scope="session", autouse=True)
def _schema() -> None:
    async def reset() -> None:
        e = create_async_engine(TEST_DB)
        async with e.begin() as c:
            await c.execute(text("DROP SCHEMA IF EXISTS public CASCADE"))
            await c.execute(text("CREATE SCHEMA public"))
        await e.dispose()

    asyncio.run(reset())
    migrate(TEST_DB)


@pytest.fixture(autouse=True)
async def _clean() -> None:
    e = create_async_engine(TEST_DB)
    async with e.begin() as c:
        await c.execute(
            text(
                "TRUNCATE users, instance_settings, invites, email_codes, rate_counters, lockouts, activity "
                "RESTART IDENTITY CASCADE"
            )
        )
    await e.dispose()


def make_settings(tmp: Path, **over: Any) -> Settings:
    base: dict[str, Any] = {
        "public_base_url": "http://clear.test",
        "server_secret": SECRET,
        "admin_token": "admin-token-0123456789-0123456789-abcdef",
        "database_url": TEST_DB,
        "mail_backend": "memory",
        "blob_storage_dir": str(tmp / "blobs"),
        "trusted_proxy_cidrs": "127.0.0.1/32",
        "host_drop_grace_s": 0.5,
        "server_restart_grace_s": 1.0,
        "handover_force_timeout_s": 0.6,
        "command_result_timeout_s": 0.6,
        "ws_hello_timeout_s": 1.0,
        "ws_idle_timeout_s": 30,
        "jobs_enabled": False,
        "notify_listener_enabled": False,
        "instance_settings_cache_s": 0,
        "db_pool_size": 5,
        "log_level": "warning",
    }
    base.update(over)
    return Settings(_env_file=None, **base)  # type: ignore[call-arg]


@dataclass
class Session:
    email: str
    user_id: str
    device_id: str
    access: str
    refresh: str | None
    body: dict[str, Any] = field(default_factory=dict)

    @property
    def h(self) -> dict[str, str]:
        return {"Authorization": f"Bearer {self.access}"}


class WSClient:
    def __init__(self, srv: TestServer, s: Session) -> None:
        self.srv = srv
        self.s = s
        self.ws: Any = None
        self.events: list[dict[str, Any]] = []
        self.waiters: dict[str, asyncio.Future[dict[str, Any]]] = {}
        self._n = 0
        self._cond = asyncio.Condition()
        self._reader: asyncio.Task[None] | None = None
        self.close_code: int | None = None
        self.closed = asyncio.Event()

    async def connect(self, **hello: Any) -> dict[str, Any]:
        self.ws = await ws_connect(self.srv.ws_url, max_size=32 * 1024 * 1024, ping_interval=None)
        self._reader = asyncio.create_task(self._read())
        msg = {"t": "hello", "protocol": 1, "access_token": self.s.access, "cursor": 0, "state_cursor": 0}
        msg.update(hello)
        return await self.req_raw(msg)

    async def _read(self) -> None:
        try:
            async for raw in self.ws:
                m = json.loads(raw)
                re = m.get("re")
                if re is not None and re in self.waiters and m.get("t") in ("ack", "error", "welcome", "pong"):
                    fut = self.waiters.pop(re)
                    if not fut.done():
                        fut.set_result(m)
                    continue
                async with self._cond:
                    self.events.append(m)
                    self._cond.notify_all()
        except ConnectionClosed:
            pass
        finally:
            self.close_code = self.ws.close_code
            self.closed.set()
            async with self._cond:
                self._cond.notify_all()

    async def req_raw(self, msg: dict[str, Any], timeout: float = 5) -> dict[str, Any]:
        self._n += 1
        rid = str(self._n)
        msg = {**msg, "id": rid}
        fut: asyncio.Future[dict[str, Any]] = asyncio.get_running_loop().create_future()
        self.waiters[rid] = fut
        await self.ws.send(json.dumps(msg))
        return await asyncio.wait_for(fut, timeout)

    async def req(self, t: str, **fields: Any) -> dict[str, Any]:
        return await self.req_raw({"t": t, **fields})

    async def ack(self, t: str, **fields: Any) -> dict[str, Any]:
        r = await self.req(t, **fields)
        assert r["t"] == "ack", r
        return r

    async def err(self, t: str, **fields: Any) -> dict[str, Any]:
        r = await self.req(t, **fields)
        assert r["t"] == "error", r
        return r

    async def send(self, msg: dict[str, Any]) -> None:
        await self.ws.send(json.dumps(msg))

    async def event(self, t: str, timeout: float = 3, pred: Any = None) -> dict[str, Any]:
        async def find() -> dict[str, Any]:
            async with self._cond:
                while True:
                    for i, m in enumerate(self.events):
                        if m.get("t") == t and (pred is None or pred(m)):
                            return self.events.pop(i)
                    if self.closed.is_set():
                        raise AssertionError(f"conexão fechada esperando {t} (code {self.close_code})")
                    await self._cond.wait()

        return await asyncio.wait_for(find(), timeout)

    async def no_event(self, t: str, timeout: float = 0.3, pred: Any = None) -> None:
        with contextlib.suppress(TimeoutError):
            m = await self.event(t, timeout, pred)
            raise AssertionError(f"evento inesperado: {m}")

    def drain(self, t: str | None = None) -> None:
        self.events = [m for m in self.events if t is not None and m.get("t") != t]

    async def wait_closed(self, timeout: float = 3) -> int | None:
        await asyncio.wait_for(self.closed.wait(), timeout)
        return self.close_code

    async def close(self) -> None:
        if self.ws is not None:
            with contextlib.suppress(Exception):
                await self.ws.close()
        if self._reader is not None:
            with contextlib.suppress(Exception):
                await asyncio.wait_for(self._reader, 2)


class _Server(uvicorn.Server):
    @contextlib.contextmanager
    def capture_signals(self):  # type: ignore[no-untyped-def,override]
        yield

    async def shutdown(self, sockets=None):  # type: ignore[no-untyped-def]
        ctx = getattr(self.config.app.state, "ctx", None)
        if ctx is not None:
            await ctx.hub.close_all(1001, "server_restart")
        await super().shutdown(sockets)


class TestServer:
    __test__ = False

    def __init__(self, settings: Settings, turnstile: Any = None) -> None:
        self.settings = settings
        self.mailer = Mailer(settings)
        transport = httpx.MockTransport(turnstile) if turnstile else None
        self.app_http = httpx.AsyncClient(transport=transport)
        self.app = create_app(settings, mailer=self.mailer, http=self.app_http, configure_logging=False)
        self.clients: list[WSClient] = []

    async def start(self) -> TestServer:
        cfg = uvicorn.Config(
            self.app,
            host="127.0.0.1",
            port=0,
            log_level="warning",
            lifespan="on",
            ws_max_size=16 * 1024 * 1024,
            ws_ping_interval=None,
            timeout_graceful_shutdown=2,
        )
        self.server = _Server(cfg)
        self.task = asyncio.create_task(self.server.serve())
        for _ in range(500):
            if self.server.started:
                break
            await asyncio.sleep(0.01)
        port = self.server.servers[0].sockets[0].getsockname()[1]
        self.base = f"http://127.0.0.1:{port}"
        self.ws_url = f"ws://127.0.0.1:{port}/ws"
        self.http = httpx.AsyncClient(base_url=self.base, timeout=10)
        return self

    async def stop(self) -> None:
        for c in self.clients:
            await c.close()
        await self.http.aclose()
        self.server.should_exit = True
        await self.task
        await self.app_http.aclose()

    @property
    def ctx(self) -> Any:
        return self.app.state.ctx

    # ---------- e-mail ----------
    def last_code(self, email: str, purpose: str | None = None) -> str:
        for m in reversed(self.mailer.outbox):
            if m.to == email and m.kind.startswith("code:") and (purpose is None or m.kind == f"code:{purpose}"):
                return m.meta["code"]
        raise AssertionError(f"nenhum código para {email}")

    def mails(self, email: str) -> list[Any]:
        return [m for m in self.mailer.outbox if m.to == email]

    async def flush_mail(self) -> None:
        await asyncio.sleep(0.05)

    # ---------- fluxos ----------
    def device(self, client: str = "desktop", can_host: bool = True, name: str = "PC") -> dict[str, Any]:
        platform = {"desktop": "linux", "mobile": "android", "web": "web"}.get(client, "linux")
        return {"name": name, "platform": platform, "client": client, "app_version": "0.6.0", "can_host": can_host}

    async def signup(self, email: str | None = None, name: str = "Ana", **dev: Any) -> Session:
        email = email or f"u{uuid.uuid4().hex[:10]}@example.com"
        ip = {"X-Real-IP": rand_ip()}
        r = await self.http.post("/api/v1/auth/signup/start", json={"email": email, "name": name}, headers=ip)
        assert r.status_code == 202, r.text
        await self.flush_mail()
        code = self.last_code(email, "signup")
        r = await self.http.post(
            "/api/v1/auth/signup/verify", json={"email": email, "code": code, "device": self.device(**dev)}, headers=ip
        )
        assert r.status_code == 201, r.text
        b = r.json()
        return Session(email, b["user"]["id"], b["device_id"], b["access_token"], b.get("refresh_token"), b)

    async def login(self, email: str, **dev: Any) -> Session:
        ip = {"X-Real-IP": rand_ip()}
        r = await self.http.post("/api/v1/auth/code/request", json={"email": email}, headers=ip)
        assert r.status_code == 202, r.text
        await self.flush_mail()
        code = self.last_code(email, "login")
        r = await self.http.post(
            "/api/v1/auth/code/verify", json={"email": email, "code": code, "device": self.device(**dev)}, headers=ip
        )
        assert r.status_code == 200, r.text
        b = r.json()
        return Session(email, b["user"]["id"], b["device_id"], b["access_token"], b.get("refresh_token"), b)

    async def ws(self, s: Session, **hello: Any) -> tuple[WSClient, dict[str, Any]]:
        c = WSClient(self, s)
        self.clients.append(c)
        w = await c.connect(**hello)
        assert w["t"] == "welcome", w
        return c, w

    async def push(self, s: Session, items: list[dict[str, Any]], **extra: Any) -> httpx.Response:
        body = {"push_id": str(uuid.uuid4()), "items": items, **extra}
        return await self.http.post("/api/v1/sync/push", json=body, headers=s.h)


def item(
    type_: str, id_: str, scope: str | None = None, base_rev: int = 0, deleted: bool = False, **kw: Any
) -> dict[str, Any]:
    it: dict[str, Any] = {
        "type": type_,
        "id": id_,
        "scope": scope,
        "base_rev": base_rev,
        "rev": base_rev + 1,
        "deleted": deleted,
    }
    if not deleted:
        it["env"] = kw.pop("env", None) or env()
    it["blobs"] = kw.pop("blobs", [])
    it.update(kw)
    return it


def chat(cid: str, base_rev: int = 0, **kw: Any) -> dict[str, Any]:
    return item("chat", cid, cid, base_rev, **kw)


def msg(mid: str, cid: str, base_rev: int = 0, **kw: Any) -> dict[str, Any]:
    return item("message", mid, cid, base_rev, **kw)


@pytest.fixture
async def make_server(tmp_path: Path):  # type: ignore[no-untyped-def]
    servers: list[TestServer] = []

    async def factory(turnstile: Any = None, **over: Any) -> TestServer:
        srv = TestServer(make_settings(tmp_path, **over), turnstile)
        await srv.start()
        servers.append(srv)
        return srv

    yield factory
    for s in servers:
        await s.stop()


@pytest.fixture
async def srv(make_server: Any) -> TestServer:
    return await make_server()
