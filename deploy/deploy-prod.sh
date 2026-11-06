#!/usr/bin/env bash
# Deploy da instância (Docker Compose) a partir do commit atual (git archive HEAD — nada não commitado vai).
#
#   deploy/deploy-prod.sh            mostra o que vai fazer e pede confirmação
#   deploy/deploy-prod.sh --yes      sem pergunta
#
# Variáveis: DEPLOY_TARGET (padrão ezenere@172.16.1.7), DEPLOY_DIR (padrão /srv/websites/clear-chat),
# FCM_KEY_FILE (JSON da conta de serviço do Firebase; padrão: o único secrets/*-firebase-adminsdk-*.json),
# PRIVACY_CONTACT_EMAIL (padrão suporte@ezenere.com; só é gravado se o .env ainda não tiver).
#
# No servidor: 1) backup em .backups/<data>/ (pg_dump do banco + código + .env); 2) troca o código
# (admin/ backend/ deploy/ docs/ frontend/ e arquivos da raiz; .env, secrets/ e .backups/ ficam);
# 3) copia a chave do Firebase para secrets/ (dono uid 10001 do container, modo 400 — via container
# descartável, sem sudo); 4) acerta FCM_SERVICE_ACCOUNT_FILE e PRIVACY_CONTACT_EMAIL no .env;
# 5) docker compose up -d --build (a api roda as migrações no start); 6) confere /api/info.
set -euo pipefail
cd "$(dirname "$0")/.."

TARGET="${DEPLOY_TARGET:-ezenere@172.16.1.7}"
DIR="${DEPLOY_DIR:-/srv/websites/clear-chat}"
CONTACT="${PRIVACY_CONTACT_EMAIL:-suporte@ezenere.com}"

if [[ -z "${FCM_KEY_FILE:-}" ]]; then
  shopt -s nullglob
  keys=(secrets/*-firebase-adminsdk-*.json)
  shopt -u nullglob
  [[ ${#keys[@]} -eq 1 ]] || { echo "defina FCM_KEY_FILE (achei ${#keys[@]} chaves em secrets/)" >&2; exit 1; }
  FCM_KEY_FILE="${keys[0]}"
fi
[[ -f "$FCM_KEY_FILE" ]] || { echo "chave não encontrada: $FCM_KEY_FILE" >&2; exit 1; }
KEY_NAME="$(basename "$FCM_KEY_FILE")"
[[ "$KEY_NAME" =~ ^[A-Za-z0-9._-]+$ ]] || { echo "nome de arquivo da chave inválido" >&2; exit 1; }

COMMIT="$(git rev-parse --short HEAD)"
if [[ -n "$(git status --porcelain -- . ':!secrets')" ]]; then
  echo "aviso: há mudanças não commitadas — só o commit $COMMIT vai para o servidor."
fi
if [[ "$(git rev-parse HEAD)" != "$(git rev-parse '@{u}' 2>/dev/null || true)" ]]; then
  echo "aviso: o commit $COMMIT não está igual ao do GitHub (faltou push?)."
fi

echo "Deploy de $COMMIT ($(git log -1 --format=%s | cut -c1-70)) → $TARGET:$DIR"
echo "Chave do Firebase: $KEY_NAME · contato da privacidade: $CONTACT"
if [[ "${1:-}" != "--yes" ]]; then
  read -rp "Continuar? [s/N] " ok
  [[ "$ok" == s || "$ok" == S ]] || { echo "cancelado"; exit 1; }
fi

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
git archive --format=tar.gz -o "$TMP/release.tgz" HEAD

echo "→ enviando código e chave"
ssh "$TARGET" "mkdir -p '$DIR/.incoming' && cat > '$DIR/.incoming/release.tgz'" < "$TMP/release.tgz"
ssh "$TARGET" "umask 077 && cat > '$DIR/.incoming/$KEY_NAME'" < "$FCM_KEY_FILE"

echo "→ backup, troca do código e subida"
ssh "$TARGET" "DIR='$DIR' KEY_NAME='$KEY_NAME' CONTACT='$CONTACT' bash -s" <<'REMOTE'
set -euo pipefail
# os comandos docker recebem </dev/null: este script chega pela entrada padrão (bash -s)
cd "$DIR"
TS="$(date +%Y%m%d-%H%M%S)"
B=".backups/$TS"
mkdir -p "$B"
chmod 700 .backups

docker compose exec -T db sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc' < /dev/null > "$B/db.dump"
[[ -s "$B/db.dump" ]] || { echo "pg_dump vazio — abortando sem mexer em nada" >&2; exit 1; }
tar -czf "$B/tree.tgz" --exclude=./.backups --exclude=./secrets --exclude=./.incoming .
echo "backup: $DIR/$B ($(du -sh "$B" | cut -f1))"

rm -rf admin backend deploy docs frontend
tar -xzf .incoming/release.tgz
rm -f .incoming/release.tgz

mkdir -p secrets
chmod 711 secrets
mv -f ".incoming/$KEY_NAME" "secrets/$KEY_NAME"
rmdir .incoming
# o container roda como uid 10001; ajusta o dono por um container descartável (a imagem já está aqui)
docker run --rm -v "$PWD/secrets:/s" --entrypoint sh postgres:17-alpine \
  -c "chown 10001 '/s/$KEY_NAME' && chmod 400 '/s/$KEY_NAME'" < /dev/null

set_env() {  # set_env NOME VALOR [só_se_ausente]
  if grep -q "^$1=" .env; then
    [[ "${3:-}" == only-if-missing ]] && grep -q "^$1=." .env && return 0
    sed -i "s|^$1=.*|$1=$2|" .env
  else
    printf '\n%s=%s\n' "$1" "$2" >> .env
  fi
}
set_env FCM_SERVICE_ACCOUNT_FILE "/run/secrets/clearchat/$KEY_NAME"
set_env PRIVACY_CONTACT_EMAIL "$CONTACT" only-if-missing

docker compose up -d --build < /dev/null 2>&1 | tail -15
for i in $(seq 1 60); do
  if curl -fsS http://127.0.0.1:8100/api/info > /tmp/clearchat-info.json 2>/dev/null; then break; fi
  sleep 2
done
echo "→ /api/info:"
python3 -c 'import json;d=json.load(open("/tmp/clearchat-info.json"));print(" protocolo", d["protocol"]["version"], "· push", d["features"].get("push"))' \
  || cat /tmp/clearchat-info.json
rm -f /tmp/clearchat-info.json
docker compose ps --format '{{.Service}} {{.Status}}'
echo
echo "Desfazer: cd $DIR && rm -rf admin backend deploy docs frontend && tar -xzf $B/tree.tgz &&"
echo "  docker compose up -d --build   (o banco: docker compose exec -T db pg_restore --clean -U ... < $B/db.dump)"
REMOTE
