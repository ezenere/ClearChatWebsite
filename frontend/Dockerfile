# ClearChat — site (React + Vite) → arquivos estáticos servidos por nginx. Ver docs/ARCHITECTURE.md §7–8.
# O build é independente do caminho de base (base: './'); no start, docker/40-clearchat-site.sh lê
# PUBLIC_BASE_URL e gera config.js, o <base href> do index.html e a configuração do nginx (com o
# fallback da SPA e a CSP).

FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
ARG SITE_VERSION=0.1.0
ENV VITE_SITE_VERSION=${SITE_VERSION}
# build de produção: sem VITE_MOCK_API, o servidor simulado não entra no bundle
RUN npm run build && ! grep -rq "clearchat-mock-db" dist

FROM nginx:1.29-alpine
COPY --from=build /app/dist /opt/clearchat-site
COPY docker/40-clearchat-site.sh /docker-entrypoint.d/40-clearchat-site.sh
RUN chmod +x /docker-entrypoint.d/40-clearchat-site.sh && rm -f /etc/nginx/conf.d/default.conf
ENV PUBLIC_BASE_URL=""
EXPOSE 80
HEALTHCHECK --interval=30s --timeout=3s CMD wget -q -O /dev/null http://127.0.0.1/healthz || exit 1
