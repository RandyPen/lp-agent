"""Fee model arithmetic on hand-constructed Cetus swap-event rows."""

import pandas as pd
import pytest

from backtest.fee_model import MS_PER_DAY, calibrate, expected_daily_fee, fee_revenue


def events_frame(rows: list[tuple[int, int, float, float]]) -> pd.DataFrame:
    return pd.DataFrame(rows, columns=["ts_ms", "bin_id", "amount_in", "fee_rate"])


class TestFeeRevenue:
    def test_share_weighted_sum(self):
        events = events_frame([(0, 5, 100.0, 0.004), (1, 5, 200.0, 0.004)])
        # (100 + 200) × 0.004 × (10 / 40) = 0.3
        out = fee_revenue(events, our_liquidity={5: 10.0}, pool_liquidity={5: 40.0})
        assert out == pytest.approx(0.3)

    def test_bins_we_hold_nothing_in_contribute_nothing(self):
        events = events_frame([(0, 5, 100.0, 0.004), (1, 6, 999.0, 0.004)])
        out = fee_revenue(events, our_liquidity={5: 10.0}, pool_liquidity={5: 10.0})
        assert out == pytest.approx(100.0 * 0.004)  # full share of bin 5 only

    def test_own_liquidity_exceeding_pool_raises(self):
        events = events_frame([(0, 5, 100.0, 0.004)])
        with pytest.raises(ValueError, match="exceeds pool"):
            fee_revenue(events, our_liquidity={5: 50.0}, pool_liquidity={5: 40.0})

    def test_missing_pool_bin_raises(self):
        events = events_frame([(0, 5, 100.0, 0.004)])
        with pytest.raises(ValueError, match="no pool liquidity"):
            fee_revenue(events, our_liquidity={5: 1.0}, pool_liquidity={})

    def test_missing_column_raises(self):
        with pytest.raises(ValueError, match="missing columns"):
            fee_revenue(pd.DataFrame({"ts_ms": [0]}), {5: 1.0}, {5: 1.0})


class TestCalibration:
    def test_daily_volume_normalisation(self):
        events = events_frame(
            [
                (0, 5, 1000.0, 0.004),
                (MS_PER_DAY, 6, 500.0, 0.004),
                (2 * MS_PER_DAY, 5, 1000.0, 0.004),
            ]
        )
        cal = calibrate(events)
        assert cal.span_days == pytest.approx(2.0)
        assert cal.total_fee_volume == pytest.approx(2500.0 * 0.004)
        assert cal.daily_fee_volume == pytest.approx(2500.0 * 0.004 / 2.0)
        assert cal.fee_volume_by_bin == {
            5: pytest.approx(2000.0 * 0.004),
            6: pytest.approx(500.0 * 0.004),
        }

    def test_expected_daily_fee_weights_shares(self):
        events = events_frame([(0, 5, 1000.0, 0.004), (MS_PER_DAY, 6, 500.0, 0.004)])
        cal = calibrate(events)
        # bin 5: 4.0 fee volume × 25 % share; bin 6: 2.0 × 100 %; over 1 day
        out = expected_daily_fee(cal, {5: 0.25, 6: 1.0})
        assert out == pytest.approx((4.0 * 0.25 + 2.0 * 1.0) / 1.0)

    def test_share_outside_unit_interval_raises(self):
        events = events_frame([(0, 5, 1.0, 0.004), (MS_PER_DAY, 5, 1.0, 0.004)])
        cal = calibrate(events)
        with pytest.raises(ValueError, match=r"outside \[0, 1\]"):
            expected_daily_fee(cal, {5: 1.5})

    def test_zero_time_span_raises(self):
        events = events_frame([(0, 5, 1.0, 0.004), (0, 5, 2.0, 0.004)])
        with pytest.raises(ValueError, match="positive time window"):
            calibrate(events)
