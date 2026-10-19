"""correções da auditoria: histórico de rotação do refresh, índice activity (kind, at), uso nunca negativo

- `device_refresh_history`: todo refresh rotacionado de um dispositivo, até a validade dele; apresentar
  qualquer um de novo é reuso (SYNC_PROTOCOL §5.4) e revoga o dispositivo. O GC apaga os expirados.
  Os `refresh_prev_hash` já gravados entram no histórico (validade = a do refresh atual, um teto).
- `activity (kind, at DESC)`: a visão geral do painel admin agrega a janela de 14 dias por faixa de índice.
- `users.usage_*` >= 0: negativos (deriva antiga) são zerados antes, e as restrições entram NOT VALID +
  VALIDATE, para a migração não falhar numa instalação com contadores derivados.

Revision ID: 0002_auth_hardening
Revises: 0001_initial
Create Date: 2026-10-19
"""

from alembic import op

revision = "0002_auth_hardening"
down_revision = "0001_initial"
branch_labels = None
depends_on = None

USAGE_COLUMNS = ("usage_records", "usage_record_bytes", "usage_blobs", "usage_blob_bytes")

UPGRADE = [
    """
    CREATE TABLE device_refresh_history (
      token_hash  bytea PRIMARY KEY,
      device_id   uuid NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
      expires_at  timestamptz NOT NULL
    )
    """,
    "CREATE INDEX device_refresh_history_device ON device_refresh_history (device_id)",
    "CREATE INDEX device_refresh_history_expires ON device_refresh_history (expires_at)",
    """
    INSERT INTO device_refresh_history (token_hash, device_id, expires_at)
    SELECT refresh_prev_hash, id, COALESCE(refresh_expires_at, now() + interval '60 days') FROM devices
    WHERE refresh_prev_hash IS NOT NULL AND revoked_at IS NULL
    ON CONFLICT (token_hash) DO NOTHING
    """,
    "CREATE INDEX activity_kind_at ON activity (kind, at DESC)",
    "UPDATE users SET "
    + ", ".join(f"{c} = GREATEST({c}, 0)" for c in USAGE_COLUMNS)
    + " WHERE "
    + " OR ".join(f"{c} < 0" for c in USAGE_COLUMNS),
    *(f"ALTER TABLE users ADD CONSTRAINT users_{c}_nonneg CHECK ({c} >= 0) NOT VALID" for c in USAGE_COLUMNS),
    *(f"ALTER TABLE users VALIDATE CONSTRAINT users_{c}_nonneg" for c in USAGE_COLUMNS),
]

DOWNGRADE = [
    *(f"ALTER TABLE users DROP CONSTRAINT IF EXISTS users_{c}_nonneg" for c in USAGE_COLUMNS),
    "DROP INDEX IF EXISTS activity_kind_at",
    "DROP TABLE IF EXISTS device_refresh_history",
]


def upgrade() -> None:
    # asyncpg não aceita vários comandos num execute preparado: um por vez
    for stmt in UPGRADE:
        op.execute(stmt)


def downgrade() -> None:
    for stmt in DOWNGRADE:
        op.execute(stmt)
