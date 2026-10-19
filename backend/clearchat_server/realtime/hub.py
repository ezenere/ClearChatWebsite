"""Hub de WebSocket: registro device_id → conexão (uma por dispositivo), fila de envio por conexão com
backpressure (> 1000 mensagens ou 8 MiB → fecha 4429), inscrições por chat."""

from __future__ import annotations

import asyncio
import contextlib
import logging
import time
import uuid
from collections import deque
from typing import Any

from fastapi import WebSocket

from ..util import json_dumps

log = logging.getLogger("clearchat.ws")

MAX_QUEUE_MSGS = 1000
MAX_QUEUE_BYTES = 8 * 1024 * 1024


class Conn:
    def __init__(
        self,
        ws: WebSocket,
        user_id: uuid.UUID,
        device_id: uuid.UUID,
        device_name: str,
        platform: str,
        client: str,
        can_host: bool,
    ) -> None:
        self.ws = ws
        self.user_id = user_id
        self.device_id = device_id
        self.device_name = device_name
        self.platform = platform
        self.client = client
        self.can_host = can_host
        self.subscriptions: set[str] = set()
        self.last_frame_at = time.monotonic()
        self.closed = False
        self._buf: deque[str] = deque()
        self._bytes = 0
        self._wake = asyncio.Event()
        self._close: tuple[int, str] | None = None
        self._task: asyncio.Task[None] | None = None
        self.done = asyncio.Event()

    # ---------- envio ----------
    def send(self, msg: dict[str, Any] | str) -> None:
        if self.closed or self._close is not None:
            return
        s = msg if isinstance(msg, str) else json_dumps(msg)
        self._buf.append(s)
        self._bytes += len(s)
        if len(self._buf) > MAX_QUEUE_MSGS or self._bytes > MAX_QUEUE_BYTES:
            log.warning("fila de envio estourou; fechando 4429", extra={"device_id": str(self.device_id)})
            self._buf.clear()
            self._bytes = 0
            self._close = (4429, "rate_limited")
        self._wake.set()

    def send_front(self, msg: dict[str, Any]) -> None:
        s = json_dumps(msg)
        self._buf.appendleft(s)
        self._bytes += len(s)
        self._wake.set()

    def start(self) -> None:
        self._task = asyncio.create_task(self._run())

    async def _run(self) -> None:
        try:
            while True:
                while self._buf:
                    s = self._buf.popleft()
                    self._bytes -= len(s)
                    await self.ws.send_text(s)
                if self._close is not None:
                    code, reason = self._close
                    with contextlib.suppress(Exception):
                        await self.ws.close(code=code, reason=reason)
                    return
                self._wake.clear()
                if self._buf or self._close is not None:
                    continue
                await self._wake.wait()
        except Exception as e:  # conexão já caiu
            log.debug("envio interrompido", extra={"error": type(e).__name__})
        finally:
            self.closed = True
            self.done.set()

    def close(self, code: int, reason: str = "") -> None:
        """Fecha depois de enviar o que já está na fila."""
        if self._close is None:
            self._close = (code, reason)
        self._wake.set()
        if self._task is None:  # ainda não começou (antes do welcome)
            self.closed = True

    async def close_now(self, code: int, reason: str = "") -> None:
        self.close(code, reason)
        if self._task is None:
            with contextlib.suppress(Exception):
                await self.ws.close(code=code, reason=reason)
            return
        with contextlib.suppress(asyncio.TimeoutError):
            await asyncio.wait_for(self.done.wait(), 5)

    async def stop(self) -> None:
        if self._task is not None and not self._task.done():
            self._task.cancel()
            with contextlib.suppress(asyncio.CancelledError, Exception):
                await self._task


class Hub:
    def __init__(self) -> None:
        self.by_device: dict[uuid.UUID, Conn] = {}
        self.by_user: dict[uuid.UUID, set[Conn]] = {}

    def register(self, conn: Conn) -> Conn | None:
        old = self.by_device.get(conn.device_id)
        if old is not None:
            self.by_user.get(old.user_id, set()).discard(old)
        self.by_device[conn.device_id] = conn
        self.by_user.setdefault(conn.user_id, set()).add(conn)
        return old

    def unregister(self, conn: Conn) -> bool:
        """Remove a conexão; True se ela era a conexão atual do dispositivo."""
        users = self.by_user.get(conn.user_id)
        if users is not None:
            users.discard(conn)
            if not users:
                self.by_user.pop(conn.user_id, None)
        if self.by_device.get(conn.device_id) is conn:
            del self.by_device[conn.device_id]
            return True
        return False

    def is_online(self, device_id: uuid.UUID | None) -> bool:
        return device_id is not None and device_id in self.by_device

    def get(self, device_id: uuid.UUID | None) -> Conn | None:
        return None if device_id is None else self.by_device.get(device_id)

    def user_conns(self, user_id: uuid.UUID) -> list[Conn]:
        return list(self.by_user.get(user_id, ()))

    def send_user(self, user_id: uuid.UUID, msg: dict[str, Any], exclude: Conn | None = None) -> None:
        s = json_dumps(msg)
        for c in self.user_conns(user_id):
            if c is not exclude:
                c.send(s)

    def send_device(self, device_id: uuid.UUID | None, msg: dict[str, Any]) -> bool:
        c = self.get(device_id)
        if c is None:
            return False
        c.send(msg)
        return True

    def subscribers(self, user_id: uuid.UUID, chat_id: str) -> list[Conn]:
        return [c for c in self.user_conns(user_id) if chat_id in c.subscriptions]

    def close_user(self, user_id: uuid.UUID, code: int, reason: str = "", final: dict[str, Any] | None = None) -> None:
        for c in self.user_conns(user_id):
            if final is not None:
                c.send(final)
            c.close(code, reason)

    def close_device(self, device_id: uuid.UUID, code: int, reason: str = "") -> None:
        c = self.by_device.get(device_id)
        if c is not None:
            c.close(code, reason)

    async def close_all(self, code: int = 1001, reason: str = "server_restart") -> None:
        conns = [c for cs in self.by_user.values() for c in cs]
        for c in conns:
            c.close(code, reason)
        for c in conns:
            with contextlib.suppress(asyncio.TimeoutError):
                await asyncio.wait_for(c.done.wait(), 2)
