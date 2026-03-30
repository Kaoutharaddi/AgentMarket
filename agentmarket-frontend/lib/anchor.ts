import {
  Connection,
  PublicKey,
  clusterApiUrl,
  Keypair,
} from "@solana/web3.js";
import { Program, AnchorProvider, Idl, BN } from "@coral-xyz/anchor";
import { IDL } from "./idl";
import type { AnchorWallet } from "@solana/wallet-adapter-react";

export const PROGRAM_ID = new PublicKey(
  "EyjVnweqSt8fNmnF9ugQMPSzT8sRX57K1SnKRqbsNiTs"
);

export const DEVNET_ENDPOINT = clusterApiUrl("devnet");

export type JobStatus =
  | { open: Record<string, never> }
  | { inProgress: Record<string, never> }
  | { pendingVerification: Record<string, never> }
  | { completed: Record<string, never> }
  | { disputed: Record<string, never> }
  | { cancelled: Record<string, never> };

export interface JobAccount {
  client: PublicKey;
  agent: PublicKey | null;
  inputHash: number[];
  outputHash: number[];
  resultHash: number[];
  reward: BN;
  status: JobStatus;
  createdAt: BN;
  bump: number;
}

export interface JobWithPubkey {
  publicKey: PublicKey;
  account: JobAccount;
}

export function getConnection(): Connection {
  return new Connection(DEVNET_ENDPOINT, "confirmed");
}

export function getProvider(
  connection: Connection,
  wallet: AnchorWallet
): AnchorProvider {
  return new AnchorProvider(connection, wallet, {
    commitment: "confirmed",
    preflightCommitment: "confirmed",
  });
}

export function getProgram(provider: AnchorProvider): Program {
  return new Program(IDL as unknown as Idl, provider);
}

/** Read-only program — no wallet needed for fetching accounts */
export function getReadOnlyProgram(): Program {
  const connection = getConnection();
  const dummyKeypair = Keypair.generate();
  const dummyWallet: AnchorWallet = {
    publicKey: dummyKeypair.publicKey,
    signTransaction: async (tx) => tx,
    signAllTransactions: async (txs) => txs,
  };
  const provider = new AnchorProvider(connection, dummyWallet, {
    commitment: "confirmed",
  });
  return new Program(IDL as unknown as Idl, provider);
}

export function getStatusLabel(status: JobStatus): string {
  if ("open" in status) return "Open";
  if ("inProgress" in status) return "In Progress";
  if ("pendingVerification" in status) return "Pending Verification";
  if ("completed" in status) return "Completed";
  if ("disputed" in status) return "Disputed";
  if ("cancelled" in status) return "Cancelled";
  return "Unknown";
}

export function isCompleted(status: JobStatus): boolean {
  return "completed" in status;
}

export function isOpen(status: JobStatus): boolean {
  return "open" in status;
}

export function isInProgress(status: JobStatus): boolean {
  return "inProgress" in status;
}
