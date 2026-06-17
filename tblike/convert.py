"""Convert a run's TensorBoard event files into columnar Parquet.

Per run we keep a small cache directory::

    cache/<run_id>/
        data/seg-00000.parquet   # one segment per ingest pass (immutable)
        data/seg-00001.parquet
        index.json               # tags, per-file ingest state, metadata

Each Parquet segment is sorted by (tag, step) and written with statistics so a
reader filtering on `tag` only touches the relevant row groups. Incremental
updates append a new segment containing just the freshly seen rows; the reader
unions all segments and de-duplicates (tag, step) at query time.
"""

from __future__ import annotations

import json
import os
import time
from dataclasses import dataclass

import polars as pl

from .events import FileState, RunIngestState, list_event_files, parse_file, plan_files

ROW_GROUP_SIZE = 256_000

# Top-level config.yaml keys worth surfacing as run metadata.
CONFIG_KEYS = (
    "exp_name", "run_name", "user", "global_seed", "seed",
    "max_seq_len", "tensorboard_path", "save_folder",
)


@dataclass
class ConvertResult:
    run_id: str
    new_rows: int
    total_rows: int
    num_tags: int
    segment: str | None


def _shallow_yaml(path: str) -> dict:
    """Parse top-level `key: value` pairs from a config.yaml (no deps).

    Nested/indented lines are skipped; that is fine for metadata display.
    """
    out: dict[str, str] = {}
    try:
        with open(path, "r", errors="replace") as fh:
            for line in fh:
                if not line.strip() or line[0] in " \t#":
                    continue
                if ":" not in line:
                    continue
                key, _, val = line.partition(":")
                key = key.strip()
                val = val.strip().strip("'\"")
                if key and val:
                    out[key] = val
    except OSError:
        pass
    return out


def load_index(cache_run_dir: str) -> dict | None:
    p = os.path.join(cache_run_dir, "index.json")
    if not os.path.exists(p):
        return None
    try:
        with open(p) as fh:
            return json.load(fh)
    except (OSError, json.JSONDecodeError):
        return None


def _load_texts(cache_run_dir: str) -> dict:
    p = os.path.join(cache_run_dir, "texts.json")
    if not os.path.exists(p):
        return {}
    try:
        with open(p) as fh:
            return json.load(fh)
    except (OSError, json.JSONDecodeError):
        return {}


def load_texts(cache_run_dir: str) -> dict:
    """Public read of a run's text summaries: {tag: {step: {wall_time, text}}}."""
    return _load_texts(cache_run_dir)


def load_meta(cache_run_dir: str) -> dict | None:
    """Read the small per-run meta.json, lazily creating it from index.json
    for caches written before the split (one-time, cheap thereafter)."""
    p = os.path.join(cache_run_dir, "meta.json")
    if os.path.exists(p):
        try:
            with open(p) as fh:
                return json.load(fh)
        except (OSError, json.JSONDecodeError):
            pass
    idx = load_index(cache_run_dir)
    if idx is None:
        return None
    meta = meta_from_index(idx)
    try:
        _atomic_write_json(p, meta)
    except OSError:
        pass
    return meta


# Keys surfaced in the lightweight per-run meta.json (read for run listing, so
# the dashboard never has to parse the multi-MB tags map just to show the list).
META_KEYS = ("run_id", "display_name", "num_rows", "num_event_files", "updated_at", "config", "text_tags")


def meta_from_index(index: dict) -> dict:
    m = {k: index.get(k) for k in META_KEYS}
    m["num_tags"] = len(index.get("tags", {}))
    return m


def _atomic_write_json(path: str, obj: dict) -> None:
    tmp = path + ".tmp"
    with open(tmp, "w") as fh:
        json.dump(obj, fh)
    os.replace(tmp, path)  # atomic so a concurrent reader never sees half a file


def _write_index(cache_run_dir: str, index: dict) -> None:
    _atomic_write_json(os.path.join(cache_run_dir, "meta.json"), meta_from_index(index))
    _atomic_write_json(os.path.join(cache_run_dir, "index.json"), index)


def _merge_tag_stats(existing: dict, df: pl.DataFrame) -> dict:
    """Fold a new segment's per-tag stats into the running index."""
    agg = (
        df.group_by("tag")
        .agg(
            count=pl.len(),
            min_step=pl.col("step").min(),
            max_step=pl.col("step").max(),
            last_value=pl.col("value").last(),
        )
        .to_dicts()
    )
    for row in agg:
        tag = row["tag"]
        cur = existing.get(tag)
        if cur is None:
            existing[tag] = {
                "count": row["count"],
                "min_step": row["min_step"],
                "max_step": row["max_step"],
                "last_value": row["last_value"],
            }
        else:
            cur["count"] += row["count"]
            cur["min_step"] = min(cur["min_step"], row["min_step"])
            cur["max_step"] = max(cur["max_step"], row["max_step"])
            cur["last_value"] = row["last_value"]
    return existing


def convert_run(
    run_dir: str,
    cache_run_dir: str,
    run_id: str,
    display_name: str | None = None,
    on_file=None,
    n_jobs: int = 1,
) -> ConvertResult:
    """Ingest any new scalar data from `run_dir` into `cache_run_dir`.

    Idempotent and incremental: calling it again after new events were written
    only parses and stores the delta. `on_file(done, total, basename)` is invoked
    after each event file (for progress reporting). With ``n_jobs != 1`` the
    independent event files are parsed across processes via joblib.
    """
    os.makedirs(os.path.join(cache_run_dir, "data"), exist_ok=True)

    index = load_index(cache_run_dir) or {}
    state = RunIngestState.from_dict(index.get("ingest"))
    tags: dict = index.get("tags", {})
    segments: list[str] = index.get("segments", [])

    # Decide what to (re)parse; unchanged files are skipped without reading.
    tasks, n_total = plan_files(run_dir, state)
    done = n_total - len(tasks)  # cheaply skipped files already "done"
    if on_file and done:
        on_file(done, n_total, "")

    # Parse files (parallel or sequential), streaming results as they complete
    # so the progress bar tracks real progress. Each result is one columnar chunk.
    frames: list[pl.DataFrame] = []
    new_texts: list[tuple] = []  # (tag, step, wall_time, text) from text summaries

    def handle(res: dict) -> None:
        nonlocal done
        state.files[res["name"]] = FileState(size=res["size"], records=res["records"])
        if res.get("texts"):
            new_texts.extend(res["texts"])
        if res["steps"]:
            frames.append(
                pl.DataFrame(
                    {
                        "tag": pl.Series(res["tags"], dtype=pl.Utf8),
                        "step": pl.Series(res["steps"], dtype=pl.Int64),
                        "wall_time": pl.Series(res["walls"], dtype=pl.Float64),
                        "value": pl.Series(res["vals"], dtype=pl.Float32),
                    }
                )
            )
        done += 1
        if on_file:
            on_file(done, n_total, res["name"])

    if tasks:
        if n_jobs == 1:
            for path, already in tasks:
                handle(parse_file(path, already))
        else:
            from joblib import Parallel, delayed

            gen = Parallel(n_jobs=n_jobs, return_as="generator_unordered")(
                delayed(parse_file)(path, already) for path, already in tasks
            )
            for res in gen:
                handle(res)

    new_rows = sum(f.height for f in frames)
    segment_name: str | None = None

    if new_rows:
        df = pl.concat(frames, rechunk=True) if len(frames) > 1 else frames[0]
        # De-duplicate within this segment (a resumed file can repeat steps),
        # keeping the latest write by wall_time, then sort so row groups are
        # tag-contiguous (enables tag predicate pushdown on read).
        df = df.sort(["tag", "step", "wall_time"]).unique(
            subset=["tag", "step"], keep="last", maintain_order=True
        )
        new_rows = df.height
        segment_name = f"seg-{len(segments):05d}.parquet"
        df.write_parquet(
            os.path.join(cache_run_dir, "data", segment_name),
            statistics=True,
            row_group_size=ROW_GROUP_SIZE,
        )
        segments.append(segment_name)
        tags = _merge_tag_stats(tags, df)

    # Text summaries (e.g. the logged config) live in a small sidecar, keyed by
    # tag -> step. Merged across passes, last write wins.
    texts = _load_texts(cache_run_dir)
    for tag, step, wall, text in new_texts:
        texts.setdefault(tag, {})[str(step)] = {"wall_time": wall, "text": text}
    if new_texts:
        _atomic_write_json(os.path.join(cache_run_dir, "texts.json"), texts)

    # Metadata is (re)read cheaply each pass so config edits are picked up.
    config = _shallow_yaml(os.path.join(run_dir, "config.yaml"))
    meta_name = display_name or index.get("display_name") or config.get("run_name") or run_id

    total_rows = int(index.get("num_rows", 0)) + new_rows
    index.update(
        {
            "run_id": run_id,
            "display_name": meta_name,
            "source_dir": os.path.abspath(run_dir),
            "config": {k: config[k] for k in CONFIG_KEYS if k in config},
            "tags": tags,
            "segments": segments,
            "ingest": state.to_dict(),
            "num_rows": total_rows,
            "num_event_files": len(list_event_files(run_dir)),
            "text_tags": sorted(texts.keys()),
            "updated_at": time.time(),
        }
    )
    _write_index(cache_run_dir, index)

    return ConvertResult(
        run_id=run_id,
        new_rows=new_rows,
        total_rows=total_rows,
        num_tags=len(tags),
        segment=segment_name,
    )
