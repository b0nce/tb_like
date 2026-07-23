"""FastAPI app: serves run/tag metadata, downsampled series, and the dashboard."""

from __future__ import annotations

import json
import os
import re
import threading
from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
from starlette.middleware.gzip import GZipMiddleware

from .convert import _atomic_write_json, backfill_texts, convert_run
from .store import Store
from .watcher import Watcher, run_dir_for

STATIC_DIR = os.path.join(os.path.dirname(__file__), "static")


class SeriesRequest(BaseModel):
    run_ids: list[str]
    tags: list[str]
    max_points: int = 1500


class RefreshRequest(BaseModel):
    run_ids: list[str]


class SelectionRequest(BaseModel):
    name: str
    runs: list[str] = []
    tags: list[str] = []
    view: dict = {}
    overlay: dict = {}


class ColorsRequest(BaseModel):
    colors: dict[str, str] = {}


def _slugify(name: str) -> str:
    s = re.sub(r"[^a-z0-9]+", "-", name.strip().lower()).strip("-")
    return s[:80] or "selection"


# Guards read-modify-write of the shared cache/_colors.json map.
_COLORS_LOCK = threading.Lock()
_HEX_RE = re.compile(r"^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$")


def _read_colors(path: str) -> dict:
    if not os.path.exists(path):
        return {}
    try:
        with open(path) as fh:
            data = json.load(fh)
        return data if isinstance(data, dict) else {}
    except (OSError, json.JSONDecodeError):
        return {}


def create_app(
    runs_dir: str = "runs",
    cache_dir: str = "cache",
    watch: bool = True,
    interval: float = 10.0,
    jobs: int = 1,
    hover_legend: bool = False,
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
    # Compress large JSON (the tag-name list and series payloads). Tag names share
    # long prefixes, so this shrinks a 250k-tag response ~10×. Skips tiny bodies.
    app.add_middleware(GZipMiddleware, minimum_size=1024)
    app.state.store = store
    app.state.watcher = watcher
    app.state.runs_dir = os.path.abspath(runs_dir)
    app.state.cache_dir = os.path.abspath(cache_dir)

    @app.get("/api/config")
    def get_config():
        # Launch-time UI defaults (the dashboard reads these once, at boot).
        return {"hover_legend": hover_legend}

    @app.get("/api/runs")
    def get_runs():
        return {"runs": [r.__dict__ for r in store.list_runs()]}

    @app.get("/api/tags")
    def get_tags(runs: str = ""):
        # Returns just the union of tag NAMES (from the tags.txt sidecars), so even
        # a 250k-tag run sends a compact list — no per-tag stats, no index parse.
        run_ids = [r for r in runs.split(",") if r]
        if not run_ids:
            run_ids = store.run_ids()
        return {"tags": store.tag_names(run_ids)}

    @app.post("/api/series")
    def post_series(req: SeriesRequest):
        if not req.run_ids or not req.tags:
            return {"series": []}
        if req.max_points < 0 or req.max_points > 100_000:
            raise HTTPException(400, "max_points out of range")
        return {"series": store.get_series(req.run_ids, req.tags, req.max_points)}

    @app.get("/api/text-index")
    def get_text_index(runs: str = ""):
        run_ids = [r for r in runs.split(",") if r]
        if not run_ids:
            return {"runs": {}}
        return {"runs": store.text_index(run_ids)}

    @app.get("/api/text")
    def get_text(run: str, tag: str, i: int = -1, step: int = -1):
        # `i` is the entry id from /api/text-index (several texts can share a step);
        # `step` is kept as a legacy fallback for older clients.
        ref = i if i >= 0 else step
        text = store.get_text(run, tag, ref)
        if text is None:
            raise HTTPException(404, "text not found")
        return {"run": run, "tag": tag, "i": ref, "text": text}

    @app.post("/api/refresh")
    def post_refresh(req: RefreshRequest):
        # Re-ingest selected runs from disk now (incremental: a fast no-op if no
        # new tfevents). Sync endpoint -> runs in the threadpool, off the loop.
        refreshed, new_rows, text_added = [], 0, 0
        for rid in req.run_ids:
            run_dir = run_dir_for(runs_dir, rid)
            if run_dir is None:
                continue
            cache_run_dir = os.path.join(cache_dir, rid)
            try:
                res = convert_run(run_dir, cache_run_dir, rid)
                # Backfill text for runs ingested before text support (a cheap
                # no-op once they already have text). jobs= speeds the re-scan.
                n = backfill_texts(run_dir, cache_run_dir, n_jobs=jobs)
                if n > 0:
                    text_added += 1
                # Store caches index/texts by mtime, so the rewritten files are
                # picked up automatically on the next read — no manual invalidation.
                refreshed.append(rid)
                new_rows += res.new_rows
            except Exception as e:  # noqa: BLE001 - report, don't crash the request
                raise HTTPException(500, f"refresh failed for {rid}: {e}")
        return {"refreshed": refreshed, "new_rows": new_rows, "text_backfilled": text_added}

    @app.post("/api/selections")
    def post_selection(req: SelectionRequest):
        # Persist a named selection (runs + tags + view options) under
        # cache/_shared/<slug>.json so it can be restored from a short ?sel= URL.
        if len(req.tags) > 500_000:
            raise HTTPException(400, "selection too large")
        shared = os.path.join(app.state.cache_dir, "_shared")
        os.makedirs(shared, exist_ok=True)
        base = _slugify(req.name)
        sid, n = base, 2
        while os.path.exists(os.path.join(shared, sid + ".json")):
            sid = f"{base}-{n}"
            n += 1
        payload = {"id": sid, "name": req.name, "runs": req.runs, "tags": req.tags,
                   "view": req.view, "overlay": req.overlay}
        _atomic_write_json(os.path.join(shared, sid + ".json"), payload)
        return {"id": sid, "name": req.name}

    @app.get("/api/selections/{sid}")
    def get_selection(sid: str):
        # basename() defangs any path-traversal attempt in the id.
        p = os.path.join(app.state.cache_dir, "_shared", os.path.basename(sid) + ".json")
        if not os.path.exists(p):
            raise HTTPException(404, "selection not found")
        try:
            with open(p) as fh:
                return json.load(fh)
        except (OSError, json.JSONDecodeError):
            raise HTTPException(500, "selection unreadable")

    @app.get("/api/colors")
    def get_colors():
        # Per-run color assignments, persisted so a run keeps its color across
        # restarts (and new runs never shift the colors of existing ones).
        return {"colors": _read_colors(os.path.join(app.state.cache_dir, "_colors.json"))}

    @app.post("/api/colors")
    def post_colors(req: ColorsRequest):
        # Merge the given {run_id: "#rrggbb"} updates into the stored map. Invalid
        # (non-hex) values are dropped rather than persisted.
        updates = {k: v for k, v in req.colors.items() if isinstance(v, str) and _HEX_RE.match(v)}
        path = os.path.join(app.state.cache_dir, "_colors.json")
        with _COLORS_LOCK:
            current = _read_colors(path)
            current.update(updates)
            os.makedirs(app.state.cache_dir, exist_ok=True)
            _atomic_write_json(path, current)
        return {"saved": len(updates)}

    @app.get("/api/status")
    def get_status():
        return {
            "watcher": watcher.last_scan,
            "progress": watcher.progress,
            "num_runs": len(store.run_ids()),
            "runs_dir": app.state.runs_dir,
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
    hover_legend=os.environ.get("TBLIKE_HOVER_LEGEND", "0") == "1",
)
