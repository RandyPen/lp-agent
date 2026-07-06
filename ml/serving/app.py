"""FastAPI inference sidecar (plan W4, contract per plan §3.3/§3.4).

Endpoints
---------
``GET /health``    → ``{status, model_version, loaded_at, psi_summary}``
``POST /predict``  → input ``MarketSnapshot`` (camelCase, same shape as
                     ``src/prediction/types.ts``), output ``PredictionResponse``
                     with exactly these keys: ``centerOffset, centerQ10,
                     centerQ90, widthSigma, pAbove, pBelow, modelVersion,
                     featureCompleteness, psi, fallback``
``POST /reload``   → ``{"artifact_dir": …}``; hot-swap via the model registry,
                     HTTP 409 + old model keeps serving on failure.

Fallback semantics (sidecar side; the TS provider adds ``sidecar_down`` /
``timeout`` on top): ``"missing"`` when featureCompleteness < 0.7, else
``"psi"`` when rolling max feature PSI > 0.25, else ``false``. Even in
fallback the full prediction is returned — the consumer (mlAgent) decides
whether to discard it (degradation authority lives with the consumer).

Feature assembly uses ``features.registry`` directly — the same code that
built the training matrix. Derivatives arrive as point-in-time scalars; the
sidecar accumulates its OWN rolling funding/OI/liq history across /predict
calls (``DerivativesHistory``) and reconstructs the grid columns with the
same forward-fill limits training used, so history-dependent derivative
features (funding_ma_8h, oi_change_30m, liq_volume_5m) become real after
warm-up. Before warm-up they keep their documented defaults — reflected in
``featureCompleteness`` — and are excluded from PSI tracking
(``_psi_exclusions``) so drift is never flagged on constants that are
defaults-by-construction.

Concurrency: endpoints are sync ``def`` (Starlette runs them in a
threadpool). Shared mutable state is guarded at two levels, each object
owning its own invariant (no inconsistent double-locking):
``ModelRegistry`` locks its bundle pointer, ``PsiTracker`` locks its
observation buffer, and an app-level ``state_lock`` guards the compound
operations — the (registry, tracker) snapshot in /predict, the derivative
history read/write, and the /reload swap of registry bundle + tracker as one
atomic step.

Contract decisions beyond the docs (documented here on purpose):

* ``pAbove``/``pBelow`` are the probabilities that the predicted 30-min
  center lands above/below the current active bin, i.e. outside the
  ``[lowerOffset, upperOffset]`` band (default ±0.5 bin). A caller that wants
  range-break probabilities for a wider position passes the optional
  ``pmRangeContext: {lowerOffset, upperOffset}`` field on the snapshot.
* Quantile crossings (q10 > q50 etc., possible with independently trained
  quantile models) are repaired by sorting the three predictions.
* ``cetus.binStep`` on the snapshot is accepted but not used in computation:
  the models are trained for a fixed bin step recorded in
  ``models_meta.json``; mixing per-request bin steps would silently change
  the unit of the labels.

The server binds 127.0.0.1 only.

Run:

    PREDICTION_ARTIFACT_DIR=artifacts/v1.0.0 uv run python -m serving.app
    # or: uv run python -m serving.app --artifact-dir artifacts/v1.0.0 --port 8765
"""

from __future__ import annotations

import argparse
import math
import os
import threading
from pathlib import Path

import numpy as np
import pandas as pd
from fastapi import FastAPI, HTTPException
from pydantic import AliasChoices, BaseModel, ConfigDict, Field

from features.derivatives import FUNDING_MA_WINDOW, LIQ_SUM_WINDOW, OI_CHANGE_WINDOW
from features.registry import build_feature_vector
from serving.psi import PsiTracker
from serving.registry import ModelRegistry

DEFAULT_PORT = 8765
BIND_HOST = "127.0.0.1"  # local sidecar only — never expose externally
WIDTH_DIVISOR = 2.56  # (q90 - q10) / 2.56 ≈ σ for a normal distribution
MIN_WIDTH_SIGMA = 1e-9
PSI_FALLBACK_THRESHOLD = 0.25
COMPLETENESS_FALLBACK_THRESHOLD = 0.7

# Forward-fill limits for reconstructing derivative grid columns from the
# sidecar's own accumulated history. MUST mirror training
# (training.train_quantile FUNDING_FFILL_LIMIT / OI_FFILL_LIMIT) so the
# alignment semantics are identical on both sides of the model. Liquidation
# volume gets no fill — training has no liq backfill path at all, and the
# 1-minute notional is only meaningful at the minute it was observed.
FUNDING_FFILL_LIMIT = 8 * 60 + 5  # funding settles every 8h
OI_FFILL_LIMIT = 5  # TS OI poll cadence is 5 minutes
LIQ_FFILL_LIMIT = 0
DERIV_HISTORY_RETENTION_MIN = 24 * 60  # keep 24h of observations in memory


# --- request / response models (camelCase mirrors src/prediction/types.ts) ---


class OhlcvBar(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    # Canonical wire name is `ts` (src/prediction/types.ts OhlcvBar.ts);
    # `bucketStartMs` is accepted as a legacy alias for older payloads.
    ts: int = Field(..., validation_alias=AliasChoices("ts", "bucketStartMs"))
    open: float
    high: float
    low: float
    close: float
    volume: float | None = None  # TS sends volume; optional here (unused by v1 features)


class CetusState(BaseModel):
    activeBin: int
    price: str
    tvlUsd: float
    binStep: float


class BinanceBars(BaseModel):
    sui: list[OhlcvBar]
    btc: list[OhlcvBar]
    eth: list[OhlcvBar]


class DerivativesState(BaseModel):
    funding: float
    oi: float
    liq1m: float


class PmRangeContext(BaseModel):
    lowerOffset: float = -0.5
    upperOffset: float = 0.5


class MarketSnapshot(BaseModel):
    ts: int
    cetus: CetusState
    binance: BinanceBars
    derivatives: DerivativesState
    spread: float
    pmRangeContext: PmRangeContext | None = None


class ReloadRequest(BaseModel):
    artifact_dir: str


# --- snapshot → canonical frame ---


def _bars_frame(bars: list[OhlcvBar], prefix: str, fields: tuple[str, ...]) -> pd.DataFrame:
    if not bars:
        raise ValueError(f"snapshot has no {prefix} bars")
    rows = sorted(bars, key=lambda b: b.ts)
    data = {f"{prefix}_{f}": [getattr(b, f) for b in rows] for f in fields}
    index = pd.DatetimeIndex(
        pd.to_datetime([b.ts for b in rows], unit="ms", utc=True), name="ts"
    )
    df = pd.DataFrame(data, index=index)
    return df[~df.index.duplicated(keep="last")]


def snapshot_to_frame(snapshot: MarketSnapshot) -> pd.DataFrame:
    """Assemble the canonical 1-min frame from a MarketSnapshot.

    The SUI bar grid is the spine; BTC/ETH closes are joined on matching
    timestamps. Derivative scalars are set on the last row only — /predict
    overlays the sidecar's accumulated ``DerivativesHistory`` onto the earlier
    rows; constants are never broadcast into fake history."""
    sui = _bars_frame(snapshot.binance.sui, "sui", ("open", "high", "low", "close"))
    btc = _bars_frame(snapshot.binance.btc, "btc", ("close",))
    eth = _bars_frame(snapshot.binance.eth, "eth", ("close",))

    frame = sui.join(btc, how="left").join(eth, how="left")
    for col, value in (
        ("funding", snapshot.derivatives.funding),
        ("oi", snapshot.derivatives.oi),
        ("liq_1m", snapshot.derivatives.liq1m),
    ):
        series = pd.Series(np.nan, index=frame.index, dtype=float)
        series.iloc[-1] = value
        frame[col] = series
    return frame


def _norm_cdf(x: float) -> float:
    return 0.5 * (1.0 + math.erf(x / math.sqrt(2.0)))


# --- sidecar-side derivative history (funding / OI / liq) ---


class DerivativesHistory:
    """Rolling per-minute funding/OI/liquidation observations accumulated
    across /predict calls.

    The TS ``MarketSnapshot`` only carries point-in-time derivative scalars,
    so without history ``funding_ma_8h`` (480 rows) and ``oi_change_30m``
    (30 rows) are NaN→default at every inference — constant at serving by
    construction, while training saw their real distributions. The sidecar
    therefore records each snapshot's scalars keyed by the snapshot's last
    bar minute and rebuilds the grid columns with the SAME forward-fill
    limits training used, so these features are computed from real history
    after warm-up (~8h of sidecar uptime for the funding MA; ~30 min at
    minute cadence for the OI delta — at sparser decision cadences the OI
    ffill limit of 5 min honestly leaves gaps, exactly as training did with
    5-minute-sampled OI).

    Not persisted: a restart re-enters warm-up, during which the affected
    features keep their documented defaults and are excluded from PSI
    tracking (``_psi_exclusions``).

    NOT thread-safe on its own — callers hold the app-level state lock.
    """

    def __init__(self, retention_minutes: int = DERIV_HISTORY_RETENTION_MIN) -> None:
        self._retention_ms = retention_minutes * 60_000
        self._rows: dict[int, tuple[float, float, float]] = {}  # minute ms → (funding, oi, liq1m)

    def record(self, ts_ms: int, funding: float, oi: float, liq1m: float) -> None:
        minute = ts_ms - (ts_ms % 60_000)
        self._rows[minute] = (funding, oi, liq1m)
        cutoff = minute - self._retention_ms
        for stale in [t for t in self._rows if t < cutoff]:
            del self._rows[stale]

    def columns(self, grid: pd.DatetimeIndex) -> dict[str, pd.Series]:
        """``{"funding": …, "oi": …, "liq_1m": …}`` reindexed onto ``grid``.

        Forward-fill limits are counted in minutes on a full 1-min grid
        spanning history∪grid — the exact semantics of training's
        ``data.alignment.align_sources``. Minutes with no coverage stay NaN
        (never back-filled, never fabricated)."""
        specs = (("funding", 0, FUNDING_FFILL_LIMIT), ("oi", 1, OI_FFILL_LIMIT), ("liq_1m", 2, LIQ_FFILL_LIMIT))
        if not self._rows:
            return {name: pd.Series(np.nan, index=grid, dtype=float) for name, _, _ in specs}
        ts_sorted = sorted(self._rows)
        idx = pd.DatetimeIndex(pd.to_datetime(ts_sorted, unit="ms", utc=True), name="ts")
        full = pd.date_range(min(idx.min(), grid.min()), grid.max(), freq="1min", name="ts")
        out: dict[str, pd.Series] = {}
        for name, pos, limit in specs:
            s = pd.Series([self._rows[t][pos] for t in ts_sorted], index=idx, dtype=float)
            s = s.reindex(full)
            if limit > 0:
                s = s.ffill(limit=limit)
            out[name] = s.reindex(grid)
        return out


def _psi_exclusions(frame: pd.DataFrame) -> set[str]:
    """History-dependent derivative features still in warm-up on this frame.

    While the sidecar's accumulated history does not yet cover a feature's
    rolling window, that feature is a default-filled constant by
    construction; feeding it to the PSI tracker would flag "drift" on a
    constant and pin the sidecar in ``fallback="psi"``. Such features are
    excluded per-observation until their inputs are real (the tracker then
    requires ``min_obs`` real observations before scoring them)."""
    excl: set[str] = set()
    funding = frame["funding"]
    if len(funding) < FUNDING_MA_WINDOW or funding.iloc[-FUNDING_MA_WINDOW:].isna().any():
        excl.add("funding_ma_8h")
    oi = frame["oi"]
    # oi_change_30m needs strictly positive OI now and 30 minutes ago
    # (features.derivatives invalidates non-positive OI). NaN comparisons are
    # False, so missing history lands here too.
    if (
        len(oi) <= OI_CHANGE_WINDOW
        or not (oi.iloc[-1] > 0)
        or not (oi.iloc[-1 - OI_CHANGE_WINDOW] > 0)
    ):
        excl.add("oi_change_30m")
    liq = frame["liq_1m"]
    if len(liq) < LIQ_SUM_WINDOW or liq.iloc[-LIQ_SUM_WINDOW:].isna().any():
        excl.add("liq_volume_5m")
    return excl


# --- app factory ---


def create_app(
    artifact_dir: Path | str,
    psi_threshold: float = PSI_FALLBACK_THRESHOLD,
    completeness_threshold: float = COMPLETENESS_FALLBACK_THRESHOLD,
) -> FastAPI:
    app = FastAPI(title="LiquidityManager prediction sidecar")
    registry = ModelRegistry.from_dir(artifact_dir)

    def make_tracker() -> PsiTracker:
        bundle = registry.current()
        return PsiTracker(bundle.psi_baseline, bundle.feature_names)

    state = {
        "registry": registry,
        "tracker": make_tracker(),
        "deriv_history": DerivativesHistory(),
    }
    # Guards compound multi-object operations (see module docstring):
    # consistent (registry, tracker) snapshots in /predict, derivative-history
    # mutation, and the /reload registry+tracker swap. PsiTracker and
    # ModelRegistry additionally self-lock their own internals.
    state_lock = threading.Lock()

    @app.get("/health")
    def health() -> dict:
        with state_lock:
            bundle = state["registry"].current()
            tracker = state["tracker"]
        summary = tracker.summary()
        return {
            "status": "ok",
            "model_version": bundle.version,
            "loaded_at": bundle.loaded_at,
            "psi_summary": {
                "max": summary["max"],
                "breached": summary["breached"],
                "n_obs": summary["n_obs"],
            },
        }

    @app.post("/predict")
    def predict(snapshot: MarketSnapshot) -> dict:
        # Consistent snapshot of the serving pair; model inference itself runs
        # outside the lock (CPU-bound, must not serialize requests).
        with state_lock:
            bundle = state["registry"].current()
            tracker = state["tracker"]

        try:
            frame = snapshot_to_frame(snapshot)
        except ValueError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc

        # Record this snapshot's derivative scalars, then overlay accumulated
        # history onto the grid. The last row keeps the point-in-time scalars
        # snapshot_to_frame placed (they equal the just-recorded history value
        # on an aligned grid); earlier rows come from history where covered.
        with state_lock:
            history: DerivativesHistory = state["deriv_history"]
            history.record(
                int(frame.index[-1].value // 1_000_000),
                snapshot.derivatives.funding,
                snapshot.derivatives.oi,
                snapshot.derivatives.liq1m,
            )
            deriv_cols = history.columns(frame.index)
        for col, series in deriv_cols.items():
            frame[col] = frame[col].fillna(series)

        exclusions = _psi_exclusions(frame)
        try:
            x, completeness = build_feature_vector(frame)
        except ValueError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc

        raw = [float(bundle.boosters[k].predict(x)[0]) for k in ("q10", "q50", "q90")]
        q10, q50, q90 = sorted(raw)  # repair quantile crossings (documented)
        width_sigma = max((q90 - q10) / WIDTH_DIVISOR, MIN_WIDTH_SIGMA)

        ctx = snapshot.pmRangeContext or PmRangeContext()
        p_above = 1.0 - _norm_cdf((ctx.upperOffset - q50) / width_sigma)
        p_below = _norm_cdf((ctx.lowerOffset - q50) / width_sigma)

        psi_summary = tracker.observe(x[0], exclude=exclusions)
        psi_max = float(psi_summary["max"])

        fallback: bool | str = False
        if completeness < completeness_threshold:
            fallback = "missing"
        elif psi_max > psi_threshold:
            fallback = "psi"

        return {
            "centerOffset": q50,
            "centerQ10": q10,
            "centerQ90": q90,
            "widthSigma": width_sigma,
            "pAbove": p_above,
            "pBelow": p_below,
            "modelVersion": bundle.version,
            "featureCompleteness": completeness,
            "psi": psi_max,
            "fallback": fallback,
        }

    @app.post("/reload")
    def reload(body: ReloadRequest) -> dict:
        # Registry swap and tracker replacement happen atomically under the
        # state lock so /predict never observes a new bundle paired with the
        # old model's tracker (or vice versa). Derivative history survives a
        # reload — it is market data, not model state.
        with state_lock:
            try:
                bundle = state["registry"].swap(body.artifact_dir)
            except Exception as exc:
                # Old bundle keeps serving — a failed reload must never take the
                # previous model offline (prediction-service-design.md §4.2).
                raise HTTPException(status_code=409, detail=f"reload failed: {exc}") from exc
            state["tracker"] = make_tracker()
        return {"model_version": bundle.version}

    return app


def main(argv: list[str] | None = None) -> None:
    import uvicorn

    parser = argparse.ArgumentParser(description="Prediction sidecar (127.0.0.1 only)")
    parser.add_argument(
        "--artifact-dir",
        default=os.environ.get("PREDICTION_ARTIFACT_DIR"),
        help="artifact directory, e.g. artifacts/v1.0.0 (env PREDICTION_ARTIFACT_DIR)",
    )
    parser.add_argument(
        "--port",
        type=int,
        default=int(os.environ.get("PREDICTION_SIDECAR_PORT", DEFAULT_PORT)),
        help=f"listen port (env PREDICTION_SIDECAR_PORT, default {DEFAULT_PORT})",
    )
    args = parser.parse_args(argv)
    if not args.artifact_dir:
        raise SystemExit("--artifact-dir (or PREDICTION_ARTIFACT_DIR) is required")

    uvicorn.run(create_app(args.artifact_dir), host=BIND_HOST, port=args.port)


if __name__ == "__main__":
    main()
