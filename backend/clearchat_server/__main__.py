"""`python -m clearchat_server` — sobe a api (1 worker) ou roda comandos de administração (ver cli.py)."""

from __future__ import annotations

import sys
from typing import Any


def main() -> None:
    if len(sys.argv) > 1 and sys.argv[1] != "serve" and not sys.argv[1].startswith("-"):
        from .cli import main as cli_main

        cli_main(sys.argv[1:])
        return
    import argparse

    import uvicorn

    from .main import create_app
    from .realtime.ws import WS_MAX_FRAME

    ap = argparse.ArgumentParser(prog="clearchat_server serve")
    ap.add_argument("serve", nargs="?")
    ap.add_argument("--host", default="0.0.0.0")
    ap.add_argument("--port", type=int, default=8000)
    args = ap.parse_args()

    app = create_app()

    class Server(uvicorn.Server):
        async def shutdown(self, sockets: Any = None) -> None:
            # fecha os WebSockets com 1001 (reinício do servidor, §10.5) antes do uvicorn derrubar as conexões
            ctx = getattr(app.state, "ctx", None)
            if ctx is not None:
                await ctx.hub.close_all(1001, "server_restart")
            await super().shutdown(sockets)

    config = uvicorn.Config(
        app,
        host=args.host,
        port=args.port,
        workers=1,
        proxy_headers=False,  # o IP real é resolvido pelo middleware (TRUSTED_PROXY_CIDRS)
        # limite do protocolo (4 MiB por frame, §10.1) + folga; acima disso o uvicorn fecha com 1009
        ws_max_size=WS_MAX_FRAME + 64 * 1024,
        ws_ping_interval=None,  # heartbeat é do protocolo (ping/pong de aplicação)
        log_config=None,
        timeout_graceful_shutdown=10,
    )
    Server(config).run()


if __name__ == "__main__":
    main()
