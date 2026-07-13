/**
 * The one rule that matters for alerting: a broken pager must never take down
 * the agent, and must never abort the emergency unwind it is reporting on.
 */

import { describe, it, expect } from "bun:test";
import { createAlertDispatcher, createWebhookAlertSink, createLogAlertSink } from "../../src/alerts/sinks.ts";
import type { Alert, AlertSink } from "../../src/alerts/types.ts";

const alert: Alert = {
  severity: "critical",
  code: "l3_drain_failed",
  message: "position still deployed",
  tsMs: 1_700_000_000_000,
};

describe("alert dispatcher", () => {
  it("delivers to every sink", async () => {
    const a: Alert[] = [];
    const b: Alert[] = [];
    const dispatcher = createAlertDispatcher([
      { name: "a", async send(x) { a.push(x); } },
      { name: "b", async send(x) { b.push(x); } },
    ]);

    await dispatcher.emit(alert);

    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);
  });

  it("a throwing sink does NOT take down the agent, and does not block the others", async () => {
    // This is the whole point. An alert is a REPORT ABOUT a failure; if the
    // pager itself throws and that propagates, a Slack outage could abort the
    // emergency withdrawal the alert exists to announce.
    const delivered: Alert[] = [];
    const dispatcher = createAlertDispatcher([
      { name: "broken", async send() { throw new Error("slack is down"); } },
      { name: "good", async send(x) { delivered.push(x); } },
    ]);

    await expect(dispatcher.emit(alert)).resolves.toBeUndefined();
    expect(delivered).toHaveLength(1); // the healthy sink still got it
  });

  it("a sink that rejects is contained too", async () => {
    const dispatcher = createAlertDispatcher([
      { name: "rejects", send: () => Promise.reject(new Error("nope")) } as AlertSink,
    ]);
    await expect(dispatcher.emit(alert)).resolves.toBeUndefined();
  });
});

describe("webhook sink", () => {
  it("filters below minSeverity", async () => {
    let called = 0;
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      called++;
      return new Response("ok", { status: 200 });
    }) as unknown as typeof fetch;

    try {
      const sink = createWebhookAlertSink({ url: "http://example.invalid", minSeverity: "critical" });
      await sink.send({ ...alert, severity: "warn", code: "l2_extreme" });
      expect(called).toBe(0); // below threshold — not delivered

      await sink.send(alert); // critical
      expect(called).toBe(1);
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it("a failing HTTP call never throws", async () => {
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      throw new Error("network unreachable");
    }) as unknown as typeof fetch;

    try {
      const sink = createWebhookAlertSink({ url: "http://example.invalid" });
      await expect(sink.send(alert)).resolves.toBeUndefined();
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it("sends a `text` field so Slack/Discord render it with no transformer", async () => {
    let body: Record<string, unknown> = {};
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      body = JSON.parse(String(init.body));
      return new Response("ok", { status: 200 });
    }) as unknown as typeof fetch;

    try {
      await createWebhookAlertSink({ url: "http://example.invalid" }).send(alert);
      expect(String(body.text)).toContain("position still deployed");
      expect(body.code).toBe("l3_drain_failed");
      expect(body.severity).toBe("critical");
    } finally {
      globalThis.fetch = origFetch;
    }
  });
});

describe("log sink", () => {
  it("never throws", async () => {
    await expect(createLogAlertSink().send(alert)).resolves.toBeUndefined();
  });
});
