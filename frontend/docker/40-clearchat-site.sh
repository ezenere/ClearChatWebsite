#!/bin/sh
# Gera, no start do container, a parte do site que depende de PUBLIC_BASE_URL (self-host em qualquer
# host/porta/caminho): config.js, <base href> do index.html e o server block do nginx.
set -eu

BASE_URL="${PUBLIC_BASE_URL:-}"
while [ "${BASE_URL%/}" != "$BASE_URL" ]; do BASE_URL="${BASE_URL%/}"; done

case "$BASE_URL" in
  "" | http://* | https://*) ;;
  *) echo "clearchat-site: PUBLIC_BASE_URL precisa começar com http:// ou https://" >&2; exit 1 ;;
esac
# só caracteres seguros (vai para JS, HTML e configuração do nginx)
if printf '%s' "$BASE_URL" | grep -q '[^A-Za-z0-9._~:/%@+-]'; then
  echo "clearchat-site: PUBLIC_BASE_URL contém caracteres não permitidos" >&2
  exit 1
fi

BASE_PATH=""
if [ -n "$BASE_URL" ]; then
  REST="${BASE_URL#*://}"
  case "$REST" in */*) BASE_PATH="/${REST#*/}" ;; esac
fi

ROOT="${CLEARCHAT_SITE_ROOT:-/srv/www}"
SRC="${CLEARCHAT_SITE_SRC:-/opt/clearchat-site}"
NGX="${CLEARCHAT_NGINX_DIR:-/etc/nginx}"
rm -rf "$ROOT"
mkdir -p "$ROOT$BASE_PATH"
cp -R "$SRC"/. "$ROOT$BASE_PATH/"
printf 'window.__CLEARCHAT__ = { baseUrl: "%s" }\n' "$BASE_URL" > "$ROOT$BASE_PATH/config.js"
sed -i "s#<base href=\"/\" */\?>#<base href=\"$BASE_PATH/\" />#" "$ROOT$BASE_PATH/index.html"

mkdir -p "$NGX/conf.d"
# CSP: docs/ARCHITECTURE.md §7 + api.github.com (a landing consulta a última release do app).
cat > "$NGX/clearchat-headers.conf" <<'HDR'
add_header Content-Security-Policy "default-src 'self'; script-src 'self' 'wasm-unsafe-eval' https://challenges.cloudflare.com; frame-src https://challenges.cloudflare.com; connect-src 'self' wss: ws: https://api.github.com; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; worker-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'" always;
add_header X-Content-Type-Options nosniff always;
add_header Referrer-Policy no-referrer always;
add_header X-Frame-Options DENY always;
add_header Permissions-Policy "camera=(), microphone=(), geolocation=()" always;
HDR

cat > "$NGX/conf.d/clearchat.conf" <<CONF
server {
    listen 80;
    server_name _;
    root $ROOT;
    server_tokens off;
    charset utf-8;
    gzip on;
    gzip_types text/css application/javascript application/json image/svg+xml application/wasm;

    location = /healthz { access_log off; return 200 "ok\n"; }

    location = $BASE_PATH/config.js {
        include $NGX/clearchat-headers.conf;
        add_header Cache-Control "no-store" always;
    }
    location ^~ $BASE_PATH/assets/ {
        include $NGX/clearchat-headers.conf;
        add_header Cache-Control "public, max-age=31536000, immutable" always;
        try_files \$uri =404;
    }
    location / {
        include $NGX/clearchat-headers.conf;
        add_header Cache-Control "no-cache" always;
        # SPA: qualquer rota do site cai no index.html (o router resolve)
        try_files \$uri \$uri/ $BASE_PATH/index.html;
    }
}
CONF

echo "clearchat-site: base '${BASE_URL:-<origem atual>}' (caminho '${BASE_PATH:-/}')"
