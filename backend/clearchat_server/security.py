"""Hashes, HMACs e tokens opacos. Códigos e tokens nunca são guardados em claro."""

from __future__ import annotations

import hashlib
import hmac
import secrets

from .util import b64u_encode


def sha256(data: bytes) -> bytes:
    return hashlib.sha256(data).digest()


def hmac256(key: bytes, msg: str) -> bytes:
    return hmac.new(key, msg.encode(), hashlib.sha256).digest()


def email_hash(secret: bytes, email: str) -> bytes:
    return hmac256(secret, "email|" + email)


def code_hash(secret: bytes, purpose: str, email: str, code: str) -> bytes:
    return hmac256(secret, f"{purpose}|{email}|{code}")


def new_code() -> str:
    return f"{secrets.randbelow(1_000_000):06d}"


def new_token(prefix: str) -> str:
    return prefix + b64u_encode(secrets.token_bytes(32))


def token_hash(token: str) -> bytes:
    return sha256(token.encode())


def ct_equal(a: bytes, b: bytes) -> bool:
    return hmac.compare_digest(a, b)
