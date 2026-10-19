"""Acesso ao Postgres: engine SQLAlchemy async (asyncpg) + SQL explícito via text()."""

from __future__ import annotations

from collections.abc import Mapping
from pathlib import Path
from typing import Any

from sqlalchemy import text
from sqlalchemy.engine import Row
from sqlalchemy.ext.asyncio import AsyncConnection, AsyncEngine, create_async_engine

ALEMBIC_DIR = Path(__file__).parent / "alembic"


def make_engine(url: str, pool_size: int = 10) -> AsyncEngine:
    return create_async_engine(url, pool_size=pool_size, max_overflow=pool_size, pool_pre_ping=True)


async def fetchone(conn: AsyncConnection, sql: str, params: Mapping[str, Any] | None = None) -> Row[Any] | None:
    res = await conn.execute(text(sql), dict(params or {}))
    return res.first()


async def fetchall(conn: AsyncConnection, sql: str, params: Mapping[str, Any] | None = None) -> list[Row[Any]]:
    res = await conn.execute(text(sql), dict(params or {}))
    return list(res.fetchall())


async def fetchval(conn: AsyncConnection, sql: str, params: Mapping[str, Any] | None = None) -> Any:
    res = await conn.execute(text(sql), dict(params or {}))
    row = res.first()
    return None if row is None else row[0]


async def execute(conn: AsyncConnection, sql: str, params: Mapping[str, Any] | None = None) -> int:
    res = await conn.execute(text(sql), dict(params or {}))
    return res.rowcount


def alembic_config(database_url: str) -> Any:
    from alembic.config import Config

    cfg = Config()
    cfg.set_main_option("script_location", str(ALEMBIC_DIR))
    cfg.attributes["database_url"] = database_url
    return cfg


def migrate(database_url: str, revision: str = "head") -> None:
    """Roda `alembic upgrade` (síncrono; usa asyncio.run internamente)."""
    from alembic import command

    command.upgrade(alembic_config(database_url), revision)
