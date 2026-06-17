"""Visual downsampling so we can plot long series cheaply.

LTTB (Largest-Triangle-Three-Buckets) keeps the visual shape of a curve with a
small, fixed number of points — far better than naive striding for noisy loss
curves, and orders of magnitude cheaper to render than the raw series.
"""

from __future__ import annotations

import numpy as np


def lttb(x: np.ndarray, y: np.ndarray, n_out: int) -> tuple[np.ndarray, np.ndarray]:
    """Downsample (x, y) to about `n_out` points using LTTB.

    `x` is assumed sorted ascending. Non-finite y (NaN/±Inf) are treated as 0
    for the area computation but their original value is preserved in the output
    (the read layer turns non-finite into nulls/gaps).
    """
    n = len(x)
    if n_out >= n or n_out < 3:
        return x, y

    x = x.astype(np.float64, copy=False)
    # Neutralize non-finite for area math so Inf can't overflow/dominate bucket
    # selection; the original y (incl. NaN/Inf) is what we return.
    yf = np.nan_to_num(y.astype(np.float64, copy=False), nan=0.0, posinf=0.0, neginf=0.0)

    sampled_idx = np.empty(n_out, dtype=np.int64)
    sampled_idx[0] = 0
    sampled_idx[-1] = n - 1

    # n_out - 2 interior buckets over the interior points [1, n-1).
    bucket_edges = np.linspace(1, n - 1, n_out - 1).astype(np.int64)

    a = 0  # index of the previously selected point
    for i in range(n_out - 2):
        lo, hi = bucket_edges[i], bucket_edges[i + 1]
        # Average point of the *next* bucket forms the far triangle vertex.
        nlo, nhi = bucket_edges[i + 1], bucket_edges[i + 2] if i + 2 < len(bucket_edges) else n
        avg_x = x[nlo:nhi].mean() if nhi > nlo else x[-1]
        avg_y = yf[nlo:nhi].mean() if nhi > nlo else yf[-1]

        ax, ay = x[a], yf[a]
        # Triangle area between point a, each candidate, and the next bucket avg.
        areas = np.abs(
            (ax - avg_x) * (yf[lo:hi] - ay) - (ax - x[lo:hi]) * (avg_y - ay)
        )
        chosen = lo + int(np.argmax(areas)) if hi > lo else lo
        sampled_idx[i + 1] = chosen
        a = chosen

    return x[sampled_idx], y[sampled_idx]
