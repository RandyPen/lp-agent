/**
 * Treasury service entry point: instantiates the deposit watcher and exposes
 * a stop handle. Brings the treasury feature online when the agent starts.
 *
 * The rebalancer talks to treasury directly via `src/treasury/charges.ts`
 * (`attemptCharge` / `refundCharge`) — there's no service-level RPC seam,
 * the data model is the contract.
 */

import { getSuiClient } from "../sui/client.ts";
import { log } from "../lib/logger.ts";
import {
  createTreasuryWatcher,
  suiClientAsWatcherClient,
} from "../treasury/watcher.ts";
import { getTreasuryMasterAddress } from "../sui/keypairs/treasury.ts";
import type { TreasuryAppConfig } from "../config.ts";

export interface TreasuryService {
  /** Stop polling and tear down the watcher. */
  stop(): void;
}

/**
 * Spin up the watcher loop. Caller must have already validated
 * `cfg.treasury.enabled` and resolved master keypair (via `getTreasuryMasterAddress`).
 */
export function startTreasuryService(cfg: TreasuryAppConfig): TreasuryService {
  if (!cfg.enabled) {
    log.warn("treasury: startTreasuryService called with cfg.enabled=false — noop");
    return { stop: () => {} };
  }
  const masterAddress = getTreasuryMasterAddress(); // throws on misconfig
  const watcher = createTreasuryWatcher({
    client: suiClientAsWatcherClient(getSuiClient()),
    intervalMs: cfg.watcherIntervalMs,
  });
  const stopWatcher = watcher.start();
  log.info("treasury: service started", {
    masterAddress,
    watcherIntervalMs: cfg.watcherIntervalMs,
    requireRegistration: cfg.requireRegistration,
  });
  return {
    stop(): void {
      stopWatcher();
      log.info("treasury: service stopped");
    },
  };
}
