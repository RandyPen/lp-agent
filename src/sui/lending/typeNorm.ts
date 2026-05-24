import { normalizeStructTag } from "@mysten/sui/utils";

/**
 * Canonicalise a Move struct tag for map lookups. The Sui ecosystem freely mixes
 * short-form addresses (`0x2::sui::SUI`) and 32-byte zero-padded long forms
 * (`0x0000…0002::sui::SUI`). `normalizeStructTag` pads to 32 bytes and lowercases.
 * If parsing fails we fall back to a plain lowercase so the call site still has
 * a usable string.
 */
export function canonicalType(t: string): string {
  try {
    return normalizeStructTag(t).toLowerCase();
  } catch {
    return t.trim().toLowerCase();
  }
}
