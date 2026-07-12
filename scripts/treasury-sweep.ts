/**
 * Operator script: sweep deposit addresses, consolidating funds to the treasury
 * master address (or a specified target).
 *
 * Usage:
 *   bun run scripts/treasury-sweep.ts [options]
 *
 * Options:
 *   --to <address>       Destination address (default: treasury master address)
 *   --coin <type>        Move coin type to sweep (default: all known types)
 *   --min <amount>       Minimum atomic-unit balance to sweep (dust floor, default: 1)
 *   --user <sui_address> Sweep only this user's deposit address
 *   --dry-run            Print plan without submitting transactions (shows gasless/gas path per address+coin)
 *   --force-gas          Force the legacy gas-paid path even for gasless-eligible coins (USDC etc.)
 *                        Use when you want to consolidate Coin objects and have SUI on the deposit address.
 *                        Without this flag, USDC and other allowlisted stablecoins use the gasless path
 *                        (no SUI needed). Amounts below the gasless minimum (0.01 whole units) are
 *                        skipped unless --force-gas is set.
 *
 * Examples:
 *   bun run scripts/treasury-sweep.ts --dry-run
 *   bun run scripts/treasury-sweep.ts --coin 0x2::sui::SUI --min 100000000
 *   bun run scripts/treasury-sweep.ts --user 0xabc... --dry-run
 *   bun run scripts/treasury-sweep.ts --to 0xdef... --coin 0x2::sui::SUI
 *   bun run scripts/treasury-sweep.ts --coin usdc --force-gas  # gas-paid USDC sweep
 *
 * Never prints keys, mnemonics, or private key material.
 */

import { loadConfig } from "../src/config.ts";
import { openDb } from "../src/db/client.ts";
import { getSuiClient } from "../src/sui/client.ts";
import { getTreasuryMasterAddress } from "../src/sui/keypairs/treasury.ts";
import { sweepDepositAddress, sweepAll, type OperatorClient, type SweepPath } from "../src/treasury/operator.ts";
import { findUserBySuiAddress } from "../src/treasury/store.ts";

// ---- arg parsing ---------------------------------------------------------

function parseArgs(): {
  to?: string;
  coin?: string;
  min: bigint;
  user?: string;
  dryRun: boolean;
  forceGas: boolean;
} {
  const argv = process.argv.slice(2);
  let to: string | undefined;
  let coin: string | undefined;
  let min = 1n;
  let user: string | undefined;
  let dryRun = false;
  let forceGas = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--dry-run") {
      dryRun = true;
    } else if (arg === "--force-gas") {
      forceGas = true;
    } else if (arg === "--to" && argv[i + 1]) {
      to = argv[++i]!;
    } else if (arg === "--coin" && argv[i + 1]) {
      coin = argv[++i]!;
    } else if (arg === "--min" && argv[i + 1]) {
      const raw = argv[++i]!;
      try {
        min = BigInt(raw);
        if (min < 0n) throw new Error("negative");
      } catch {
        console.error(`ERROR: --min must be a non-negative integer, got '${raw}'`);
        process.exit(1);
      }
    } else if (arg === "--user" && argv[i + 1]) {
      user = argv[++i]!;
    } else {
      console.error(`ERROR: unknown argument '${arg}'`);
      console.error(
        "usage: bun run scripts/treasury-sweep.ts [--to <addr>] [--coin <type>] [--min <atomic>] [--user <addr>] [--dry-run] [--force-gas]",
      );
      process.exit(1);
    }
  }

  return { to, coin, min, user, dryRun, forceGas };
}

// ---- adapt SuiJsonRpcClient to OperatorClient interface ------------------

function adaptClient(raw: ReturnType<typeof getSuiClient>): OperatorClient {
  return {
    async getCoins(args) {
      return raw.getCoins({
        owner: args.owner,
        coinType: args.coinType,
        cursor: args.cursor ?? undefined,
        limit: args.limit ?? undefined,
      });
    },
    async signAndExecuteTransaction(args) {
      // Cast signer: our OperatorKeypair is a subset; the real Ed25519Keypair
      // satisfies Signer at runtime even though TypeScript sees a narrower type here.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return raw.signAndExecuteTransaction({
        transaction: args.transaction,
        signer: args.signer as any,
        options: args.options,
      }) as Promise<{
        digest: string;
        effects?: { status: { status: "success" | "failure"; error?: string } } | null;
      }>;
    },
  };
}

// ---- main ----------------------------------------------------------------

function pathLabel(path: SweepPath | undefined): string {
  if (path === "gasless") return "[gasless]";
  if (path === "gas") return "[gas-paid]";
  return "";
}

async function main(): Promise<void> {
  const { to, coin, min, user, dryRun, forceGas } = parseArgs();

  const cfg = loadConfig();
  if (!cfg.treasury.enabled) {
    console.error("FAIL: TREASURY_ENABLED=false. Enable treasury in .env to run sweeps.");
    process.exit(1);
  }

  openDb(cfg.dbFile);
  const rawClient = getSuiClient();
  const client = adaptClient(rawClient);

  // Resolve recipient.
  const recipient = to ?? getTreasuryMasterAddress();

  console.log("");
  console.log("=".repeat(70));
  console.log(`Treasury Sweep ${dryRun ? "(DRY RUN)" : ""}`);
  console.log("=".repeat(70));
  console.log(`Recipient      : ${recipient}`);
  console.log(`Coin filter    : ${coin ?? "(all known)"}`);
  console.log(`Min amount     : ${min} atomic units`);
  console.log(`Scope          : ${user ?? "all users"}`);
  console.log(`Gas mode       : ${forceGas ? "force-gas (legacy gas-paid path)" : "auto (gasless for eligible stablecoins)"}`);
  console.log("");

  if (user) {
    // Single-user sweep.
    const u = findUserBySuiAddress(user);
    if (!u) {
      console.error(`ERROR: no registered treasury user for ${user}`);
      process.exit(1);
    }
    const coinTypes = coin
      ? [coin]
      : ["0x2::sui::SUI"]; // single-user without --coin defaults to SUI only for safety

    for (const ct of coinTypes) {
      console.log(`Sweeping ${ct} from ${u.depositAddress} (index ${u.derivationIndex})...`);
      const result = await sweepDepositAddress({
        derivationIndex: u.derivationIndex,
        coinType: ct,
        to: recipient,
        client,
        dryRun,
        forceGas,
        initiatedBy: "operator-script",
      });
      if (result.amountSwept === 0n) {
        console.log(`  SKIPPED — zero spendable balance`);
      } else if (result.dryRun) {
        console.log(`  DRY-RUN — would sweep ${result.amountSwept} atomic units ${pathLabel(result.path)}`);
      } else {
        console.log(`  SWEPT   — ${result.amountSwept} atomic units ${pathLabel(result.path)}`);
        console.log(`  digest  : ${result.digest}`);
        console.log(`  op id   : ${result.opId}`);
      }
    }
  } else {
    // Sweep all users.
    const report = await sweepAll({
      coinType: coin,
      to: recipient,
      minAmount: min,
      client,
      dryRun,
      forceGas,
      initiatedBy: "operator-script",
    });

    if (report.swept.length > 0) {
      console.log("Swept:");
      for (const s of report.swept) {
        if (s.dryRun) {
          console.log(
            `  DRY-RUN  | ${s.depositAddress} | ${s.coinType} | ${s.amountSwept} atomic ${pathLabel(s.path)}`,
          );
        } else {
          console.log(
            `  SWEPT    | ${s.depositAddress} | ${s.coinType} | ${s.amountSwept} atomic ${pathLabel(s.path)} | digest: ${s.digest}`,
          );
        }
      }
    }

    if (report.skipped.length > 0) {
      console.log("\nSkipped:");
      for (const sk of report.skipped) {
        const pathNote = sk.path ? ` ${pathLabel(sk.path)}` : "";
        console.log(`  SKIPPED  | ${sk.depositAddress} | ${sk.reason}${pathNote}`);
      }
    }

    if (report.errors.length > 0) {
      console.log("\nErrors:");
      for (const e of report.errors) {
        console.log(`  ERROR    | ${e.depositAddress} | ${e.error}`);
      }
    }

    console.log("");
    console.log(
      `Summary: ${report.swept.length} swept, ${report.skipped.length} skipped, ${report.errors.length} errors`,
    );

    if (report.errors.length > 0) {
      process.exit(1);
    }
  }
}

main().catch((err: unknown) => {
  console.error("FATAL:", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
