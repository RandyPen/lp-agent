import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useCurrentAccount } from "@mysten/dapp-kit-react";
import { api, type RebalanceEntry } from "@/lib/api";
import { NavChart } from "@/components/charts";
import { EmptyState, LoadingRow, Panel, StatusPill } from "@/components/primitives";
import { EnrollWizard } from "./EnrollWizard";
import {
  explorerObjectUrl,
  explorerTxUrl,
  formatRaw,
  formatTs,
  formatUsd,
  truncateAddress,
} from "@/lib/format";
import { POOL } from "@/lib/cdpm";

export function PositionsPage() {
  const account = useCurrentAccount();
  const [wizardOpen, setWizardOpen] = useState(false);
  const [selectedPm, setSelectedPm] = useState<string | null>(null);

  const pms = useQuery({
    queryKey: ["pms", account?.address],
    enabled: !!account,
    queryFn: () => api.pms(account!.address),
  });

  const active = selectedPm ?? pms.data?.[0]?.pm_id ?? null;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-ink-3 text-sm">
          {account
            ? "PositionManagers you own that this agent manages."
            : "Connect your wallet to see your managed positions."}
        </p>
        <button className="btn-primary" onClick={() => setWizardOpen(true)} disabled={!account}>
          + Enroll position
        </button>
      </div>

      {wizardOpen && <EnrollWizard onClose={() => setWizardOpen(false)} />}

      {account && pms.isLoading && <LoadingRow />}

      {account && pms.isSuccess && pms.data.length === 0 && (
        <EmptyState>
          No managed positions for {truncateAddress(account.address)} yet. Enroll one — the flow
          creates your custody PositionManager and authorizes the agent in two transactions.
        </EmptyState>
      )}

      {account && (pms.data ?? []).length > 0 && (
        <>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {(pms.data ?? []).map((pm) => (
              <button
                key={pm.pm_id}
                onClick={() => setSelectedPm(pm.pm_id)}
                className={`panel p-4 text-left transition-colors ${
                  active === pm.pm_id ? "border-[var(--color-mint-dim)]" : "hover:border-line-2"
                }`}
              >
                <div className="flex items-center justify-between">
                  <span className="mono-num text-sm">{truncateAddress(pm.pm_id)}</span>
                  <StatusPill status={pm.status} />
                </div>
                <div className="text-ink-3 mt-2 text-xs">
                  {POOL.label} · enrolled {formatTs(pm.added_at_ms)}
                </div>
                <a
                  className="text-s-blue mt-1 inline-block font-mono text-[11px] underline decoration-dotted"
                  href={explorerObjectUrl(pm.pm_id)}
                  target="_blank"
                  rel="noreferrer"
                  onClick={(e) => e.stopPropagation()}
                >
                  view on-chain ↗
                </a>
              </button>
            ))}
          </div>

          {active && <PmDetail pmId={active} />}
        </>
      )}
    </div>
  );
}

function PmDetail({ pmId }: { pmId: string }) {
  const pnl = useQuery({ queryKey: ["pnl", pmId], queryFn: () => api.pnl(pmId) });
  const rebalances = useQuery({
    queryKey: ["rebalances", pmId],
    queryFn: () => api.rebalances(pmId, 50),
  });
  const [expanded, setExpanded] = useState<number | null>(null);

  const ticks = pnl.data ?? [];
  const nav = ticks.at(-1)?.nav_usd;
  const fees = ticks.reduce((s, t) => s + t.fee_income_usd, 0);
  const credits = ticks.reduce((s, t) => s + t.cost_credits, 0);

  return (
    <div className="space-y-4">
      <Panel
        title={`Position ${truncateAddress(pmId)}`}
        right={
          <span className="mono-num text-ink-2 text-xs">
            {nav != null && `NAV $${formatUsd(nav)} · `}fees ${`$${formatUsd(fees)}`} · cost{" "}
            {credits.toLocaleString()} credits
          </span>
        }
      >
        {pnl.isLoading ? (
          <LoadingRow />
        ) : ticks.length > 0 ? (
          <NavChart series={[{ name: truncateAddress(pmId), points: ticks }]} />
        ) : (
          <EmptyState>No NAV samples yet for this PM.</EmptyState>
        )}
      </Panel>

      <Panel title="Rebalance history">
        {rebalances.isLoading ? (
          <LoadingRow />
        ) : (rebalances.data ?? []).length === 0 ? (
          <EmptyState>
            No rebalances yet — the first one lands within an evaluation interval of enrollment.
          </EmptyState>
        ) : (
          <div className="space-y-1.5">
            {(rebalances.data ?? []).map((r) => (
              <RebalanceRow
                key={r.id}
                entry={r}
                expanded={expanded === r.id}
                onToggle={() => setExpanded(expanded === r.id ? null : r.id)}
              />
            ))}
          </div>
        )}
      </Panel>
    </div>
  );
}

function RebalanceRow(props: {
  entry: RebalanceEntry;
  expanded: boolean;
  onToggle: () => void;
}) {
  const { entry: r, expanded, onToggle } = props;
  return (
    <div className="border-line/60 rounded-md border">
      <button
        onClick={onToggle}
        className="hover:bg-panel-2 flex w-full items-center gap-3 rounded-md px-3 py-2 text-left text-sm transition-colors"
      >
        <span className="text-ink-3 mono-num w-32 shrink-0 text-xs">
          {formatTs(r.plannedAtMs)}
        </span>
        <StatusPill status={r.status} />
        {r.summary.priority === "emergency" && (
          <span className="font-display text-l3 text-[10px] font-bold tracking-wider uppercase">
            emergency
          </span>
        )}
        <span className="text-ink-2 flex-1 truncate text-xs">{r.summary.reason}</span>
        <span className="mono-num text-ink-3 hidden text-xs sm:inline">
          −{r.summary.removeBinCount} / +{r.summary.addBinCount} bins
        </span>
        <span className="text-ink-3 text-xs">{expanded ? "−" : "+"}</span>
      </button>
      {expanded && (
        <div className="border-line/60 mono-num space-y-1.5 border-t px-3 py-2.5 text-xs">
          <div className="grid gap-1 sm:grid-cols-2">
            <span className="text-ink-3">
              add {POOL.symbolA}:{" "}
              <span className="text-ink">{formatRaw(r.summary.addAmountA, POOL.decimalsA)}</span>
            </span>
            <span className="text-ink-3">
              add {POOL.symbolB}:{" "}
              <span className="text-ink">{formatRaw(r.summary.addAmountB, POOL.decimalsB)}</span>
            </span>
            <span className="text-ink-3">
              planned active bin: <span className="text-ink">{r.summary.plannedActiveBinId ?? "—"}</span>
            </span>
            <span className="text-ink-3">
              collect fees: <span className="text-ink">{r.summary.collectFees ? "yes" : "no"}</span>
            </span>
          </div>
          {r.error && <div className="text-l3 break-all">{r.error}</div>}
          {r.digest && (
            <a
              className="text-s-blue inline-block underline decoration-dotted"
              href={explorerTxUrl(r.digest)}
              target="_blank"
              rel="noreferrer"
            >
              {r.digest} ↗
            </a>
          )}
          <details className="text-ink-3">
            <summary className="cursor-pointer select-none">full plan JSON</summary>
            <pre className="bg-panel-2 mt-1.5 max-h-64 overflow-auto rounded-md p-2 text-[11px] leading-relaxed">
              {JSON.stringify(r.plan, null, 2)}
            </pre>
          </details>
        </div>
      )}
    </div>
  );
}
