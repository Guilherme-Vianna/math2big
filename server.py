"""math2big — OCR de matemática (imagem -> LaTeX).

Ponto de entrada (Vercel e `uvicorn server:app`). O código fica em backend/:
  - providers.py  Gemini / Claude com streaming
  - ocr.py        rotas públicas (/api/models, /api/ocr, /api/events)
  - admin.py      painel /admin (/api/admin/*)
  - db.py         Postgres: conversões, eventos e configurações
"""

from backend.main import app  # noqa: F401
