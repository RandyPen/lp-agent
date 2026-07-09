import { useRef, useState, useEffect } from "react";
import { ConnectButton } from "@mysten/dapp-kit-react/ui";
import { useCurrentAccount, useDAppKit } from "@mysten/dapp-kit-react";
import { truncateAddress } from "@/lib/format";

export function WalletConnectButton() {
  const account = useCurrentAccount();
  const dAppKit = useDAppKit();
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function handleClick(e: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [open]);

  const handleCopy = async () => {
    if (!account?.address) return;
    await navigator.clipboard.writeText(account.address);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  if (account?.address) {
    return (
      <div className="relative" ref={dropdownRef}>
        <button
          className="btn-ghost mono-num"
          onClick={() => setOpen((v) => !v)}
          aria-haspopup="true"
          aria-expanded={open}
        >
          {truncateAddress(account.address)}
        </button>

        {open && (
          <div className="panel absolute right-0 top-full z-40 mt-2 w-72 p-3">
            <div className="mono-num text-ink-3 text-xs break-all" title={account.address}>
              {account.address}
            </div>
            <div className="bg-line my-2 h-px" />
            <div className="flex gap-2">
              <button className="btn-ghost flex-1" onClick={handleCopy}>
                {copied ? "Copied" : "Copy"}
              </button>
              <button
                className="btn-ghost flex-1"
                onClick={async () => {
                  setOpen(false);
                  await dAppKit.disconnectWallet();
                }}
              >
                Disconnect
              </button>
            </div>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="wallet-connect-unconnected">
      <ConnectButton />
    </div>
  );
}
