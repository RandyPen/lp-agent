import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { buildFanPoints, PredictionFan } from "@/components/charts";
import { EmptyState, LoadingRow, Panel, StatTile, StateBadge } from "@/components/primitives";
import { formatTs } from "@/lib/format";

const DAY_MS = 24 * 3600 * 1000;

export function IntelligencePage() {
  const summary = useQuery({ queryKey: ["agentSummary"], queryFn: api.agentSummary });
  const predictions = useQuery({
    queryKey: ["predictions"],
    queryFn: () => api.predictions(1000),
  });
  const prices = useQuery({
    queryKey: ["prices"],
    queryFn: () => api.prices(Date.now() - 3 * DAY_MS, 400),
  });
  const shadow = useQuery({
    queryKey: ["shadow"],
    queryFn: () => api.shadowDecisions(200),
  });

  const binStep = summary.data?.pool.binStep ?? 50;
  const recentPreds = (predictions.data ?? []).filter(
    (p) => p.ts_ms >= Date.now() - 3 * DAY_MS,
  );
  const fan =
    prices.data && recentPreds.length > 0
      ? buildFanPoints(recentPreds, prices.data.points, binStep)
      : null;

  const latest = predictions.data?.[0];
  const modelShare =
    predictions.data && predictions.data.length > 0
      ? predictions.data.filter((p) => p.executed_path === "model").length /
        predictions.data.length
      : null;

  // Shadow agreement: how often the ML strategy and rule baseline chose the
  // same output kind on the same tick.
  const shadowRows = shadow.data ?? [];
  const comparable = shadowRows.filter((s) => s.rule_output_kind !== null);
  const agree = comparable.filter((s) => s.strategy_output_kind === s.rule_output_kind).length;

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <StatTile
          label="Model"
          value={<span className="text-base">{latest?.model_version ?? "—"}</span>}
          sub="LightGBM vol head · σ only (center head removed)"
        />
        <StatTile
          label="Model-path share"
          value={modelShare == null ? "—" : `${(modelShare * 100).toFixed(1)}%`}
          sub="vs Tier-0 rule fallback"
        />
        <StatTile
          label="P(break above / below)"
          value={
            latest ? (
              <span className="text-lg">
                {(latest.p_above * 100).toFixed(0)}% / {(latest.p_below * 100).toFixed(0)}%
              </span>
            ) : (
              "—"
            )
          }
          sub={latest ? `σ ${latest.width_sigma.toFixed(2)} bins · PSI ${latest.psi.toFixed(3)}` : ""}
        />
        <StatTile
          label="Inference"
          value={latest ? `${latest.infer_ms}ms` : "—"}
          sub={latest ? `last at ${formatTs(latest.ts_ms)}` : "sidecar offline"}
        />
      </div>

      <Panel
        title="Price vs ±1.28σ vol band — 3 days"
        right={
          <span className="text-ink-3 font-mono text-[11px]">
            liquidity is placed as a σ-scaled band centered on spot (no direction predicted)
          </span>
        }
      >
        {predictions.isLoading || prices.isLoading ? (
          <LoadingRow />
        ) : fan && fan.bandPoints.length > 0 ? (
          <PredictionFan data={fan} />
        ) : (
          <EmptyState>
            No predictions in the last 3 days. Start the ML sidecar (ml/) and the agent to see
            the vol band.
          </EmptyState>
        )}
      </Panel>

      <Panel
        title="Shadow mode — ML strategy vs rule baseline"
        right={
          comparable.length > 0 ? (
            <span className="mono-num text-ink-2 text-xs">
              agreement {((agree / comparable.length) * 100).toFixed(0)}% over {comparable.length}{" "}
              ticks
            </span>
          ) : undefined
        }
      >
        {shadow.isLoading ? (
          <LoadingRow />
        ) : shadowRows.length === 0 ? (
          <EmptyState>
            No shadow decisions yet. Shadow mode records what the ML strategy would have done —
            side by side with the live rule-based strategy — without executing it.
          </EmptyState>
        ) : (
          <div className="max-h-96 overflow-auto">
            <table className="w-full min-w-[720px] text-left text-sm">
              <thead className="bg-panel sticky top-0">
                <tr className="text-ink-3 border-line border-b font-mono text-[11px] uppercase">
                  <th className="py-2 pr-3">time</th>
                  <th className="py-2 pr-3">state</th>
                  <th className="py-2 pr-3">ML output</th>
                  <th className="py-2 pr-3">rule output</th>
                  <th className="py-2 pr-3">half-width</th>
                  <th className="py-2 pr-3">bias</th>
                  <th className="py-2">lending</th>
                </tr>
              </thead>
              <tbody className="mono-num">
                {shadowRows.slice(0, 60).map((s, i) => {
                  const differs =
                    s.rule_output_kind !== null && s.strategy_output_kind !== s.rule_output_kind;
                  return (
                    <tr key={i} className="border-line/60 border-b last:border-0">
                      <td className="text-ink-3 py-1.5 pr-3">{formatTs(s.ts_ms)}</td>
                      <td className="py-1.5 pr-3">
                        <StateBadge state={s.market_state} />
                      </td>
                      <td
                        className="py-1.5 pr-3"
                        style={differs ? { color: "var(--color-s-violet)" } : undefined}
                      >
                        {s.strategy_output_kind}
                      </td>
                      <td className="text-ink-2 py-1.5 pr-3">{s.rule_output_kind ?? "—"}</td>
                      <td className="py-1.5 pr-3">{s.half_width ?? "—"}</td>
                      <td className="py-1.5 pr-3">
                        {s.trend_bias == null ? "—" : s.trend_bias.toFixed(2)}
                      </td>
                      <td className="py-1.5">
                        {s.lending_pct == null ? "—" : `${(s.lending_pct * 100).toFixed(0)}%`}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
    </div>
  );
}
