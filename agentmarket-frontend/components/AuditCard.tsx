"use client";

import { useState } from "react";
import { useWallet, useAnchorWallet, useConnection } from "@solana/wallet-adapter-react";
import { SystemProgram } from "@solana/web3.js";
import { Card, CardContent, CardFooter } from "./ui/card";
import { Button } from "./ui/button";
import { StatusBadge, ZkVerifiedBadge } from "./StatusBadge";
import {
  getProgram,
  getProvider,
  isOpen,
  isInProgress,
  isCompleted,
  type JobWithPubkey,
} from "@/lib/anchor";
import {
  truncateAddress,
  formatSol,
  formatTimestamp,
  bytesToHex,
} from "@/lib/solana";
import { Coins, Calendar, Hash, User, ExternalLink } from "lucide-react";

interface AuditCardProps {
  job: JobWithPubkey;
  onClaimed?: () => void;
  onCancelled?: () => void;
}

export function AuditCard({ job, onClaimed, onCancelled }: AuditCardProps) {
  const { connected } = useWallet();
  const anchorWallet = useAnchorWallet();
  const { connection } = useConnection();
  const [claiming, setClaiming] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const { publicKey, account } = job;
  const inputHashHex = bytesToHex(account.inputHash).slice(0, 16) + "...";

  // Cancel eligibility: must be the client, and job must be Open OR
  // InProgress with more than 72 hours elapsed since creation.
  const isMyJob =
    connected &&
    anchorWallet?.publicKey?.toBase58() === account.client.toBase58();
  const nowSec = Math.floor(Date.now() / 1000);
  const over72h = nowSec - account.createdAt.toNumber() > 72 * 3600;
  const canCancel =
    isMyJob &&
    (isOpen(account.status) || (isInProgress(account.status) && over72h));

  async function handleClaim() {
    if (!anchorWallet) return;
    setClaiming(true);
    setError(null);
    try {
      const provider = getProvider(connection, anchorWallet);
      const program = getProgram(provider);

      await (program.methods as any)
        .claimJob(account.createdAt)
        .accounts({
          agent: anchorWallet.publicKey,
          client: account.client,
          job: publicKey,
        })
        .rpc();

      onClaimed?.();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Transaction failed";
      setError(msg.includes("custom program error") ? "Job already claimed or unavailable" : msg);
    } finally {
      setClaiming(false);
    }
  }

  async function handleCancel() {
    if (!anchorWallet) return;
    setCancelling(true);
    setError(null);
    try {
      const provider = getProvider(connection, anchorWallet);
      const program = getProgram(provider);

      await (program.methods as any)
        .cancelJob()
        .accounts({
          client: anchorWallet.publicKey,
          job: publicKey,
          systemProgram: SystemProgram.programId,
        })
        .rpc();

      onCancelled?.();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Transaction failed";
      setError(msg.includes("custom program error") ? "Job cannot be cancelled" : msg);
    } finally {
      setCancelling(false);
    }
  }

  return (
    <Card className="group hover:border-purple-500/30 transition-all duration-300">
      <CardContent>
        <div className="flex items-start justify-between gap-4 mb-4">
          <div className="flex-1 min-w-0">
            <p className="font-mono text-xs text-zinc-500 mb-1">Job PDA</p>
            <p className="font-mono text-sm text-white truncate">
              {truncateAddress(publicKey.toBase58(), 6)}
            </p>
          </div>
          <div className="flex flex-col items-end gap-2 shrink-0">
            <StatusBadge status={account.status} />
            {isCompleted(account.status) && <ZkVerifiedBadge />}
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div className="rounded-lg bg-background/60 border border-border-subtle p-3">
            <div className="flex items-center gap-1.5 mb-1">
              <Coins className="h-3.5 w-3.5 text-purple-400" />
              <span className="text-xs text-zinc-500">Reward</span>
            </div>
            <p className="text-lg font-bold text-white">
              {formatSol(account.reward, 3)}{" "}
              <span className="text-sm font-normal text-zinc-400">SOL</span>
            </p>
          </div>

          <div className="rounded-lg bg-background/60 border border-border-subtle p-3">
            <div className="flex items-center gap-1.5 mb-1">
              <Calendar className="h-3.5 w-3.5 text-zinc-500" />
              <span className="text-xs text-zinc-500">Created</span>
            </div>
            <p className="text-sm text-white">
              {formatTimestamp(account.createdAt)}
            </p>
          </div>
        </div>

        <div className="mt-3 space-y-2">
          <div className="flex items-center gap-2">
            <User className="h-3.5 w-3.5 text-zinc-600 shrink-0" />
            <span className="text-xs text-zinc-500">Client:</span>
            <span className="font-mono text-xs text-zinc-400">
              {truncateAddress(account.client.toBase58())}
            </span>
          </div>
          {account.agent && (
            <div className="flex items-center gap-2">
              <User className="h-3.5 w-3.5 text-blue-500 shrink-0" />
              <span className="text-xs text-zinc-500">Agent:</span>
              <span className="font-mono text-xs text-zinc-400">
                {truncateAddress(account.agent.toBase58())}
              </span>
            </div>
          )}
          <div className="flex items-center gap-2">
            <Hash className="h-3.5 w-3.5 text-zinc-600 shrink-0" />
            <span className="text-xs text-zinc-500">Input:</span>
            <span className="font-mono text-xs text-zinc-500">
              {inputHashHex}
            </span>
          </div>
        </div>

        {error && (
          <p className="mt-3 rounded-lg bg-red-500/10 border border-red-500/20 px-3 py-2 text-xs text-red-400">
            {error}
          </p>
        )}
      </CardContent>

      <CardFooter className="border-t border-border-subtle pt-4">
        <div className="flex w-full flex-col gap-2">
          {/* Claim — visible to any connected wallet when job is Open */}
          {isOpen(account.status) && (
            <Button
              onClick={handleClaim}
              disabled={!connected || claiming || cancelling}
              className="w-full"
              size="sm"
            >
              {claiming
                ? "Claiming..."
                : connected
                ? "Claim Audit"
                : "Connect wallet to claim"}
            </Button>
          )}

          {/* Cancel & Refund — visible only to the client under eligible conditions */}
          {canCancel && (
            <Button
              variant="outline"
              onClick={handleCancel}
              disabled={cancelling || claiming}
              className="w-full border-red-500/30 text-red-400 hover:border-red-500/60 hover:bg-red-500/5 hover:text-red-300"
              size="sm"
            >
              {cancelling ? "Cancelling..." : "Cancel & Refund"}
            </Button>
          )}

          {/* Completed */}
          {isCompleted(account.status) && (
            <Button variant="outline" size="sm" className="w-full">
              <ExternalLink className="h-3.5 w-3.5" />
              View ZK Proof
            </Button>
          )}

          {/* InProgress and not yet cancellable */}
          {isInProgress(account.status) && !canCancel && (
            <p className="w-full text-center text-xs text-zinc-500">
              Job is being processed
            </p>
          )}

          {/* PendingVerification or Disputed */}
          {"pendingVerification" in account.status && (
            <p className="w-full text-center text-xs text-zinc-500">
              Awaiting ZK verification
            </p>
          )}

          {/* Cancelled */}
          {"cancelled" in account.status && (
            <p className="w-full text-center text-xs text-zinc-500">
              Job cancelled — funds returned
            </p>
          )}
        </div>
      </CardFooter>
    </Card>
  );
}
