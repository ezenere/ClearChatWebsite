"""Endurecimento da auditoria: CORS sem curinga, .env criado com 0600, log sem token de convite, e-mail sem
SMTP não vaza código no log, engine sem parâmetros nos erros, restrições de uso não negativo."""

from __future__ import annotations

import logging
import stat

import pytest
from conftest import make_settings
from sqlalchemy import text
from sqlalchemy.exc import IntegrityError

from clearchat_server.cli import init_env
from clearchat_server.db import make_engine
from clearchat_server.mail import Mailer, code_mail
from clearchat_server.main import create_app, redact_path


def test_cors_wildcard_rejected(tmp_path):
    with pytest.raises(RuntimeError, match="ALLOWED_ORIGINS"):
        create_app(make_settings(tmp_path, allowed_origins="*"), configure_logging=False)
    with pytest.raises(RuntimeError, match="ALLOWED_ORIGINS"):
        create_app(make_settings(tmp_path, allowed_origins="https://a.example, *"), configure_logging=False)
    create_app(make_settings(tmp_path, allowed_origins="https://a.example"), configure_logging=False)


def test_init_env_mode_0600(tmp_path):
    example = tmp_path / ".env.example"
    example.write_text("SERVER_SECRET=\nADMIN_TOKEN=\nPOSTGRES_PASSWORD=\nOTHER=x\n")
    out = tmp_path / ".env"
    init_env(example, out, force=False)
    assert stat.S_IMODE(out.stat().st_mode) == 0o600
    body = out.read_text()
    assert "OTHER=x" in body and "SERVER_SECRET=\n" not in body
    # --force sobre um arquivo antigo aberto demais também termina em 0600
    out.chmod(0o644)
    init_env(example, out, force=True)
    assert stat.S_IMODE(out.stat().st_mode) == 0o600


def test_invite_token_redacted_from_request_log():
    assert redact_path("/api/v1/auth/invite/SECRET-TOKEN-123") == "/api/v1/auth/invite/***"
    assert redact_path("/clearchat/api/v1/auth/invite/SECRET-TOKEN-123") == "/clearchat/api/v1/auth/invite/***"
    assert redact_path("/api/v1/auth/refresh") == "/api/v1/auth/refresh"
    assert redact_path(None) is None


async def test_request_log_has_no_invite_token(srv, caplog):
    with caplog.at_level(logging.INFO, logger="clearchat.api"):
        r = await srv.http.get("/api/v1/auth/invite/super-secret-invite-token")
    assert r.status_code == 200
    paths = [getattr(rec, "path", "") for rec in caplog.records if rec.getMessage() == "http"]
    assert "/api/v1/auth/invite/***" in paths
    assert "super-secret-invite-token" not in caplog.text


async def test_mail_auto_without_smtp_never_logs_code(tmp_path, caplog):
    settings = make_settings(tmp_path, mail_backend="auto", smtp_host="")
    with caplog.at_level(logging.INFO, logger="clearchat.mail"):
        mailer = Mailer(settings)
        assert mailer.backend == "none"
        await mailer.send(code_mail("a@example.com", "123456", "login", "ClearChat", 600))
    assert "NENHUM e-mail" in caplog.text  # aviso alto na subida
    assert "123456" not in caplog.text and "a@example.com" not in caplog.text
    # console só quando escolhido explicitamente (aí sim escreve o e-mail, para desenvolvimento)
    assert Mailer(make_settings(tmp_path, mail_backend="console")).backend == "console"
    assert Mailer(make_settings(tmp_path, mail_backend="auto", smtp_host="smtp.example")).backend == "smtp"


async def test_engine_hides_parameters_and_usage_checks(tmp_path):
    settings = make_settings(tmp_path)
    engine = make_engine(settings.database_url, 1)
    try:
        async with engine.begin() as c:
            uid = (
                await c.execute(text("INSERT INTO users (email, name) VALUES ('neg@example.com', 'N') RETURNING id"))
            ).scalar()
        for col in ("usage_records", "usage_record_bytes", "usage_blobs", "usage_blob_bytes"):
            with pytest.raises(IntegrityError) as ei:
                async with engine.begin() as c:
                    await c.execute(text(f"UPDATE users SET {col} = -1 WHERE id = :u"), {"u": uid})
            assert "nonneg" in str(ei.value)
            # hide_parameters: os valores dos parâmetros não entram na mensagem do erro (que vai para o log)
            assert "parameters hidden" in str(ei.value) and str(uid) not in str(ei.value)
    finally:
        await engine.dispose()
