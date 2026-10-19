# ClearChatWebsite

Servidor de sincronização **zero-knowledge** + site do [ClearChat](https://github.com/ezenere/ClearChat)
(app desktop de chat com IA). Um repositório só: **backend** (FastAPI + Postgres), **frontend** (React —
landing, cadastro, login, painel que decifra no navegador) e **admin** (painel local do dono da instância).
Instância oficial: https://clear.ezenere.com — qualquer pessoa pode hospedar a sua (self-host).

> ⚠️ **AVISO — PROTOCOLO COMPARTILHADO COM O APP**
>
> Estes dois projetos (**ClearChat** app ↔ **ClearChatWebsite** servidor/site) compartilham o protocolo
> de sync em [`docs/SYNC_PROTOCOL.md`](docs/SYNC_PROTOCOL.md) (e os vetores em `docs/test-vectors/`).
> **Qualquer mudança** no protocolo, na criptografia, nos esquemas dos registros, nos endpoints ou nas
> mensagens de WebSocket precisa ser feita **nos DOIS repositórios** — mantenha os documentos idênticos,
> regenere os vetores e suba a versão do protocolo. Mudar um lado só **quebra o sync**.

## Estado

Contrato definido; implementação ainda não começou. Estrutura:

| Pasta | Conteúdo |
|---|---|
| `docs/SYNC_PROTOCOL.md` | **o contrato** com os clientes (cripto, registros, REST, WebSocket, host de execução, divergência) — idêntico no repo do app |
| `docs/test-vectors/` | implementação de referência (`generate.ts`) + vetores JSON — idênticos no repo do app |
| `docs/ARCHITECTURE.md` | arquitetura do servidor: componentes, tabelas, rate limit, admin, deploy, Nginx, self-host |
| `backend/` | API FastAPI (a implementar) |
| `frontend/` | site React + Vite (a implementar) |
| `admin/` | painel admin, só em 127.0.0.1 (a implementar) |
| `deploy/` | exemplo de Nginx e Caddyfile do perfil self-host |
| `docker-compose.yml`, `.env.example` | esqueleto do deploy |

## Vetores de teste

```bash
cd docs/test-vectors && npm install && node generate.ts --check   # Node ≥ 22.18
```

## Deploy e self-host

Ver [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) §8 (produção atrás do Nginx) e §9 (início rápido de
self-host: `docker compose --profile edge up -d`, criar admin, desligar o cadastro aberto). O painel
admin nunca é exposto: só `127.0.0.1`, acesso por túnel SSH.
