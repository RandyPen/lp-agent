export function truncateAddress(address: string, head = 6, tail = 4): string {
  if (address.length <= head + tail + 2) return address;
  return `${address.slice(0, head)}…${address.slice(-tail)}`;
}

export function formatUsd(v: number, digits = 2): string {
  return v.toLocaleString("en-US", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

export function formatTs(ms: number): string {
  const d = new Date(ms);
  return d.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

export function formatAgo(ms: number, now = Date.now()): string {
  const s = Math.max(0, Math.floor((now - ms) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

/** Raw atomic amount → human string with the coin's decimals. */
export function formatRaw(raw: string, decimals: number, displayDigits = 2): string {
  const n = Number(raw) / 10 ** decimals;
  return n.toLocaleString("en-US", {
    minimumFractionDigits: displayDigits,
    maximumFractionDigits: displayDigits,
  });
}

export function explorerTxUrl(digest: string): string {
  return `https://suivision.xyz/txblock/${digest}`;
}

export function explorerObjectUrl(id: string): string {
  return `https://suivision.xyz/object/${id}`;
}
