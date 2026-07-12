/**
 * Verify that the agent mnemonic derives the address you expect.
 * Tries the common Sui BIP44 derivation paths and reports the match.
 *
 * Privacy contract:
 *   - Never logs the mnemonic.
 *   - Never logs derived private keys or seeds.
 *   - Only logs derivation paths and the target address (which the operator
 *     already supplied via EXPECTED_AGENT_ADDRESS).
 *
 * Usage:
 *   EXPECTED_AGENT_ADDRESS=0x… bun run verify-agent
 *
 * Reads (Bun auto-loads `.env`, so nothing needs exporting by hand):
 *   EXPECTED_AGENT_ADDRESS  the address the mnemonic must derive (required)
 *   AGENT_MNEMONICS         the phrase (preferred name); MNEMONICS is the
 *                           legacy alias and is accepted as a fallback
 *
 * This file lives under `scripts/` per the project convention (see
 * CLAUDE.md §"Verification scripts (convention)"); it is part of the
 * reusable subset whitelisted in .gitignore.
 */

import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";

const SUI_ADDR_RE = /^0x[0-9a-fA-F]{64}$/;

const TARGET_ADDRESS = (process.env.EXPECTED_AGENT_ADDRESS ?? "").trim();

// Sui BIP44 coin type = 784. Common derivation conventions for "address N":
//   - Sui Wallet (Mysten): account index, m/44'/784'/N'/0'/0'
//   - Suiet:               address index, m/44'/784'/0'/0'/N'
//   - Some hardware:       change index,  m/44'/784'/0'/N'/0'
// We probe 0 and 1 for each to cover address 0 (default) and address 1.
const CANDIDATE_PATHS: { label: string; path: string }[] = [
  { label: "default (address 0)",         path: "m/44'/784'/0'/0'/0'" },
  { label: "Sui Wallet style (acct 1)",   path: "m/44'/784'/1'/0'/0'" },
  { label: "Suiet style (addr 1)",         path: "m/44'/784'/0'/0'/1'" },
  { label: "change index 1",               path: "m/44'/784'/0'/1'/0'" },
  { label: "Sui Wallet style (acct 2)",   path: "m/44'/784'/2'/0'/0'" },
  { label: "Suiet style (addr 2)",         path: "m/44'/784'/0'/0'/2'" },
];

function main(): void {
  if (!TARGET_ADDRESS) {
    console.error(
      "FAIL: EXPECTED_AGENT_ADDRESS is not set. Put the address this mnemonic\n" +
        "      should derive in .env — the runtime enforces the same match at startup.",
    );
    process.exit(2);
  }
  if (!SUI_ADDR_RE.test(TARGET_ADDRESS)) {
    console.error(
      `FAIL: EXPECTED_AGENT_ADDRESS is malformed: expected 0x + 64 hex chars, got '${TARGET_ADDRESS}'.`,
    );
    process.exit(2);
  }

  // AGENT_MNEMONICS is the role-explicit name; MNEMONICS is the legacy alias
  // (same precedence as src/sui/keypairs/agent.ts).
  const mnemonic = (process.env.AGENT_MNEMONICS ?? process.env.MNEMONICS ?? "").trim();
  if (!mnemonic) {
    console.error(
      "FAIL: neither AGENT_MNEMONICS nor MNEMONICS is set (Bun should auto-load .env).",
    );
    process.exit(2);
  }

  // Probe each candidate; collect ONLY the matching one's path.
  let matched: { label: string; path: string } | null = null;
  const probed: string[] = [];

  for (const candidate of CANDIDATE_PATHS) {
    let address: string;
    try {
      const kp = Ed25519Keypair.deriveKeypair(mnemonic, candidate.path);
      address = kp.toSuiAddress();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`probe ${candidate.path}: derivation threw — ${msg}`);
      continue;
    }
    probed.push(candidate.path);
    if (address === TARGET_ADDRESS) {
      matched = candidate;
      break;
    }
  }

  console.log("");
  console.log("=".repeat(70));
  console.log("Agent address verification");
  console.log("=".repeat(70));
  console.log(`Target address : ${TARGET_ADDRESS}`);
  console.log(`Paths probed   : ${probed.length}`);

  if (matched) {
    console.log(`Match          : ✅  ${matched.label}`);
    console.log(`Path           : ${matched.path}`);
    console.log("");
    console.log("Recommended next steps:");
    console.log(`  1. Export the matching keypair's bech32 private key and store as`);
    console.log(`     AGENT_PRIVATE_KEY in .env (this script will not print the key).`);
    console.log(`     The simplest path: Sui CLI 'sui keytool import "<mnemonic>" ed25519`);
    console.log(`     --derivation-path "${matched.path}"' then 'sui keytool export <addr>'.`);
    console.log(`  2. Set AGENT_DERIVATION_PATH="${matched.path}" in .env if it differs`);
    console.log(`     from the default. EXPECTED_AGENT_ADDRESS is already set, so`);
    console.log(`     'bun start' will refuse to launch with the wrong key.`);
    console.log("");
    process.exit(0);
  }

  console.log(`Match          : ❌  none of the ${CANDIDATE_PATHS.length} probed paths produced the target`);
  console.log("");
  console.log("If this is unexpected:");
  console.log("  - Confirm AGENT_MNEMONICS is the right phrase (without surrounding quotes).");
  console.log("  - Confirm EXPECTED_AGENT_ADDRESS is correct.");
  console.log("  - The wallet may use a non-standard derivation path; supply it manually.");
  console.log("");
  process.exit(1);
}

main();
