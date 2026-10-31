# CLAUDE.md — ClearChatWebsite

> ⚠️ **AVISO — PROTOCOLO DE SYNC COMPARTILHADO**
> Este repositório faz parte da pasta `ClearChat/` (repositório pai com o que é compartilhado) junto com
> `../ClearChatDesktop` (app), `../ClearChatWebsite` (servidor/site) e `../ClearChatMobile` (mobile).
> O protocolo de sync tem fonte única em `../docs/SYNC_PROTOCOL.md` (e `../docs/test-vectors/`); o
> `docs/` daqui é uma cópia byte a byte. Qualquer mudança no protocolo, na criptografia, nos esquemas dos
> registros, nos endpoints ou nas mensagens de WebSocket: edite no pai, suba a versão + changelog, rode
> `node ../scripts/protocol.mjs sync` e implemente no app **e** no servidor (o mobile revendora). Mudar
> um lado só quebra o sync. Regras gerais: `../CLAUDE.md`.

## Onde está o quê
- `docs/SYNC_PROTOCOL.md` — contrato normativo (vence qualquer outro documento).
- `docs/ARCHITECTURE.md` — como o servidor implementa: tabelas Postgres, módulos, rate limit, admin, deploy.
- `docs/test-vectors/generate.ts` — implementação de referência da cripto; `node generate.ts --check` deve passar.
  Testes do backend (formato de envelope) e do frontend (cripto completa) devem consumir os JSON.
- `backend/` FastAPI + SQLAlchemy async + Alembic (1 worker) · `frontend/` React + Vite + hash-wasm ·
  `admin/` FastAPI + Jinja2 só em 127.0.0.1.

## Regras
- Zero-knowledge: o servidor nunca recebe senha, DEK, chave de recuperação nem plaintext. Logs sem tokens,
  códigos, envelopes ou conteúdo.
- Nada hardcoded para `clear.ezenere.com`: tudo deriva de `PUBLIC_BASE_URL` (self-host, base path).
- Admin: nunca exposto, nunca roteado pelo Nginx.
- Não mexer no servidor de produção (`ezenere@172.16.1.7:/srv/websites/clear-chat`) sem pedido explícito.
- UI e textos em pt-BR; identificadores em inglês.
- Commits sem trailer de co-autoria de IA.
