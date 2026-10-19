"""Limites de taxa (janela fixa) e bloqueios em Postgres (§17.3, ARCHITECTURE §5).

Cada contagem roda na sua própria transação (fica gravada mesmo se a requisição falhar depois)."""

from __future__ import annotations

import math
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta

from sqlalchemy.ext.asyncio import AsyncEngine

from ..db import execute, fetchone, fetchval
from ..errors import rate_limited

HOUR = 3600
DAY = 86400
LOCKOUT_LEVEL_HOURS = [1, 2, 4, 8, 16, 24]


@dataclass(frozen=True)
class Limit:
    bucket: str
    limit: int
    window_s: int


def _window_start(now: datetime, window_s: int) -> datetime:
    ts = math.floor(now.timestamp() / window_s) * window_s
    return datetime.fromtimestamp(ts, UTC)


class RateLimiter:
    def __init__(self, engine: AsyncEngine) -> None:
        self.engine = engine

    async def hit(self, limits: list[Limit], now: datetime | None = None) -> None:
        """Conta 1 em cada balde; se algum passou do limite → ApiError rate_limited (429)."""
        now = now or datetime.now(UTC)
        retry = 0
        async with self.engine.begin() as conn:
            for lim in limits:
                start = _window_start(now, lim.window_s)
                count = await fetchval(
                    conn,
                    "INSERT INTO rate_counters (bucket, window_start, count) VALUES (:b, :w, 1) "
                    "ON CONFLICT (bucket, window_start) DO UPDATE SET count = rate_counters.count + 1 "
                    "RETURNING count",
                    {"b": f"{lim.bucket}:{lim.window_s}", "w": start},
                )
                if count > lim.limit:
                    end = start + timedelta(seconds=lim.window_s)
                    retry = max(retry, math.ceil((end - now).total_seconds()))
        if retry:
            raise rate_limited(retry)

    async def count(self, bucket: str, window_s: int, now: datetime | None = None) -> int:
        now = now or datetime.now(UTC)
        async with self.engine.connect() as conn:
            v = await fetchval(
                conn,
                "SELECT count FROM rate_counters WHERE bucket = :b AND window_start = :w",
                {"b": f"{bucket}:{window_s}", "w": _window_start(now, window_s)},
            )
        return int(v or 0)

    # ---------- bloqueios por e-mail (falhas de verify) ----------
    async def check_lockout(self, key: str, now: datetime | None = None) -> None:
        now = now or datetime.now(UTC)
        async with self.engine.connect() as conn:
            until = await fetchval(conn, "SELECT until FROM lockouts WHERE key = :k", {"k": key})
        if until is not None and until > now:
            raise rate_limited(math.ceil((until - now).total_seconds()))

    async def register_failure(
        self, key: str, threshold: int = 15, window_s: int = DAY, now: datetime | None = None
    ) -> None:
        """Conta uma falha; ao atingir `threshold` na janela, bloqueia (1 h, dobrando até 24 h)."""
        now = now or datetime.now(UTC)
        bucket = f"fail:{key}:{window_s}"
        async with self.engine.begin() as conn:
            start = _window_start(now, window_s)
            count = await fetchval(
                conn,
                "INSERT INTO rate_counters (bucket, window_start, count) VALUES (:b, :w, 1) "
                "ON CONFLICT (bucket, window_start) DO UPDATE SET count = rate_counters.count + 1 "
                "RETURNING count",
                {"b": bucket, "w": start},
            )
            if count >= threshold:
                row = await fetchone(conn, "SELECT level FROM lockouts WHERE key = :k FOR UPDATE", {"k": key})
                level = 1 if row is None else min(int(row.level) + 1, len(LOCKOUT_LEVEL_HOURS))
                until = now + timedelta(hours=LOCKOUT_LEVEL_HOURS[level - 1])
                await execute(
                    conn,
                    "INSERT INTO lockouts (key, until, level) VALUES (:k, :u, :l) "
                    "ON CONFLICT (key) DO UPDATE SET until = EXCLUDED.until, level = EXCLUDED.level",
                    {"k": key, "u": until, "l": level},
                )
                # zera a contagem: depois do bloqueio, novas 15 tentativas
                await execute(conn, "DELETE FROM rate_counters WHERE bucket = :b", {"b": bucket})
