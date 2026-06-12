/**
 * Credit backfill for deposits that were recorded before a coin's rate was set.
 *
 * When the watcher observes a deposit for a coin with no entry in
 * `treasury_credit_rates`, it records the deposit row with `credits_granted = 0`
 * and `rate_num = rate_den = NULL` (audit trail preserved; credits deferred).
 * Once the operator sets a rate via `scripts/treasury-update-rate.ts`, this
 * module retroactively grants credits for those NULL-rate rows.
 *
 * Idempotency contract:
 *   - Only rows with `rate_num IS NULL` are processed (they were recorded when no
 *     rate existed). A row that had a rate at deposit time but rounded to 0 (dust)
 *     has `rate_num` set — those are intentional dust grants and must NOT be
 *     re-processed.
 *   - After processing a row its `rate_num` / `rate_den` are filled in, so a
 *     second run of `backfillCredits` finds no more NULL-rate rows and returns
 *     `processed = 0`.
 *
 * Transaction design:
 *   All rows for the given coin type are processed in a SINGLE database
 *   transaction. This keeps the user-credit bumps and deposit-row updates
 *   atomic with each other. For very large backfills (millions of rows) a
 *   batched approach could be used, but in the anticipated operator workflow
 *   (set rate → immediately backfill) the cohort is small.
 *
 * Usage:
 *   import { backfillCredits } from "../treasury/backfill.ts";
 *   const result = backfillCredits(coinType);
 *   console.log(result);
 */

import { getDb } from "../db/client.ts";
import { canonicalType } from "../sui/lending/typeNorm.ts";
import { getCreditRate } from "./store.ts";
import { creditsForAmount } from "./credits.ts";

export interface BackfillResult {
  /** Canonical coin type that was processed. */
  coinType: string;
  /** Number of deposit rows that were updated (had rate_num IS NULL). */
  processed: number;
  /** Total credits granted across all processed rows. */
  creditsGranted: number;
  /** Rows skipped because they already had a rate set (idempotency guard). */
  skipped: number;
}

interface DepositBackfillRow {
  id: string;
  sui_address: string;
  amount_delta: string;
}

/**
 * Backfill credits for all NULL-rate deposits of the given coin type.
 *
 * Throws a descriptive error (loud failure, no silent fallback) when:
 *   - The coin type has no rate in `treasury_credit_rates` (operator must set
 *     the rate first via `scripts/treasury-update-rate.ts`).
 *
 * Returns a `BackfillResult` summary. Call is safe to repeat — re-running
 * when all rows already have a rate set returns `{ processed: 0, ... }`.
 *
 * @param rawCoinType  Move struct tag in any form; canonicalised internally.
 */
export function backfillCredits(rawCoinType: string): BackfillResult {
  const coinType = canonicalType(rawCoinType);

  // Require the rate to exist before we touch any rows.  Loud failure: if the
  // operator has not set a rate yet there is nothing meaningful we can compute
  // and silently granting 0 credits again would be wrong.
  const rate = getCreditRate(coinType);
  if (rate === null) {
    throw new Error(
      `backfillCredits: no credit rate found for coin type "${coinType}". ` +
      `Set the rate first with scripts/treasury-update-rate.ts, then re-run the backfill.`,
    );
  }

  const db = getDb();

  // Count rows with rate_num IS NOT NULL for the skipped tally (already done).
  const alreadyDoneRow = db
    .query<{ cnt: number }, [string]>(
      `SELECT COUNT(*) AS cnt FROM treasury_deposits
       WHERE coin_type = ? AND rate_num IS NOT NULL`,
    )
    .get(coinType);
  const skipped = alreadyDoneRow?.cnt ?? 0;

  // Fetch all NULL-rate rows for this coin.
  const rows = db
    .query<DepositBackfillRow, [string]>(
      `SELECT id, sui_address, amount_delta
       FROM treasury_deposits
       WHERE coin_type = ? AND rate_num IS NULL`,
    )
    .all(coinType);

  if (rows.length === 0) {
    return { coinType, processed: 0, creditsGranted: 0, skipped };
  }

  let totalCreditsGranted = 0;

  // Process all qualifying rows in one transaction for atomicity.
  db.transaction(() => {
    const updateDeposit = db.prepare(
      `UPDATE treasury_deposits
         SET credits_granted = ?, rate_num = ?, rate_den = ?
         WHERE id = ?`,
    );
    const bumpCredits = db.prepare(
      `UPDATE treasury_users
         SET credits = credits + ?
         WHERE sui_address = ?`,
    );

    for (const row of rows) {
      const amountDelta = BigInt(row.amount_delta);
      const granted = creditsForAmount(amountDelta, rate);

      // Update the deposit row — fill in rate columns regardless of whether
      // granted > 0 so the row is no longer NULL-rate and idempotency holds.
      updateDeposit.run(
        granted,
        rate.rateNum.toString(),
        rate.rateDen.toString(),
        row.id,
      );

      if (granted > 0) {
        bumpCredits.run(granted, row.sui_address);
        totalCreditsGranted += granted;
      }
    }
  })();

  return {
    coinType,
    processed: rows.length,
    creditsGranted: totalCreditsGranted,
    skipped,
  };
}
