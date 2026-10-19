"""Comandos de administração: `python -m clearchat_server <comando>`.

migrate                     roda as migrações (alembic upgrade head)
init-env [--out .env]       cria o .env a partir do .env.example com segredos gerados
create-user EMAIL NOME      cria usuário (sem chaves; entra por código e define a senha no /setup)
invite [--email E] [--days N] [--note T]   gera link de convite de uso único
settings [--name N] [--signup-open on|off] [--landing on|off] [--captcha on|off]
gc                          roda uma passada de GC agora
healthcheck [--port 8000]   GET <base>/api/info local (healthcheck do container)
"""

from __future__ import annotations

import argparse
import asyncio
import secrets
import sys
from pathlib import Path
from typing import Any

from .config import Settings


def _onoff(v: str) -> bool:
    if v.lower() in ("on", "true", "1", "sim", "yes"):
        return True
    if v.lower() in ("off", "false", "0", "nao", "não", "no"):
        return False
    raise argparse.ArgumentTypeError("use on/off")


def init_env(example: Path, out: Path, force: bool) -> None:
    if out.exists() and not force:
        print(f"{out} já existe (use --force para sobrescrever)", file=sys.stderr)
        sys.exit(1)
    gen = {
        "SERVER_SECRET": secrets.token_urlsafe(48),
        "ADMIN_TOKEN": secrets.token_urlsafe(36),
        "POSTGRES_PASSWORD": secrets.token_urlsafe(24),
    }
    lines = []
    for line in example.read_text().splitlines():
        key = line.split("=", 1)[0].strip()
        if key in gen and line.strip().endswith("="):
            line = f"{key}={gen[key]}"
        lines.append(line)
    out.write_text("\n".join(lines) + "\n")
    out.chmod(0o600)
    print(f"{out} criado (permissão 600). ADMIN_TOKEN={gen['ADMIN_TOKEN']}")
    print("Revise PUBLIC_BASE_URL, SMTP_* e TURNSTILE_* antes de subir.")


async def _with_conn(settings: Settings, fn: Any) -> Any:
    from .db import make_engine

    engine = make_engine(settings.database_url, 2)
    try:
        async with engine.begin() as conn:
            return await fn(conn)
    finally:
        await engine.dispose()


def main(argv: list[str]) -> None:
    ap = argparse.ArgumentParser(
        prog="python -m clearchat_server", description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("migrate")
    p = sub.add_parser("init-env")
    p.add_argument("--example", default=".env.example")
    p.add_argument("--out", default=".env")
    p.add_argument("--force", action="store_true")
    p = sub.add_parser("create-user")
    p.add_argument("email")
    p.add_argument("name")
    p = sub.add_parser("invite")
    p.add_argument("--email")
    p.add_argument("--days", type=int)
    p.add_argument("--note")
    p = sub.add_parser("settings")
    p.add_argument("--name")
    p.add_argument("--signup-open", type=_onoff)
    p.add_argument("--landing", type=_onoff)
    p.add_argument("--captcha", type=_onoff)
    sub.add_parser("gc")
    p = sub.add_parser("healthcheck")
    p.add_argument("--port", type=int, default=8000)
    args = ap.parse_args(argv)

    if args.cmd == "init-env":
        init_env(Path(args.example), Path(args.out), args.force)
        return
    settings = Settings()
    if args.cmd == "healthcheck":
        import urllib.request

        url = f"http://127.0.0.1:{args.port}{settings.base_path}/api/info"
        with urllib.request.urlopen(url, timeout=3) as r:
            sys.exit(0 if r.status == 200 else 1)
    if args.cmd == "migrate":
        from .db import migrate

        migrate(settings.database_url)
        print("migrações aplicadas")
    elif args.cmd == "create-user":
        from .services.accounts import create_user
        from .util import normalize_email, valid_email

        email = normalize_email(args.email)
        if not valid_email(email):
            sys.exit("e-mail inválido")
        uid = asyncio.run(_with_conn(settings, lambda c: create_user(c, email, args.name.strip(), settings)))
        print(f"usuário criado: {uid} — entre em {settings.public_base_url}/login com {email}")
    elif args.cmd == "invite":
        from .services.accounts import create_invite

        days = args.days or settings.invite_ttl_days
        bound = args.email.strip().lower() if args.email else None
        _iid, token = asyncio.run(_with_conn(settings, lambda c: create_invite(c, bound, args.note, days)))
        print(f"{settings.public_base_url}/signup?invite={token}")
    elif args.cmd == "settings":
        from .instance import service as inst
        from .services.accounts import notify

        values = {}
        if args.name is not None:
            values["instance_name"] = args.name
        if args.signup_open is not None:
            values["signup_open"] = args.signup_open
        if args.landing is not None:
            values["landing_enabled"] = args.landing
        if args.captcha is not None:
            values["captcha_enabled"] = args.captcha

        async def run(conn: Any) -> Any:
            if values:
                await inst.save(conn, values)
                await notify(conn, {"kind": "settings_changed"})
            return await inst.load(conn, settings)

        cur = asyncio.run(_with_conn(settings, run))
        print(cur)
        if cur.captcha_enabled and not settings.captcha_keys_present:
            print("(captcha ligado, mas sem TURNSTILE_* no .env → sem captcha)")
    elif args.cmd == "gc":
        from types import SimpleNamespace

        from .db import make_engine
        from .jobs import run_gc
        from .sync.blobs import BlobStore

        async def go() -> Any:
            engine = make_engine(settings.database_url, 2)
            try:
                ctx = SimpleNamespace(settings=settings, engine=engine, blobs=BlobStore(settings))
                return await run_gc(ctx)  # type: ignore[arg-type]  # só usa settings/engine/blobs
            finally:
                await engine.dispose()

        print(asyncio.run(go()))
