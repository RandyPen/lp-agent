/**
 * tests/risk/emergency.test.ts
 *
 * Unit tests for src/risk/emergency.ts — L3 emergency stop latch.
 */

import { describe, it, expect, beforeEach, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, resetDbCacheForTests } from "../../src/db/client.ts";
import { createEmergencyStop } from "../../src/risk/emergency.ts";
import type { Database } from "bun:sqlite";

let tmpDir: string;
let db: Database;
let clock = 1_700_000_000_000;

function freshDb(): Database {
  resetDbCacheForTests();
  if (tmpDir) {
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  tmpDir = mkdtempSync(join(tmpdir(), "risk-emergency-"));
  return openDb(join(tmpDir, "test.db"));
}

function nowMs(): number {
  return clock;
}

function advanceMs(ms: number): void {
  clock += ms;
}

function countRiskEvents(database: Database): number {
  const result = database.prepare<{ n: number }, []>("SELECT COUNT(*) as n FROM risk_events").get();
  return result?.n ?? 0;
}

function getRiskEvents(database: Database): Array<{ level: string; kind: string; metric: string }> {
  return database
    .prepare<{ level: string; kind: string; metric: string }, []>(
      "SELECT level, kind, metric FROM risk_events ORDER BY id",
    )
    .all();
}

beforeEach(() => {
  clock = 1_700_000_000_000;
  db = freshDb();
});

afterAll(() => {
  resetDbCacheForTests();
  if (tmpDir) {
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

describe("createEmergencyStop", () => {
  it("starts in un-tripped state", () => {
    const stop = createEmergencyStop({ db, nowMs });
    expect(stop.isTripped()).toBe(false);
  });

  it("trips and is reflected in isTripped()", () => {
    const stop = createEmergencyStop({ db, nowMs });
    stop.trip("manual test");
    expect(stop.isTripped()).toBe(true);
  });

  it("persists an L3 risk_event row on trip", () => {
    const stop = createEmergencyStop({ db, nowMs });
    expect(countRiskEvents(db)).toBe(0);
    stop.trip("test reason");
    expect(countRiskEvents(db)).toBe(1);

    const events = getRiskEvents(db);
    expect(events[0]!.level).toBe("L3");
    expect(events[0]!.kind).toBe("emergency_stop");
    expect(events[0]!.metric).toBe("emergency_stop");
  });

  it("trip is idempotent — second call does NOT write another DB row", () => {
    const stop = createEmergencyStop({ db, nowMs });
    stop.trip("first reason");
    stop.trip("second reason"); // should be no-op on DB
    expect(countRiskEvents(db)).toBe(1);
    expect(stop.isTripped()).toBe(true);
  });

  it("reset clears the latch", () => {
    const stop = createEmergencyStop({ db, nowMs });
    stop.trip("test");
    stop.reset("acknowledged: test resolved");
    expect(stop.isTripped()).toBe(false);
  });

  it("reset persists a reset event and resolves the original event", () => {
    const stop = createEmergencyStop({ db, nowMs });
    stop.trip("test");
    advanceMs(5000);
    stop.reset("acknowledged");

    const events = getRiskEvents(db);
    // Should have trip event + reset event
    expect(events).toHaveLength(2);
    expect(events[0]!.kind).toBe("emergency_stop");
    expect(events[1]!.kind).toBe("emergency_stop_reset");

    // Original trip event should have resolved_at_ms set
    const tripRow = db
      .prepare<{ resolved_at_ms: number | null }, []>(
        "SELECT resolved_at_ms FROM risk_events WHERE kind = 'emergency_stop' LIMIT 1",
      )
      .get();
    expect(tripRow?.resolved_at_ms).not.toBeNull();
  });

  it("reset throws when not tripped", () => {
    const stop = createEmergencyStop({ db, nowMs });
    expect(() => stop.reset("ack")).toThrow();
  });

  it("can be tripped again after reset", () => {
    const stop = createEmergencyStop({ db, nowMs });
    stop.trip("first");
    stop.reset("ack");
    stop.trip("second");
    expect(stop.isTripped()).toBe(true);
    // Should have: trip + reset + trip_again = 3 rows
    expect(countRiskEvents(db)).toBe(3);
  });

  it("uses injected nowMs for timestamps", () => {
    const fixedNow = 9_999_999_999_000;
    const stop = createEmergencyStop({ db, nowMs: () => fixedNow });
    stop.trip("test");

    const row = db
      .prepare<{ ts_ms: number }, []>("SELECT ts_ms FROM risk_events LIMIT 1")
      .get();
    expect(row?.ts_ms).toBe(fixedNow);
  });
});
