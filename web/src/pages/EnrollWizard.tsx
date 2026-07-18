import { useState } from "react";
import { createPortal } from "react-dom";
import { useQuery } from "@tanstack/react-query";
import { useCurrentAccount, useCurrentClient } from "@mysten/dapp-kit-react";
import { api } from "@/lib/api";
import {
  buildCreatePositionTx,
  buildSetAgentTx,
  calculateSpotBinAmounts,
  CDPM,
  fetchPmIdFromTxEvents,
  fetchPoolSnapshot,
  POOL,
} from "@/lib/cdpm";
import { describeTxError, useSignAndExecute } from "@/lib/useSignAndExecute";
import { explorerTxUrl, truncateAddress } from "@/lib/format";

type Step = "intro" | "amounts" | "authorize" | "done";

const HALF_WIDTH = 3;

export function EnrollWizard({ onClose }: { onClose: () => void }) {
  const account = useCurrentAccount();
  const client = useCurrentClient();
  const signAndExecute = useSignAndExecute();

  const [step, setStep] = useState<Step>("intro");
  const [amountUsdc, setAmountUsdc] = useState("");
  const [amountSui, setAmountSui] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pmId, setPmId] = useState<string | null>(null);
  const [createDigest, setCreateDigest] = useState<string | null>(null);
  const [authorizeDigest, setAuthorizeDigest] = useState<string | null>(null);
  const [resumePmId, setResumePmId] = useState("");

  const summary = useQuery({ queryKey: ["agentSummary"], queryFn: api.agentSummary });
  const snapshot = useQuery({
    queryKey: ["poolSnapshot"],
    queryFn: () => fetchPoolSnapshot(client),
    staleTime: 30_000,
  });

  // Poll for the agent's auto-subscription once authorized.
  const subs = useQuery({
    queryKey: ["pms", account?.address],
    enabled: step === "done" && !!account,
    refetchInterval: 4000,
    queryFn: () => api.pms(account!.address),
  });
  const subscribed = pmId != null && (subs.data ?? []).some((s) => s.pm_id === pmId);

  /**
   * The portal signs against CDPM.PACKAGE_ID; the agent watches
   * summary.cdpmPackage. If they differ the AgentAdded event will never be
   * seen and custody silently won't start — refuse to proceed.
   */
  function assertDeploymentMatch(): void {
    if (!summary.data) throw new Error("agent API unreachable — cannot verify deployment");
    if (summary.data.cdpmPackage !== CDPM.PACKAGE_ID) {
      throw new Error(
        `deployment mismatch: portal signs on ${truncateAddress(CDPM.PACKAGE_ID)} but the agent watches ${truncateAddress(summary.data.cdpmPackage)}`,
      );
    }
  }

  async function handleCreate() {
    if (!account || !snapshot.data) return;
    setBusy("Building transaction…");
    setError(null);
    try {
      assertDeploymentMatch();
      const usdcRaw = BigInt(Math.round(Number(amountUsdc) * 10 ** POOL.decimalsA));
      const suiRaw = BigInt(Math.round(Number(amountSui) * 10 ** POOL.decimalsB));
      if (usdcRaw <= 0n && suiRaw <= 0n) throw new Error("enter at least one amount");

      const active = snapshot.data.activeBinId;
      const bins = Array.from({ length: HALF_WIDTH * 2 + 1 }, (_, i) => active - HALF_WIDTH + i);
      const { amountsA, amountsB } = calculateSpotBinAmounts(bins, active, usdcRaw, suiRaw);
      // Drop zero-zero bins (one side may be unfunded).
      const funded = bins
        .map((b, i) => ({ bin: b, a: amountsA[i]!, b_: amountsB[i]! }))
        .filter((x) => x.a > 0n || x.b_ > 0n);

      const tx = await buildCreatePositionTx(client, account.address, {
        poolId: POOL.poolId,
        coinTypeA: POOL.coinTypeA,
        coinTypeB: POOL.coinTypeB,
        bins: funded.map((x) => x.bin),
        amountsA: funded.map((x) => x.a),
        amountsB: funded.map((x) => x.b_),
      });

      setBusy("Waiting for wallet…");
      const result = await signAndExecute(tx);
      if (result.$kind === "FailedTransaction") {
        throw new Error(
          result.FailedTransaction.status.error?.message ?? "transaction failed on-chain",
        );
      }
      const digest = result.Transaction.digest;
      setCreateDigest(digest);

      setBusy("Confirming on-chain…");
      await client.waitForTransaction({ digest });

      setBusy("Locating your new PositionManager…");
      const created = await fetchPmIdFromTxEvents(digest);
      if (!created) {
        throw new Error(
          `position created (${digest}) but pm_id not found in events — paste the PM id below to continue`,
        );
      }
      setPmId(created);
      setStep("authorize");
    } catch (e) {
      setError(describeTxError(e, "create failed"));
    } finally {
      setBusy(null);
    }
  }

  async function handleAuthorize(targetPmId: string) {
    if (!account || !summary.data) return;
    setBusy("Waiting for wallet…");
    setError(null);
    try {
      assertDeploymentMatch();
      const tx = buildSetAgentTx(account.address, {
        pmId: targetPmId,
        agent: summary.data.agentAddress,
        enabled: true,
      });
      const result = await signAndExecute(tx);
      if (result.$kind === "FailedTransaction") {
        throw new Error(
          result.FailedTransaction.status.error?.message ?? "transaction failed on-chain",
        );
      }
      setAuthorizeDigest(result.Transaction.digest);
      setBusy("Confirming on-chain…");
      await client.waitForTransaction({ digest: result.Transaction.digest });
      setPmId(targetPmId);
      setStep("done");
    } catch (e) {
      setError(describeTxError(e, "authorization failed"));
    } finally {
      setBusy(null);
    }
  }

  const steps: Array<{ id: Step; label: string }> = [
    { id: "intro", label: "How it works" },
    { id: "amounts", label: "Deposit" },
    { id: "authorize", label: "Authorize agent" },
    { id: "done", label: "Live" },
  ];
  const stepIdx = steps.findIndex((s) => s.id === step);

  // Portal to <body>: an animated ancestor with a lingering transform would
  // otherwise become the containing block for this fixed overlay and clip it.
  return createPortal(
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/70 p-4 pt-12 backdrop-blur-sm">
      <div className="panel w-full max-w-2xl p-6">
        <div className="mb-5 flex items-center justify-between">
          <h2 className="font-display text-mint text-sm font-bold tracking-[0.2em] uppercase">
            Enroll a position
          </h2>
          <button className="btn-ghost" onClick={onClose}>
            Close
          </button>
        </div>

        {/* step indicator */}
        <div className="mb-6 flex items-center gap-2">
          {steps.map((s, i) => (
            <div key={s.id} className="flex flex-1 items-center gap-2 last:flex-none">
              <span
                className="font-mono flex h-5 w-5 shrink-0 items-center justify-center rounded-sm text-[11px]"
                style={
                  i === stepIdx
                    ? { background: "var(--color-mint)", color: "#052019" }
                    : i < stepIdx
                      ? { background: "var(--color-mint-dim)", color: "var(--color-ink)" }
                      : {
                          background: "var(--color-panel-2)",
                          color: "var(--color-ink-3)",
                          border: "1px solid var(--color-line-2)",
                        }
                }
              >
                {i < stepIdx ? "✓" : i + 1}
              </span>
              <span
                className={`font-display hidden text-[10px] font-semibold tracking-wider uppercase sm:inline ${
                  i <= stepIdx ? "text-ink-2" : "text-ink-3"
                }`}
              >
                {s.label}
              </span>
              {i < steps.length - 1 && (
                <span
                  className="h-px flex-1"
                  style={{
                    background: i < stepIdx ? "var(--color-mint-dim)" : "var(--color-line)",
                  }}
                />
              )}
            </div>
          ))}
        </div>

        {step === "intro" && (
          <div className="space-y-4">
            <p className="text-ink-2 text-sm leading-relaxed">
              Your liquidity goes into a <b>PositionManager</b> you own on-chain. You then
              whitelist this agent's address as an operator. The agent rebalances bins, harvests
              fees, and routes idle capital to lending — under a hard contract-enforced boundary:
            </p>
            <div className="grid gap-2 text-xs sm:grid-cols-2">
              <div className="border-line-2 rounded-md border p-3">
                <div className="text-mint font-display mb-1.5 tracking-wider uppercase">
                  Agent can
                </div>
                <ul className="text-ink-2 space-y-1">
                  <li>· add / remove liquidity inside your PM</li>
                  <li>· collect fees &amp; rewards into your fee bag</li>
                  <li>· lend idle balance (Scallop / Kai)</li>
                </ul>
              </div>
              <div className="border-line-2 rounded-md border p-3">
                <div className="text-l3 font-display mb-1.5 tracking-wider uppercase">
                  Agent can never
                </div>
                <ul className="text-ink-2 space-y-1">
                  <li>· withdraw funds — only you can</li>
                  <li>· close the position — only you can</li>
                  <li>· change PM config or other agents</li>
                </ul>
              </div>
            </div>
            <div
              className="rounded-md border p-3 text-xs leading-relaxed"
              style={{ borderColor: "color-mix(in srgb, var(--color-l1) 45%, transparent)" }}
            >
              <span className="font-display tracking-wider uppercase" style={{ color: "var(--color-l1)" }}>
                One-way door:
              </span>{" "}
              <span className="text-ink-2">
                once any agent is authorized, this PM permanently leaves LeafSheep's protocol
                management (its 20% managed-service fee is waived; the PM never reverts to
                protocol mode). You can revoke this agent and authorize another at any time.
              </span>
            </div>
            <button
              className="btn-primary w-full"
              disabled={!account}
              onClick={() => setStep("amounts")}
            >
              {account ? "Continue" : "Connect wallet first"}
            </button>
            <div className="border-line border-t pt-3">
              <div className="text-ink-3 mb-1.5 text-[11px]">
                Already created a PM but didn't finish authorizing? Paste its id:
              </div>
              <div className="flex gap-2">
                <input
                  value={resumePmId}
                  onChange={(e) => setResumePmId(e.target.value.trim())}
                  placeholder="0x…"
                  className="border-line-2 bg-panel-2 mono-num flex-1 rounded-md border px-3 py-2 text-xs outline-none focus:border-[var(--color-mint-dim)]"
                />
                <button
                  className="btn-ghost"
                  disabled={!/^0x[0-9a-fA-F]{64}$/.test(resumePmId) || busy !== null}
                  onClick={() => handleAuthorize(resumePmId)}
                >
                  Authorize
                </button>
              </div>
            </div>
          </div>
        )}

        {step === "amounts" && (
          <div className="space-y-4">
            <div className="border-line-2 bg-panel-2 flex items-center justify-between rounded-md border px-3 py-2.5 text-sm">
              <span className="font-display text-ink-2 tracking-wider">{POOL.label}</span>
              <span className="mono-num text-ink-2">
                {snapshot.data
                  ? `${snapshot.data.price.toFixed(4)} USDC/SUI · bin ${snapshot.data.activeBinId}`
                  : "loading pool…"}
              </span>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              {(
                [
                  { label: "USDC", value: amountUsdc, set: setAmountUsdc },
                  { label: "SUI", value: amountSui, set: setAmountSui },
                ] as const
              ).map((f) => (
                <label key={f.label} className="block">
                  <span className="text-ink-3 font-mono text-[11px] uppercase">{f.label}</span>
                  <input
                    value={f.value}
                    onChange={(e) => f.set(e.target.value)}
                    inputMode="decimal"
                    placeholder="0.0"
                    className="border-line-2 bg-panel-2 mono-num mt-1 w-full rounded-md border px-3 py-2.5 text-lg outline-none focus:border-[var(--color-mint-dim)]"
                  />
                </label>
              ))}
            </div>
            <p className="text-ink-3 text-xs leading-relaxed">
              Initial placement is a uniform spread over the active bin ±{HALF_WIDTH} (USDC above,
              SUI below). The agent re-optimizes the shape on its first evaluation tick, so the
              starting split doesn't need to be precise.
            </p>
            <div className="flex gap-2">
              <button className="btn-ghost" onClick={() => setStep("intro")} disabled={busy !== null}>
                Back
              </button>
              <button
                className="btn-primary flex-1"
                onClick={handleCreate}
                disabled={busy !== null || !snapshot.data || (!Number(amountUsdc) && !Number(amountSui))}
              >
                {busy ?? "Create position (tx 1 of 2)"}
              </button>
            </div>
          </div>
        )}

        {step === "authorize" && (
          <div className="space-y-4">
            <div className="text-sm">
              <div className="text-mint font-mono text-xs">✓ PositionManager created</div>
              <div className="mono-num text-ink-2 mt-1 break-all text-xs">{pmId}</div>
              {createDigest && (
                <a
                  className="text-s-blue font-mono text-[11px] underline decoration-dotted"
                  href={explorerTxUrl(createDigest)}
                  target="_blank"
                  rel="noreferrer"
                >
                  view tx ↗
                </a>
              )}
            </div>
            <p className="text-ink-2 text-sm leading-relaxed">
              Now whitelist the agent operator{" "}
              <code className="mono-num text-mint text-xs">
                {summary.data ? truncateAddress(summary.data.agentAddress) : "…"}
              </code>{" "}
              on your PM. The agent's on-chain watcher picks up the AgentAdded event and starts
              managing automatically — no extra registration needed.
            </p>
            <button
              className="btn-primary w-full"
              onClick={() => pmId && handleAuthorize(pmId)}
              disabled={busy !== null || !pmId || !summary.data}
            >
              {busy ?? "Authorize agent (tx 2 of 2)"}
            </button>
          </div>
        )}

        {step === "done" && (
          <div className="space-y-4 text-center">
            <div className="font-display text-mint pt-2 text-lg font-bold tracking-widest uppercase">
              {subscribed ? "Agent is live" : "Waiting for agent pickup…"}
            </div>
            <div className="mono-num text-ink-2 break-all text-xs">{pmId}</div>
            {authorizeDigest && (
              <a
                className="text-s-blue font-mono text-[11px] underline decoration-dotted"
                href={explorerTxUrl(authorizeDigest)}
                target="_blank"
                rel="noreferrer"
              >
                authorization tx ↗
              </a>
            )}
            <p className="text-ink-3 text-xs leading-relaxed">
              {subscribed
                ? "The agent's event watcher registered your PM. First rebalance lands within one evaluation interval."
                : "The agent's event watcher polls the chain for your AgentAdded event and subscribes automatically — usually under a minute."}
            </p>
            {!subscribed && (
              <div className="flex justify-center">
                <span className="live-dot" />
              </div>
            )}
            <button className="btn-primary w-full" onClick={onClose}>
              {subscribed ? "View my positions" : "Close (agent will pick it up)"}
            </button>
          </div>
        )}

        {error && (
          <p className="text-l3 mt-4 font-mono text-xs leading-relaxed break-all">{error}</p>
        )}
      </div>
    </div>,
    document.body,
  );
}
