"""Label generation: bin math, future-window truncation, hand-computed values.

label_center / VWAP tests were removed with the center head (2026-07,
docs/decision-remove-center-prediction.md); label_vol is the only label."""

import math

import numpy as np
import pandas as pd
import pytest

from data.labels import bin_of, bin_offset, future_offset, make_labels
from tests.conftest import make_canonical_frame


def _tiny_frame(closes):
    n = len(closes)
    index = pd.date_range("2025-01-06", periods=n, freq="1min", tz="UTC")
    return pd.DataFrame({"sui_close": closes}, index=index)


class TestBinOf:
    def test_base_price_is_bin_zero(self):
        assert bin_of(1.0, 1.0, 0.005) == 0

    def test_exact_boundary_rounds_up_despite_float_noise(self):
        # price exactly one bin up: log(1.005/1)/log(1.005) is 1.0 up to float
        # noise — the epsilon guard must put it in bin 1, not bin 0.
        assert bin_of(1.005, 1.0, 0.005) == 1
        assert bin_of(1.005 * 1.005, 1.0, 0.005) == 2

    def test_just_below_boundary_stays_in_lower_bin(self):
        assert bin_of(1.0049, 1.0, 0.005) == 0

    def test_downward_prices_floor_negative(self):
        # log(0.995)/log(1.005) ≈ -1.005 → floor → bin -2
        assert bin_of(0.995, 1.0, 0.005) == -2

    def test_continuous_offset_matches_log_ratio(self):
        expected = math.log(1.01 / 1.0) / math.log(1.005)
        assert bin_offset(1.01, 1.0, 0.005) == pytest.approx(expected)

    def test_rejects_nonpositive_inputs(self):
        with pytest.raises(ValueError):
            bin_of(0.0, 1.0)
        with pytest.raises(ValueError):
            bin_of(1.0, 1.0, bin_step=0.0)


class TestFutureWindowTruncation:
    def test_last_horizon_rows_are_dropped_not_padded(self):
        frame = make_canonical_frame(n=100)
        labels = make_labels(frame, horizon=30)
        assert len(labels) == 100 - 30
        assert labels.index[-1] == frame.index[100 - 30 - 1]
        assert not labels.isna().any().any()

    def test_horizon_longer_than_series_yields_no_labels(self):
        labels = make_labels(_tiny_frame([1.0, 1.01, 1.02]), horizon=5)
        assert len(labels) == 0

    def test_nan_bar_inside_window_invalidates_covering_labels(self):
        frame = make_canonical_frame(n=100)
        frame.loc[frame.index[50], "sui_close"] = np.nan
        labels = make_labels(frame, horizon=30)
        # windows (T, T+30] containing index 50 ⇒ T in [20, 49]; T=50 itself
        # has a NaN base close.
        for t in range(20, 51):
            assert frame.index[t] not in labels.index
        assert frame.index[19] in labels.index
        assert frame.index[51] in labels.index


class TestLabelValues:
    def test_constant_price_gives_zero_labels(self):
        labels = make_labels(_tiny_frame([2.0] * 10), horizon=3)
        assert np.allclose(labels["label_vol"], 0.0)

    def test_vol_label_is_population_std_of_future_returns(self):
        closes = [1.0, 1.1, 0.9, 1.05]
        labels = make_labels(_tiny_frame(closes), horizon=3)
        r = np.diff(np.log(closes))  # the three returns in (T0, T0+3]
        assert labels["label_vol"].iloc[0] == pytest.approx(np.std(r))

    def test_only_vol_label_is_produced(self):
        labels = make_labels(_tiny_frame([1.0, 1.1, 0.9, 1.05]), horizon=2)
        assert list(labels.columns) == ["label_vol"]


class TestFutureOffset:
    def test_endpoint_offset_matches_log_ratio(self):
        closes = [1.0, 1.02, 1.04]
        offset = future_offset(_tiny_frame(closes), horizon=2, bin_step=0.005)
        expected = math.log(1.04 / 1.0) / math.log(1.005)
        assert offset.iloc[0] == pytest.approx(expected)

    def test_tail_rows_are_nan(self):
        offset = future_offset(_tiny_frame([1.0, 1.02, 1.04]), horizon=2)
        assert offset.iloc[-2:].isna().all()
