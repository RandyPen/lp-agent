/**
 * Built-in alert sinks + the dispatcher.
 *
 * The dispatcher is deliberately fire-and-forget and swallows sink errors. That
 * is the one place in this codebase where swallowing is correct: an alert is a
 * REPORT ABOUT a failure, and a broken pager must never abort the emergency
 * unwind it is reporting on. Silence from the pager is bad; a crashed agent that
 * failed to exit its position because Slack was down is worse.
 */

import { log } from "../lib/logger.ts";
import type { Alert, AlertSink } from "./types.ts";

/** Default sink: structured log lines. Always installed. */
export function createLogAlertSink(): AlertSink {
  return {
    name: "log",
    async send(alert: Alert): Promise<void> {
      const fields = { code: alert.code, ...alert.fields, poolId: alert.poolId, pmId: alert.pmId };
      if (alert.severity === "critical") log.error(`ALERT: ${alert.message}`, fields);
      else if (alert.severity === "warn") log.warn(`ALERT: ${alert.message}`, fields);
      else log.info(`ALERT: ${alert.message}`, fields);
    },
  };
}

export interface WebhookSinkOptions {
  url: string;
  timeoutMs?: number;
  /** Minimum severity to deliver. Default: "warn" — info stays in the logs. */
  minSeverity?: "info" | "warn" | "critical";
}

const SEVERITY_RANK = { info: 0, warn: 1, critical: 2 } as const;

/**
 * POSTs the alert as JSON. Generic on purpose: Slack, Discord, PagerDuty
 * Events API, Opsgenie and every incident tool accept a JSON POST, and an
 * operator can point this at whatever they already run.
 *
 * The body includes a `text` field alongside the structured payload, because
 * Slack/Discord render `text` directly — so the default config produces a
 * readable message with no transformer in between.
 */
export function createWebhookAlertSink(opts: WebhookSinkOptions): AlertSink {
  const timeoutMs = opts.timeoutMs ?? 5_000;
  const min = SEVERITY_RANK[opts.minSeverity ?? "warn"];

  return {
    name: "webhook",
    async send(alert: Alert): Promise<void> {
      if (SEVERITY_RANK[alert.severity] < min) return;

      const icon = alert.severity === "critical" ? "🚨" : alert.severity === "warn" ? "⚠️" : "ℹ️";
      const body = {
        // Rendered directly by Slack / Discord.
        text: `${icon} [${alert.severity.toUpperCase()}] ${alert.message}`,
        // Structured payload for anything that parses.
        severity: alert.severity,
        code: alert.code,
        message: alert.message,
        tsMs: alert.tsMs,
        poolId: alert.poolId,
        pmId: alert.pmId,
        fields: alert.fields,
      };

      try {
        const res = await fetch(opts.url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (!res.ok) {
          log.warn("alerts: webhook returned non-OK", { status: res.status, code: alert.code });
        }
      } catch (err: unknown) {
        // Never rethrow: see the module header.
        log.warn("alerts: webhook delivery failed", {
          error: err instanceof Error ? err.message : String(err),
          code: alert.code,
        });
      }
    },
  };
}

export interface AlertDispatcher {
  /**
   * Deliver to every sink. Never throws.
   *
   * Returns a promise you MAY await (tests do) but callers on the hot path —
   * notably the emergency unwind — deliberately do not: a slow pager must not
   * delay the withdrawal it is announcing.
   */
  emit(alert: Alert): Promise<void>;
  readonly sinks: readonly AlertSink[];
}

export function createAlertDispatcher(sinks: AlertSink[]): AlertDispatcher {
  return {
    sinks,
    async emit(alert: Alert): Promise<void> {
      await Promise.all(
        sinks.map(async (sink) => {
          try {
            await sink.send(alert);
          } catch (err: unknown) {
            // A sink violated its no-throw contract. Contain it here — an alert
            // about a failure must not become a second failure.
            log.error("alerts: sink threw (it must not) — alert may be undelivered", {
              sink: sink.name,
              code: alert.code,
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }),
      );
    },
  };
}
