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
  expiração de comandos) ficam em memória do processo, com o estado durável no Postgres. Escala de uma
  instância pessoal/pequena cabe com folga. Caminho futuro para vários workers: `LISTEN/NOTIFY` do
  Postgres para fan-out entre processos + timers baseados em colunas `*_deadline` varridas por job (o
  esquema abaixo já guarda os deadlines).
- **Sem Redis**: rate limit e contadores em Postgres (`INSERT … ON CONFLICT … RETURNING`).
- **Sem CORS** por padrão (site na mesma origem; apps nativos não fazem CORS). `ALLOWED_ORIGINS` opcional.

## 2. Layout do repositório

```
backend/            Python (pacote clearchat_server): app FastAPI da api
  clearchat_server/
    main.py           # cria a app, monta rotas sob BASE_PATH, middlewares (IP real, logs)
    config.py         # lê o .env (pydantic-settings)
    db/               # modelos SQLAlchemy, sessão, migrações Alembic (alembic/)
    auth/             # códigos por e-mail, convites, tokens, dispositivos
    keys/             # wraps, verifier
    sync/             # push/pull, records, blobs, cascatas, cotas
    realtime/         # hub WS, host coordinator, stream relay, comandos
    ratelimit/        # contadores Postgres, bloqueios
    mail/             # SMTP + templates pt-BR
    instance/         # configurações da instância (/api/info)
    jobs/             # GC e expirações (tarefas asyncio periódicas)
  tests/
  pyproject.toml, Dockerfile
frontend/           React + Vite + TS (site)
  src/ … ; Dockerfile (build → nginx estático; gera config.js com PUBLIC_BASE_URL no start)
admin/              FastAPI + Jinja2 (importa clearchat_server.db), Dockerfile
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
  refresh_prev_hash bytea,                     -- anterior (detecção de reuso)
  refresh_expires_at timestamptz
);
CREATE INDEX ON devices (user_id) WHERE revoked_at IS NULL;

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

CREATE TABLE chat_commands (            -- comandos remotos em trânsito / guardados (SYNC §8.6–8.7)
  user_id        uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  chat_id        text NOT NULL,
  cmd_id         text NOT NULL,
  kind           text NOT NULL,
  from_device_id uuid,
  env            jsonb NOT NULL,
  stored         boolean NOT NULL,         -- true = guardado (send com host fora); false = em trânsito
  created_at     timestamptz NOT NULL DEFAULT now(),
  expires_at     timestamptz,              -- só guardados
  delivered_at   timestamptz,              -- entregue ao host, aguardando remote.result
  pos            bigserial,
  PRIMARY KEY (user_id, chat_id, cmd_id)
);
CREATE INDEX ON chat_commands (expires_at) WHERE stored;

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
  key        text PRIMARY KEY,             -- 'email:<hmac hex>'
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
```

### 3.1 Transações e concorrência

- **Push**: uma transação; `SELECT … FROM users WHERE id = $1 FOR UPDATE` serializa os pushes do
  usuário (seq contíguos e cotas consistentes); `chat_states … FOR UPDATE` dos chats do lote (ordem
  determinística por `chat_id` para não haver deadlock). Depois do `COMMIT`, o hub transmite
  `sync.changes`.
- **Host** (`host.begin/end/takeover/release`, divergência): transação com `chat_states FOR UPDATE`;
  toda mudança incrementa `users.state_seq` e grava `ssq`; após commit, broadcast `chat.state`.
- **Cascata de chat**: no mesmo push do tombstone — `DELETE FROM records WHERE user_id=$1 AND scope_id=$2
  AND type IN ('session','message')`, `DELETE FROM chat_states/chat_commands`, ajuste de uso. Coleção de
  memória: `DELETE … type='memory' AND scope_id=$2`.
- **Uso**: `usage_*` ajustados na mesma transação (delta de `size`).

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
- **Jobs** (asyncio, a cada 5 min, com `pg_try_advisory_lock` para nunca rodar em dobro):
  tombstones > 180 d (atualiza `tombstone_floor`), blobs sem referência > 24 h (apaga arquivo e linha),
  `push_receipts` > 7 d, `email_codes` expirados > 1 d, `chat_commands` guardados expirados (broadcast
  `command_expired`), `rate_counters` velhos, `activity` > 90 d, `access_tokens` expirados.
- **E-mail**: aiosmtplib com `SMTP_TLS_MODE` = `starttls` | `ssl` | `none`; templates pt-BR em texto puro
  + HTML simples ("Seu código ClearChat: 123456", validade, "se não foi você, ignore"; convite; "você já
  tem conta"). Falha de SMTP é logada (sem o código) e não muda a resposta HTTP.
- **Logs**: JSON estruturado; nunca registrar tokens, códigos, `key_proof`, envelopes ou corpos de push;
  e-mails só como HMAC.

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
   captcha (self-host sem Turnstile), esta camada continua.

## 6. Painel admin (só do dono, nunca exposto)

- Serviço `admin` separado, publicado **só** em `127.0.0.1:${ADMIN_PORT}` (no compose:
  `"127.0.0.1:${ADMIN_PORT}:8090"` — fixo, não configurável para outra interface). Acesso:
  `ssh -L 8190:127.0.0.1:8190 ezenere@172.16.1.7` → `http://localhost:8190`.
- **O Nginx nunca roteia para ele** (nenhum `location` aponta para a porta do admin; o exemplo de Nginx
  não o menciona). Vale também em self-host.
- Autenticação: `ADMIN_TOKEN` do `.env` (≥ 32 caracteres aleatórios) num formulário de login → cookie de
  sessão assinado (`HttpOnly`, `SameSite=Strict`, expira em 12 h). Defesas extras: aceita só `Host`
  `localhost:<porta>`/`127.0.0.1:<porta>` (anti DNS rebinding), token CSRF em todo formulário, limite de
  5 tentativas de login/min, comparação em tempo constante. Sem token configurado → o admin não sobe.
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
  `docs/test-vectors/`. CSP: `default-src 'self'; script-src 'self' 'wasm-unsafe-eval'
  https://challenges.cloudflare.com; frame-src https://challenges.cloudflare.com; connect-src 'self'
  wss: ws:; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; object-src 'none';
  base-uri 'none'; frame-ancestors 'none'`.
- Base path em tempo de execução: o build usa caminhos relativos (`base: './'`); no start, o container
  gera `config.js` com `window.__CLEARCHAT__ = { baseUrl: PUBLIC_BASE_URL }` e o router usa o caminho
  dele como `basename`.
- O site é um "dispositivo" (`client: web`, `can_host: false`); PODE usar o WebSocket para assistir ao
  vivo e mandar comandos remotos (fora do escopo mínimo).

## 8. Deploy (Docker Compose)

Servidor do usuário: `ssh ezenere@172.16.1.7`, pasta `/srv/websites/clear-chat`, atrás do Nginx dele
em `https://clear.ezenere.com` (TLS no Nginx). **O usuário configura Nginx e DNS.**

```bash
cd /srv/websites/clear-chat
cp .env.example .env && $EDITOR .env        # segredos, SMTP, Turnstile, PUBLIC_BASE_URL
docker compose up -d --build                 # db → api (roda `alembic upgrade head` no start) → web → admin
docker compose logs -f api
```

Portas no host (todas em `127.0.0.1` por padrão; `BIND_ADDR` muda api/web se o Nginx estiver em outra
máquina — o admin fica sempre em 127.0.0.1): `API_PORT=8100`, `WEB_PORT=8101`, `ADMIN_PORT=8190`.
Postgres sem porta publicada. Rede do compose com sub-rede fixa (`COMPOSE_SUBNET`, padrão
`172.31.250.0/24`) para que `TRUSTED_PROXY_CIDRS` cubra o gateway da bridge por onde o Nginx do host chega.

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
docker compose --profile edge up -d --build        # perfil "edge": um proxy Caddy numa porta só (EDGE_PORT)
ssh -L 8190:127.0.0.1:8190 voce@servidor           # se for remoto; local: http://localhost:8190
#   painel admin → Configurações da instância → desligar "Cadastro aberto" → Convites → gerar link
```

- Sem Nginx próprio: o perfil `edge` sobe um Caddy que roteia `/` → web, `/api` → api, `/ws` → api em
  `EDGE_PORT` (HTTP; para HTTPS público use um domínio no Caddy ou o seu proxy).
- No app: Configurações → Conta → Servidor → **Self-host** → `http://192.168.0.10:8080` (o app valida
  com `/api/info`).
- O painel admin continua só em `127.0.0.1` — nunca exponha a porta dele.

## 10. Checklist de segurança

- TLS obrigatório em produção (HSTS); `http://` só em LAN (o app avisa).
- Segredos só no `.env` (permissão 600); `.env` no `.gitignore`.
- Respostas de auth idênticas (sem enumeração); códigos e tokens só como hash.
- O servidor nunca recebe senha, DEK ou chave de recuperação; `key_proof` só compara com o verifier.
- Postgres e admin sem exposição externa; Nginx nunca roteia para o admin.
- Uploads em arquivo temporário + rename; caminho do blob derivado só de `user_id` + `blob_id` validado
  (`^[0-9a-f]{64}$`) — sem path traversal.
- CSP estrita no site (`wasm-unsafe-eval` só para o Argon2id). XSS no site = vazamento da senha no
  desbloqueio: sem `dangerouslySetInnerHTML` com conteúdo de chat (markdown sanitizado).
- Logs sem conteúdo, tokens ou códigos.
