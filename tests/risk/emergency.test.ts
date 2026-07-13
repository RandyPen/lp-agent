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

  it("trip() enters DRAINING, not HALTED — the agent must exit before it freezes", () => {
    const stop = createEmergencyStop({ db, nowMs });
    stop.trip("manual test", { kind: "global" });

    // The load-bearing change: L3 used to halt immediately, leaving the user's
    // liquidity deployed and unmanaged. It now force-exits first.
    expect(stop.state()).toBe("DRAINING");
    expect(stop.isDraining()).toBe(true);
    // isTripped() means "no on-chain op may run" — false while draining,
    // because the drain itself has to submit a withdrawal PTB.
    expect(stop.isTripped()).toBe(false);
  });

  it("persists an L3 risk_event row on trip", () => {
    const stop = createEmergencyStop({ db, nowMs });
    expect(countRiskEvents(db)).toBe(0);
    stop.trip("test reason", { kind: "global" });
    expect(countRiskEvents(db)).toBe(1);

    const events = getRiskEvents(db);
    expect(events[0]!.level).toBe("L3");
    expect(events[0]!.kind).toBe("emergency_stop");
    expect(events[0]!.metric).toBe("emergency_stop");
  });

  it("trip is idempotent — second call does NOT write another DB row", () => {
    const stop = createEmergencyStop({ db, nowMs });
    stop.trip("first reason", { kind: "global" });
    stop.trip("second reason", { kind: "global" }); // should be no-op on DB
    expect(countRiskEvents(db)).toBe(1);
    expect(stop.state()).toBe("DRAINING");
  });

  it("reset clears the latch", () => {
    const stop = createEmergencyStop({ db, nowMs });
    stop.trip("test", { kind: "global" });
    stop.reset("acknowledged: test resolved");
    expect(stop.state()).toBe("ARMED");
    expect(stop.isTripped()).toBe(false);
  });

  it("reset persists a reset event and resolves the original event", () => {
    const stop = createEmergencyStop({ db, nowMs });
    stop.trip("test", { kind: "global" });
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
    stop.trip("first", { kind: "global" });
    stop.reset("ack");
    stop.trip("second", { kind: "global" });
    expect(stop.state()).toBe("DRAINING");
    // Should have: trip + reset + trip_again = 3 rows
    expect(countRiskEvents(db)).toBe(3);
  });

  it("uses injected nowMs for timestamps", () => {
    const fixedNow = 9_999_999_999_000;
    const stop = createEmergencyStop({ db, nowMs: () => fixedNow });
    stop.trip("test", { kind: "global" });

    const row = db
      .prepare<{ ts_ms: number }, []>("SELECT ts_ms FROM risk_events LIMIT 1")
      .get();
    expect(row?.ts_ms).toBe(fixedNow);
  });
});

// ---------------------------------------------------------------------------
// Phase 1 additions — DB rehydration + out-of-process operator reset
// ---------------------------------------------------------------------------

import { resolveEmergencyStopInDb } from "../../src/risk/emergency.ts";

describe("emergency stop rehydration (restart survival)", () => {
  it("a tripped latch survives a process restart via DB rehydration", () => {
    const stop1 = createEmergencyStop({ db, nowMs });
    stop1.trip("first process trips", { kind: "global" });
    expect(stop1.state()).toBe("DRAINING");

    // A NEW latch over the same DB comes up HALTED, not DRAINING: we cannot
    // tell from the row alone whether the previous run managed to exit, and
    // re-entering a drain on every restart could thrash the position. A human
    // is already required — the `l3_rehydrated` alert tells them so.
    const stop2 = createEmergencyStop({ db, nowMs });
    expect(stop2.state()).toBe("HALTED");
    expect(stop2.isTripped()).toBe(true);
  });

  it("a resolved (operator-reset) trip does NOT re-trip on restart", () => {
    const stop1 = createEmergencyStop({ db, nowMs });
    stop1.trip("trip then resolve", { kind: "global" });
    resolveEmergencyStopInDb(db, "verified safe to resume", nowMs());

    const stop2 = createEmergencyStop({ db, nowMs });
    expect(stop2.isTripped()).toBe(false);
  });

  it("a fresh DB (no trips ever) rehydrates un-tripped", () => {
    const stop = createEmergencyStop({ db, nowMs });
    expect(stop.isTripped()).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Drain-then-latch: L3 must exit the position before it freezes
// ---------------------------------------------------------------------------

import type { Alert } from "../../src/alerts/types.ts";
import { createAlertDispatcher } from "../../src/alerts/sinks.ts";

function captureAlerts(): { alerts: Alert[]; dispatcher: ReturnType<typeof createAlertDispatcher> } {
  const alerts: Alert[] = [];
  const dispatcher = createAlertDispatcher([
    { name: "capture", async send(a: Alert) { alerts.push(a); } },
  ]);
  return { alerts, dispatcher };
}

describe("L3 drain-then-latch", () => {
  it("a successful drain HALTS and reports that capital is safe", async () => {
    const { alerts, dispatcher } = captureAlerts();
    const stop = createEmergencyStop({ db, nowMs, alerts: dispatcher });

    stop.trip("catastrophic pnl", { kind: "global" });
    expect(stop.state()).toBe("DRAINING");

    stop.recordDrainAttempt({}, { positionEmpty: true, pmId: "0xpm" });

    expect(stop.state()).toBe("HALTED");
    expect(stop.isTripped()).toBe(true);

    await Promise.resolve(); // let the fire-and-forget alerts flush
    expect(alerts.map((a) => a.code)).toEqual(["l3_tripped", "l3_drained"]);
    expect(alerts.every((a) => a.severity === "critical")).toBe(true);
  });

  it("retries a failed drain, then HALTS with the LOUDEST alert when it gives up", async () => {
    // This is the worst state the system can be in: automation off, capital
    // still deployed. It must be impossible to reach it quietly.
    const { alerts, dispatcher } = captureAlerts();
    const stop = createEmergencyStop({ db, nowMs, alerts: dispatcher, drainMaxAttempts: 3 });

    stop.trip("5 consecutive tx failures", { kind: "global" });

    stop.recordDrainAttempt({}, { positionEmpty: false, error: "rpc down" });
    expect(stop.state()).toBe("DRAINING"); // attempt 1 — keep trying
    stop.recordDrainAttempt({}, { positionEmpty: false, error: "rpc down" });
    expect(stop.state()).toBe("DRAINING"); // attempt 2

    stop.recordDrainAttempt({}, { positionEmpty: false, error: "rpc down" });
    expect(stop.state()).toBe("HALTED"); // attempt 3 — give up

    await Promise.resolve();
    const codes = alerts.map((a) => a.code);
    expect(codes).toEqual(["l3_tripped", "l3_drain_failed"]);

    const failure = alerts.find((a) => a.code === "l3_drain_failed")!;
    expect(failure.severity).toBe("critical");
    // The operator must be able to tell "we got flat" from "we are still exposed".
    expect(failure.message).toMatch(/STILL DEPLOYED/);
  });

  it("bounded attempts: a broken chain cannot make the drain retry forever", () => {
    const stop = createEmergencyStop({ db, nowMs, drainMaxAttempts: 2 });
    stop.trip("chain unreachable", { kind: "global" });

    stop.recordDrainAttempt({}, { positionEmpty: false });
    stop.recordDrainAttempt({}, { positionEmpty: false });
    expect(stop.state()).toBe("HALTED");

    // Further reports are ignored — we are already terminal.
    stop.recordDrainAttempt({}, { positionEmpty: false });
    expect(stop.state()).toBe("HALTED");
  });

  it("tells the truth about WHERE the funds are — not 'the PM balance' by assumption", async () => {
    // The L2→L3 path: L2 EXTREME already withdrew the DLMM position and swept
    // 100% of the capital into Scallop. L3 then finds nothing to withdraw.
    // The price exposure IS gone (that is what L3 is for), but the money is NOT
    // in the PM balance — and an operator woken at 3am must not be told it is.
    const { alerts, dispatcher } = captureAlerts();
    const stop = createEmergencyStop({ db, nowMs, alerts: dispatcher });

    stop.trip("repeated L2", { kind: "pool", poolId: "0xpool" });
    stop.recordDrainAttempt(
      { poolId: "0xpool", pmId: "0xpm" },
      {
        positionEmpty: true, // no DLMM bins — exposure is zero
        pmId: "0xpm",
        funds: {
          balanceA: 0n,
          balanceB: 0n,
          lending: {
            scallop: {
              "0x2::usdc::USDC": {
                protocol: "scallop",
                coinType: "0x2::usdc::USDC",
                ytType: "",
                underlyingPrincipal: 12_400_000_000n,
                marketCoinAmount: 12_000_000_000n,
              },
            },
            kai: {},
          },
        },
      },
    );

    await Promise.resolve();
    const drained = alerts.find((a) => a.code === "l3_drained")!;
    expect(drained.message).toContain("scallop lending");
    expect(drained.message).toContain("12400000000");
    // It must NOT claim the money is sitting in the PM balance.
    expect(drained.message).not.toContain("PM balance (");
  });

  it("a PM-scoped trip does NOT halt other PMs", () => {
    // One user's malformed position, dust plan, or revoked authorization must
    // not force-exit every other user's position.
    const stop = createEmergencyStop({ db, nowMs });

    stop.trip("5 consecutive tx failures", { kind: "pm", pmId: "0xbad" });

    expect(stop.state({ poolId: "0xpool", pmId: "0xbad" })).toBe("DRAINING");
    expect(stop.state({ poolId: "0xpool", pmId: "0xhealthy" })).toBe("ARMED");
  });

  it("a POOL-scoped trip DOES apply to every PM on that pool", () => {
    const stop = createEmergencyStop({ db, nowMs });

    stop.trip("catastrophic pnl", { kind: "pool", poolId: "0xpool" });

    expect(stop.state({ poolId: "0xpool", pmId: "0xa" })).toBe("DRAINING");
    expect(stop.state({ poolId: "0xpool", pmId: "0xb" })).toBe("DRAINING");
    // ...but not to a different pool.
    expect(stop.state({ poolId: "0xother", pmId: "0xc" })).toBe("ARMED");
  });

  it("recordDrainAttempt only advances the latches that apply to the given PM", () => {
    const stop = createEmergencyStop({ db, nowMs, drainMaxAttempts: 1 });
    stop.trip("bad pm", { kind: "pm", pmId: "0xbad" });
    stop.trip("bad pm 2", { kind: "pm", pmId: "0xbad2" });

    // Report a failure for 0xbad only.
    stop.recordDrainAttempt({ pmId: "0xbad" }, { positionEmpty: false, pmId: "0xbad" });

    expect(stop.state({ pmId: "0xbad" })).toBe("HALTED");
    expect(stop.state({ pmId: "0xbad2" })).toBe("DRAINING"); // untouched
  });

  it("recordDrainAttempt is a no-op when not draining", () => {
    const stop = createEmergencyStop({ db, nowMs });
    stop.recordDrainAttempt({}, { positionEmpty: true });
    expect(stop.state()).toBe("ARMED");
  });

  it("a rehydrated latch alerts — a restarted-but-frozen agent must announce itself", async () => {
    const first = createEmergencyStop({ db, nowMs });
    first.trip("something bad", { kind: "global" });

    const { alerts, dispatcher } = captureAlerts();
    const restarted = createEmergencyStop({ db, nowMs, alerts: dispatcher });

    expect(restarted.state()).toBe("HALTED");
    await Promise.resolve();
    expect(alerts.map((a) => a.code)).toEqual(["l3_rehydrated"]);
    expect(alerts[0]!.severity).toBe("critical");
  });
});

describe("resolveEmergencyStopInDb (operator reset path)", () => {
  it("resolves the unresolved row and writes an audit row with the ack reason", () => {
    const stop = createEmergencyStop({ db, nowMs });
    stop.trip("something bad", { kind: "global" });

    const { resolvedEventIds } = resolveEmergencyStopInDb(db, "rpc outage over", nowMs());
    const resolvedEventId = resolvedEventIds[0]!;

    const resolved = db
      .prepare<{ resolved_at_ms: number | null }, [number]>(
        "SELECT resolved_at_ms FROM risk_events WHERE id = ?",
      )
      .get(resolvedEventId);
    expect(resolved?.resolved_at_ms).toBe(nowMs());

    const audit = db
      .prepare<{ kind: string; action: string }, []>(
        "SELECT kind, action FROM risk_events ORDER BY id DESC LIMIT 1",
      )
      .get();
    expect(audit?.kind).toBe("emergency_stop_reset");
    expect(audit?.action).toBe("manual_reset:rpc outage over");
  });

  it("throws when no unresolved emergency_stop row exists", () => {
    expect(() => resolveEmergencyStopInDb(db, "nothing to reset")).toThrow(/no unresolved/);
  });

  it("throws on an empty ack reason", () => {
    const stop = createEmergencyStop({ db, nowMs });
    stop.trip("x", { kind: "global" });
    expect(() => resolveEmergencyStopInDb(db, "  ")).toThrow(/ackReason/);
  });
});
