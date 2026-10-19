"""Códigos de 6 dígitos por e-mail (§5.3): HMAC, uso único, 5 tentativas, validade 10 min, bloqueios."""

from __future__ import annotations

import ipaddress
import re
import uuid
from datetime import timedelta
from typing import Any

from sqlalchemy.ext.asyncio import AsyncConnection

from ..context import AppContext
from ..db import execute, fetchone
from ..errors import ApiError
from ..ratelimit import DAY, HOUR, Limit
from ..security import code_hash, ct_equal, email_hash, new_code
from ..services.accounts import log_activity
from ..util import utcnow

CODE_RE = re.compile(r"\A[0-9]{6}\Z")  # [0-9]: "\d" aceitaria outros dígitos Unicode
# `code/verify` (§17.3): 10/h por e-mail + rede do cliente; teto alto por e-mail só como proteção extra.
# A conta por rede impede que terceiros gastem o limite (ou disparem o bloqueio) do dono do e-mail.
VERIFY_PER_NET_HOUR = 10
VERIFY_PER_EMAIL_HOUR = 200
VERIFY_PER_IP_HOUR = 30


def email_key(ctx: AppContext, email: str) -> str:
    return email_hash(ctx.settings.secret_bytes(), email).hex()


def net_key(ip: str | None) -> str:
    """Rede do cliente para os contadores de verify: IPv4 /24, IPv6 /64; 'noip' sem IP conhecido."""
    if not ip:
        return "noip"
    try:
        addr = ipaddress.ip_address(ip)
    except ValueError:
        return "noip"
    if isinstance(addr, ipaddress.IPv6Address) and addr.ipv4_mapped is not None:
        addr = addr.ipv4_mapped
    prefix = 24 if addr.version == 4 else 64
    return str(ipaddress.ip_network(f"{addr}/{prefix}", strict=False))


async def request_limits(ctx: AppContext, email: str, ip: str | None) -> None:
    """`code/request` + `signup/start`: 5/h e 10/24 h por e-mail; 20/h e 100/24 h por IP."""
    ek = email_key(ctx, email)
    limits = [Limit(f"code_req:email:{ek}", 5, HOUR), Limit(f"code_req:email:{ek}", 10, DAY)]
    if ip:
        limits += [Limit(f"code_req:ip:{ip}", 20, HOUR), Limit(f"code_req:ip:{ip}", 100, DAY)]
    await ctx.limiter.hit(limits)


async def issue_code(
    conn: AsyncConnection,
    ctx: AppContext,
    email: str,
    purpose: str,
    *,
    user_id: uuid.UUID | None = None,
    pending_name: str | None = None,
    invite_id: uuid.UUID | None = None,
    ip: str | None = None,
) -> str:
    secret = ctx.settings.secret_bytes()
    eh = email_hash(secret, email)
    await execute(
        conn,
        "UPDATE email_codes SET invalidated_at = now() WHERE email_hash = :e AND purpose = :p "
        "AND consumed_at IS NULL AND invalidated_at IS NULL",
        {"e": eh, "p": purpose},
    )
    code = new_code()
    await execute(
        conn,
        "INSERT INTO email_codes (email_hash, purpose, code_hash, user_id, pending_name, invite_id, expires_at, ip) "
        "VALUES (:e, :p, :c, :u, :n, :i, :x, CAST(:ip AS inet))",
        {
            "e": eh,
            "p": purpose,
            "c": code_hash(secret, purpose, email, code),
            "u": user_id,
            "n": pending_name,
            "i": invite_id,
            "x": utcnow() + timedelta(seconds=ctx.settings.email_code_ttl_s),
            "ip": ip,
        },
    )
    return code


async def verify_code(ctx: AppContext, email: str, code: Any, purpose: str, ip: str | None) -> Any:
    """Consome o código ou levanta `code_invalid` (mesma resposta para qualquer motivo).

    Limites e bloqueio são por e-mail + rede do cliente (§17.3), e só tentativas contra um código vivo
    (existe, não usado, não expirado, abaixo do teto de tentativas) contam para o bloqueio: quem não lê a
    caixa de e-mail não consegue bloquear o dono mandando códigos aleatórios."""
    ek = email_key(ctx, email)
    net = net_key(ip)
    lock_key = f"email:{ek}:{net}"
    await ctx.limiter.check_lockout(lock_key)
    limits = [
        Limit(f"verify:email:{ek}:{net}", VERIFY_PER_NET_HOUR, HOUR),
        Limit(f"verify:email:{ek}", VERIFY_PER_EMAIL_HOUR, HOUR),
    ]
    if ip:
        limits.append(Limit(f"verify:ip:{ip}", VERIFY_PER_IP_HOUR, HOUR))
    await ctx.limiter.hit(limits)

    secret = ctx.settings.secret_bytes()
    ok_row = None
    guessed_live = False  # errou um código vivo (conta para o bloqueio)
    async with ctx.engine.begin() as conn:
        row = await fetchone(
            conn,
            "SELECT * FROM email_codes WHERE email_hash = :e AND purpose = :p AND consumed_at IS NULL "
            "AND invalidated_at IS NULL AND expires_at > now() ORDER BY created_at DESC LIMIT 1 FOR UPDATE",
            {"e": email_hash(secret, email), "p": purpose},
        )
        if row is not None and int(row.attempts) < ctx.settings.email_code_max_attempts:
            given = code if isinstance(code, str) and CODE_RE.match(code) else "x"
            if ct_equal(bytes(row.code_hash), code_hash(secret, purpose, email, given)):
                await execute(conn, "UPDATE email_codes SET consumed_at = now() WHERE id = :i", {"i": row.id})
                ok_row = row
            else:
                await execute(conn, "UPDATE email_codes SET attempts = attempts + 1 WHERE id = :i", {"i": row.id})
                guessed_live = True
    if ok_row is None:
        if guessed_live:
            await ctx.limiter.register_failure(lock_key)
        async with ctx.engine.begin() as conn:
            await log_activity(conn, "login_failed", None, None, ip, {"purpose": purpose})
        raise ApiError("code_invalid")
    return ok_row
