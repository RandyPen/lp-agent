import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { decodeSuiPrivateKey } from "@mysten/sui/cryptography";
import { ConfigError } from "../lib/errors.ts";
import { loadConfig } from "../config.ts";

let cached: Ed25519Keypair | null = null;

export function getAgentKeypair(): Ed25519Keypair {
  if (cached) return cached;
  const cfg = loadConfig();
  const raw = cfg.agentPrivateKey.trim();
  if (!raw.startsWith("suiprivkey")) {
    throw new ConfigError("AGENT_PRIVATE_KEY must be a bech32 'suiprivkey1...' string");
  }
  const { scheme, secretKey } = decodeSuiPrivateKey(raw);
  if (scheme !== "ED25519") {
    throw new ConfigError(`AGENT_PRIVATE_KEY uses ${scheme}; only ED25519 is supported`);
  }
  cached = Ed25519Keypair.fromSecretKey(secretKey);
  return cached;
}

export function getAgentAddress(): string {
  return getAgentKeypair().toSuiAddress();
}

export function resetKeypairCacheForTests(): void {
  cached = null;
}
