"""Command line entrypoints for tb_like.

    uv run tblike build-runs --count 200      # make symlinked test runs
    uv run tblike convert <run_dir> [run_id]  # ingest one run -> parquet
    uv run tblike clone <src_run_id> --count 200  # fan a converted run out (test)
    uv run tblike scan                        # one incremental watcher pass
    uv run tblike serve [--port 8000]         # dashboard + background watcher
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import sys
import time

from .convert import convert_run, load_index, meta_from_index
from .watcher import Watcher, discover_runs


def cmd_build_runs(args: argparse.Namespace) -> None:
    src = os.path.abspath(args.source)
    os.makedirs(args.runs_dir, exist_ok=True)
    for i in range(args.count):
        link = os.path.join(args.runs_dir, f"{args.prefix}{i:03d}")
        if os.path.islink(link) or os.path.exists(link):
            os.remove(link) if os.path.islink(link) else None
        if not os.path.exists(link):
            os.symlink(src, link)
    print(f"created {args.count} symlinked runs in {args.runs_dir}/ -> {src}")


def _file_progress(prefix: str):
    """Return an on_file(done, total, name) callback backed by a tqdm bar."""
    from tqdm import tqdm

    bar = {"t": None}

    def cb(done: int, total: int, name: str) -> None:
        if bar["t"] is None:
            bar["t"] = tqdm(total=total, desc=prefix, unit="file", dynamic_ncols=True)
        bar["t"].n = done
        bar["t"].refresh()
        if done >= total:
            bar["t"].close()

    return cb


def cmd_convert(args: argparse.Namespace) -> None:
    run_id = args.run_id or os.path.basename(os.path.normpath(args.run_dir))
    cache_run_dir = os.path.join(args.cache_dir, run_id)
    t0 = time.time()
    res = convert_run(
        args.run_dir, cache_run_dir, run_id,
        on_file=_file_progress(run_id), n_jobs=args.jobs,
    )
    dt = time.time() - t0
    print(
        f"[{run_id}] +{res.new_rows:,} rows (total {res.total_rows:,}), "
        f"{res.num_tags} tags, segment={res.segment} in {dt:.1f}s ({args.jobs} jobs)"
    )


def cmd_clone(args: argparse.Namespace) -> None:
    """Fan a single converted run out into N runs by hardlinking its Parquet.

    Used only for the scale test: the 200 runs are symlinks to identical bytes,
    so their columnar output is identical too. Hardlinks keep disk ~flat while
    giving each run its own independent index.json / display name.
    """
    src_dir = os.path.join(args.cache_dir, args.src_run_id)
    src_index = load_index(src_dir)
    if not src_index:
        print(f"source run {args.src_run_id!r} not converted yet", file=sys.stderr)
        sys.exit(1)
    src_data = os.path.join(src_dir, "data")
    segments = src_index.get("segments", [])

    for i in range(args.count):
        rid = f"{args.prefix}{i:03d}"
        dst = os.path.join(args.cache_dir, rid)
        dst_data = os.path.join(dst, "data")
        os.makedirs(dst_data, exist_ok=True)
        for seg in segments:
            link = os.path.join(dst_data, seg)
            if os.path.exists(link):
                os.remove(link)
            try:
                os.link(os.path.join(src_data, seg), link)  # hardlink, ~free
            except OSError:
                shutil.copy2(os.path.join(src_data, seg), link)
        idx = dict(src_index)
        idx["run_id"] = rid
        base = src_index.get("display_name", args.src_run_id)
        idx["display_name"] = f"{base} #{i:03d}"
        idx["source_dir"] = os.path.abspath(os.path.join(args.runs_dir, rid))
        with open(os.path.join(dst, "index.json"), "w") as fh:
            json.dump(idx, fh)
        with open(os.path.join(dst, "meta.json"), "w") as fh:
            json.dump(meta_from_index(idx), fh)
    print(f"cloned {args.src_run_id} -> {args.count} runs ({len(segments)} segments each)")


def cmd_scan(args: argparse.Namespace) -> None:
    w = Watcher(args.runs_dir, args.cache_dir)
    runs = discover_runs(args.runs_dir)
    print(f"discovered {len(runs)} runs; scanning...")
    t0 = time.time()
    res = w.scan_once()
    print(f"scan done in {time.time()-t0:.1f}s: {res}")


def cmd_serve(args: argparse.Namespace) -> None:
    import uvicorn

    os.environ.setdefault("TBLIKE_RUNS", args.runs_dir)
    os.environ.setdefault("TBLIKE_CACHE", args.cache_dir)
    uvicorn.run("tblike.server:app", host=args.host, port=args.port, reload=False)


def main(argv: list[str] | None = None) -> None:
    p = argparse.ArgumentParser(prog="tblike")
    p.add_argument("--runs-dir", default="runs")
    p.add_argument("--cache-dir", default="cache")
    sub = p.add_subparsers(dest="cmd", required=True)

    b = sub.add_parser("build-runs", help="create symlinked test runs")
    b.add_argument("--source", default="data")
    b.add_argument("--count", type=int, default=200)
    b.add_argument("--prefix", default="run_")
    b.set_defaults(func=cmd_build_runs)

    c = sub.add_parser("convert", help="ingest one run into parquet")
    c.add_argument("run_dir")
    c.add_argument("run_id", nargs="?")
    c.add_argument("-j", "--jobs", type=int, default=max(1, (os.cpu_count() or 2) - 1),
                   help="parallel worker processes for event-file parsing (default: ncpu-1)")
    c.set_defaults(func=cmd_convert)

    cl = sub.add_parser("clone", help="fan a converted run out into N runs (test)")
    cl.add_argument("src_run_id")
    cl.add_argument("--count", type=int, default=200)
    cl.add_argument("--prefix", default="run_")
    cl.set_defaults(func=cmd_clone)

    s = sub.add_parser("scan", help="one incremental ingest pass")
    s.set_defaults(func=cmd_scan)

    sv = sub.add_parser("serve", help="run the dashboard server")
    sv.add_argument("--host", default="127.0.0.1")
    sv.add_argument("--port", type=int, default=8000)
    sv.set_defaults(func=cmd_serve)

    args = p.parse_args(argv)
    args.func(args)


if __name__ == "__main__":
    main()
