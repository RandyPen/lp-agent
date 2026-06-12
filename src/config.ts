import { ConfigError } from "./lib/errors.ts";
import { loadPoolProfile, type PoolProfile } from "./pools/index.ts";
import { isStrategyName, listStrategyNames, type StrategyName } from "./strategies/registry.ts";

export type Network = "mainnet" | "testnet" | "devnet";

export interface LendingAppConfig {
  enabled: boolean;
  apyCacheTtlMs: number;
  protocols: {
    scallop: { enabled: boolean };
    kai: { enabled: boolean };
  };
}

export type { StrategyName };

/**
 * Per-role keypair env config — consumed by the generic resolver in
 * `src/sui/keypairs/resolve.ts`. Each role (agent, treasury, …) has its own
 * independent env vars and is resolved through its own singleton module.
 */
export interface KeyRoleEnvConfig {
  readonly role: string;
  readonly privateKey: string | null;
  readonly mnemonic: string | null;
  readonly derivationPath: string;
  readonly expectedAddress: string | null;
}

/**
 * Bundle of all role configs. Each role has its own env vars and singleton
 * cache in `src/sui/keypairs/*.ts`. See CLAUDE.md §"Multi-role keys".
 */
export interface KeyConfig {
  readonly agent: KeyRoleEnvConfig;
  /** Treasury master keypair config; null when TREASURY_ENABLED=false. */
  readonly treasury: KeyRoleEnvConfig | null;
}

export interface TreasuryAppConfig {
  enabled: boolean;
  /** Watcher poll interval (ms). */
  watcherIntervalMs: number;
  /** Per-user deposit address derivation base — child index appended per user. */
  userBasePath: string;
  /** Per-rebalance flat fee in credits. */
  rebalanceBaseCost: number;
  /** Per USDC-atomic-unit variable rate. credits = base + volume_usdc_atomic × rate. */
  rebalanceFeeRate: number;
  /** When true, an unregistered PM owner is treated as "no credits" → rebalance skipped. */
  requireRegistration: boolean;
}

/**
 * Configuration for the Python prediction sidecar (v1 ML layer).
 * See `docs/prediction-service-design.md §4` and `implementation-plan-v1.md §9`.
 */
export interface PredictionAppConfig {
  /** Base URL of the local Python inference sidecar. Default: http://127.0.0.1:8377 */
  sidecarUrl: string;
  /** HTTP request timeout in ms. After this, SidecarPredictionProvider returns fallback="timeout". */
  timeoutMs: number;
}

/**
 * ML pipeline runtime switches.
 */
export interface MlAppConfig {
  /**
   * When true, `mlAgent` records predictions and state transitions but does NOT
   * submit any on-chain PTBs. The production strategy (cfg.strategy) continues
   * to execute normally. Shadow mode allows 14-day validation before live trading.
   */
  shadowMode: boolean;
}

/**
 * L1/L2/L3 risk thresholds.
 * See `docs/risk-monitoring-design.md §5.3` and `implementation-plan-v1.md §5.3`.
 *
 * All percentage values are fractional (0.10 = 10%, not "10").
 */
export interface RiskThresholds {
  /**
   * L2 trigger: 5-minute price volatility threshold.
   * If |Δprice| / price over 5 min exceeds this, enter EXTREME.
   * Default 0.10 (10%).
   */
  extremeVolatility5m: number;
  /**
   * L2 trigger: 5-minute TVL drop threshold.
   * If TVL drops by more than this fraction over 5 min, enter EXTREME.
   * Default 0.50 (50%).
   */
  tvlDrop5m: number;
  /**
   * L2 trigger: cross-market spread threshold (Cetus vs Binance).
   * If |(cetus_price − binance_price) / binance_price| exceeds this, start timer.
   * Default 0.05 (5%).
   */
  spreadExtreme: number;
  /**
   * L2 trigger: how long (ms) the spread must stay above `spreadExtreme`
   * before entering EXTREME. Default 30_000 (30 s).
   */
  spreadSustainMs: number;
  /**
   * L2 trigger: if pAbove + pBelow exceeds this, enter EXTREME.
   * Signals the model sees high probability of crossing the active bin on both
   * sides (i.e. extreme uncertainty). Default 0.7.
   */
  pBreakSum: number;
  /**
   * L2 trigger: 24-hour PnL threshold. If 24h PnL / NAV < this (negative),
   * enter EXTREME. Default -0.05 (-5%).
   */
  pnl24hPct: number;
  /**
   * L1 soft circuit-breaker: lower bound of the spread band that triggers a
   * soft circuit (increase lending %, narrow half-width). Default 0.005 (0.5%).
   */
  l1SpreadSoftBandLow: number;
  /**
   * L1 soft circuit-breaker: upper bound. Spread above this triggers L1
   * (below spreadExtreme which triggers L2). Default 0.01 (1%).
   */
  l1SpreadSoftBandHigh: number;
}

export interface RiskAppConfig {
  thresholds: RiskThresholds;
}

export interface AppConfig {
  network: Network;
  grpcUrl: string;
  poolProfile: PoolProfile;
  /**
   * Role-aware key configuration. Use `keys.agent` from the agent singleton
   * (`src/sui/keypairs/agent.ts`); future `keys.treasury` from
   * `src/sui/keypairs/treasury.ts`. Roles share the generic resolver but
   * never share cache.
   */
  keys: KeyConfig;
  dbFile: string;
  eventPollIntervalMs: number;
  rebalanceIntervalMs: number;
  perPmCooldownMs: number;
  priceFeed: "onchain" | "pyth" | "binance";
  strategy: StrategyName;
  /**
   * When true, the rebalancer submits a single unified PTB per tick
   * (collect_fee → remove → transfer → redeem → add → supply, atomic).
   * When false, falls back to the per-op transaction sequence (5+ PTBs).
   * Default false until the unified path is mainnet-validated.
   */
  unifiedTx: boolean;
  lending: LendingAppConfig;
  treasury: TreasuryAppConfig;
  /** Python prediction sidecar config (v1 ML layer). */
  prediction: PredictionAppConfig;
  /** ML runtime switches (shadow mode, etc.). */
  ml: MlAppConfig;
  /**
   * Strategy to fall back to when `mlAgent` cannot use the prediction provider
   * (sidecar down, PSI drift, timeout). Defaults to `emaTrend`.
   * Set via `FALLBACK_STRATEGY` env var.
   */
  fallbackStrategy: StrategyName;
  /** Risk monitor thresholds for L1/L2/L3 circuit breakers. */
  risk: RiskAppConfig;
}

function required(name: string): string {
  const v = process.env[name];
  if (!v || v.trim() === "") throw new ConfigError(`missing required env var: ${name}`);
  return v;
}

function optional(name: string, fallback: string): string {
  const v = process.env[name];
  return v && v.trim() !== "" ? v : fallback;
}

/** Sui addresses are 0x-prefixed 32-byte hex (64 hex chars). */
const SUI_ADDR_RE = /^0x[0-9a-fA-F]{64}$/;
function isValidSuiAddress(s: string): boolean {
  return SUI_ADDR_RE.test(s);
}

/**
 * Accumulator that lets us scan every required .env field, collect ALL
 * missing/invalid ones, and surface them in a single error message.
 *
 * The point: an operator deploying for the first time should see every
 * gap in one go, not have to launch-fail-fix-launch ten times.
 */
class ConfigErrorAggregator {
  private readonly issues: string[] = [];

  push(msg: string): void {
    this.issues.push(msg);
  }

  hasIssues(): boolean {
    return this.issues.length > 0;
  }

  toError(): ConfigError {
    const numbered = this.issues.map((s, i) => `  ${i + 1}. ${s}`).join("\n");
    return new ConfigError(
      `配置缺失或无效(共 ${this.issues.length} 项),请补齐 .env(参见 .env.example):\n${numbered}`,
    );
  }
}

function parseNetwork(raw: string): Network {
  if (raw === "mainnet" || raw === "testnet" || raw === "devnet") return raw;
  throw new ConfigError(`SUI_NETWORK must be mainnet|testnet|devnet, got '${raw}'`);
}

function parsePriceFeed(raw: string): AppConfig["priceFeed"] {
  if (raw === "onchain" || raw === "pyth" || raw === "binance") return raw;
  throw new ConfigError(`PRICE_FEED must be onchain|pyth|binance, got '${raw}'`);
}

function parseStrategy(raw: string): StrategyName {
  if (isStrategyName(raw)) return raw;
  throw new ConfigError(
    `STRATEGY must be one of [${listStrategyNames().join(", ")}], got '${raw}'`,
  );
}

function defaultGrpcUrl(network: Network): string {
  switch (network) {
    case "mainnet": return "https://fullnode.mainnet.sui.io:443";
    case "testnet": return "https://fullnode.testnet.sui.io:443";
    case "devnet":  return "https://fullnode.devnet.sui.io:443";
  }
}

let cached: AppConfig | null = null;

export function loadConfig(): AppConfig {
  if (cached) return cached;

  const errs = new ConfigErrorAggregator();

  const network = parseNetwork(optional("SUI_NETWORK", "mainnet"));
  const grpcUrl = optional("SUI_GRPC_URL", defaultGrpcUrl(network));
  const poolProfileName = optional("POOL_PROFILE", "sui-usdc");

  // Pool profile loading throws on its own — collect into the aggregator
  // so missing SUI_USDC_POOL_ID shows up alongside other gaps.
  let poolProfile: PoolProfile | null = null;
  try {
    const candidate = loadPoolProfile(poolProfileName);
    if (candidate.network !== network) {
      errs.push(
        `pool profile '${candidate.name}' targets ${candidate.network} but SUI_NETWORK=${network}`,
      );
    } else if (!candidate.poolId) {
      // Profile loaded but pool id env was empty (e.g. SUI_USDC_POOL_ID).
      errs.push(
        `pool profile '${candidate.name}' requires its pool-id env (e.g. SUI_USDC_POOL_ID) — currently empty`,
      );
    } else {
      poolProfile = candidate;
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    errs.push(`pool profile '${poolProfileName}' could not be loaded: ${msg}`);
  }

  const lending: LendingAppConfig = {
    enabled: optional("LENDING_ENABLED", "true").toLowerCase() !== "false",
    apyCacheTtlMs: Number(optional("LENDING_APY_CACHE_TTL_MS", "60000")),
    protocols: {
      scallop: { enabled: optional("LENDING_SCALLOP_ENABLED", "true").toLowerCase() !== "false" },
      kai: { enabled: optional("LENDING_KAI_ENABLED", "true").toLowerCase() !== "false" },
    },
  };
  if (!Number.isFinite(lending.apyCacheTtlMs) || lending.apyCacheTtlMs <= 0) {
    errs.push(`LENDING_APY_CACHE_TTL_MS must be a positive number (got '${process.env.LENDING_APY_CACHE_TTL_MS ?? ""}')`);
  }

  // Agent role: AGENT_PRIVATE_KEY wins over the mnemonic; mnemonic name
  // accepts both AGENT_MNEMONICS (new, role-explicit) and MNEMONICS (legacy).
  const agentPrivateKeyRaw = process.env.AGENT_PRIVATE_KEY?.trim() ?? "";
  const agentMnemonicRaw =
    process.env.AGENT_MNEMONICS?.trim() ?? process.env.MNEMONICS?.trim() ?? "";
  if (!agentPrivateKeyRaw && !agentMnemonicRaw) {
    errs.push(
      "agent key not configured: set AGENT_PRIVATE_KEY (suiprivkey1…) or AGENT_MNEMONICS / MNEMONICS in .env",
    );
  }

  // EXPECTED_AGENT_ADDRESS is REQUIRED — fail-fast safety guard against
  // accidentally swapping mnemonics or running the wrong derivation path.
  const expectedAgentAddrRaw = process.env.EXPECTED_AGENT_ADDRESS?.trim() ?? "";
  if (!expectedAgentAddrRaw) {
    errs.push(
      "EXPECTED_AGENT_ADDRESS not set: required so 'bun start' aborts if the wrong agent key is loaded. Set it to the address you whitelisted on the PositionManager.",
    );
  } else if (!isValidSuiAddress(expectedAgentAddrRaw)) {
    errs.push(
      `EXPECTED_AGENT_ADDRESS malformed: '${expectedAgentAddrRaw}' — expected a 0x-prefixed 64-hex Sui address`,
    );
  }

  // Treasury role (optional — TREASURY_ENABLED=false disables the whole layer).
  const treasuryEnabled =
    optional("TREASURY_ENABLED", "false").toLowerCase() === "true";
  const treasuryPrivateKeyRaw = process.env.TREASURY_PRIVATE_KEY?.trim() ?? "";
  const treasuryMnemonicRaw = process.env.TREASURY_MNEMONICS?.trim() ?? "";
  let treasuryKey: KeyRoleEnvConfig | null = null;
  if (treasuryEnabled) {
    if (!treasuryPrivateKeyRaw && !treasuryMnemonicRaw) {
      errs.push(
        "treasury enabled but key not configured: set TREASURY_PRIVATE_KEY or TREASURY_MNEMONICS in .env (or set TREASURY_ENABLED=false)",
      );
    }
    const expectedTreasuryAddrRaw =
      process.env.EXPECTED_TREASURY_MASTER_ADDRESS?.trim() ?? "";
    if (expectedTreasuryAddrRaw && !isValidSuiAddress(expectedTreasuryAddrRaw)) {
      errs.push(
        `EXPECTED_TREASURY_MASTER_ADDRESS malformed: '${expectedTreasuryAddrRaw}' — expected a 0x-prefixed 64-hex Sui address`,
      );
    }
    treasuryKey = {
      role: "treasury",
      privateKey: treasuryPrivateKeyRaw === "" ? null : treasuryPrivateKeyRaw,
      mnemonic: treasuryMnemonicRaw === "" ? null : treasuryMnemonicRaw,
      derivationPath: optional("TREASURY_MASTER_DERIVATION_PATH", "m/44'/784'/0'/0'/0'"),
      expectedAddress: expectedTreasuryAddrRaw === "" ? null : expectedTreasuryAddrRaw,
    };
  }

  const treasury: TreasuryAppConfig = {
    enabled: treasuryEnabled,
    watcherIntervalMs: Number(optional("TREASURY_WATCHER_INTERVAL_MS", "15000")),
    userBasePath: optional("TREASURY_USER_BASE_PATH", "m/44'/784'/0'/0'"),
    rebalanceBaseCost: Number(optional("TREASURY_REBALANCE_BASE_COST", "10")),
    rebalanceFeeRate: Number(optional("TREASURY_REBALANCE_FEE_RATE", "0.0000001")),
    requireRegistration:
      optional("TREASURY_REQUIRE_REGISTRATION", "false").toLowerCase() === "true",
  };
  if (treasury.enabled) {
    if (!Number.isFinite(treasury.watcherIntervalMs) || treasury.watcherIntervalMs <= 0) {
      errs.push("TREASURY_WATCHER_INTERVAL_MS must be a positive number");
    }
    if (!Number.isFinite(treasury.rebalanceBaseCost) || treasury.rebalanceBaseCost < 0) {
      errs.push("TREASURY_REBALANCE_BASE_COST must be ≥ 0");
    }
    if (!Number.isFinite(treasury.rebalanceFeeRate) || treasury.rebalanceFeeRate < 0) {
      errs.push("TREASURY_REBALANCE_FEE_RATE must be ≥ 0");
    }
  }

  // Loop tunings (collected, not thrown one-by-one).
  const eventPollIntervalMs = Number(optional("EVENT_POLL_INTERVAL_MS", "5000"));
  const rebalanceIntervalMs = Number(optional("REBALANCE_INTERVAL_MS", "60000"));
  const perPmCooldownMs = Number(optional("PER_PM_COOLDOWN_MS", "30000"));
  for (const [name, value] of [
    ["EVENT_POLL_INTERVAL_MS", eventPollIntervalMs],
    ["REBALANCE_INTERVAL_MS", rebalanceIntervalMs],
    ["PER_PM_COOLDOWN_MS", perPmCooldownMs],
  ] as const) {
    if (!Number.isFinite(value) || value <= 0) {
      errs.push(`${name} must be a positive number, got ${process.env[name] ?? ""}`);
    }
  }

  // Prediction sidecar config (v1 ML layer).
  const predictionTimeoutMs = Number(optional("PREDICTION_TIMEOUT_MS", "2000"));
  if (!Number.isFinite(predictionTimeoutMs) || predictionTimeoutMs <= 0) {
    errs.push(`PREDICTION_TIMEOUT_MS must be a positive number, got '${process.env.PREDICTION_TIMEOUT_MS ?? ""}'`);
  }
  const prediction: PredictionAppConfig = {
    sidecarUrl: optional("PREDICTION_SIDECAR_URL", "http://127.0.0.1:8377"),
    timeoutMs: predictionTimeoutMs,
  };

  // ML shadow mode.
  const ml: MlAppConfig = {
    shadowMode: optional("ML_SHADOW_MODE", "false").toLowerCase() === "true",
  };

  // Fallback strategy for mlAgent Tier 0 degradation.
  const fallbackStrategyRaw = optional("FALLBACK_STRATEGY", "emaTrend");
  if (!isStrategyName(fallbackStrategyRaw)) {
    errs.push(
      `FALLBACK_STRATEGY must be one of [${listStrategyNames().join(", ")}], got '${fallbackStrategyRaw}'`,
    );
  }
  const fallbackStrategy = isStrategyName(fallbackStrategyRaw)
    ? fallbackStrategyRaw
    : ("emaTrend" as StrategyName);

  // Risk thresholds (L1/L2/L3 circuit breakers).
  const extremeVolatility5m = Number(optional("RISK_EXTREME_VOLATILITY_5M", "0.10"));
  const tvlDrop5m = Number(optional("RISK_TVL_DROP_5M", "0.50"));
  const spreadExtreme = Number(optional("RISK_SPREAD_EXTREME", "0.05"));
  const spreadSustainMs = Number(optional("RISK_SPREAD_SUSTAIN_MS", "30000"));
  const pBreakSum = Number(optional("RISK_P_BREAK_SUM", "0.7"));
  const pnl24hPct = Number(optional("RISK_PNL_24H_PCT", "-0.05"));
  const l1SpreadSoftBandLow = Number(optional("RISK_L1_SPREAD_SOFT_BAND_LOW", "0.005"));
  const l1SpreadSoftBandHigh = Number(optional("RISK_L1_SPREAD_SOFT_BAND_HIGH", "0.01"));

  for (const [name, value] of [
    ["RISK_EXTREME_VOLATILITY_5M", extremeVolatility5m],
    ["RISK_TVL_DROP_5M", tvlDrop5m],
    ["RISK_SPREAD_EXTREME", spreadExtreme],
    ["RISK_SPREAD_SUSTAIN_MS", spreadSustainMs],
    ["RISK_P_BREAK_SUM", pBreakSum],
    ["RISK_L1_SPREAD_SOFT_BAND_LOW", l1SpreadSoftBandLow],
    ["RISK_L1_SPREAD_SOFT_BAND_HIGH", l1SpreadSoftBandHigh],
  ] as const) {
    if (!Number.isFinite(value)) {
      errs.push(`${name} must be a finite number, got '${process.env[name] ?? ""}'`);
    }
  }
  if (!Number.isFinite(pnl24hPct)) {
    errs.push(`RISK_PNL_24H_PCT must be a finite number, got '${process.env.RISK_PNL_24H_PCT ?? ""}'`);
  }

  const risk: RiskAppConfig = {
    thresholds: {
      extremeVolatility5m,
      tvlDrop5m,
      spreadExtreme,
      spreadSustainMs,
      pBreakSum,
      pnl24hPct,
      l1SpreadSoftBandLow,
      l1SpreadSoftBandHigh,
    },
  };

  // Surface every gap in one shot.
  if (errs.hasIssues()) throw errs.toError();

  // Past the gate: all collected slots are valid.
  // poolProfile cannot be null here since loadPoolProfile success path
  // is gated by the absence of errors.
  if (!poolProfile) {
    throw new ConfigError(
      "internal: poolProfile is null after validation passed (this is a bug, please report)",
    );
  }

  const keys: KeyConfig = {
    agent: {
      role: "agent",
      privateKey: agentPrivateKeyRaw === "" ? null : agentPrivateKeyRaw,
      mnemonic: agentMnemonicRaw === "" ? null : agentMnemonicRaw,
      derivationPath: optional("AGENT_DERIVATION_PATH", "m/44'/784'/1'/0'/0'"),
      expectedAddress: expectedAgentAddrRaw,
    },
    treasury: treasuryKey,
  };

  cached = {
    network,
    grpcUrl,
    poolProfile,
    keys,
    dbFile: optional("DB_FILE", "./data/app.db"),
    eventPollIntervalMs,
    rebalanceIntervalMs,
    perPmCooldownMs,
    priceFeed: parsePriceFeed(optional("PRICE_FEED", "onchain")),
    strategy: parseStrategy(optional("STRATEGY", "singleBin")),
    unifiedTx: optional("UNIFIED_TX", "false").toLowerCase() === "true",
    lending,
    treasury,
    prediction,
    ml,
    fallbackStrategy,
    risk,
  };

  return cached;
}

export function resetConfigCacheForTests(): void {
  cached = null;
}
