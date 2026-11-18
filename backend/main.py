"""Monta a aplicação FastAPI."""

from __future__ import annotations

import logging

from fastapi import FastAPI
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from . import admin, config, db, ocr

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")

app = FastAPI(title="math2big", docs_url=None, redoc_url=None)
app.include_router(ocr.router)
app.include_router(admin.router)


@app.get("/api/health")
def health():
    ok = None
    if db.enabled():
        try:
            with db.connect() as conn:
                conn.execute("select 1")
            ok = True
        except Exception:  # noqa: BLE001
            ok = False
    return {"ok": True, "database": ok}


# Local/Docker: serve a interface. Na Vercel, a pasta public/ é servida pela CDN
# (e vercel.json reescreve /admin para /admin.html).
if config.STATIC.is_dir():
    @app.get("/admin", include_in_schema=False)
    def admin_page():
        return FileResponse(config.STATIC / "admin.html")

    app.mount("/", StaticFiles(directory=config.STATIC, html=True), name="public")
