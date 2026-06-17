"""Command line entrypoints for tb_like.

Primary usage — just point it at a folder of runs and open the dashboard:

    tblike <runs_dir> [--port 8000] [--jobs 8]

The background watcher converts runs to Parquet automatically and keeps the
cache in sync. Advanced/scriptable subcommands are also available:

    tblike convert <run_dir> [run_id]   # ingest one run -> parquet (one-off)
    tblike scan                         # one incremental ingest pass, no server
    tblike build-runs --count 200       # make symlinked test runs (dev)
    tblike clone <src_run_id> --count N # fan a converted run out (dev)
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import sys
import time

from .convert import backfill_texts, convert_run, load_index, load_texts, meta_from_index
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


def cmd_backfill_text(args: argparse.Namespace) -> None:
    """Re-scan event files for text summaries (e.g. configs) and attach them to
    existing caches. For runs ingested before text support: scalars/Parquet are
    left untouched, so this is much cheaper than clearing and re-converting."""
    runs = discover_runs(args.runs_dir)
    if not runs:
        print(f"no runs found under {args.runs_dir}", file=sys.stderr)
        sys.exit(1)
    # Cache defaults to the serve convention: <runs_dir>/.tblike_cache.
    cache_dir = args.cache_dir or os.path.join(args.runs_dir, ".tblike_cache")
    print(f"backfilling text from {args.runs_dir} into {cache_dir} ({args.jobs} jobs)")
    done = skipped = 0
    for run_id, run_dir in runs:
        cache_run_dir = os.path.join(cache_dir, run_id)
        n = backfill_texts(
            run_dir, cache_run_dir,
            on_file=_file_progress(run_id), n_jobs=args.jobs, force=args.force,
        )
        if n < 0:
            skipped += 1
            reason = "no cache" if load_index(cache_run_dir) is None else "already has text"
            print(f"[{run_id}] skipped ({reason}; use --force to re-scan)")
        else:
            done += 1
            tags = sorted(load_texts(cache_run_dir).keys())
            print(f"[{run_id}] {n} text entries across {len(tags)} tag(s)")
    print(f"backfilled {done} run(s), skipped {skipped}")


def cmd_scan(args: argparse.Namespace) -> None:
    w = Watcher(args.runs_dir, args.cache_dir)
    runs = discover_runs(args.runs_dir)
    print(f"discovered {len(runs)} runs; scanning...")
    t0 = time.time()
    res = w.scan_once()
    print(f"scan done in {time.time()-t0:.1f}s: {res}")


DEFAULT_JOBS = max(1, (os.cpu_count() or 2) - 1)


def run_serve(argv: list[str]) -> None:
    import uvicorn

    p = argparse.ArgumentParser(
        prog="tblike",
        description="Serve the tb_like dashboard for a folder of runs (auto-ingests in the background).",
    )
    p.add_argument("runs_dir", help="folder containing run subdirs with events.out.tfevents.* files")
    p.add_argument("--port", type=int, default=8000)
    p.add_argument("--host", default="127.0.0.1")
    p.add_argument("--cache-dir", default=None,
                   help="Parquet cache directory (default: <runs_dir>/.tblike_cache)")
    p.add_argument("-j", "--jobs", type=int, default=DEFAULT_JOBS,
                   help=f"parallel parse workers for background conversion (default: {DEFAULT_JOBS})")
    p.add_argument("--interval", type=float, default=10.0, help="watcher poll interval, seconds")
    p.add_argument("--no-watch", action="store_true", help="serve only; do not ingest in the background")
    args = p.parse_args(argv)

    if not os.path.isdir(args.runs_dir):
        p.error(f"runs_dir not found: {args.runs_dir}")
    cache = args.cache_dir or os.path.join(args.runs_dir, ".tblike_cache")
    os.environ["TBLIKE_RUNS"] = os.path.abspath(args.runs_dir)
    os.environ["TBLIKE_CACHE"] = os.path.abspath(cache)
    os.environ["TBLIKE_WATCH"] = "0" if args.no_watch else "1"
    os.environ["TBLIKE_INTERVAL"] = str(args.interval)
    os.environ["TBLIKE_JOBS"] = str(args.jobs)
    print(f"tb_like → http://{args.host}:{args.port}   runs={args.runs_dir}  cache={cache}")
    uvicorn.run("tblike.server:app", host=args.host, port=args.port, reload=False)


def run_advanced(argv: list[str]) -> None:
    p = argparse.ArgumentParser(prog="tblike")
    p.add_argument("--runs-dir", default="runs")
    p.add_argument("--cache-dir", default="cache")
    sub = p.add_subparsers(dest="cmd", required=True)

    c = sub.add_parser("convert", help="ingest one run into parquet")
    c.add_argument("run_dir")
    c.add_argument("run_id", nargs="?")
    c.add_argument("-j", "--jobs", type=int, default=DEFAULT_JOBS,
                   help="parallel worker processes for event-file parsing")
    c.set_defaults(func=cmd_convert)

    s = sub.add_parser("scan", help="one incremental ingest pass, no server")
    s.set_defaults(func=cmd_scan)

    bt = sub.add_parser("backfill-text",
                        help="attach text summaries (configs) to existing caches")
    bt.add_argument("runs_dir", help="folder of runs (same one you serve)")
    bt.add_argument("--cache-dir", default=None,
                    help="Parquet cache dir (default: <runs_dir>/.tblike_cache)")
    bt.add_argument("-j", "--jobs", type=int, default=DEFAULT_JOBS,
                    help="parallel worker processes for the text re-scan")
    bt.add_argument("--force", action="store_true",
                    help="re-scan even runs that already have text")
    bt.set_defaults(func=cmd_backfill_text)

    b = sub.add_parser("build-runs", help="create symlinked test runs (dev)")
    b.add_argument("--source", default="data")
    b.add_argument("--count", type=int, default=200)
    b.add_argument("--prefix", default="run_")
    b.set_defaults(func=cmd_build_runs)

    cl = sub.add_parser("clone", help="fan a converted run out into N runs (dev)")
    cl.add_argument("src_run_id")
    cl.add_argument("--count", type=int, default=200)
    cl.add_argument("--prefix", default="run_")
    cl.set_defaults(func=cmd_clone)

    args = p.parse_args(argv)
    args.func(args)


ADVANCED = {"convert", "scan", "backfill-text", "build-runs", "clone"}


def main(argv: list[str] | None = None) -> None:
    argv = list(sys.argv[1:] if argv is None else argv)
    if argv and argv[0] in ADVANCED:
        run_advanced(argv)            # power-user subcommands
    elif not argv or argv[0] in ("-h", "--help"):
        run_serve(["--help"])         # default command's help
    else:
        run_serve(argv)               # `tblike <runs_dir> [opts]`


if __name__ == "__main__":
    main()
