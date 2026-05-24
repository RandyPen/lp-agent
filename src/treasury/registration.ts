/**
 * Treasury user registration. Single entry point — `registerUser(suiAddress)`
 * runs the atomic store transaction in `registerUserTx` and uses the treasury
 * keypair singleton (`deriveUserDepositAddress`) to compute the derived
 * deposit address for the chosen derivation index.
 *
 * Idempotent: re-registering an already-known sui_address returns the
 * existing user record (same derivation_index, same deposit_address).
 */

import { log } from "../lib/logger.ts";
import { deriveUserDepositAddress } from "../sui/keypairs/treasury.ts";
import { registerUserTx } from "./store.ts";
import type { TreasuryUser } from "./types.ts";

export function registerUser(suiAddress: string): TreasuryUser {
  if (!/^0x[0-9a-fA-F]{1,64}$/.test(suiAddress.trim())) {
    throw new Error(`registerUser: invalid sui address '${suiAddress}'`);
  }
  const user = registerUserTx(suiAddress.trim(), (index) =>
    deriveUserDepositAddress(index),
  );
  log.info("treasury: user registered (or already existed)", {
    suiAddress: user.suiAddress,
    derivationIndex: user.derivationIndex,
    depositAddress: user.depositAddress,
    credits: user.credits,
  });
  return user;
}
