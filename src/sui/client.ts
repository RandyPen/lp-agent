import { SuiJsonRpcClient } from "@mysten/sui/jsonRpc";
import { loadConfig } from "../config.ts";

let cached: SuiJsonRpcClient | null = null;

export function getSuiClient(): SuiJsonRpcClient {
  if (cached) return cached;
  const cfg = loadConfig();
  cached = new SuiJsonRpcClient({ url: cfg.grpcUrl, network: cfg.network });
  return cached;
}

export function resetSuiClientCacheForTests(): void {
  cached = null;
}

export type SuiClient = SuiJsonRpcClient;
