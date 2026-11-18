"""Rotas públicas: modelos, OCR (streaming e direto), edições e eventos de uso."""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import time
import uuid
from typing import Iterator, Literal

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from . import config, db, providers, textutil
from .providers import ProviderError, Usage

router = APIRouter(prefix="/api")

EVENT_KINDS = {
    "copy_all", "copy_formula", "copy_inline", "copy_word", "copy_word_formula",
    "export_md", "export_tex", "export_word", "download_tex", "download_md",
    "edit_restore", "rotate", "crop", "rerun", "remove_page", "history_open", "model_change",
}


class OcrRequest(BaseModel):
    image: str                       # base64 (sem prefixo data:)
    media_type: str = "image/png"
    model: str | None = None
    hint: str | None = None
    # Metadados opcionais enviados pela interface
    client_id: str | None = Field(None, max_length=64)
    width: int | None = None
    height: int | None = None
    batch_size: int | None = None
    source: str | None = Field(None, max_length=24)


class OcrResponse(BaseModel):
    id: str | None
    content: str
    model: str
    input_tokens: int
    output_tokens: int
    thinking_tokens: int = 0


class EditRequest(BaseModel):
    client_id: str | None = Field(None, max_length=64)
    content: str = Field(..., max_length=200_000)


class EventRequest(BaseModel):
    kind: str = Field(..., max_length=32)
    client_id: str | None = Field(None, max_length=64)
    request_id: str | None = None
    detail: dict | None = None


def _line(obj: dict) -> bytes:
    return (json.dumps(obj, ensure_ascii=False) + "\n").encode("utf-8")


def _ip_hash(request: Request) -> str | None:
    ip = (request.headers.get("x-forwarded-for") or "").split(",")[0].strip()
    ip = ip or (request.client.host if request.client else "")
    if not ip:
        return None
    return hmac.new((config.ADMIN_SECRET or "math2big").encode(), ip.encode(), hashlib.sha256).hexdigest()[:16]


def _valid_uuid(value: str | None) -> str | None:
    try:
        return str(uuid.UUID(value)) if value else None
    except ValueError:
        return None


# ---------------------------------------------------------------- modelos
@router.get("/models")
def list_models():
    settings = db.get_settings()
    disabled = set(settings.get("disabled_models") or [])
    models = [m for m in providers.available_models() if m["id"] not in disabled]
    ids = [m["id"] for m in models]
    default = settings.get("default_model") or config.DEFAULT_MODEL
    if default not in ids:
        default = ids[0] if ids else None
    return {"default": default, "models": models, "notice": settings.get("maintenance_message") or None}


# ---------------------------------------------------------------- OCR
class Job:
    """Uma conversão: valida a entrada, chama o provedor e registra o resultado."""

    def __init__(self, req: OcrRequest, request: Request):
        settings = db.get_settings()
        if settings.get("maintenance_message"):
            raise HTTPException(503, settings["maintenance_message"])
        if not (config.GEMINI_KEY or config.ANTHROPIC_KEY):
            raise HTTPException(401, "Nenhuma chave configurada: defina GEMINI_API_KEY e reinicie o servidor.")
        if req.media_type not in config.ALLOWED_MEDIA:
            raise HTTPException(400, "Formato de imagem não suportado (use PNG, JPEG, WEBP ou GIF).")
        try:
            self.image = base64.b64decode(req.image, validate=True)
        except Exception:
            raise HTTPException(400, "Imagem inválida.")

        self.model = req.model or list_models()["default"]
        if not self.model:
            raise HTTPException(400, "Nenhum modelo disponível.")
        if self.model in (settings.get("disabled_models") or []):
            raise HTTPException(400, "Este modelo foi desativado pelo administrador.")
        try:
            providers.check_model(self.model)
        except ProviderError as e:
            raise HTTPException(e.status, e.message)

        hint = (req.hint or "").strip()[: config.MAX_HINT] or None
        self.instruction = "Transcreva a matemática desta imagem."
        if hint:
            self.instruction += f"\nContexto fornecido pelo usuário: {hint}"

        self.req = req
        self.settings = settings
        self.id = str(uuid.uuid4())
        self.usage = Usage()
        self.meta = {
            "id": self.id,
            "client_id": req.client_id,
            "ip_hash": _ip_hash(request),
            "user_agent": (request.headers.get("user-agent") or "")[:300] or None,
            "provider": providers.provider_of(self.model),
            "model": self.model,
            "media_type": req.media_type,
            "image_bytes": len(self.image),
            "image_width": req.width,
            "image_height": req.height,
            "image_sha256": hashlib.sha256(self.image).hexdigest(),
            "hint": hint,
            "batch_size": req.batch_size,
            "source": req.source,
        }

    def run(self) -> Iterator[str]:
        """Repassa os pedaços de texto; ao final (ou em erro/abandono) grava o registro."""
        started = time.perf_counter()
        first_ms = None
        parts: list[str] = []
        status, error = "aborted", None
        try:
            for delta in providers.stream(self.model, self.image, self.req.media_type, self.instruction, self.usage):
                if first_ms is None:
                    first_ms = int((time.perf_counter() - started) * 1000)
                parts.append(delta)
                yield delta
            status = "ok"
        except ProviderError as e:
            status, error = "error", e
            raise
        finally:
            self.text = textutil.clean("".join(parts))
            self._record(status, error, int((time.perf_counter() - started) * 1000), first_ms)

    def _record(self, status: str, error: ProviderError | None, latency_ms: int, first_ms: int | None) -> None:
        if not self.settings.get("logging_enabled", True):
            self.id = None
            return
        row = dict(self.meta)
        row.update(
            status=status,
            error=error.message if error else None,
            http_status=error.status if error else 200 if status == "ok" else None,
            input_tokens=self.usage.input_tokens,
            output_tokens=self.usage.output_tokens,
            thinking_tokens=self.usage.thinking_tokens,
            finish_reason=self.usage.finish_reason,
            thinking_used=self.usage.thinking_used,
            latency_ms=latency_ms,
            first_token_ms=first_ms,
        )
        stats = textutil.analyse(self.text)
        row.update(formula_count=stats["formula_count"], unsure_count=stats["unsure_count"],
                   char_count=stats["char_count"])
        if self.settings.get("store_content", True):
            row.update(content=self.text or None, latex=stats["latex"] or None)
        else:
            row.update(hint=None)
        if db.insert_request(row) is None:
            self.id = None

    def done(self) -> dict:
        return {
            "id": self.id,
            "model": self.model,
            "input_tokens": self.usage.input_tokens,
            "output_tokens": self.usage.output_tokens,
            "thinking_tokens": self.usage.thinking_tokens,
        }


@router.post("/ocr/stream")
def ocr_stream(req: OcrRequest, request: Request):
    """Devolve o texto aos poucos (NDJSON): {"delta"} ... e por fim {"done"} ou {"error"}."""
    job = Job(req, request)

    def gen():
        try:
            for delta in job.run():
                yield _line({"delta": delta})
        except ProviderError as e:
            yield _line({"error": e.message, "status": e.status, "id": job.id})
            return
        yield _line({"done": True, **job.done()})

    return StreamingResponse(
        gen(),
        media_type="application/x-ndjson",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@router.post("/ocr", response_model=OcrResponse)
def ocr(req: OcrRequest, request: Request):
    job = Job(req, request)
    try:
        for _ in job.run():
            pass
    except ProviderError as e:
        raise HTTPException(e.status, e.message)
    return OcrResponse(content=job.text, **job.done())


# ---------------------------------------------------------------- uso
@router.patch("/ocr/{request_id}")
def save_edit(request_id: str, body: EditRequest):
    """Guarda a versão editada pelo usuário (só o mesmo cliente que converteu)."""
    rid = _valid_uuid(request_id)
    if not rid:
        raise HTTPException(404, "Registro não encontrado.")
    if not db.get_settings().get("store_content", True):
        return {"saved": False}
    return {"saved": bool(db.save_edit(rid, body.client_id, body.content))}


@router.post("/events", status_code=204)
def track_event(body: EventRequest):
    if body.kind in EVENT_KINDS and db.get_settings().get("logging_enabled", True):
        detail = body.detail if body.detail and len(json.dumps(body.detail)) < 2000 else None
        db.insert_event(body.kind, body.client_id, _valid_uuid(body.request_id), detail)
