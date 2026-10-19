"""Apresentação do painel: formatação pt-BR (números, tamanhos, datas relativas), rótulos e cotas."""

from __future__ import annotations

import math
import re
from datetime import UTC, date, datetime
from decimal import Decimal, InvalidOperation
from typing import Any

from markupsafe import Markup, escape

# Tamanhos em base 1024, com rótulos curtos (como no app e no site).
UNITS = {"B": 1, "KB": 1024, "MB": 1024**2, "GB": 1024**3, "TB": 1024**4}

TYPE_LABELS = {
    "chat": "Conversas",
    "session": "Sessões",
    "message": "Mensagens",
    "provider": "Provedores",
    "setting": "Configurações",
    "preset": "Presets",
    "memory_collection": "Coleções de memória",
    "memory": "Memórias",
    "skill": "Skills",
    "blob": "Anexos (blobs)",
}

KIND_LABELS = {
    "signup": "Cadastro",
    "login": "Login",
    "login_failed": "Falha de login",
    "logout": "Saída",
    "refresh_reused": "Reuso de refresh token",
    "keys_setup": "Chaves configuradas",
    "keys_reset": "Chaves redefinidas",
    "password_changed": "Senha trocada",
    "device_revoked": "Dispositivo desconectado",
    "account_deleted": "Conta apagada",
    "ban": "Banido",
    "unban": "Reativado",
    "invite_created": "Convite criado",
    "admin_create_user": "Criado pelo admin",
    "admin_quotas": "Cotas alteradas",
    "admin_settings": "Instância alterada",
}
# eventos que merecem destaque (tom do selo)
KIND_TONE = {
    "login_failed": "danger",
    "refresh_reused": "danger",
    "ban": "danger",
    "account_deleted": "danger",
    "keys_reset": "warning",
    "device_revoked": "warning",
    "signup": "success",
    "unban": "success",
    "admin_create_user": "accent",
    "admin_quotas": "accent",
    "admin_settings": "accent",
    "invite_created": "accent",
}

CLIENT_LABELS = {"desktop": "App desktop", "mobile": "App móvel", "web": "Site"}
CREATED_BY_LABELS = {"signup": "cadastro", "invite": "convite", "admin": "painel admin"}


# ------------------------------------------------------------------ números
def num(n: Any, digits: int = 0) -> str:
    """1234567 → "1.234.567"; 1.5 → "1,5"."""
    if n is None:
        return "—"
    v = float(n)
    s = f"{v:,.{digits}f}"
    return s.replace(",", "\x00").replace(".", ",").replace("\x00", ".")


def human(n: Any) -> str:
    """Bytes legíveis em pt-BR: 137 B · 1,5 KB · 12,3 MB (base 1024)."""
    if n is None:
        return "—"
    v = float(n)
    for unit in ("B", "KB", "MB", "GB", "TB"):
        if abs(v) < 1024 or unit == "TB":
            if unit == "B":
                return f"{num(v)} B"
            return f"{num(v, 0 if abs(v) >= 100 else 1)} {unit}"
        v /= 1024
    return str(n)  # pragma: no cover


def pct(part: Any, whole: Any) -> float:
    """Porcentagem 0–100 (para barras); 0 se o total for 0."""
    try:
        p, w = float(part or 0), float(whole or 0)
    except (TypeError, ValueError):
        return 0.0
    if w <= 0:
        return 0.0
    return max(0.0, min(100.0, p * 100.0 / w))


def bar_width(part: Any, whole: Any) -> str:
    """Largura de barra para SVG (atributo, não CSS: compatível com a CSP). Mínimo visível de 1,5%."""
    v = pct(part, whole)
    if v <= 0:
        return "0%"
    return f"{max(v, 1.5):.2f}%"


# ------------------------------------------------------------------ datas
def _aware(v: datetime) -> datetime:
    return v if v.tzinfo else v.replace(tzinfo=UTC)


def dt(v: Any) -> str:
    if v is None:
        return "—"
    if isinstance(v, datetime):
        return _aware(v).astimezone(UTC).strftime("%d/%m/%Y %H:%M UTC")
    if isinstance(v, date):
        return v.strftime("%d/%m/%Y")
    return str(v)


def day(v: Any) -> str:
    """Data curta: "19/10" (ano só se não for o atual)."""
    if not isinstance(v, date):
        return str(v)
    if v.year == datetime.now(UTC).year:
        return v.strftime("%d/%m")
    return v.strftime("%d/%m/%Y")


WEEKDAYS = ("seg", "ter", "qua", "qui", "sex", "sáb", "dom")


def weekday(v: Any) -> str:
    return WEEKDAYS[v.weekday()] if isinstance(v, date) else ""


def relative(v: Any, now: datetime | None = None) -> str:
    if v is None:
        return "nunca"
    if not isinstance(v, datetime):
        return str(v)
    now = now or datetime.now(UTC)
    secs = (now - _aware(v)).total_seconds()
    future = secs < 0
    secs = abs(secs)
    if secs < 60:
        return "agora"
    for limit, size, one, many in (
        (3600, 60, "1 min", "{} min"),
        (86400, 3600, "1 h", "{} h"),
        (86400 * 30, 86400, "1 dia", "{} dias"),
        (86400 * 365, 86400 * 30, "1 mês", "{} meses"),
        (math.inf, 86400 * 365, "1 ano", "{} anos"),
    ):
        if secs < limit:
            n = int(secs // size)
            txt = one if n == 1 else many.format(n)
            return f"em {txt}" if future else f"há {txt}"
    return dt(v)  # pragma: no cover


def ago(v: Any) -> Markup:
    """`<time>` com o texto relativo e a data completa no title."""
    if v is None:
        return Markup('<span class="muted">nunca</span>')
    if not isinstance(v, datetime):
        return escape(str(v))
    iso = _aware(v).astimezone(UTC).isoformat(timespec="seconds")
    return Markup('<time datetime="{}" title="{}">{}</time>').format(iso, dt(v), relative(v))


def ts(v: Any) -> int:
    """Chave numérica de ordenação (epoch) para as colunas de data."""
    if isinstance(v, datetime):
        return int(_aware(v).timestamp())
    return 0


# ------------------------------------------------------------------ cotas
def quota_split(v: int | None) -> tuple[str, str]:
    """Valor do banco (bytes) → (número, unidade) para o editor: a maior unidade que represente o valor
    exatamente com até 2 casas ("1,5" GB). None → ("", "GB")."""
    if v is None:
        return "", "GB"
    if v == 0:
        return "0", "MB"
    for unit in ("TB", "GB", "MB", "KB"):
        size = UNITS[unit]
        if v < size:
            continue
        if v % size == 0:
            return str(v // size), unit
        q = Decimal(v) / size
        if q == q.quantize(Decimal("0.01")):
            return f"{q.normalize():f}".replace(".", ","), unit
    return str(v), "B"


_NUM_RE = re.compile(r"^\d+(?:[.,]\d+)?$")


def parse_quota(raw: str, unit: str = "") -> int | None:
    """Vazio → None (ilimitado); número (aceita vírgula) × unidade → inteiro ≥ 0. Sem unidade = valor bruto."""
    raw = raw.strip().replace(" ", "")
    if raw == "":
        return None
    if not _NUM_RE.match(raw):
        raise ValueError("cota inválida")
    try:
        value = Decimal(raw.replace(",", "."))
    except InvalidOperation as e:  # pragma: no cover
        raise ValueError("cota inválida") from e
    mult = UNITS.get(unit.strip().upper() or "B")
    if mult is None:
        raise ValueError("unidade inválida")
    n = int(value * mult)
    if n < 0 or n > 2**62:
        raise ValueError("cota fora do intervalo")
    return n


def quota_status(u: Any, devices: int) -> dict[str, Any]:
    """Pior uso relativo entre as cotas definidas: tone none|ok|warning|danger + rótulo."""
    pairs = [
        (u.usage_records, u.quota_records),
        (u.usage_record_bytes, u.quota_record_bytes),
        (u.usage_blob_bytes, u.quota_blob_bytes),
        (devices, u.quota_devices),
    ]
    ratios = [float(used or 0) / q if q else (999.0 if used else 1.0) for used, q in pairs if q is not None]
    if not ratios:
        return {"tone": "none", "label": "sem cota", "ratio": 0.0}
    r = max(ratios)
    if r >= 1:
        return {"tone": "danger", "label": "no limite", "ratio": r}
    if r >= 0.8:
        return {"tone": "warning", "label": f"{num(r * 100)}% usado", "ratio": r}
    return {"tone": "ok", "label": f"{num(r * 100)}% usado", "ratio": r}


def initials(name: str | None, email: str | None = None) -> str:
    parts = [p for p in re.split(r"\s+", (name or "").strip()) if p]
    if len(parts) >= 2:
        return (parts[0][0] + parts[-1][0]).upper()
    if parts:
        return parts[0][:2].upper()
    return (email or "?")[:1].upper()


def register(env: Any) -> None:
    env.filters.update(
        human=human,
        num=num,
        dt=dt,
        day=day,
        weekday=weekday,
        ago=ago,
        rel=relative,
        ts=ts,
    )
    env.globals.update(
        pct=pct,
        bar_width=bar_width,
        quota_split=quota_split,
        initials=initials,
        TYPE_LABELS=TYPE_LABELS,
        KIND_LABELS=KIND_LABELS,
        KIND_TONE=KIND_TONE,
        CLIENT_LABELS=CLIENT_LABELS,
        CREATED_BY_LABELS=CREATED_BY_LABELS,
    )
