import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { WalletConnectButton } from "@/components/WalletConnectButton";
import { DashboardPage } from "@/pages/DashboardPage";
import { IntelligencePage } from "@/pages/IntelligencePage";
import { PositionsPage } from "@/pages/PositionsPage";
import { AccountPage } from "@/pages/AccountPage";

type Page = "dashboard" | "intelligence" | "positions" | "account";

const PAGES: Array<{ id: Page; label: string }> = [
  { id: "dashboard", label: "Dashboard" },
  { id: "intelligence", label: "Intelligence" },
  { id: "positions", label: "Positions" },
  { id: "account", label: "Account" },
];

function pageFromPath(): Page {
  const seg = window.location.pathname.split("/").filter(Boolean)[0];
  return (PAGES.find((p) => p.id === seg)?.id ?? "dashboard") as Page;
}

export function App() {
  const [page, setPage] = useState<Page>(pageFromPath);

  useEffect(() => {
    const onPop = () => setPage(pageFromPath());
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  const navigate = (next: Page) => {
    window.history.pushState(null, "", next === "dashboard" ? "/" : `/${next}`);
    setPage(next);
  };

  const summary = useQuery({ queryKey: ["agentSummary"], queryFn: api.agentSummary });

  return (
    <div className="mx-auto min-h-screen max-w-6xl px-4 pb-16">
      {summary.data?.demo && (
        <div className="border-l1/40 bg-l1/10 -mx-4 flex flex-wrap items-center justify-center gap-x-3 gap-y-1 border-b px-4 py-2 text-center">
          <span className="font-display text-l1 text-[0.72rem] font-bold tracking-[0.18em] uppercase">
            ● Demo data
          </span>
          <span className="text-ink-2 text-xs">
            Seeded sample dataset for UI demonstration — no real funds, no on-chain execution;
            NAV, fees and rebalance figures are illustrative, not real performance.
          </span>
        </div>
      )}
      <header className="border-line flex items-center justify-between border-b py-4">
        <div className="flex items-baseline gap-3">
          <span className="font-display text-mint text-lg font-bold tracking-widest">
            LIQUIDITY<span className="text-ink">MANAGER</span>
          </span>
          <span className="font-mono text-ink-3 hidden text-[11px] sm:inline">
            open-source LP-agent template · self-host for your own users
          </span>
        </div>
        <div className="flex items-center gap-3">
          {summary.data && (
            <span className="text-ink-3 hidden items-center gap-2 text-xs md:flex">
              <span className="live-dot" />
              <span className="mono-num">
                {summary.data.activePms} PM · {summary.data.succeededRebalances} rebalances
              </span>
            </span>
          )}
          <WalletConnectButton />
        </div>
      </header>

      <nav className="border-line mt-0 flex gap-1 border-b">
        {PAGES.map((p) => (
          <button
            key={p.id}
            onClick={() => navigate(p.id)}
            className={`font-display px-4 py-3 text-[0.78rem] font-semibold tracking-[0.12em] uppercase transition-colors ${
              page === p.id
                ? "text-mint border-mint -mb-px border-b-2"
                : "text-ink-3 hover:text-ink-2"
            }`}
          >
            {p.label}
          </button>
        ))}
      </nav>

      {summary.isError && (
        <div className="panel border-l3/40 mt-6 border-l-2 p-4 text-sm">
          <span className="text-l3 font-display tracking-wider uppercase">agent offline</span>
          <span className="text-ink-2 ml-3">
            Cannot reach the agent API — start it with TREASURY_HTTP_ENABLED=true, or run
            scripts/serve-demo-api.ts for the demo dataset.
          </span>
        </div>
      )}

      <main className="rise-in mt-6" key={page}>
        {page === "dashboard" && <DashboardPage />}
        {page === "intelligence" && <IntelligencePage />}
        {page === "positions" && <PositionsPage />}
        {page === "account" && <AccountPage />}
      </main>

      <footer className="text-ink-3 mt-16 flex items-center justify-between gap-4 text-xs">
        <span>
          Reference portal from the open-source <b className="text-ink-2">lp-agent template</b>{" "}
          (Apache-2.0) — each operator self-hosts it for their own users. Non-custodial: the agent
          can never withdraw, only the owner can.
        </span>
        {summary.data && (
          <span className="mono-num">model {summary.data.modelVersion ?? "—"}</span>
        )}
      </footer>
    </div>
  );
}
