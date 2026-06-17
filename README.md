# tb_like

A faster, **columnar** TensorBoard-style scalar viewer — built for **many series and many runs**.

TensorBoard re-parses event files on demand and gets slow when a run has tens of
thousands of scalar series across hundreds of experiments. `tb_like` instead
converts TensorBoard event files into per-run **Parquet** once, then serves
downsampled series on demand to a fast Plotly dashboard. New events are picked
up incrementally in the background.

## Why it's fast

- **Convert once, read many.** Each run's `events.out.tfevents.*` are parsed into
  a columnar Parquet file sorted by `(tag, step)`, with row-group statistics so a
  query for a few tags only touches the matching row groups — even when a run has
  ~18k series.
- **Incremental & idempotent.** Ingestion tracks each event file's size and record
  count, so re-scans only parse new data. A background watcher keeps the cache in
  sync; parsing is parallelized across event files with `joblib`.
- **Lazy, prioritized rendering.** The dashboard renders charts only as they
  scroll into view, fetched through a priority queue (visible first, then
  neighbors, biased toward the scroll direction).
- **LTTB downsampling** keeps long curves cheap to draw without losing their shape.

## Install

```bash
pip install tb-like
# or
uv tool install tb-like
```

## Quick start

A "run" is a directory containing `events.out.tfevents.*` files. Point `tb_like`
at a directory of runs and open the dashboard — that's it:

```
my_runs/
  run_a/  events.out.tfevents.*  config.yaml
  run_b/  events.out.tfevents.*
  ...
```

```bash
tblike my_runs --port 8000 --jobs 8
# open http://127.0.0.1:8000
```

The background watcher discovers runs under the folder, converts any that
changed to Parquet (parsing event files across `--jobs` worker processes), keeps
the cache in sync, and serves them — no separate build step. The cache lives in
`<runs_dir>/.tblike_cache` by default (override with `--cache-dir`).

## Dashboard features

- Hierarchical, searchable **tag tree** (regex filter) with smart grouping:
  path compression of `a.b.c` chains, numeric-enumeration collapsing
  (`…expert_idx_∗`), and layer indices kept as their own levels.
- Multi-run overlay, unified hover, EMA smoothing, log-y, step vs. relative-time
  x-axis, and **outlier clipping** by value percentiles.
- Collapsible per-group chart sections, resizable sidebar, and a one-click
  **Refresh selected** that re-ingests from disk and rebuilds the plots.
- **Text diff** panel (pinned at the bottom): compare logged text summaries —
  typically the run config — between any two runs/steps as a git-style diff.

> Text summaries are ingested as event files are parsed, so new runs get them
> automatically. For runs converted by an older version (before text support),
> attach text without re-parsing scalars by running
> `tblike backfill-text <runs_dir>` — or just hit **Refresh selected** in the UI,
> which backfills any selected run that's missing text.

## CLI

```
tblike <runs_dir> [--port P] [--host H] [--cache-dir D] [-j JOBS] [--no-watch]
                                            # the main command: serve + auto-ingest
```

Advanced / scriptable subcommands:

```
tblike convert RUN_DIR [RUN_ID] [-j JOBS]   # ingest one run into Parquet (one-off)
tblike scan                                 # one incremental ingest pass, no server
tblike backfill-text RUNS_DIR [-j JOBS]     # attach text (configs) to old caches
```

## How it stores data

```
cache/<run_id>/
    data/seg-00000.parquet   # one immutable segment per ingest pass
    index.json               # tags, per-file ingest state, metadata
    meta.json                # tiny summary used for fast run listing
```

Reads union all segments and de-duplicate `(tag, step)` by latest `wall_time`.

## License

MIT — see [LICENSE](LICENSE).
