"""Persistência em Postgres (Neon): conversões, eventos de uso e configurações.

Tudo aqui é tolerante a falhas: se o banco não estiver configurado ou cair,
o OCR continua funcionando — só deixa de registrar.
"""

from __future__ import annotations

import atexit
import logging
import threading
import time
from contextlib import contextmanager
from typing import Any, Iterator

from . import config

log = logging.getLogger("math2big.db")

SCHEMA = """
create table if not exists ocr_requests (
    id               uuid primary key,
    created_at       timestamptz not null default now(),
    client_id        text,
    ip_hash          text,
    user_agent       text,
    provider         text,
    model            text not null,
    status           text not null,              -- ok | error | aborted
    error            text,
    http_status      int,
    media_type       text,
    image_bytes      int,
    image_width      int,
    image_height     int,
    image_sha256     text,
    hint             text,
    content          text,                       -- Markdown + LaTeX devolvido
    latex            text,                       -- só as fórmulas
    edited_content   text,                       -- versão editada pelo usuário
    edited_at        timestamptz,
    input_tokens     int not null default 0,
    output_tokens    int not null default 0,
    thinking_tokens  int not null default 0,
    total_tokens     int generated always as (input_tokens + output_tokens + thinking_tokens) stored,
    latency_ms       int,
    first_token_ms   int,
    formula_count    int,
    unsure_count     int,
    char_count       int,
    finish_reason    text,
    thinking_used    boolean,
    batch_size       int,
    source           text                        -- upload | camera | paste | example | rerun | crop | rotate
);
create index if not exists ocr_requests_created_idx on ocr_requests (created_at desc);
create index if not exists ocr_requests_model_idx on ocr_requests (model);
create index if not exists ocr_requests_client_idx on ocr_requests (client_id);

create table if not exists usage_events (
    id          bigserial primary key,
    created_at  timestamptz not null default now(),
    request_id  uuid references ocr_requests(id) on delete cascade,
    client_id   text,
    kind        text not null,
    detail      jsonb
);
create index if not exists usage_events_created_idx on usage_events (created_at desc);
create index if not exists usage_events_request_idx on usage_events (request_id);

create table if not exists app_settings (
    key         text primary key,
    value       jsonb not null,
    updated_at  timestamptz not null default now()
);
"""

DEFAULT_SETTINGS: dict[str, Any] = {
    "logging_enabled": True,     # registra as conversões no banco
    "store_content": True,       # guarda o texto/LaTeX (desligue por privacidade)
    "default_model": None,       # modelo padrão da interface (None = automático)
    "disabled_models": [],       # modelos escondidos da interface e bloqueados na API
    "maintenance_message": "",   # se preenchido, o OCR fica pausado com esta mensagem
}

_pool = None
_pool_lock = threading.Lock()
_schema_ready = False


def enabled() -> bool:
    return bool(config.DATABASE_URL)


def _get_pool():
    global _pool, _schema_ready
    if _pool is None:
        with _pool_lock:
            if _pool is None:
                from psycopg_pool import ConnectionPool

                _pool = ConnectionPool(
                    config.DATABASE_URL,
                    min_size=0,
                    max_size=4,
                    max_idle=60,
                    timeout=8,
                    # O pooler do Neon (PgBouncer) não combina com prepared statements.
                    kwargs={"prepare_threshold": None, "autocommit": True, "connect_timeout": 8},
                    check=ConnectionPool.check_connection,
                    open=True,
                )
                atexit.register(_pool.close)
    if not _schema_ready:
        with _pool_lock:
            if not _schema_ready:
                with _pool.connection() as conn:
                    conn.execute(SCHEMA)
                _schema_ready = True
    return _pool


@contextmanager
def connect() -> Iterator[Any]:
    from psycopg.rows import dict_row

    with _get_pool().connection() as conn:
        conn.row_factory = dict_row
        yield conn


def safe(fn):
    """Decora gravações em segundo plano: loga a falha e segue a vida."""
    def wrapper(*a, **kw):
        if not enabled():
            return None
        try:
            return fn(*a, **kw)
        except Exception:  # noqa: BLE001
            log.exception("falha no banco em %s", fn.__name__)
            return None
    wrapper.__name__ = fn.__name__
    return wrapper


# ---------------------------------------------------------------- configurações
_settings_cache: tuple[float, dict] | None = None
SETTINGS_TTL = 20.0


def get_settings(fresh: bool = False) -> dict:
    global _settings_cache
    if not enabled():
        return dict(DEFAULT_SETTINGS)
    now = time.monotonic()
    if not fresh and _settings_cache and now - _settings_cache[0] < SETTINGS_TTL:
        return dict(_settings_cache[1])
    settings = dict(DEFAULT_SETTINGS)
    try:
        with connect() as conn:
            for row in conn.execute("select key, value from app_settings"):
                if row["key"] in settings:
                    settings[row["key"]] = row["value"]
    except Exception:  # noqa: BLE001
        log.exception("não consegui ler as configurações")
        if _settings_cache:
            return dict(_settings_cache[1])
    _settings_cache = (now, settings)
    return dict(settings)


def save_settings(changes: dict) -> dict:
    global _settings_cache
    from psycopg.types.json import Jsonb

    with connect() as conn:
        for key, value in changes.items():
            if key not in DEFAULT_SETTINGS:
                continue
            conn.execute(
                "insert into app_settings (key, value, updated_at) values (%s, %s, now()) "
                "on conflict (key) do update set value = excluded.value, updated_at = now()",
                (key, Jsonb(value)),
            )
    _settings_cache = None
    return get_settings(fresh=True)


# ---------------------------------------------------------------- gravações
REQUEST_COLUMNS = (
    "id", "client_id", "ip_hash", "user_agent", "provider", "model", "status", "error", "http_status",
    "media_type", "image_bytes", "image_width", "image_height", "image_sha256", "hint", "content", "latex",
    "input_tokens", "output_tokens", "thinking_tokens", "latency_ms", "first_token_ms", "formula_count",
    "unsure_count", "char_count", "finish_reason", "thinking_used", "batch_size", "source",
)


@safe
def insert_request(row: dict) -> str | None:
    cols = [c for c in REQUEST_COLUMNS if c in row]
    sql = (f"insert into ocr_requests ({', '.join(cols)}) values ({', '.join(['%s'] * len(cols))}) "
           "on conflict (id) do nothing")
    with connect() as conn:
        conn.execute(sql, [row[c] for c in cols])
    return row["id"]


@safe
def save_edit(request_id: str, client_id: str | None, content: str) -> bool:
    with connect() as conn:
        cur = conn.execute(
            "update ocr_requests set edited_content = %s, edited_at = now() "
            "where id = %s and client_id is not distinct from %s",
            (content, request_id, client_id),
        )
        return cur.rowcount > 0


@safe
def insert_event(kind: str, client_id: str | None, request_id: str | None, detail: dict | None) -> None:
    from psycopg.types.json import Jsonb

    with connect() as conn:
        # Só liga ao pedido se ele existir e for do mesmo cliente.
        if request_id:
            ok = conn.execute(
                "select 1 from ocr_requests where id = %s and client_id is not distinct from %s",
                (request_id, client_id),
            ).fetchone()
            if not ok:
                request_id = None
        conn.execute(
            "insert into usage_events (kind, client_id, request_id, detail) values (%s, %s, %s, %s)",
            (kind, client_id, request_id, Jsonb(detail) if detail else None),
        )
