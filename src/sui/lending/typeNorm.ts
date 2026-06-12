import { normalizeStructTag } from "@mysten/sui/utils";

/**
 * Canonicalise a Move struct tag for **map/DB lookups and PTB type arguments**.
 *
 * The Sui ecosystem freely mixes short-form addresses (`0x2::sui::SUI`) and
 * 32-byte zero-padded long forms (`0x0000…0002::sui::SUI`).
 * `normalizeStructTag` pads ONLY the address component to 32 bytes (lowercase
 * hex) while preserving the module name and struct name exactly as given.
 *
 * Move identifiers are case-sensitive. Coin struct names are protocol-
 * guaranteed to be UPPERCASE (One-Time Witness rule: `is_one_time_witness`
 * enforces struct name == uppercase(module name)). Lowercasing the full tag
 * produces an incorrect key — `::usdc::usdc` is NOT the same type as
 * `::usdc::USDC`, and the Sui validator's gasless allowlist enforces this.
 *
 * Canonical form: `0x<64 lowercase hex>::<module>::<Struct>` (addresses
 * normalised, module/struct casing preserved). All comparisons must ensure
 * both sides pass through `canonicalType`.
 *
 * If parsing fails the input is returned trimmed (casing preserved) so the
 * call site receives a deterministic key without silently discarding data.
 */
export function canonicalType(t: string): string {
  try {
    return normalizeStructTag(t);
  } catch {
    return t.trim();
  }
}

/**
 * @deprecated Use `canonicalType` directly. The canonical/PTB distinction no
 * longer exists now that `canonicalType` is case-preserving.
 */
export const ptbType = canonicalType;
