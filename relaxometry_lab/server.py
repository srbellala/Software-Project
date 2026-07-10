import os
import uvicorn
from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse

from api.load_routes   import router as load_router
from api.fit_routes    import router as fit_router
from api.output_routes import router as output_router

app = FastAPI(title="Relaxometry Lab")

app.include_router(load_router,   prefix="/api/load")
app.include_router(fit_router,    prefix="/api/fit")
app.include_router(output_router, prefix="/api/output")

_here = os.path.dirname(os.path.abspath(__file__))
app.mount("/static", StaticFiles(directory=os.path.join(_here, "static")), name="static")

_frontend_dist = os.path.join(_here, "frontend", "dist")
if os.path.isdir(_frontend_dist):
    app.mount("/tool-next/assets", StaticFiles(directory=os.path.join(_frontend_dist, "assets")),
              name="frontend-assets")


def _serve_frontend_build(fallback_static_file: str):
    """/, /tool, /next, and /tool-next all serve the same built index.html —
    main.tsx picks the wizard vs. landing React tree based on
    window.location.pathname."""
    index_path = os.path.join(_frontend_dist, "index.html")
    if not os.path.isfile(index_path):
        return FileResponse(os.path.join(_here, "static", fallback_static_file))  # fallback if not built yet
    return FileResponse(index_path)


# ── React app (default) ─────────────────────────────────────────────────────

@app.get("/")
def root():
    """New React landing page — the default entry point now that migration is complete."""
    return _serve_frontend_build("landing.html")


@app.get("/tool")
def tool():
    """New React + Vite + Tailwind wizard — the default tool now that migration is complete."""
    return _serve_frontend_build("index.html")


@app.get("/next")
def landing_next():
    """Alias for / — kept for existing links/scripts built during migration."""
    return _serve_frontend_build("landing.html")


@app.get("/tool-next")
def tool_next():
    """Alias for /tool — kept for existing links/scripts built during migration."""
    return _serve_frontend_build("index.html")


@app.get("/tool-next/favicon.svg")
def tool_next_favicon():
    return FileResponse(os.path.join(_frontend_dist, "favicon.svg"))


# ── Legacy vanilla-JS app (kept for reference/comparison) ──────────────────

@app.get("/legacy")
def legacy_landing():
    return FileResponse(os.path.join(_here, "static", "landing.html"))


@app.get("/tool-legacy")
def legacy_tool():
    return FileResponse(os.path.join(_here, "static", "index.html"))


if __name__ == "__main__":
    uvicorn.run("server:app", host="127.0.0.1", port=8001, reload=True)
