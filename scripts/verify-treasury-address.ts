/**
 * Verify that the TREASURY_MNEMONICS env var derives the expected Sui treasury
 * master address.
 *
 * Mirrors `scripts/verify-agent-address.ts`. Tries the common Sui BIP44
 * derivation paths and reports the match. Optionally accepts the target
 * address via `--expected=0x…` (default: read from EXPECTED_TREASURY_MASTER_ADDRESS).
 *
 * Privacy contract:
 *   - Never logs the mnemonic.
 *   - Never logs derived private keys or seeds.
 *   - Only logs derivation paths and the matching address (which the operator
 *     supplied via env or --expected).
 *
 * Usage:
 *   bun run scripts/verify-treasury-address.ts
 *   bun run scripts/verify-treasury-address.ts --expected=0xabc...
 *
 * Bun auto-loads `.env`, so TREASURY_MNEMONICS does not need to be exported
 * manually.
 *
 * This file lives under `scripts/` per the project convention (see
 * CLAUDE.md §"Verification scripts (convention)"); it is part of the
 * reusable subset whitelisted in .gitignore.
 */

import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";

const CANDIDATE_PATHS: { label: string; path: string }[] = [
  { label: "default master (acct 0, addr 0)", path: "m/44'/784'/0'/0'/0'" },
  { label: "Sui Wallet style (acct 1)",       path: "m/44'/784'/1'/0'/0'" },
  { label: "Suiet style (addr 1)",             path: "m/44'/784'/0'/0'/1'" },
  { label: "change index 1",                   path: "m/44'/784'/0'/1'/0'" },
  { label: "Sui Wallet style (acct 2)",       path: "m/44'/784'/2'/0'/0'" },
  { label: "Suiet style (addr 2)",             path: "m/44'/784'/0'/0'/2'" },
];

function parseExpected(argv: string[]): string | null {
  for (const a of argv) {
    if (a.startsWith("--expected=")) return a.slice("--expected=".length).trim();
  }
  return process.env.EXPECTED_TREASURY_MASTER_ADDRESS?.trim() ?? null;
}

function main(): void {
  const mnemonic = (process.env.TREASURY_MNEMONICS ?? "").trim();
  if (!mnemonic) {
    console.error("FAIL: TREASURY_MNEMONICS env var is not set (Bun should auto-load .env).");
    process.exit(2);
  }

  const expected = parseExpected(process.argv.slice(2));
  if (!expected) {
    console.error(
      "FAIL: target address not provided. Set EXPECTED_TREASURY_MASTER_ADDRESS in .env or pass --expected=0x...",
    );
    process.exit(2);
  }

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
    if (address === expected) {
      matched = candidate;
      break;
    }
  }

  console.log("");
  console.log("=".repeat(70));
  console.log("Treasury master address verification");
  console.log("=".repeat(70));
  console.log(`Target address : ${expected}`);
  console.log(`Paths probed   : ${probed.length}`);

  if (matched) {
    console.log(`Match          : ✅  ${matched.label}`);
    console.log(`Path           : ${matched.path}`);
    console.log("");
    console.log("Recommended next steps:");
    console.log(
      `  1. Set TREASURY_MASTER_DERIVATION_PATH=${matched.path} in .env (if not default).`,
    );
    console.log(
      `  2. Set EXPECTED_TREASURY_MASTER_ADDRESS=${expected} in .env so 'bun start' refuses to launch with the wrong key.`,
    );
    console.log("");
    process.exit(0);
  }

  console.log(`Match          : ❌  none of the ${CANDIDATE_PATHS.length} probed paths produced the target`);
  console.log("");
  console.log("If this is unexpected:");
  console.log("  - Confirm TREASURY_MNEMONICS is the right phrase (no surrounding quotes).");
  console.log("  - Confirm the target address is correct.");
  console.log("  - The wallet may use a non-standard derivation path; supply it manually.");
  console.log("");
  process.exit(1);
}

main();
