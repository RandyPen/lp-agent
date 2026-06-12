"""Parquet persistence for collected market data.

Layout (relative to a data root, default ``data/parquet`` inside ``ml/``):

    <root>/<subdir>/<YYYY-MM>.parquet

where ``subdir`` encodes the source, e.g. ``binance/klines/SUIUSDC/1m`` or
``binance/funding/SUIUSDT``. Files are partitioned by calendar month of the
millisecond timestamp column, deduplicated on that column (keep-last) and kept
sorted, so collectors can be re-run idempotently over overlapping windows.

Writes are atomic: data is written to a temporary file in the same directory
and then ``os.replace``d into place.
"""

from __future__ import annotations

import os
import tempfile
from pathlib import Path

import pandas as pd

DEFAULT_DATA_ROOT = Path("data/parquet")


def month_key(ts_ms: int) -> str:
    """Calendar-month partition key (UTC) for a millisecond timestamp."""
    return pd.Timestamp(ts_ms, unit="ms", tz="UTC").strftime("%Y-%m")


def _atomic_write(df: pd.DataFrame, path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=path.parent, suffix=".parquet.tmp")
    os.close(fd)
    try:
        df.to_parquet(tmp, index=False)
        os.replace(tmp, path)
    finally:
        if os.path.exists(tmp):
            os.unlink(tmp)


def write_partitioned(
    df: pd.DataFrame,
    root: Path | str,
    subdir: str,
    ts_col: str,
) -> list[Path]:
    """Upsert ``df`` into monthly parquet partitions under ``<root>/<subdir>``.

    Rows are merged with any existing partition content, deduplicated on
    ``ts_col`` (new rows win) and sorted ascending. Returns the list of
    partition paths written.
    """
    if df.empty:
        return []
    if ts_col not in df.columns:
        raise ValueError(f"write_partitioned: missing timestamp column {ts_col!r}")

    root = Path(root)
    written: list[Path] = []
    keys = df[ts_col].map(month_key)
    for key, chunk in df.groupby(keys):
        path = root / subdir / f"{key}.parquet"
        if path.exists():
            existing = pd.read_parquet(path)
            chunk = pd.concat([existing, chunk], ignore_index=True)
        chunk = (
            chunk.drop_duplicates(subset=ts_col, keep="last")
            .sort_values(ts_col)
            .reset_index(drop=True)
        )
        _atomic_write(chunk, path)
        written.append(path)
    return sorted(written)


def read_partitioned(
    root: Path | str,
    subdir: str,
    ts_col: str,
    start_ms: int | None = None,
    end_ms: int | None = None,
) -> pd.DataFrame:
    """Read all monthly partitions under ``<root>/<subdir>``.

    Optional ``[start_ms, end_ms)`` filter on ``ts_col``. Raises
    ``FileNotFoundError`` if the dataset directory does not exist — a missing
    dataset is an operator error (run the collector), not an empty result.
    """
    directory = Path(root) / subdir
    if not directory.is_dir():
        raise FileNotFoundError(
            f"parquet dataset not found: {directory} — run the collector first"
        )
    paths = sorted(directory.glob("*.parquet"))
    if not paths:
        raise FileNotFoundError(f"parquet dataset is empty: {directory}")

    frames = [pd.read_parquet(p) for p in paths]
    df = pd.concat(frames, ignore_index=True)
    df = df.drop_duplicates(subset=ts_col, keep="last").sort_values(ts_col)
    if start_ms is not None:
        df = df[df[ts_col] >= start_ms]
    if end_ms is not None:
        df = df[df[ts_col] < end_ms]
    return df.reset_index(drop=True)
