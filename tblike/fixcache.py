"""Rewrite an existing cache in place to merge timestamp-split nested tags.

Earlier versions prefixed nested event files (e.g. an autometrics eval logged
under ``metrics/<timestamp>/autometrics/...``) with their FULL subpath, so the
same metric logged under each eval folder became a separate single-point tag —
``metrics/20260618_101116_148035/autometrics/acc`` vs
``metrics/20260626_113351_772697/autometrics/acc`` — instead of one series.

Newer ingestion drops timestamp/run-id directory levels from the tag prefix
(see :func:`tblike.events._clean_prefix`). This script applies the same fix to a
cache that was already built, WITHOUT re-reading any tfevents: it only rewrites
the ``tag`` column of each Parquet segment and the small JSON sidecars. That's
I/O over the (compact, downsampled) cache — orders of magnitude cheaper than a
full reconvert — and it only touches runs that actually have such tags.

Usage::

    python -m tblike.fixcache <cache_dir> [--jobs N] [--dry-run]

``<cache_dir>`` defaults to the serve convention if you pass a runs dir that
contains a ``.tblike_cache``. Re-running is a cheap no-op (tags already clean).
"""

from __future__ import annotations

import argparse
import os

import polars as pl

from .convert import (
    ROW_GROUP_SIZE,
    _atomic_write_json,
    _load_texts,
    _write_index,
    _write_tag_names,
    load_index,
    normalize_texts,
)
from .events import _ID_DIR


def _clean_tag(tag: str) -> str:
    """Drop timestamp/run-id path components (pure digits/underscores, >=8 digits)
    from a tag — the same rule ingestion applies to the nested-file prefix."""
    parts = [p for p in tag.split("/") if not (_ID_DIR.match(p) and len(p.replace("_", "")) >= 8)]
    cleaned = "/".join(parts)
    return cleaned or tag  # never collapse a tag to nothing


def _rename_map(tags) -> dict:
    """{old_tag: new_tag} for only the tags whose name actually changes."""
    out = {}
    for t in tags:
        nt = _clean_tag(t)
        if nt != t:
            out[t] = nt
    return out


def _merge_stats(tags: dict) -> dict:
    """Fold the per-tag index stats under their cleaned names."""
    new: dict = {}
    for old, st in tags.items():
        nt = _clean_tag(old)
        cur = new.get(nt)
        if cur is None:
            new[nt] = dict(st)
        else:
            cur["count"] = cur.get("count", 0) + st.get("count", 0)
            if st.get("min_step") is not None:
                cur["min_step"] = min(cur.get("min_step", st["min_step"]), st["min_step"])
            if st.get("max_step") is not None:
                if st["max_step"] >= cur.get("max_step", st["max_step"]):
                    cur["last_value"] = st.get("last_value", cur.get("last_value"))
                cur["max_step"] = max(cur.get("max_step", st["max_step"]), st["max_step"])
    return new


def _rewrite_segment(seg_path: str, rename: dict) -> None:
    """Rewrite one Parquet segment's tag column, re-sorting + de-duping (tag,step)."""
    df = pl.read_parquet(seg_path)
    df = df.with_columns(pl.col("tag").replace(rename))
    df = df.sort(["tag", "step", "wall_time"]).unique(
        subset=["tag", "step"], keep="last", maintain_order=True
    )
    tmp = seg_path + ".tmp"
    df.write_parquet(tmp, statistics=True, row_group_size=ROW_GROUP_SIZE)
    os.replace(tmp, seg_path)  # atomic


def fix_run(cache_run_dir: str, dry_run: bool = False) -> dict:
    """Fix one run's cache in place. Returns a small summary dict."""
    index = load_index(cache_run_dir)
    if index is None:
        return {"run": os.path.basename(cache_run_dir), "skipped": "no index", "tags_merged": 0}

    rename = _rename_map(index.get("tags", {}).keys())
    if not rename:
        return {"run": index.get("run_id", os.path.basename(cache_run_dir)),
                "tags_renamed": 0, "tags_merged": 0}

    old_n = len(index.get("tags", {}))
    new_n = len({_clean_tag(t) for t in index["tags"]})
    segments = index.get("segments", [])
    summary = {"run": index.get("run_id"), "tags_renamed": len(rename),
               "tags_merged": old_n - new_n, "segments": len(segments)}
    if dry_run:
        return {**summary, "dry_run": True}

    # 1) rewrite each Parquet segment's tag column
    for seg in segments:
        seg_path = os.path.join(cache_run_dir, "data", seg)
        if os.path.exists(seg_path):
            _rewrite_segment(seg_path, rename)

    # 2) fold the index tag-stats under their cleaned names
    index["tags"] = _merge_stats(index["tags"])

    # 3) rename text-summary tags (configs) too, merging any collisions
    texts = normalize_texts(_load_texts(cache_run_dir))
    if texts:
        new_texts: dict = {}
        for tag, entries in texts.items():
            new_texts.setdefault(_clean_tag(tag), []).extend(entries)
        for v in new_texts.values():
            v.sort(key=lambda e: e.get("step", 0))
        _atomic_write_json(os.path.join(cache_run_dir, "texts.json"), new_texts)
        index["text_tags"] = sorted(new_texts.keys())

    # 4) rewrite index.json + meta.json (recomputed) + tags.txt sidecar
    _write_index(cache_run_dir, index)
    try:
        _write_tag_names(cache_run_dir, index["tags"].keys())
    except OSError:
        pass

    return summary


def fix_cache(cache_dir: str, jobs: int = 1, dry_run: bool = False) -> list[dict]:
    """Fix every run cache under ``cache_dir``."""
    run_dirs = [
        os.path.join(cache_dir, name)
        for name in sorted(os.listdir(cache_dir))
        if os.path.isdir(os.path.join(cache_dir, name))
        and os.path.exists(os.path.join(cache_dir, name, "index.json"))
    ]
    if jobs == 1:
        return [fix_run(d, dry_run) for d in run_dirs]
    from joblib import Parallel, delayed
    return list(Parallel(n_jobs=jobs)(delayed(fix_run)(d, dry_run) for d in run_dirs))


def main() -> None:
    ap = argparse.ArgumentParser(description="Merge timestamp-split nested tags in an existing tb_like cache, in place.")
    ap.add_argument("cache_dir", help="cache dir, or a runs dir containing .tblike_cache")
    ap.add_argument("--jobs", type=int, default=1, help="parallel runs (default 1)")
    ap.add_argument("--dry-run", action="store_true", help="report what would change without writing")
    args = ap.parse_args()

    cache_dir = args.cache_dir
    if not os.path.exists(os.path.join(cache_dir, "")) or not any(
        os.path.exists(os.path.join(cache_dir, d, "index.json"))
        for d in (os.listdir(cache_dir) if os.path.isdir(cache_dir) else [])
    ):
        alt = os.path.join(cache_dir, ".tblike_cache")
        if os.path.isdir(alt):
            cache_dir = alt
    if not os.path.isdir(cache_dir):
        raise SystemExit(f"not a directory: {cache_dir}")

    print(f"{'(dry run) ' if args.dry_run else ''}fixing cache: {cache_dir}")
    results = fix_cache(cache_dir, jobs=args.jobs, dry_run=args.dry_run)
    total_renamed = sum(r.get("tags_renamed", 0) for r in results)
    changed = [r for r in results if r.get("tags_renamed", 0)]
    for r in changed:
        print(f"  {r.get('run')}: renamed {r['tags_renamed']} tags "
              f"(−{r.get('tags_merged', 0)} after merge) across {r.get('segments', 0)} segment(s)"
              + (" [dry run]" if r.get("dry_run") else ""))
    print(f"done: {len(changed)}/{len(results)} run(s) changed, {total_renamed} tags renamed"
          + (" (nothing written — dry run)" if args.dry_run else ""))


if __name__ == "__main__":
    main()
