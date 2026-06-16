"""tb_like: a faster, columnar TensorBoard-style scalar viewer.

Pipeline: TensorBoard event files -> per-run columnar Parquet -> on-demand,
downsampled reads served to a Plotly dashboard. New events are picked up
incrementally in a background watcher.
"""

__version__ = "0.1.0"
