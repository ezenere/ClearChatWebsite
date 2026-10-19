"""Utilitários: tempo, base64url, validação de ids, IP real."""

from __future__ import annotations

import base64
import binascii
import ipaddress
import json
import re
from datetime import UTC, datetime
from typing import Any

from .config import Settings

RECORD_ID_RE = re.compile(r"^[A-Za-z0-9._-]{1,128}$")
TYPE_RE = re.compile(r"^[a-z_]{1,32}$")
BLOB_ID_RE = re.compile(r"^[0-9a-f]{64}$")
HEX64_RE = re.compile(r"^[0-9a-fA-F]{64}$")
B64U_RE = re.compile(r"^[A-Za-z0-9_-]*$")
EMAIL_RE = re.compile(r"^[^@\s]{1,64}@[^@\s]{1,253}\.[^@\s]{1,63}$")


def utcnow() -> datetime:
    return datetime.now(UTC)


def iso(dt: datetime | None) -> str | None:
    """ISO 8601 UTC com milissegundos e 'Z' (§ convenções)."""
    if dt is None:
        return None
    dt = dt.astimezone(UTC)
    return dt.strftime("%Y-%m-%dT%H:%M:%S.") + f"{dt.microsecond // 1000:03d}Z"


def b64u_decode(s: str) -> bytes:
    """Decodifica base64url SEM padding (RFC 4648 §5). Levanta ValueError se inválido."""
    if not isinstance(s, str) or not B64U_RE.match(s) or len(s) % 4 == 1:
        raise ValueError("base64url inválido")
    try:
        raw = base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))
    except (binascii.Error, ValueError) as e:
        raise ValueError("base64url inválido") from e
    # rejeita codificações não canônicas (bits extras no último caractere)
    if b64u_encode(raw) != s:
        raise ValueError("base64url não canônico")
    return raw


def b64u_encode(b: bytes) -> str:
    return base64.urlsafe_b64encode(b).rstrip(b"=").decode()


def normalize_email(email: str) -> str:
    return email.strip().lower()


def valid_email(email: str) -> bool:
    return len(email) <= 254 and bool(EMAIL_RE.match(email))


def json_dumps(obj: Any) -> str:
    return json.dumps(obj, separators=(",", ":"), ensure_ascii=False)


def client_ip(peer: str | None, headers: Any, settings: Settings) -> str | None:
    """IP real: se o par for um proxy confiável (TRUSTED_PROXY_CIDRS), usa X-Real-IP (ou o último
    X-Forwarded-For); senão o IP do par. Cabeçalhos vindos de fora nunca são confiados."""
    if not peer:
        return None
    try:
        peer_ip = ipaddress.ip_address(peer)
    except ValueError:
        return None
    if any(peer_ip in net for net in settings.trusted_networks):
        cand = headers.get("x-real-ip")
        if not cand:
            xff = headers.get("x-forwarded-for")
            if xff:
                cand = xff.split(",")[-1].strip()
        if cand:
            try:
                return str(ipaddress.ip_address(cand.strip()))
            except ValueError:
                pass
    return str(peer_ip)
