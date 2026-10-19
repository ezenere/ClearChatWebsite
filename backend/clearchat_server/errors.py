"""Erros da API no formato do protocolo (§6.1, §17.4)."""

from __future__ import annotations

from typing import Any

STATUS: dict[str, int] = {
    "invalid_request": 400,
    "captcha_failed": 400,
    "signup_closed": 403,
    "invite_invalid": 400,
    "code_invalid": 400,
    "unauthorized": 401,
    "refresh_reused": 401,
    "forbidden": 403,
    "account_disabled": 403,
    "device_revoked": 403,
    "key_proof_invalid": 403,
    "not_found": 404,
    "keys_not_ready": 409,
    "keys_already_set": 409,
    "conflict": 409,
    "blob_missing": 409,
    "chat_busy": 409,
    "chat_diverged": 409,
    "divergence_discarded": 409,
    "divergence_mismatch": 409,
    "stale_base": 409,
    "not_host": 409,
    "no_host": 409,
    "cannot_host": 409,
    "host_offline": 409,
    "host_pinned": 409,
    "handover_pending": 409,
    "cursor_expired": 410,
    "payload_too_large": 413,
    "quota_exceeded": 413,
    "protocol_unsupported": 426,
    "rate_limited": 429,
    "internal": 500,
}

MESSAGES: dict[str, str] = {
    "invalid_request": "Requisição inválida.",
    "captcha_failed": "A verificação de captcha falhou. Tente de novo.",
    "signup_closed": "O cadastro está fechado nesta instância.",
    "invite_invalid": "Convite inválido, usado ou expirado.",
    "code_invalid": "Código inválido ou expirado.",
    "unauthorized": "Sessão inválida ou expirada.",
    "refresh_reused": "Sessão encerrada por segurança. Entre de novo.",
    "forbidden": "Sem permissão.",
    "account_disabled": "Conta desativada.",
    "device_revoked": "Este dispositivo foi desconectado.",
    "key_proof_invalid": "Prova de posse da chave inválida.",
    "not_found": "Não encontrado.",
    "keys_not_ready": "A criptografia da conta ainda não foi configurada.",
    "keys_already_set": "A criptografia da conta já está configurada.",
    "conflict": "Conflito de revisão.",
    "blob_missing": "Há anexos que ainda não foram enviados.",
    "chat_busy": "O chat está rodando em outro dispositivo.",
    "chat_diverged": "O chat está divergente.",
    "divergence_discarded": "Esta versão do chat já foi descartada.",
    "divergence_mismatch": "A divergência mudou. Atualize e tente de novo.",
    "stale_base": "Base do chat à frente do servidor.",
    "not_host": "Este dispositivo não é o host do chat.",
    "no_host": "O chat não tem host.",
    "cannot_host": "Este dispositivo não pode executar chats.",
    "host_offline": "O host do chat está offline.",
    "host_pinned": "O host está fixado.",
    "handover_pending": "Há uma troca de host em andamento.",
    "cursor_expired": "Cursor expirado: é preciso sincronizar tudo de novo.",
    "payload_too_large": "Dados grandes demais.",
    "quota_exceeded": "Cota excedida.",
    "protocol_unsupported": "Versão do protocolo incompatível.",
    "rate_limited": "Muitas tentativas. Aguarde e tente de novo.",
    "internal": "Erro interno.",
}


class ApiError(Exception):
    def __init__(
        self,
        code: str,
        message: str | None = None,
        details: dict[str, Any] | None = None,
        status: int | None = None,
        headers: dict[str, str] | None = None,
    ) -> None:
        super().__init__(code)
        self.code = code
        self.message = message or MESSAGES.get(code, code)
        self.details = details or {}
        self.status = status or STATUS.get(code, 400)
        self.headers = headers or {}
        # estados de chat a transmitir mesmo com a requisição recusada (ex.: divergência marcada)
        self.broadcast: list[dict[str, Any]] = []

    def body(self) -> dict[str, Any]:
        return {"error": {"code": self.code, "message": self.message, "details": self.details}}


def rate_limited(retry_after: int) -> ApiError:
    retry_after = max(1, int(retry_after))
    return ApiError("rate_limited", details={"retry_after": retry_after}, headers={"Retry-After": str(retry_after)})
