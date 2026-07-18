import { useQuery } from "@tanstack/react-query";
import { api, type AgentSummary } from "@/lib/api";
import { formatAgo } from "@/lib/format";

const HOUR_MS = 3600 * 1000;
const STALE_MS = HOUR_MS;

/**
 * Live market readout under the masthead — every figure comes from the agent's
 * public read-only API, refreshed on a slow poll. Cells render "—" until their
 * query lands so the strip never jumps.
 */
export function StatusStrip({ summary }: { summary: AgentSummary | undefined }) {
  const prices = useQuery({
    queryKey: ["stripPrices"],
    queryFn: () => api.prices(0, 200),
    refetchInterval: 30_000,
  });
  const states = useQuery({
    queryKey: ["stripState"],
    queryFn: () => api.marketStates(5),
    refetchInterval: 60_000,
  });
  const predictions = useQuery({
    queryKey: ["stripPrediction"],
    queryFn: () => api.predictions(1),
    refetchInterval: 60_000,
  });
  const risk = useQuery({
    queryKey: ["stripRisk"],
    queryFn: () => api.riskEvents(50),
    refetchInterval: 60_000,
  });

  const points = prices.data?.points ?? [];
  const last = points.at(-1);
  const prev = points.at(-2);
  const price = last ? Number(last.price) : null;
  const dir = price != null && prev != null ? Math.sign(price - Number(prev.price)) : 0;
  // An old sample must not read as a live quote — surface its age instead.
  const priceStale = last != null && Date.now() - last.observed_ms > STALE_MS;

  const state = states.data?.find((e) => e.exited_at_ms === null)?.state ?? null;
  const stateColor =
    state === "NORMAL"
      ? "var(--color-state-normal)"
      : state === "TREND"
        ? "var(--color-state-trend)"
        : state === "EXTREME"
          ? "var(--color-state-extreme)"
          : "var(--color-ink-3)";

  const pred = predictions.data?.[0];
  const openCircuits = (risk.data ?? []).filter((e) => e.resolved_at_ms === null);
  const worstOpen = ["L3", "L2", "L1"].find((l) => openCircuits.some((e) => e.level === l));

  return (
    <div className="border-line -mx-4 overflow-x-auto border-b px-4 [scrollbar-width:none]">
      <div className="flex items-center gap-6 py-2">
        <span className="strip-cell">
          <span className="strip-label">{summary?.pool.pricePairLabel ?? "pool"}</span>
          <span className={`strip-value ${priceStale ? "text-ink-3" : "text-ink"}`}>
            {price != null ? price.toFixed(4) : "—"}
            {!priceStale && dir !== 0 && (
              <span
                className="ml-1"
                style={{ color: dir > 0 ? "var(--color-mint)" : "var(--color-l3)" }}
              >
                {dir > 0 ? "▲" : "▼"}
              </span>
            )}
            {priceStale && last && (
              <span className="text-ink-3 ml-1">({formatAgo(last.observed_ms)})</span>
            )}
          </span>
        </span>

        <span className="strip-cell">
          <span className="strip-label">state</span>
          <span className="strip-value" style={{ color: stateColor }}>
            {state ?? "—"}
          </span>
        </span>

        <span className="strip-cell">
          <span className="strip-label">vol σ</span>
          <span className="strip-value">
            {pred ? `${pred.width_sigma.toFixed(2)} bins` : "—"}
          </span>
        </span>

        <span className="strip-cell">
          <span className="strip-label">circuits</span>
          <span
            className="strip-value"
            style={{
              color: worstOpen
                ? `var(--color-${worstOpen.toLowerCase()})`
                : "var(--color-mint)",
            }}
          >
            {risk.data ? (worstOpen ? `${worstOpen} open` : "green") : "—"}
          </span>
        </span>

        <span className="strip-cell">
          <span className="strip-label">rebalance</span>
          <span className="strip-value">
            {summary?.lastRebalanceMs ? formatAgo(summary.lastRebalanceMs) : "—"}
          </span>
        </span>

        <span className="strip-cell">
          <span className="strip-label">strategy</span>
          <span className="strip-value">{summary?.strategy ?? "—"}</span>
        </span>

        {summary?.modelVersion && (
          <span className="strip-cell">
            <span className="strip-label">model</span>
            <span className="strip-value">{summary.modelVersion}</span>
          </span>
        )}
      </div>
    </div>
  );
}
