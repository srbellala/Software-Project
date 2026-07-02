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


@app.get("/")
def root():
    return FileResponse(os.path.join(_here, "static", "landing.html"))


@app.get("/tool")
def tool():
    return FileResponse(os.path.join(_here, "static", "index.html"))


if __name__ == "__main__":
    uvicorn.run("server:app", host="127.0.0.1", port=8001, reload=True)
