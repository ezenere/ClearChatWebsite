"""Cloudflare Turnstile (opcional, §15). Sem chaves ou desligado no painel → não verifica."""

from __future__ import annotations

import logging

import httpx

from ..config import Settings
from ..errors import ApiError

log = logging.getLogger("clearchat.turnstile")


async def verify_turnstile(
    http: httpx.AsyncClient,
    settings: Settings,
    token: str | None,
    action: str,
    remote_ip: str | None,
) -> None:
    """Levanta captcha_failed se o token não passar. Só chamar com o captcha ativo."""
    if not token or len(token) > 4096:
        raise ApiError("captcha_failed")
    data = {"secret": settings.turnstile_secret_key, "response": token}
    if remote_ip:
        data["remoteip"] = remote_ip
    try:
        resp = await http.post(settings.turnstile_verify_url, data=data, timeout=5.0)
        body = resp.json()
    except (httpx.HTTPError, ValueError) as e:
        log.warning("siteverify indisponível", extra={"error": type(e).__name__})
        raise ApiError("captcha_failed") from e
    if not isinstance(body, dict) or body.get("success") is not True:
        raise ApiError("captcha_failed")
    if body.get("hostname") != settings.public_hostname:
        raise ApiError("captcha_failed")
    if body.get("action") != action:
        raise ApiError("captcha_failed")
