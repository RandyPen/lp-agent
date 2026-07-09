import { useCallback } from "react";
import { useCurrentAccount, useCurrentWallet, useDAppKit } from "@mysten/dapp-kit-react";
import type { Transaction } from "@mysten/sui/transactions";

// Extension wallets (observed with Suiet) reject a sign request with
// "No permission for the action | (e4:-4003)" — thrown BEFORE any approval
// popup appears — when dApp-kit's autoConnect restored the saved account
// straight from the wallet's exposed `accounts` list without ever re-running
// the wallet's `standard:connect`, so the per-origin permission grant was
// never re-established for this page session.
export function isStaleWalletAuthError(error: unknown): boolean {
  const msg = error instanceof Error ? error.message : String(error ?? "");
  return /no permission for the action|-4003/i.test(msg);
}

const STALE_AUTH_MESSAGE =
  "Wallet authorization expired. Reconnect your wallet and try again.";

export function describeTxError(error: unknown, fallback: string): string {
  if (isStaleWalletAuthError(error)) return STALE_AUTH_MESSAGE;
  return error instanceof Error ? error.message : fallback;
}

/**
 * Wallet-level sign+execute with a one-shot re-auth. The single entry point
 * every component should use to sign — never call
 * `dAppKit.signAndExecuteTransaction` directly — so the stale-grant recovery
 * lives in one place. (Mirrors cdpm_web's use-sign-and-execute.ts.)
 */
export function useSignAndExecute() {
  const dAppKit = useDAppKit();
  const currentWallet = useCurrentWallet();
  const currentAccount = useCurrentAccount();

  return useCallback(
    async (tx: Transaction) => {
      try {
        return await dAppKit.signAndExecuteTransaction({ transaction: tx });
      } catch (error) {
        if (!isStaleWalletAuthError(error) || !currentWallet) throw error;
        await dAppKit.connectWallet({ wallet: currentWallet, account: currentAccount ?? undefined });
        return await dAppKit.signAndExecuteTransaction({ transaction: tx });
      }
    },
    [dAppKit, currentWallet, currentAccount],
  );
}
