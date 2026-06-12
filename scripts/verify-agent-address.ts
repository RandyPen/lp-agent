/**
 * Verify that the MNEMONICS env var derives the expected Sui agent address.
 * Tries the common Sui BIP44 derivation paths and reports the match.
 *
 * Privacy contract:
 *   - Never logs the mnemonic.
 *   - Never logs derived private keys or seeds.
 *   - Only logs derivation paths and a single matching address (which the
 *     operator already supplied — see TARGET_ADDRESS below).
 *
 * Usage:
 *   bun run scripts/verify-agent-address.ts
 *
 * Bun auto-loads `.env`, so MNEMONICS does not need to be exported manually.
 *
 * This file lives under `scripts/` per the project convention (see
 * CLAUDE.md §"Verification scripts (convention)"); it is part of the
 * reusable subset whitelisted in .gitignore.
 */

import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";

const TARGET_ADDRESS =
  "0xf3f8feeba6b94376511dfc38d51ea3f5d2f3d1b70725fa0f50e5253a66d0d0b9";

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
  const mnemonic = (process.env.MNEMONICS ?? "").trim();
  if (!mnemonic) {
    console.error("FAIL: MNEMONICS env var is not set (Bun should auto-load .env).");
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
    console.log(`  2. Set EXPECTED_AGENT_ADDRESS=${TARGET_ADDRESS}`);
    console.log(`     in .env so 'bun start' refuses to launch with the wrong key.`);
    console.log("");
    process.exit(0);
  }

  console.log(`Match          : ❌  none of the ${CANDIDATE_PATHS.length} probed paths produced the target`);
  console.log("");
  console.log("If this is unexpected:");
  console.log("  - Confirm MNEMONICS is the right phrase (without surrounding quotes).");
  console.log("  - Confirm the target address you provided is correct.");
  console.log("  - The wallet may use a non-standard derivation path; supply it manually.");
  console.log("");
  process.exit(1);
}

main();
