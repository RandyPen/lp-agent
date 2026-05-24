/**
 * Backward-compatibility re-export. The actual implementation moved to
 * `src/sui/keypairs/agent.ts` once the multi-role design landed — see that
 * file plus `src/sui/keypairs/resolve.ts` for the role-aware shape.
 *
 * Existing callers `import { getAgentKeypair, getAgentAddress } from
 * "../sui/keypair.ts"` keep working through this re-export.
 */

export {
  getAgentKeypair,
  getAgentAddress,
  resetAgentKeypairCacheForTests as resetKeypairCacheForTests,
} from "./keypairs/agent.ts";
