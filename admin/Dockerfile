# Painel admin do ClearChat. Contexto do build = raiz do repositório (copia backend/ para os modelos).
# Publicado SÓ em 127.0.0.1 do host (docker-compose.yml). Nunca exponha nem roteie no Nginx.
FROM python:3.13-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PYTHONPATH=/app/admin

WORKDIR /app
COPY backend/pyproject.toml backend/alembic.ini backend/
COPY backend/clearchat_server backend/clearchat_server
RUN pip install ./backend \
 && useradd --system --uid 10001 --home-dir /app --shell /usr/sbin/nologin clearchat \
 && mkdir -p /data/blobs && chown clearchat:clearchat /data/blobs
COPY admin/clearchat_admin admin/clearchat_admin

USER clearchat
EXPOSE 8090
CMD ["python", "-m", "clearchat_admin", "--host", "0.0.0.0", "--port", "8090", "--in-container"]
