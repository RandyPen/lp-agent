"""Multi-source timestamp alignment onto a single 1-minute grid.

The canonical training/serving frame (see ``features.registry``) is a
UTC ``DatetimeIndex`` at fixed frequency with one column namespace per source.
This module turns heterogeneous source frames (klines, funding, OI, …) into
that shape:

* outer time grid spanning min..max of all sources at ``freq``;
* per-source forward-fill with an explicit **limit** (e.g. funding settles
  every 8h → limit 480 minutes; klines get limit 0 — a missing bar stays NaN
  and is surfaced by ``detect_gaps``, never papered over);
* gap detection so data-quality problems fail loudly at training time.
"""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass

import pandas as pd


@dataclass(frozen=True)
class Gap:
    """A run of missing grid timestamps inside one source."""

    start: pd.Timestamp
    end: pd.Timestamp
    missing_bars: int


def from_klines(
    df: pd.DataFrame,
    prefix: str,
    fields: tuple[str, ...] = ("open", "high", "low", "close", "volume"),
    ts_col: str = "open_time",
) -> pd.DataFrame:
    """Convert a collector klines frame to ``<prefix>_<field>`` columns
    indexed by a UTC DatetimeIndex derived from ``ts_col`` (epoch ms)."""
    missing = [f for f in fields if f not in df.columns]
    if missing:
        raise ValueError(f"from_klines: missing fields {missing} for prefix {prefix!r}")
    out = df[list(fields)].copy()
    out.columns = [f"{prefix}_{f}" for f in fields]
    out.index = pd.DatetimeIndex(pd.to_datetime(df[ts_col], unit="ms", utc=True), name="ts")
    return out.sort_index()


def from_scalar_series(
    df: pd.DataFrame,
    value_cols: Mapping[str, str],
    ts_col: str = "ts",
) -> pd.DataFrame:
    """Convert a (ts, value…) frame to renamed columns on a UTC DatetimeIndex.

    ``value_cols`` maps source column → output column, e.g.
    ``{"funding_rate": "funding"}``.
    """
    out = df[list(value_cols)].rename(columns=dict(value_cols))
    out.index = pd.DatetimeIndex(pd.to_datetime(df[ts_col], unit="ms", utc=True), name="ts")
    return out.sort_index()


def detect_gaps(
    index: pd.DatetimeIndex,
    freq: str = "1min",
    grid: pd.DatetimeIndex | None = None,
) -> list[Gap]:
    """Find runs of grid timestamps absent from ``index``.

    ``grid`` defaults to the full range min(index)..max(index) at ``freq``.
    """
    if len(index) == 0:
        return []
    if grid is None:
        grid = pd.date_range(index.min(), index.max(), freq=freq)
    present = grid.isin(index)
    gaps: list[Gap] = []
    run_start: int | None = None
    for i, ok in enumerate(present):
        if not ok and run_start is None:
            run_start = i
        elif ok and run_start is not None:
            gaps.append(Gap(grid[run_start], grid[i - 1], i - run_start))
            run_start = None
    if run_start is not None:
        gaps.append(Gap(grid[run_start], grid[-1], len(grid) - run_start))
    return gaps


def align_sources(
    frames: Mapping[str, pd.DataFrame],
    freq: str = "1min",
    ffill_limits: Mapping[str, int] | None = None,
) -> pd.DataFrame:
    """Outer-align source frames onto one UTC grid at ``freq``.

    Each value of ``frames`` must carry a tz-aware DatetimeIndex (use
    ``from_klines`` / ``from_scalar_series``). ``ffill_limits`` maps source
    name → max bars to forward-fill (0 / absent = no fill). Values are
    forward-filled only — never back-filled, which would leak the future.
    """
    if not frames:
        raise ValueError("align_sources: no frames given")
    for name, frame in frames.items():
        if not isinstance(frame.index, pd.DatetimeIndex) or frame.index.tz is None:
            raise ValueError(f"align_sources: source {name!r} needs a tz-aware DatetimeIndex")

    limits = dict(ffill_limits or {})
    start = min(f.index.min() for f in frames.values() if len(f) > 0)
    end = max(f.index.max() for f in frames.values() if len(f) > 0)
    grid = pd.date_range(start, end, freq=freq, name="ts")

    aligned: list[pd.DataFrame] = []
    for name, frame in frames.items():
        # keep-last on duplicate timestamps, then snap to grid
        frame = frame[~frame.index.duplicated(keep="last")].sort_index()
        out = frame.reindex(grid)
        limit = limits.get(name, 0)
        if limit > 0:
            out = out.ffill(limit=limit)
        aligned.append(out)

    return pd.concat(aligned, axis=1)
