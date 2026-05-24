/**
 * Generic role-keypair resolver. Pure function:
 *   - reads nothing from `process.env` or filesystem (callers pre-collect the
 *     config from `loadConfig()` and pass it in)
 *   - emits no logs (callers do their own logging at the singleton layer)
 *   - throws ConfigError on any misconfiguration (`*_PRIVATE_KEY` malformed,
 *     mnemonic derivation failure, EXPECTED address mismatch)
 *
 * Why a pure resolver:
 *   - Each role (agent, treasury, …) has its own singleton wrapper that
 *     handles caching and logging. The math + validation is shared via this
 *     resolver.
 *   - Easy to unit-test with synthetic inputs — no env/process state to mock.
 *
 * Privacy contract: this module never logs key material. Error messages
 * include role name and the public derived address but never the private
 * key, mnemonic, or seed.
 */

import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { decodeSuiPrivateKey } from "@mysten/sui/cryptography";
import { ConfigError } from "../../lib/errors.ts";

export interface KeyRoleConfig {
  /** Role label, used in error messages + log lines (e.g. "agent", "treasury"). */
  readonly role: string;
  /** Bech32 ED25519 private key (`suiprivkey1…`). Wins if set. */
  readonly privateKey: string | null;
  /** BIP-39 mnemonic phrase. Used only when `privateKey` is null. */
  readonly mnemonic: string | null;
  /** Derivation path applied when deriving from mnemonic. */
  readonly derivationPath: string;
  /** Hex Sui address. Resolver refuses to return a keypair whose address differs. */
  readonly expectedAddress: string | null;
}

export interface ResolvedKeypair {
  readonly keypair: Ed25519Keypair;
  readonly address: string;
  readonly source: "private_key" | "mnemonic";
}

function deriveFromPrivateKey(role: string, raw: string): Ed25519Keypair {
  const trimmed = raw.trim();
  if (!trimmed.startsWith("suiprivkey")) {
    throw new ConfigError(
      `${role} private key must be a bech32 'suiprivkey1...' string`,
    );
  }
  const { scheme, secretKey } = decodeSuiPrivateKey(trimmed);
  if (scheme !== "ED25519") {
    throw new ConfigError(
      `${role} private key scheme=${scheme}; only ED25519 is supported`,
    );
  }
  return Ed25519Keypair.fromSecretKey(secretKey);
}

function deriveFromMnemonic(
  role: string,
  mnemonic: string,
  path: string,
): Ed25519Keypair {
  try {
    return Ed25519Keypair.deriveKeypair(mnemonic.trim(), path);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new ConfigError(
      `${role} mnemonic derivation failed at path '${path}': ${msg}`,
    );
  }
}

export function resolveKeypair(cfg: KeyRoleConfig): ResolvedKeypair {
  if (!cfg.privateKey && !cfg.mnemonic) {
    throw new ConfigError(
      `${cfg.role} key not configured: set either the private key or mnemonic env var (see CLAUDE.md §"Agent Identity" / §"Multi-role keys")`,
    );
  }

  let keypair: Ed25519Keypair;
  let source: "private_key" | "mnemonic";
  if (cfg.privateKey) {
    keypair = deriveFromPrivateKey(cfg.role, cfg.privateKey);
    source = "private_key";
  } else {
    keypair = deriveFromMnemonic(cfg.role, cfg.mnemonic!, cfg.derivationPath);
    source = "mnemonic";
  }

  const address = keypair.toSuiAddress();
  if (cfg.expectedAddress && cfg.expectedAddress !== address) {
    throw new ConfigError(
      `${cfg.role} address mismatch: derived ${address} but expected ${cfg.expectedAddress}`,
    );
  }
  return { keypair, address, source };
}
