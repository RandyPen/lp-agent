import { useState } from "react";
import { useQuery, useInfiniteQuery } from "@tanstack/react-query";
import { useCurrentAccount } from "@mysten/dapp-kit-react";
import { api, type RebalanceEntry } from "@/lib/api";
import { NavChart } from "@/components/charts";
import { EmptyState, LoadingRow, Panel, StatusPill } from "@/components/primitives";
import { EnrollWizard } from "./EnrollWizard";
import {
  explorerAddressUrl,
  explorerObjectUrl,
  explorerTxUrl,
  formatRaw,
  formatTs,
  formatUsd,
  truncateAddress,
} from "@/lib/format";
import { POOL } from "@/lib/cdpm";
import {
  fetchAgentEvents,
  eventAmountLabel,
  type AgentOnchainEvent,
} from "@/lib/onchainEvents";

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

      <OnchainActivityPanel />

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

// ---------------------------------------------------------------------------
// On-chain agent activity — queried directly from Sui GraphQL (no backend).
// Public data: shown regardless of wallet connection. Surfaces REAL mainnet
// agent events across all PMs, including third-party agents that aren't ours.
// ---------------------------------------------------------------------------

const KIND_META: Record<AgentOnchainEvent["kind"], { label: string; color: string }> = {
  AgentLiquidityAdded: { label: "add", color: "var(--color-mint)" },
  AgentLiquidityRemoved: { label: "remove", color: "var(--color-s-orange)" },
  AgentFeeCollected: { label: "fee", color: "var(--color-s-blue)" },
  AgentRewardCollected: { label: "reward", color: "var(--color-s-violet)" },
};

function OnchainActivityPanel() {
  const q = useInfiniteQuery({
    queryKey: ["onchainAgentEvents"],
    queryFn: ({ pageParam }) => fetchAgentEvents({ before: pageParam, pageSize: 20 }),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => (last.hasMore ? last.cursor : undefined),
  });
  const events = q.data?.pages.flatMap((p) => p.events) ?? [];

  return (
    <Panel
      title="On-chain agent activity — all PMs (verifiable)"
      right={
        <span className="text-ink-3 font-mono text-[11px]">
          live from Sui GraphQL · every row is a real mainnet tx
        </span>
      }
    >
      {q.isLoading ? (
        <LoadingRow />
      ) : q.isError ? (
        <EmptyState>Could not reach Sui GraphQL — retry shortly.</EmptyState>
      ) : events.length === 0 ? (
        <EmptyState>No agent events found on-chain yet.</EmptyState>
      ) : (
        <div className="space-y-1.5">
          {events.map((e, i) => (
            <AgentEventRow key={`${e.digest}-${e.kind}-${e.pmId}-${i}`} e={e} />
          ))}
          <div className="pt-2 text-center">
            {q.hasNextPage ? (
              <button
                onClick={() => q.fetchNextPage()}
                disabled={q.isFetchingNextPage}
                className="font-display text-ink-2 hover:text-mint border-line-2 hover:border-mint-dim rounded-md border px-4 py-1.5 text-xs tracking-wider uppercase transition-colors disabled:opacity-50"
              >
                {q.isFetchingNextPage ? "Loading…" : "Load more ↓"}
              </button>
            ) : (
              <span className="text-ink-3 text-xs">— end of history —</span>
            )}
          </div>
        </div>
      )}
    </Panel>
  );
}

function AgentEventRow({ e }: { e: AgentOnchainEvent }) {
  const meta = KIND_META[e.kind];
  return (
    <div className="border-line/60 hover:bg-panel-2 flex items-center gap-3 rounded-md border px-3 py-2 text-sm transition-colors">
      <span className="text-ink-3 mono-num w-24 shrink-0 text-xs">{formatTs(e.timestampMs)}</span>
      <span
        className="font-display w-16 shrink-0 text-[10px] font-bold tracking-wider uppercase"
        style={{ color: meta.color }}
      >
        {meta.label}
      </span>
      <a
        className="text-s-blue mono-num shrink-0 text-xs underline decoration-dotted"
        href={explorerAddressUrl(e.agent)}
        target="_blank"
        rel="noreferrer"
        title={e.agent}
      >
        {truncateAddress(e.agent)}
      </a>
      <span className="text-ink-3 mono-num hidden shrink-0 text-xs lg:inline" title={e.pmId}>
        PM {truncateAddress(e.pmId)}
      </span>
      <span className="text-ink-2 mono-num flex-1 truncate text-right text-xs">
        {eventAmountLabel(e)}
      </span>
      <a
        className="text-s-blue shrink-0 text-xs underline decoration-dotted"
        href={explorerTxUrl(e.digest)}
        target="_blank"
        rel="noreferrer"
      >
        tx ↗
      </a>
    </div>
  );
}
