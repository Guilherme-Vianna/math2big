"""Painel administrativo: login, métricas, registros, exportação e configurações."""

from __future__ import annotations

import csv
import hashlib
import hmac
import io
import time
import uuid
from datetime import date, datetime
from decimal import Decimal
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from . import config, db, providers

router = APIRouter(prefix="/api/admin")
COOKIE = "m2b_admin"
TZ = "America/Sao_Paulo"


# ---------------------------------------------------------------- sessão
def _sign(exp: int) -> str:
    return hmac.new(config.ADMIN_SECRET.encode(), f"admin:{exp}".encode(), hashlib.sha256).hexdigest()


def _valid_token(token: str | None) -> bool:
    if not (token and config.ADMIN_PASSWORD):
        return False
    exp, _, sig = token.partition(".")
    return exp.isdigit() and int(exp) > time.time() and hmac.compare_digest(sig, _sign(int(exp)))


def require_admin(request: Request) -> None:
    if not config.ADMIN_PASSWORD:
        raise HTTPException(503, "Painel desativado: defina ADMIN_PASSWORD no servidor.")
    if not _valid_token(request.cookies.get(COOKIE)):
        raise HTTPException(401, "Faça login para continuar.")


def require_db() -> None:
    if not db.enabled():
        raise HTTPException(503, "Banco não configurado: defina DATABASE_URL no servidor.")


class Login(BaseModel):
    password: str


@router.post("/login")
def login(body: Login, request: Request, response: Response):
    if not config.ADMIN_PASSWORD:
        raise HTTPException(503, "Painel desativado: defina ADMIN_PASSWORD no servidor.")
    if not hmac.compare_digest(body.password.encode(), config.ADMIN_PASSWORD.encode()):
        time.sleep(0.8)  # freia tentativas por força bruta
        raise HTTPException(401, "Senha incorreta.")
    exp = int(time.time()) + config.ADMIN_SESSION_HOURS * 3600
    response.set_cookie(
        COOKIE, f"{exp}.{_sign(exp)}", max_age=config.ADMIN_SESSION_HOURS * 3600,
        httponly=True, samesite="strict", secure=request.url.scheme == "https"
        or request.headers.get("x-forwarded-proto") == "https", path="/api/admin",
    )
    return {"ok": True}


@router.post("/logout")
def logout(response: Response):
    response.delete_cookie(COOKIE, path="/api/admin")
    return {"ok": True}


@router.get("/me")
def me(request: Request):
    return {
        "configured": bool(config.ADMIN_PASSWORD),
        "authenticated": _valid_token(request.cookies.get(COOKIE)),
        "database": db.enabled(),
    }


guard = [Depends(require_admin), Depends(require_db)]


# ---------------------------------------------------------------- filtros
def _filters(days: int | None, model: str | None, status: str | None, q: str | None,
             client: str | None, edited: bool | None) -> tuple[str, list]:
    where, args = ["true"], []
    if days:
        where.append("r.created_at >= now() - make_interval(days => %s)")
        args.append(days)
    if model:
        where.append("r.model = %s")
        args.append(model)
    if status:
        where.append("r.status = %s")
        args.append(status)
    if client:
        where.append("r.client_id = %s")
        args.append(client)
    if edited is not None:
        where.append("r.edited_content is not null" if edited else "r.edited_content is null")
    if q:
        like = f"%{q.strip()}%"
        where.append("(r.content ilike %s or r.edited_content ilike %s or r.hint ilike %s "
                     "or r.error ilike %s or r.id::text ilike %s or r.client_id ilike %s)")
        args += [like] * 6
    return " and ".join(where), args


def _value(v: Any) -> Any:
    if isinstance(v, uuid.UUID):
        return str(v)
    if isinstance(v, (datetime, date)):
        return v.isoformat()
    if isinstance(v, Decimal):
        return float(v)
    return v


def _jsonable(row: dict) -> dict:
    return {k: _value(v) for k, v in row.items()}


# ---------------------------------------------------------------- métricas
@router.get("/stats", dependencies=guard)
def stats(days: int = Query(30, ge=1, le=3650)):
    span = "r.created_at >= now() - make_interval(days => %(days)s)"
    p = {"days": days, "tz": TZ}
    with db.connect() as conn:
        totals = conn.execute(f"""
            select count(*)                                             as requests,
                   count(*) filter (where status = 'ok')                as ok,
                   count(*) filter (where status = 'error')             as errors,
                   count(*) filter (where status = 'aborted')           as aborted,
                   coalesce(sum(input_tokens), 0)                       as input_tokens,
                   coalesce(sum(output_tokens), 0)                      as output_tokens,
                   coalesce(sum(thinking_tokens), 0)                    as thinking_tokens,
                   coalesce(sum(total_tokens), 0)                       as total_tokens,
                   round(avg(latency_ms) filter (where status = 'ok'))  as avg_latency_ms,
                   percentile_cont(0.5) within group (order by latency_ms) filter (where status = 'ok') as p50_latency_ms,
                   percentile_cont(0.95) within group (order by latency_ms) filter (where status = 'ok') as p95_latency_ms,
                   round(avg(first_token_ms) filter (where status = 'ok')) as avg_first_token_ms,
                   count(distinct client_id)                            as clients,
                   count(*) filter (where edited_content is not null)   as edited,
                   coalesce(sum(formula_count), 0)                      as formulas,
                   count(*) filter (where unsure_count > 0)             as with_unsure,
                   coalesce(sum(image_bytes), 0)                        as image_bytes
              from ocr_requests r where {span}""", p).fetchone()

        daily = conn.execute(f"""
            with d as (
              select generate_series(date_trunc('day', now() at time zone %(tz)s) - make_interval(days => %(days)s - 1),
                                     date_trunc('day', now() at time zone %(tz)s), interval '1 day')::date as day)
            select d.day,
                   count(r.id)                                   as requests,
                   count(r.id) filter (where r.status = 'ok')    as ok,
                   count(r.id) filter (where r.status <> 'ok')   as errors,
                   coalesce(sum(r.input_tokens), 0)              as input_tokens,
                   coalesce(sum(r.output_tokens + r.thinking_tokens), 0) as output_tokens
              from d left join ocr_requests r
                on (r.created_at at time zone %(tz)s)::date = d.day and {span}
             group by d.day order by d.day""", p).fetchall()

        models = conn.execute(f"""
            select model, provider,
                   count(*)                                             as requests,
                   count(*) filter (where status = 'ok')                as ok,
                   coalesce(sum(input_tokens), 0)                       as input_tokens,
                   coalesce(sum(output_tokens), 0)                      as output_tokens,
                   coalesce(sum(thinking_tokens), 0)                    as thinking_tokens,
                   round(avg(latency_ms) filter (where status = 'ok'))  as avg_latency_ms,
                   percentile_cont(0.95) within group (order by latency_ms) filter (where status = 'ok') as p95_latency_ms,
                   count(*) filter (where edited_content is not null)   as edited
              from ocr_requests r where {span}
             group by model, provider order by requests desc""", p).fetchall()

        errors = conn.execute(f"""
            select error, count(*) as n, max(created_at) as last
              from ocr_requests r where {span} and status = 'error'
             group by error order by n desc limit 8""", p).fetchall()

        events = conn.execute("""
            select kind, count(*) as n from usage_events
             where created_at >= now() - make_interval(days => %(days)s)
             group by kind order by n desc""", p).fetchall()

        sources = conn.execute(f"""
            select coalesce(source, 'desconhecido') as source, count(*) as n
              from ocr_requests r where {span} group by 1 order by n desc""", p).fetchall()

    return {
        "days": days,
        "totals": _jsonable(totals),
        "daily": [_jsonable(r) for r in daily],
        "models": [_jsonable(r) for r in models],
        "errors": [_jsonable(r) for r in errors],
        "events": events,
        "sources": sources,
    }


# ---------------------------------------------------------------- registros
LIST_COLUMNS = """r.id, r.created_at, r.model, r.provider, r.status, r.error, r.client_id,
    r.input_tokens, r.output_tokens, r.thinking_tokens, r.total_tokens, r.latency_ms,
    r.formula_count, r.unsure_count, r.image_bytes, r.image_width, r.image_height, r.source,
    r.edited_content is not null as edited,
    left(regexp_replace(coalesce(r.edited_content, r.content, r.error, ''), '\\s+', ' ', 'g'), 180) as snippet"""


@router.get("/requests", dependencies=guard)
def list_requests(
    days: int | None = Query(None, ge=1, le=3650), model: str | None = None, status: str | None = None,
    q: str | None = Query(None, max_length=200), client: str | None = None, edited: bool | None = None,
    limit: int = Query(50, ge=1, le=500), offset: int = Query(0, ge=0),
):
    where, args = _filters(days, model, status, q, client, edited)
    with db.connect() as conn:
        total = conn.execute(f"select count(*) as n from ocr_requests r where {where}", args).fetchone()["n"]
        rows = conn.execute(
            f"select {LIST_COLUMNS} from ocr_requests r where {where} "
            "order by r.created_at desc limit %s offset %s", [*args, limit, offset],
        ).fetchall()
        models = [r["model"] for r in conn.execute("select distinct model from ocr_requests order by 1")]
    return {"total": total, "items": [_jsonable(r) for r in rows], "models": models}


def _uuid(value: str) -> str:
    try:
        return str(uuid.UUID(value))
    except ValueError:
        raise HTTPException(404, "Registro não encontrado.")


@router.get("/requests/{request_id}", dependencies=guard)
def get_request(request_id: str):
    rid = _uuid(request_id)
    with db.connect() as conn:
        row = conn.execute("select * from ocr_requests where id = %s", (rid,)).fetchone()
        if not row:
            raise HTTPException(404, "Registro não encontrado.")
        events = conn.execute(
            "select kind, created_at, detail from usage_events where request_id = %s order by created_at",
            (rid,)).fetchall()
        client = None
        if row["client_id"]:
            client = conn.execute(
                "select count(*) as requests, min(created_at) as first_seen, max(created_at) as last_seen, "
                "coalesce(sum(total_tokens), 0) as tokens from ocr_requests where client_id = %s",
                (row["client_id"],)).fetchone()
    return {"item": _jsonable(row), "events": [_jsonable(e) for e in events],
            "client": _jsonable(client) if client else None}


@router.delete("/requests/{request_id}", dependencies=guard)
def delete_request(request_id: str):
    with db.connect() as conn:
        n = conn.execute("delete from ocr_requests where id = %s", (_uuid(request_id),)).rowcount
    return {"deleted": n}


class Purge(BaseModel):
    older_than_days: int
    content_only: bool = False


@router.post("/purge", dependencies=guard)
def purge(body: Purge):
    """Apaga registros antigos (ou só o texto deles, mantendo as métricas)."""
    if body.older_than_days < 0:
        raise HTTPException(400, "Informe um número de dias ≥ 0.")
    with db.connect() as conn:
        if body.content_only:
            n = conn.execute(
                "update ocr_requests set content = null, latex = null, edited_content = null, hint = null "
                "where created_at < now() - make_interval(days => %s) and "
                "(content is not null or edited_content is not null or hint is not null)",
                (body.older_than_days,)).rowcount
        else:
            n = conn.execute("delete from ocr_requests where created_at < now() - make_interval(days => %s)",
                             (body.older_than_days,)).rowcount
            conn.execute("delete from usage_events where created_at < now() - make_interval(days => %s)",
                         (body.older_than_days,))
    return {"affected": n}


EXPORT_COLUMNS = [
    "id", "created_at", "client_id", "provider", "model", "status", "error", "http_status", "source",
    "media_type", "image_bytes", "image_width", "image_height", "batch_size", "input_tokens", "output_tokens",
    "thinking_tokens", "total_tokens", "latency_ms", "first_token_ms", "formula_count", "unsure_count",
    "char_count", "finish_reason", "hint", "content", "latex", "edited_content", "edited_at",
]


@router.get("/export.csv", dependencies=guard)
def export_csv(
    days: int | None = Query(None, ge=1, le=3650), model: str | None = None, status: str | None = None,
    q: str | None = Query(None, max_length=200), client: str | None = None, edited: bool | None = None,
):
    where, args = _filters(days, model, status, q, client, edited)
    cols = ", ".join(f"r.{c}" for c in EXPORT_COLUMNS)

    def gen():
        buf = io.StringIO()
        w = csv.writer(buf)
        buf.write("﻿")  # BOM para o Excel abrir em UTF-8
        w.writerow(EXPORT_COLUMNS)
        with db.connect() as conn:
            cur = conn.execute(f"select {cols} from ocr_requests r where {where} order by r.created_at desc", args)
            for row in cur:
                w.writerow(["" if row[c] is None else row[c] for c in EXPORT_COLUMNS])
                if buf.tell() > 64_000:
                    yield buf.getvalue()
                    buf.seek(0)
                    buf.truncate()
        yield buf.getvalue()

    name = f"math2big-{datetime.now():%Y%m%d-%H%M}.csv"
    return StreamingResponse(gen(), media_type="text/csv; charset=utf-8",
                             headers={"Content-Disposition": f'attachment; filename="{name}"'})


# ---------------------------------------------------------------- configurações
@router.get("/settings", dependencies=guard)
def get_settings():
    return {"settings": db.get_settings(fresh=True), "models": providers.available_models()}


class SettingsBody(BaseModel):
    logging_enabled: bool | None = None
    store_content: bool | None = None
    default_model: str | None = None
    disabled_models: list[str] | None = None
    maintenance_message: str | None = None


@router.put("/settings", dependencies=guard)
def put_settings(body: SettingsBody):
    changes: dict[str, Any] = body.model_dump(exclude_unset=True)
    if "maintenance_message" in changes:
        changes["maintenance_message"] = (changes["maintenance_message"] or "").strip()[:300]
    if "default_model" in changes and not changes["default_model"]:
        changes["default_model"] = None
    return {"settings": db.save_settings(changes)}
