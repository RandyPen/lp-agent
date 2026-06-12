"""Feature registry: determinism, NaN policy, parity with the TS estimators."""

import numpy as np
import pandas as pd
import pytest

from features import volatility
from features.registry import FEATURE_NAMES, FEATURES, build_feature_matrix, build_feature_vector
from tests.conftest import make_canonical_frame


class TestRegistryShape:
    def test_dimension_in_plan_band(self):
        assert 20 <= len(FEATURES) <= 30

    def test_names_unique_and_ordered(self):
        assert len(set(FEATURE_NAMES)) == len(FEATURE_NAMES)
        assert [s.name for s in FEATURES] == FEATURE_NAMES

    def test_matrix_columns_follow_registry_order(self, canonical_frame):
        X, _ = build_feature_matrix(canonical_frame)
        assert list(X.columns) == FEATURE_NAMES

    def test_vector_shape_and_completeness(self, canonical_frame):
        x, completeness = build_feature_vector(canonical_frame)
        assert x.shape == (1, len(FEATURES))
        assert 0.0 <= completeness <= 1.0


class TestDeterminism:
    def test_same_input_same_output(self, canonical_frame):
        x1, c1 = build_feature_matrix(canonical_frame.copy())
        x2, c2 = build_feature_matrix(canonical_frame.copy())
        pd.testing.assert_frame_equal(x1, x2)
        pd.testing.assert_series_equal(c1, c2)


class TestNanPolicy:
    def test_filled_matrix_has_no_nans(self, canonical_frame):
        X, _ = build_feature_matrix(canonical_frame)
        assert not X.isna().any().any()

    def test_missing_input_column_uses_default_and_lowers_completeness(self, canonical_frame):
        full_X, full_c = build_feature_matrix(canonical_frame)
        stripped = canonical_frame.drop(columns=["funding", "oi", "liq_1m"])
        X, c = build_feature_matrix(stripped)
        derivative_features = ["funding_rate", "funding_ma_8h", "oi_change_30m", "liq_volume_5m"]
        for name in derivative_features:
            default = next(s.default for s in FEATURES if s.name == name)
            assert (X[name] == default).all()
        assert (c <= full_c).all()
        assert c.iloc[-1] == pytest.approx(
            full_c.iloc[-1] - len(derivative_features) / len(FEATURES)
        )

    def test_vol_ratio_defaults_to_one_in_warmup(self, canonical_frame):
        X, _ = build_feature_matrix(canonical_frame)
        assert X["vol_ratio"].iloc[0] == 1.0  # long window not yet available

    def test_completeness_grows_with_history(self, canonical_frame):
        _, c = build_feature_matrix(canonical_frame)
        assert c.iloc[-1] > c.iloc[0]
        assert c.iloc[-1] == 1.0  # full synthetic frame: everything computable


class TestTsParity:
    """Mirror src/forecast/volatility.ts on hand-computed inputs."""

    def _frame_from_closes(self, closes):
        index = pd.date_range("2025-01-06", periods=len(closes), freq="1min", tz="UTC")
        return pd.DataFrame({"sui_close": closes}, index=index)

    def test_ewma_matches_ts_recursion(self):
        closes = [1.0, 1.01, 0.99, 1.02, 1.005]
        lam = volatility.EWMA_LAMBDA
        # TS ewmaSigma: var := r0², then var = λ·var + (1−λ)·r²
        returns = np.diff(np.log(closes))
        var = returns[0] ** 2
        for r in returns[1:]:
            var = lam * var + (1 - lam) * r * r
        out = volatility.ewma_sigma(self._frame_from_closes(closes))
        assert out.iloc[-1] == pytest.approx(np.sqrt(var))

    def test_parkinson_constant_range(self):
        n = 40
        index = pd.date_range("2025-01-06", periods=n, freq="1min", tz="UTC")
        df = pd.DataFrame(
            {"sui_high": [1.01] * n, "sui_low": [1.0] * n}, index=index
        )
        expected = np.sqrt(np.log(1.01) ** 2 / (4 * np.log(2)))
        out = volatility.parkinson_30m(df)
        assert np.isnan(out.iloc[28])  # window of 30 not yet full
        assert out.iloc[-1] == pytest.approx(expected)

    def test_garman_klass_hand_value(self):
        n = 40
        index = pd.date_range("2025-01-06", periods=n, freq="1min", tz="UTC")
        df = pd.DataFrame(
            {
                "sui_open": [1.0] * n,
                "sui_high": [1.02] * n,
                "sui_low": [0.99] * n,
                "sui_close": [1.01] * n,
            },
            index=index,
        )
        ln_hl, ln_co = np.log(1.02 / 0.99), np.log(1.01 / 1.0)
        v = 0.5 * ln_hl**2 - (2 * np.log(2) - 1) * ln_co**2
        out = volatility.gk_30m(df)
        assert out.iloc[-1] == pytest.approx(np.sqrt(v))

    def test_parkinson_skips_invalid_bars_like_ts(self):
        # H == L bars are invalid in the TS implementation; a full window of
        # them must not produce a fake zero σ.
        n = 40
        index = pd.date_range("2025-01-06", periods=n, freq="1min", tz="UTC")
        df = pd.DataFrame({"sui_high": [1.0] * n, "sui_low": [1.0] * n}, index=index)
        assert volatility.parkinson_30m(df).isna().all()


class TestTimeFeatures:
    def test_midnight_monday_values(self):
        index = pd.DatetimeIndex([pd.Timestamp("2025-01-06 00:00", tz="UTC")])  # a Monday
        df = pd.DataFrame({"sui_close": [1.0]}, index=index)
        X, _ = build_feature_matrix(df)
        assert X["hod_sin"].iloc[0] == pytest.approx(0.0)
        assert X["hod_cos"].iloc[0] == pytest.approx(1.0)
        assert X["dow_sin"].iloc[0] == pytest.approx(0.0)
        assert X["dow_cos"].iloc[0] == pytest.approx(1.0)

    def test_time_features_never_nan(self, canonical_frame):
        X, _ = build_feature_matrix(canonical_frame[["sui_close"]])
        for name in ("hod_sin", "hod_cos", "dow_sin", "dow_cos"):
            assert not X[name].isna().any()
