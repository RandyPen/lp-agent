/**
 * risk-reset-emergency.ts — operator reset for the L3 emergency stop.
 *
 * Usage:
 *   bun run scripts/risk-reset-emergency.ts "<ack reason>"
 *
 * What it does:
 *   1. Opens the configured SQLite DB (DB_FILE, default ./data/app.db).
 *   2. Resolves the latest unresolved `emergency_stop` risk_events row and
 *      writes an `emergency_stop_reset` audit row carrying the ack reason.
 *   3. Prints the resolved event id.
 *
 * IMPORTANT: this does NOT un-trip a RUNNING agent process (by design — the
 * in-memory latch is only cleared via boot rehydration). After running this
 * script, RESTART the agent; createEmergencyStop will come up un-tripped.
 *
 * Fails loudly when no unresolved emergency_stop row exists.
 */

import { loadConfig } from "../src/config.ts";
import { openDb, getDb } from "../src/db/client.ts";
import { resolveEmergencyStopInDb } from "../src/risk/emergency.ts";

const ackReason = process.argv[2];
if (!ackReason || ackReason.trim() === "") {
  console.error('usage: bun run scripts/risk-reset-emergency.ts "<ack reason>"');
  console.error("the ack reason is stored in the risk_events audit trail — say why it is safe to resume.");
  process.exit(1);
}

const cfg = loadConfig();
openDb(cfg.dbFile);

const { resolvedEventId } = resolveEmergencyStopInDb(getDb(), ackReason);

console.log(`✅ resolved emergency_stop risk_event id=${resolvedEventId}`);
console.log("Now RESTART the agent — the latch clears via boot rehydration.");
