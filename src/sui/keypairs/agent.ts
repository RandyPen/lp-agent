/**
 * Agent role keypair — the address that signs CDPM rebalance transactions.
 *
 * Sources, in precedence order:
 *   1. `AGENT_PRIVATE_KEY` (bech32 `suiprivkey1…`)
 *   2. `AGENT_MNEMONICS` (preferred new name) or `MNEMONICS` (legacy alias)
 *      + `AGENT_DERIVATION_PATH` (default `m/44'/784'/1'/0'/0'`)
 *
 * The resolver enforces `EXPECTED_AGENT_ADDRESS` when set; mismatch throws.
 *
 * Singleton with module-private cache — never shared with other roles (see
 * `src/sui/keypairs/treasury.ts` when added). This isolation matters: a
 * compromised agent code path must not be able to obtain the treasury key
 * by accident.
 */

import type { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { loadConfig } from "../../config.ts";
import { log } from "../../lib/logger.ts";
import { resolveKeypair } from "./resolve.ts";
import {
  defaultIdentityFilePath,
  identityFilesDisabled,
  loadOrPersistIdentity,
} from "./identityFile.ts";

let cached: Ed25519Keypair | null = null;
let cachedAddress: string | null = null;

export function getAgentKeypair(): Ed25519Keypair {
  if (cached) return cached;
  const cfg = loadConfig();
  const resolved = resolveKeypair(cfg.keys.agent);

  // TOFU identity gate (defense in depth over EXPECTED_AGENT_ADDRESS).
  // First run writes `<dbDir>/agent.identity.json`; later runs verify and
  // throw on mismatch. Disable via `IDENTITY_FILES_DISABLED=true`.
  let identityNote = "skipped";
  if (!identityFilesDisabled()) {
    const filePath =
      process.env.AGENT_IDENTITY_FILE?.trim() ||
      defaultIdentityFilePath("agent", cfg.dbFile);
    const result = loadOrPersistIdentity({
      role: "agent",
      derivedAddress: resolved.address,
      source: resolved.source,
      derivationPath:
        resolved.source === "mnemonic" ? cfg.keys.agent.derivationPath : null,
      filePath,
    });
    identityNote = result.created ? `created:${filePath}` : `verified:${filePath}`;
  }

  cached = resolved.keypair;
  cachedAddress = resolved.address;
  log.info("agent keypair resolved", {
    role: "agent",
    address: resolved.address,
    source: resolved.source,
    derivationPath:
      resolved.source === "mnemonic"
        ? cfg.keys.agent.derivationPath
        : undefined,
    addressGuard: cfg.keys.agent.expectedAddress ? "enforced" : "unset",
    identityFile: identityNote,
  });
  return cached;
}

export function getAgentAddress(): string {
  if (cachedAddress) return cachedAddress;
  return getAgentKeypair().toSuiAddress();
}

export function resetAgentKeypairCacheForTests(): void {
  cached = null;
  cachedAddress = null;
}
