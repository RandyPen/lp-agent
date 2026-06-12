"""Timestamp alignment: grid join, forward-fill limits, gap detection."""

import numpy as np
import pandas as pd
import pytest

from data.alignment import align_sources, detect_gaps, from_klines, from_scalar_series


def _series_frame(times_min: list[int], values: list[float], column: str) -> pd.DataFrame:
    base = pd.Timestamp("2025-01-06", tz="UTC")
    index = pd.DatetimeIndex([base + pd.Timedelta(minutes=m) for m in times_min], name="ts")
    return pd.DataFrame({column: values}, index=index)


class TestFromKlines:
    def test_converts_epoch_ms_to_utc_grid(self):
        base_ms = int(pd.Timestamp("2025-01-06", tz="UTC").timestamp() * 1000)
        raw = pd.DataFrame(
            {
                "open_time": [base_ms, base_ms + 60_000],
                "open": [1.0, 1.1],
                "high": [1.2, 1.3],
                "low": [0.9, 1.0],
                "close": [1.1, 1.2],
                "volume": [10.0, 20.0],
            }
        )
        out = from_klines(raw, "sui")
        assert list(out.columns) == ["sui_open", "sui_high", "sui_low", "sui_close", "sui_volume"]
        assert out.index[0] == pd.Timestamp("2025-01-06", tz="UTC")
        assert out.index[1] - out.index[0] == pd.Timedelta(minutes=1)

    def test_missing_field_raises(self):
        with pytest.raises(ValueError, match="missing fields"):
            from_klines(pd.DataFrame({"open_time": [0]}), "sui")

    def test_scalar_series_rename(self):
        raw = pd.DataFrame({"ts": [0, 60_000], "funding_rate": [0.01, 0.02]})
        out = from_scalar_series(raw, {"funding_rate": "funding"})
        assert list(out.columns) == ["funding"]
        assert out["funding"].iloc[1] == 0.02


class TestAlignSources:
    def test_ffill_respects_limit(self):
        dense = _series_frame(list(range(30)), [float(i) for i in range(30)], "sui_close")
        sparse = _series_frame([0, 20], [1.0, 2.0], "funding")
        out = align_sources({"sui": dense, "fund": sparse}, ffill_limits={"fund": 5})
        # filled through minute 5, NaN from 6 until the next observation at 20
        assert out["funding"].iloc[5] == 1.0
        assert np.isnan(out["funding"].iloc[6])
        assert np.isnan(out["funding"].iloc[19])
        assert out["funding"].iloc[20] == 2.0

    def test_no_ffill_without_limit(self):
        dense = _series_frame(list(range(10)), [1.0] * 10, "sui_close")
        sparse = _series_frame([0], [3.0], "funding")
        out = align_sources({"sui": dense, "fund": sparse})
        assert out["funding"].iloc[0] == 3.0
        assert out["funding"].iloc[1:].isna().all()

    def test_never_backfills_the_past(self):
        dense = _series_frame(list(range(10)), [1.0] * 10, "sui_close")
        late = _series_frame([5], [9.0], "funding")
        out = align_sources({"sui": dense, "fund": late}, ffill_limits={"fund": 100})
        assert out["funding"].iloc[:5].isna().all()  # before first obs: NaN, not 9.0
        assert (out["funding"].iloc[5:] == 9.0).all()

    def test_duplicate_timestamps_keep_last(self):
        dup = _series_frame([0, 0, 1], [1.0, 2.0, 3.0], "sui_close")
        out = align_sources({"sui": dup})
        assert out["sui_close"].iloc[0] == 2.0

    def test_naive_index_rejected(self):
        bad = pd.DataFrame(
            {"x": [1.0]}, index=pd.DatetimeIndex([pd.Timestamp("2025-01-06")])
        )
        with pytest.raises(ValueError, match="tz-aware"):
            align_sources({"bad": bad})


class TestDetectGaps:
    def test_contiguous_index_has_no_gaps(self):
        idx = pd.date_range("2025-01-06", periods=60, freq="1min", tz="UTC")
        assert detect_gaps(idx) == []

    def test_finds_single_gap_with_correct_extent(self):
        idx = pd.date_range("2025-01-06", periods=60, freq="1min", tz="UTC")
        holed = idx.delete([10, 11, 12])
        gaps = detect_gaps(holed)
        assert len(gaps) == 1
        assert gaps[0].missing_bars == 3
        assert gaps[0].start == idx[10]
        assert gaps[0].end == idx[12]

    def test_finds_multiple_gaps(self):
        idx = pd.date_range("2025-01-06", periods=60, freq="1min", tz="UTC")
        holed = idx.delete([5, 30, 31])
        gaps = detect_gaps(holed)
        assert [g.missing_bars for g in gaps] == [1, 2]
