"""Blobs cifrados (CCB1, §3.11 e §14): armazenamento em disco + rotas.

O servidor nunca decifra: confere só o tamanho, o SHA-256 do ciphertext (`X-Content-SHA256`) e a
moldura (magic "CCB1", chunk_log2 10..24, tamanhos de chunk coerentes)."""

from __future__ import annotations

import contextlib
import hashlib
import os
import shutil
import uuid
from pathlib import Path
from typing import Any

from fastapi import APIRouter, Depends, Request, Response
from fastapi.responses import FileResponse
from pydantic import BaseModel
from starlette.requests import ClientDisconnect

from ..auth.deps import current_principal
from ..auth.tokens import Principal
from ..config import Settings
from ..context import AppContext, get_ctx
from ..db import execute, fetchall, fetchone
from ..errors import ApiError
from ..util import BLOB_ID_RE, HEX64_RE

HEADER_LEN = 21
TAG_LEN = 16
MAGIC = b"CCB1"


def check_framing(header: bytes, total_len: int) -> str | None:
    """Valida a moldura CCB1 sem decifrar. Devolve o motivo da falha ou None se ok."""
    if total_len < HEADER_LEN + TAG_LEN or len(header) < HEADER_LEN:
        return "too_short"
    if header[:4] != MAGIC:
        return "bad_magic"
    log2 = header[4]
    if not 10 <= log2 <= 24:
        return "bad_chunk_size"
    full = (1 << log2) + TAG_LEN
    ct_len = total_len - HEADER_LEN
    n = max(1, -(-ct_len // full))
    last = ct_len - (n - 1) * full
    if last < TAG_LEN or last > full:
        return "bad_chunk_layout"
    return None


class BlobStore:
    def __init__(self, settings: Settings) -> None:
        self.root = Path(settings.blob_storage_dir)

    def user_dir(self, user_id: uuid.UUID | str) -> Path:
        return self.root / str(uuid.UUID(str(user_id)))

    def path(self, user_id: uuid.UUID | str, blob_id: str) -> Path:
        if not BLOB_ID_RE.match(blob_id):
            raise ValueError("blob_id inválido")
        return self.user_dir(user_id) / blob_id[:2] / blob_id

    def remove(self, user_id: uuid.UUID | str, blob_id: str) -> None:
        with contextlib.suppress(FileNotFoundError):
            self.path(user_id, blob_id).unlink()

    def remove_user(self, user_id: uuid.UUID | str) -> None:
        shutil.rmtree(self.user_dir(user_id), ignore_errors=True)


def _fsync_dir(d: Path) -> None:
    try:
        fd = os.open(d, os.O_RDONLY)
    except OSError:
        return
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


router = APIRouter()


class CheckBody(BaseModel):
    ids: list[str]


@router.post("/blobs/check")
async def blobs_check(
    body: CheckBody, p: Principal = Depends(current_principal), ctx: AppContext = Depends(get_ctx)
) -> Any:
    if len(body.ids) > 1000 or any(not BLOB_ID_RE.match(i) for i in body.ids):
        raise ApiError("invalid_request", details={"field": "ids"})
    ids = list(dict.fromkeys(body.ids))
    async with ctx.engine.connect() as conn:
        rows = await fetchall(
            conn,
            "SELECT blob_id FROM blobs WHERE user_id = :u AND blob_id = ANY(CAST(:ids AS text[]))",
            {"u": p.user_id, "ids": ids},
        )
    present = {r.blob_id for r in rows}
    return {"present": [i for i in ids if i in present], "missing": [i for i in ids if i not in present]}


@router.put("/blobs/{blob_id}")
async def blob_put(
    blob_id: str, request: Request, p: Principal = Depends(current_principal), ctx: AppContext = Depends(get_ctx)
) -> Response:
    if not BLOB_ID_RE.match(blob_id):
        raise ApiError("invalid_request", details={"field": "blob_id"})
    sha_hdr = request.headers.get("x-content-sha256", "")
    if not HEX64_RE.match(sha_hdr):
        raise ApiError("invalid_request", details={"field": "X-Content-SHA256"})
    expected_sha = bytes.fromhex(sha_hdr)
    settings = ctx.settings
    store = ctx.blobs

    async with ctx.engine.connect() as conn:
        user = await fetchone(
            conn,
            "SELECT u.quota_blob_bytes, u.usage_blob_bytes, "
            "EXISTS (SELECT 1 FROM blobs b WHERE b.user_id = u.id AND b.blob_id = :b) AS present "
            "FROM users u WHERE u.id = :u",
            {"u": p.user_id, "b": blob_id},
        )
    assert user is not None
    if user.present:
        return _json(200, {"blob_id": blob_id, "created": False})

    clen_hdr = request.headers.get("content-length")
    if clen_hdr is not None:
        try:
            clen = int(clen_hdr)
        except ValueError as e:
            raise ApiError("invalid_request") from e
        if clen > settings.blob_max_bytes:
            raise ApiError("payload_too_large", details={"limit": settings.blob_max_bytes})
        _check_quota(user.quota_blob_bytes, int(user.usage_blob_bytes), clen)

    final = store.path(p.user_id, blob_id)
    final.parent.mkdir(parents=True, exist_ok=True)
    tmp = final.with_name(f"{blob_id}.tmp-{uuid.uuid4().hex}")
    h = hashlib.sha256()
    size = 0
    header = b""
    try:
        try:
            with tmp.open("wb") as f:
                async for chunk in request.stream():
                    if not chunk:
                        continue
                    size += len(chunk)
                    if size > settings.blob_max_bytes:
                        raise ApiError("payload_too_large", details={"limit": settings.blob_max_bytes})
                    if len(header) < HEADER_LEN:
                        header += chunk[: HEADER_LEN - len(header)]
                    h.update(chunk)
                    f.write(chunk)
                f.flush()
                os.fsync(f.fileno())
        except ClientDisconnect as e:
            raise ApiError("invalid_request", details={"reason": "incomplete_upload"}) from e
        if clen_hdr is not None and size != int(clen_hdr):
            raise ApiError("invalid_request", details={"reason": "incomplete_upload"})
        if h.digest() != expected_sha:
            raise ApiError("invalid_request", details={"reason": "sha256_mismatch"})
        reason = check_framing(header, size)
        if reason:
            raise ApiError("invalid_request", details={"reason": "bad_framing", "framing": reason})

        async with ctx.engine.begin() as conn:
            u = await fetchone(
                conn, "SELECT quota_blob_bytes, usage_blob_bytes FROM users WHERE id = :u FOR UPDATE", {"u": p.user_id}
            )
            assert u is not None
            exists = await fetchone(
                conn, "SELECT 1 FROM blobs WHERE user_id = :u AND blob_id = :b", {"u": p.user_id, "b": blob_id}
            )
            if exists is not None:
                return _json(200, {"blob_id": blob_id, "created": False})
            _check_quota(u.quota_blob_bytes, int(u.usage_blob_bytes), size)
            await execute(
                conn,
                "INSERT INTO blobs (user_id, blob_id, size, sha256_ct, unreferenced_since) "
                "VALUES (:u, :b, :s, :h, CASE WHEN EXISTS (SELECT 1 FROM record_blobs rb "
                "WHERE rb.user_id = :u AND rb.blob_id = :b) THEN NULL ELSE now() END)",
                {"u": p.user_id, "b": blob_id, "s": size, "h": expected_sha},
            )
            await execute(
                conn,
                "UPDATE users SET usage_blob_bytes = usage_blob_bytes + :s, usage_blobs = usage_blobs + 1 WHERE id = :u",
                {"u": p.user_id, "s": size},
            )
            await execute(
                conn,
                "INSERT INTO usage_daily (user_id, day, blob_uploads, blob_bytes) VALUES (:u, current_date, 1, :s) "
                "ON CONFLICT (user_id, day) DO UPDATE SET blob_uploads = usage_daily.blob_uploads + 1, "
                "blob_bytes = usage_daily.blob_bytes + EXCLUDED.blob_bytes",
                {"u": p.user_id, "s": size},
            )
            os.replace(tmp, final)
            _fsync_dir(final.parent)
        return _json(201, {"blob_id": blob_id, "created": True})
    except BaseException:
        # se o commit falhar depois do rename, o arquivo não pode ficar sem linha
        if final.exists() and not await _row_exists(ctx, p.user_id, blob_id):
            with contextlib.suppress(FileNotFoundError):
                final.unlink()
        raise
    finally:
        with contextlib.suppress(FileNotFoundError):
            tmp.unlink()


async def _row_exists(ctx: AppContext, user_id: uuid.UUID, blob_id: str) -> bool:
    try:
        async with ctx.engine.connect() as conn:
            r = await fetchone(
                conn, "SELECT 1 FROM blobs WHERE user_id = :u AND blob_id = :b", {"u": user_id, "b": blob_id}
            )
        return r is not None
    except Exception:
        return True  # na dúvida, não apaga


def _check_quota(limit: int | None, used: int, add: int) -> None:
    if limit is not None and used + add > int(limit):
        raise ApiError("quota_exceeded", details={"kind": "blob_bytes", "used": used, "limit": int(limit)})


def _json(status: int, body: dict[str, Any]) -> Response:
    from fastapi.responses import JSONResponse

    return JSONResponse(body, status_code=status)


@router.get("/blobs/{blob_id}")
async def blob_get(
    blob_id: str, p: Principal = Depends(current_principal), ctx: AppContext = Depends(get_ctx)
) -> Response:
    if not BLOB_ID_RE.match(blob_id):
        raise ApiError("not_found")
    async with ctx.engine.connect() as conn:
        row = await fetchone(
            conn,
            "SELECT size, sha256_ct FROM blobs WHERE user_id = :u AND blob_id = :b",
            {"u": p.user_id, "b": blob_id},
        )
    path = ctx.blobs.path(p.user_id, blob_id)
    if row is None or not path.exists():
        raise ApiError("not_found")
    return FileResponse(
        path,
        media_type="application/octet-stream",
        headers={"X-Content-SHA256": bytes(row.sha256_ct).hex(), "Cache-Control": "private, no-store"},
    )
