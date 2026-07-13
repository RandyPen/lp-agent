/**
 * tests/config.test.ts
 *
 * loadConfig() validation for the Phase 1 additions:
 *   - StateParams (STATE_* env vars): defaults, overrides, cross-field checks.
 *   - RISK_VOLATILITY_RECOVERY < RISK_EXTREME_VOLATILITY_5M.
 *   - L3 thresholds: defaults + cross-field checks (outage > staleness,
 *     L3 pnl more negative than L2 pnl).
 *
 * Batched-error contract: every violation must appear in ONE ConfigError.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { loadConfig, resetConfigCacheForTests } from "../src/config.ts";
import { DEFAULT_STATE_PARAMS } from "../src/state/params.ts";

// Minimal valid env (mirrors tests/txUnified.test.ts bootstrap).
const REQUIRED_ENV: Record<string, string> = {
  AGENT_PRIVATE_KEY: "suiprivkey1qr3twlseqm4qj5sr7mqhz3yyx7wrluu3qn39nj6jxpsxufe46mul574lteq",
  SUI_USDC_POOL_ID: "0xpool",
  EXPECTED_AGENT_ADDRESS:
    "0xf3f8feeba6b94376511dfc38d51ea3f5d2f3d1b70725fa0f50e5253a66d0d0b9",
  IDENTITY_FILES_DISABLED: "true",
  LENDING_ENABLED: "false",
};

const MANAGED_KEYS = [
  ...Object.keys(REQUIRED_ENV),
  "STATE_K_W",
  "STATE_U_HIGH",
  "STATE_DRIFT_STRENGTH_ENTRY",
  "STATE_DRIFT_STRENGTH_EXIT",
  "STATE_P_BREAK_ENTRY",
  "STATE_P_BREAK_SUM_EXTREME",
  "STATE_P_BREAK_SUM_EXTREME_EXIT",
  "STATE_TREND_BIAS_STRONG",
  "RISK_VOLATILITY_RECOVERY",
  "RISK_EXTREME_VOLATILITY_5M",
  "RISK_PNL_24H_PCT",
  "RISK_L3_PNL_PCT",
  "RISK_L3_OUTAGE_MS",
  "RISK_SOURCE_STALE_SUI_MS",
  "RISK_L3_REPEATED_L2_COUNT",
];

const origEnv: Record<string, string | undefined> = {};

beforeAll(() => {
  for (const k of MANAGED_KEYS) origEnv[k] = process.env[k];
});

afterAll(() => {
  for (const k of MANAGED_KEYS) {
    if (origEnv[k] !== undefined) process.env[k] = origEnv[k];
    else delete process.env[k];
  }
  resetConfigCacheForTests();
});

beforeEach(() => {
  // Reset to the minimal valid env before each test.
  for (const k of MANAGED_KEYS) delete process.env[k];
  for (const [k, v] of Object.entries(REQUIRED_ENV)) process.env[k] = v;
  resetConfigCacheForTests();
});

describe("stateParams (STATE_* env)", () => {
  it("defaults equal DEFAULT_STATE_PARAMS when no env is set", () => {
    const cfg = loadConfig();
    expect(cfg.stateParams).toEqual(DEFAULT_STATE_PARAMS);
  });

  it("env overrides are honoured", () => {
    process.env.STATE_K_W = "3.5";
    process.env.STATE_P_BREAK_ENTRY = "0.55";
    resetConfigCacheForTests();
    const cfg = loadConfig();
    expect(cfg.stateParams.kW).toBe(3.5);
    expect(cfg.stateParams.pBreakEntry).toBe(0.55);
    // untouched fields keep defaults
    expect(cfg.stateParams.uHigh).toBe(DEFAULT_STATE_PARAMS.uHigh);
  });

  it("drift exit >= entry is a batched config error naming both vars", () => {
    process.env.STATE_DRIFT_STRENGTH_ENTRY = "2.0";
    process.env.STATE_DRIFT_STRENGTH_EXIT = "3.0";
    resetConfigCacheForTests();
    expect(() => loadConfig()).toThrow(/STATE_DRIFT_STRENGTH_EXIT.*STATE_DRIFT_STRENGTH_ENTRY/s);
  });

  it("EXTREME p-sum exit >= entry is a batched config error", () => {
    process.env.STATE_P_BREAK_SUM_EXTREME = "0.7";
    process.env.STATE_P_BREAK_SUM_EXTREME_EXIT = "0.7";
    resetConfigCacheForTests();
    expect(() => loadConfig()).toThrow(/STATE_P_BREAK_SUM_EXTREME_EXIT/);
  });

  it("non-numeric STATE_* value is rejected", () => {
    process.env.STATE_K_W = "banana";
    resetConfigCacheForTests();
    expect(() => loadConfig()).toThrow(/STATE_K_W/);
  });

  it("multiple violations surface in one batched error", () => {
    process.env.STATE_K_W = "banana";
    process.env.STATE_DRIFT_STRENGTH_EXIT = "9";
    resetConfigCacheForTests();
    try {
      loadConfig();
      throw new Error("expected ConfigError");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      expect(msg).toContain("STATE_K_W");
      expect(msg).toContain("STATE_DRIFT_STRENGTH_EXIT");
    }
  });
});

describe("risk thresholds — volatility recovery hysteresis", () => {
  it("defaults: recovery 0.07 below entry 0.10", () => {
    const cfg = loadConfig();
    expect(cfg.risk.thresholds.volatilityRecovery).toBe(0.07);
    expect(cfg.risk.thresholds.extremeVolatility5m).toBe(0.10);
  });

  it("recovery >= entry aborts with a batched error", () => {
    // Lowering the entry threshold below the default recovery used to
    // silently invert the hysteresis — now it must fail at load.
    process.env.RISK_EXTREME_VOLATILITY_5M = "0.05";
    resetConfigCacheForTests();
    expect(() => loadConfig()).toThrow(/RISK_VOLATILITY_RECOVERY.*RISK_EXTREME_VOLATILITY_5M/s);
  });

  it("a consistent override pair loads", () => {
    process.env.RISK_EXTREME_VOLATILITY_5M = "0.05";
    process.env.RISK_VOLATILITY_RECOVERY = "0.03";
    resetConfigCacheForTests();
    const cfg = loadConfig();
    expect(cfg.risk.thresholds.volatilityRecovery).toBe(0.03);
  });
});

describe("risk L3 thresholds", () => {
  it("defaults load", () => {
    const cfg = loadConfig();
    expect(cfg.risk.l3).toEqual({
      repeatedL2Count: 3,
      repeatedL2WindowMs: 3_600_000,
      outageMs: 300_000,
      pnlPct: -0.15,
      txFailureCount: 5,
      drainMaxAttempts: 3,
    });
  });

  it("L3 pnl must be more negative than the L2 pnl threshold", () => {
    process.env.RISK_L3_PNL_PCT = "-0.03"; // above the L2 default -0.05
    resetConfigCacheForTests();
    expect(() => loadConfig()).toThrow(/RISK_L3_PNL_PCT.*RISK_PNL_24H_PCT/s);
  });

  it("L3 outage must exceed the sui staleness threshold", () => {
    process.env.RISK_L3_OUTAGE_MS = "30000"; // below RISK_SOURCE_STALE_SUI_MS default 60000
    resetConfigCacheForTests();
    expect(() => loadConfig()).toThrow(/RISK_L3_OUTAGE_MS.*RISK_SOURCE_STALE_SUI_MS/s);
  });

  it("repeated-L2 count must be a positive integer", () => {
    process.env.RISK_L3_REPEATED_L2_COUNT = "0";
    resetConfigCacheForTests();
    expect(() => loadConfig()).toThrow(/RISK_L3_REPEATED_L2_COUNT/);
  });
});

describe("execution knobs", () => {
  it("REBALANCE_MAX_PER_HOUR default and validation", () => {
    const cfg = loadConfig();
    expect(cfg.rebalanceMaxPerHour).toBe(4);
    expect(cfg.unifiedTx).toBe(true); // Phase 2: unified PTB is the default

    process.env.REBALANCE_MAX_PER_HOUR = "0";
    resetConfigCacheForTests();
    expect(() => loadConfig()).toThrow(/REBALANCE_MAX_PER_HOUR/);
    delete process.env.REBALANCE_MAX_PER_HOUR;
    resetConfigCacheForTests();
  });
});
