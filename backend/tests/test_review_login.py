"""Conta de revisão (REVIEW_LOGIN_EMAIL/CODE): código fixo no cadastro e no login, sem e-mail, mesmos limites."""

from __future__ import annotations

import pytest
from conftest import rand_ip
from pydantic import ValidationError

from clearchat_server.config import Settings

REVIEW = "revisao@example.com"
CODE = "482913"


def ipk() -> dict[str, str]:
    return {"X-Real-IP": rand_ip()}


async def _review_srv(make_server):  # type: ignore[no-untyped-def]
    return await make_server(review_login_email="  Revisao@Example.com ", review_login_code=CODE)


async def _signup(srv, ip: dict[str, str]) -> dict:  # type: ignore[no-untyped-def]
    r = await srv.http.post("/api/v1/auth/signup/start", json={"email": REVIEW, "name": "Revisão"}, headers=ip)
    assert r.status_code == 202, r.text
    r = await srv.http.post(
        "/api/v1/auth/signup/verify", json={"email": REVIEW, "code": CODE, "device": srv.device("mobile")}, headers=ip
    )
    assert r.status_code == 201, r.text
    return r.json()


async def _request_login(srv, ip: dict[str, str]) -> None:  # type: ignore[no-untyped-def]
    r = await srv.http.post("/api/v1/auth/code/request", json={"email": REVIEW}, headers=ip)
    assert r.status_code == 202, r.text


async def _verify(srv, code: str, ip: dict[str, str]):  # type: ignore[no-untyped-def]
    return await srv.http.post(
        "/api/v1/auth/code/verify", json={"email": REVIEW, "code": code, "device": srv.device("mobile")}, headers=ip
    )


async def test_review_signup_and_login_use_fixed_code_without_mail(make_server):
    srv = await _review_srv(make_server)
    ip = ipk()
    await _signup(srv, ip)
    await _request_login(srv, ip)
    r = await _verify(srv, CODE, ip)
    assert r.status_code == 200, r.text
    await srv.flush_mail()
    assert srv.mails(REVIEW) == []


async def test_review_code_is_single_use_per_request(make_server):
    srv = await _review_srv(make_server)
    ip = ipk()
    await _signup(srv, ip)
    # sem pedir código: não há código vivo, o fixo não vale sozinho
    assert (await _verify(srv, CODE, ip)).status_code == 400
    await _request_login(srv, ip)
    assert (await _verify(srv, CODE, ip)).status_code == 200
    assert (await _verify(srv, CODE, ip)).status_code == 400  # já consumido


async def test_review_code_keeps_attempt_limit(make_server):
    srv = await _review_srv(make_server)
    ip = ipk()
    await _signup(srv, ip)
    await _request_login(srv, ip)
    for _ in range(5):
        assert (await _verify(srv, "000000", ipk())).status_code == 400
    # 5 erros esgotam o código vivo: nem o certo passa até pedir outro
    assert (await _verify(srv, CODE, ipk())).status_code == 400
    await _request_login(srv, ipk())
    assert (await _verify(srv, CODE, ipk())).status_code == 200


async def test_review_reauth_and_other_emails_stay_random(make_server):
    srv = await _review_srv(make_server)
    b = await _signup(srv, ipk())
    h = {"Authorization": f"Bearer {b['access_token']}"}
    r = await srv.http.post("/api/v1/auth/reauth/request", json={"purpose": "delete_account"}, headers=h)
    assert r.status_code == 202, r.text
    await srv.flush_mail()
    # reauth (apagar conta) continua por e-mail com código aleatório
    assert [m.kind for m in srv.mails(REVIEW)] == ["code:delete_account"]
    # outro e-mail: código aleatório por e-mail, como sempre
    other = await srv.signup("ana@example.com")
    assert other.email == "ana@example.com"
    assert srv.last_code("ana@example.com", "signup")


async def test_review_off_by_default(srv):
    s = await srv.signup(REVIEW)  # sem as variáveis: fluxo normal, código por e-mail
    assert s.email == REVIEW


def test_review_code_must_be_six_digits() -> None:
    with pytest.raises(ValidationError):
        Settings(review_login_code="12345")
    with pytest.raises(ValidationError):
        Settings(review_login_code="abcdef")
    assert Settings(review_login_code=" 123456 ").review_login_code == "123456"
