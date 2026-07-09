import type { ReactNode } from "react";

export function StatTile(props: { label: string; value: ReactNode; sub?: ReactNode }) {
  return (
    <div className="panel p-4">
      <div className="panel-title">{props.label}</div>
      <div className="mono-num text-ink mt-1.5 text-2xl font-medium">{props.value}</div>
      {props.sub != null && <div className="text-ink-3 mt-1 text-xs">{props.sub}</div>}
    </div>
  );
}

const STATE_COLORS: Record<string, string> = {
  NORMAL: "var(--color-state-normal)",
  TREND: "var(--color-state-trend)",
  EXTREME: "var(--color-state-extreme)",
};

export function StateBadge({ state }: { state: string | null }) {
  if (!state) return <span className="text-ink-3 text-xs">—</span>;
  const color = STATE_COLORS[state] ?? "var(--color-ink-3)";
  return (
    <span
      className="font-display inline-flex items-center gap-1.5 rounded-sm px-2 py-0.5 text-[11px] font-semibold tracking-wider uppercase"
      style={{ color, background: `color-mix(in srgb, ${color} 12%, transparent)` }}
    >
      <span className="h-1.5 w-1.5 rounded-full" style={{ background: color }} />
      {state}
    </span>
  );
}

const LEVEL_COLORS: Record<string, string> = {
  L1: "var(--color-l1)",
  L2: "var(--color-l2)",
  L3: "var(--color-l3)",
};

export function RiskLevelBadge({ level }: { level: string }) {
  const color = LEVEL_COLORS[level] ?? "var(--color-ink-3)";
  return (
    <span
      className="font-display inline-block rounded-sm px-1.5 py-0.5 text-[11px] font-bold tracking-wider"
      style={{ color, background: `color-mix(in srgb, ${color} 14%, transparent)` }}
    >
      {level}
    </span>
  );
}

export function StatusPill({ status }: { status: string }) {
  const map: Record<string, string> = {
    succeeded: "var(--color-state-normal)",
    active: "var(--color-state-normal)",
    failed: "var(--color-l3)",
    revoked: "var(--color-l2)",
    closed: "var(--color-ink-3)",
    planned: "var(--color-s-blue)",
    submitted: "var(--color-s-blue)",
  };
  const color = map[status] ?? "var(--color-ink-3)";
  return (
    <span
      className="font-mono rounded-sm px-1.5 py-0.5 text-[11px]"
      style={{ color, background: `color-mix(in srgb, ${color} 12%, transparent)` }}
    >
      {status}
    </span>
  );
}

export function Panel(props: { title: string; right?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`panel p-4 ${props.className ?? ""}`}>
      <div className="mb-3 flex items-center justify-between">
        <h2 className="panel-title">{props.title}</h2>
        {props.right}
      </div>
      {props.children}
    </section>
  );
}

export function EmptyState({ children }: { children: ReactNode }) {
  return (
    <div className="border-line-2 text-ink-3 rounded-md border border-dashed px-4 py-8 text-center text-sm">
      {children}
    </div>
  );
}

export function LoadingRow() {
  return (
    <div className="text-ink-3 flex items-center gap-2 py-6 text-sm">
      <span className="live-dot" /> loading…
    </div>
  );
}
