import { useQuery } from "@tanstack/react-query";
import { api, type PnlTick } from "@/lib/api";
import { NavChart, FeeChart, StateRibbon } from "@/components/charts";
import {
  EmptyState,
  LoadingRow,
  Panel,
  RiskLevelBadge,
  StatTile,
  StateBadge,
  TableScroll,
} from "@/components/primitives";
import { formatAgo, formatTs, formatUsd, truncateAddress } from "@/lib/format";

const MAX_CHART_PMS = 4;

export function DashboardPage() {
  const summary = useQuery({ queryKey: ["agentSummary"], queryFn: api.agentSummary });
  const pms = useQuery({ queryKey: ["pms"], queryFn: () => api.pms() });
  const states = useQuery({ queryKey: ["marketStates"], queryFn: () => api.marketStates(100) });
  const risk = useQuery({ queryKey: ["riskEvents"], queryFn: () => api.riskEvents(20) });

  const activePmIds = (pms.data ?? [])
    .filter((p) => p.status === "active")
    .slice(0, MAX_CHART_PMS)
    .map((p) => p.pm_id);

  const pnlQueries = useQuery({
    queryKey: ["pnlAll", activePmIds],
    enabled: activePmIds.length > 0,
    queryFn: async () => {
      const results = await Promise.all(activePmIds.map((id) => api.pnl(id)));
      return activePmIds.map((id, i) => ({ pmId: id, ticks: results[i]! }));
    },
  });

  const navSeries = (pnlQueries.data ?? []).map((s) => ({
    name: truncateAddress(s.pmId),
    points: s.ticks,
  }));

  // Portfolio stats derived from the per-PM tick series.
  const allSeries = pnlQueries.data ?? [];
  const navNow = allSeries.reduce((sum, s) => sum + (s.ticks.at(-1)?.nav_usd ?? 0), 0);
  const dayAgo = Date.now() - 24 * 3600 * 1000;
  // Baseline = each series' first NAV sample inside the 24h window. A series
  // whose samples are all older than a day has no baseline, and there is no
  // honest 24h number to show — falling back to its latest tick would make
  // navDayAgo === navNow and render a confident "+0.00%" over stale data.
  const baselines = allSeries.map((s) => s.ticks.find((t) => t.ts_ms >= dayAgo));
  const has24hBaseline = allSeries.length > 0 && baselines.every((b) => b != null);
  const navDayAgo = has24hBaseline ? baselines.reduce((sum, b) => sum + b!.nav_usd, 0) : 0;
  const pnl24hPct = has24hBaseline && navDayAgo > 0 ? ((navNow - navDayAgo) / navDayAgo) * 100 : null;
  const cumFees = allSeries.reduce(
    (sum, s) => sum + s.ticks.reduce((f, t) => f + t.fee_income_usd, 0),
    0,
  );

  const feePoints = buildCumulativeFees(allSeries.flatMap((s) => s.ticks));
  const currentState = states.data?.find((e) => e.exited_at_ms === null)?.state ?? null;
  const openL3 = (risk.data ?? []).some((e) => e.level === "L3" && e.resolved_at_ms === null);

  return (
    <div className="space-y-4">
      {openL3 && (
        <div className="panel border-l3 border-l-2 p-4">
          <span className="text-l3 font-display text-sm font-bold tracking-widest uppercase">
            L3 emergency stop active
          </span>
          <span className="text-ink-2 ml-3 text-sm">
            The agent has halted all rebalancing. Funds remain in custody, withdrawable by owners only.
          </span>
        </div>
      )}

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <StatTile
          label="Managed NAV"
          value={pnlQueries.isSuccess ? `$${formatUsd(navNow)}` : "—"}
          sub={`${summary.data?.activePms ?? "—"} active PM${summary.data?.activePms === 1 ? "" : "s"}`}
        />
        <StatTile
          label="24h PnL"
          value={
            pnl24hPct == null ? (
              "—"
            ) : (
              <span style={{ color: pnl24hPct >= 0 ? "var(--color-mint)" : "var(--color-l3)" }}>
                {pnl24hPct >= 0 ? "+" : ""}
                {pnl24hPct.toFixed(2)}%
              </span>
            )
          }
          sub={pnl24hPct == null ? "no NAV sample in the last 24h" : "mark-to-market"}
        />
        <StatTile
          label="Fees harvested"
          value={
            pnlQueries.isSuccess ? (
              <span className="text-gold">${formatUsd(cumFees)}</span>
            ) : (
              "—"
            )
          }
          sub="cumulative swap-fee income"
        />
        <StatTile
          label="Market state"
          value={<StateBadge state={currentState} />}
          sub={
            summary.data?.lastRebalanceMs
              ? `last rebalance ${formatAgo(summary.data.lastRebalanceMs)}`
              : "no rebalances yet"
          }
        />
      </div>

      <Panel title="Net asset value — per position manager">
        {pnlQueries.isLoading && activePmIds.length > 0 ? (
          <LoadingRow />
        ) : navSeries.length > 0 ? (
          <NavChart series={navSeries} />
        ) : (
          <EmptyState>
            No PnL history yet. NAV samples appear once the agent starts managing a position.
          </EmptyState>
        )}
      </Panel>

      <div className="grid gap-4 lg:grid-cols-2">
        <Panel title="Cumulative fee income">
          {feePoints.length > 0 ? (
            <FeeChart ticks={feePoints} />
          ) : (
            <EmptyState>No fee income recorded yet.</EmptyState>
          )}
        </Panel>

        <Panel title="Market state timeline">
          {states.data && states.data.length > 0 ? (
            <div className="pt-2">
              <StateRibbon episodes={states.data} now={Date.now()} />
              <div className="mt-4 flex gap-4">
                {(["NORMAL", "TREND", "EXTREME"] as const).map((s) => (
                  <StateBadge key={s} state={s} />
                ))}
              </div>
              <p className="text-ink-3 mt-3 text-xs leading-relaxed">
                The three-state machine drives evaluation cadence and strategy posture: steady
                fee-harvesting in NORMAL, directional bias in TREND, full withdrawal to custody
                balance in EXTREME.
              </p>
            </div>
          ) : (
            <EmptyState>No state transitions recorded yet.</EmptyState>
          )}
        </Panel>
      </div>

      <Panel
        title="Risk events"
        right={
          <span className="text-ink-3 font-mono text-[11px]">
            L1 observe · L2 de-risk · L3 emergency stop
          </span>
        }
      >
        {risk.isLoading ? (
          <LoadingRow />
        ) : (risk.data ?? []).length === 0 ? (
          <EmptyState>
            No live risk events — all circuits green. L1/L2/L3 breakers publish here the moment
            they trip.
          </EmptyState>
        ) : (
          <TableScroll>
            <table className="w-full min-w-[720px] text-left text-sm">
              <thead>
                <tr className="text-ink-3 border-line border-b font-mono text-[11px] uppercase">
                  <th className="py-2 pr-3">level</th>
                  <th className="py-2 pr-3">kind</th>
                  <th className="py-2 pr-3">metric</th>
                  <th className="py-2 pr-3">observed / threshold</th>
                  <th className="py-2 pr-3">action</th>
                  <th className="py-2 pr-3">time</th>
                  <th className="py-2">status</th>
                </tr>
              </thead>
              <tbody className="mono-num">
                {(risk.data ?? []).map((e, i) => (
                  <tr key={i} className="border-line/60 border-b last:border-0">
                    <td className="py-2 pr-3">
                      <RiskLevelBadge level={e.level} />
                    </td>
                    <td className="py-2 pr-3">{e.kind}</td>
                    <td className="text-ink-2 py-2 pr-3">{e.metric}</td>
                    <td className="py-2 pr-3">
                      {e.observed} / {e.threshold}
                    </td>
                    <td className="text-ink-2 py-2 pr-3">{e.action}</td>
                    <td className="text-ink-3 py-2 pr-3">{formatTs(e.ts_ms)}</td>
                    <td className="py-2">
                      {e.resolved_at_ms ? (
                        <span className="text-ink-3">resolved</span>
                      ) : (
                        <span style={{ color: "var(--color-l2)" }}>open</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableScroll>
        )}
      </Panel>
    </div>
  );
}

function buildCumulativeFees(ticks: PnlTick[]): Array<{ ts_ms: number; cum_fees: number }> {
  const sorted = [...ticks].sort((a, b) => a.ts_ms - b.ts_ms);
  let cum = 0;
  return sorted.map((t) => {
    cum += t.fee_income_usd;
    return { ts_ms: t.ts_ms, cum_fees: Number(cum.toFixed(4)) };
  });
}
