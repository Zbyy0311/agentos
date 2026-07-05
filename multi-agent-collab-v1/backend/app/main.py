import os
from contextlib import asynccontextmanager
from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
from starlette.middleware.base import BaseHTTPMiddleware
from app.database import engine, Base, AsyncSessionLocal
from app.routers import agents, tasks, messages, files, metrics, demo
from app.websocket.manager import websocket_endpoint
from app.services.agent_service import seed_default_agents


@asynccontextmanager
async def lifespan(app: FastAPI):
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    async with AsyncSessionLocal() as db:
        await seed_default_agents(db)
    yield


app = FastAPI(
    title="Multi-Agent Collaboration System",
    version="1.0.0",
    lifespan=lifespan,
)


class StripAPIPrefix(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next):
        if request.url.path.startswith("/api/"):
            request.scope["path"] = request.url.path[4:]
        return await call_next(request)


app.add_middleware(StripAPIPrefix)

app.add_middleware(
    CORSMiddleware,
    allow_origins=os.getenv("CORS_ORIGINS", "*").split(","),
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(agents.router)
app.include_router(tasks.router)
app.include_router(messages.router)
app.include_router(files.router)
app.include_router(metrics.router)
app.include_router(demo.router)
app.add_websocket_route("/ws", websocket_endpoint)


@app.get("/health")
async def health():
    return {"status": "ok"}


dist_dir = os.path.abspath(os.path.join(os.path.dirname(__file__), "../../frontend/dist"))
assets_dir = os.path.join(dist_dir, "assets")
index_file = os.path.join(dist_dir, "index.html")

if os.path.exists(assets_dir):
    app.mount("/assets", StaticFiles(directory=assets_dir), name="assets")


if os.path.exists(index_file):
    @app.get("/")
    async def serve_index():
        return FileResponse(index_file)


    @app.get("/{full_path:path}")
    async def serve_spa(full_path: str):
        return FileResponse(index_file)
