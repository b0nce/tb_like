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
at a directory of runs:

```
my_runs/
  run_a/  events.out.tfevents.*  config.yaml
  run_b/  events.out.tfevents.*
  ...
```

Convert and serve:

```bash
# ingest one run -> cache/<run_id>/  (parallel parse + progress bar)
tblike convert my_runs/run_a run_a

# launch the dashboard + background watcher
tblike serve --runs-dir my_runs --cache-dir cache --port 8000
# open http://127.0.0.1:8000
```

The server's background watcher discovers runs under `--runs-dir`, converts any
that changed, and serves them. You can also pre-convert everything with `tblike scan`.

## Dashboard features

- Hierarchical, searchable **tag tree** (regex filter) with smart grouping:
  path compression of `a.b.c` chains, numeric-enumeration collapsing
  (`…expert_idx_∗`), and layer indices kept as their own levels.
- Multi-run overlay, unified hover, EMA smoothing, log-y, step vs. relative-time
  x-axis, and **outlier clipping** by value percentiles.
- Collapsible per-group chart sections, resizable sidebar, and a one-click
  **Refresh selected** that re-ingests from disk and rebuilds the plots.

## CLI

```
tblike build-runs --source DATA --count N   # make N symlinked test runs from one
tblike convert RUN_DIR [RUN_ID] [-j JOBS]   # ingest one run into Parquet
tblike scan                                 # one incremental ingest pass over all runs
tblike serve [--host H] [--port P]          # dashboard + background watcher
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
