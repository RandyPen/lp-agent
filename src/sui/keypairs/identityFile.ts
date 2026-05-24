/**
 * Trust-On-First-Use (TOFU) identity persistence for role keypairs.
 *
 * On first run the role's derived address is written to a local JSON file
 * (default `<dbDir>/<role>.identity.json`). On every subsequent run the file
 * is read and compared against the freshly-derived address; mismatch aborts
 * startup with a ConfigError.
 *
 * This is **defense in depth** on top of `EXPECTED_*_ADDRESS` env vars:
 *   - When the env guard is set, both checks run (env first, then file).
 *   - When the env guard is unset, the local file is the only safety net.
 *     Useful for operators who set up the mnemonic once and don't want to
 *     embed the expected address in `.env`.
 *
 * Privacy contract: the file contains only the public Sui address, role
 * label, the source kind (`mnemonic` | `private_key`), the derivation path
 * (already public if derived from the BIP-39 wordlist), and two timestamps.
 * It never contains seed material.
 *
 * To rotate a role's key intentionally: delete the file and restart.
 * To audit identity history: read the file (`firstSeenMs` / `lastSeenMs`).
 */

import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { ConfigError } from "../../lib/errors.ts";

export interface IdentityRecord {
  role: string;
  address: string;
  source: "private_key" | "mnemonic";
  derivationPath: string | null;
  firstSeenMs: number;
  lastSeenMs: number;
}

export interface LoadOrPersistArgs {
  role: string;
  derivedAddress: string;
  source: "private_key" | "mnemonic";
  derivationPath: string | null;
  filePath: string;
}

export interface LoadOrPersistResult {
  identity: IdentityRecord;
  /** True only when this call wrote the file for the first time. */
  created: boolean;
  filePath: string;
}

/**
 * Persist on first use, verify on subsequent runs.
 *
 *   - If file exists: read, check `address === derivedAddress`, throw on
 *     mismatch, otherwise refresh `lastSeenMs` (best-effort) and return.
 *   - If file does not exist: create parent dir, write the record, return
 *     `created=true`.
 *
 * Throws on:
 *   - filesystem read failure (existing file unreadable)
 *   - invalid JSON in existing file
 *   - address mismatch
 *   - filesystem write failure when creating new file
 */
export function loadOrPersistIdentity(args: LoadOrPersistArgs): LoadOrPersistResult {
  const { role, derivedAddress, source, derivationPath, filePath } = args;

  if (existsSync(filePath)) {
    let raw: string;
    try {
      raw = readFileSync(filePath, "utf-8");
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new ConfigError(`${role} identity file read failed (${filePath}): ${msg}`);
    }
    let parsed: IdentityRecord;
    try {
      parsed = JSON.parse(raw) as IdentityRecord;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new ConfigError(
        `${role} identity file ${filePath} contains invalid JSON: ${msg} — delete the file if you intentionally rotated keys`,
      );
    }
    if (typeof parsed.address !== "string" || parsed.address.length === 0) {
      throw new ConfigError(
        `${role} identity file ${filePath} is missing the 'address' field — delete and re-run if corrupted`,
      );
    }
    if (parsed.address !== derivedAddress) {
      throw new ConfigError(
        `${role} identity mismatch: derived ${derivedAddress} but local identity file (${filePath}) says ${parsed.address}. ` +
          `Either restore the original key, or delete the file if you intentionally rotated keys.`,
      );
    }
    // Touch lastSeenMs (best-effort).
    parsed.lastSeenMs = Date.now();
    try {
      writeFileSync(filePath, JSON.stringify(parsed, null, 2), "utf-8");
    } catch {
      // read-only filesystem etc. — identity has already been verified, ignore.
    }
    return { identity: parsed, created: false, filePath };
  }

  const nowMs = Date.now();
  const record: IdentityRecord = {
    role,
    address: derivedAddress,
    source,
    derivationPath,
    firstSeenMs: nowMs,
    lastSeenMs: nowMs,
  };
  try {
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, JSON.stringify(record, null, 2), "utf-8");
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new ConfigError(`${role} identity file write failed at ${filePath}: ${msg}`);
  }
  return { identity: record, created: true, filePath };
}

/**
 * Default identity file path for a role, sitting next to the SQLite DB
 * (e.g. `./data/agent.identity.json` when `DB_FILE=./data/app.db`).
 */
export function defaultIdentityFilePath(role: string, dbFilePath: string): string {
  return join(dirname(dbFilePath), `${role}.identity.json`);
}

/**
 * Check the runtime kill-switch.
 *
 * `IDENTITY_FILES_DISABLED=true` skips both persistence and verification
 * entirely. Intended for tests, ephemeral dev loops, and operators who
 * insist on env-only guards.
 */
export function identityFilesDisabled(): boolean {
  const v = process.env.IDENTITY_FILES_DISABLED?.trim().toLowerCase() ?? "";
  return v === "true" || v === "1" || v === "yes";
}
