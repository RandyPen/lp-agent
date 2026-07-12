/**
 * Operator script: set / update the credit conversion rate for a coin type.
 *
 *   credits_granted = floor(amount_atomic × rate_num / rate_den)
 *
 * Examples (1 credit = 0.01 USDC convention):
 *
 *   USDC (6 dec) — 1 USDC = 100 credits = 1e6 atomic / 1e4
 *     rate_num = 1, rate_den = 10000
 *   SUI  (9 dec) — at SUI = 2.5 USDC, 1 SUI = 250 credits = 1e9 atomic × 25 / 1e8
 *     rate_num = 25, rate_den = 100000000
 *
 * Usage:
 *   bun run scripts/treasury-update-rate.ts --coin 0x...::usdc::USDC --num 1 --den 10000
 */

import { loadConfig } from "../src/config.ts";
import { openDb } from "../src/db/client.ts";
import { canonicalType } from "../src/sui/lending/typeNorm.ts";
import { upsertCreditRate, getCreditRate } from "../src/treasury/store.ts";

function arg(name: string, argv: string[]): string | null {
  const idx = argv.indexOf(`--${name}`);
  if (idx < 0 || idx === argv.length - 1) return null;
  return argv[idx + 1] ?? null;
}

function main(): void {
  const argv = process.argv.slice(2);
  const coin = arg("coin", argv);
  const numStr = arg("num", argv);
  const denStr = arg("den", argv);
  if (!coin || !numStr || !denStr) {
    console.error(
      "usage: bun run scripts/treasury-update-rate.ts --coin <CoinType> --num <bigint> --den <bigint>",
    );
    process.exit(2);
  }

  const num = BigInt(numStr);
  const den = BigInt(denStr);
  if (den <= 0n || num < 0n) {
    console.error("FAIL: --num must be ≥ 0 and --den must be > 0");
    process.exit(2);
  }

  const cfg = loadConfig();
  openDb(cfg.dbFile);
  const canonical = canonicalType(coin);

  const prior = getCreditRate(canonical);
  upsertCreditRate({
    coinType: canonical,
    rateNum: num,
    rateDen: den,
    updatedBy: "treasury-update-rate.ts",
  });
  const current = getCreditRate(canonical)!;

  console.log("");
  console.log(`Coin type : ${canonical}`);
  if (prior) {
    console.log(`Was        : ${prior.rateNum} / ${prior.rateDen}`);
  } else {
    console.log(`Was        : (no prior rate)`);
  }
  console.log(`Now        : ${current.rateNum} / ${current.rateDen}`);
  console.log("");
  console.log("Watcher will pick up the new rate on its next tick. Existing");
  console.log("deposits with credits_granted=0 are NOT auto-backfilled —");
  console.log("write a backfill script if you need to retroactively credit.");
  console.log("");
}

main();
