"""Painel admin do ClearChat (docs/ARCHITECTURE.md §6): FastAPI + Jinja2, só em 127.0.0.1.

Defesas: ADMIN_TOKEN (≥ 32 caracteres, comparação em tempo constante) → cookie de sessão assinado
(HttpOnly, SameSite=Strict, 12 h); só aceita Host localhost/127.0.0.1/[::1] (anti DNS rebinding);
token CSRF em todo formulário; 5 tentativas de login/min por IP. Nunca mostra conteúdo (está cifrado).
"""

from __future__ import annotations

import hashlib
import hmac
import os
import secrets
import uuid
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from fastapi import FastAPI, Form, Request
from fastapi.responses import HTMLResponse, PlainTextResponse, RedirectResponse, Response
from fastapi.templating import Jinja2Templates
from itsdangerous import BadSignature, URLSafeTimedSerializer
from starlette.staticfiles import StaticFiles
from starlette.types import ASGIApp, Message, Receive, Scope, Send

from clearchat_server.config import Settings
from clearchat_server.db import execute, fetchall, fetchone, make_engine
from clearchat_server.errors import ApiError
from clearchat_server.instance import service as inst
from clearchat_server.mail import Mailer, invite_mail, welcome_mail
from clearchat_server.ratelimit import Limit, RateLimiter
from clearchat_server.services import accounts as acc
from clearchat_server.sync.blobs import BlobStore
from clearchat_server.util import client_ip, normalize_email, valid_email

from . import ui

SESSION_COOKIE = "cc_admin"
SESSION_MAX_AGE = 12 * 3600
# Hosts extras aceitos no cabeçalho Host (ex.: o IP da rede local), via ADMIN_ALLOWED_HOSTS no .env.
ALLOWED_HOSTS = {"localhost", "127.0.0.1", "[::1]", "::1"} | {
    h.strip().lower() for h in os.environ.get("ADMIN_ALLOWED_HOSTS", "").split(",") if h.strip()
}
TEMPLATES = Jinja2Templates(directory=str(Path(__file__).parent / "templates"))


ui.register(TEMPLATES.env)
STATIC_DIR = Path(__file__).parent / "static"

# CSP estrita: só recursos do próprio painel (CSS, JS e a fonte Inter servidos de /static), nada inline.
CSP = (
    "default-src 'none'; script-src 'self'; style-src 'self'; font-src 'self'; img-src 'self' data:; "
    "connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'"
)
SECURITY_HEADERS = [
    (b"content-security-policy", CSP.encode()),
    (b"x-content-type-options", b"nosniff"),
    (b"x-frame-options", b"DENY"),
    (b"referrer-policy", b"no-referrer"),
    (b"cache-control", b"no-store"),
]


class SecurityHeaders:
    """CSP e cabeçalhos defensivos em toda resposta (os estáticos podem ir para o cache)."""

    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        static = scope.get("path", "").startswith("/static/")

        async def send_with_headers(message: Message) -> None:
            if message["type"] == "http.response.start":
                headers = [(k, v) for k, v in message.get("headers", []) if k.lower() != b"cache-control" or static]
                for k, v in SECURITY_HEADERS:
                    if k == b"cache-control" and static:
                        continue
                    headers.append((k, v))
                message = {**message, "headers": headers}
            await send(message)

        await self.app(scope, receive, send_with_headers)


class HostGuard:
    """Recusa qualquer Host que não seja localhost (anti DNS rebinding)."""

    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] == "http":
            host = ""
            for k, v in scope.get("headers", []):
                if k == b"host":
                    host = v.decode("latin-1").lower()
                    break
            name = host.rsplit(":", 1)[0] if not host.startswith("[") else host.split("]")[0] + "]"
            if name not in ALLOWED_HOSTS:
                resp = PlainTextResponse("Host não permitido", status_code=403)
                await resp(scope, receive, send)
                return
        await self.app(scope, receive, send)


def check_admin_token(settings: Settings) -> None:
    if not settings.admin_token or len(settings.admin_token) < 32:
        raise SystemExit("ADMIN_TOKEN ausente ou curto (mínimo 32 caracteres): o painel admin não sobe.")
    if not settings.server_secret:
        raise SystemExit("SERVER_SECRET ausente.")


def create_admin_app(settings: Settings | None = None, mailer: Mailer | None = None) -> FastAPI:
    settings = settings or Settings()
    check_admin_token(settings)
    signing_key = hmac.new(
        settings.admin_token.encode(), b"clearchat-admin|" + settings.secret_bytes(), hashlib.sha256
    ).hexdigest()
    serializer = URLSafeTimedSerializer(signing_key, salt="cc-admin-session")
    store = BlobStore(settings)

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        app.state.engine = make_engine(settings.database_url, 3)
        app.state.limiter = RateLimiter(app.state.engine)
        app.state.mailer = mailer or Mailer(settings)
        try:
            yield
        finally:
            await app.state.engine.dispose()

    app = FastAPI(title="ClearChat Admin", lifespan=lifespan, docs_url=None, redoc_url=None, openapi_url=None)
    app.add_middleware(HostGuard)
    app.add_middleware(SecurityHeaders)
    app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")

    # ---------------------------------------------------------- sessão e CSRF
    def session(request: Request) -> dict[str, Any] | None:
        raw = request.cookies.get(SESSION_COOKIE)
        if not raw:
            return None
        try:
            data = serializer.loads(raw, max_age=SESSION_MAX_AGE)
        except BadSignature:
            return None
        return data if isinstance(data, dict) and "csrf" in data else None

    def render(request: Request, name: str, ctx: dict[str, Any], status: int = 200) -> HTMLResponse:
        s = session(request)
        base = {
            "request": request,
            "csrf": s["csrf"] if s else "",
            "settings": settings,
            "flash": request.query_params.get("ok"),
            "flash_error": request.query_params.get("err"),
            "now": datetime.now(UTC),
        }
        return TEMPLATES.TemplateResponse(request, name, {**base, **ctx}, status_code=status)

    def require(request: Request) -> dict[str, Any]:
        s = session(request)
        if s is None:
            raise _Redirect("/login")
        return s

    def require_csrf(request: Request, token: str) -> dict[str, Any]:
        s = require(request)
        if not token or not hmac.compare_digest(token, s["csrf"]):
            raise _Forbidden()
        return s

    class _Redirect(Exception):
        def __init__(self, url: str) -> None:
            self.url = url

    class _Forbidden(Exception):
        pass

    @app.exception_handler(_Redirect)
    async def _redir(_r: Request, e: _Redirect) -> Response:
        return RedirectResponse(e.url, status_code=303)

    @app.exception_handler(_Forbidden)
    async def _forb(_r: Request, _e: _Forbidden) -> Response:
        return PlainTextResponse("CSRF inválido", status_code=403)

    def ip_of(request: Request) -> str:
        return client_ip(request.client.host if request.client else None, request.headers, settings) or "?"

    # ---------------------------------------------------------- login
    @app.get("/login", response_class=HTMLResponse)
    async def login_form(request: Request) -> Response:
        return render(request, "login.html", {"error": None})

    @app.post("/login")
    async def login(request: Request, token: str = Form("")) -> Response:
        try:
            await app.state.limiter.hit([Limit(f"admin_login:{ip_of(request)}", 5, 60)])
        except ApiError:
            return render(request, "login.html", {"error": "Muitas tentativas. Aguarde um minuto."}, 429)
        if not hmac.compare_digest(token.encode(), settings.admin_token.encode()):
            return render(request, "login.html", {"error": "Token inválido."}, 401)
        resp = RedirectResponse("/", status_code=303)
        cookie = serializer.dumps({"sid": secrets.token_urlsafe(16), "csrf": secrets.token_urlsafe(24)})
        resp.set_cookie(SESSION_COOKIE, cookie, max_age=SESSION_MAX_AGE, httponly=True, samesite="strict", path="/")
        return resp

    @app.post("/logout")
    async def logout(request: Request, csrf: str = Form("")) -> Response:
        require_csrf(request, csrf)
        resp = RedirectResponse("/login", status_code=303)
        resp.delete_cookie(SESSION_COOKIE, path="/")
        return resp

    # ---------------------------------------------------------- painel
    @app.get("/", response_class=HTMLResponse)
    async def dashboard(request: Request) -> Response:
        require(request)
        async with app.state.engine.connect() as c:
            totals = await fetchone(
                c,
                "SELECT (SELECT count(*) FROM users) AS users, "
                "(SELECT count(*) FROM users WHERE status = 'banned') AS banned, "
                "(SELECT count(*) FROM users WHERE last_seen_at > now() - interval '1 day') AS active1, "
                "(SELECT count(*) FROM users WHERE last_seen_at > now() - interval '7 days') AS active7, "
                "(SELECT count(*) FROM users WHERE last_seen_at > now() - interval '30 days') AS active30, "
                "(SELECT count(*) FROM devices WHERE revoked_at IS NULL) AS devices, "
                "(SELECT COALESCE(sum(usage_records), 0) FROM users) AS records, "
                "(SELECT COALESCE(sum(usage_record_bytes), 0) FROM users) AS record_bytes, "
                "(SELECT COALESCE(sum(usage_blobs), 0) FROM users) AS blobs, "
                "(SELECT COALESCE(sum(usage_blob_bytes), 0) FROM users) AS blob_bytes",
            )
            days = await fetchall(
                c,
                "WITH d AS (SELECT generate_series(current_date - 13, current_date, interval '1 day')::date AS day) "
                "SELECT d.day, "
                "(SELECT count(*) FROM activity a WHERE a.kind = 'login' AND a.at::date = d.day) AS logins, "
                "(SELECT count(*) FROM activity a WHERE a.kind = 'signup' AND a.at::date = d.day) AS signups, "
                "(SELECT count(*) FROM activity a WHERE a.kind IN ('login_failed', 'refresh_reused') "
                "  AND a.at::date = d.day) AS failures, "
                "(SELECT COALESCE(sum(pushes), 0) FROM usage_daily u WHERE u.day = d.day) AS pushes, "
                "(SELECT COALESCE(sum(blob_uploads), 0) FROM usage_daily u WHERE u.day = d.day) AS uploads, "
                "(SELECT count(DISTINCT user_id) FROM usage_daily u WHERE u.day = d.day) AS active "
                "FROM d ORDER BY d.day DESC",
            )
            recent = await fetchall(
                c,
                "SELECT a.kind, a.ip, a.at, a.meta, u.email FROM activity a LEFT JOIN users u ON u.id = a.user_id "
                "ORDER BY a.at DESC LIMIT 30",
            )
            by_type = await fetchall(
                c,
                "SELECT type, count(*) AS n, COALESCE(sum(size), 0) AS bytes FROM records WHERE NOT deleted "
                "GROUP BY type ORDER BY bytes DESC",
            )
            top = await fetchall(
                c,
                "SELECT id, email, name, status, usage_record_bytes, usage_blob_bytes, "
                "usage_record_bytes + usage_blob_bytes AS total FROM users "
                "WHERE usage_record_bytes + usage_blob_bytes > 0 ORDER BY total DESC LIMIT 8",
            )
        storage = [{"type": r.type, "n": r.n, "bytes": int(r.bytes)} for r in by_type]
        if totals and totals.blobs:
            storage.append({"type": "blob", "n": totals.blobs, "bytes": int(totals.blob_bytes)})
        storage.sort(key=lambda r: r["bytes"], reverse=True)
        chart = list(reversed(days))  # mais antigo → mais recente
        sums = {
            k: sum(int(getattr(d, k)) for d in days) for k in ("logins", "signups", "failures", "pushes", "uploads")
        }
        return render(
            request,
            "dashboard.html",
            {
                "t": totals,
                "days": days,
                "chart": chart,
                "chart_max": max([int(d.active) for d in days] + [1]),
                "sums": sums,
                "recent": recent,
                "storage": storage,
                "storage_max": max([r["bytes"] for r in storage] + [1]),
                "storage_total": int(totals.record_bytes + totals.blob_bytes) if totals else 0,
                "top": top,
                "top_max": max([int(r.total) for r in top] + [1]),
                "nav": "dashboard",
            },
        )

    @app.get("/users", response_class=HTMLResponse)
    async def users(request: Request, q: str = "") -> Response:
        require(request)
        async with app.state.engine.connect() as c:
            rows = await fetchall(
                c,
                "SELECT u.*, (SELECT count(*) FROM devices d WHERE d.user_id = u.id AND d.revoked_at IS NULL) AS n_devices "
                "FROM users u WHERE (:q = '' OR u.email::text ILIKE :like OR u.name ILIKE :like) "
                "ORDER BY u.created_at DESC LIMIT 500",
                {"q": q, "like": f"%{q}%"},
            )
        items = []
        for r in rows:
            items.append(
                {
                    "u": r,
                    "storage": int(r.usage_record_bytes) + int(r.usage_blob_bytes),
                    "quota": ui.quota_status(r, int(r.n_devices)),
                }
            )
        counts = {
            "all": len(items),
            "active": sum(1 for i in items if i["u"].status == "active"),
            "banned": sum(1 for i in items if i["u"].status == "banned"),
            "nokeys": sum(1 for i in items if not i["u"].keys_ready),
            "quota": sum(1 for i in items if i["quota"]["tone"] in ("warning", "danger")),
        }
        storage_max = max([i["storage"] for i in items] + [1])
        return render(
            request,
            "users.html",
            {"users": items, "q": q, "counts": counts, "storage_max": storage_max, "nav": "users"},
        )

    async def _user(c: Any, user_id: str) -> Any:
        try:
            uid = uuid.UUID(user_id)
        except ValueError:
            return None
        return await fetchone(c, "SELECT * FROM users WHERE id = :u", {"u": uid})

    @app.get("/users/new", response_class=HTMLResponse)
    async def new_user_form(request: Request) -> Response:
        require(request)
        return render(request, "user_new.html", {"error": None, "nav": "users"})

    @app.post("/users/new")
    async def new_user(
        request: Request,
        csrf: str = Form(""),
        email: str = Form(""),
        name: str = Form(""),
        send_welcome: str = Form(""),
    ) -> Response:
        require_csrf(request, csrf)
        email = normalize_email(email)
        name = name.strip()
        if not valid_email(email) or not 1 <= len(name) <= 100:
            return render(
                request,
                "user_new.html",
                {"error": "E-mail ou nome inválido.", "nav": "users", "form": {"email": email, "name": name}},
                400,
            )
        async with app.state.engine.begin() as c:
            if await fetchone(c, "SELECT 1 FROM users WHERE email = :e", {"e": email}):
                return render(
                    request,
                    "user_new.html",
                    {
                        "error": "Já existe uma conta com esse e-mail.",
                        "nav": "users",
                        "form": {"email": email, "name": name},
                    },
                    400,
                )
            uid = await acc.create_user(c, email, name, settings)
            await acc.log_activity(c, "admin_create_user", uid, None, ip_of(request))
            current = await inst.load(c, settings)
        if send_welcome:
            await app.state.mailer.send(welcome_mail(email, current.instance_name, f"{settings.public_base_url}/login"))
        return RedirectResponse(f"/users/{uid}?ok=Usuário+criado", status_code=303)

    @app.get("/users/{user_id}", response_class=HTMLResponse)
    async def user_detail(request: Request, user_id: str) -> Response:
        require(request)
        async with app.state.engine.connect() as c:
            u = await _user(c, user_id)
            if u is None:
                return render(
                    request,
                    "message.html",
                    {"title": "Não encontrado", "text": "Usuário inexistente.", "back": "/users", "nav": "users"},
                    404,
                )
            by_type = await fetchall(
                c,
                "SELECT type, count(*) AS n, COALESCE(sum(size), 0) AS bytes FROM records "
                "WHERE user_id = :u AND NOT deleted GROUP BY type ORDER BY type",
                {"u": u.id},
            )
            tomb = await fetchone(c, "SELECT count(*) AS n FROM records WHERE user_id = :u AND deleted", {"u": u.id})
            blobs = await fetchone(
                c,
                "SELECT count(*) AS n, COALESCE(sum(size), 0) AS bytes, "
                "count(*) FILTER (WHERE unreferenced_since IS NOT NULL) AS orphans FROM blobs WHERE user_id = :u",
                {"u": u.id},
            )
            devices = await fetchall(
                c, "SELECT * FROM devices WHERE user_id = :u ORDER BY created_at DESC", {"u": u.id}
            )
            activity = await fetchall(
                c, "SELECT * FROM activity WHERE user_id = :u ORDER BY at DESC LIMIT 50", {"u": u.id}
            )
            daily = await fetchall(
                c, "SELECT * FROM usage_daily WHERE user_id = :u ORDER BY day DESC LIMIT 30", {"u": u.id}
            )
        active_devices = sum(1 for d in devices if d.revoked_at is None)
        storage = [{"type": r.type, "n": r.n, "bytes": int(r.bytes)} for r in by_type]
        storage.sort(key=lambda r: r["bytes"], reverse=True)
        return render(
            request,
            "user.html",
            {
                "u": u,
                "by_type": by_type,
                "storage": storage,
                "storage_max": max([r["bytes"] for r in storage] + [int(blobs.bytes) if blobs else 0, 1]),
                "tomb": tomb,
                "blobs": blobs,
                "devices": devices,
                "active_devices": active_devices,
                "activity": activity,
                "daily": daily,
                "quota": ui.quota_status(u, active_devices),
                "nav": "users",
            },
        )

    @app.post("/users/{user_id}/quotas")
    async def user_quotas(
        request: Request,
        user_id: str,
        csrf: str = Form(""),
        quota_record_bytes: str = Form(""),
        quota_record_bytes_unit: str = Form(""),
        quota_records: str = Form(""),
        quota_blob_bytes: str = Form(""),
        quota_blob_bytes_unit: str = Form(""),
        quota_devices: str = Form(""),
    ) -> Response:
        require_csrf(request, csrf)
        try:
            vals = {
                "a": ui.parse_quota(quota_record_bytes, quota_record_bytes_unit),
                "b": ui.parse_quota(quota_records),
                "c": ui.parse_quota(quota_blob_bytes, quota_blob_bytes_unit),
                "d": ui.parse_quota(quota_devices),
            }
            if (vals["b"] is not None and vals["b"] > 2**31 - 1) or (vals["d"] is not None and vals["d"] > 2**31 - 1):
                raise ValueError
        except ValueError:
            return render(
                request,
                "message.html",
                {
                    "title": "Cota inválida",
                    "text": "Use números ≥ 0 (decimais com vírgula nos tamanhos) ou deixe vazio para ilimitado.",
                    "back": f"/users/{user_id}#cotas",
                    "nav": "users",
                },
                400,
            )
        async with app.state.engine.begin() as c:
            u = await _user(c, user_id)
            if u is None:
                return PlainTextResponse("não encontrado", status_code=404)
            await execute(
                c,
                "UPDATE users SET quota_record_bytes = :a, quota_records = :b, quota_blob_bytes = :c, quota_devices = :d "
                "WHERE id = :u",
                {**vals, "u": u.id},
            )
            await acc.log_activity(c, "admin_quotas", u.id, None, ip_of(request), {k: v for k, v in vals.items()})
        return RedirectResponse(f"/users/{u.id}?ok=Cotas+salvas", status_code=303)

    @app.post("/users/{user_id}/ban")
    async def user_ban(request: Request, user_id: str, csrf: str = Form(""), reason: str = Form("")) -> Response:
        require_csrf(request, csrf)
        async with app.state.engine.begin() as c:
            u = await _user(c, user_id)
            if u is None:
                return PlainTextResponse("não encontrado", status_code=404)
            await acc.ban_user(c, u.id, reason.strip()[:500] or None)
            await acc.log_activity(c, "ban", u.id, None, ip_of(request), {"reason": reason.strip()[:200]})
            await acc.notify(c, {"kind": "user_banned", "user_id": str(u.id)})
        return RedirectResponse(f"/users/{u.id}?ok=Usuário+banido", status_code=303)

    @app.post("/users/{user_id}/unban")
    async def user_unban(request: Request, user_id: str, csrf: str = Form("")) -> Response:
        require_csrf(request, csrf)
        async with app.state.engine.begin() as c:
            u = await _user(c, user_id)
            if u is None:
                return PlainTextResponse("não encontrado", status_code=404)
            await acc.unban_user(c, u.id)
            await acc.log_activity(c, "unban", u.id, None, ip_of(request))
        return RedirectResponse(f"/users/{u.id}?ok=Usuário+reativado", status_code=303)

    @app.post("/users/{user_id}/revoke-devices")
    async def user_revoke(request: Request, user_id: str, csrf: str = Form("")) -> Response:
        require_csrf(request, csrf)
        async with app.state.engine.begin() as c:
            u = await _user(c, user_id)
            if u is None:
                return PlainTextResponse("não encontrado", status_code=404)
            ids, chats = await acc.revoke_devices(c, u.id)
            await acc.log_activity(c, "device_revoked", u.id, None, ip_of(request), {"by": "admin", "n": len(ids)})
            await acc.notify(
                c,
                {"kind": "devices_revoked", "user_id": str(u.id), "device_ids": [str(i) for i in ids], "chats": chats},
            )
        return RedirectResponse(f"/users/{u.id}?ok=Dispositivos+desconectados#dispositivos", status_code=303)

    @app.post("/users/{user_id}/devices/{device_id}/revoke")
    async def user_revoke_one(request: Request, user_id: str, device_id: str, csrf: str = Form("")) -> Response:
        require_csrf(request, csrf)
        try:
            did = uuid.UUID(device_id)
        except ValueError:
            return PlainTextResponse("não encontrado", status_code=404)
        async with app.state.engine.begin() as c:
            u = await _user(c, user_id)
            if u is None:
                return PlainTextResponse("não encontrado", status_code=404)
            ids, chats = await acc.revoke_devices(c, u.id, [did])
            if ids:
                await acc.log_activity(c, "device_revoked", u.id, did, ip_of(request), {"by": "admin", "n": 1})
                await acc.notify(
                    c,
                    {
                        "kind": "devices_revoked",
                        "user_id": str(u.id),
                        "device_ids": [str(i) for i in ids],
                        "chats": chats,
                    },
                )
        return RedirectResponse(f"/users/{u.id}?ok=Dispositivo+desconectado#dispositivos", status_code=303)

    @app.post("/users/{user_id}/delete")
    async def user_delete(
        request: Request, user_id: str, csrf: str = Form(""), confirm_email: str = Form("")
    ) -> Response:
        require_csrf(request, csrf)
        async with app.state.engine.begin() as c:
            u = await _user(c, user_id)
            if u is None:
                return PlainTextResponse("não encontrado", status_code=404)
            if normalize_email(confirm_email) != str(u.email).lower():
                return render(
                    request,
                    "message.html",
                    {
                        "title": "Confirmação errada",
                        "text": "Digite o e-mail exato da conta para apagá-la.",
                        "back": f"/users/{u.id}#zona-de-perigo",
                        "nav": "users",
                    },
                    400,
                )
            await acc.delete_user(c, u.id)
            await acc.log_activity(c, "account_deleted", None, None, ip_of(request), {"by": "admin"})
            await acc.notify(c, {"kind": "user_deleted", "user_id": str(u.id)})
        store.remove_user(u.id)
        return RedirectResponse("/users?ok=Conta+apagada", status_code=303)

    # ---------------------------------------------------------- convites
    def _invites_ctx(
        rows: list[Any], link: str | None, mail_to: str | None = None, mailed: bool = False, ndays: int = 0
    ) -> dict[str, Any]:
        now = datetime.now(UTC)
        items = []
        for i in rows:
            if i.used_at:
                status = "used"
            elif i.revoked_at:
                status = "revoked"
            elif i.expires_at < now:
                status = "expired"
            else:
                status = "pending"
            items.append({"i": i, "status": status})
        counts = {k: sum(1 for x in items if x["status"] == k) for k in ("pending", "used", "expired", "revoked")}
        return {
            "invites": items,
            "counts": counts,
            "link": link,
            "link_email": mail_to,
            "link_mailed": mailed,
            "link_days": ndays,
            "nav": "invites",
        }

    @app.get("/invites", response_class=HTMLResponse)
    async def invites(request: Request) -> Response:
        require(request)
        async with app.state.engine.connect() as c:
            rows = await fetchall(
                c,
                "SELECT i.*, u.email AS used_email FROM invites i LEFT JOIN users u ON u.id = i.used_by "
                "ORDER BY i.created_at DESC LIMIT 200",
            )
        return render(request, "invites.html", _invites_ctx(rows, None))

    @app.post("/invites", response_class=HTMLResponse)
    async def invite_create(
        request: Request,
        csrf: str = Form(""),
        email: str = Form(""),
        note: str = Form(""),
        days: str = Form(""),
        send_email: str = Form(""),
    ) -> Response:
        require_csrf(request, csrf)
        mail_to = normalize_email(email) if email.strip() else None
        if mail_to is not None and not valid_email(mail_to):
            return render(
                request,
                "message.html",
                {
                    "title": "E-mail inválido",
                    "text": "Confira o e-mail do convite.",
                    "back": "/invites",
                    "nav": "invites",
                },
                400,
            )
        try:
            ndays = int(days) if days.strip() else settings.invite_ttl_days
            if not 1 <= ndays <= 365:
                raise ValueError
        except ValueError:
            return render(
                request,
                "message.html",
                {
                    "title": "Validade inválida",
                    "text": "A validade vai de 1 a 365 dias.",
                    "back": "/invites",
                    "nav": "invites",
                },
                400,
            )
        async with app.state.engine.begin() as c:
            _iid, token = await acc.create_invite(c, mail_to, note.strip()[:200] or None, ndays)
            await acc.log_activity(c, "invite_created", None, None, ip_of(request), {"bound": bool(mail_to)})
            current = await inst.load(c, settings)
            rows = await fetchall(
                c,
                "SELECT i.*, u.email AS used_email FROM invites i LEFT JOIN users u ON u.id = i.used_by "
                "ORDER BY i.created_at DESC LIMIT 200",
            )
        link = f"{settings.public_base_url}/signup?invite={token}"
        if send_email and mail_to:
            await app.state.mailer.send(invite_mail(mail_to, current.instance_name, link, ndays))
        return render(request, "invites.html", _invites_ctx(rows, link, mail_to, bool(send_email and mail_to), ndays))

    @app.post("/invites/{invite_id}/revoke")
    async def invite_revoke(request: Request, invite_id: str, csrf: str = Form("")) -> Response:
        require_csrf(request, csrf)
        try:
            iid = uuid.UUID(invite_id)
        except ValueError:
            return PlainTextResponse("não encontrado", status_code=404)
        async with app.state.engine.begin() as c:
            await execute(c, "UPDATE invites SET revoked_at = now() WHERE id = :i AND used_at IS NULL", {"i": iid})
        return RedirectResponse("/invites?ok=Convite+revogado", status_code=303)

    # ---------------------------------------------------------- configurações da instância
    @app.get("/settings", response_class=HTMLResponse)
    async def settings_form(request: Request) -> Response:
        require(request)
        async with app.state.engine.connect() as c:
            current = await inst.load(c, settings)
        return render(
            request, "settings.html", {"cur": current, "keys": settings.captcha_keys_present, "nav": "settings"}
        )

    @app.post("/settings")
    async def settings_save(
        request: Request,
        csrf: str = Form(""),
        instance_name: str = Form(""),
        signup_open: str = Form(""),
        landing_enabled: str = Form(""),
        captcha_enabled: str = Form(""),
    ) -> Response:
        require_csrf(request, csrf)
        name = instance_name.strip()[:80] or settings.instance_name
        async with app.state.engine.begin() as c:
            await inst.save(
                c,
                {
                    "instance_name": name,
                    "signup_open": bool(signup_open),
                    "landing_enabled": bool(landing_enabled),
                    "captcha_enabled": bool(captcha_enabled),
                    "gateway_enabled": False,
                },
            )
            await acc.log_activity(c, "admin_settings", None, None, ip_of(request))
            await acc.notify(c, {"kind": "settings_changed"})
        return RedirectResponse("/settings?ok=Configurações+salvas", status_code=303)

    return app
