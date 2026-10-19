"""Validação de formato (sem decifrar) dos envelopes (§3.9) e das wraps (§3.6, §6.5)."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, TypeGuard

from ..errors import ApiError
from ..util import b64u_decode, b64u_encode


@dataclass(frozen=True)
class Envelope:
    v: int
    k: int
    nonce: bytes
    ct: bytes

    def to_json(self) -> dict[str, Any]:
        return {"v": self.v, "k": self.k, "n": b64u_encode(self.nonce), "c": b64u_encode(self.ct)}


def _is_int(x: Any) -> TypeGuard[int]:
    return isinstance(x, int) and not isinstance(x, bool)


def parse_envelope(env: Any, field: str = "env", max_bytes: int | None = None) -> Envelope:
    """`v == 1`, `k ≥ 1`, `n` → 12 bytes, `c` → ≥ 17 bytes, base64url válido."""
    if not isinstance(env, dict):
        raise ApiError("invalid_request", details={"field": field, "reason": "envelope"})
    v, k, n, c = env.get("v"), env.get("k"), env.get("n"), env.get("c")
    if not _is_int(v) or v != 1 or not _is_int(k) or k < 1 or k > 32767:
        raise ApiError("invalid_request", details={"field": field, "reason": "envelope_version"})
    try:
        nonce = b64u_decode(n) if isinstance(n, str) else b""
        if max_bytes is not None and isinstance(c, str) and len(c) * 3 // 4 > max_bytes:
            raise ApiError("payload_too_large", details={"field": field, "limit": max_bytes})
        ct = b64u_decode(c) if isinstance(c, str) else b""
    except ValueError as e:
        raise ApiError("invalid_request", details={"field": field, "reason": "envelope_encoding"}) from e
    if len(nonce) != 12 or len(ct) < 17:
        raise ApiError("invalid_request", details={"field": field, "reason": "envelope_size"})
    return Envelope(v, k, nonce, ct)


def parse_wrap(w: Any, field: str) -> tuple[bytes, bytes]:
    if not isinstance(w, dict):
        raise ApiError("invalid_request", details={"field": field})
    try:
        n = b64u_decode(w.get("n", ""))
        c = b64u_decode(w.get("c", ""))
    except (ValueError, TypeError) as e:
        raise ApiError("invalid_request", details={"field": field}) from e
    if len(n) != 12 or len(c) != 48:
        raise ApiError("invalid_request", details={"field": field})
    return n, c


def parse_b64_len(s: Any, n: int, field: str) -> bytes:
    try:
        raw = b64u_decode(s) if isinstance(s, str) else b""
    except ValueError as e:
        raise ApiError("invalid_request", details={"field": field}) from e
    if len(raw) != n:
        raise ApiError("invalid_request", details={"field": field})
    return raw


KDF_BOUNDS = {"m": (19456, 1048576), "t": (2, 10), "p": (1, 4)}


def parse_kdf(kdf: Any) -> dict[str, int | str]:
    """Parâmetros Argon2id dentro dos limites de §3.4."""
    if not isinstance(kdf, dict) or kdf.get("alg") != "argon2id" or kdf.get("v") != 19 or kdf.get("len") != 32:
        raise ApiError("invalid_request", details={"field": "password.kdf"})
    out: dict[str, int | str] = {"alg": "argon2id", "v": 19, "len": 32}
    for key, (lo, hi) in KDF_BOUNDS.items():
        val = kdf.get(key)
        if not _is_int(val) or not lo <= val <= hi:
            raise ApiError("invalid_request", details={"field": f"password.kdf.{key}"})
        out[key] = val
    return {"alg": "argon2id", "v": 19, "m": out["m"], "t": out["t"], "p": out["p"], "len": 32}
