/**
 * serve-demo-api.ts — stand up JUST the HTTP API against the seeded demo DB
 * (no rebalancer, no watchers) for frontend development.
 *
 * Uses throwaway test mnemonics — the demo DB holds no real funds and the
 * server only serves reads + registration against derived demo addresses.
 * Do NOT point this at the live app.db.
 *
 * Usage: bun run scripts/serve-demo-api.ts   (listens on 127.0.0.1:8378)
 */

process.env.DB_FILE = process.env.SEED_DB_FILE ?? "./data/demo.db";
process.env.WEB_DEMO_MODE = "true"; // portal shows a "DEMO DATA" banner
process.env.IDENTITY_FILES_DISABLED = "true";
process.env.TREASURY_ENABLED = "true";
process.env.TREASURY_HTTP_ENABLED = "true";
process.env.TREASURY_HTTP_HOST ??= "127.0.0.1";
process.env.TREASURY_HTTP_PORT ??= "8378";
process.env.SUI_USDC_POOL_ID ??=
  "0x64e590b0e4d4f7dfc7ae9fae8e9983cd80ad83b658d8499bf550a9d4f6667076"; // must match seed-demo-data.ts
process.env.AGENT_MNEMONICS ??=
  "legal winner thank year wave sausage worth useful legal winner thank yellow";
process.env.TREASURY_MNEMONICS ??=
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

const { Ed25519Keypair } = await import("@mysten/sui/keypairs/ed25519");
process.env.EXPECTED_AGENT_ADDRESS ??= Ed25519Keypair.deriveKeypair(
  process.env.AGENT_MNEMONICS,
  "m/44'/784'/1'/0'/0'",
).toSuiAddress();

const { loadConfig } = await import("../src/config.ts");
const { openDb } = await import("../src/db/client.ts");
const { startTreasuryHttpApi } = await import("../src/treasury/httpApi.ts");

const cfg = loadConfig();
openDb(cfg.dbFile);
const handle = startTreasuryHttpApi(cfg);
console.log(`demo API serving ${cfg.dbFile} on http://127.0.0.1:${handle.port}`);
console.log("Ctrl-C to stop");
