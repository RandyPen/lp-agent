import { ConfigError } from "./lib/errors.ts";
import { loadPoolProfile, type PoolProfile } from "./pools/index.ts";

export type Network = "mainnet" | "testnet" | "devnet";

export interface AppConfig {
  network: Network;
  grpcUrl: string;
  poolProfile: PoolProfile;
  agentPrivateKey: string;
  dbFile: string;
  eventPollIntervalMs: number;
  rebalanceIntervalMs: number;
  perPmCooldownMs: number;
  priceFeed: "onchain" | "pyth" | "binance";
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

  cached = {
    network,
    grpcUrl,
    poolProfile,
    agentPrivateKey: required("AGENT_PRIVATE_KEY"),
    dbFile: optional("DB_FILE", "./data/app.db"),
    eventPollIntervalMs: Number(optional("EVENT_POLL_INTERVAL_MS", "5000")),
    rebalanceIntervalMs: Number(optional("REBALANCE_INTERVAL_MS", "60000")),
    perPmCooldownMs: Number(optional("PER_PM_COOLDOWN_MS", "30000")),
    priceFeed: parsePriceFeed(optional("PRICE_FEED", "onchain")),
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
