"""Provedores de OCR (Gemini e Claude) com uma interface única de streaming.

`stream(model, image, media_type, instruction, usage)` devolve um iterador de
pedaços de texto e preenche `usage` (tokens, motivo de término) ao terminar.
Falhas viram `ProviderError` com uma mensagem pronta para a interface.
"""

from __future__ import annotations

import base64
import re
from dataclasses import dataclass
from functools import lru_cache
from typing import Iterator

from . import config

SYSTEM_PROMPT = r"""You are a meticulous OCR engine specialised in mathematics (printed or handwritten).
Transcribe EXACTLY what is in the image — do not solve, simplify, correct, reorder or complete anything.

Output format (Markdown + LaTeX), nothing else:
- Every formula, equation or expression goes in display math: $$ ... $$ on its own line.
- Math that sits inside a sentence of prose on the same line (e.g. "Seja $f(x)=...$. Mostre que:") MUST stay inline with single dollars $ ... $ — never break a sentence with $$.
- Prose (statements, "seja", "prove que", item labels like "a)", "1.") stays as plain text, in its original language.
- Never put LaTeX commands in prose outside $...$. Circled or boxed item numbers (e.g. a circled 11) are written as plain text "(11)".
- Multi-line derivations/systems: use \begin{aligned} ... \end{aligned} (align on = when the image does), cases, or matrices (pmatrix, bmatrix, vmatrix) as appropriate.
- Use standard LaTeX that KaTeX can render: \frac, \sqrt[n]{}, \int_a^b, \sum, \prod, \lim_{x \to 0}, \partial, \nabla, \mathbb{R}, \mathcal{}, \vec{}, \hat{}, \overline{}, \binom, \left( \right), \operatorname{}, etc.
- Preserve the original variable names, subscripts, superscripts, primes, and spacing intent.
- If a symbol is illegible, give your best reading followed by \text{[?]}.
- Never wrap the answer in code fences and never add explanations or commentary.
- If the image contains no mathematics or text, output exactly: (sem conteúdo matemático)"""

GEMINI_FALLBACK_MODELS = ["gemini-3.8-flash", "gemini-3.5-flash-lite"]
CLAUDE_MODELS = {
    "claude-opus-5-5": "Claude Opus 5.5 · precisão",
    "claude-sonnet-5-5": "Claude Sonnet 5.5 · equilíbrio",
    "claude-haiku-5-5": "Claude Haiku 5.5 · rápido",
}
_SKIP = re.compile(r"tts|image|embed|live|audio|robotics|computer|aqa|learnlm|gemma|native|dialog", re.I)


class ProviderError(Exception):
    def __init__(self, message: str, status: int = 502):
        super().__init__(message)
        self.message = message
        self.status = status


@dataclass
class Usage:
    input_tokens: int = 0
    output_tokens: int = 0
    thinking_tokens: int = 0
    finish_reason: str | None = None
    thinking_used: bool | None = None


def provider_of(model: str) -> str:
    return "anthropic" if model.startswith("claude-") else "google" if model.startswith("gemini-") else "?"


# ---------------------------------------------------------------- Gemini
@lru_cache(maxsize=1)
def gemini_client():
    from google import genai

    return genai.Client(api_key=config.GEMINI_KEY)


def _version(name: str) -> float:
    m = re.search(r"gemini-(\d+(?:\.\d+)?)", name)
    return float(m.group(1)) if m else 0.0


def _gemini_label(mid: str, first: bool) -> str:
    tier = ("mais leve" if "lite" in mid else "precisão máxima" if "pro" in mid
            else "recomendado" if first else "versão anterior")
    pretty = mid.replace("gemini-", "Gemini ").replace("-", " ").title()
    return f"{pretty} · {tier}"


@lru_cache(maxsize=1)
def gemini_models() -> list[str]:
    """Modelos Gemini estáveis com suporte a imagem disponíveis na chave."""
    try:
        found = set()
        for m in gemini_client().models.list():
            mid = (m.name or "").removeprefix("models/")
            if not mid.startswith("gemini-") or "generateContent" not in (m.supported_actions or []):
                continue
            if _SKIP.search(mid) or re.search(r"preview|exp|latest|-\d{3,}$", mid):
                continue
            if any(t in mid for t in ("flash", "pro")):
                found.add(mid)
        newest = lambda xs: sorted(xs, key=lambda m: -_version(m))
        flash = newest(m for m in found if "flash" in m and "lite" not in m)
        # Só oferece um Pro se ele for de geração igual ou mais nova que o melhor Flash.
        pro = [m for m in newest(m for m in found if "pro" in m)
               if not flash or _version(m) >= _version(flash[0])]
        lite = newest(m for m in found if "lite" in m)
        return flash[:2] + pro[:1] + lite[:1] or GEMINI_FALLBACK_MODELS
    except Exception:
        return GEMINI_FALLBACK_MODELS


def _gemini_config(thinking: bool):
    from google.genai import types

    return types.GenerateContentConfig(
        system_instruction=SYSTEM_PROMPT,
        temperature=0,
        max_output_tokens=8192,
        media_resolution=types.MediaResolution.MEDIA_RESOLUTION_HIGH,
        thinking_config=types.ThinkingConfig(thinking_level="LOW") if thinking else None,
    )


def _gemini_error(e: Exception, model: str) -> ProviderError:
    from google.genai import errors

    if isinstance(e, errors.ClientError):
        if e.code in (401, 403):
            return ProviderError("Chave do Gemini inválida ou sem permissão.", 401)
        if e.code == 404:
            return ProviderError(f"Modelo {model} não encontrado na sua conta.", 400)
        if e.code == 429:
            return ProviderError("Limite do Gemini atingido (o plano gratuito tem cota por minuto). "
                                 "Tente em instantes ou troque o modelo.", 429)
        return ProviderError(f"Gemini rejeitou a requisição: {e.message}", 400)
    if isinstance(e, errors.ServerError):
        return ProviderError(f"Gemini indisponível no momento ({e.code}). Tente novamente.", 502)
    return ProviderError("Falha inesperada ao falar com o Gemini.", 502)


def _stream_gemini(model: str, image: bytes, media_type: str, instruction: str, usage: Usage) -> Iterator[str]:
    from google.genai import errors, types

    contents = [types.Part.from_bytes(data=image, mime_type=media_type), instruction]
    for thinking in (True, False):
        sent = False
        try:
            meta = None
            for chunk in gemini_client().models.generate_content_stream(
                model=model, contents=contents, config=_gemini_config(thinking)
            ):
                if chunk.usage_metadata:
                    meta = chunk.usage_metadata
                if chunk.candidates and chunk.candidates[0].finish_reason:
                    usage.finish_reason = str(getattr(chunk.candidates[0].finish_reason, "name",
                                                      chunk.candidates[0].finish_reason))
                if chunk.text:
                    sent = True
                    yield chunk.text
            usage.thinking_used = thinking
            if meta:
                usage.input_tokens = meta.prompt_token_count or 0
                usage.output_tokens = meta.candidates_token_count or 0
                usage.thinking_tokens = getattr(meta, "thoughts_token_count", None) or 0
            if not sent:
                raise ProviderError(f"O Gemini não devolveu texto para esta imagem ({usage.finish_reason or 'vazio'}).", 422)
            return
        except errors.ClientError as e:
            # Alguns modelos não aceitam thinking_level: tenta de novo sem ele.
            if e.code == 400 and thinking and not sent:
                continue
            raise _gemini_error(e, model) from e
        except ProviderError:
            raise
        except Exception as e:  # noqa: BLE001 — qualquer falha vira mensagem para a interface
            raise _gemini_error(e, model) from e


# ---------------------------------------------------------------- Claude
def _stream_claude(model: str, image: bytes, media_type: str, instruction: str, usage: Usage) -> Iterator[str]:
    import anthropic

    client = anthropic.Anthropic(api_key=config.ANTHROPIC_KEY)
    params = dict(
        model=model,
        max_tokens=16000,
        system=SYSTEM_PROMPT,
        output_config={"effort": "low"},
        messages=[{
            "role": "user",
            "content": [
                {"type": "image", "source": {"type": "base64", "media_type": media_type,
                                             "data": base64.b64encode(image).decode()}},
                {"type": "text", "text": instruction},
            ],
        }],
    )
    if model != "claude-haiku-5-5":
        # Recusas indevidas são reexecutadas num modelo de fallback pelo servidor.
        params.update(betas=["server-side-fallback-2026-07-01"], fallbacks="default")
    try:
        resp = client.beta.messages.create(**params)
    except anthropic.AuthenticationError as e:
        raise ProviderError("Chave da Anthropic inválida.", 401) from e
    except anthropic.RateLimitError as e:
        raise ProviderError("Limite de requisições atingido. Tente novamente em instantes.", 429) from e
    except anthropic.BadRequestError as e:
        raise ProviderError(f"Requisição rejeitada: {e.message}", 400) from e
    except anthropic.APIStatusError as e:
        raise ProviderError(f"Erro da API ({e.status_code}). Tente novamente.", 502) from e
    except anthropic.APIConnectionError as e:
        raise ProviderError("Sem conexão com a API.", 503) from e
    usage.finish_reason = resp.stop_reason
    usage.input_tokens = resp.usage.input_tokens
    usage.output_tokens = resp.usage.output_tokens
    if resp.stop_reason == "refusal":
        raise ProviderError("O modelo recusou esta imagem.", 422)
    text = "".join(b.text for b in resp.content if b.type == "text")
    if text:
        yield text


# ---------------------------------------------------------------- interface
def available_models() -> list[dict]:
    models = []
    if config.GEMINI_KEY:
        models += [{"id": m, "label": _gemini_label(m, i == 0)} for i, m in enumerate(gemini_models())]
    if config.ANTHROPIC_KEY:
        models += [{"id": k, "label": v} for k, v in CLAUDE_MODELS.items()]
    return models


def check_model(model: str) -> None:
    if model.startswith("claude-"):
        if not (config.ANTHROPIC_KEY and model in CLAUDE_MODELS):
            raise ProviderError("Modelo Claude indisponível (sem ANTHROPIC_API_KEY).", 400)
    elif model.startswith("gemini-"):
        if not config.GEMINI_KEY:
            raise ProviderError("Modelo Gemini indisponível (sem GEMINI_API_KEY).", 400)
    else:
        raise ProviderError("Modelo não suportado.", 400)


def stream(model: str, image: bytes, media_type: str, instruction: str, usage: Usage) -> Iterator[str]:
    if model.startswith("claude-"):
        return _stream_claude(model, image, media_type, instruction, usage)
    return _stream_gemini(model, image, media_type, instruction, usage)
