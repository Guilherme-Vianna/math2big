"""Pequenas análises do texto devolvido pelo modelo."""

from __future__ import annotations

import re

_FENCE = re.compile(r"```[a-zA-Z]*\n?([\s\S]*?)\n?```")
_DISPLAY = re.compile(r"\$\$([\s\S]+?)\$\$|\\\[([\s\S]+?)\\\]")
_INLINE = re.compile(r"(?<!\$)\$([^$\n]+?)\$(?!\$)")
_UNSURE = re.compile(r"\\text\{\s*\[\?\]\s*\}")


def clean(text: str) -> str:
    """Remove espaços e cercas de código que o modelo às vezes coloca em volta."""
    text = text.strip()
    m = _FENCE.fullmatch(text)
    return m.group(1).strip() if m else text


def formulas(text: str) -> list[str]:
    """Fórmulas em destaque ($$...$$ e \\[...\\]) e inline ($...$), na ordem."""
    out = []
    display_spans = []
    for m in _DISPLAY.finditer(text):
        display_spans.append(m.span())
        out.append((m.start(), (m.group(1) or m.group(2)).strip()))
    rest = text
    for a, b in display_spans:  # apaga os blocos para não confundir com $ inline
        rest = rest[:a] + " " * (b - a) + rest[b:]
    for m in _INLINE.finditer(rest):
        out.append((m.start(), m.group(1).strip()))
    return [f for _, f in sorted(out)]


def analyse(text: str) -> dict:
    fs = formulas(text)
    return {
        "latex": "\n\n".join(fs),
        "formula_count": len(fs),
        "unsure_count": len(_UNSURE.findall(text)),
        "char_count": len(text),
    }
