"""Dispositivos e tokens (§5.4): access `cca_` (1 h) e refresh `ccr_` (60 d deslizante, rotacionado)."""

from __future__ import annotations

import re
import uuid
from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Any

from sqlalchemy.ext.asyncio import AsyncConnection

from ..config import Settings
from ..db import execute, fetchone
from ..errors import ApiError
from ..security import new_token, token_hash
from ..util import utcnow


@dataclass
class Principal:
    user_id: uuid.UUID
    device_id: uuid.UUID
    email: str
    user_name: str
    keys_ready: bool
    device_name: str
    platform: str
    client: str
    can_host: bool


async def create_device(conn: AsyncConnection, user_id: uuid.UUID, device: dict[str, Any], ip: str | None) -> uuid.UUID:
    row = await fetchone(
        conn,
        "INSERT INTO devices (user_id, name, platform, client, app_version, can_host, last_seen_at, last_ip) "
        "VALUES (:u, :n, :p, :c, :v, :h, now(), CAST(:ip AS inet)) RETURNING id",
        {
            "u": user_id,
            "n": device["name"],
            "p": device["platform"],
            "c": device["client"],
            "v": device["app_version"],
            "h": bool(device["can_host"]) and device["client"] != "web",
            "ip": ip,
        },
    )
    assert row is not None
    return uuid.UUID(str(row.id))


async def issue_tokens(
    conn: AsyncConnection,
    settings: Settings,
    user_id: uuid.UUID,
    device_id: uuid.UUID,
    rotate_from: bytes | None = None,
) -> dict[str, Any]:
    """Cria um access token novo e um refresh novo. O refresh que sai (`rotate_from`) entra no histórico
    de rotação do dispositivo (`device_refresh_history`, até a validade dele): apresentá-lo de novo é reuso
    (§5.4), qualquer que seja a geração."""
    access = new_token("cca_")
    refresh = new_token("ccr_")
    now = utcnow()
    if rotate_from is not None:
        await execute(
            conn,
            "INSERT INTO device_refresh_history (token_hash, device_id, expires_at) "
            "SELECT :h, id, COALESCE(refresh_expires_at, :e) FROM devices WHERE id = :d "
            "ON CONFLICT (token_hash) DO NOTHING",
            {"h": rotate_from, "d": device_id, "e": now + timedelta(days=settings.refresh_token_ttl_days)},
        )
    await execute(
        conn,
        "INSERT INTO access_tokens (token_hash, device_id, user_id, expires_at) VALUES (:h, :d, :u, :e)",
        {
            "h": token_hash(access),
            "d": device_id,
            "u": user_id,
            "e": now + timedelta(seconds=settings.access_token_ttl_s),
        },
    )
    await execute(
        conn,
        "UPDATE devices SET refresh_prev_hash = :prev, refresh_hash = :h, refresh_expires_at = :e WHERE id = :d",
        {
            "prev": rotate_from,
            "h": token_hash(refresh),
            "e": now + timedelta(days=settings.refresh_token_ttl_days),
            "d": device_id,
        },
    )
    return {
        "access_token": access,
        "access_expires_in": settings.access_token_ttl_s,
        "refresh_token": refresh,
        "refresh_expires_in": settings.refresh_token_ttl_days * 86400,
    }


async def find_reused_refresh(conn: AsyncConnection, h: bytes) -> Any:
    """Dispositivo não revogado cujo histórico de rotação contém este hash (reuso de refresh), ou None."""
    return await fetchone(
        conn,
        "SELECT d.id, d.user_id FROM device_refresh_history r JOIN devices d ON d.id = r.device_id "
        "WHERE r.token_hash = :h AND d.revoked_at IS NULL",
        {"h": h},
    )


async def prune_refresh_history(conn: AsyncConnection, now: datetime) -> int:
    """GC: apaga do histórico de rotação os refresh que já teriam expirado de qualquer jeito."""
    return await execute(conn, "DELETE FROM device_refresh_history WHERE expires_at < :t", {"t": now})


async def authenticate(conn: AsyncConnection, token: str | None) -> Principal:
    """Valida um access token. Erros: unauthorized (sem/expirado/inválido), device_revoked, account_disabled."""
    if not token or not token.startswith("cca_") or len(token) > 100:
        raise ApiError("unauthorized")
    row = await fetchone(
        conn,
        "SELECT t.expires_at, t.user_id, t.device_id, u.email, u.name AS user_name, u.status, u.keys_ready, "
        "d.name AS device_name, d.platform, d.client, d.can_host, d.revoked_at "
        "FROM access_tokens t JOIN users u ON u.id = t.user_id JOIN devices d ON d.id = t.device_id "
        "WHERE t.token_hash = :h",
        {"h": token_hash(token)},
    )
    if row is None:
        raise ApiError("unauthorized")
    if row.revoked_at is not None:
        raise ApiError("device_revoked")
    if row.status != "active":
        raise ApiError("account_disabled")
    if row.expires_at <= utcnow():
        raise ApiError("unauthorized", details={"reason": "expired"})
    return Principal(
        user_id=row.user_id,
        device_id=row.device_id,
        email=str(row.email),
        user_name=row.user_name,
        keys_ready=row.keys_ready,
        device_name=row.device_name,
        platform=row.platform,
        client=row.client,
        can_host=row.can_host,
    )


CLIENT_HEADER_RE = re.compile(r"\A(desktop|mobile|web)/([0-9A-Za-z.+_-]{1,64})\Z")


def client_version(header: str | None, client: str) -> str | None:
    """Versão do app no cabeçalho `X-ClearChat-Client: <client>/<versão>` — só se o client bate com o do dispositivo."""
    m = CLIENT_HEADER_RE.match(header or "")
    return m.group(2) if m and m.group(1) == client else None


async def touch_device(
    conn: AsyncConnection,
    device_id: uuid.UUID,
    user_id: uuid.UUID,
    ip: str | None,
    app_version: str | None = None,
) -> None:
    """Atualiza último acesso (no máximo 1×/min por dispositivo) e a versão do app quando ela muda."""
    await execute(
        conn,
        "UPDATE devices SET last_seen_at = now(), last_ip = COALESCE(CAST(:ip AS inet), last_ip) "
        "WHERE id = :d AND (last_seen_at IS NULL OR last_seen_at < now() - interval '60 seconds')",
        {"d": device_id, "ip": ip},
    )
    if app_version is not None:
        # gravada no login e nunca mais: o app atualizado continuaria aparecendo com a versão antiga
        await execute(
            conn,
            "UPDATE devices SET app_version = :v WHERE id = :d AND app_version IS DISTINCT FROM :v",
            {"d": device_id, "v": app_version},
        )
    await execute(
        conn,
        "UPDATE users SET last_seen_at = now() WHERE id = :u "
        "AND (last_seen_at IS NULL OR last_seen_at < now() - interval '60 seconds')",
        {"u": user_id},
    )
