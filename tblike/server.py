"""FastAPI app: serves run/tag metadata, downsampled series, and the dashboard."""

from __future__ import annotations

import os
from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from .convert import convert_run
from .store import Store
from .watcher import Watcher

STATIC_DIR = os.path.join(os.path.dirname(__file__), "static")


class SeriesRequest(BaseModel):
    run_ids: list[str]
    tags: list[str]
    max_points: int = 1500


class RefreshRequest(BaseModel):
    run_ids: list[str]


def create_app(
    runs_dir: str = "runs",
    cache_dir: str = "cache",
    watch: bool = True,
    interval: float = 10.0,
    jobs: int = 1,
) -> FastAPI:
    store = Store(cache_dir)
    watcher = Watcher(runs_dir, cache_dir, interval=interval, jobs=jobs)

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        if watch:
            watcher.start()
        yield
        watcher.stop()

    app = FastAPI(title="tb_like", version="0.1.0", lifespan=lifespan)
    app.state.store = store
    app.state.watcher = watcher

    @app.get("/api/runs")
    def get_runs():
        return {"runs": [r.__dict__ for r in store.list_runs()]}

    @app.get("/api/tags")
    def get_tags(runs: str = ""):
        run_ids = [r for r in runs.split(",") if r]
        if not run_ids:
            run_ids = store.run_ids()
        return {"tags": store.tags_for(run_ids)}

    @app.post("/api/series")
    def post_series(req: SeriesRequest):
        if not req.run_ids or not req.tags:
            return {"series": []}
        if req.max_points < 0 or req.max_points > 100_000:
            raise HTTPException(400, "max_points out of range")
        return {"series": store.get_series(req.run_ids, req.tags, req.max_points)}

    @app.post("/api/refresh")
    def post_refresh(req: RefreshRequest):
        # Re-ingest selected runs from disk now (incremental: a fast no-op if no
        # new tfevents). Sync endpoint -> runs in the threadpool, off the loop.
        refreshed, new_rows = [], 0
        for rid in req.run_ids:
            run_dir = os.path.join(runs_dir, rid)
            if not os.path.isdir(run_dir):
                continue
            try:
                res = convert_run(run_dir, os.path.join(cache_dir, rid), rid)
                refreshed.append(rid)
                new_rows += res.new_rows
            except Exception as e:  # noqa: BLE001 - report, don't crash the request
                raise HTTPException(500, f"refresh failed for {rid}: {e}")
        return {"refreshed": refreshed, "new_rows": new_rows}

    @app.get("/api/status")
    def get_status():
        return {
            "watcher": watcher.last_scan,
            "num_runs": len(store.run_ids()),
        }

    @app.get("/")
    def index():
        return FileResponse(os.path.join(STATIC_DIR, "index.html"))

    app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")
    return app


# For `uvicorn tblike.server:app` (the CLI sets these env vars before launching).
app = create_app(
    runs_dir=os.environ.get("TBLIKE_RUNS", "runs"),
    cache_dir=os.environ.get("TBLIKE_CACHE", "cache"),
    watch=os.environ.get("TBLIKE_WATCH", "1") != "0",
    interval=float(os.environ.get("TBLIKE_INTERVAL", "10")),
    jobs=int(os.environ.get("TBLIKE_JOBS", "1")),
)
