"""Cliente mínimo do Firebase Cloud Messaging (HTTP v1) com conta de serviço do Google.

OAuth2 "service account" sem SDK: JWT RS256 assinado com a chave do JSON (`cryptography`) trocado no
`token_uri` por um access token (cache até perto de expirar); envio com `POST
{base}/v1/projects/{project_id}/messages:send`. Nada aqui loga tokens, chaves ou conteúdo."""

from __future__ import annotations

import asyncio
import json
import logging
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Literal

import httpx
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import padding, rsa

from ..util import b64u_encode

log = logging.getLogger("clearchat.push")

FCM_SCOPE = "https://www.googleapis.com/auth/firebase.messaging"
JWT_TTL_S = 3600
# renova o access token quando faltar menos que isto para expirar
TOKEN_REFRESH_MARGIN_S = 300

SendStatus = Literal["ok", "invalid_token", "error"]


class ServiceAccountError(ValueError):
    """JSON da conta de serviço ausente/ilegível (a mensagem nunca leva o conteúdo do arquivo)."""


@dataclass(frozen=True)
class ServiceAccount:
    project_id: str
    client_email: str
    private_key_id: str
    token_uri: str
    key: rsa.RSAPrivateKey

    @classmethod
    def load(cls, path: str) -> ServiceAccount:
        try:
            raw = json.loads(Path(path).read_text(encoding="utf-8"))
        except FileNotFoundError as e:
            raise ServiceAccountError("arquivo da conta de serviço não encontrado") from e
        except (OSError, ValueError) as e:
            raise ServiceAccountError("arquivo da conta de serviço ilegível (JSON inválido?)") from e
        if not isinstance(raw, dict) or raw.get("type") != "service_account":
            raise ServiceAccountError("o JSON não é de uma conta de serviço (type != service_account)")
        fields = {}
        for k in ("project_id", "client_email", "private_key", "token_uri"):
            v = raw.get(k)
            if not isinstance(v, str) or not v:
                raise ServiceAccountError(f"conta de serviço sem o campo {k}")
            fields[k] = v
        try:
            key = serialization.load_pem_private_key(fields["private_key"].encode(), password=None)
        except (ValueError, TypeError) as e:
            raise ServiceAccountError("chave privada da conta de serviço inválida") from e
        if not isinstance(key, rsa.RSAPrivateKey):
            raise ServiceAccountError("a chave da conta de serviço não é RSA")
        kid = raw.get("private_key_id")
        return cls(
            project_id=fields["project_id"],
            client_email=fields["client_email"],
            private_key_id=kid if isinstance(kid, str) else "",
            token_uri=fields["token_uri"],
            key=key,
        )

    def assertion(self, now: float | None = None) -> str:
        """JWT RS256 do fluxo OAuth2 de conta de serviço (RFC 7523)."""
        iat = int(now if now is not None else time.time())
        header: dict[str, str] = {"alg": "RS256", "typ": "JWT"}
        if self.private_key_id:
            header["kid"] = self.private_key_id
        claims = {
            "iss": self.client_email,
            "scope": FCM_SCOPE,
            "aud": self.token_uri,
            "iat": iat,
            "exp": iat + JWT_TTL_S,
        }

        def seg(o: dict[str, Any]) -> str:
            return b64u_encode(json.dumps(o, separators=(",", ":")).encode())

        signing_input = f"{seg(header)}.{seg(claims)}"
        sig = self.key.sign(signing_input.encode(), padding.PKCS1v15(), hashes.SHA256())
        return f"{signing_input}.{b64u_encode(sig)}"


def classify_error(status: int, body: Any) -> SendStatus:
    """Erro do FCM → `invalid_token` (apagar o token: UNREGISTERED, 404 ou INVALID_ARGUMENT apontando o
    token, §22.2) ou `error` (transitório/outro: o aviso é descartado, sem fila)."""
    err = body.get("error") if isinstance(body, dict) else None
    details = err.get("details") if isinstance(err, dict) else None
    codes: set[str] = set()
    token_field = False
    if isinstance(details, list):
        for d in details:
            if not isinstance(d, dict):
                continue
            if isinstance(d.get("errorCode"), str):
                codes.add(d["errorCode"])
            for fv in d.get("fieldViolations") or []:
                if isinstance(fv, dict) and fv.get("field") == "message.token":
                    token_field = True
    if status == 404 or "UNREGISTERED" in codes:
        return "invalid_token"
    st = err.get("status") if isinstance(err, dict) else None
    if (status == 400 or st == "INVALID_ARGUMENT" or "INVALID_ARGUMENT" in codes) and token_field:
        return "invalid_token"
    return "error"


class FcmClient:
    def __init__(self, account: ServiceAccount, http: httpx.AsyncClient, base_url: str, timeout_s: float) -> None:
        self.account = account
        self.http = http
        self.url = f"{base_url.rstrip('/')}/v1/projects/{account.project_id}/messages:send"
        self.timeout = timeout_s
        self._token: str | None = None
        self._token_exp = 0.0
        self._lock = asyncio.Lock()

    async def access_token(self, force: bool = False) -> str:
        async with self._lock:
            now = time.monotonic()
            if not force and self._token and now < self._token_exp - TOKEN_REFRESH_MARGIN_S:
                return self._token
            r = await self.http.post(
                self.account.token_uri,
                data={
                    "grant_type": "urn:ietf:params:oauth:grant-type:jwt-bearer",
                    "assertion": self.account.assertion(),
                },
                timeout=self.timeout,
            )
            if r.status_code != 200:
                raise RuntimeError(f"token OAuth2 recusado (HTTP {r.status_code})")
            b = r.json()
            tok = b.get("access_token") if isinstance(b, dict) else None
            if not isinstance(tok, str) or not tok:
                raise RuntimeError("resposta do token OAuth2 sem access_token")
            exp = b.get("expires_in")
            ttl = float(exp) if isinstance(exp, int | float) and not isinstance(exp, bool) else 3600.0
            self._token, self._token_exp = tok, now + ttl
            return tok

    async def send(self, message: dict[str, Any], validate_only: bool = False) -> tuple[SendStatus, str]:
        """Envia uma mensagem (`{"token": …, "data": …, "android": …}`). Devolve (status, código curto
        para log — nunca o token). Um 401 renova o access token e tenta de novo uma vez."""
        body: dict[str, Any] = {"message": message}
        if validate_only:
            body["validate_only"] = True
        for attempt in (0, 1):
            try:
                tok = await self.access_token(force=attempt == 1)
                r = await self.http.post(
                    self.url, json=body, headers={"Authorization": f"Bearer {tok}"}, timeout=self.timeout
                )
            except (httpx.HTTPError, RuntimeError, ValueError) as e:
                return "error", type(e).__name__
            if r.status_code == 200:
                return "ok", "200"
            if r.status_code == 401 and attempt == 0:
                continue
            try:
                payload = r.json()
            except ValueError:
                payload = None
            st = classify_error(r.status_code, payload)
            err = payload.get("error") if isinstance(payload, dict) else None
            code = err.get("status") if isinstance(err, dict) and isinstance(err.get("status"), str) else ""
            return st, f"{r.status_code} {code}".strip()
        return "error", "401"
