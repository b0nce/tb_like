"""Read layer over the Parquet cache.

Listing runs and tags is served entirely from the small per-run `index.json`
files (no Parquet touched). Series reads use Polars' predicate pushdown so a
query for a handful of tags only reads the matching row groups, even when a run
holds ~18k series.
"""

from __future__ import annotations

import os
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass

import numpy as np
import polars as pl

from .convert import load_index, load_meta, load_tag_names, load_texts
from .downsample import lttb


# Cap how many non-finite markers we emit per series, so a pathologically broken
# series (mostly NaN/Inf) can't bloat the payload.
GAP_CAP = 2000


def _nonfinite_gaps(steps: np.ndarray, values: np.ndarray, walls: np.ndarray) -> list[dict]:
    """Describe each non-finite point: {step, wall_time, kind, y}.

    `kind` is "nan" / "+inf" / "-inf". `y` anchors the marker to the nearest
    finite value (previous if any, else next) so it sits right at the break.
    """
    finite = np.isfinite(values)
    bad = np.flatnonzero(~finite)
    if bad.size == 0:
        return []
    fin = np.flatnonzero(finite)
    if fin.size:
        # nearest finite index: previous one, falling back to the first finite
        pos = np.searchsorted(fin, bad, side="right") - 1
        anchor_idx = np.where(pos >= 0, fin[np.clip(pos, 0, fin.size - 1)], fin[0])
        anchors = values[anchor_idx]
    else:
        anchors = np.zeros(bad.size)
    out: list[dict] = []
    for i, ai in zip(bad[:GAP_CAP], anchors[:GAP_CAP]):
        v = values[i]
        kind = "nan" if np.isnan(v) else ("+inf" if v > 0 else "-inf")
        out.append({
            "step": int(steps[i]),
            "wall_time": float(walls[i]),
            "kind": kind,
            "y": float(ai),
        })
    return out


@dataclass
class RunInfo:
    run_id: str
    display_name: str
    num_tags: int
    num_rows: int
    num_event_files: int
    updated_at: float
    config: dict
    step_min: int
    step_max: int


# A single huge run's index.json holds a ~250k-tag stats map (tens of MB parsed),
# so the in-memory caches are bounded: without a cap, browsing many big runs would
# pin them all resident. meta/texts are tiny, so they get a roomier cap.
_INDEX_CACHE_MAX = 24
_META_CACHE_MAX = 1024
_TEXTS_CACHE_MAX = 256
_TAGNAMES_CACHE_MAX = 12   # each list can hold ~250k strings — keep few resident
_RUNIDS_TTL = 2.0   # seconds; run_ids() is polled often (status) — don't re-listdir each time


def _cache_put(cache: dict, key, value, cap: int) -> None:
    """Insert into an insertion-ordered dict, evicting the oldest over `cap`."""
    cache.pop(key, None)
    cache[key] = value
    while len(cache) > cap:
        cache.pop(next(iter(cache)))


class Store:
    def __init__(self, cache_dir: str):
        self.cache_dir = cache_dir
        self._index_cache: dict[str, tuple[float, dict]] = {}  # run_id -> (mtime, index)
        self._meta_cache: dict[str, tuple[float, dict]] = {}   # run_id -> (mtime, meta)
        self._texts_cache: dict[str, tuple[float, dict]] = {}  # run_id -> (mtime, texts)
        self._tagnames_cache: dict[str, tuple[float, list]] = {}  # run_id -> (mtime, names)
        self._runids: tuple[float, list[str]] | None = None    # (read_at, ids)

    # ---- discovery -------------------------------------------------------
    def run_ids(self) -> list[str]:
        import time
        now = time.monotonic()
        if self._runids and now - self._runids[0] < _RUNIDS_TTL:
            return self._runids[1]
        out: list[str] = []
        if os.path.isdir(self.cache_dir):
            for name in os.listdir(self.cache_dir):
                if os.path.exists(os.path.join(self.cache_dir, name, "index.json")):
                    out.append(name)
            out.sort()
        self._runids = (now, out)
        return out

    def _index(self, run_id: str) -> dict | None:
        p = os.path.join(self.cache_dir, run_id, "index.json")
        try:
            mtime = os.path.getmtime(p)
        except OSError:
            self._index_cache.pop(run_id, None)
            return None
        cached = self._index_cache.get(run_id)
        if cached and cached[0] == mtime:
            return cached[1]
        idx = load_index(os.path.join(self.cache_dir, run_id))
        if idx is not None:
            _cache_put(self._index_cache, run_id, (mtime, idx), _INDEX_CACHE_MAX)
        return idx

    def _meta(self, run_id: str) -> dict | None:
        """Small per-run meta (display_name, segments, step range, …). The hot
        series-read path uses this so it never parses the giant index.json."""
        p = os.path.join(self.cache_dir, run_id, "meta.json")
        try:
            mtime = os.path.getmtime(p)
        except OSError:
            # meta may not exist yet (old cache); load_meta creates it from index.
            m = load_meta(os.path.join(self.cache_dir, run_id))
            return m
        cached = self._meta_cache.get(run_id)
        if cached and cached[0] == mtime:
            return cached[1]
        m = load_meta(os.path.join(self.cache_dir, run_id))
        if m is not None:
            _cache_put(self._meta_cache, run_id, (mtime, m), _META_CACHE_MAX)
        return m

    def list_runs(self) -> list[RunInfo]:
        # Uses the small meta.json per run, so listing 200+ runs stays fast and
        # never parses the multi-MB tags map.
        runs = []
        for rid in self.run_ids():
            m = self._meta(rid)
            if not m:
                continue
            runs.append(
                RunInfo(
                    run_id=rid,
                    display_name=m.get("display_name", rid),
                    num_tags=m.get("num_tags", 0),
                    num_rows=m.get("num_rows", 0),
                    num_event_files=m.get("num_event_files", 0),
                    updated_at=m.get("updated_at", 0.0),
                    config=m.get("config", {}),
                    step_min=m.get("step_min", 0),
                    step_max=m.get("step_max", 0),
                )
            )
        return runs

    def _tag_names(self, run_id: str) -> list[str]:
        p = os.path.join(self.cache_dir, run_id, "tags.txt")
        try:
            mtime = os.path.getmtime(p)
        except OSError:
            # Old cache without the sidecar: derive from the index (it'll be
            # written on the next convert pass, so this fallback is one-time).
            idx = self._index(run_id)
            return list(idx.get("tags", {}).keys()) if idx else []
        cached = self._tagnames_cache.get(run_id)
        if cached and cached[0] == mtime:
            return cached[1]
        names = load_tag_names(os.path.join(self.cache_dir, run_id)) or []
        _cache_put(self._tagnames_cache, run_id, (mtime, names), _TAGNAMES_CACHE_MAX)
        return names

    def tag_names(self, run_ids: list[str]) -> list[str]:
        """Union of tag names across the given runs (sorted), read from the tiny
        tags.txt sidecar so listing never parses the giant index. The client only
        needs names; per-tag stats stay server-side, read lazily when needed."""
        if len(run_ids) == 1:
            return self._tag_names(run_ids[0])   # already sorted in the sidecar
        seen: set[str] = set()
        for rid in run_ids:
            seen.update(self._tag_names(rid))
        return sorted(seen)

    # ---- series reads ----------------------------------------------------
    def _segment_paths(self, run_id: str) -> list[str]:
        # Prefer meta (tiny) so a series read never parses the giant index; fall
        # back to the index only for caches whose meta predates `segments`.
        m = self._meta(run_id) or {}
        segs = m.get("segments")
        if segs is None:
            segs = (self._index(run_id) or {}).get("segments", [])
        base = os.path.join(self.cache_dir, run_id, "data")
        return [os.path.join(base, s) for s in segs]

    def _run_frame(self, run_id: str, tags: list[str]) -> pl.DataFrame:
        paths = self._segment_paths(run_id)
        if not paths:
            return pl.DataFrame(schema={"tag": pl.Utf8, "step": pl.Int64, "wall_time": pl.Float64, "value": pl.Float32})
        df = pl.scan_parquet(paths).filter(pl.col("tag").is_in(tags)).collect()
        if df.is_empty() or len(paths) == 1:
            # A single segment is already sorted by (tag, step) and deduped at
            # write time, so the expensive sort+unique is unnecessary.
            return df
        # Multiple segments may repeat (tag, step) across resumes -> keep latest.
        return df.sort(["tag", "step", "wall_time"]).unique(
            subset=["tag", "step"], keep="last", maintain_order=True
        )

    def _series_for_run(self, rid: str, tags: list[str], max_points: int) -> list[dict]:
        # Series reads only need display_name + segment paths, both in the tiny
        # meta — so a chart fetch never parses the run's ~250k-tag index.
        m = self._meta(rid)
        if not m:
            return []
        display = m.get("display_name", rid)
        df = self._run_frame(rid, tags)
        if df.is_empty():
            return []
        items: list[dict] = []
        for tag, sub in df.group_by("tag", maintain_order=True):
            tag_name = tag[0] if isinstance(tag, tuple) else tag
            steps = sub["step"].to_numpy()
            values = sub["value"].to_numpy().astype(np.float64)
            walls = sub["wall_time"].to_numpy()
            count = len(steps)
            # Locate non-finite points on the FULL series (so downsampling can't
            # hide them) and tag each with its kind + an anchor y (nearest finite
            # value) so the UI can mark exactly where — and why — the line breaks.
            gaps = _nonfinite_gaps(steps, values, walls)
            if max_points and count > max_points:
                ds, vs = lttb(steps.astype(np.float64), values, max_points)
                # Map downsampled steps back to nearest wall_time for x-axis options.
                wsel = np.interp(ds, steps.astype(np.float64), walls)
                steps_out, values_out, walls_out = ds.astype(np.int64), vs, wsel
            else:
                steps_out, values_out, walls_out = steps, values, walls
            item = {
                "run_id": rid,
                "display_name": display,
                "tag": tag_name,
                "steps": steps_out.tolist(),
                # Non-finite (NaN or ±Inf) -> null: Plotly draws a gap, and it
                # keeps Inf out of JSON (Starlette uses allow_nan=False) and off
                # the y-axis autoscale.
                "values": [None if not np.isfinite(v) else float(v) for v in values_out],
                "wall_time": walls_out.tolist(),
                "count": int(count),
            }
            if gaps:
                item["gaps"] = gaps
            items.append(item)
        return items

    def get_series(
        self, run_ids: list[str], tags: list[str], max_points: int = 1500
    ) -> list[dict]:
        """Return downsampled series for the (run, tag) cross product that exists.

        Reads run in parallel threads: Polars releases the GIL during Parquet
        scan/collect, so many runs are read concurrently. Each item:
        {run_id, display_name, tag, steps, values, wall_time, count}.
        """
        if not run_ids:
            return []
        workers = min(len(run_ids), (os.cpu_count() or 4) * 2)
        if workers <= 1:
            return [it for rid in run_ids for it in self._series_for_run(rid, tags, max_points)]
        out: list[dict] = []
        with ThreadPoolExecutor(max_workers=workers) as ex:
            futures = [ex.submit(self._series_for_run, rid, tags, max_points) for rid in run_ids]
            for fut in futures:  # preserve run order
                out.extend(fut.result())
        return out

    # ---- text summaries (for the config diff) ----------------------------
    def _texts(self, run_id: str) -> dict:
        p = os.path.join(self.cache_dir, run_id, "texts.json")
        try:
            mtime = os.path.getmtime(p)
        except OSError:
            self._texts_cache.pop(run_id, None)
            return {}
        cached = self._texts_cache.get(run_id)
        if cached and cached[0] == mtime:
            return cached[1]
        texts = load_texts(os.path.join(self.cache_dir, run_id))
        _cache_put(self._texts_cache, run_id, (mtime, texts), _TEXTS_CACHE_MAX)
        return texts

    def text_index(self, run_ids: list[str]) -> dict:
        """Available text entries per run, WITHOUT the bodies:
        {run_id: {display_name, tags: {tag: [{step, wall_time, chars}]}}}."""
        out: dict = {}
        for rid in run_ids:
            texts = self._texts(rid)
            if not texts:
                continue
            idx = self._index(rid) or {}
            tag_map = {}
            for tag, by_step in texts.items():
                entries = [
                    {"step": int(s), "wall_time": e.get("wall_time", 0.0), "chars": len(e.get("text", ""))}
                    for s, e in by_step.items()
                ]
                entries.sort(key=lambda x: x["step"])
                tag_map[tag] = entries
            out[rid] = {"display_name": idx.get("display_name", rid), "tags": tag_map}
        return out

    def get_text(self, run_id: str, tag: str, step: int) -> str | None:
        entry = self._texts(run_id).get(tag, {}).get(str(step))
        return entry.get("text") if entry else None
