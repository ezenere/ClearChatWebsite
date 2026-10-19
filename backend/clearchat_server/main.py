"""Aplicação FastAPI da api: rotas sob BASE_PATH (`<base>/api`, `<base>/ws`), middlewares, ciclo de vida."""

from __future__ import annotations

import asyncio
import contextlib
import logging
import time
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import Any

import httpx
from fastapi import APIRouter, Depends, FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException as StarletteHTTPException
from starlette.types import ASGIApp, Receive, Scope, Send

from .auth import account as account_routes
from .auth import routes as auth_routes
from .config import Settings
from .context import AppContext
from .db import make_engine
from .errors import ApiError
from .instance import routes as instance_routes
from .instance.service import InstanceSettingsCache
from .jobs import gc_loop, notify_listener
from .keys import routes as keys_routes
from .logging_setup import setup_logging
from .mail import Mailer
from .ratelimit import RateLimiter
from .realtime.coordinator import Coordinator
from .realtime.hub import Hub
from .realtime.ws import ws_endpoint
from .sync import blobs as blob_routes
from .sync import routes as sync_routes
from .sync.blobs import BlobStore
from .util import client_ip

log = logging.getLogger("clearchat.api")


class ClientIPMiddleware:
    """Resolve o IP real (TRUSTED_PROXY_CIDRS) para HTTP e WebSocket e registra as requisições."""

    def __init__(self, app: ASGIApp, settings: Settings) -> None:
        self.app = app
        self.settings = settings

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] not in ("http", "websocket"):
            await self.app(scope, receive, send)
            return
        headers = {k.decode("latin-1").lower(): v.decode("latin-1") for k, v in scope.get("headers", [])}
        client = scope.get("client")
        peer = client[0] if client else None
        ip = client_ip(peer, headers, self.settings)
        scope.setdefault("state", {})["client_ip"] = ip
        if scope["type"] == "websocket":
            await self.app(scope, receive, send)
            return
        start = time.monotonic()
        status = {"code": 500}

        async def _send(msg: Any) -> None:
            if msg["type"] == "http.response.start":
                status["code"] = msg["status"]
            await send(msg)

        try:
            await self.app(scope, receive, _send)
        finally:
            log.info(
                "http",
                extra={
                    "method": scope.get("method"),
                    "path": scope.get("path"),  # sem query string
                    "status": status["code"],
                    "ms": round((time.monotonic() - start) * 1000, 1),
                    "ip": ip,
                    "client": headers.get("x-clearchat-client", "")[:64],
                },
            )


def protocol_header(request: Request) -> None:
    v = request.headers.get("x-clearchat-protocol")
    if v is not None and v.strip() != "1":
        raise ApiError("protocol_unsupported", details={"min": 1, "max": 1})


def create_app(
    settings: Settings | None = None,
    *,
    mailer: Mailer | None = None,
    http: httpx.AsyncClient | None = None,
    configure_logging: bool = True,
) -> FastAPI:
    settings = settings or Settings()
    if configure_logging:
        setup_logging(settings.log_level, settings.log_format)
    if not settings.server_secret or len(settings.server_secret) < 16:
        raise RuntimeError("SERVER_SECRET ausente ou curto demais (gere com `openssl rand -base64 48`)")

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        engine = make_engine(settings.database_url, settings.db_pool_size)
        hub = Hub()
        ctx = AppContext(
            settings=settings,
            engine=engine,
            mailer=mailer or Mailer(settings),
            http=http or httpx.AsyncClient(timeout=10),
            limiter=RateLimiter(engine),
            instance=InstanceSettingsCache(engine, settings),
            hub=hub,
            coordinator=Coordinator(engine, hub, settings),
            blobs=BlobStore(settings),
        )
        app.state.ctx = ctx
        await ctx.coordinator.boot()
        tasks: list[asyncio.Task[None]] = []
        if settings.jobs_enabled:
            tasks.append(asyncio.create_task(gc_loop(ctx)))
        if settings.notify_listener_enabled:
            tasks.append(asyncio.create_task(notify_listener(ctx)))
        log.info("api pronta", extra={"base_url": settings.public_base_url})
        try:
            yield
        finally:
            await hub.close_all(1001, "server_restart")
            await ctx.coordinator.shutdown()
            for t in tasks:
                t.cancel()
            for t in tasks:
                with contextlib.suppress(asyncio.CancelledError, Exception):
                    await t
            if http is None:
                await ctx.http.aclose()
            await engine.dispose()

    app = FastAPI(
        title="ClearChat Sync",
        lifespan=lifespan,
        docs_url=None,
        redoc_url=None,
        openapi_url=None,
    )
    base = settings.base_path

    @app.exception_handler(ApiError)
    async def _api_error(_r: Request, e: ApiError) -> JSONResponse:
        return JSONResponse(e.body(), status_code=e.status, headers=e.headers)

    @app.exception_handler(RequestValidationError)
    async def _validation(_r: Request, e: RequestValidationError) -> JSONResponse:
        fields = [".".join(str(x) for x in err.get("loc", ())) for err in e.errors()]
        err = ApiError("invalid_request", details={"fields": fields[:20]})
        return JSONResponse(err.body(), status_code=400)

    @app.exception_handler(StarletteHTTPException)
    async def _http(_r: Request, e: StarletteHTTPException) -> JSONResponse:
        code = {404: "not_found", 401: "unauthorized", 403: "forbidden", 413: "payload_too_large"}.get(
            e.status_code, "invalid_request"
        )
        err = ApiError(code, status=e.status_code if e.status_code != 405 else 404)
        return JSONResponse(err.body(), status_code=err.status)

    @app.exception_handler(Exception)
    async def _internal(_r: Request, e: Exception) -> JSONResponse:
        log.exception("erro inesperado", exc_info=e)
        return JSONResponse(ApiError("internal").body(), status_code=500)

    v1 = APIRouter(dependencies=[Depends(protocol_header)])
    v1.include_router(auth_routes.router)
    v1.include_router(account_routes.router)
    v1.include_router(keys_routes.router)
    v1.include_router(sync_routes.router)
    v1.include_router(blob_routes.router)
    app.include_router(v1, prefix=f"{base}/api/v1")
    app.include_router(instance_routes.router, prefix=f"{base}/api")
    app.add_api_websocket_route(f"{base}/ws", ws_endpoint)

    if settings.cors_origins:
        app.add_middleware(
            CORSMiddleware,
            allow_origins=settings.cors_origins,
            allow_credentials=True,
            allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE"],
            allow_headers=[
                "Authorization",
                "Content-Type",
                "X-Content-SHA256",
                "X-ClearChat-Client",
                "X-ClearChat-Protocol",
            ],
            expose_headers=["X-Content-SHA256", "Retry-After"],
        )
    app.add_middleware(ClientIPMiddleware, settings=settings)
    return app


def _lazy_app() -> FastAPI:
    return create_app()


class _LazyApp:
    """`uvicorn clearchat_server.main:app` sem criar a app na importação (testes importam o módulo)."""

    _app: FastAPI | None = None

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if self._app is None:
            self._app = _lazy_app()
        await self._app(scope, receive, send)


app = _LazyApp()
