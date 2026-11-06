#!/usr/bin/env bash
# Servidor LOCAL de desenvolvimento/teste SEM push (nada de conta de serviço do Firebase), para os testes de
# ponta a ponta dos apps (desktop e mobile) contra o servidor real. Usa o Postgres descartável
# `clearchat-backend-pytest` (127.0.0.1:55440) com um banco próprio (clearchat_dev por padrão, criado se
# faltar). Os códigos de login vão para o log (MAIL_BACKEND=console). Roda em primeiro plano; Ctrl+C para
# parar (o contêiner continua: `docker --context desktop-linux stop clearchat-backend-pytest`).
#
#   backend/scripts/dev-server.sh [--fast] [--python <python do backend>] [--reset] [--no-live]
#     --fast:    tempos curtos (tolerância de queda 3 s, reinício 5 s, comandos 15 s)
#     --reset:   apaga e recria o banco antes de subir
#     --no-live: instância sem chats só ao vivo (features.liveChats false; testa clientes contra servidor antigo)
#
# Variáveis: CLEARCHAT_SERVER_PYTHON (padrão: .venv do backend), PORT (8100), HOST (0.0.0.0),
# PUBLIC_BASE_URL (padrão http://127.0.0.1:$PORT), DEV_DB (clearchat_dev), DATA_DIR (blobs e cwd do
# processo; padrão ~/.cache/clearchat-dev-server/<DEV_DB>), RATE_LIMIT_MULTIPLIER (1000), DOCKER_CONTEXT
# (desktop-linux). Qualquer variável de ambiente do servidor (ex.: HOST_DROP_GRACE_S,
# SERVER_RESTART_GRACE_S, COMMAND_RESULT_TIMEOUT_S, LIVE_MAX_CHATS_PER_HOST) passada no ambiente vence os padrões.
# O .env do repositório NÃO é lido (o processo roda dentro de DATA_DIR).
set -euo pipefail
BACKEND="$(cd "$(dirname "$0")/.." && pwd)"

PY="${CLEARCHAT_SERVER_PYTHON:-$BACKEND/.venv/bin/python}"
FAST=""
RESET=""
LIVE=1
while [[ $# -gt 0 ]]; do
  case "$1" in
    --fast) FAST=1; shift ;;
    --reset) RESET=1; shift ;;
    --no-live) LIVE=""; shift ;;
    --python) PY="$2"; shift 2 ;;
    *) sed -n '2,20p' "$0"; exit 2 ;;
  esac
done
[[ -x "$PY" ]] || { echo "python do backend não encontrado: $PY (use --python)" >&2; exit 1; }
PORT="${PORT:-8100}"
HOST="${HOST:-0.0.0.0}"
DEV_DB="${DEV_DB:-clearchat_dev}"
[[ "$DEV_DB" =~ ^[a-z_][a-z0-9_]*$ ]] || { echo "DEV_DB inválido: $DEV_DB" >&2; exit 1; }
DATA_DIR="${DATA_DIR:-$HOME/.cache/clearchat-dev-server/$DEV_DB}"
mkdir -p "$DATA_DIR/run" "$DATA_DIR/blobs"

DC=(docker --context "${DOCKER_CONTEXT:-desktop-linux}")
"${DC[@]}" start clearchat-backend-pytest >/dev/null
# espera o Postgres aceitar conexões (a porta abre antes, pelo proxy do Docker)
for _ in $(seq 1 60); do
  "${DC[@]}" exec clearchat-backend-pytest pg_isready -U postgres -q && break
  sleep 1
done
if [[ -n "$RESET" ]]; then
  "${DC[@]}" exec clearchat-backend-pytest psql -U postgres -c "DROP DATABASE IF EXISTS $DEV_DB WITH (FORCE)" >/dev/null
  rm -rf "$DATA_DIR/blobs" && mkdir -p "$DATA_DIR/blobs"
fi
exists="$("${DC[@]}" exec clearchat-backend-pytest psql -U postgres -tAc \
  "SELECT 1 FROM pg_database WHERE datname='$DEV_DB'")"
[[ "$exists" == 1 ]] || "${DC[@]}" exec clearchat-backend-pytest psql -U postgres -c "CREATE DATABASE $DEV_DB" >/dev/null

export PYTHONPATH="$BACKEND${PYTHONPATH:+:$PYTHONPATH}"
export DATABASE_URL="postgresql+asyncpg://postgres@127.0.0.1:55440/$DEV_DB"
export SERVER_SECRET="${SERVER_SECRET:-local-dev-secret-0123456789abcdef}"
export PUBLIC_BASE_URL="${PUBLIC_BASE_URL:-http://127.0.0.1:$PORT}"
export BLOB_STORAGE_DIR="$DATA_DIR/blobs"
export MAIL_BACKEND=console LOG_FORMAT=text TURNSTILE_SITE_KEY= TURNSTILE_SECRET_KEY= FCM_SERVICE_ACCOUNT_FILE=
export RATE_LIMIT_MULTIPLIER="${RATE_LIMIT_MULTIPLIER:-1000}"
export LIVE_CHATS_ENABLED="${LIVE_CHATS_ENABLED:-$([[ -n "$LIVE" ]] && echo true || echo false)}"
if [[ -n "$FAST" ]]; then
  export HOST_DROP_GRACE_S="${HOST_DROP_GRACE_S:-3}" SERVER_RESTART_GRACE_S="${SERVER_RESTART_GRACE_S:-5}"
  export COMMAND_RESULT_TIMEOUT_S="${COMMAND_RESULT_TIMEOUT_S:-15}"
fi

cd "$DATA_DIR/run"
"$PY" -m clearchat_server migrate
echo "servidor de desenvolvimento em http://$HOST:$PORT (banco $DEV_DB; chats ao vivo: $LIVE_CHATS_ENABLED; códigos de login neste log)"
exec "$PY" -m uvicorn clearchat_server.main:app --host "$HOST" --port "$PORT" --ws-max-size 16777216
