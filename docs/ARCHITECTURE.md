# ClearChatWebsite — Arquitetura do servidor e do site

> Complementa `docs/SYNC_PROTOCOL.md` (o contrato com os clientes, **idêntico** no repositório do app).
> Este arquivo é só deste repositório: descreve como o servidor implementa o contrato. Se algo aqui
> contradisser o `SYNC_PROTOCOL.md`, vale o protocolo.

## 1. Componentes

```
                Internet / LAN
                      │  HTTPS (TLS no Nginx do usuário)
              ┌───────▼────────┐
              │ Nginx (host)   │  /      → web   (127.0.0.1:${WEB_PORT})
              │ limit_req      │  /api/  → api   (127.0.0.1:${API_PORT})
              │                │  /ws    → api   (upgrade WebSocket)
              └───┬───────┬────┘  NUNCA → admin
                  │       │
   ┌──────────────▼┐   ┌──▼─────────────────────┐        ┌──────────────────────┐
   │ web (nginx    │   │ api (FastAPI, uvicorn, │        │ admin (FastAPI +     │
   │ estático: SPA │   │ 1 worker async)        │        │ Jinja2) 127.0.0.1    │
   │ React/Vite)   │   │ REST + WS hub + host   │        │ :${ADMIN_PORT} só    │
   └───────────────┘   │ coordinator + jobs     │        │ via túnel SSH        │
                       └──┬─────────┬───────────┘        └──────┬───────────────┘
                          │         │ volume blobs              │
                   ┌──────▼──────┐  └──► /data/blobs           │
                   │ db Postgres │◄─────────────────────────────┘
                   │ (sem porta  │
                   │  publicada) │       SMTP do usuário ◄── api (aiosmtplib)
                   └─────────────┘       Cloudflare Turnstile ◄── api (siteverify, opcional)
```

| Serviço | Tecnologia | Responsabilidade |
|---|---|---|
| `web` | React 19 + Vite + TypeScript, servido por `nginx:alpine` | landing, cadastro, login, desbloqueio, painel (decifra no navegador), página `/captcha` do app |
| `api` | Python 3.13, FastAPI, SQLAlchemy 2 (async) + asyncpg, Alembic, Pydantic v2, httpx, aiosmtplib | REST `/api`, WebSocket `/ws`, coordenação de host, rate limit, e-mail, jobs de GC |
| `admin` | FastAPI + Jinja2 (HTML no servidor, sem JS obrigatório), reaproveita os modelos do backend | painel do dono da instância, só em `127.0.0.1` |
| `db` | `postgres:17-alpine` | todo o estado (sem Redis) |
| volume `blobs` | sistema de arquivos | blobs cifrados (anexos, bundles de skill) |

Decisões:
- **Um worker** do uvicorn: o hub de WebSocket e os timers de host (tolerância de 10 s, troca forçada,
  comandos remotos em trânsito aguardando resultado) ficam em memória do processo, com o estado durável no Postgres. Escala de uma
  instância pessoal/pequena cabe com folga. Caminho futuro para vários workers: `LISTEN/NOTIFY` do
  Postgres para fan-out entre processos + timers baseados em colunas `*_deadline` varridas por job (o
  esquema abaixo já guarda os deadlines).
- **Sem Redis**: rate limit e contadores em Postgres (`INSERT … ON CONFLICT … RETURNING`).
- **Sem CORS** por padrão (site na mesma origem; apps nativos não fazem CORS). `ALLOWED_ORIGINS` opcional.

## 2. Layout do repositório

```
backend/            Python (pacote clearchat_server): app FastAPI da api
  clearchat_server/
    main.py           # create_app(): rotas sob BASE_PATH, middlewares (IP real, logs), ciclo de vida
    __main__.py       # `python -m clearchat_server serve` (uvicorn, 1 worker) ou comandos do cli.py
    cli.py            # migrate, init-env, create-user, invite, settings, gc, healthcheck
    config.py         # lê o .env (pydantic-settings)
    context.py        # AppContext (engine, hub, coordenador, mailer, limiter…) em app.state.ctx
    chatstate.py      # chat_states: ssq, travas, serialização ChatState
    db/               # engine async (asyncpg) + SQL explícito; migrações Alembic (db/alembic/)
    auth/             # códigos por e-mail, convites, tokens, dispositivos, conta, Turnstile
    keys/             # wraps, verifier, key_proof, reset
    sync/             # envelope (validação de formato), push/pull/divergência (records.py), blobs
    realtime/         # hub WS (hub.py), coordenador de host + comandos + stream (coordinator.py), endpoint (ws.py)
    ratelimit/        # contadores Postgres, bloqueios
    mail/             # SMTP (aiosmtplib) / console / memória + textos pt-BR
    instance/         # configurações da instância (/api/info)
    services/         # operações de conta compartilhadas com o admin (revogar, banir, apagar, convites)
    jobs/             # GC e expirações + ouvinte LISTEN/NOTIFY dos eventos do admin
  tests/              # pytest (Postgres real, uvicorn em processo, WebSocket de verdade)
  pyproject.toml, alembic.ini, Dockerfile, Makefile
frontend/           React + Vite + TS (site)
  src/ … ; Dockerfile (build → nginx estático; gera config.js com PUBLIC_BASE_URL no start)
admin/              clearchat_admin: FastAPI + Jinja2 (importa clearchat_server), Dockerfile (contexto = raiz)
docs/               SYNC_PROTOCOL.md (compartilhado), ARCHITECTURE.md, test-vectors/ (compartilhado)
deploy/             nginx.example.conf, edge.Caddyfile (perfil self-host com uma porta só)
docker-compose.yml, .env.example
```

## 3. Banco de dados (Postgres)

Convenções: `uuid` gerado no servidor (`gen_random_uuid()`), `timestamptz`, `bytea` para binário. Todas
as tabelas com dados de usuário têm `user_id … REFERENCES users(id) ON DELETE CASCADE`.

```sql
CREATE EXTENSION IF NOT EXISTS citext;

-- configurações da instância (painel admin) ---------------------------------------------------
CREATE TABLE instance_settings (
  key         text PRIMARY KEY,          -- instance_name, signup_open, landing_enabled, captcha_enabled, gateway_enabled
  value       jsonb NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- usuários e chaves -------------------------------------------------------------------------
CREATE TABLE users (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email              citext NOT NULL UNIQUE,
  name               text NOT NULL,
  status             text NOT NULL DEFAULT 'active' CHECK (status IN ('active','banned')),
  banned_at          timestamptz, banned_reason text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  created_by         text NOT NULL DEFAULT 'signup',   -- signup | invite | admin
  last_seen_at       timestamptz,
  -- chaves (SYNC_PROTOCOL §3/§6.5)
  keys_ready         boolean NOT NULL DEFAULT false,
  key_version        smallint NOT NULL DEFAULT 1,
  keys_rev           integer NOT NULL DEFAULT 0,
  kdf                jsonb,                 -- {"alg":"argon2id","v":19,"m":65536,"t":3,"p":1,"len":32}
  pw_salt            bytea,  pw_wrap_nonce bytea,  pw_wrap_ct bytea,   -- 16 / 12 / 48 bytes
  rk_salt            bytea,  rk_wrap_nonce bytea,  rk_wrap_ct bytea,
  key_verifier       bytea,                 -- SHA-256(K_verify), 32 bytes
  -- sync
  seq                bigint NOT NULL DEFAULT 0,     -- último seq atribuído
  state_seq          bigint NOT NULL DEFAULT 0,     -- último ssq de chat_states
  tombstone_floor    bigint NOT NULL DEFAULT 0,
  -- cotas (NULL = ilimitado) e uso
  quota_record_bytes bigint, quota_records integer, quota_blob_bytes bigint, quota_devices integer,
  usage_record_bytes bigint NOT NULL DEFAULT 0, usage_records integer NOT NULL DEFAULT 0,
  usage_blob_bytes   bigint NOT NULL DEFAULT 0, usage_blobs integer NOT NULL DEFAULT 0
  -- 0002: CHECK (usage_* >= 0) nas quatro colunas de uso (users_usage_*_nonneg)
);

CREATE TABLE invites (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash   bytea NOT NULL UNIQUE,          -- SHA-256(token)
  email        citext,                          -- NULL = qualquer e-mail
  note         text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL,
  used_at      timestamptz, used_by uuid REFERENCES users(id) ON DELETE SET NULL,
  revoked_at   timestamptz
);

CREATE TABLE email_codes (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email_hash   bytea NOT NULL,                 -- HMAC(SERVER_SECRET, email normalizado)
  purpose      text NOT NULL CHECK (purpose IN ('signup','login','delete_account','reset_keys')),
  code_hash    bytea NOT NULL,                 -- HMAC(SERVER_SECRET, purpose|email|code)
  user_id      uuid REFERENCES users(id) ON DELETE CASCADE,
  pending_name text,                           -- nome informado no signup/start
  invite_id    uuid REFERENCES invites(id) ON DELETE SET NULL,
  attempts     smallint NOT NULL DEFAULT 0,
  created_at   timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL,
  consumed_at  timestamptz, invalidated_at timestamptz,
  ip           inet
);
CREATE INDEX ON email_codes (email_hash, purpose, created_at DESC);

-- dispositivos e tokens --------------------------------------------------------------------
CREATE TABLE devices (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name           text NOT NULL,
  platform       text NOT NULL,
  client         text NOT NULL CHECK (client IN ('desktop','mobile','web')),  -- 'gateway' reservado
  app_version    text NOT NULL,
  can_host       boolean NOT NULL DEFAULT false,
  created_at     timestamptz NOT NULL DEFAULT now(),
  last_seen_at   timestamptz, last_ip inet,
  revoked_at     timestamptz,
  refresh_hash   bytea UNIQUE,                 -- refresh atual
  refresh_prev_hash bytea,                     -- anterior (legado; a detecção usa o histórico abaixo)
  refresh_expires_at timestamptz
);
CREATE INDEX ON devices (user_id) WHERE revoked_at IS NULL;

-- 0002: todo refresh já rotacionado do dispositivo, até a validade dele. Apresentar qualquer um de novo
-- (de qualquer geração) é reuso → revoga o dispositivo (SYNC_PROTOCOL §5.4). O GC apaga os expirados.
CREATE TABLE device_refresh_history (
  token_hash  bytea PRIMARY KEY,               -- SHA-256(refresh rotacionado)
  device_id   uuid NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  expires_at  timestamptz NOT NULL
);
CREATE INDEX ON device_refresh_history (device_id);
CREATE INDEX ON device_refresh_history (expires_at);

CREATE TABLE access_tokens (
  token_hash  bytea PRIMARY KEY,
  device_id   uuid NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at  timestamptz NOT NULL
);

-- registros ----------------------------------------------------------------------------------
CREATE TABLE records (
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type        text NOT NULL,
  id          text NOT NULL,
  scope_id    text,
  rev         integer NOT NULL,
  seq         bigint NOT NULL,
  deleted     boolean NOT NULL DEFAULT false,
  env_v       smallint, key_version smallint,
  nonce       bytea, ciphertext bytea,          -- NULL em tombstones
  size        integer NOT NULL DEFAULT 0,
  blobs       text[] NOT NULL DEFAULT '{}',      -- cópia de record_blobs para montar o Change sem join
  device_id   uuid,                              -- quem escreveu (sem FK: dispositivo pode sumir)
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
CREATE INDEX ON record_blobs (user_id, blob_id);

CREATE TABLE blobs (
  user_id        uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  blob_id        text NOT NULL,                -- 64 hex
  size           bigint NOT NULL,
  sha256_ct      bytea NOT NULL,               -- SHA-256 do ciphertext
  created_at     timestamptz NOT NULL DEFAULT now(),
  unreferenced_since timestamptz DEFAULT now(), -- NULL enquanto houver referência viva
  PRIMARY KEY (user_id, blob_id)
);
-- arquivo: ${BLOB_STORAGE_DIR}/<user_id>/<blob_id[0:2]>/<blob_id>

CREATE TABLE push_receipts (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  push_id uuid NOT NULL,
  response jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, push_id)
);

-- host de execução e divergência -------------------------------------------------------------
CREATE TABLE chat_states (
  user_id          uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  chat_id          text NOT NULL,
  head             bigint NOT NULL DEFAULT 0,
  host_device_id   uuid REFERENCES devices(id) ON DELETE SET NULL,
  epoch            integer NOT NULL DEFAULT 0,
  pinned           boolean NOT NULL DEFAULT false,
  window_purpose   text,                       -- run | edit | replay | NULL
  window_since     timestamptz,
  host_dropped_at  timestamptz,                -- início da tolerância
  host_grace_deadline timestamptz,
  handover_to      uuid REFERENCES devices(id) ON DELETE SET NULL,
  handover_mode    text, handover_requested_at timestamptz, handover_deadline timestamptz,
  divergence_id    uuid, diverged_device_id uuid, diverged_base bigint, diverged_head bigint, diverged_at timestamptz,
  ssq              bigint NOT NULL,
  updated_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, chat_id)
);
CREATE INDEX ON chat_states (user_id, ssq);
CREATE INDEX ON chat_states (user_id, host_device_id);

CREATE TABLE divergence_discards (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  chat_id text NOT NULL, device_id uuid NOT NULL, base bigint NOT NULL, divergence_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, chat_id, device_id, base)
);

-- abuso e auditoria -------------------------------------------------------------------------------
CREATE TABLE rate_counters (
  bucket       text NOT NULL,              -- ex.: 'code_req:email:<hmac hex>:1h', 'code_req:ip:1.2.3.4:24h'
  window_start timestamptz NOT NULL,
  count        integer NOT NULL,
  PRIMARY KEY (bucket, window_start)
);
CREATE TABLE lockouts (
  key        text PRIMARY KEY,             -- 'email:<hmac hex>:<rede do cliente>' (IPv4 /24, IPv6 /64)
  until      timestamptz NOT NULL,
  level      smallint NOT NULL DEFAULT 1   -- 1h, 2h, 4h … 24h
);
CREATE TABLE activity (
  id         bigserial PRIMARY KEY,
  user_id    uuid REFERENCES users(id) ON DELETE CASCADE,
  device_id  uuid,
  kind       text NOT NULL,                -- login, login_failed, signup, push, blob_upload, device_revoked, password_changed, keys_reset, ban…
  ip         inet,
  meta       jsonb,                         -- só metadados (contagens, bytes) — nunca conteúdo
  at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON activity (user_id, at DESC);
CREATE INDEX ON activity (at DESC);
CREATE INDEX ON activity (kind, at DESC);      -- 0002: visão geral do painel (janela de 14 dias)

-- contadores diários de uso para o painel (sem conteúdo): um upsert por push/upload em vez de uma
-- linha de activity a cada push (o host empurra a cada ~250 ms durante um turno)
CREATE TABLE usage_daily (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE, day date NOT NULL,
  pushes integer NOT NULL DEFAULT 0, push_items integer NOT NULL DEFAULT 0, push_bytes bigint NOT NULL DEFAULT 0,
  blob_uploads integer NOT NULL DEFAULT 0, blob_bytes bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, day)
);
```

A migração inicial (`backend/clearchat_server/db/alembic/versions/0001_initial.py`) é este esquema sem
as linhas marcadas `0002` (com nomes explícitos nos índices); `0002_auth_hardening.py` acrescenta o
histórico de rotação do refresh, o índice `activity (kind, at DESC)` e as restrições de uso não negativo
(zerando antes contadores que tenham derivado para negativo).

### 3.1 Transações e concorrência

- **Push**: uma transação; `SELECT … FROM users WHERE id = $1 FOR UPDATE` serializa os pushes do
  usuário (seq contíguos e cotas consistentes); `chat_states … FOR UPDATE` dos chats do lote (ordem
  determinística por `chat_id` para não haver deadlock). Depois do `COMMIT`, o hub transmite
  `sync.changes`.
- **Host** (`host.begin/end/takeover/release`, divergência): transação com `chat_states FOR UPDATE`;
  toda mudança incrementa `users.state_seq` e grava `ssq`; após commit, broadcast `chat.state`.
- **Cascata de chat**: no mesmo push do tombstone — `DELETE FROM records WHERE user_id=$1 AND scope_id=$2
  AND type IN ('session','message')`, `DELETE FROM chat_states`, ajuste de uso. Coleção de
  memória: `DELETE … type='memory' AND scope_id=$2`.
- **Uso**: `usage_*` ajustados na mesma transação (delta de `size`).
- **Validação do push** (`sync/records.py`): tipos de `KNOWN_TYPES`, escopo por tipo, ids pelo padrão de
  `RECORD_ID_RE`, `setting` nunca tombstone e teto de bytes. Os ids de `setting` **não** são filtrados:
  ids novos do app (ex.: `smartApproveDefaults`, `autoTitle`, `toolOutputSpillChars`, protocolo 1.4.0;
  `audioInput`, `sttSettings`, `ttsSettings`, `voiceCallDefaults`, protocolo 1.5.0) passam sem mudar o
  servidor. Também não há nada a validar nos campos novos de 1.5.0 (`provider.kind: 'elevenlabs'`,
  `ChatConfig.voice`, `MessageMeta.voice`/`voiceCall`, marcadores `kind: 'voice-call'`): vão dentro dos
  envelopes cifrados — só o site (cliente) os lê e mostra.
- **Ordem das checagens do push** (§7.4): validação → recibo (idempotência) → blobs → escopo
  (`scope_missing`/`scope_deleted`) → regras de conteúdo do chat (§8.4: divergência, `stale_base`,
  `not_host`, `chat_busy`) → revisão (`rev_mismatch`/`gone`) → cotas → escrita. As regras do chat vêm
  antes das de revisão para que um replay com base velha marque a divergência em vez de devolver
  `rev_mismatch`. A divergência é gravada numa transação própria (o lote em si é recusado). Base velha
  (`b < head`) só diverge se houver `session`/`message` do chat com `seq > b` gravado por outro
  dispositivo (`device_id IS DISTINCT FROM`, via `records_user_scope`); se tudo depois da base é do
  próprio remetente (lotes de um mesmo envio com a mesma base), o push segue como `b == head`.
- **Reset de chaves**: apaga registros/blobs sem tombstones; `seq` continua monotônico e
  `tombstone_floor = seq` (cursores antigos → `410 cursor_expired` → resync).

## 4. Backend — módulos

- **IP real** (middleware): se o IP do par estiver em `TRUSTED_PROXY_CIDRS`, usa `X-Real-IP`; senão o
  IP do par. Nunca confiar em `X-Forwarded-For` vindo de fora (o Nginx sobrescreve os dois cabeçalhos).
- **Base path**: `BASE_PATH` = caminho de `PUBLIC_BASE_URL` (ex.: `/clearchat`); as rotas são montadas em
  `${BASE_PATH}/api` e `${BASE_PATH}/ws` (o proxy não precisa reescrever caminhos).
- **Auth**: códigos (HMAC, tempo constante, uso único), convites, emissão/rotação de tokens,
  dispositivos; resposta idêntica e envio de e-mail em `BackgroundTask` (sem enumeração por tempo).
- **Turnstile**: se `captcha_enabled` e chaves presentes → `POST https://challenges.cloudflare.com/turnstile/v0/siteverify`
  (timeout 5 s; falha de rede → `captcha_failed`), conferindo `hostname` (host de `PUBLIC_BASE_URL`) e
  `action`.
- **Sync/records/blobs**: §6–7 e §14 do protocolo. Blob: grava em `…/<blob>.tmp-<uuid>`, confere tamanho
  e `X-Content-SHA256`, `fsync`, `rename`, insere a linha; `PUT` repetido → `200`.
- **Hub WS** (`realtime/`): registro `device_id → conexão` (uma por dispositivo), inscrições por chat,
  envio com fila por conexão (backpressure: fila > 1000 mensagens ou 8 MiB → fecha `4429`), heartbeat.
- **Host coordinator**: aplica a máquina de estados (§8 do protocolo); timers asyncio para
  `host_grace_deadline`/`handover_deadline`; no boot, marca todos os hosts como caídos com tolerância de
  `SERVER_RESTART_GRACE_S`.
- **Eventos do admin**: o painel roda em outro processo; ban, apagar conta, revogar dispositivos e
  mudar configurações fazem `NOTIFY clearchat_events` e a api (LISTEN) fecha os WebSockets (`4403`),
  transmite `chat.state` e invalida o cache das configurações.
- **Comandos remotos**: **não há fila guardada** (nem tabela). `remote.send` com o host online →
  repassa e guarda `cmd_id → remetente` só em memória até o `remote.result`; queda do host ou
  `COMMAND_RESULT_TIMEOUT_S` (30 s) → `remote.failed` ao remetente. Host fora → `host_offline` na hora.
  Só os `kind` de `COMMAND_KINDS` passam (desde 1.3.0 inclui `fs.list`/`fs.read`, a leitura de arquivos
  do host em pedaços); envelope de `remote.send` e de `remote.result` até `COMMAND_MAX_BYTES` (1 MiB).
  Um arquivo grande são centenas de pares `remote.send`/`remote.result` de ~0,7 MiB — sem limite por
  usuário além da fila por conexão (128 requisições / 16 MiB) e da fila de envio do hub (1000 msgs /
  8 MiB, acima → `4429`); o app mantém 3 pedaços em voo (≤ ~2,8 MiB), bem abaixo.
- **Jobs** (asyncio, a cada 5 min, com `pg_try_advisory_lock` para nunca rodar em dobro):
  tombstones > 180 d (atualiza `tombstone_floor`), blobs sem referência > 24 h (apaga arquivo e linha),
  `push_receipts` > 7 d, `email_codes` expirados > 1 d, `rate_counters` velhos, `activity` > 90 d, `access_tokens` expirados,
  histórico de rotação do refresh expirado (`auth.tokens.prune_refresh_history`).
- **E-mail**: aiosmtplib com `SMTP_TLS_MODE` = `starttls` | `ssl` | `none`; templates pt-BR em texto puro
  + HTML simples ("Seu código ClearChat: 123456", validade, "se não foi você, ignore"; convite; "você já
  tem conta"). Falha de SMTP é logada (sem o código) e não muda a resposta HTTP. `MAIL_BACKEND=auto` sem
  `SMTP_HOST` não envia nada: a subida registra um aviso alto e cada e-mail vira só um aviso com o tipo
  (sem destinatário, assunto ou código) — o console com código só existe se escolhido explicitamente.
- **Logs**: JSON estruturado; nunca registrar tokens, códigos, `key_proof`, envelopes ou corpos de push;
  e-mails só como HMAC. O log de requisições troca o token de convite do caminho por `***`; o engine do
  SQLAlchemy usa `hide_parameters=True` (erros sem os valores dos parâmetros). Exceção consciente:
  `MAIL_BACKEND=console` (desenvolvimento, só se escolhido explicitamente) escreve o e-mail inteiro, com o
  código, no log.
- **CORS**: só com `ALLOWED_ORIGINS` (lista exata, com credenciais); `*` é recusado na subida.

### 4.1 Lacunas do contrato

As interpretações adotadas durante a implementação (corpos de resposta de `/records`, `/chat-states`,
`divergence/resolve`, `/keys/*` e `/blobs`; stream sem janela aberta; modos A/B do push e `chat_busy` em
tolerância; ordem das checagens; `host.release` sem troca; eventos de tolerância; `keys.reset` com `4403`
sem revogar; fechamento por ociosidade `1000`; refresh do site com corpo `{}`) foram incorporadas ao
`docs/SYNC_PROTOCOL.md` (v1.5.0, ainda não lançado) — vale o que está lá.

## 5. Rate limiting

Duas camadas:

1. **Nginx** (`limit_req`, por IP, antes de chegar na app):
   ```nginx
   # no bloco http {}
   limit_req_zone $binary_remote_addr zone=cc_auth:10m rate=10r/m;
   limit_req_zone $binary_remote_addr zone=cc_api:10m  rate=30r/s;
   limit_req_zone $binary_remote_addr zone=cc_ws:10m   rate=20r/m;
   limit_req_status 429;
   ```
   `/api/v1/auth/` → `cc_auth burst=10 nodelay`; `/api/` → `cc_api burst=60 nodelay`; `/ws` → `cc_ws burst=10`.
2. **Aplicação** (contadores em `rate_counters`, janela fixa; bloqueios em `lockouts`): os limites de
   SYNC_PROTOCOL §17.3, por e-mail (HMAC) e por IP; respostas `429` com `Retry-After`. Mesmo sem
   captcha (self-host sem Turnstile), esta camada continua. O `code/verify` conta por e-mail + rede do
   cliente (IPv4 /24, IPv6 /64), com um teto alto só por e-mail, e o bloqueio só soma erros contra um código
   vivo — quem não lê a caixa de e-mail não esgota o limite nem bloqueia o dono. Login sem conta (ou banida)
   e cadastro de conta existente gravam um código que nunca é enviado, para o bloqueio não revelar contas.
   Troca de wrap (`PUT /keys/password|recovery`): 10/h por conta. Os limites por IP dependem do IP real:
   proxy fora de `TRUSTED_PROXY_CIDRS` = todos os clientes com o IP do proxy, dividindo os mesmos baldes.

## 6. Painel admin (só do dono, nunca exposto)

- Serviço `admin` separado, publicado por padrão **só** em `127.0.0.1:${ADMIN_PORT}` (no compose:
  `"${ADMIN_BIND_ADDR:-127.0.0.1}:${ADMIN_PORT}:8090"`). Opcionalmente pode ser liberado na **rede local**:
  `ADMIN_BIND_ADDR=<IP da LAN do servidor>` + `ADMIN_ALLOWED_HOSTS=<esse IP>` (o admin só aceita esses
  cabeçalhos `Host`). Nunca na internet. Instância oficial: liberado na LAN em `172.16.1.7:8195`. Fora do Docker,
  `python -m clearchat_admin` recusa escutar fora do loopback (dentro do container usa
  `--host 0.0.0.0 --in-container`, e o isolamento fica com o mapeamento de porta do compose). Acesso:
  `ssh -L 8190:127.0.0.1:8190 ezenere@172.16.1.7` → `http://localhost:8190`.
- **O Nginx nunca roteia para ele** (nenhum `location` aponta para a porta do admin; o exemplo de Nginx
  não o menciona). Vale também em self-host.
- Autenticação: `ADMIN_TOKEN` do `.env` (≥ 32 caracteres aleatórios) num formulário de login → cookie de
  sessão assinado (`HttpOnly`, `SameSite=Strict`, expira em 12 h; `Secure` quando o painel é servido por
  https — `ADMIN_HTTPS=true` atrás de um proxy TLS, ou TLS direto; em http na LAN/túnel fica sem `Secure`). Defesas extras: aceita só `Host`
  `localhost:<porta>`/`127.0.0.1:<porta>` e os de `ADMIN_ALLOWED_HOSTS` (anti DNS rebinding), token CSRF em todo formulário, limite de
  5 tentativas de login/min, comparação em tempo constante. Sem token configurado → o admin não sobe
  (no container ele só registra o erro e fica parado, para não reiniciar em loop).
- Funcionalidades:
  - **Usuários**: lista/busca (e-mail, nome, criado, último acesso, status, dispositivos, uso), detalhe.
  - **Armazenamento** por usuário e por tipo de registro (`SELECT type, count(*), sum(size) FROM records
    WHERE user_id=$1 AND NOT deleted GROUP BY type`) + blobs.
  - **Atividade**: logins, falhas, pushes/uploads por dia (a partir de `activity`), usuários ativos.
  - **Cotas**: editar `quota_*` por usuário (vazio = ilimitado) e mostrar uso × limite.
  - **Banir/desbanir**: banir revoga todos os dispositivos e fecha os WebSockets (`4403`); login passa a
    não enviar código (resposta idêntica).
  - **Apagar conta** (com confirmação digitando o e-mail): registros, blobs (arquivos), dispositivos.
  - **Criar usuário** (e-mail + nome; opcionalmente enviar e-mail de boas-vindas com o link de login) e
    **convites** (gerar link de uso único com validade e e-mail opcional; listar/revogar).
  - **Configurações da instância** (`instance_settings`): nome, cadastro aberto, landing, captcha
    (mostra se as chaves Turnstile existem no `.env`), gateway (reservado, desabilitado).
  - Nunca mostra conteúdo (o servidor não tem como decifrar).

## 7. Site (frontend)

- Rotas: `/` (landing — ou login/painel se `landing` desligada), `/signup`, `/login`, `/setup`
  (definir senha de criptografia), `/unlock`, `/recover`, `/app` (painel), `/captcha`, `/captcha/done`.
- Landing: apresenta o ClearChat (destaques do README do app, screenshots), downloads
  (`https://github.com/ezenere/ClearChat/releases`), "Criar conta" só com `signupOpen`.
- Painel (tudo decifrado no navegador): conversas (listar/ver com markdown/apagar), provedores e chaves
  de busca (editar registros `provider` e `setting webSearchApiKeys`), trocar senha, recuperação, nova
  chave de recuperação, dispositivos (listar/renomear/revogar), apagar conta, "zerar criptografia".
- Cripto: hash-wasm 4.12.0 (Argon2id) em Web Worker + WebCrypto; testes rodam os vetores de
  `docs/test-vectors/`. CSP (servida pelo nginx do container, `frontend/docker/40-clearchat-site.sh`):
  `default-src 'self'; script-src 'self' 'wasm-unsafe-eval' https://challenges.cloudflare.com;
  frame-src https://challenges.cloudflare.com; connect-src 'self' wss: ws: https://api.github.com;
  img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; worker-src 'self'; object-src 'none';
  base-uri 'self'; frame-ancestors 'none'; form-action 'self'`. `https://api.github.com`: a landing
  consulta a última release do app. `base-uri 'self'` (e não `'none'`): o `index.html` usa `<base href>`.
- Base path em tempo de execução: o build usa caminhos relativos; no start, o container (script em
  `frontend/docker/`) gera `config.js` com `window.__CLEARCHAT__ = { baseUrl: PUBLIC_BASE_URL }`,
  **reescreve o `<base href="/">` do `index.html` para `<base href="<caminho>/">`** e monta o server block
  do nginx para servir sob o caminho; o router usa esse caminho como `basename`.
- O site é um "dispositivo" (`client: web`, `can_host: false`); PODE usar o WebSocket para assistir ao
  vivo e mandar comandos remotos (fora do escopo mínimo).

## 8. Deploy (Docker Compose)

Servidor do usuário: `ssh ezenere@172.16.1.7`, pasta `/srv/websites/clear-chat`, atrás do Nginx dele
em `https://clear.ezenere.com` (TLS no Nginx). **O usuário configura Nginx e DNS.**

```bash
cd /srv/websites/clear-chat
cp .env.example .env && $EDITOR .env        # segredos, SMTP, Turnstile, PUBLIC_BASE_URL
docker compose up -d --build                 # db → api (roda as migrações no start) → web → admin
docker compose logs -f api
```

**O Nginx roda na mesma máquina que o Docker (172.16.1.7)** — confirmado. Por isso todas as portas são
publicadas só em `127.0.0.1` (`BIND_ADDR=127.0.0.1`, padrão): `API_PORT=8100`, `WEB_PORT=8101`,
`ADMIN_PORT=8190` (o admin usa `ADMIN_BIND_ADDR`, padrão 127.0.0.1, independente do `BIND_ADDR`). Postgres sem
porta publicada. Uma conexão do Nginx para `127.0.0.1:8100` chega no container vinda do gateway da bridge
do compose (o docker-proxy reescreve a origem), por isso a rede tem sub-rede fixa (`COMPOSE_SUBNET`,
padrão `172.31.250.0/24`) e `TRUSTED_PROXY_CIDRS=127.0.0.1/32,172.31.250.1/32,172.31.250.250/32`
(padrão; o `.250` é o Caddy do perfil `edge`, com IP fixo `EDGE_IP`) — a api só aceita `X-Real-IP` vindo
daí. (Em self-host com o proxy em outra máquina: `BIND_ADDR` = interface da LAN e
o IP do proxy em `TRUSTED_PROXY_CIDRS`.)

### 8.1 Nginx (exemplo — `deploy/nginx.example.conf`)

```nginx
# http {} : zonas de limit_req da §5
map $http_upgrade $connection_upgrade { default upgrade; '' close; }

server {
    listen 443 ssl;
    http2 on;
    server_name clear.ezenere.com;
    # ssl_certificate / ssl_certificate_key …  (TLS termina aqui)

    add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;
    add_header X-Content-Type-Options nosniff always;
    add_header Referrer-Policy no-referrer always;

    # cabeçalhos de IP: SOBRESCREVER (nunca repassar o que o cliente mandou)
    proxy_set_header Host              $host;
    proxy_set_header X-Real-IP         $remote_addr;
    proxy_set_header X-Forwarded-For   $remote_addr;
    proxy_set_header X-Forwarded-Proto $scheme;

    location /api/v1/auth/ {
        limit_req zone=cc_auth burst=10 nodelay;
        proxy_pass http://127.0.0.1:8100;
    }
    location /api/v1/blobs/ {
        limit_req zone=cc_api burst=60 nodelay;
        client_max_body_size 300m;
        proxy_request_buffering off;
        proxy_buffering off;
        proxy_read_timeout 300s;
        proxy_send_timeout 300s;
        proxy_pass http://127.0.0.1:8100;
    }
    location /api/ {
        limit_req zone=cc_api burst=60 nodelay;
        client_max_body_size 40m;
        proxy_pass http://127.0.0.1:8100;
    }
    location = /ws {
        limit_req zone=cc_ws burst=10;
        proxy_pass http://127.0.0.1:8100;
        proxy_http_version 1.1;
        # um location com proxy_set_header próprio NÃO herda os do server: repetir os de IP
        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $remote_addr;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Upgrade    $http_upgrade;
        proxy_set_header Connection $connection_upgrade;
        proxy_read_timeout 3600s;     # heartbeats a cada 15 s mantêm viva
        proxy_send_timeout 3600s;
        proxy_buffering off;
    }
    location / {
        proxy_pass http://127.0.0.1:8101;   # SPA (o container web faz o fallback para index.html)
    }
    # NUNCA: nenhum location para 127.0.0.1:8190 (admin)
}
server { listen 80; server_name clear.ezenere.com; return 301 https://$host$request_uri; }
```

Com base path (ex.: `/clearchat`), prefixar cada `location` (`/clearchat/api/…`, `/clearchat/ws`,
`/clearchat/`) mantendo `proxy_pass` **sem** caminho (a app já espera o prefixo).

**IP real do cliente — cadeia completa.** Cliente → Nginx do host (`$remote_addr`) → `X-Real-IP` /
`X-Forwarded-For` **sobrescritos** com `$remote_addr` → container da api, que só aceita esses cabeçalhos
quando a conexão vem de `TRUSTED_PROXY_CIDRS` (`127.0.0.1`, gateway `172.31.250.1` do compose); de
qualquer outra origem usa o IP do par (`clearchat_server/util.py:client_ip`). Os `limit_req` do Nginx
(chave `$binary_remote_addr`) e os limites por IP da api (§5) usam esse mesmo IP.

**Atrás da Cloudflare (OPCIONAL — só com o proxy da Cloudflare ligado, "nuvem laranja").** Com o proxy,
toda conexão chega de uma borda da Cloudflare (ex.: `172.69.x.x`) e, sem ajuste, o `$remote_addr` — e
portanto `X-Real-IP`, os `limit_req` e os limites por IP da api — seria o da borda (todos os usuários
dividiriam o mesmo balde). A correção é no Nginx, com o `ngx_http_realip_module` (incluído nos pacotes
do Debian/Ubuntu e no nginx.org): o `deploy/nginx.example.conf` traz, **comentado**, um bloco com
`set_real_ip_from` para cada faixa IPv4/IPv6 publicada em <https://www.cloudflare.com/ips-v4> e
<https://www.cloudflare.com/ips-v6> e `real_ip_header CF-Connecting-IP;`. Descomentado (no mesmo
`server {}` dos `location`), o Nginx troca o `$remote_addr` pelo `CF-Connecting-IP` **apenas** quando a
conexão vem de uma faixa da Cloudflare — de qualquer outra origem o cabeçalho é ignorado, então ninguém
forja o IP falando direto com a origem; conexões que não passam pela Cloudflare (rede local, acesso
direto pelo IP) continuam com o próprio IP. Nada muda no backend: ele continua confiando no `X-Real-IP`
que o Nginx local (127.0.0.1 / gateway do compose) escreve, agora com o IP real. Com DNS only (sem proxy),
deixe o bloco comentado. As faixas da Cloudflare mudam raramente; revise a lista de vez em quando.

### 8.2 Backup e atualização

- Backup: `docker compose exec db pg_dump -Fc clearchat > backup.dump` + cópia do volume `blobs`
  (tudo já cifrado no cliente, mas e-mails/metadados não).
- Atualizar: `git pull && docker compose up -d --build` (migrações Alembic no start da api; o reinício
  dá 60 s de tolerância aos hosts conectados).

## 9. Self-host — início rápido

```bash
git clone https://github.com/ezenere/ClearChatWebsite.git && cd ClearChatWebsite
cp .env.example .env
#   PUBLIC_BASE_URL=http://192.168.0.10:8080      (ou https://chat.seudominio.com, ou …/clearchat)
#   SERVER_SECRET, ADMIN_TOKEN, POSTGRES_PASSWORD  → openssl rand -base64 48
#   SMTP_*                                         → seu servidor de e-mail (códigos de login)
#   TURNSTILE_* vazios                             → sem captcha (rate limit continua)
#   TRUSTED_PROXY_CIDRS                            → deixe o padrão (inclui o Caddy do edge, EDGE_IP);
#                                                    proxy próprio em outra máquina? acrescente o IP dele
docker compose --profile edge up -d --build        # perfil "edge": um proxy Caddy numa porta só (EDGE_PORT)
ssh -L 8190:127.0.0.1:8190 voce@servidor           # se for remoto; local: http://localhost:8190
#   painel admin → Configurações da instância → desligar "Cadastro aberto" → Convites → gerar link
```

- Sem Nginx próprio: o perfil `edge` sobe um Caddy que roteia `/` → web, `/api` → api, `/ws` → api em
  `EDGE_PORT` (HTTP; para HTTPS público use um domínio no Caddy ou o seu proxy).
- `TRUSTED_PROXY_CIDRS`: o Caddy do `edge` tem IP fixo na rede interna (`EDGE_IP`, padrão
  `172.31.250.250`), já incluído no padrão — a api usa o `X-Real-IP` que ele manda e cada cliente tem os
  próprios limites por IP. Mudou `COMPOSE_SUBNET`? Ajuste `EDGE_IP` e `TRUSTED_PROXY_CIDRS` juntos; um
  proxy fora da lista faz todos os clientes dividirem o IP dele (e os limites por IP).
- No app: Configurações → Conta → Servidor → **Self-host** → `http://192.168.0.10:8080` (o app valida
  com `/api/info`).
- O painel admin continua só em `127.0.0.1` — nunca exponha a porta dele.

## 10. Desenvolvimento e testes

```bash
cd backend
make venv                      # .venv com o backend + dev (Python ≥ 3.12; a imagem usa 3.13)
make init-env                  # ../.env com segredos gerados (ajuste DATABASE_URL, PUBLIC_BASE_URL)
make db-up                     # Postgres descartável no Docker em 127.0.0.1:55432 (ou qualquer Postgres ≥ 13)
make migrate && make dev       # api em http://127.0.0.1:8100 (MAIL_BACKEND=console mostra os códigos no log)
make admin                     # painel em http://127.0.0.1:8190
make test                      # pytest — APAGA e recria o schema de TEST_DATABASE_URL
make check                     # ruff + mypy + testes
```

Os testes sobem a api de verdade (uvicorn numa porta livre) contra um Postgres real, com timers do
protocolo encurtados (tolerância 0,5 s, troca forçada 0,6 s, timeout de comando 0,6 s), e cobrem auth,
sessões, chaves, push/pull, blobs, WebSocket, host/comandos/stream, divergência e o painel admin.
Turnstile é testado com um transporte httpx falso (sem rede).

Site (`frontend/`): `npm run test` (unitários, inclusive os vetores de cripto), `npm run test:e2e`
(Playwright contra a API simulada de `src/mock`) e o **E2E de integração contra o backend real**
(`e2e-integration/`): com a api rodando (`MAIL_BACKEND=console`, cadastro aberto, sem Turnstile),
`CLEARCHAT_IT_BACKEND_URL=http://127.0.0.1:8100 CLEARCHAT_IT_MAIL_LOG=/caminho/do/log-da-api npm run
test:e2e:integration` sobe o Vite (sem mock, repassando `/api` e `/ws` para a api) e cobre cadastro,
login por código em outro navegador, desbloqueio, WebSocket chegando a "Ao vivo", registro criado pelo
site aparecendo no feed `GET /sync/changes` e a notificação `sync.changes` atualizando a lista da outra
aba, além da reconexão após queda. Sem `CLEARCHAT_IT_BACKEND_URL` os testes são pulados.

## 11. Checklist de segurança

- TLS obrigatório em produção (HSTS); `http://` só em LAN (o app avisa).
- Segredos só no `.env` (permissão 600, já criado assim pelo `init-env`); `.env`, `*.pem` e `*.key` no `.gitignore`.
- Respostas de auth idênticas (sem enumeração); códigos e tokens só como hash.
- O servidor nunca recebe senha, DEK ou chave de recuperação; `key_proof` só compara com o verifier.
- Postgres e admin sem exposição externa; Nginx nunca roteia para o admin.
- Uploads em arquivo temporário + rename; caminho do blob derivado só de `user_id` + `blob_id` validado
  (`^[0-9a-f]{64}$`) — sem path traversal.
- CSP estrita no site (`wasm-unsafe-eval` só para o Argon2id). XSS no site = vazamento da senha no
  desbloqueio: sem `dangerouslySetInnerHTML` com conteúdo de chat (markdown sanitizado).
- Logs sem conteúdo, tokens ou códigos.
