#!/usr/bin/env bash
# Servidor LOCAL de desenvolvimento com push real (FCM), para o teste de ponta a ponta com o emulador.
# Usa o Postgres descartável `clearchat-backend-pytest` (127.0.0.1:55440, banco clearchat_push_dev) e a
# conta de serviço do Firebase em ../secrets/ (só o caminho é passado ao servidor; o conteúdo nunca é
# impresso). Roda em primeiro plano; Ctrl+C para parar (o contêiner continua: docker stop para parar).
#
#   backend/scripts/dev-push-server.sh [--fast] [--python <python do backend>]
#     --fast: tempos curtos para testar "host caiu"
#
# Variáveis: CLEARCHAT_SERVER_PYTHON (padrão: .venv do backend), PORT (8100), PUBLIC_BASE_URL
# (padrão http://127.0.0.1:$PORT — use o IP da LAN se o aparelho não usar adb reverse).
set -euo pipefail
cd "$(dirname "$0")/.."

PY="${CLEARCHAT_SERVER_PYTHON:-.venv/bin/python}"
FAST=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --fast) FAST=1; shift ;;
    --python) PY="$2"; shift 2 ;;
    *) sed -n '2,10p' "$0"; exit 2 ;;
  esac
done
[[ -x "$PY" ]] || { echo "python do backend não encontrado: $PY (use --python)" >&2; exit 1; }
PORT="${PORT:-8100}"
shopt -s nullglob
keys=(../secrets/*-firebase-adminsdk-*.json)
shopt -u nullglob
[[ ${#keys[@]} -eq 1 ]] || { echo "esperava 1 chave em ClearChatWebsite/secrets/ (achei ${#keys[@]})" >&2; exit 1; }

docker --context "${DOCKER_CONTEXT:-desktop-linux}" start clearchat-backend-pytest >/dev/null
DC=(docker --context "${DOCKER_CONTEXT:-desktop-linux}")
# espera o Postgres aceitar conexões (a porta abre antes, pelo proxy do Docker)
for _ in $(seq 1 60); do
  "${DC[@]}" exec clearchat-backend-pytest pg_isready -U postgres -q && break
  sleep 1
done
exists="$("${DC[@]}" exec clearchat-backend-pytest psql -U postgres -tAc \
  "SELECT 1 FROM pg_database WHERE datname='clearchat_push_dev'")"
[[ "$exists" == 1 ]] || "${DC[@]}" exec clearchat-backend-pytest psql -U postgres -c "CREATE DATABASE clearchat_push_dev" >/dev/null

export DATABASE_URL=postgresql+asyncpg://postgres@127.0.0.1:55440/clearchat_push_dev
export SERVER_SECRET=local-dev-secret-0123456789abcdef
export PUBLIC_BASE_URL="${PUBLIC_BASE_URL:-http://127.0.0.1:$PORT}"
export MAIL_BACKEND=console LOG_FORMAT=text TURNSTILE_SITE_KEY= TURNSTILE_SECRET_KEY=
export RATE_LIMIT_MULTIPLIER="${RATE_LIMIT_MULTIPLIER:-50}"
FCM_SERVICE_ACCOUNT_FILE="$(realpath "${keys[0]}")"
export FCM_SERVICE_ACCOUNT_FILE
if [[ -n "$FAST" ]]; then
  export HOST_DROP_GRACE_S=5 HOST_OFFLINE_PUSH_DELAY_S=15 HOST_OFFLINE_PUSH_COOLDOWN_S=60
fi

"$PY" -m clearchat_server migrate
echo "servidor com push real em http://0.0.0.0:$PORT (códigos de login aparecem neste log)"
exec "$PY" -m uvicorn clearchat_server.main:app --host 0.0.0.0 --port "$PORT" --ws-max-size 16777216
