# ClearChatWebsite

Servidor de sincronização **zero-knowledge** + site do [ClearChat](https://github.com/ezenere/ClearChatDesktop)
(app desktop de chat com IA). Um repositório só: **backend** (FastAPI + Postgres), **frontend** (React —
landing, cadastro, login, painel que decifra no navegador) e **admin** (painel local do dono da instância).
Instância oficial: https://clear.ezenere.com — qualquer pessoa pode hospedar a sua (self-host).

> ⚠️ **AVISO — PROTOCOLO DE SYNC COMPARTILHADO**
>
> Este repositório faz parte do projeto [ClearChat](https://github.com/ezenere): app desktop
> ([ClearChatDesktop](https://github.com/ezenere/ClearChatDesktop)), servidor de sync e site
> ([ClearChatWebsite](https://github.com/ezenere/ClearChatWebsite)) e app mobile. Todos implementam o
> protocolo em [`docs/SYNC_PROTOCOL.md`](docs/SYNC_PROTOCOL.md) (vetores em `docs/test-vectors/`), cuja
> fonte única fica no repositório pai `ClearChat/docs/` — aqui é uma cópia idêntica. **Qualquer mudança**
> no protocolo, na criptografia, nos esquemas dos registros, nos endpoints ou nas mensagens de WebSocket
> é feita no pai, copiada com `node ../scripts/protocol.mjs sync` e implementada no app **e** no
> servidor, com a versão do protocolo incrementada. Mudar um lado só **quebra o sync**.

## Estado

Backend, painel admin e site implementados (protocolo v1). Estrutura:

| Pasta | Conteúdo |
|---|---|
| `docs/SYNC_PROTOCOL.md` | **o contrato** com os clientes (cripto, registros, REST, WebSocket, host de execução, divergência) — idêntico no repo do app |
| `docs/test-vectors/` | implementação de referência (`generate.ts`) + vetores JSON — idênticos no repo do app |
| `docs/ARCHITECTURE.md` | arquitetura do servidor: componentes, tabelas, rate limit, admin, deploy, Nginx, self-host |
| `backend/` | API FastAPI + Postgres (REST `/api`, WebSocket `/ws`, host de execução, blobs, GC) — `make -C backend help` |
| `frontend/` | site React + Vite (a implementar) |
| `admin/` | painel admin (FastAPI + Jinja2), só em 127.0.0.1 |
| `deploy/` | exemplo de Nginx e Caddyfile do perfil self-host |
| `docker-compose.yml`, `.env.example` | deploy (db, api, web, admin; perfil `edge` com Caddy) |

## Backend: desenvolvimento

```bash
cd backend
make venv && make init-env        # .venv + ../.env com segredos gerados (ajuste DATABASE_URL)
make migrate && make dev          # api em http://127.0.0.1:8100 (códigos de login no log com MAIL_BACKEND=console)
make admin                        # painel em http://127.0.0.1:8190 (ADMIN_TOKEN do .env)
make check                        # ruff + mypy + pytest (TEST_DATABASE_URL: banco descartável, é apagado)
```

Detalhes em [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) §10.

## Vetores de teste

```bash
cd docs/test-vectors && npm install && node generate.ts --check   # Node ≥ 22.18
```

## Deploy e self-host

Ver [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) §8 (produção atrás do Nginx) e §9 (início rápido de
self-host: `docker compose --profile edge up -d`, criar admin, desligar o cadastro aberto).

**Notificações push (opcional, protocolo 1.7.0):** o JSON da conta de serviço do Firebase fica numa pasta
fora do git (`secrets/`, montada só leitura em `/run/secrets/clearchat`) e o `.env` aponta para ele com
`FCM_SERVICE_ACCOUNT_FILE=/run/secrets/clearchat/<arquivo>.json`. Sem isso a instância funciona sem push
(`features.push = null`). Passo a passo em [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) §8.0. O painel
admin nunca é exposto: só `127.0.0.1`, acesso por túnel SSH.
