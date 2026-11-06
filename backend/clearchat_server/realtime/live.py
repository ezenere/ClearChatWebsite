"""Chats só ao vivo (SYNC_PROTOCOL §23): vínculos em memória por chat anunciado por um host.

Nada daqui é persistido (banco, disco, filas) nem vai ao log além de contagens: o envelope do anúncio
(`env`, cifrado com K_stream) só é guardado em memória enquanto o host está conectado (ou na tolerância
de queda) e retransmitido aos outros dispositivos do usuário que declararam `caps: ["live_chats"]`.
Reinício do servidor apaga tudo: os hosts reanunciam a cada `welcome`. Um processo só (o que segura as
conexões WebSocket) — ver docs/ARCHITECTURE.md."""

from __future__ import annotations

import asyncio
import logging
import math
import time
import uuid
from collections import deque
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import datetime
from typing import TYPE_CHECKING, Any

from sqlalchemy.ext.asyncio import AsyncEngine

from ..config import Settings
from ..db import fetchall
from ..errors import ApiError
from ..sync.envelope import parse_envelope
from ..util import RECORD_ID_RE, iso, json_dumps, utcnow
from .hub import Conn, Hub

if TYPE_CHECKING:
    from ..push.service import PushService

log = logging.getLogger("clearchat.live")

LIVE_CAP = "live_chats"
MAX_EPOCH = 2**53 - 1
LIVE_ANNOUNCE_MAX_ENV_BYTES = 2048
# itens por frame de live.announce (o host anuncia no máximo LIVE_MAX_CHATS_PER_HOST; o resto vira quota)
LIVE_ANNOUNCE_MAX_ITEMS = 1000
LIVE_WITHDRAW_MAX_IDS = 1000
# reason do live.withdraw (host) → reason do live.removed (visualizadores)
WITHDRAW_REASONS = {"deleted": "deleted", "quit": "host_quit", "withdrawn": "withdrawn"}
# kinds de comando remoto que só existem para chats com vínculo ao vivo (§8.6)
LIVE_ONLY_KINDS = frozenset(
    {"history.list", "history.changes", "history.item", "chat.update", "attach.put", "attach.get"}
)
CONTENT_TYPES = ("session", "message")

# limites por conexão, em memória (§17.3): (quantidade, janela em s)
RATE_FRAMES = (10, 1.0)  # live.announce + live.withdraw
RATE_LIST = (10, 60.0)
RATE_REFRESH = (6, 60.0)
# abuso contínuo de live.announce/withdraw: tantas recusas por taxa nesta janela → fecha 4429
ABUSE_MAX, ABUSE_WINDOW_S = 20, 10.0


@dataclass
class LiveBinding:
    chat_id: str
    host_device_id: uuid.UUID
    host_name: str
    host_platform: str
    epoch: int
    arev: int
    running: bool
    env: dict[str, Any]
    announced_at: datetime


@dataclass
class _Host:
    """Estado de um dispositivo host com vínculos (por dispositivo; um dispositivo é de um usuário só)."""

    user_id: uuid.UUID
    chats: set[str] = field(default_factory=set)
    grace: asyncio.Task[None] | None = None  # tolerância de queda em andamento
    reannounce: asyncio.Task[None] | None = None  # prazo para reanunciar depois do welcome
    awaiting: set[str] = field(default_factory=set)  # vínculos ainda sem reanúncio desde o welcome


def _rate_ok(store: dict[str, deque[float]], key: str, limit: tuple[int, float], now: float) -> bool:
    n, window = limit
    dq = store.setdefault(key, deque())
    while dq and now - dq[0] > window:
        dq.popleft()
    if len(dq) >= n:
        return False
    dq.append(now)
    return True


def _int_in(v: Any, lo: int, hi: int) -> bool:
    return isinstance(v, int) and not isinstance(v, bool) and lo <= v <= hi


def live_conflict(chat_id: str, reason: str) -> ApiError:
    return ApiError("live_conflict", details={"chat_id": chat_id, "reason": reason})


class LiveRegistry:
    def __init__(
        self, engine: AsyncEngine, hub: Hub, settings: Settings, push: Callable[[], PushService | None]
    ) -> None:
        self.engine = engine
        self.hub = hub
        self.settings = settings
        self._push = push
        self.bindings: dict[uuid.UUID, dict[str, LiveBinding]] = {}  # user_id → chat_id → vínculo
        self.hosts: dict[uuid.UUID, _Host] = {}  # device_id do host → estado
        self.started = time.monotonic()
        self._closing = False

    # ------------------------------------------------------------------ consultas
    @property
    def enabled(self) -> bool:
        return self.settings.live_chats_enabled

    def get(self, user_id: uuid.UUID, chat_id: str) -> LiveBinding | None:
        return self.bindings.get(user_id, {}).get(chat_id)

    def assert_unbound(self, user_id: uuid.UUID, chat_id: str) -> None:
        """host.begin / takeover / pin / resolver divergência num chat ao vivo → live_conflict (§23.3)."""
        if self.get(user_id, chat_id) is not None:
            raise live_conflict(chat_id, "live")

    def settling_s(self) -> int:
        left = self.settings.server_restart_grace_s - (time.monotonic() - self.started)
        return max(0, math.ceil(left))

    def host_status(self, b: LiveBinding) -> str:
        return "online" if self.hub.is_online(b.host_device_id) else "grace"

    def serialize(self, b: LiveBinding) -> dict[str, Any]:
        return {
            "chat_id": b.chat_id,
            "epoch": b.epoch,
            "arev": b.arev,
            "running": b.running,
            "env": b.env,
            "host": {
                "device_id": str(b.host_device_id),
                "name": b.host_name,
                "platform": b.host_platform,
                "status": self.host_status(b),
            },
            "announced_at": iso(b.announced_at),
        }

    def _send_viewers(self, user_id: uuid.UUID, host: uuid.UUID, msg: dict[str, Any]) -> None:
        """Conexões do usuário com caps live_chats, menos a do host."""
        s = json_dumps(msg)
        for c in self.hub.user_conns(user_id):
            if LIVE_CAP in c.caps and c.device_id != host:
                c.send(s)

    @staticmethod
    def _require_cap(c: Conn) -> None:
        if LIVE_CAP not in c.caps:
            raise ApiError("invalid_request", details={"reason": "caps_required", "cap": LIVE_CAP})

    def _frame_rate(self, c: Conn) -> None:
        now = time.monotonic()
        if _rate_ok(c.live_rate, "frames", RATE_FRAMES, now):
            return
        abuse = c.live_rate.setdefault("abuse", deque())
        while abuse and now - abuse[0] > ABUSE_WINDOW_S:
            abuse.popleft()
        abuse.append(now)
        if len(abuse) >= ABUSE_MAX:
            log.warning("live: abuso de anúncios; fechando 4429", extra={"device_id": str(c.device_id)})
            c.close(4429, "rate_limited")
        raise ApiError("rate_limited", details={"retry_after": 1})

    # ------------------------------------------------------------------ remoção
    def _drop(self, user_id: uuid.UUID, chat_ids: list[str]) -> dict[uuid.UUID, list[str]]:
        """Tira os vínculos (sem avisar ninguém); devolve host → chats removidos."""
        ub = self.bindings.get(user_id)
        out: dict[uuid.UUID, list[str]] = {}
        if not ub:
            return out
        for cid in chat_ids:
            b = ub.pop(cid, None)
            if b is None:
                continue
            out.setdefault(b.host_device_id, []).append(cid)
            h = self.hosts.get(b.host_device_id)
            if h is not None:
                h.chats.discard(cid)
                h.awaiting.discard(cid)
        if not ub:
            self.bindings.pop(user_id, None)
        for host in out:
            self._gc_host(host)
        return out

    def _gc_host(self, device_id: uuid.UUID) -> None:
        h = self.hosts.get(device_id)
        if h is not None and not h.chats:
            for t in (h.grace, h.reannounce):
                if t is not None and t is not asyncio.current_task():
                    t.cancel()
            del self.hosts[device_id]

    def remove(self, user_id: uuid.UUID, chat_ids: list[str], reason: str) -> None:
        for host, ids in self._drop(user_id, chat_ids).items():
            self._send_viewers(
                user_id,
                host,
                {"t": "live.removed", "host_device_id": str(host), "chat_ids": sorted(ids), "reason": reason},
            )

    def _remove_host(self, device_id: uuid.UUID, reason: str) -> None:
        h = self.hosts.get(device_id)
        if h is not None:
            self.remove(h.user_id, sorted(h.chats), reason)

    # ------------------------------------------------------------------ host → servidor
    async def announce(self, c: Conn, data: dict[str, Any]) -> dict[str, Any]:
        self._require_cap(c)
        self._frame_rate(c)
        full, chats = data.get("full"), data.get("chats")
        if not isinstance(full, bool) or not isinstance(chats, list) or len(chats) > LIVE_ANNOUNCE_MAX_ITEMS:
            raise ApiError("invalid_request", details={"field": "full/chats"})
        rejected: list[dict[str, Any]] = []
        valid: list[tuple[str, int, int, bool, dict[str, Any]]] = []
        seen: set[str] = set()
        for raw in chats:
            cid = raw.get("chat_id") if isinstance(raw, dict) else None
            if not isinstance(cid, str) or not RECORD_ID_RE.match(cid) or cid in seen:
                rejected.append({"chat_id": cid if isinstance(cid, str) else None, "code": "invalid_request"})
                continue
            assert isinstance(raw, dict)
            seen.add(cid)
            epoch, arev, running = raw.get("epoch"), raw.get("arev"), raw.get("running")
            if not _int_in(epoch, 1, MAX_EPOCH) or not _int_in(arev, 1, MAX_EPOCH) or not isinstance(running, bool):
                rejected.append({"chat_id": cid, "code": "invalid_request"})
                continue
            try:
                env = parse_envelope(raw.get("env"), "env", max_bytes=LIVE_ANNOUNCE_MAX_ENV_BYTES).to_json()
            except ApiError:
                rejected.append({"chat_id": cid, "code": "invalid_request"})
                continue
            if len(json_dumps(env).encode()) > LIVE_ANNOUNCE_MAX_ENV_BYTES:
                rejected.append({"chat_id": cid, "code": "invalid_request"})
                continue
            assert isinstance(epoch, int) and isinstance(arev, int)
            valid.append((cid, epoch, arev, running, env))

        # exclusividade com os chats online (§23.3): registro `chat` não apagado ou linha em chat_states
        known = self.bindings.get(c.user_id, {})
        new_ids = sorted(cid for cid, *_ in valid if cid not in known)
        online: set[str] = set()
        if new_ids:
            async with self.engine.connect() as conn:
                rows = await fetchall(
                    conn,
                    "SELECT id AS chat_id FROM records WHERE user_id = :u AND type = 'chat' AND NOT deleted "
                    "AND id = ANY(CAST(:c AS text[])) "
                    "UNION SELECT chat_id FROM chat_states WHERE user_id = :u AND chat_id = ANY(CAST(:c AS text[]))",
                    {"u": c.user_id, "c": new_ids},
                )
            online = {r.chat_id for r in rows}
        if c.closed or self.hub.get(c.device_id) is not c:
            # a conexão caiu (ou foi substituída) enquanto o banco respondia: nada de vínculo órfão
            raise ApiError("invalid_request", details={"reason": "connection_closed"})

        now = utcnow()
        ub = self.bindings.setdefault(c.user_id, {})
        host = self.hosts.get(c.device_id)
        if host is None:
            host = self.hosts[c.device_id] = _Host(c.user_id)
        accepted: list[str] = []
        changed: list[LiveBinding] = []
        user_max = self.settings.live_max_chats_per_user
        host_max = self.settings.live_max_chats_per_host
        for cid, epoch, arev, running, env in valid:
            b = ub.get(cid)
            if b is not None and b.host_device_id != c.device_id:
                rejected.append({"chat_id": cid, "code": "live_conflict", "reason": "other_host"})
                continue
            if b is None:
                if cid in online:
                    rejected.append({"chat_id": cid, "code": "live_conflict", "reason": "exists_online"})
                    continue
                if len(host.chats) >= host_max or len(ub) >= user_max:
                    limit = host_max if len(host.chats) >= host_max else user_max
                    rejected.append({"chat_id": cid, "code": "quota_exceeded", "kind": "live_chats", "limit": limit})
                    continue
                b = LiveBinding(cid, c.device_id, c.device_name, c.platform, epoch, arev, running, env, now)
                ub[cid] = b
                host.chats.add(cid)
                changed.append(b)
            elif b.epoch == epoch and arev <= b.arev:
                pass  # anúncio velho (ou repetido) no mesmo epoch: aceito sem efeito
            else:
                b.epoch, b.arev, b.running, b.env, b.announced_at = epoch, arev, running, env, now
                b.host_name, b.host_platform = c.device_name, c.platform
                changed.append(b)
            accepted.append(cid)
            host.awaiting.discard(cid)
        if not ub:
            self.bindings.pop(c.user_id, None)
        if changed:
            self._send_viewers(
                c.user_id, c.device_id, {"t": "live.update", "chats": [self.serialize(b) for b in changed]}
            )
        if full:
            keep = set(accepted)
            gone = sorted(cid for cid in host.chats if cid not in keep)
            if gone:
                self.remove(c.user_id, gone, "withdrawn")
            host.awaiting.clear()
        if not host.awaiting and host.reannounce is not None:
            host.reannounce.cancel()
            host.reannounce = None
        self._gc_host(c.device_id)
        log.debug(
            "live.announce",
            extra={"device_id": str(c.device_id), "items": len(chats), "accepted": len(accepted), "full": full},
        )
        return {"accepted": accepted, "rejected": rejected}

    async def withdraw(self, c: Conn, data: dict[str, Any]) -> dict[str, Any]:
        self._require_cap(c)
        self._frame_rate(c)
        ids, reason = data.get("chat_ids"), data.get("reason")
        if reason not in WITHDRAW_REASONS:
            raise ApiError("invalid_request", details={"field": "reason"})
        host = self.hosts.get(c.device_id)
        if ids is None:
            targets = sorted(host.chats) if host is not None else []
        elif isinstance(ids, list) and len(ids) <= LIVE_WITHDRAW_MAX_IDS and all(isinstance(x, str) for x in ids):
            targets = sorted({x for x in ids if host is not None and x in host.chats})
        else:
            raise ApiError("invalid_request", details={"field": "chat_ids"})
        if targets:
            self.remove(c.user_id, targets, WITHDRAW_REASONS[reason])
        return {}

    # ------------------------------------------------------------------ visualizadores
    async def list_chats(self, c: Conn, data: dict[str, Any]) -> dict[str, Any]:
        self._require_cap(c)
        if not _rate_ok(c.live_rate, "list", RATE_LIST, time.monotonic()):
            raise ApiError("rate_limited", details={"retry_after": 6})
        chats = [
            self.serialize(b)
            for b in sorted(self.bindings.get(c.user_id, {}).values(), key=lambda b: b.chat_id)
            if b.host_device_id != c.device_id
        ]
        return {"chats": chats, "settling_s": self.settling_s()}

    async def refresh(self, c: Conn, data: dict[str, Any]) -> dict[str, Any]:
        self._require_cap(c)
        target = data.get("host_device_id")
        dev: uuid.UUID | None = None
        if target is not None:
            try:
                dev = uuid.UUID(str(target))
            except ValueError as e:
                raise ApiError("invalid_request", details={"field": "host_device_id"}) from e
        if not _rate_ok(c.live_rate, "refresh", RATE_REFRESH, time.monotonic()):
            raise ApiError("rate_limited", details={"retry_after": 10})
        msg = {"t": "live.refresh_request", "requester_device_id": str(c.device_id)}
        if dev is not None:
            hc = self.hub.get(dev)
            if hc is not None and hc.user_id == c.user_id and hc is not c and LIVE_CAP in hc.caps:
                hc.send(msg)
        else:
            for d, h in self.hosts.items():
                hc = self.hub.get(d)
                if h.user_id == c.user_id and hc is not None and hc is not c and LIVE_CAP in hc.caps:
                    hc.send(msg)
        return {}

    # ------------------------------------------------------------------ conexão do host
    def on_welcome(self, c: Conn) -> None:
        """O host (re)conectou: sai da tolerância (`live.host online`) e tem HOST_DROP_GRACE_S para
        reanunciar; os vínculos sem reanúncio até lá são apagados (`withdrawn`)."""
        h = self.hosts.get(c.device_id)
        if h is None or h.user_id != c.user_id:
            return
        if h.grace is not None:
            h.grace.cancel()
            h.grace = None
            self._send_viewers(
                c.user_id, c.device_id, {"t": "live.host", "host_device_id": str(c.device_id), "status": "online"}
            )
        h.awaiting = set(h.chats)
        if h.reannounce is not None:
            h.reannounce.cancel()
        device_id = c.device_id

        async def expire() -> None:
            try:
                await asyncio.sleep(self.settings.host_drop_grace_s)
            except asyncio.CancelledError:
                return
            hh = self.hosts.get(device_id)
            if hh is None or hh.reannounce is not asyncio.current_task():
                return
            hh.reannounce = None
            if hh.awaiting:
                self.remove(hh.user_id, sorted(hh.awaiting), "withdrawn")

        h.reannounce = asyncio.create_task(expire())

    def on_disconnect(self, c: Conn) -> None:
        """Queda do host: `live.host grace`; vencida a tolerância sem voltar, apaga todos os vínculos dele
        (`host_dropped`). Guarda, só em memória, se algum estava rodando (aviso "host caiu", §22.6)."""
        if self._closing:
            return
        h = self.hosts.get(c.device_id)
        if h is None or h.user_id != c.user_id or self.hub.is_online(c.device_id):
            return
        if h.reannounce is not None:
            h.reannounce.cancel()
            h.reannounce = None
        h.awaiting.clear()
        ub = self.bindings.get(c.user_id, {})
        running = sorted(cid for cid in h.chats if (b := ub.get(cid)) is not None and b.running)
        dropped_at = utcnow()
        if h.grace is not None:
            h.grace.cancel()
        self._send_viewers(
            c.user_id, c.device_id, {"t": "live.host", "host_device_id": str(c.device_id), "status": "grace"}
        )
        device_id, user_id = c.device_id, c.user_id

        async def expire() -> None:
            try:
                await asyncio.sleep(self.settings.host_drop_grace_s)
            except asyncio.CancelledError:
                return
            hh = self.hosts.get(device_id)
            if hh is None or hh.grace is not asyncio.current_task():
                return
            hh.grace = None
            if self.hub.is_online(device_id):
                return
            self._remove_host(device_id, "host_dropped")
            push = self._push()
            if push is not None and running:
                push.host_dropped(user_id, device_id, [], dropped_at, live_chat_ids=running)

        h.grace = asyncio.create_task(expire())

    # ------------------------------------------------------------------ push de registros (§23.3)
    def check_push(self, user_id: uuid.UUID, device_id: uuid.UUID, body: Any) -> None:
        """Lote com `chat` vinculado, ou `session`/`message` com `scope` vinculado, vindo de OUTRO
        dispositivo → recusado inteiro (`live_conflict`, `live`). Do próprio host é a conversão ao vivo →
        online e segue as regras normais."""
        ub = self.bindings.get(user_id)
        if not ub or not isinstance(body, dict) or not isinstance(body.get("items"), list):
            return
        for it in body["items"]:
            if not isinstance(it, dict):
                continue
            t = it.get("type")
            cid = it.get("id") if t == "chat" else it.get("scope") if t in CONTENT_TYPES else None
            if isinstance(cid, str):
                b = ub.get(cid)
                if b is not None and b.host_device_id != device_id:
                    raise live_conflict(cid, "live")

    def after_push(self, user_id: uuid.UUID, device_id: uuid.UUID, changes: list[dict[str, Any]]) -> None:
        """Commit que criou o registro `chat` de um chat vinculado a este host: o vínculo some
        (`saved_online`, §23.8)."""
        ub = self.bindings.get(user_id)
        if not ub:
            return
        saved = [
            ch["id"]
            for ch in changes
            if ch.get("type") == "chat"
            and not ch.get("deleted")
            and (b := ub.get(ch["id"])) is not None
            and b.host_device_id == device_id
        ]
        if saved:
            self.remove(user_id, saved, "saved_online")

    # ------------------------------------------------------------------ esquecer
    def forget_user(self, user_id: uuid.UUID) -> None:
        """Conta apagada / banida / chaves zeradas: as conexões fecham; os vínculos somem sem aviso."""
        ub = self.bindings.get(user_id)
        if ub:
            self._drop(user_id, list(ub))
        for d in [d for d, h in self.hosts.items() if h.user_id == user_id]:
            h = self.hosts.pop(d)
            for t in (h.grace, h.reannounce):
                if t is not None:
                    t.cancel()

    def forget_devices(self, device_ids: list[uuid.UUID]) -> None:
        for d in device_ids:
            self._remove_host(d, "device_revoked")

    def shutdown(self) -> None:
        self._closing = True
        for h in self.hosts.values():
            for t in (h.grace, h.reannounce):
                if t is not None:
                    t.cancel()
        self.hosts.clear()
        self.bindings.clear()
