/**
 * Operator script: list all registered treasury users with current credit
 * balance. Read-only against the local SQLite DB.
 *
 * Usage:
 *   bun run scripts/treasury-list-users.ts
 */

import { loadConfig } from "../src/config.ts";
import { openDb } from "../src/db/client.ts";
import { listUsers } from "../src/treasury/store.ts";

function main(): void {
  const cfg = loadConfig();
  openDb(cfg.dbFile);
  const users = listUsers();
  if (users.length === 0) {
    console.log("No registered treasury users.");
    return;
  }
  console.log("");
  console.log(
    "idx  | credits        | deposit_address                                                    | sui_address",
  );
  console.log("-".repeat(160));
  for (const u of users) {
    console.log(
      `${String(u.derivationIndex).padStart(4)} | ${String(u.credits).padStart(14)} | ${u.depositAddress} | ${u.suiAddress}`,
    );
  }
  console.log("");
  console.log(`Total: ${users.length} users`);
}

main();
