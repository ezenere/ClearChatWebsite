"""Envio de e-mail: SMTP (aiosmtplib), console (desenvolvimento: escreve o e-mail no log) ou memória (testes).

Falha de SMTP é logada (sem o código) e nunca muda a resposta HTTP."""

from __future__ import annotations

import html
import logging
from dataclasses import dataclass, field
from email.message import EmailMessage
from email.utils import make_msgid

from ..config import Settings

log = logging.getLogger("clearchat.mail")


@dataclass
class Mail:
    to: str
    subject: str
    text: str
    html: str
    kind: str
    meta: dict[str, str] = field(default_factory=dict)


PURPOSE_TEXT = {
    "signup": "para concluir seu cadastro",
    "login": "para entrar",
    "delete_account": "para APAGAR sua conta",
    "reset_keys": "para ZERAR a criptografia da sua conta (todos os dados sincronizados serão apagados)",
}


def _wrap_html(body_html: str, instance: str) -> str:
    return (
        '<!doctype html><html lang="pt-BR"><body style="font-family:system-ui,sans-serif;'
        'max-width:520px;margin:24px auto;color:#111">'
        f'<h2 style="margin:0 0 16px">{html.escape(instance)}</h2>{body_html}'
        '<p style="color:#666;font-size:12px;margin-top:32px">E-mail automático — não responda.</p>'
        "</body></html>"
    )


def code_mail(to: str, code: str, purpose: str, instance: str, ttl_s: int) -> Mail:
    minutes = max(1, ttl_s // 60)
    what = PURPOSE_TEXT.get(purpose, "")
    subject = f"Seu código {instance}: {code}"
    text = (
        f"Seu código {instance} {what}: {code}\n\n"
        f"Ele vale por {minutes} minutos e só pode ser usado uma vez.\n"
        "Se não foi você, ignore este e-mail.\n"
    )
    body = (
        f"<p>Seu código {html.escape(what)}:</p>"
        f'<p style="font-size:32px;letter-spacing:6px;font-weight:700">{code}</p>'
        f"<p>Ele vale por {minutes} minutos e só pode ser usado uma vez.</p>"
        "<p>Se não foi você, ignore este e-mail.</p>"
    )
    return Mail(to, subject, text, _wrap_html(body, instance), f"code:{purpose}", {"code": code})


def existing_account_mail(to: str, instance: str, login_url: str) -> Mail:
    subject = f"Você já tem uma conta no {instance}"
    text = (
        f"Alguém (talvez você) tentou criar uma conta no {instance} com este e-mail, mas ela já existe.\n"
        f"Para entrar, use: {login_url}\n\nSe não foi você, ignore este e-mail.\n"
    )
    body = (
        f"<p>Alguém (talvez você) tentou criar uma conta no {html.escape(instance)} com este e-mail, "
        "mas ela já existe.</p>"
        f'<p><a href="{html.escape(login_url)}">Entrar</a></p><p>Se não foi você, ignore este e-mail.</p>'
    )
    return Mail(to, subject, text, _wrap_html(body, instance), "existing_account")


def invite_mail(to: str, instance: str, link: str, days: int) -> Mail:
    subject = f"Convite para o {instance}"
    text = (
        f"Você foi convidado para o {instance}.\nCrie sua conta em: {link}\n"
        f"O convite vale por {days} dias e só pode ser usado uma vez.\n"
    )
    body = (
        f"<p>Você foi convidado para o {html.escape(instance)}.</p>"
        f'<p><a href="{html.escape(link)}">Criar minha conta</a></p>'
        f"<p>O convite vale por {days} dias e só pode ser usado uma vez.</p>"
    )
    return Mail(to, subject, text, _wrap_html(body, instance), "invite", {"link": link})


def welcome_mail(to: str, instance: str, login_url: str) -> Mail:
    subject = f"Sua conta no {instance}"
    text = (
        f"Uma conta foi criada para você no {instance}.\nEntre com este e-mail em: {login_url}\n"
        "No primeiro acesso você define a sua senha de criptografia.\n"
    )
    body = (
        f"<p>Uma conta foi criada para você no {html.escape(instance)}.</p>"
        f'<p><a href="{html.escape(login_url)}">Entrar</a></p>'
        "<p>No primeiro acesso você define a sua senha de criptografia.</p>"
    )
    return Mail(to, subject, text, _wrap_html(body, instance), "welcome")


class Mailer:
    def __init__(self, settings: Settings) -> None:
        self.settings = settings
        self.backend = settings.effective_mail_backend
        self.outbox: list[Mail] = []  # backend "memory"

    async def send(self, mail: Mail) -> None:
        try:
            if self.backend == "memory":
                self.outbox.append(mail)
            elif self.backend == "console":
                # só desenvolvimento: o corpo (com o código) vai para o log
                log.warning("e-mail (MAIL_BACKEND=console) para %s — %s\n%s", mail.to, mail.subject, mail.text)
            else:
                await self._smtp(mail)
        except Exception as e:  # nunca propaga: a resposta HTTP já foi dada
            log.error("falha ao enviar e-mail", extra={"kind": mail.kind, "error": type(e).__name__})

    async def _smtp(self, mail: Mail) -> None:
        import aiosmtplib

        s = self.settings
        msg = EmailMessage()
        msg["From"] = s.smtp_from
        msg["To"] = mail.to
        msg["Subject"] = mail.subject
        domain = s.smtp_from.rsplit("@", 1)[-1].strip("> ") or None
        msg["Message-ID"] = make_msgid(domain=domain)
        msg.set_content(mail.text)
        msg.add_alternative(mail.html, subtype="html")
        await aiosmtplib.send(
            msg,
            hostname=s.smtp_host,
            port=s.smtp_port,
            username=s.smtp_username or None,
            password=s.smtp_password or None,
            use_tls=s.smtp_tls_mode == "ssl",
            start_tls=s.smtp_tls_mode == "starttls",
            validate_certs=s.smtp_validate_certs,
            timeout=s.smtp_timeout_s,
        )
        log.info("e-mail enviado", extra={"kind": mail.kind})
