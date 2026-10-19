"""esquema inicial (docs/ARCHITECTURE.md §3)

Revision ID: 0001_initial
Revises:
Create Date: 2026-10-19
"""

from alembic import op

revision = "0001_initial"
down_revision = None
branch_labels = None
depends_on = None

DDL = r"""
CREATE EXTENSION IF NOT EXISTS citext;

CREATE TABLE instance_settings (
  key         text PRIMARY KEY,
  value       jsonb NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE users (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email              citext NOT NULL UNIQUE,
  name               text NOT NULL,
  status             text NOT NULL DEFAULT 'active' CHECK (status IN ('active','banned')),
  banned_at          timestamptz, banned_reason text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  created_by         text NOT NULL DEFAULT 'signup',
  last_seen_at       timestamptz,
  keys_ready         boolean NOT NULL DEFAULT false,
  key_version        smallint NOT NULL DEFAULT 1,
  keys_rev           integer NOT NULL DEFAULT 0,
  kdf                jsonb,
  pw_salt            bytea,  pw_wrap_nonce bytea,  pw_wrap_ct bytea,
  rk_salt            bytea,  rk_wrap_nonce bytea,  rk_wrap_ct bytea,
  key_verifier       bytea,
  seq                bigint NOT NULL DEFAULT 0,
  state_seq          bigint NOT NULL DEFAULT 0,
  tombstone_floor    bigint NOT NULL DEFAULT 0,
  quota_record_bytes bigint, quota_records integer, quota_blob_bytes bigint, quota_devices integer,
  usage_record_bytes bigint NOT NULL DEFAULT 0, usage_records integer NOT NULL DEFAULT 0,
  usage_blob_bytes   bigint NOT NULL DEFAULT 0, usage_blobs integer NOT NULL DEFAULT 0
);

CREATE TABLE invites (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash   bytea NOT NULL UNIQUE,
  email        citext,
  note         text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL,
  used_at      timestamptz, used_by uuid REFERENCES users(id) ON DELETE SET NULL,
  revoked_at   timestamptz
);

CREATE TABLE email_codes (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email_hash   bytea NOT NULL,
  purpose      text NOT NULL CHECK (purpose IN ('signup','login','delete_account','reset_keys')),
  code_hash    bytea NOT NULL,
  user_id      uuid REFERENCES users(id) ON DELETE CASCADE,
  pending_name text,
  invite_id    uuid REFERENCES invites(id) ON DELETE SET NULL,
  attempts     smallint NOT NULL DEFAULT 0,
  created_at   timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL,
  consumed_at  timestamptz, invalidated_at timestamptz,
  ip           inet
);
CREATE INDEX email_codes_lookup ON email_codes (email_hash, purpose, created_at DESC);

CREATE TABLE devices (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name           text NOT NULL,
  platform       text NOT NULL,
  client         text NOT NULL CHECK (client IN ('desktop','mobile','web')),
  app_version    text NOT NULL,
  can_host       boolean NOT NULL DEFAULT false,
  created_at     timestamptz NOT NULL DEFAULT now(),
  last_seen_at   timestamptz, last_ip inet,
  revoked_at     timestamptz,
  refresh_hash   bytea UNIQUE,
  refresh_prev_hash bytea,
  refresh_expires_at timestamptz
);
CREATE INDEX devices_user_active ON devices (user_id) WHERE revoked_at IS NULL;
CREATE INDEX devices_refresh_prev ON devices (refresh_prev_hash) WHERE refresh_prev_hash IS NOT NULL;

CREATE TABLE access_tokens (
  token_hash  bytea PRIMARY KEY,
  device_id   uuid NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at  timestamptz NOT NULL
);
CREATE INDEX access_tokens_device ON access_tokens (device_id);

CREATE TABLE records (
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type        text NOT NULL,
  id          text NOT NULL,
  scope_id    text,
  rev         integer NOT NULL,
  seq         bigint NOT NULL,
  deleted     boolean NOT NULL DEFAULT false,
  env_v       smallint, key_version smallint,
  nonce       bytea, ciphertext bytea,
  size        integer NOT NULL DEFAULT 0,
  blobs       text[] NOT NULL DEFAULT '{}',
  device_id   uuid,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, type, id)
);
CREATE UNIQUE INDEX records_user_seq ON records (user_id, seq);
CREATE INDEX records_user_scope ON records (user_id, scope_id) WHERE scope_id IS NOT NULL;
CREATE INDEX records_user_type_seq ON records (user_id, type, seq) WHERE NOT deleted;
CREATE INDEX records_tombstones ON records (updated_at) WHERE deleted;

CREATE TABLE record_blobs (
  user_id uuid NOT NULL, type text NOT NULL, record_id text NOT NULL, blob_id text NOT NULL,
  PRIMARY KEY (user_id, type, record_id, blob_id),
  FOREIGN KEY (user_id, type, record_id) REFERENCES records(user_id, type, id) ON DELETE CASCADE
);
CREATE INDEX record_blobs_blob ON record_blobs (user_id, blob_id);

CREATE TABLE blobs (
  user_id        uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  blob_id        text NOT NULL,
  size           bigint NOT NULL,
  sha256_ct      bytea NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  unreferenced_since timestamptz DEFAULT now(),
  PRIMARY KEY (user_id, blob_id)
);
CREATE INDEX blobs_orphans ON blobs (unreferenced_since) WHERE unreferenced_since IS NOT NULL;

CREATE TABLE push_receipts (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  push_id uuid NOT NULL,
  response jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, push_id)
);

CREATE TABLE chat_states (
  user_id          uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  chat_id          text NOT NULL,
  head             bigint NOT NULL DEFAULT 0,
  host_device_id   uuid REFERENCES devices(id) ON DELETE SET NULL,
  epoch            integer NOT NULL DEFAULT 0,
  pinned           boolean NOT NULL DEFAULT false,
  window_purpose   text,
  window_since     timestamptz,
  host_dropped_at  timestamptz,
  host_grace_deadline timestamptz,
  handover_to      uuid REFERENCES devices(id) ON DELETE SET NULL,
  handover_mode    text, handover_requested_at timestamptz, handover_deadline timestamptz,
  divergence_id    uuid, diverged_device_id uuid, diverged_base bigint, diverged_head bigint, diverged_at timestamptz,
  ssq              bigint NOT NULL,
  updated_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, chat_id)
);
CREATE INDEX chat_states_ssq ON chat_states (user_id, ssq);
CREATE INDEX chat_states_host ON chat_states (user_id, host_device_id);

CREATE TABLE divergence_discards (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  chat_id text NOT NULL, device_id uuid NOT NULL, base bigint NOT NULL, divergence_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, chat_id, device_id, base)
);

CREATE TABLE rate_counters (
  bucket       text NOT NULL,
  window_start timestamptz NOT NULL,
  count        integer NOT NULL,
  PRIMARY KEY (bucket, window_start)
);
CREATE INDEX rate_counters_window ON rate_counters (window_start);

CREATE TABLE lockouts (
  key        text PRIMARY KEY,
  until      timestamptz NOT NULL,
  level      smallint NOT NULL DEFAULT 1
);

CREATE TABLE activity (
  id         bigserial PRIMARY KEY,
  user_id    uuid REFERENCES users(id) ON DELETE CASCADE,
  device_id  uuid,
  kind       text NOT NULL,
  ip         inet,
  meta       jsonb,
  at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX activity_user_at ON activity (user_id, at DESC);
CREATE INDEX activity_at ON activity (at DESC);

-- contadores diários de uso (pushes e uploads) para o painel admin — sem conteúdo
CREATE TABLE usage_daily (
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  day          date NOT NULL,
  pushes       integer NOT NULL DEFAULT 0,
  push_items   integer NOT NULL DEFAULT 0,
  push_bytes   bigint NOT NULL DEFAULT 0,
  blob_uploads integer NOT NULL DEFAULT 0,
  blob_bytes   bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, day)
);
CREATE INDEX usage_daily_day ON usage_daily (day);
"""

TABLES = [
    "usage_daily", "activity", "lockouts", "rate_counters", "divergence_discards", "chat_states",
    "push_receipts", "blobs", "record_blobs", "records", "access_tokens", "devices", "email_codes",
    "invites", "users", "instance_settings",
]


def upgrade() -> None:
    # asyncpg não aceita vários comandos num execute preparado: um por vez
    for stmt in DDL.split(";\n"):
        lines = [ln for ln in stmt.splitlines() if not ln.strip().startswith("--")]
        if "".join(lines).strip():
            op.execute("\n".join(lines))


def downgrade() -> None:
    for t in TABLES:
        op.execute(f"DROP TABLE IF EXISTS {t} CASCADE")
