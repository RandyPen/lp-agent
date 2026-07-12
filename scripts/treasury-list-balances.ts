/**
 * Operator script: query on-chain balances for every registered deposit
 * address (across all coin types). Useful before manual sweeps or to verify
 * the watcher is keeping cached balances in sync with reality.
 *
 * Usage:
 *   bun run scripts/treasury-list-balances.ts
 */

import { loadConfig } from "../src/config.ts";
import { openDb } from "../src/db/client.ts";
import { getSuiClient } from "../src/sui/client.ts";
import { listUsers } from "../src/treasury/store.ts";
import { canonicalType } from "../src/sui/lending/typeNorm.ts";

interface CoinBalance {
  coinType: string;
  totalBalance: string;
}

async function main(): Promise<void> {
  const cfg = loadConfig();
  openDb(cfg.dbFile);
  const users = listUsers();
  if (users.length === 0) {
    console.log("No registered treasury users.");
    return;
  }
  const client = getSuiClient();

  console.log("");
  for (const u of users) {
    let balances: CoinBalance[];
    try {
      balances = await client.getAllBalances({ owner: u.depositAddress });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.log(`[idx=${u.derivationIndex}] ${u.depositAddress} — error: ${msg}`);
      continue;
    }
    const nonZero = balances.filter((b) => BigInt(b.totalBalance) > 0n);
    if (nonZero.length === 0) {
      console.log(
        `[idx=${u.derivationIndex}] ${u.depositAddress} (sui=${u.suiAddress}) credits=${u.credits} — empty`,
      );
      continue;
    }
    console.log(
      `[idx=${u.derivationIndex}] ${u.depositAddress} (sui=${u.suiAddress}) credits=${u.credits}`,
    );
    for (const b of nonZero) {
      console.log(`    ${canonicalType(b.coinType)} = ${b.totalBalance}`);
    }
  }
  console.log("");
}

main().catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(`fatal: ${msg}`);
  process.exit(1);
});
