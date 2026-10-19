# api do ClearChat (FastAPI + uvicorn, 1 worker). Ver docs/ARCHITECTURE.md §8.
FROM python:3.13-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

WORKDIR /app
COPY pyproject.toml alembic.ini ./
COPY clearchat_server ./clearchat_server
RUN pip install . \
 && useradd --system --uid 10001 --home-dir /app --shell /usr/sbin/nologin clearchat \
 && mkdir -p /data/blobs && chown clearchat:clearchat /data/blobs

USER clearchat
EXPOSE 8000
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=5 \
  CMD ["python", "-m", "clearchat_server", "healthcheck", "--port", "8000"]

# migrações no start (idempotente) e depois a api com 1 worker (hub WS + timers de host em memória)
CMD ["sh", "-c", "python -m clearchat_server migrate && exec python -m clearchat_server serve --host 0.0.0.0 --port 8000"]
