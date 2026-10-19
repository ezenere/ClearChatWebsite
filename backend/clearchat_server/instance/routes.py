"""`GET <base>/api/info` (§6.2): sem autenticação e sem versão no caminho."""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends

from .. import PROTOCOL_MAJOR, PROTOCOL_VERSION, __version__
from ..context import AppContext, get_ctx

router = APIRouter()


@router.get("/info")
async def info(ctx: AppContext = Depends(get_ctx)) -> Any:
    s = ctx.settings
    inst = await ctx.instance.get()
    links: dict[str, str] = {"download": s.download_url}
    if inst.signup_open:
        links["signup"] = f"{s.public_base_url}/signup"
    return {
        "name": inst.instance_name,
        "server_version": __version__,
        "base_url": s.public_base_url,
        "protocol": {"min": PROTOCOL_MAJOR, "max": PROTOCOL_MAJOR, "version": PROTOCOL_VERSION},
        "features": {
            "signupOpen": inst.signup_open,
            "captcha": {"provider": "turnstile", "siteKey": s.turnstile_site_key} if inst.captcha_active(s) else None,
            "landing": inst.landing_enabled,
            "gateway": False,
        },
        "links": links,
    }
