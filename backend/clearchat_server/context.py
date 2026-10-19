"""Estado da aplicação (um por processo da api), guardado em app.state.ctx."""

from __future__ import annotations

from dataclasses import dataclass
from typing import TYPE_CHECKING

import httpx
from fastapi import Request, WebSocket
from sqlalchemy.ext.asyncio import AsyncEngine

from .config import Settings
from .instance.service import InstanceSettingsCache
from .mail import Mailer
from .ratelimit import RateLimiter

if TYPE_CHECKING:
    from .realtime.coordinator import Coordinator
    from .realtime.hub import Hub
    from .sync.blobs import BlobStore


@dataclass
class AppContext:
    settings: Settings
    engine: AsyncEngine
    mailer: Mailer
    http: httpx.AsyncClient
    limiter: RateLimiter
    instance: InstanceSettingsCache
    hub: Hub
    coordinator: Coordinator
    blobs: BlobStore


def get_ctx(request: Request) -> AppContext:
    ctx: AppContext = request.app.state.ctx
    return ctx


def ws_ctx(ws: WebSocket) -> AppContext:
    ctx: AppContext = ws.app.state.ctx
    return ctx


def request_ip(request: Request) -> str | None:
    ip: str | None = getattr(request.state, "client_ip", None)
    return ip
