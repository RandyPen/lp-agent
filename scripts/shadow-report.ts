/**
 * shadow-report.ts — print the shadow-mode validation report.
 *
 * Usage:
 *   bun run scripts/shadow-report.ts [days]
 *     days: lookback window (default 14).
 *
 * Reads shadow_decisions + price_observations from the configured DB and
 * prints agreement + hypothetical in-range metrics (src/services/shadowReport.ts).
 * Promotion to STRATEGY=mlAgent stays a manual decision — this is the data.
 */

import { loadConfig } from "../src/config.ts";
import { openDb, getDb } from "../src/db/client.ts";
import { computeShadowReport } from "../src/services/shadowReport.ts";

const days = Number(process.argv[2] ?? "14");
if (!Number.isFinite(days) || days <= 0) {
  console.error("usage: bun run scripts/shadow-report.ts [days>0]");
  process.exit(1);
}

const cfg = loadConfig();
openDb(cfg.dbFile);

const report = computeShadowReport(getDb(), {
  poolId: cfg.poolProfile.poolId,
  profile: cfg.poolProfile,
  sinceMs: Date.now() - days * 24 * 60 * 60 * 1000,
});

const pct = (v: number | null) => (v === null ? "n/a" : `${(v * 100).toFixed(1)}%`);

console.log(`Shadow report — pool ${report.poolId}, last ${days}d`);
console.log(`  decisions recorded:        ${report.rows} (${report.rowsWithBaseline} with rule baseline)`);
console.log(`  kind agreement (ml=rule):  ${pct(report.kindAgreementRate)}`);
console.log(`  bin overlap (Jaccard):     ${report.meanBinJaccard?.toFixed(3) ?? "n/a"} over ${report.bothPlannedRows} both-planned rows`);
console.log(`  hypothetical in-range:     ml=${pct(report.mlInRangeRate)}  rule=${pct(report.ruleInRangeRate)}  (${report.scoredDecisions} scored)`);
console.log(`  by state: ${JSON.stringify(report.byState)}`);
console.log(`  by ml output kind: ${JSON.stringify(report.byMlKind)}`);
