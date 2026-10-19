"""Configuração lida do ambiente / .env (pydantic-settings). Ver .env.example."""

from __future__ import annotations

import ipaddress
from functools import cached_property
from typing import Literal
from urllib.parse import urlsplit

from pydantic import field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    # .env do diretório atual ou do pai (rodando de backend/ com o .env na raiz do repositório)
    model_config = SettingsConfigDict(env_file=("../.env", ".env"), extra="ignore", case_sensitive=False)

    # instância
    public_base_url: str = "http://localhost:8100"
    allowed_origins: str = ""
    instance_name: str = "ClearChat"
    initial_signup_open: bool = True
    initial_landing_enabled: bool = True
    download_url: str = "https://github.com/ezenere/ClearChat/releases"

    # segredos
    server_secret: str = ""
    admin_token: str = ""

    # banco
    database_url: str = "postgresql+asyncpg://clearchat:clearchat@localhost:5432/clearchat"
    db_pool_size: int = 10

    # e-mail
    mail_backend: Literal["auto", "smtp", "console", "memory"] = "auto"
    smtp_host: str = ""
    smtp_port: int = 587
    smtp_username: str = ""
    smtp_password: str = ""
    smtp_from: str = "ClearChat <no-reply@localhost>"
    smtp_tls_mode: Literal["starttls", "ssl", "none"] = "starttls"
    smtp_validate_certs: bool = True
    smtp_timeout_s: float = 15

    # captcha
    turnstile_site_key: str = ""
    turnstile_secret_key: str = ""
    turnstile_verify_url: str = "https://challenges.cloudflare.com/turnstile/v0/siteverify"

    # rede
    trusted_proxy_cidrs: str = "127.0.0.1/32,172.31.250.1/32"

    # armazenamento
    blob_storage_dir: str = "/data/blobs"
    blob_max_bytes: int = 300 * 1024 * 1024

    # tempos e limites (protocolo §17.1); floats para os testes poderem encurtar
    email_code_ttl_s: int = 600
    email_code_max_attempts: int = 5
    invite_ttl_days: int = 7
    access_token_ttl_s: int = 3600
    refresh_token_ttl_days: int = 60
    host_drop_grace_s: float = 10
    server_restart_grace_s: float = 60
    handover_force_timeout_s: float = 20
    command_result_timeout_s: float = 30
    ws_hello_timeout_s: float = 10
    ws_idle_timeout_s: float = 30
    tombstone_retention_days: int = 180
    push_receipt_ttl_days: int = 7
    blob_orphan_grace_h: float = 24
    activity_retention_days: int = 90
    gc_interval_s: float = 300
    instance_settings_cache_s: float = 5

    default_quota_record_bytes: int | None = None
    default_quota_records: int | None = None
    default_quota_blob_bytes: int | None = None
    default_quota_devices: int | None = None

    log_level: str = "info"
    log_format: Literal["json", "text"] = "json"
    # desliga os jobs periódicos (testes chamam o GC na mão)
    jobs_enabled: bool = True
    # desliga o LISTEN/NOTIFY (eventos do painel admin)
    notify_listener_enabled: bool = True

    @field_validator(
        "default_quota_record_bytes",
        "default_quota_records",
        "default_quota_blob_bytes",
        "default_quota_devices",
        mode="before",
    )
    @classmethod
    def _empty_is_none(cls, v: object) -> object:
        if isinstance(v, str) and v.strip() == "":
            return None
        return v

    @field_validator("public_base_url")
    @classmethod
    def _strip_slash(cls, v: str) -> str:
        v = v.strip().rstrip("/")
        parts = urlsplit(v)
        if parts.scheme not in ("http", "https") or not parts.netloc:
            raise ValueError("PUBLIC_BASE_URL deve ser http(s)://host[:porta][/caminho]")
        return v

    # ---------- derivados ----------
    @cached_property
    def base_path(self) -> str:
        """Caminho de PUBLIC_BASE_URL ('' ou '/clearchat')."""
        return urlsplit(self.public_base_url).path.rstrip("/")

    @cached_property
    def public_hostname(self) -> str:
        return urlsplit(self.public_base_url).hostname or ""

    @cached_property
    def is_https(self) -> bool:
        return urlsplit(self.public_base_url).scheme == "https"

    @cached_property
    def trusted_networks(self) -> list[ipaddress.IPv4Network | ipaddress.IPv6Network]:
        nets: list[ipaddress.IPv4Network | ipaddress.IPv6Network] = []
        for part in self.trusted_proxy_cidrs.split(","):
            part = part.strip()
            if part:
                nets.append(ipaddress.ip_network(part, strict=False))
        return nets

    @cached_property
    def cors_origins(self) -> list[str]:
        return [o.strip().rstrip("/") for o in self.allowed_origins.split(",") if o.strip()]

    @property
    def captcha_keys_present(self) -> bool:
        return bool(self.turnstile_site_key and self.turnstile_secret_key)

    @property
    def effective_mail_backend(self) -> str:
        if self.mail_backend == "auto":
            return "smtp" if self.smtp_host else "console"
        return self.mail_backend

    def secret_bytes(self) -> bytes:
        if not self.server_secret:
            raise RuntimeError("SERVER_SECRET não configurado")
        return self.server_secret.encode()


def get_settings() -> Settings:
    return Settings()
