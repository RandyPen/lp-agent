/**
 * Alerting — the missing half of the L3 emergency stop.
 *
 * L3's entire design rests on "a human operator resets the latch". But until
 * now the only observable effect of a trip was a line on stdout, so the human
 * that design depends on had no mechanism by which to learn they were needed.
 * A 24/7 custody agent whose every catastrophic state is silent is,
 * operationally, an unattended one.
 *
 * The framework's job here is to EMIT, not to integrate. It ships a log sink
 * (the previous behaviour) and a webhook sink (which covers Slack, Discord,
 * PagerDuty, Opsgenie and anything else that accepts a JSON POST). A fork
 * plugs in its own via `defineAgent({ alerts: [...] })` — the same seam as
 * strategies.
 */

export type AlertSeverity = "info" | "warn" | "critical";

/**
 * Stable, machine-readable event codes. Alert on `code`, not on message text —
 * messages are for humans and will change.
 */
export type AlertCode =
  /** L3 tripped. The agent is now attempting to exit the position. */
  | "l3_tripped"
  /** L3 drained the position successfully and is now halted. Capital is safe in the PM. */
  | "l3_drained"
  /**
   * L3 could NOT exit. The position is still deployed and the agent is halted.
   * This is the worst state the agent can be in: unmanaged capital, exposed to
   * the market, with automation disabled. It always needs a human, now.
   */
  | "l3_drain_failed"
  /** A previous run's L3 latch was rehydrated at startup — the agent came up frozen. */
  | "l3_rehydrated"
  /** L2 hard circuit fired: the agent is force-withdrawing. */
  | "l2_extreme"
  /** Chain/RPC unreachable for long enough that ticks cannot run. */
  | "chain_unreachable"
  /** A lending supply/redeem failed. Funds may be stuck in the protocol. */
  | "lending_failure";

export interface Alert {
  severity: AlertSeverity;
  code: AlertCode;
  /** Human-readable, for the page/notification body. */
  message: string;
  tsMs: number;
  poolId?: string;
  pmId?: string;
  /** Structured context. Must be JSON-serializable. */
  fields?: Record<string, unknown>;
}

export interface AlertSink {
  readonly name: string;
  /**
   * Deliver the alert.
   *
   * MUST NOT THROW and MUST NOT REJECT. A failing pager must never take down
   * the agent, and must never abort the emergency unwind it is reporting on.
   * Swallow your own errors (log them) — the dispatcher also guards, but the
   * contract is on you.
   */
  send(alert: Alert): Promise<void>;
}
