"""notificações push (SYNC_PROTOCOL §22, protocolo 1.7.0)

- `devices.push_provider` / `push_token` / `push_updated_at`: token de push do dispositivo (um por
  dispositivo; `PUT`/`DELETE /devices/current/push`). Índice único parcial: um token pertence a um
  dispositivo só (registrar o mesmo token noutro dispositivo tira do anterior — ex.: o app foi
  reinstalado e entrou noutra conta).
- `devices.offline_push_tag` / `offline_push_at` / `offline_push_shown`: aviso "host caiu" gerado pelo
  servidor (§22.6) — tag fixa por dispositivo host, hora do último aviso (intervalo mínimo, sobrevive a
  reinícios) e se há aviso a apagar (`dismiss`) quando o host voltar.

Revision ID: 0003_push
Revises: 0002_auth_hardening
Create Date: 2026-11-06
"""

from alembic import op

revision = "0003_push"
down_revision = "0002_auth_hardening"
branch_labels = None
depends_on = None

UPGRADE = [
    "ALTER TABLE devices ADD COLUMN push_provider text CHECK (push_provider IN ('fcm','apns'))",
    "ALTER TABLE devices ADD COLUMN push_token text CHECK (char_length(push_token) BETWEEN 1 AND 4096)",
    "ALTER TABLE devices ADD COLUMN push_updated_at timestamptz",
    "CREATE UNIQUE INDEX devices_push_token ON devices (push_token) WHERE push_token IS NOT NULL",
    "ALTER TABLE devices ADD COLUMN offline_push_tag text",
    "ALTER TABLE devices ADD COLUMN offline_push_at timestamptz",
    "ALTER TABLE devices ADD COLUMN offline_push_shown boolean NOT NULL DEFAULT false",
]

DOWNGRADE = [
    "DROP INDEX IF EXISTS devices_push_token",
    *(
        f"ALTER TABLE devices DROP COLUMN IF EXISTS {c}"
        for c in (
            "push_provider",
            "push_token",
            "push_updated_at",
            "offline_push_tag",
            "offline_push_at",
            "offline_push_shown",
        )
    ),
]


def upgrade() -> None:
    # asyncpg não aceita vários comandos num execute preparado: um por vez
    for stmt in UPGRADE:
        op.execute(stmt)


def downgrade() -> None:
    for stmt in DOWNGRADE:
        op.execute(stmt)
