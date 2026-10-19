"""Ambiente do Alembic: usa DATABASE_URL (asyncpg) do .env/ambiente."""

from __future__ import annotations

import asyncio
import os
from typing import Any

from alembic import context
from sqlalchemy.ext.asyncio import create_async_engine

from clearchat_server.config import Settings

config = context.config


def _url() -> str:
    return config.attributes.get("database_url") or os.environ.get("DATABASE_URL") or Settings().database_url


def run_migrations_offline() -> None:
    context.configure(url=_url(), literal_binds=True, target_metadata=None)
    with context.begin_transaction():
        context.run_migrations()


def _do_run(connection: Any) -> None:
    context.configure(connection=connection, target_metadata=None)
    with context.begin_transaction():
        context.run_migrations()


async def run_migrations_online() -> None:
    engine = create_async_engine(_url())
    async with engine.connect() as conn:
        await conn.run_sync(_do_run)
        await conn.commit()
    await engine.dispose()


if context.is_offline_mode():
    run_migrations_offline()
else:
    conn = config.attributes.get("connection")
    if conn is not None:
        _do_run(conn)
    else:
        asyncio.run(run_migrations_online())
