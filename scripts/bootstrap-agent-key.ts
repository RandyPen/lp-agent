/**
 * Generate a fresh Ed25519 keypair for use as the liquidity manager agent key.
 * Prints the bech32 private key and the corresponding Sui address once.
 * Store the private key in .env as AGENT_PRIVATE_KEY immediately after running this.
 */

import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";

const keypair = Ed25519Keypair.generate();
const address = keypair.toSuiAddress();

// getSecretKey() returns a Uint8Array of the raw 32-byte seed.
// encodeSuiPrivateKey / decodeSuiPrivateKey expect a flag byte prefix;
// getSecretKey() on Ed25519Keypair already returns the bech32-encoded form via toSuiAddress.
// Use the built-in export method which returns the "suiprivkey1..." bech32 string.
const bech32Key = keypair.getSecretKey();

console.log("");
console.log("=".repeat(70));
console.log("AGENT KEYPAIR GENERATED");
console.log("=".repeat(70));
console.log("");
console.log("Sui address  :", address);
console.log("Private key  :", bech32Key);
console.log("");
console.log("WARNING: This private key is printed ONCE. Store it immediately.");
console.log("Add the following line to your .env file:");
console.log("");
console.log(`  AGENT_PRIVATE_KEY=${bech32Key}`);
console.log("");
console.log("=".repeat(70));
console.log("");
