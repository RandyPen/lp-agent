/**
 * Tests for the TOFU identity-file helper. We exercise the helper in isolation
 * (no env, no DB) so behaviour is decoupled from the agent/treasury singletons.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  defaultIdentityFilePath,
  identityFilesDisabled,
  loadOrPersistIdentity,
  type IdentityRecord,
} from "../src/sui/keypairs/identityFile.ts";

const ADDR_A = "0x" + "a".repeat(64);
const ADDR_B = "0x" + "b".repeat(64);

let tmpDir = "";

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "identityfile-"));
});

afterEach(() => {
  if (tmpDir) {
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

describe("loadOrPersistIdentity — first-use", () => {
  it("writes the file and returns created=true", () => {
    const filePath = join(tmpDir, "agent.identity.json");
    const result = loadOrPersistIdentity({
      role: "agent",
      derivedAddress: ADDR_A,
      source: "mnemonic",
      derivationPath: "m/44'/784'/1'/0'/0'",
      filePath,
    });
    expect(result.created).toBe(true);
    expect(result.identity.address).toBe(ADDR_A);
    expect(result.identity.role).toBe("agent");
    expect(result.identity.source).toBe("mnemonic");
    expect(result.identity.derivationPath).toBe("m/44'/784'/1'/0'/0'");
    expect(result.identity.firstSeenMs).toBeGreaterThan(0);
    expect(result.identity.lastSeenMs).toBe(result.identity.firstSeenMs);

    // Round-trip the JSON.
    const raw = readFileSync(filePath, "utf-8");
    const parsed = JSON.parse(raw) as IdentityRecord;
    expect(parsed.address).toBe(ADDR_A);
  });

  it("creates parent dir recursively", () => {
    const filePath = join(tmpDir, "nested", "deeper", "agent.identity.json");
    const result = loadOrPersistIdentity({
      role: "agent",
      derivedAddress: ADDR_A,
      source: "private_key",
      derivationPath: null,
      filePath,
    });
    expect(result.created).toBe(true);
    const raw = readFileSync(filePath, "utf-8");
    expect(JSON.parse(raw).address).toBe(ADDR_A);
  });
});

describe("loadOrPersistIdentity — subsequent runs", () => {
  it("returns created=false and refreshes lastSeenMs on match", async () => {
    const filePath = join(tmpDir, "agent.identity.json");
    const first = loadOrPersistIdentity({
      role: "agent",
      derivedAddress: ADDR_A,
      source: "mnemonic",
      derivationPath: "m/44'/784'/1'/0'/0'",
      filePath,
    });
    // Sleep a tick so the timestamp can advance.
    await new Promise((r) => setTimeout(r, 5));

    const second = loadOrPersistIdentity({
      role: "agent",
      derivedAddress: ADDR_A,
      source: "mnemonic",
      derivationPath: "m/44'/784'/1'/0'/0'",
      filePath,
    });
    expect(second.created).toBe(false);
    expect(second.identity.address).toBe(ADDR_A);
    expect(second.identity.firstSeenMs).toBe(first.identity.firstSeenMs);
    expect(second.identity.lastSeenMs).toBeGreaterThanOrEqual(first.identity.lastSeenMs);
  });

  it("throws on address mismatch with operator-friendly message", () => {
    const filePath = join(tmpDir, "agent.identity.json");
    loadOrPersistIdentity({
      role: "agent",
      derivedAddress: ADDR_A,
      source: "mnemonic",
      derivationPath: null,
      filePath,
    });
    expect(() =>
      loadOrPersistIdentity({
        role: "agent",
        derivedAddress: ADDR_B,
        source: "mnemonic",
        derivationPath: null,
        filePath,
      }),
    ).toThrow(/identity mismatch/i);
  });

  it("throws when existing file is corrupt JSON", () => {
    const filePath = join(tmpDir, "agent.identity.json");
    writeFileSync(filePath, "this is not json", "utf-8");
    expect(() =>
      loadOrPersistIdentity({
        role: "agent",
        derivedAddress: ADDR_A,
        source: "mnemonic",
        derivationPath: null,
        filePath,
      }),
    ).toThrow(/invalid JSON/i);
  });

  it("throws when existing file is missing 'address' field", () => {
    const filePath = join(tmpDir, "agent.identity.json");
    writeFileSync(filePath, JSON.stringify({ role: "agent" }), "utf-8");
    expect(() =>
      loadOrPersistIdentity({
        role: "agent",
        derivedAddress: ADDR_A,
        source: "mnemonic",
        derivationPath: null,
        filePath,
      }),
    ).toThrow(/missing the 'address' field/);
  });
});

describe("defaultIdentityFilePath", () => {
  it("sits next to the DB file", () => {
    expect(defaultIdentityFilePath("agent", "./data/app.db")).toBe(
      "data/agent.identity.json",
    );
    expect(defaultIdentityFilePath("treasury", "/var/lm/state.db")).toBe(
      "/var/lm/treasury.identity.json",
    );
  });
});

describe("identityFilesDisabled", () => {
  const ORIG = process.env.IDENTITY_FILES_DISABLED;
  afterEach(() => {
    if (ORIG === undefined) delete process.env.IDENTITY_FILES_DISABLED;
    else process.env.IDENTITY_FILES_DISABLED = ORIG;
  });

  it("recognises common truthy values", () => {
    for (const v of ["true", "TRUE", "1", "yes", "Yes"]) {
      process.env.IDENTITY_FILES_DISABLED = v;
      expect(identityFilesDisabled()).toBe(true);
    }
  });

  it("treats everything else as off", () => {
    for (const v of ["", "false", "0", "no", "off"]) {
      process.env.IDENTITY_FILES_DISABLED = v;
      expect(identityFilesDisabled()).toBe(false);
    }
    delete process.env.IDENTITY_FILES_DISABLED;
    expect(identityFilesDisabled()).toBe(false);
  });
});
