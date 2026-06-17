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

from .convert import load_index, load_meta, load_texts
from .downsample import lttb


@dataclass
class RunInfo:
    run_id: str
    display_name: str
    num_tags: int
    num_rows: int
    num_event_files: int
    updated_at: float
    config: dict


class Store:
    def __init__(self, cache_dir: str):
        self.cache_dir = cache_dir
        self._index_cache: dict[str, tuple[float, dict]] = {}  # run_id -> (mtime, index)
        self._texts_cache: dict[str, tuple[float, dict]] = {}  # run_id -> (mtime, texts)

    # ---- discovery -------------------------------------------------------
    def run_ids(self) -> list[str]:
        if not os.path.isdir(self.cache_dir):
            return []
        out = []
        for name in os.listdir(self.cache_dir):
            if os.path.exists(os.path.join(self.cache_dir, name, "index.json")):
                out.append(name)
        return sorted(out)

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
            self._index_cache[run_id] = (mtime, idx)
        return idx

    def list_runs(self) -> list[RunInfo]:
        # Uses the small meta.json per run, so listing 200+ runs stays fast and
        # never parses the multi-MB tags map.
        runs = []
        for rid in self.run_ids():
            m = load_meta(os.path.join(self.cache_dir, rid))
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
                )
            )
        return runs

    def tags_for(self, run_ids: list[str]) -> dict[str, dict]:
        """Union of tags across the given runs, with merged step ranges."""
        merged: dict[str, dict] = {}
        for rid in run_ids:
            idx = self._index(rid)
            if not idx:
                continue
            for tag, st in idx.get("tags", {}).items():
                m = merged.get(tag)
                if m is None:
                    merged[tag] = {
                        "min_step": st.get("min_step", 0),
                        "max_step": st.get("max_step", 0),
                        "runs": 1,
                    }
                else:
                    m["min_step"] = min(m["min_step"], st.get("min_step", 0))
                    m["max_step"] = max(m["max_step"], st.get("max_step", 0))
                    m["runs"] += 1
        return merged

    # ---- series reads ----------------------------------------------------
    def _segment_paths(self, run_id: str) -> list[str]:
        idx = self._index(run_id)
        if not idx:
            return []
        base = os.path.join(self.cache_dir, run_id, "data")
        return [os.path.join(base, s) for s in idx.get("segments", [])]

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
        idx = self._index(rid)
        if not idx:
            return []
        display = idx.get("display_name", rid)
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
            if max_points and count > max_points:
                ds, vs = lttb(steps.astype(np.float64), values, max_points)
                # Map downsampled steps back to nearest wall_time for x-axis options.
                wsel = np.interp(ds, steps.astype(np.float64), walls)
                steps_out, values_out, walls_out = ds.astype(np.int64), vs, wsel
            else:
                steps_out, values_out, walls_out = steps, values, walls
            items.append(
                {
                    "run_id": rid,
                    "display_name": display,
                    "tag": tag_name,
                    "steps": steps_out.tolist(),
                    "values": [None if np.isnan(v) else float(v) for v in values_out],
                    "wall_time": walls_out.tolist(),
                    "count": int(count),
                }
            )
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
        self._texts_cache[run_id] = (mtime, texts)
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
