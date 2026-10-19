"""Configurações da instância (§20.2): banco com padrões do .env e cache curto."""

from __future__ import annotations

import json
import time
from dataclasses import dataclass
from typing import Any

from sqlalchemy.ext.asyncio import AsyncConnection, AsyncEngine

from ..config import Settings
from ..db import execute, fetchall

KEYS = ("instance_name", "signup_open", "landing_enabled", "captcha_enabled", "gateway_enabled")


@dataclass(frozen=True)
class InstanceSettings:
    instance_name: str
    signup_open: bool
    landing_enabled: bool
    captcha_enabled: bool  # valor do painel (sem considerar as chaves do .env)
    gateway_enabled: bool  # reservado (§21), sempre tratado como desligado

    def captcha_active(self, settings: Settings) -> bool:
        return self.captcha_enabled and settings.captcha_keys_present


def defaults(settings: Settings) -> dict[str, Any]:
    return {
        "instance_name": settings.instance_name,
        "signup_open": settings.initial_signup_open,
        "landing_enabled": settings.initial_landing_enabled,
        "captcha_enabled": True,
        "gateway_enabled": False,
    }


async def load(conn: AsyncConnection, settings: Settings) -> InstanceSettings:
    vals = defaults(settings)
    for row in await fetchall(conn, "SELECT key, value FROM instance_settings"):
        if row.key in vals:
            vals[row.key] = row.value  # jsonb já decodificado pelo driver
    return InstanceSettings(
        instance_name=str(vals["instance_name"]),
        signup_open=bool(vals["signup_open"]),
        landing_enabled=bool(vals["landing_enabled"]),
        captcha_enabled=bool(vals["captcha_enabled"]),
        gateway_enabled=bool(vals["gateway_enabled"]),
    )


async def save(conn: AsyncConnection, values: dict[str, Any]) -> None:
    for k, v in values.items():
        if k not in KEYS:
            raise ValueError(f"configuração desconhecida: {k}")
        await execute(
            conn,
            "INSERT INTO instance_settings (key, value, updated_at) VALUES (:k, CAST(:v AS jsonb), now()) "
            "ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()",
            {"k": k, "v": json.dumps(v)},
        )


class InstanceSettingsCache:
    def __init__(self, engine: AsyncEngine, settings: Settings) -> None:
        self.engine = engine
        self.settings = settings
        self._value: InstanceSettings | None = None
        self._at = 0.0

    def invalidate(self) -> None:
        self._value = None

    async def get(self) -> InstanceSettings:
        now = time.monotonic()
        if self._value is None or now - self._at > self.settings.instance_settings_cache_s:
            async with self.engine.connect() as conn:
                self._value = await load(conn, self.settings)
            self._at = now
        return self._value
