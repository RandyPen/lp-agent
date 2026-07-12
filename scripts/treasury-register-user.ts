/**
 * Operator script: register a Sui address as a treasury user and print the
 * derived deposit address. Idempotent.
 *
 * Usage:
 *   bun run scripts/treasury-register-user.ts 0x<sui_address>
 */

import { loadConfig } from "../src/config.ts";
import { openDb } from "../src/db/client.ts";
import { registerUser } from "../src/treasury/registration.ts";

function main(): void {
  const suiAddress = process.argv[2];
  if (!suiAddress) {
    console.error("usage: bun run scripts/treasury-register-user.ts 0x<sui_address>");
    process.exit(2);
  }
  const cfg = loadConfig();
  if (!cfg.treasury.enabled) {
    console.error("FAIL: TREASURY_ENABLED=false. Set it true in .env first.");
    process.exit(1);
  }
  openDb(cfg.dbFile);
  const user = registerUser(suiAddress);
  console.log("");
  console.log("=".repeat(70));
  console.log("Treasury user registered");
  console.log("=".repeat(70));
  console.log(`Sui address      : ${user.suiAddress}`);
  console.log(`Derivation index : ${user.derivationIndex}`);
  console.log(`Deposit address  : ${user.depositAddress}`);
  console.log(`Credits          : ${user.credits}`);
  console.log("");
  console.log("Have the user transfer SUI/USDC/etc to the deposit address.");
  console.log("The watcher will detect inbound balance changes and grant credits.");
  console.log("");
}

main();
