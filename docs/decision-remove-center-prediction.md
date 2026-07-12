# Decision record: mean-price (center) prediction removed from the ML pipeline

**Date:** 2026-07-11
**Status:** adopted
**Scope:** `ml/` training + serving, `src/prediction/`, `src/strategies/mlAgent.ts`,
`src/decision/diffPlanner.ts`, `src/state/`, `predictions` DB table, `web/` portal.

## Summary

The pipeline originally trained four LightGBM heads on a 30–120 min horizon:
three quantile heads (q10 / q50 / q90) over the future **center offset** (the
volume-weighted mean price, expressed as a continuous DLMM bin offset from
spot) and one **volatility** head (future per-bar σ). Walk-forward evaluation
falsified the center heads and validated the vol head. The center label, the
three quantile heads, and every downstream use of the predicted center are
removed. The vol head is now the only trained model; the serving distribution
is **center ≡ spot, width = predicted σ**.

## Evidence (purged walk-forward, 12 months SUIUSDC 1m, 525k samples, 5 folds)

Reports: `ml/reports/wf_2026-07-10.json` (h30), `ml/reports/h60/`, `ml/reports/h120/`.
The h60/h120 runs already included the anchor-deviation features
(`dev_30m/dev_1h/dev_4h/dev_z_4h`) that were added specifically to give the
center head a mean-reversion coordinate — i.e. the result below is *after*
the rescue attempt, not before it.

| Metric | h30 | h60 | h120 | Verdict |
|---|---|---|---|---|
| `center_mae_ratio` (q50 MAE ÷ center-on-spot MAE) | — | **1.009** | **1.012** | q50 places the center *worse* than simply using spot |
| q50 pinball vs baseline-0 | — | 0.445 vs 0.441 | 0.625 vs 0.618 | q50 head loses to "predict 0" |
| Direction accuracy (sign of q50) | 50.3% | 50.0% | 50.5% | coin flip; p-values only "significant" because n=525k |
| q10/q90 pinball improvement | ~ -6% | -11.8% / -12.2% | -11.7% / -12.4% | symmetric ⇒ it is the vol edge re-expressed, no skew alpha |
| **vol MAE vs EWMA baseline** | **-20.0%** | **-21.8%** | **-24.8%** | the only head with real, stable predictive value |

Independent data study (same window) confirming the mechanism: SUI 1m prices
are mean-reverting in variance terms (VR(60m)=0.64, VR(240m)=0.52; OU
half-life vs the 4h anchor ≈ 59 min) but the reversion signal explains ~1% of
forward-return variance (corr(dev_4h, fwd_120m) ≈ −0.11, R² ≈ 0.012) — and it
**inverts to momentum beyond ~2σ stretch**. A signal at that R² cannot improve
a point forecast's absolute error; this is an information ceiling, not a
modelling deficiency. Volatility, by contrast, clusters strongly and is
predictable — which is exactly what the vol head captures.

## Decision

1. **Removed** — `label_center` (VWAP-offset label), the q10/q50/q90 boosters,
   the `centerOffset`/`centerQ10`/`centerQ90` wire fields, the
   `center_q10`/`center_offset`/`center_q90` DB columns, and the
   pinball/coverage/center/direction walk-forward gates that scored them.
2. **Kept** — the vol head. `widthSigma` (bin units) is now sourced directly
   from it: `widthSigma = σ̂_perBar × √horizon_bars / ln(1 + bin_step)`.
   This also *unifies* semantics with `NullPredictionProvider`, whose
   widthSigma was always EWMA-σ-based; previously the two providers shipped
   subtly different quantities under one field name.
3. **Kept** — `pAbove` / `pBelow`, recomputed with the center pinned at 0:
   `pAbove = 1 − Φ(upperOffset / widthSigma)`, `pBelow = Φ(lowerOffset / widthSigma)`.
   These feed the state machine's TREND/EXTREME transitions and are exactly
   the "range-break risk" quantities that *are* learnable (they are functions
   of σ, not of direction).
4. **Walk-forward gate** — the vol head is now gated:
   `vol_mae_model < 0.9 × vol_mae_ewma_baseline` (currently ~0.75–0.80,
   passing). An informational `sigma_band_coverage` metric checks the
   ±1.28·widthSigma band against realized end-of-horizon offsets, guarding the
   σ-scaling constant that pAbove/pBelow depend on.
5. **Anchor features retained** — `dev_30m/dev_1h/dev_4h/dev_z_4h` stay in the
   registry. They failed their original purpose (rescuing the center head) but
   are honest regime/stretch descriptors, cheap to compute on both sides, and
   are the inputs the planned `p_break` classification head will need. They
   are untested for vol-head lift; that is acceptable for retained features,
   not for retained *predictions*.

## Consequences

- The sidecar `/predict` response shrinks to 7 keys:
  `widthSigma, pAbove, pBelow, modelVersion, featureCompleteness, psi, fallback`.
- `mlAgent` / `diffPlanner` always center the liquidity range on the active
  bin. `computeTargetCenterBin` and `StateContext.maxCenterOffset` (whose only
  job was clamping the predicted center) are removed.
- `StateContext.trendBias` (mlAgent path only) now derives purely from range
  asymmetry: with the center pinned at 0, `pAbove − pBelow ≠ 0` only when the
  position sits off-center of the active bin. The old directional tilt came
  from q50 — i.e. from noise. The presence strategies (`presenceAnchor` /
  `presenceSweep`, the current mainline) never consumed trendBias; they gate
  regimes on *realized* drift-z and vol ratios, unaffected by this removal.
- Directional intelligence, where it exists at all, lives in **rules**, not
  in a trained head: the presence architecture's regime-gated anchor pull
  (reversion, clamped, NORMAL-only) and DEFENSE gates (realized drift).
  Nothing learned replaces the center head. If a future fork wants a learned
  directional signal, the seam is a new head behind `PredictionProvider` —
  and the burden of proof is this document's evidence table.
- **DB**: the three center columns are dropped from `schema.sql` (fresh
  databases). Existing databases carry them as NOT NULL, so inserts from the
  new code would violate the constraint: `src/db/client.ts` detects the
  legacy layout at startup and refuses to start with an explicit remediation
  message (a one-off operator script drops the columns; predictions history
  is diagnostic data of a retired head). Loud failure was chosen over silent
  per-tick insert errors and over auto-dropping operator data.
- **web portal**: the prediction chart's band now renders
  `active_bin ± 1.28 × width_sigma` instead of the q10–q90 band, and no
  longer draws a predicted-center line.
- The `emaTrend` strategy was removed outright (2026-07-12): dual-EMA
  trend-biased placement is a directional bet, and the same evidence that
  killed the center head (direction ≈ coin flip, in-sample and OOS) applies
  to it one-for-one. `FALLBACK_STRATEGY` now defaults to `multiBinSpot`
  (distribution placement, no directional bet) — the previous default WAS
  `emaTrend`, i.e. the Tier 0 safety floor itself was a falsified-premise
  strategy.
- Model artifacts trained under the old layout (v0.1.0, v0.2.0) fail
  `load_bundle` validation by design (missing files / different meta);
  retrain with `uv run python -m training.train_vol …` to produce a v0.3.0
  vol-only artifact.

## What would reverse this decision

A center (or skew) head that, on the same purged walk-forward protocol,
achieves `center_mae_ratio < 1.0` *and* a q10/q90 improvement that is
asymmetric beyond what the vol head explains — evaluated out-of-sample over
at least two market regimes. Until then, "center = spot" is not a fallback;
it is the measured optimum.
