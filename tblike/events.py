"""Low-level reading of TensorBoard event files (`events.out.tfevents.*`).

We only care about scalar summaries. Modern TensorBoard writes scalars as
rank-0 `TensorProto`s (not the legacy `simple_value`), so we decode both.

Event files are append-only TFRecord streams. A run is usually made of many
of them (one per process restart / resume), often with overlapping steps.
Ingestion is incremental: we remember, per source file, its byte size and how
many records we have already consumed, so a re-scan only emits new data.
"""

from __future__ import annotations

import glob
import mmap
import os
import struct
from dataclasses import dataclass, field
from typing import Iterator

from google.protobuf.message import DecodeError
from tensorboard.compat.proto import event_pb2, types_pb2
from tensorboard.util import tensor_util

EVENT_GLOB = "events.out.tfevents.*"

_Event = event_pb2.Event


def iter_event_records(path: str) -> Iterator[bytes]:
    """Yield raw Event-proto payloads from a TFRecord event file.

    TensorBoard's own ``EventFileLoader`` is ~25x slower here — it does Python-
    level reads and CRC checks per record. The TFRecord framing is just
    ``len(u64) | crc(u32) | data | crc(u32)``, so we mmap the file and slice by
    the length prefix. CRCs are skipped; a truncated tail (file still being
    written) or a bad length simply stops iteration cleanly.
    """
    with open(path, "rb") as fh:
        try:
            mm = mmap.mmap(fh.fileno(), 0, access=mmap.ACCESS_READ)
        except ValueError:
            return  # empty file
        try:
            n = len(mm)
            i = 0
            while i + 12 <= n:
                length = struct.unpack_from("<Q", mm, i)[0]
                start = i + 12               # skip length(8) + its crc(4)
                end = start + length
                if end + 4 > n:
                    break                    # truncated / partially written record
                yield mm[start:end]
                i = end + 4                  # skip data + its crc(4)
        finally:
            mm.close()


def _event_from_bytes(data: bytes):
    """Parse one Event proto; return None on corruption (treat as end-of-stream)."""
    try:
        return _Event.FromString(data)
    except (DecodeError, ValueError):
        return None

# DataType enum values for the float/int tensors we accept as scalars.
_NUMERIC_DTYPES = frozenset(
    {
        types_pb2.DT_FLOAT, types_pb2.DT_DOUBLE, types_pb2.DT_BFLOAT16, types_pb2.DT_HALF,
        types_pb2.DT_INT8, types_pb2.DT_INT16, types_pb2.DT_INT32, types_pb2.DT_INT64,
        types_pb2.DT_UINT8, types_pb2.DT_UINT16, types_pb2.DT_UINT32, types_pb2.DT_UINT64,
    }
)


@dataclass
class ScalarRow:
    __slots__ = ("tag", "step", "wall_time", "value")
    tag: str
    step: int
    wall_time: float
    value: float


@dataclass
class FileState:
    """How much of one event file we have already ingested."""

    size: int = 0
    records: int = 0  # number of Event records consumed


@dataclass
class RunIngestState:
    """Per-run ingestion bookkeeping, persisted in the run's index.json."""

    files: dict[str, FileState] = field(default_factory=dict)

    @classmethod
    def from_dict(cls, d: dict | None) -> "RunIngestState":
        st = cls()
        for name, fs in (d or {}).get("files", {}).items():
            st.files[name] = FileState(size=fs.get("size", 0), records=fs.get("records", 0))
        return st

    def to_dict(self) -> dict:
        return {"files": {n: {"size": fs.size, "records": fs.records} for n, fs in self.files.items()}}


def list_event_files(run_dir: str) -> list[str]:
    """Event files for a run, sorted by name (their suffix is monotonic)."""
    return sorted(glob.glob(os.path.join(run_dir, EVENT_GLOB)))


def _decode_scalar(value) -> float | None:
    kind = value.WhichOneof("value")
    if kind == "simple_value":
        return float(value.simple_value)
    if kind == "tensor":
        # Only rank-0 numeric tensors are scalars. Text/string summaries (e.g. the
        # logged config), histograms and images all arrive as tensors too.
        if value.tensor.dtype not in _NUMERIC_DTYPES:
            return None
        arr = tensor_util.make_ndarray(value.tensor)
        if arr.size == 1:
            return float(arr.reshape(-1)[0])
        return None  # non-scalar tensors (histograms, images, ...) are ignored
    return None


def _decode_text(value) -> str | None:
    """Decode a text summary (string tensor, e.g. a logged config) to str."""
    if value.WhichOneof("value") != "tensor":
        return None
    if value.tensor.dtype != types_pb2.DT_STRING:
        return None
    arr = tensor_util.make_ndarray(value.tensor)
    if arr.size == 0:
        return None
    parts = []
    for s in arr.reshape(-1):
        parts.append(s.decode("utf-8", "replace") if isinstance(s, bytes) else str(s))
    return "\n".join(parts)


def plan_files(run_dir: str, state: RunIngestState) -> tuple[list[tuple[str, int]], int]:
    """Decide which event files need (re)parsing for an incremental pass.

    Returns ``(tasks, n_total)`` where each task is ``(path, already_records)``
    for a new/grown file, and ``n_total`` is the full event-file count (so a
    progress bar can also account for the cheaply skipped, unchanged files).
    """
    tasks: list[tuple[str, int]] = []
    files = list_event_files(run_dir)
    for path in files:
        try:
            size = os.path.getsize(path)
        except OSError:
            continue
        fs = state.files.get(os.path.basename(path))
        if fs is not None and size <= fs.size:
            continue  # unchanged -> nothing new
        tasks.append((path, fs.records if fs is not None else 0))
    return tasks, len(files)


def parse_file(path: str, already: int = 0) -> dict:
    """Parse one event file, skipping the first ``already`` records.

    Top-level and picklable so it can run in a joblib worker process. Returns
    a columnar dict; the caller updates ingest state from ``size``/``records``.
    """
    tags: list[str] = []
    steps: list[int] = []
    walls: list[float] = []
    vals: list[float] = []
    texts: list[tuple[str, int, float, str]] = []  # (tag, step, wall_time, text)
    seen = 0
    for data in iter_event_records(path):
        seen += 1
        if seen <= already:
            continue
        ev = _event_from_bytes(data)
        if ev is None:
            break  # corruption -> stop (next pass re-reads from `already`)
        if not ev.HasField("summary"):
            continue
        for v in ev.summary.value:
            val = _decode_scalar(v)
            if val is not None:
                tags.append(v.tag)
                steps.append(int(ev.step))
                walls.append(float(ev.wall_time))
                vals.append(val)
                continue
            txt = _decode_text(v)
            if txt is not None:
                texts.append((v.tag, int(ev.step), float(ev.wall_time), txt))
    try:
        size = os.path.getsize(path)
    except OSError:
        size = 0
    return {
        "name": os.path.basename(path),
        "size": size,
        "records": seen,
        "tags": tags,
        "steps": steps,
        "walls": walls,
        "vals": vals,
        "texts": texts,
    }


def parse_texts(path: str, head_records: int = 512, gap: int = 512) -> dict:
    """Scan one event file for text summaries only (e.g. a logged config).

    Top-level/picklable for joblib. Ignores ingest state and scalars entirely,
    so it can backfill text for runs ingested before text support existed
    without re-parsing or rewriting their Parquet.

    Text summaries (configs) are written near the *start* of each event file,
    before the bulk of scalars. To avoid draining millions of scalar records,
    by default we stop a file after ``head_records`` if no text has appeared,
    and ``gap`` records after the last text once some has. Pass
    ``head_records=0`` and ``gap=0`` for an exhaustive scan. Returns
    ``{"name", "texts": [(tag, step, wall_time, text), ...]}``.
    """
    texts: list[tuple[str, int, float, str]] = []
    seen = since = 0
    found = False
    for data in iter_event_records(path):
        seen += 1
        ev = _event_from_bytes(data)
        if ev is None:
            break
        got = False
        if ev.HasField("summary"):
            for v in ev.summary.value:
                txt = _decode_text(v)
                if txt is not None:
                    texts.append((v.tag, int(ev.step), float(ev.wall_time), txt))
                    got = True
        if got:
            found, since = True, 0
        else:
            since += 1
        if head_records and not found and seen >= head_records:
            break  # no text in this file's head -> assume none (scalar-only file)
        if gap and found and since >= gap:
            break  # passed the text block at the file's start
    return {"name": os.path.basename(path), "texts": texts}


def iter_new_scalars(run_dir: str, state: RunIngestState, on_file=None) -> Iterator[ScalarRow]:
    """Yield scalar rows that have NOT been ingested yet, updating `state`.

    Strategy per file:
      * unchanged size  -> skip entirely (fast path, the common case),
      * grown / new     -> read sequentially, skip the first `records` events,
                           emit the rest, and bump the recorded size/record count.

    This makes a re-scan O(new data) rather than O(all data).

    `on_file(done, total, basename)` is called after each event file is handled,
    enabling a progress bar.
    """
    files = list_event_files(run_dir)
    total = len(files)
    for fi, path in enumerate(files):
        name = os.path.basename(path)
        try:
            size = os.path.getsize(path)
        except OSError:
            if on_file:
                on_file(fi + 1, total, name)
            continue
        fs = state.files.get(name)
        if fs is not None and size <= fs.size:
            if on_file:
                on_file(fi + 1, total, name)  # nothing new in this file
            continue

        already = fs.records if fs is not None else 0
        seen = 0
        for data in iter_event_records(path):
            seen += 1
            if seen <= already:
                continue
            ev = _event_from_bytes(data)
            if ev is None:
                break
            if not ev.HasField("summary"):
                continue
            for v in ev.summary.value:
                val = _decode_scalar(v)
                if val is None:
                    continue
                yield ScalarRow(tag=v.tag, step=int(ev.step), wall_time=float(ev.wall_time), value=val)
        state.files[name] = FileState(size=size, records=seen)
        if on_file:
            on_file(fi + 1, total, name)
