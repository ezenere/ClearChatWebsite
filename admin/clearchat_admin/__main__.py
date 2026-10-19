"""`python -m clearchat_admin [--host 127.0.0.1] [--port 8190]`.

Fora do Docker o padrão é 127.0.0.1. Dentro do container o compose usa `--host 0.0.0.0` e publica a porta
SÓ em 127.0.0.1 do host ("127.0.0.1:${ADMIN_PORT}:8090"). Nunca exponha nem roteie no Nginx.
"""

from __future__ import annotations

import argparse
import ipaddress
import logging
import sys
import time

import uvicorn

from clearchat_server.config import Settings
from clearchat_server.logging_setup import setup_logging

from .main import check_admin_token, create_admin_app


def main() -> None:
    ap = argparse.ArgumentParser(prog="clearchat_admin")
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=8190)
    ap.add_argument(
        "--in-container",
        action="store_true",
        help="permite --host 0.0.0.0 (a porta precisa estar publicada só em 127.0.0.1 do host)",
    )
    args = ap.parse_args()
    try:
        loopback = args.host == "localhost" or ipaddress.ip_address(args.host).is_loopback
    except ValueError:
        loopback = False
    if not loopback and not args.in_container:
        sys.exit("O painel admin só escuta em 127.0.0.1 (use --in-container dentro do Docker).")
    settings = Settings()
    setup_logging(settings.log_level, settings.log_format)
    try:
        check_admin_token(settings)
    except SystemExit as e:
        if not args.in_container:
            raise
        # no container (restart: unless-stopped) não fica reiniciando em loop: avisa e espera
        logging.getLogger("clearchat.admin").error(str(e))
        while True:
            time.sleep(3600)
    uvicorn.run(create_admin_app(settings), host=args.host, port=args.port, proxy_headers=False, log_config=None)


if __name__ == "__main__":
    main()
