/**
 * probe-cdpm-package.ts — verify the CDPM package ids in src/sui/cdpm/package.ts
 * resolve on mainnet after the upgrade to the 0x573584cc… deployment.
 *
 * 1. sui_getObject on each CDPM_MAINNET shared object — asserts it exists and
 *    prints its type (must be namespaced under CDPM_PACKAGE for fresh-publish ids).
 * 2. sui_getNormalizedMoveModule on <CDPM_PACKAGE>::cdpm — asserts the module
 *    exposes the agent entrypoints and user_insert_agent.
 * 3. suix_queryEvents on <CDPM_PACKAGE>::cdpm::AgentAdded — prints how many
 *    events exist (0 is fine on a fresh deployment; an RPC error is not).
 *
 * READ-ONLY: no keys, no transactions.
 *
 * Usage: bun run scripts/probe-cdpm-package.ts
 */

import { CDPM_PACKAGE, CDPM_MAINNET, EVENT_TYPES } from "../src/sui/cdpm/package.ts";

const FULLNODE = process.env.SUI_RPC_URL ?? "https://fullnode.mainnet.sui.io:443";

let rpcId = 0;
async function rpc(method: string, params: unknown[]): Promise<any> {
  const res = await fetch(FULLNODE, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }),
  });
  if (!res.ok) throw new Error(`${method}: HTTP ${res.status}`);
  const body = (await res.json()) as { result?: unknown; error?: { message: string } };
  if (body.error) throw new Error(`${method}: ${body.error.message}`);
  return body.result;
}

let failures = 0;
function check(label: string, ok: boolean, detail: string): void {
  console.log(`${ok ? "✅" : "❌"} ${label}: ${detail}`);
  if (!ok) failures++;
}

console.log(`fullnode: ${FULLNODE}`);
console.log(`CDPM_PACKAGE: ${CDPM_PACKAGE}\n`);

// 1. Shared objects exist and are typed under the package
for (const [name, id] of Object.entries(CDPM_MAINNET)) {
  const result = await rpc("sui_getObject", [id, { showType: true, showOwner: true }]);
  const type: string | undefined = result?.data?.type;
  const exists = Boolean(result?.data);
  const typedUnderPackage = typeof type === "string" && type.startsWith(CDPM_PACKAGE);
  check(name, exists && typedUnderPackage, exists ? `${type}` : `not found (${JSON.stringify(result?.error ?? result)})`);
}

// 2. Module exposes the expected entrypoints
const module_ = await rpc("sui_getNormalizedMoveModule", [CDPM_PACKAGE, "cdpm"]);
const fns = Object.keys(module_?.exposedFunctions ?? {});
for (const fn of [
  "agent_add_liquidity",
  "agent_remove_liquidity",
  "agent_collect_fee",
  "agent_transfer_fee_to_balance",
  "user_insert_agent",
  "user_deposit_liquidity",
]) {
  check(`fn ${fn}`, fns.includes(fn), fns.includes(fn) ? "exposed" : `missing (module has ${fns.length} fns)`);
}

// 3. AgentAdded event type is queryable (count may be 0 on a fresh deployment)
const events = await rpc("suix_queryEvents", [
  { MoveEventType: EVENT_TYPES.AgentAdded },
  null,
  10,
  true,
]);
const count = events?.data?.length ?? 0;
check("AgentAdded query", Array.isArray(events?.data), `${count} recent event(s)${events?.hasNextPage ? "+" : ""}`);

console.log(failures === 0 ? "\nall checks passed" : `\n${failures} check(s) FAILED`);
process.exit(failures === 0 ? 0 : 1);
