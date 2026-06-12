/**
 * Treasury service entry point: instantiates the deposit watcher and exposes
 * a stop handle. Brings the treasury feature online when the agent starts.
 *
 * The rebalancer talks to treasury directly via `src/treasury/charges.ts`
 * (`attemptCharge` / `refundCharge`) — there's no service-level RPC seam,
 * the data model is the contract.
 *
 * When cfg.treasury.http is non-null, also starts the HTTP API alongside
 * the watcher (Treasury v2).
 */

import { getSuiClient } from "../sui/client.ts";
import { log } from "../lib/logger.ts";
import {
  createTreasuryWatcher,
  suiClientAsWatcherClient,
} from "../treasury/watcher.ts";
import { getTreasuryMasterAddress } from "../sui/keypairs/treasury.ts";
import { startTreasuryHttpApi, type TreasuryHttpApiHandle } from "../treasury/httpApi.ts";
import type { AppConfig } from "../config.ts";

export interface TreasuryService {
  /** Stop polling and tear down the watcher (and HTTP API if running). */
  stop(): void;
}

/**
 * Spin up the watcher loop (and optionally the HTTP API). Caller must have
 * already validated `cfg.treasury.enabled` and resolved master keypair
 * (via `getTreasuryMasterAddress`).
 */
export function startTreasuryService(cfg: AppConfig): TreasuryService {
  const treasuryCfg = cfg.treasury;
  if (!treasuryCfg.enabled) {
    log.warn("treasury: startTreasuryService called with cfg.enabled=false — noop");
    return { stop: () => {} };
  }
  const masterAddress = getTreasuryMasterAddress(); // throws on misconfig
  const watcher = createTreasuryWatcher({
    client: suiClientAsWatcherClient(getSuiClient()),
    intervalMs: treasuryCfg.watcherIntervalMs,
  });
  const stopWatcher = watcher.start();
  log.info("treasury: service started", {
    masterAddress,
    watcherIntervalMs: treasuryCfg.watcherIntervalMs,
    requireRegistration: treasuryCfg.requireRegistration,
  });

  let httpApiHandle: TreasuryHttpApiHandle | null = null;
  if (treasuryCfg.http?.enabled) {
    httpApiHandle = startTreasuryHttpApi(cfg);
    log.info("treasury: HTTP API started", { port: httpApiHandle.port });
  }

  return {
    stop(): void {
      httpApiHandle?.stop();
      stopWatcher();
      log.info("treasury: service stopped");
    },
  };
}
