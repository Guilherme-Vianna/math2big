"""math2big — OCR de matemática (imagem -> LaTeX).

Provedores suportados (usa o que tiver chave configurada):
  - Google Gemini   -> GEMINI_API_KEY (ou GOOGLE_API_KEY)
  - Anthropic Claude -> ANTHROPIC_API_KEY (opcional)
"""

from __future__ import annotations

import base64
import os
import re
from functools import lru_cache
from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

ROOT = Path(__file__).parent
STATIC = ROOT / "public"  # na Vercel, servido direto pela CDN

# Carrega variáveis do arquivo .env (se existir) sem sobrescrever as do sistema.
_env = ROOT / ".env"
if _env.exists():
    for _line in _env.read_text(encoding="utf-8").splitlines():
        _k, _sep, _v = _line.strip().partition("=")
        if _sep and _k and not _k.startswith("#"):
            os.environ.setdefault(_k.strip(), _v.strip().strip('"').strip("'"))
ALLOWED_MEDIA = {"image/png", "image/jpeg", "image/webp", "image/gif"}

SYSTEM_PROMPT = r"""You are a meticulous OCR engine specialised in mathematics (printed or handwritten).
Transcribe EXACTLY what is in the image — do not solve, simplify, correct, reorder or complete anything.

Output format (Markdown + LaTeX), nothing else:
- Every formula, equation or expression goes in display math: $$ ... $$ on its own line.
- Math that sits inside a sentence of prose on the same line (e.g. "Seja $f(x)=...$. Mostre que:") MUST stay inline with single dollars $ ... $ — never break a sentence with $$.
- Prose (statements, "seja", "prove que", item labels like "a)", "1.") stays as plain text, in its original language.
- Multi-line derivations/systems: use \begin{aligned} ... \end{aligned} (align on = when the image does), cases, or matrices (pmatrix, bmatrix, vmatrix) as appropriate.
- Use standard LaTeX that KaTeX can render: \frac, \sqrt[n]{}, \int_a^b, \sum, \prod, \lim_{x \to 0}, \partial, \nabla, \mathbb{R}, \mathcal{}, \vec{}, \hat{}, \overline{}, \binom, \left( \right), \operatorname{}, etc.
- Preserve the original variable names, subscripts, superscripts, primes, and spacing intent.
- If a symbol is illegible, give your best reading followed by \text{[?]}.
- Never wrap the answer in code fences and never add explanations or commentary.
- If the image contains no mathematics or text, output exactly: (sem conteúdo matemático)"""

GEMINI_KEY = os.environ.get("GEMINI_API_KEY") or os.environ.get("GOOGLE_API_KEY")
ANTHROPIC_KEY = os.environ.get("ANTHROPIC_API_KEY")

# Usado se não for possível listar os modelos da sua conta.
GEMINI_FALLBACK_MODELS = ["gemini-3.8-flash", "gemini-3.5-flash-lite"]
CLAUDE_MODELS = {
    "claude-opus-5-5": "Claude Opus 5.5 · precisão",
    "claude-sonnet-5-5": "Claude Sonnet 5.5 · equilíbrio",
    "claude-haiku-5-5": "Claude Haiku 5.5 · rápido",
}
_SKIP = re.compile(r"tts|image|embed|live|audio|robotics|computer|aqa|learnlm|gemma|native|dialog", re.I)


# ---------------------------------------------------------------- Gemini
@lru_cache(maxsize=1)
def gemini_client():
    from google import genai

    return genai.Client(api_key=GEMINI_KEY)


def _version(name: str) -> tuple:
    m = re.search(r"gemini-(\d+(?:\.\d+)?)", name)
    return (float(m.group(1)) if m else 0.0,)


def _gemini_label(mid: str, first: bool) -> str:
    tier = ("mais leve" if "lite" in mid else "precisão máxima" if "pro" in mid
            else "recomendado" if first else "versão anterior")
    pretty = mid.replace("gemini-", "Gemini ").replace("-", " ").title()
    return f"{pretty} · {tier}"


@lru_cache(maxsize=1)
def gemini_models() -> list[str]:
    """Lista os modelos Gemini estáveis com suporte a imagem disponíveis na sua chave."""
    try:
        found = []
        for m in gemini_client().models.list():
            mid = (m.name or "").removeprefix("models/")
            actions = m.supported_actions or []
            if not mid.startswith("gemini-") or "generateContent" not in actions:
                continue
            if _SKIP.search(mid) or re.search(r"preview|exp|latest|-\d{3,}$", mid):
                continue
            if not any(t in mid for t in ("flash", "pro")):
                continue
            found.append(mid)
        if not found:
            return GEMINI_FALLBACK_MODELS
        # Mais novo primeiro; dentro da mesma versão: flash, pro, lite.
        newest = lambda xs: sorted(xs, key=lambda m: -_version(m)[0])
        flash = newest([m for m in set(found) if "flash" in m and "lite" not in m])
        # Só oferece um Pro se ele for de geração igual ou mais nova que o melhor Flash.
        pro = [m for m in newest([m for m in set(found) if "pro" in m])
               if not flash or _version(m) >= _version(flash[0])]
        lite = newest([m for m in set(found) if "lite" in m])
        # Flash mais novo (padrão), o anterior, o Pro mais novo e o Lite mais novo.
        return flash[:2] + pro[:1] + lite[:1] or GEMINI_FALLBACK_MODELS
    except Exception:
        return GEMINI_FALLBACK_MODELS


def ocr_gemini(model: str, image: bytes, media_type: str, instruction: str) -> tuple[str, int, int]:
    from google.genai import errors, types

    def call(thinking: bool):
        config = types.GenerateContentConfig(
            system_instruction=SYSTEM_PROMPT,
            temperature=0,
            max_output_tokens=8192,
            media_resolution=types.MediaResolution.MEDIA_RESOLUTION_HIGH,
            thinking_config=types.ThinkingConfig(thinking_level="LOW") if thinking else None,
        )
        return gemini_client().models.generate_content(
            model=model,
            contents=[types.Part.from_bytes(data=image, mime_type=media_type), instruction],
            config=config,
        )

    try:
        try:
            resp = call(thinking=True)
        except errors.ClientError as e:
            # Alguns modelos não aceitam thinking_level / media_resolution: tenta o básico.
            if e.code == 400:
                resp = call(thinking=False)
            else:
                raise
    except errors.ClientError as e:
        if e.code in (401, 403):
            raise HTTPException(401, "Chave do Gemini inválida ou sem permissão.")
        if e.code == 404:
            raise HTTPException(400, f"Modelo {model} não encontrado na sua conta.")
        if e.code == 429:
            raise HTTPException(429, "Limite do Gemini atingido (plano gratuito tem cota por minuto). Tente em instantes.")
        raise HTTPException(400, f"Gemini rejeitou a requisição: {e.message}")
    except errors.ServerError as e:
        raise HTTPException(502, f"Gemini indisponível ({e.code}). Tente novamente.")

    text = resp.text or ""
    if not text:
        reason = resp.candidates[0].finish_reason if resp.candidates else "bloqueado"
        raise HTTPException(422, f"O Gemini não devolveu texto ({reason}).")
    usage = resp.usage_metadata
    return text, (usage.prompt_token_count or 0) if usage else 0, (usage.candidates_token_count or 0) if usage else 0


# ---------------------------------------------------------------- Claude
def ocr_claude(model: str, image_b64: str, media_type: str, instruction: str) -> tuple[str, int, int]:
    import anthropic

    client = anthropic.Anthropic(api_key=ANTHROPIC_KEY)
    params = dict(
        model=model,
        max_tokens=16000,
        system=SYSTEM_PROMPT,
        output_config={"effort": "low"},
        messages=[{
            "role": "user",
            "content": [
                {"type": "image", "source": {"type": "base64", "media_type": media_type, "data": image_b64}},
                {"type": "text", "text": instruction},
            ],
        }],
    )
    if model != "claude-haiku-5-5":
        # Recusas indevidas são reexecutadas num modelo de fallback pelo servidor.
        params.update(betas=["server-side-fallback-2026-07-01"], fallbacks="default")
    try:
        resp = client.beta.messages.create(**params)
    except anthropic.AuthenticationError:
        raise HTTPException(401, "Chave da Anthropic inválida.")
    except anthropic.RateLimitError:
        raise HTTPException(429, "Limite de requisições atingido. Tente novamente em instantes.")
    except anthropic.BadRequestError as e:
        raise HTTPException(400, f"Requisição rejeitada: {e.message}")
    except anthropic.APIStatusError as e:
        raise HTTPException(502, f"Erro da API ({e.status_code}). Tente novamente.")
    except anthropic.APIConnectionError:
        raise HTTPException(503, "Sem conexão com a API.")
    if resp.stop_reason == "refusal":
        raise HTTPException(422, "O modelo recusou esta imagem.")
    text = "".join(b.text for b in resp.content if b.type == "text")
    return text, resp.usage.input_tokens, resp.usage.output_tokens


# ---------------------------------------------------------------- API
def available_models() -> list[dict]:
    models = []
    if GEMINI_KEY:
        models += [{"id": m, "label": _gemini_label(m, i == 0)} for i, m in enumerate(gemini_models())]
    if ANTHROPIC_KEY:
        models += [{"id": k, "label": v} for k, v in CLAUDE_MODELS.items()]
    return models


app = FastAPI(title="math2big")


class OcrRequest(BaseModel):
    image: str  # base64 (sem prefixo data:)
    media_type: str = "image/png"
    model: str | None = None
    hint: str | None = None


class OcrResponse(BaseModel):
    content: str
    model: str
    input_tokens: int
    output_tokens: int


@app.get("/api/models")
def list_models():
    models = available_models()
    ids = [m["id"] for m in models]
    default = os.environ.get("MATH2BIG_MODEL")
    if default not in ids:
        default = ids[0] if ids else None
    return {"default": default, "models": models}


@app.post("/api/ocr", response_model=OcrResponse)
def ocr(req: OcrRequest):
    if not (GEMINI_KEY or ANTHROPIC_KEY):
        raise HTTPException(401, "Nenhuma chave configurada: defina GEMINI_API_KEY e reinicie o servidor.")
    if req.media_type not in ALLOWED_MEDIA:
        raise HTTPException(400, "Formato de imagem não suportado (use PNG, JPEG, WEBP ou GIF).")
    try:
        image = base64.b64decode(req.image, validate=True)
    except Exception:
        raise HTTPException(400, "Imagem inválida.")

    model = req.model or list_models()["default"]
    instruction = "Transcreva a matemática desta imagem."
    if req.hint:
        instruction += f"\nContexto fornecido pelo usuário: {req.hint.strip()[:500]}"

    if model.startswith("claude-"):
        if not ANTHROPIC_KEY or model not in CLAUDE_MODELS:
            raise HTTPException(400, "Modelo Claude indisponível (sem ANTHROPIC_API_KEY).")
        text, tin, tout = ocr_claude(model, req.image, req.media_type, instruction)
    elif model.startswith("gemini-"):
        if not GEMINI_KEY:
            raise HTTPException(400, "Modelo Gemini indisponível (sem GEMINI_API_KEY).")
        text, tin, tout = ocr_gemini(model, image, req.media_type, instruction)
    else:
        raise HTTPException(400, "Modelo não suportado.")

    text = text.strip()
    fence = re.fullmatch(r"```[a-zA-Z]*\n?([\s\S]*?)\n?```", text)
    if fence:
        text = fence.group(1).strip()
    return OcrResponse(content=text, model=model, input_tokens=tin, output_tokens=tout)


# Local/Docker: serve a interface. Na Vercel, a pasta public/ é servida pela CDN.
if STATIC.is_dir():
    app.mount("/", StaticFiles(directory=STATIC, html=True), name="public")
