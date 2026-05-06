/**
 * CLI utility: poll a single CDPM event stream once and print decoded events as JSON.
 *
 * Usage:
 *   bun run scripts/print-events.ts <EventName> [limit]
 *
 * EventName must be one of the keys in EVENT_TYPES (e.g. AgentAdded, PositionManagerClosed).
 * limit defaults to 20.
 */

import { EVENT_TYPES } from "../src/sui/cdpm/package.ts";
import { pollEvents } from "../src/sui/cdpm/events.ts";

const [, , eventNameArg, limitArg] = process.argv;

if (!eventNameArg) {
  console.error(
    `Usage: bun run scripts/print-events.ts <EventName> [limit]\n` +
    `Available events: ${Object.keys(EVENT_TYPES).join(", ")}`,
  );
  process.exit(1);
}

if (!(eventNameArg in EVENT_TYPES)) {
  console.error(
    `Unknown event name '${eventNameArg}'.\n` +
    `Available: ${Object.keys(EVENT_TYPES).join(", ")}`,
  );
  process.exit(1);
}

const moveEventType = EVENT_TYPES[eventNameArg as keyof typeof EVENT_TYPES];
const limit = limitArg !== undefined ? Math.max(1, parseInt(limitArg, 10)) : 20;

console.error(`Polling ${moveEventType} (limit=${limit}) ...`);

const { events, nextCursor } = await pollEvents(moveEventType, null, limit);

for (const ev of events) {
  console.log(JSON.stringify(ev, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2));
}

console.error(`\n${events.length} event(s) decoded. nextCursor: ${JSON.stringify(nextCursor)}`);
