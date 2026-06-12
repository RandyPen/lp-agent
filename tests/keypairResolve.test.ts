/**
 * Tests for the pure role-keypair resolver (src/sui/keypairs/resolve.ts).
 *
 * No env vars, no singletons, no caching — just a function. Uses the public
 * BIP-39 test vector ("abandon × 11 + about") so no real mnemonic is in
 * the test suite.
 */

import { describe, it, expect } from "bun:test";
import {
  resolveKeypair,
  type KeyRoleConfig,
} from "../src/sui/keypairs/resolve.ts";

// BIP-39 spec test vector: https://github.com/bitcoin/bips/blob/master/bip-0039.mediawiki
const TEST_MNEMONIC =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

// Snapshot-pinned: address derived from TEST_MNEMONIC at m/44'/784'/1'/0'/0'.
const ADDR_PATH1 =
  "0x082d099250999ab8450a9ef3a962edf9e2449e1045be32ba5a0f2c6117ff7167";
const SUIPRIVKEY_PATH1 =
  "suiprivkey1qpexz0tqjxle6ze2nv5w3gvtrhsa2fl6vz4jv4k9jp0fyscunzu3s6y6r8n";

function cfg(overrides: Partial<KeyRoleConfig> = {}): KeyRoleConfig {
  return {
    role: "agent",
    privateKey: null,
    mnemonic: null,
    derivationPath: "m/44'/784'/1'/0'/0'",
    expectedAddress: null,
    ...overrides,
  };
}

describe("resolveKeypair — private key source", () => {
  it("decodes a bech32 suiprivkey1 string", () => {
    const r = resolveKeypair(cfg({ privateKey: SUIPRIVKEY_PATH1 }));
    expect(r.address).toBe(ADDR_PATH1);
    expect(r.source).toBe("private_key");
  });

  it("rejects a non-bech32 private key", () => {
    expect(() => resolveKeypair(cfg({ privateKey: "deadbeef" }))).toThrow(
      /suiprivkey/,
    );
  });

  it("error messages include the role name", () => {
    expect(() =>
      resolveKeypair(cfg({ role: "treasury", privateKey: "deadbeef" })),
    ).toThrow(/treasury/);
  });
});

describe("resolveKeypair — mnemonic source", () => {
  it("derives at the configured path", () => {
    const r = resolveKeypair(cfg({ mnemonic: TEST_MNEMONIC }));
    expect(r.address).toBe(ADDR_PATH1);
    expect(r.source).toBe("mnemonic");
  });

  it("different paths yield different addresses for the same mnemonic", () => {
    const addr1 = resolveKeypair(cfg({ mnemonic: TEST_MNEMONIC })).address;
    const addr0 = resolveKeypair(
      cfg({ mnemonic: TEST_MNEMONIC, derivationPath: "m/44'/784'/0'/0'/0'" }),
    ).address;
    expect(addr1).not.toBe(addr0);
  });

  it("invalid mnemonic throws with role + path in message", () => {
    expect(() =>
      resolveKeypair(cfg({ role: "treasury", mnemonic: "not a real mnemonic" })),
    ).toThrow(/treasury.*derivation/);
  });
});

describe("resolveKeypair — precedence", () => {
  it("private key wins when both sources are set", () => {
    // Set a mnemonic that would derive to a *different* address, then the
    // resolver must still use the explicit private key.
    const r = resolveKeypair(
      cfg({
        privateKey: SUIPRIVKEY_PATH1,
        // Same mnemonic, but path 0 → different address. If the resolver
        // accidentally used the mnemonic, addr would be ADDR_PATH0.
        mnemonic: TEST_MNEMONIC,
        derivationPath: "m/44'/784'/0'/0'/0'",
      }),
    );
    expect(r.address).toBe(ADDR_PATH1);
    expect(r.source).toBe("private_key");
  });
});

describe("resolveKeypair — expected address guard", () => {
  it("passes when expected matches", () => {
    const r = resolveKeypair(
      cfg({ mnemonic: TEST_MNEMONIC, expectedAddress: ADDR_PATH1 }),
    );
    expect(r.address).toBe(ADDR_PATH1);
  });

  it("throws on mismatch with the derived address surfaced", () => {
    expect(() =>
      resolveKeypair(
        cfg({ mnemonic: TEST_MNEMONIC, expectedAddress: "0xdeadbeef" }),
      ),
    ).toThrow(/address mismatch.*0xdeadbeef/);
  });

  it("guard applies regardless of source", () => {
    expect(() =>
      resolveKeypair(
        cfg({ privateKey: SUIPRIVKEY_PATH1, expectedAddress: "0xdeadbeef" }),
      ),
    ).toThrow(/address mismatch/);
  });
});

describe("resolveKeypair — missing config", () => {
  it("throws when neither source is set", () => {
    expect(() => resolveKeypair(cfg())).toThrow(/not configured/);
  });

  it("missing-config error mentions the role", () => {
    expect(() => resolveKeypair(cfg({ role: "treasury" }))).toThrow(
      /treasury/,
    );
  });
});

describe("resolveKeypair — role isolation contract", () => {
  it("does not cache — repeated calls always recompute", () => {
    const r1 = resolveKeypair(cfg({ privateKey: SUIPRIVKEY_PATH1 }));
    const r2 = resolveKeypair(cfg({ privateKey: SUIPRIVKEY_PATH1 }));
    // Same address but different object identity — resolver is pure.
    expect(r1.address).toBe(r2.address);
    expect(r1.keypair).not.toBe(r2.keypair);
  });
});
