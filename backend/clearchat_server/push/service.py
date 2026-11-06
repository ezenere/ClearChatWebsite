"""Notificações push (SYNC_PROTOCOL §22): destinos, mensagem ao FCM, envio em segundo plano e o aviso
"host caiu" gerado pelo servidor (§22.6, com histerese).

O envio nunca segura a requisição: `POST /push` responde com o número de destinos e as chamadas ao FCM
rodam em tarefas (em paralelo, com teto e timeout curto). Falhas só vão para o log (sem tokens nem
conteúdo); token que o FCM diz não valer mais é apagado."""

from __future__ import annotations

import asyncio
import contextlib
import logging
import re
import secrets
import uuid
from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import TYPE_CHECKING, Any

import httpx
from sqlalchemy.ext.asyncio import AsyncConnection, AsyncEngine

from ..config import Settings
from ..db import execute, fetchall, fetchone
from ..util import iso, json_dumps, utcnow
from .fcm import FcmClient, ServiceAccount, ServiceAccountError

if TYPE_CHECKING:
    from ..realtime.hub import Hub

log = logging.getLogger("clearchat.push")

# kinds aceitos em POST /push (§22.3); `host_offline` só o servidor gera (§22.6)
CLIENT_KINDS = frozenset({"approval", "question", "retry", "reply", "error", "dismiss"})
# android.ttl por kind (§22.3); host_offline: mesmo das pendências
TTL_S = {
    "approval": 3600,
    "question": 3600,
    "retry": 3600,
    "dismiss": 3600,
    "reply": 86400,
    "error": 86400,
    "host_offline": 3600,
}
TAG_RE = re.compile(r"\A[0-9a-f]{32}\Z")
PUSH_MAX_ENV_BYTES = 2048
PUSH_MAX_TO = 20
TOKEN_MAX_CHARS = 4096
PROVIDERS = ("fcm",)


@dataclass(frozen=True)
class Target:
    device_id: uuid.UUID
    token: str


def build_message(
    token: str, kind: str, tag: str, env_json: str, sent_at: str, extra: dict[str, str] | None = None
) -> dict[str, Any]:
    """Mensagem FCM só de dados (§22.3): o app monta a notificação."""
    data = {"v": "1", "kind": kind, "tag": tag, "env": env_json, "sent_at": sent_at, **(extra or {})}
    return {
        "token": token,
        "data": data,
        "android": {
            "collapse_key": tag,
            "priority": "normal" if kind == "dismiss" else "high",
            "ttl": f"{TTL_S.get(kind, 3600)}s",
        },
    }


async def push_targets(
    conn: AsyncConnection, user_id: uuid.UUID, sender: uuid.UUID | None, to: list[uuid.UUID] | None
) -> list[Target]:
    """Dispositivos ativos do usuário com token: `to = None` → todos menos o remetente; lista → só os
    dela (ids de outros usuários, revogados ou sem token ficam de fora)."""
    if to is None:
        rows = await fetchall(
            conn,
            "SELECT id, push_token FROM devices WHERE user_id = :u AND revoked_at IS NULL "
            "AND push_token IS NOT NULL AND (CAST(:s AS uuid) IS NULL OR id <> CAST(:s AS uuid)) ORDER BY created_at",
            {"u": user_id, "s": sender},
        )
    else:
        if not to:
            return []
        rows = await fetchall(
            conn,
            "SELECT id, push_token FROM devices WHERE user_id = :u AND revoked_at IS NULL "
            "AND push_token IS NOT NULL AND id = ANY(CAST(:d AS uuid[])) ORDER BY created_at",
            {"u": user_id, "d": to},
        )
    return [Target(r.id, r.push_token) for r in rows]


class PushService:
    def __init__(self, engine: AsyncEngine, settings: Settings, http: httpx.AsyncClient, hub: Hub) -> None:
        self.engine = engine
        self.settings = settings
        self.hub = hub
        self.fcm: FcmClient | None = None
        if settings.fcm_service_account_file:
            try:
                account = ServiceAccount.load(settings.fcm_service_account_file)
            except ServiceAccountError as e:
                # a instância continua sem push (features.push = null); o motivo vai ao log, nunca o conteúdo
                log.error("push desligado: %s", e)
            else:
                self.fcm = FcmClient(account, http, settings.fcm_base_url, settings.fcm_timeout_s)
                log.info("push ligado (FCM)", extra={"project_id": account.project_id})
        self._sem = asyncio.Semaphore(settings.fcm_max_concurrency)
        self._tasks: set[asyncio.Task[None]] = set()
        # (user_id, device_id do host) → timer do aviso "host caiu" + chats que rodavam na queda
        self._offline: dict[tuple[uuid.UUID, uuid.UUID], tuple[asyncio.Task[None], set[str]]] = {}
        self._closing = False

    # ------------------------------------------------------------------ estado
    @property
    def configured(self) -> bool:
        return self.fcm is not None

    def features(self) -> dict[str, Any] | None:
        return {"providers": list(PROVIDERS)} if self.configured else None

    def _spawn(self, coro: Any) -> None:
        if self._closing:
            coro.close()
            return
        t: asyncio.Task[None] = asyncio.create_task(coro)
        self._tasks.add(t)
        t.add_done_callback(self._tasks.discard)

    async def close(self) -> None:
        self._closing = True
        for task, _ in self._offline.values():
            task.cancel()
        self._offline.clear()
        if self._tasks:
            # envios em andamento têm timeout curto: espera um pouco e cancela o resto
            _, pending = await asyncio.wait(set(self._tasks), timeout=2)
            for t in pending:
                t.cancel()
            for t in pending:
                with contextlib.suppress(asyncio.CancelledError, Exception):
                    await t

    async def drain(self) -> None:
        """Espera os envios em andamento (testes)."""
        while self._tasks:
            await asyncio.gather(*list(self._tasks), return_exceptions=True)

    # ------------------------------------------------------------------ envio
    def dispatch(
        self, targets: list[Target], kind: str, tag: str, env_json: str, extra: dict[str, str] | None = None
    ) -> None:
        """Agenda o envio (não espera o FCM)."""
        if self.fcm is None or not targets:
            return
        sent_at = iso(utcnow()) or ""
        self._spawn(self._deliver(targets, kind, tag, env_json, sent_at, extra))

    async def _deliver(
        self, targets: list[Target], kind: str, tag: str, env_json: str, sent_at: str, extra: dict[str, str] | None
    ) -> None:
        await asyncio.gather(
            *(self._send_one(t, build_message(t.token, kind, tag, env_json, sent_at, extra)) for t in targets),
            return_exceptions=True,
        )

    async def _send_one(self, target: Target, message: dict[str, Any]) -> None:
        fcm = self.fcm
        if fcm is None:
            return
        async with self._sem:
            try:
                # teto total (token + envio + uma renovação), além dos timeouts por fase do httpx
                async with asyncio.timeout(self.settings.fcm_timeout_s * 3):
                    status, code = await fcm.send(message)
            except TimeoutError:
                log.warning("push: envio expirou", extra={"device_id": str(target.device_id)})
                return
            except Exception:
                log.exception("push: erro inesperado no envio")
                return
        if status == "ok":
            return
        if status == "invalid_token":
            await self._drop_token(target)
            log.info("push: token inválido apagado", extra={"device_id": str(target.device_id), "fcm": code})
        else:
            log.warning("push: envio falhou", extra={"device_id": str(target.device_id), "fcm": code})

    async def _drop_token(self, target: Target) -> None:
        # só se o token ainda for o mesmo (o app pode ter registrado um novo no meio-tempo)
        try:
            async with self.engine.begin() as conn:
                await execute(
                    conn,
                    "UPDATE devices SET push_token = NULL, push_provider = NULL, push_updated_at = now() "
                    "WHERE id = :d AND push_token = :t",
                    {"d": target.device_id, "t": target.token},
                )
        except Exception:
            log.exception("push: falha ao apagar token inválido")

    # ------------------------------------------------------------------ host caiu (§22.6)
    def host_dropped(self, user_id: uuid.UUID, device_id: uuid.UUID, chat_ids: list[str], dropped_at: datetime) -> None:
        """Fim da tolerância de um host com chats rodando: agenda o aviso para `dropped_at +
        HOST_OFFLINE_PUSH_DELAY_S` (a queda conta desde que o WebSocket fechou). Várias varreduras da
        mesma queda juntam os chats num timer só."""
        if self.fcm is None or self._closing or not chat_ids:
            return
        key = (user_id, device_id)
        cur = self._offline.get(key)
        if cur is not None and not cur[0].done():
            cur[1].update(chat_ids)
            return
        chats = set(chat_ids)
        delay = (dropped_at + timedelta(seconds=self.settings.host_offline_push_delay_s) - utcnow()).total_seconds()

        async def runner() -> None:
            try:
                await asyncio.sleep(max(0.0, delay))
                if self._offline.get(key, (None,))[0] is asyncio.current_task():
                    self._offline.pop(key, None)
                await self._host_offline_due(user_id, device_id, chats)
            except asyncio.CancelledError:
                pass
            except Exception:
                log.exception("push: erro no aviso de host offline")

        self._offline[key] = (asyncio.create_task(runner()), chats)

    async def _host_offline_due(self, user_id: uuid.UUID, device_id: uuid.UUID, chats: set[str]) -> None:
        if self.hub.is_online(device_id):
            return
        cooldown = timedelta(seconds=self.settings.host_offline_push_cooldown_s)
        async with self.engine.begin() as conn:
            dev = await fetchone(
                conn,
                "SELECT name, offline_push_tag, offline_push_at FROM devices "
                "WHERE id = :d AND user_id = :u AND revoked_at IS NULL FOR UPDATE",
                {"d": device_id, "u": user_id},
            )
            if dev is None:
                return
            # ainda é o host de algum dos chats que rodavam e continua fora (ninguém assumiu, não voltou)
            row = await fetchone(
                conn,
                "SELECT chat_id FROM chat_states WHERE user_id = :u AND host_device_id = :d "
                "AND host_dropped_at IS NOT NULL AND chat_id = ANY(CAST(:c AS text[])) ORDER BY chat_id LIMIT 1",
                {"u": user_id, "d": device_id, "c": sorted(chats)},
            )
            if row is None:
                return
            now = utcnow()
            if dev.offline_push_at is not None and now - dev.offline_push_at < cooldown:
                return
            targets = await push_targets(conn, user_id, device_id, None)
            if not targets:
                return
            tag = dev.offline_push_tag or secrets.token_hex(16)
            await execute(
                conn,
                "UPDATE devices SET offline_push_tag = :t, offline_push_at = :now, offline_push_shown = true "
                "WHERE id = :d",
                {"t": tag, "now": now, "d": device_id},
            )
        self.dispatch(targets, "host_offline", tag, "", {"chat_id": row.chat_id, "device_name": dev.name})

    async def host_back(self, user_id: uuid.UUID, device_id: uuid.UUID) -> None:
        """O host reconectou: cancela o aviso pendente e apaga (`dismiss`) o que foi mostrado."""
        entry = self._offline.pop((user_id, device_id), None)
        if entry is not None:
            entry[0].cancel()
        if self.fcm is None:
            return
        async with self.engine.begin() as conn:
            dev = await fetchone(
                conn,
                "UPDATE devices SET offline_push_shown = false WHERE id = :d AND offline_push_shown "
                "RETURNING offline_push_tag",
                {"d": device_id},
            )
            if dev is None or not dev.offline_push_tag:
                return
            targets = await push_targets(conn, user_id, device_id, None)
        self.dispatch(targets, "dismiss", dev.offline_push_tag, "")

    def forget_devices(self, device_ids: list[uuid.UUID]) -> None:
        for key in [k for k in self._offline if k[1] in device_ids]:
            self._offline.pop(key)[0].cancel()

    def forget_user(self, user_id: uuid.UUID) -> None:
        for key in [k for k in self._offline if k[0] == user_id]:
            self._offline.pop(key)[0].cancel()


def env_json(env: dict[str, Any]) -> str:
    return json_dumps(env)
