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

  const network = parseNetwork(optional("SUI_NETWORK", "mainnet"));
  const grpcUrl = optional("SUI_GRPC_URL", defaultGrpcUrl(network));
  const poolProfileName = optional("POOL_PROFILE", "sui-usdc");
  const poolProfile = loadPoolProfile(poolProfileName);

  if (poolProfile.network !== network) {
    throw new ConfigError(
      `pool profile '${poolProfile.name}' targets ${poolProfile.network} but SUI_NETWORK=${network}`,
    );
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
    throw new ConfigError(`LENDING_APY_CACHE_TTL_MS must be a positive number`);
  }

  // Agent role: AGENT_PRIVATE_KEY wins over the mnemonic; mnemonic name
  // accepts both AGENT_MNEMONICS (new, role-explicit) and MNEMONICS (legacy).
  const agentPrivateKeyRaw = process.env.AGENT_PRIVATE_KEY?.trim() ?? "";
  const agentMnemonicRaw =
    process.env.AGENT_MNEMONICS?.trim() ?? process.env.MNEMONICS?.trim() ?? "";
  if (!agentPrivateKeyRaw && !agentMnemonicRaw) {
    throw new ConfigError(
      "agent key not configured: set AGENT_PRIVATE_KEY (suiprivkey1…) or AGENT_MNEMONICS / MNEMONICS in .env",
    );
  }
  const expectedAgentAddrRaw = process.env.EXPECTED_AGENT_ADDRESS?.trim() ?? "";

  // Treasury role (optional — TREASURY_ENABLED=false disables the whole layer).
  const treasuryEnabled =
    optional("TREASURY_ENABLED", "false").toLowerCase() === "true";
  const treasuryPrivateKeyRaw = process.env.TREASURY_PRIVATE_KEY?.trim() ?? "";
  const treasuryMnemonicRaw = process.env.TREASURY_MNEMONICS?.trim() ?? "";
  let treasuryKey: KeyRoleEnvConfig | null = null;
  if (treasuryEnabled) {
    if (!treasuryPrivateKeyRaw && !treasuryMnemonicRaw) {
      throw new ConfigError(
        "treasury enabled but key not configured: set TREASURY_PRIVATE_KEY or TREASURY_MNEMONICS in .env (or set TREASURY_ENABLED=false)",
      );
    }
    const expectedTreasuryAddrRaw =
      process.env.EXPECTED_TREASURY_MASTER_ADDRESS?.trim() ?? "";
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
      throw new ConfigError("TREASURY_WATCHER_INTERVAL_MS must be a positive number");
    }
    if (!Number.isFinite(treasury.rebalanceBaseCost) || treasury.rebalanceBaseCost < 0) {
      throw new ConfigError("TREASURY_REBALANCE_BASE_COST must be ≥ 0");
    }
    if (!Number.isFinite(treasury.rebalanceFeeRate) || treasury.rebalanceFeeRate < 0) {
      throw new ConfigError("TREASURY_REBALANCE_FEE_RATE must be ≥ 0");
    }
  }

  const keys: KeyConfig = {
    agent: {
      role: "agent",
      privateKey: agentPrivateKeyRaw === "" ? null : agentPrivateKeyRaw,
      mnemonic: agentMnemonicRaw === "" ? null : agentMnemonicRaw,
      derivationPath: optional("AGENT_DERIVATION_PATH", "m/44'/784'/1'/0'/0'"),
      expectedAddress: expectedAgentAddrRaw === "" ? null : expectedAgentAddrRaw,
    },
    treasury: treasuryKey,
  };

  cached = {
    network,
    grpcUrl,
    poolProfile,
    keys,
    dbFile: optional("DB_FILE", "./data/app.db"),
    eventPollIntervalMs: Number(optional("EVENT_POLL_INTERVAL_MS", "5000")),
    rebalanceIntervalMs: Number(optional("REBALANCE_INTERVAL_MS", "60000")),
    perPmCooldownMs: Number(optional("PER_PM_COOLDOWN_MS", "30000")),
    priceFeed: parsePriceFeed(optional("PRICE_FEED", "onchain")),
    strategy: parseStrategy(optional("STRATEGY", "singleBin")),
    unifiedTx: optional("UNIFIED_TX", "false").toLowerCase() === "true",
    lending,
    treasury,
  };

  for (const k of ["eventPollIntervalMs", "rebalanceIntervalMs", "perPmCooldownMs"] as const) {
    if (!Number.isFinite(cached[k]) || cached[k] <= 0) {
      throw new ConfigError(`${k} must be a positive number, got ${cached[k]}`);
    }
  }
  return cached;
}

export function resetConfigCacheForTests(): void {
  cached = null;
}
