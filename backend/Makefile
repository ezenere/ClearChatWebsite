# ClearChat — backend + admin. Rode a partir de backend/ (ou `make -C backend <alvo>`).
# Configuração: o .env da raiz do repositório (ou backend/.env). Ver ../.env.example.

PYTHON  ?= python3.13
VENV    ?= .venv
PY      := $(VENV)/bin/python
# Banco dos testes (é APAGADO a cada execução): Postgres local descartável
TEST_DATABASE_URL ?= postgresql+asyncpg://postgres@127.0.0.1:55432/clearchat_test
DEV_DB_CONTAINER  ?= clearchat-dev-db

.PHONY: help venv dev admin migrate test lint fmt typecheck check init-env create-user invite settings gc db-up db-down

help:
	@echo "venv         cria $(VENV) e instala o backend + dependências de desenvolvimento"
	@echo "init-env     cria ../.env a partir do .env.example com segredos gerados"
	@echo "db-up        sobe um Postgres de desenvolvimento no Docker (127.0.0.1:55432)"
	@echo "migrate      aplica as migrações (alembic upgrade head)"
	@echo "dev          sobe a api em http://127.0.0.1:8100 (recarrega ao editar)"
	@echo "admin        sobe o painel admin em http://127.0.0.1:8190"
	@echo "test         roda os testes (TEST_DATABASE_URL=$(TEST_DATABASE_URL))"
	@echo "check        ruff + mypy + testes"
	@echo "create-user  EMAIL=... NAME=...   cria usuário (entra por código, define a senha no /setup)"
	@echo "invite       [EMAIL=...] [DAYS=7]  gera link de convite"
	@echo "settings     ARGS='--signup-open off --landing on'   configurações da instância"

venv:
	$(PYTHON) -m venv $(VENV)
	$(PY) -m pip install -U pip
	$(PY) -m pip install -e ".[dev]"

init-env:
	$(PY) -m clearchat_server init-env --example ../.env.example --out ../.env

db-up:
	docker run -d --name $(DEV_DB_CONTAINER) -p 127.0.0.1:55432:5432 \
	  -e POSTGRES_HOST_AUTH_METHOD=trust -e POSTGRES_DB=clearchat_test postgres:17-alpine
	@echo "DATABASE_URL=postgresql+asyncpg://postgres@127.0.0.1:55432/postgres (dev)"

db-down:
	docker rm -f $(DEV_DB_CONTAINER)

migrate:
	$(PY) -m clearchat_server migrate

dev:
	$(PY) -m uvicorn clearchat_server.main:app --host 127.0.0.1 --port 8100 --reload --ws-max-size 16777216

admin:
	PYTHONPATH=../admin $(PY) -m clearchat_admin --host 127.0.0.1 --port 8190

test:
	TEST_DATABASE_URL=$(TEST_DATABASE_URL) $(PY) -m pytest -q

lint:
	$(VENV)/bin/ruff check clearchat_server tests ../admin/clearchat_admin
	$(VENV)/bin/ruff format --check clearchat_server tests ../admin/clearchat_admin

fmt:
	$(VENV)/bin/ruff format clearchat_server tests ../admin/clearchat_admin
	$(VENV)/bin/ruff check --fix clearchat_server tests ../admin/clearchat_admin

typecheck:
	$(VENV)/bin/mypy
	cd ../admin && ../backend/$(VENV)/bin/mypy --python-version 3.12 --ignore-missing-imports --check-untyped-defs clearchat_admin

check: lint typecheck test

create-user:
	$(PY) -m clearchat_server create-user "$(EMAIL)" "$(NAME)"

invite:
	$(PY) -m clearchat_server invite $(if $(EMAIL),--email $(EMAIL)) $(if $(DAYS),--days $(DAYS))

settings:
	$(PY) -m clearchat_server settings $(ARGS)

gc:
	$(PY) -m clearchat_server gc
