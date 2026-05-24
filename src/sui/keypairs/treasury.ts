/**
 * Treasury role keypairs — receives user top-up deposits.
 *
 * Two distinct keypair categories:
 *
 *   - **Master** (`getTreasuryMasterKeypair`) — operations on the operator's
 *     consolidation address: sweeping per-user deposits, signing admin
 *     transfers. Singleton with private cache. Source precedence:
 *       1. `TREASURY_PRIVATE_KEY` (bech32 `suiprivkey1…`)
 *       2. `TREASURY_MNEMONICS` + `TREASURY_MASTER_DERIVATION_PATH`
 *          (default `m/44'/784'/0'/0'/0'`)
 *     Validated against `EXPECTED_TREASURY_MASTER_ADDRESS` when set.
 *
 *   - **Per-user deposit** (`getUserDepositKeypair(derivationIndex)`) —
 *     derived from `TREASURY_MNEMONICS` at `TREASURY_USER_BASE_PATH/{index}'`
 *     (default base path `m/44'/784'/0'/0'`, indices ≥ 1). **Not cached** —
 *     derivation is sub-microsecond and per-user keypairs are short-lived
 *     (only materialised when sweeping that user's deposit address).
 *
 * The agent code path (`src/sui/keypairs/agent.ts`) must NOT be able to
 * obtain these keypairs by accident — the two modules share `resolve.ts`
 * (the pure resolver) but never share cache or env reads. See CLAUDE.md
 * §"Multi-role keys" for the contract.
 *
 * Privacy contract: this module never logs the mnemonic, private key, or
 * seed material. Master address (public) logged once at first resolution.
 */

import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { loadConfig } from "../../config.ts";
import { ConfigError } from "../../lib/errors.ts";
import { log } from "../../lib/logger.ts";
import { resolveKeypair } from "./resolve.ts";
import {
  defaultIdentityFilePath,
  identityFilesDisabled,
  loadOrPersistIdentity,
} from "./identityFile.ts";

let cachedMaster: Ed25519Keypair | null = null;
let cachedMasterAddress: string | null = null;

export function getTreasuryMasterKeypair(): Ed25519Keypair {
  if (cachedMaster) return cachedMaster;
  const cfg = loadConfig();
  if (!cfg.keys.treasury) {
    throw new ConfigError(
      "treasury keypair not configured: set TREASURY_PRIVATE_KEY or TREASURY_MNEMONICS in .env",
    );
  }
  const resolved = resolveKeypair(cfg.keys.treasury);

  // TOFU identity gate — see src/sui/keypairs/identityFile.ts.
  let identityNote = "skipped";
  if (!identityFilesDisabled()) {
    const filePath =
      process.env.TREASURY_IDENTITY_FILE?.trim() ||
      defaultIdentityFilePath("treasury", cfg.dbFile);
    const result = loadOrPersistIdentity({
      role: "treasury",
      derivedAddress: resolved.address,
      source: resolved.source,
      derivationPath:
        resolved.source === "mnemonic" ? cfg.keys.treasury.derivationPath : null,
      filePath,
    });
    identityNote = result.created ? `created:${filePath}` : `verified:${filePath}`;
  }

  cachedMaster = resolved.keypair;
  cachedMasterAddress = resolved.address;
  log.info("treasury master keypair resolved", {
    role: "treasury",
    address: resolved.address,
    source: resolved.source,
    derivationPath:
      resolved.source === "mnemonic" ? cfg.keys.treasury.derivationPath : undefined,
    addressGuard: cfg.keys.treasury.expectedAddress ? "enforced" : "unset",
    identityFile: identityNote,
  });
  return cachedMaster;
}

export function getTreasuryMasterAddress(): string {
  if (cachedMasterAddress) return cachedMasterAddress;
  return getTreasuryMasterKeypair().toSuiAddress();
}

/**
 * Derive a per-user deposit keypair at `TREASURY_USER_BASE_PATH/{index}'`.
 *
 * **Not cached** — per-user keypairs are derived on demand (e.g., when
 * sweeping or signing a refund), then discarded. Avoids keeping N user
 * private keys in process memory simultaneously.
 *
 * Derivation index = 0 is reserved for the master (per `TREASURY_MASTER_DERIVATION_PATH`).
 * User indices start at 1. The runtime enforces this through `treasury_users.derivation_index ≥ 1`
 * in the SQL store.
 */
/** SLIP-0010 hardened index upper bound (exclusive). */
const HARDENED_INDEX_MAX = 2_147_483_648; // 2^31

export function getUserDepositKeypair(derivationIndex: number): Ed25519Keypair {
  if (
    !Number.isInteger(derivationIndex) ||
    derivationIndex < 1 ||
    derivationIndex >= HARDENED_INDEX_MAX
  ) {
    throw new ConfigError(
      `treasury user derivation index must be integer in [1, ${HARDENED_INDEX_MAX}), got ${derivationIndex}`,
    );
  }
  const cfg = loadConfig();
  if (!cfg.keys.treasury?.mnemonic) {
    throw new ConfigError(
      "user deposit derivation requires TREASURY_MNEMONICS — TREASURY_PRIVATE_KEY-only mode cannot derive per-user addresses",
    );
  }
  const path = `${cfg.treasury.userBasePath}/${derivationIndex}'`;
  try {
    return Ed25519Keypair.deriveKeypair(cfg.keys.treasury.mnemonic.trim(), path);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new ConfigError(
      `treasury user derivation failed at path '${path}': ${msg}`,
    );
  }
}

/** Derive a deposit address without materialising the keypair. */
export function deriveUserDepositAddress(derivationIndex: number): string {
  return getUserDepositKeypair(derivationIndex).toSuiAddress();
}

export function resetTreasuryKeypairCacheForTests(): void {
  cachedMaster = null;
  cachedMasterAddress = null;
}
