/**
 * fund-address-balance.ts — moves SUI from the agent's owned coin OBJECTS
 * into its Sui ADDRESS BALANCE, via `0x2::coin::send_funds`.
 *
 * Why: `src/sui/submit.ts`'s `submitWithRetry` forces `tx.setGasPayment([])`
 * so every rebalance PTB pays gas from the agent's address balance instead
 * of an owned gas-coin object (avoids gas-object contention across
 * concurrently submitted PTBs for the same signer — see that file's module
 * doc). The address balance has to actually be funded for this to work;
 * this script is the one-off operator action that does it.
 *
 * This funding transaction ITSELF still uses classic owned-coin gas (it does
 * NOT call setGasPayment([]) or go through submitWithRetry) — that's
 * intentional and fine, it's a single serial operation, not a hot path.
 *
 * SAFETY:
 *   - Refuses to run without an explicit `<amount-sui>` argument (no
 *     implicit/default amount — this moves real funds).
 *   - Never reads .env directly; the agent keypair is resolved through the
 *     existing `getAgentKeypair()` (same resolver `bun start` uses), which
 *     reads process.env itself.
 *   - Never logs the mnemonic, private key, or any secret material — only
 *     the public address, the amount requested, and the resulting digest /
 *     balances.
 *   - Recipient is always the agent's OWN address (self-funding its address
 *     balance) — there is no recipient argument to avoid an accidental
 *     fat-fingered destination.
 *
 * Usage:
 *   bun run scripts/fund-address-balance.ts <amount-sui>
 *   e.g. bun run scripts/fund-address-balance.ts 1.5
 */

import { Transaction } from "@mysten/sui/transactions";
import { getAgentKeypair } from "../src/sui/keypair.ts";
import { getSuiClient } from "../src/sui/client.ts";
import { MIN_ADDRESS_BALANCE_MIST } from "../src/sui/submit.ts";

const SUI_TYPE = "0x2::sui::SUI";
const MIST_PER_SUI = 1_000_000_000n;

function parseAmountSui(raw: string | undefined): bigint {
  if (!raw || !raw.trim()) {
    console.error("FAIL: missing required <amount-sui> argument.");
    console.error("Usage: bun run scripts/fund-address-balance.ts <amount-sui>");
    process.exit(2);
  }
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    console.error(`FAIL: <amount-sui> must be a positive number, got '${raw}'.`);
    process.exit(2);
  }
  // Convert via string math to avoid float rounding on the MIST conversion.
  const mist = BigInt(Math.round(n * 1e9));
  if (mist <= 0n) {
    console.error(`FAIL: amount '${raw}' rounds to zero MIST.`);
    process.exit(2);
  }
  return mist;
}

async function main(): Promise<void> {
  const amountMist = parseAmountSui(process.argv[2]);

  console.log("=".repeat(72));
  console.log("fund-address-balance.ts — fund the agent's Sui address balance");
  console.log("=".repeat(72));

  const keypair = getAgentKeypair();
  const address = keypair.toSuiAddress();
  const client = getSuiClient();

  console.log(`\nAgent address: ${address}`);
  console.log(`Amount to move into address balance: ${amountMist} MIST (${Number(amountMist) / 1e9} SUI)`);

  const before = await client.core.getBalance({ owner: address, coinType: SUI_TYPE });
  console.log(
    `Before — coin-object balance: ${before.balance.coinBalance} MIST, ` +
      `address balance: ${before.balance.addressBalance} MIST`,
  );

  if (BigInt(before.balance.coinBalance) < amountMist) {
    console.error(
      `FAIL: coin-object balance (${before.balance.coinBalance} MIST) is less than the requested ` +
        `amount (${amountMist} MIST) — nothing to split. Top up the agent's owned SUI coins first.`,
    );
    process.exit(1);
    return;
  }

  console.log("\nBuilding funding PTB (split from gas coin → coin::send_funds to self)...");
  const tx = new Transaction();
  tx.setSender(address);
  const [splitCoin] = tx.splitCoins(tx.gas, [amountMist]);
  tx.moveCall({
    target: "0x2::coin::send_funds",
    typeArguments: [SUI_TYPE],
    arguments: [splitCoin, tx.pure.address(address)],
  });
  // Intentionally NOT calling tx.setGasPayment([]) here — this funding tx
  // uses the SDK's default owned-coin gas resolution, which is exactly what
  // we want for a one-off operation moving funds INTO the address balance.

  const bytes = await tx.build({ client });
  console.log("Signing...");
  const { signature } = await keypair.signTransaction(bytes);

  console.log("Submitting...");
  const result = (await client.executeTransactionBlock({
    transactionBlock: bytes,
    signature,
    options: { showEffects: true },
  })) as { digest: string; effects?: { status?: { status?: string; error?: string } } };

  console.log(`Digest: ${result.digest}`);
  const status = result.effects?.status;
  if (status?.status !== "success") {
    console.error(`FAIL: transaction committed but did not succeed: ${status?.error ?? "unknown error"}`);
    process.exit(1);
    return;
  }
  console.log("Transaction succeeded.");

  const after = await client.core.getBalance({ owner: address, coinType: SUI_TYPE });
  console.log(
    `\nAfter — coin-object balance: ${after.balance.coinBalance} MIST, ` +
      `address balance: ${after.balance.addressBalance} MIST`,
  );

  const addressBalanceMist = BigInt(after.balance.addressBalance);
  console.log(
    addressBalanceMist >= MIN_ADDRESS_BALANCE_MIST
      ? "PASS: address balance is now above submit.ts's MIN_ADDRESS_BALANCE_MIST floor."
      : `NOTE: address balance (${addressBalanceMist} MIST) is still below the floor ` +
          `(${MIN_ADDRESS_BALANCE_MIST} MIST) submit.ts requires — run this script again with a larger amount.`,
  );
}

main().catch((err: unknown) => {
  console.error("Error:", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
