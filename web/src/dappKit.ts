import { createDAppKit } from "@mysten/dapp-kit-react";
import { SuiGrpcClient } from "@mysten/sui/grpc";

type AppNetwork = "mainnet";
const NETWORKS: AppNetwork[] = ["mainnet"];

// Read client is gRPC (dapp-kit v2 convention). Signing flows through the
// connected wallet via dAppKit.signAndExecuteTransaction, independent of the
// read client. Override the fullnode with VITE_SUI_GRPC_URL.
const GRPC_URLS: Record<AppNetwork, string> = {
  mainnet:
    (import.meta.env.VITE_SUI_GRPC_URL as string | undefined)?.trim() ||
    "https://fullnode.mainnet.sui.io:443",
};

export const dAppKit = createDAppKit({
  autoConnect: true,
  // Dev-only in-memory wallet so connected flows are testable without an
  // extension. Never enabled in production builds.
  enableBurnerWallet: import.meta.env.DEV,
  networks: NETWORKS,
  defaultNetwork: "mainnet",
  createClient(network) {
    return new SuiGrpcClient({ network, baseUrl: GRPC_URLS[network] });
  },
});

declare module "@mysten/dapp-kit-react" {
  interface Register {
    dAppKit: typeof dAppKit;
  }
}
