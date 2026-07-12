/**
 * Operator script: refund a registered treasury user — transfer all on-chain
 * balances from their deposit address back to their main wallet and zero their
 * off-chain credits.
 *
 * A DRY-RUN is the default. Add `--confirm` to execute the actual transfer.
 * This protects operators from accidental invocations.
 *
 * The dry-run output shows the routing path (gasless/gas-paid) per coin type.
 * Gasless-eligible stablecoins (USDC etc.) are routed through the gasless path
 * by default — the deposit address does not need SUI for gas in that case.
 *
 * Usage:
 *   bun run scripts/treasury-refund.ts --user <sui_address>
 *   bun run scripts/treasury-refund.ts --user <sui_address> --confirm
 *   bun run scripts/treasury-refund.ts --user <sui_address> --confirm --force-gas
 *
 * Options:
 *   --user <sui_address>   Required: the user's main Sui wallet address
 *   --confirm              Execute the refund (default: dry-run, print plan only)
 *   --force-gas            Force the legacy gas-paid path for all coins (requires SUI on deposit address)
 *
 * Never prints keys, mnemonics, or private key material.
 */

import { loadConfig } from "../src/config.ts";
import { openDb } from "../src/db/client.ts";
import { getSuiClient } from "../src/sui/client.ts";
import { refundUser, type OperatorClient } from "../src/treasury/operator.ts";
import { findUserBySuiAddress } from "../src/treasury/store.ts";

// ---- arg parsing ---------------------------------------------------------

function parseArgs(): { user: string; confirm: boolean; forceGas: boolean } {
  const argv = process.argv.slice(2);
  let user: string | undefined;
  let confirm = false;
  let forceGas = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--confirm") {
      confirm = true;
    } else if (arg === "--force-gas") {
      forceGas = true;
    } else if (arg === "--user" && argv[i + 1]) {
      user = argv[++i]!;
    } else {
      console.error(`ERROR: unknown argument '${arg}'`);
      console.error(
        "usage: bun run scripts/treasury-refund.ts --user <sui_address> [--confirm] [--force-gas]",
      );
      process.exit(1);
    }
  }

  if (!user) {
    console.error("ERROR: --user <sui_address> is required");
    console.error(
      "usage: bun run scripts/treasury-refund.ts --user <sui_address> [--confirm] [--force-gas]",
    );
    process.exit(1);
  }

  return { user, confirm, forceGas };
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

async function main(): Promise<void> {
  const { user: suiAddress, confirm, forceGas } = parseArgs();
  const dryRun = !confirm;

  const cfg = loadConfig();
  if (!cfg.treasury.enabled) {
    console.error("FAIL: TREASURY_ENABLED=false. Enable treasury in .env to run refunds.");
    process.exit(1);
  }

  openDb(cfg.dbFile);

  // Show user info before proceeding.
  const u = findUserBySuiAddress(suiAddress);
  if (!u) {
    console.error(`ERROR: no registered treasury user for ${suiAddress}`);
    process.exit(1);
  }

  console.log("");
  console.log("=".repeat(70));
  console.log(`Treasury Refund ${dryRun ? "(DRY RUN — add --confirm to execute)" : "(LIVE)"}`);
  console.log("=".repeat(70));
  console.log(`User address     : ${u.suiAddress}`);
  console.log(`Deposit address  : ${u.depositAddress}`);
  console.log(`Derivation index : ${u.derivationIndex}`);
  console.log(`Credits before   : ${u.credits}`);
  console.log(`Gas mode         : ${forceGas ? "force-gas (legacy gas-paid path)" : "auto (gasless for eligible stablecoins)"}`);
  console.log("");

  if (!confirm) {
    console.log("DRY-RUN mode: no on-chain transactions will be submitted.");
    console.log("The following would happen:");
    console.log("");
  }

  const rawClient = getSuiClient();
  const client = adaptClient(rawClient);

  const result = await refundUser({
    suiAddress,
    client,
    dryRun,
    forceGas,
    initiatedBy: "operator-script",
  });

  function pathLabel(path: typeof result.transfers[0]["path"] | undefined): string {
    if (path === "gasless") return "[gasless]";
    if (path === "gas") return "[gas-paid]";
    return "";
  }

  if (result.transfers.length === 0) {
    console.log("No on-chain balances to transfer.");
  } else {
    console.log("Transfers:");
    for (const t of result.transfers) {
      if (dryRun) {
        console.log(
          `  DRY-RUN  | ${t.coinType} | ${t.amount} atomic → ${result.suiAddress} ${pathLabel(t.path)}`,
        );
      } else {
        console.log(
          `  SENT     | ${t.coinType} | ${t.amount} atomic ${pathLabel(t.path)} | digest: ${t.digest}`,
        );
        console.log(`           | op id: ${t.opId}`);
      }
    }
  }

  console.log("");
  console.log(`Credits before : ${result.creditsBefore}`);
  console.log(`Credits after  : ${result.creditsAfter}`);

  if (dryRun) {
    console.log("");
    console.log("To execute this refund, add --confirm:");
    console.log(`  bun run scripts/treasury-refund.ts --user ${suiAddress} --confirm`);
  } else {
    console.log("");
    console.log("Refund complete.");
  }
}

main().catch((err: unknown) => {
  console.error("FATAL:", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
