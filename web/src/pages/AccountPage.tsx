import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCurrentAccount, useDAppKit } from "@mysten/dapp-kit-react";
import { api, ApiError } from "@/lib/api";
import { EmptyState, LoadingRow, Panel, StatTile } from "@/components/primitives";
import { formatRaw, formatTs, truncateAddress } from "@/lib/format";

const COIN_LABELS: Record<string, { symbol: string; decimals: number }> = {
  "0x0000000000000000000000000000000000000000000000000000000000000002::sui::SUI": {
    symbol: "SUI",
    decimals: 9,
  },
  "0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC": {
    symbol: "USDC",
    decimals: 6,
  },
};

function coinLabel(coinType: string): { symbol: string; decimals: number } {
  return COIN_LABELS[coinType] ?? { symbol: coinType.split("::").pop() ?? "?", decimals: 9 };
}

export function AccountPage() {
  const account = useCurrentAccount();
  const dAppKit = useDAppKit();
  const queryClient = useQueryClient();
  const [registering, setRegistering] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const user = useQuery({
    queryKey: ["treasuryUser", account?.address],
    enabled: !!account,
    retry: false,
    queryFn: () => api.user(account!.address),
  });
  const notRegistered = user.error instanceof ApiError && user.error.status === 404;

  const deposits = useQuery({
    queryKey: ["deposits", account?.address],
    enabled: !!account && user.isSuccess,
    queryFn: () => api.deposits(account!.address),
  });

  async function handleRegister() {
    if (!account) return;
    setRegistering(true);
    setError(null);
    try {
      const message = `LiquidityManager:register:${account.address}:${Date.now()}`;
      const { signature } = await dAppKit.signPersonalMessage({
        message: new TextEncoder().encode(message),
      });
      await api.register({
        suiAddress: account.address,
        messageB64: btoa(message),
        signature,
      });
      await queryClient.invalidateQueries({ queryKey: ["treasuryUser", account.address] });
    } catch (e) {
      setError(e instanceof Error ? e.message : "registration failed");
    } finally {
      setRegistering(false);
    }
  }

  if (!account) {
    return (
      <EmptyState>
        Connect your wallet to manage your service-fee account. Registration is a free wallet
        signature — no transaction, no gas.
      </EmptyState>
    );
  }

  if (user.isLoading) return <LoadingRow />;

  if (notRegistered) {
    return (
      <div className="mx-auto max-w-xl space-y-4">
        <Panel title="Open your service account">
          <p className="text-ink-2 text-sm leading-relaxed">
            The agent charges a small per-rebalance service fee in credits (1 credit = 0.01
            USDC). Register to get your personal deposit address — top-ups are credited
            automatically by the treasury watcher.
          </p>
          <ul className="text-ink-3 mt-3 list-inside list-disc space-y-1 text-xs">
            <li>Registration is a wallet signature only — free, instant, no gas.</li>
            <li>Your deposit address is derived for you alone and never reused.</li>
            <li>Failed rebalances are automatically refunded.</li>
          </ul>
          <button className="btn-primary mt-4 w-full" onClick={handleRegister} disabled={registering}>
            {registering ? "Waiting for wallet…" : "Sign & register"}
          </button>
          {error && <p className="text-l3 mt-2 text-xs">{error}</p>}
        </Panel>
      </div>
    );
  }

  if (user.isError) {
    return <EmptyState>Failed to load account: {(user.error as Error).message}</EmptyState>;
  }

  const u = user.data!;

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
        <StatTile
          label="Credit balance"
          value={<span className="text-mint">{u.credits.toLocaleString()}</span>}
          sub="1 credit = 0.01 USDC · debited per rebalance"
        />
        <StatTile
          label="Wallet"
          value={<span className="text-base">{truncateAddress(u.suiAddress)}</span>}
          sub={u.createdAtMs ? `registered ${formatTs(u.createdAtMs)}` : ""}
        />
        <StatTile
          label="Low balance?"
          value={
            u.credits < 100 ? (
              <span style={{ color: "var(--color-l1)" }} className="text-lg">
                top up soon
              </span>
            ) : (
              <span className="text-lg">healthy</span>
            )
          }
          sub="rebalances skip when credits run out"
        />
      </div>

      <Panel title="Your deposit address">
        <p className="text-ink-3 mb-3 text-xs">
          Send SUI or native USDC to this address from any wallet or exchange. The watcher
          confirms the balance change over several polls, then books credits at the current
          rate.
        </p>
        <div className="border-line-2 bg-panel-2 flex items-center justify-between gap-3 rounded-md border px-3 py-2.5">
          <code className="mono-num text-mint break-all text-sm">{u.depositAddress}</code>
          <button
            className="btn-ghost shrink-0"
            onClick={async () => {
              await navigator.clipboard.writeText(u.depositAddress);
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            }}
          >
            {copied ? "Copied" : "Copy"}
          </button>
        </div>
      </Panel>

      <Panel title="Deposit history">
        {deposits.isLoading ? (
          <LoadingRow />
        ) : (deposits.data ?? []).length === 0 ? (
          <EmptyState>No deposits yet — your first top-up will appear here.</EmptyState>
        ) : (
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="text-ink-3 border-line border-b font-mono text-[11px] uppercase">
                <th className="py-2 pr-3">time</th>
                <th className="py-2 pr-3">coin</th>
                <th className="py-2 pr-3">amount</th>
                <th className="py-2">credits granted</th>
              </tr>
            </thead>
            <tbody className="mono-num">
              {(deposits.data ?? []).map((d) => {
                const { symbol, decimals } = coinLabel(d.coinType);
                return (
                  <tr key={d.id} className="border-line/60 border-b last:border-0">
                    <td className="text-ink-3 py-2 pr-3">{formatTs(d.observedAtMs)}</td>
                    <td className="py-2 pr-3">{symbol}</td>
                    <td className="py-2 pr-3">{formatRaw(d.amountDelta, decimals, 4)}</td>
                    <td className="text-mint py-2">+{d.creditsGranted.toLocaleString()}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </Panel>
    </div>
  );
}
