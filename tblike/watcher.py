"""Background ingestion: keep the Parquet cache in sync with the run dirs.

A single daemon thread periodically scans the runs directory. For each run it
computes a cheap signature (event-file count + newest mtime); only when that
changes does it call the incremental converter. New runs are discovered
automatically. Conversions run sequentially in the worker so the box is never
saturated, and `index.json` writes are atomic so readers are never disrupted.
"""

from __future__ import annotations

import os
import threading
import time
import traceback

from .convert import convert_run
from .events import list_event_files


def discover_runs(runs_dir: str) -> list[tuple[str, str]]:
    """Return (run_id, run_dir) for every immediate subdir holding event files.

    Symlinked run dirs are followed (used by the test harness).
    """
    out = []
    if not os.path.isdir(runs_dir):
        return out
    for name in sorted(os.listdir(runs_dir)):
        path = os.path.join(runs_dir, name)
        if not os.path.isdir(path):  # follows symlinks
            continue
        if list_event_files(path):
            out.append((name, path))
    return out


def _signature(run_dir: str) -> tuple[int, float]:
    files = list_event_files(run_dir)
    latest = 0.0
    for f in files:
        try:
            latest = max(latest, os.path.getmtime(f))
        except OSError:
            pass
    return (len(files), latest)


class Watcher:
    def __init__(self, runs_dir: str, cache_dir: str, interval: float = 10.0, jobs: int = 1):
        self.runs_dir = runs_dir
        self.cache_dir = cache_dir
        self.interval = interval
        self.jobs = jobs
        self._sigs: dict[str, tuple[int, float]] = {}
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None
        self.last_scan: dict = {"at": 0.0, "converted": 0, "runs": 0, "errors": 0}

    # ---- lifecycle -------------------------------------------------------
    def start(self) -> None:
        if self._thread and self._thread.is_alive():
            return
        self._thread = threading.Thread(target=self._loop, name="tblike-watcher", daemon=True)
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()

    def _loop(self) -> None:
        while not self._stop.is_set():
            try:
                self.scan_once()
            except Exception:  # never let the watcher die
                traceback.print_exc()
            self._stop.wait(self.interval)

    # ---- work ------------------------------------------------------------
    def scan_once(self) -> dict:
        converted = errors = 0
        runs = discover_runs(self.runs_dir)
        for run_id, run_dir in runs:
            sig = _signature(run_dir)
            cache_run_dir = os.path.join(self.cache_dir, run_id)
            has_cache = os.path.exists(os.path.join(cache_run_dir, "index.json"))
            if has_cache and self._sigs.get(run_id) == sig:
                continue  # nothing changed since last successful pass
            try:
                res = convert_run(run_dir, cache_run_dir, run_id, n_jobs=self.jobs)
                self._sigs[run_id] = sig
                if res.new_rows or not has_cache:
                    converted += 1
            except Exception:
                errors += 1
                traceback.print_exc()
        self.last_scan = {
            "at": time.time(),
            "converted": converted,
            "runs": len(runs),
            "errors": errors,
        }
        return self.last_scan
