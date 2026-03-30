import BN from "bn.js";

export const LAMPORTS_PER_SOL = 1_000_000_000;

export function truncateAddress(address: string, chars = 4): string {
  if (address.length <= chars * 2 + 3) return address;
  return `${address.slice(0, chars)}...${address.slice(-chars)}`;
}

export function lamportsToSol(lamports: BN | number): number {
  const l = typeof lamports === "number" ? lamports : lamports.toNumber();
  return l / LAMPORTS_PER_SOL;
}

export function solToLamports(sol: number): BN {
  return new BN(Math.floor(sol * LAMPORTS_PER_SOL));
}

export function formatSol(lamports: BN | number, decimals = 4): string {
  return lamportsToSol(lamports).toFixed(decimals);
}

export async function hashString(str: string): Promise<number[]> {
  const encoder = new TextEncoder();
  const data = encoder.encode(str);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hashBuffer));
}

export function bytesToHex(bytes: number[]): string {
  return bytes.map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function formatTimestamp(ts: BN | number): string {
  const seconds = typeof ts === "number" ? ts : ts.toNumber();
  return new Date(seconds * 1000).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}
