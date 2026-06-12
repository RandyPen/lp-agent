"""L1 replay harness: determinism and sane relative ranking on synthetic bars."""

import pytest

from backtest.l1_runner import L1Result, MomentumStub, SymmetricStub, run_l1
from tests.conftest import make_ohlcv


class TestRunL1:
    def test_wider_quote_captures_at_least_as_much(self):
        bars = make_ohlcv(400, seed=11)
        results = run_l1(bars, [SymmetricStub(half_width=1), SymmetricStub(half_width=50)])
        by_name = {r.name: r for r in results}
        wide, narrow = by_name["symmetric_hw50"], by_name["symmetric_hw1"]
        assert wide.fees >= narrow.fees
        assert wide.time_in_range_frac >= narrow.time_in_range_frac
        assert wide.time_in_range_frac == pytest.approx(1.0)  # ±50 bins always covers

    def test_results_sorted_by_score_desc(self):
        bars = make_ohlcv(400, seed=11)
        results = run_l1(bars, [SymmetricStub(1), SymmetricStub(50), MomentumStub(3)])
        scores = [r.score for r in results]
        assert scores == sorted(scores, reverse=True)

    def test_deterministic_across_runs(self):
        bars = make_ohlcv(400, seed=11)
        strategies = lambda: [SymmetricStub(3), MomentumStub(3)]  # noqa: E731
        assert run_l1(bars, strategies()) == run_l1(bars, strategies())

    def test_rebalance_cost_penalises_score_not_fees(self):
        bars = make_ohlcv(400, seed=11)
        (result,) = run_l1(bars, [SymmetricStub(50)], rebalance_cost=1.0)
        assert result.score == pytest.approx(result.fees - result.rebalances * 1.0)

    def test_too_few_bars_raises(self):
        bars = make_ohlcv(50, seed=11)
        with pytest.raises(ValueError, match="not enough bars"):
            run_l1(bars, [SymmetricStub(3)])

    def test_missing_columns_raise(self):
        bars = make_ohlcv(400, seed=11).drop(columns=["volume"])
        with pytest.raises(ValueError, match="bars need columns"):
            run_l1(bars, [SymmetricStub(3)])

    def test_result_shape(self):
        bars = make_ohlcv(400, seed=11)
        (result,) = run_l1(bars, [SymmetricStub(3)])
        assert isinstance(result, L1Result)
        assert result.rebalances > 0
        assert 0.0 <= result.time_in_range_frac <= 1.0
