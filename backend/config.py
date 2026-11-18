"""Configuração lida do ambiente (e do arquivo .env, se existir)."""

from __future__ import annotations

import os
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
STATIC = ROOT / "public"  # na Vercel, servido direto pela CDN


def _load_dotenv(path: Path) -> None:
    """Carrega KEY=VALUE do .env sem sobrescrever variáveis já definidas no sistema."""
    if not path.exists():
        return
    for line in path.read_text(encoding="utf-8").splitlines():
        key, sep, value = line.strip().partition("=")
        if sep and key and not key.startswith("#"):
            os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))


_load_dotenv(ROOT / ".env")

GEMINI_KEY = os.environ.get("GEMINI_API_KEY") or os.environ.get("GOOGLE_API_KEY")
ANTHROPIC_KEY = os.environ.get("ANTHROPIC_API_KEY")
DEFAULT_MODEL = os.environ.get("MATH2BIG_MODEL")

# Banco (Postgres/Neon). Sem ele o app funciona normalmente, só não registra nada.
DATABASE_URL = os.environ.get("DATABASE_URL") or os.environ.get("POSTGRES_URL")

# Painel /admin. Sem ADMIN_PASSWORD o painel fica desativado.
ADMIN_PASSWORD = os.environ.get("ADMIN_PASSWORD")
ADMIN_SECRET = os.environ.get("ADMIN_SECRET") or ADMIN_PASSWORD or ""
ADMIN_SESSION_HOURS = int(os.environ.get("ADMIN_SESSION_HOURS", "72"))

ALLOWED_MEDIA = {"image/png", "image/jpeg", "image/webp", "image/gif"}
MAX_HINT = 500
