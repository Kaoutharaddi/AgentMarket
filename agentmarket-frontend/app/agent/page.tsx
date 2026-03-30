"use client";

import { useEffect, useState, useCallback } from "react";
import {
  useWallet,
  useAnchorWallet,
  useConnection,
} from "@solana/wallet-adapter-react";
import { SystemProgram } from "@solana/web3.js";
import { AnchorProvider } from "@coral-xyz/anchor";
import { WalletButton } from "@/components/WalletButton";
import { StatusBadge, ZkVerifiedBadge } from "@/components/StatusBadge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import {
  getProgram,
  getProvider,
  getReadOnlyProgram,
  type JobWithPubkey,
} from "@/lib/anchor";
import {
  truncateAddress,
  formatSol,
  formatTimestamp,
  bytesToHex,
} from "@/lib/solana";
import {
  User,
  Coins,
  Briefcase,
  CheckCircle,
  Clock,
  ExternalLink,
  Shield,
  RefreshCw,
  AlertCircle,
  Send,
  Loader2,
  X,
  Zap,
} from "lucide-react";
import BN from "bn.js";

// AGENT_GUEST_ID — SHA-256 del guest ELF compilado (risc-zero-v2/methods/guest).
// Debe coincidir con AGENT_GUEST_ID en programs/agentmarket/src/lib.rs.
// Con feature no-zk activa en Devnet el contrato no lo valida, pero se pasa
// igualmente para preparar el código para producción.
const AGENT_GUEST_ID: number[] = [
  0x3f, 0x35, 0x8e, 0x21, 0x7f, 0x04, 0x09, 0x81,
  0xda, 0x73, 0xcf, 0x00, 0x50, 0x46, 0x74, 0x6c,
  0xd0, 0x6a, 0x0c, 0xb0, 0xc8, 0xa0, 0x45, 0xb7,
  0x3c, 0xdc, 0x7d, 0x6f, 0x6b, 0x0e, 0xcf, 0xcf,
];

/** Convierte un hex string (con o sin 0x, con o sin espacios) a un Buffer. */
function hexToBuffer(hex: string): Buffer {
  const clean = hex.replace(/^0x/, "").replace(/\s+/g, "");
  if (clean.length === 0 || clean.length % 2 !== 0) {
    throw new Error("Hex inválido: longitud incorrecta");
  }
  if (!/^[0-9a-fA-F]+$/.test(clean)) {
    throw new Error("Hex inválido: caracteres no válidos");
  }
  const bytes = new Uint8Array(clean.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return Buffer.from(bytes);
}

export default function AgentPage() {
  const { connected, publicKey } = useWallet();
  const anchorWallet = useAnchorWallet();
  const { connection } = useConnection();

  const [myJobs, setMyJobs] = useState<JobWithPubkey[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState<string | null>(null);

  // ── Verify & Pay modal state ───────────────────────────────────────────────
  const [verifyJob, setVerifyJob] = useState<JobWithPubkey | null>(null);
  const [sealHex, setSealHex] = useState("");
  const [journalHex, setJournalHex] = useState("");
  const [verifying, setVerifying] = useState(false);
  const [verifyError, setVerifyError] = useState<string | null>(null);
  const [verifyTxHash, setVerifyTxHash] = useState<string | null>(null);

  const fetchMyJobs = useCallback(async () => {
    if (!publicKey) return;
    setLoading(true);
    setError(null);
    try {
      const program = getReadOnlyProgram();
      const allJobs = await (program.account as any).job.all();
      const mine = (allJobs as JobWithPubkey[]).filter(
        (j) =>
          j.account.agent?.toBase58() === publicKey.toBase58()
      );
      setMyJobs(mine);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to load jobs");
    } finally {
      setLoading(false);
    }
  }, [publicKey]);

  useEffect(() => {
    if (connected && publicKey) {
      fetchMyJobs();
    }
  }, [connected, publicKey, fetchMyJobs]);

  async function handleSubmitResult(job: JobWithPubkey) {
    if (!anchorWallet) return;
    setSubmitting(job.publicKey.toBase58());
    try {
      const provider = getProvider(connection, anchorWallet);
      const program = getProgram(provider);

      // In a real system, the agent would compute and submit the actual result hash
      // Here we demonstrate with the output_hash as the result (ZK-verified match)
      const resultHash = Array.from(job.account.outputHash);

      await (program.methods as any)
        .submitResult(resultHash)
        .accounts({
          agent: anchorWallet.publicKey,
          job: job.publicKey,
        })
        .rpc();

      await fetchMyJobs();
    } catch (err: unknown) {
      console.error(err);
    } finally {
      setSubmitting(null);
    }
  }

  async function handleVerifyAndPay() {
    if (!anchorWallet || !verifyJob) return;
    setVerifying(true);
    setVerifyError(null);
    setVerifyTxHash(null);
    try {
      const seal = hexToBuffer(sealHex);
      const journalOutputs = hexToBuffer(journalHex);

      const provider = getProvider(connection, anchorWallet);
      const program = getProgram(provider);

      // Con feature no-zk activa en Devnet, la CPI al VerifierRouter se omite.
      // Pasamos SystemProgram como placeholder para las cuentas del verifier
      // (igual que en los tests de Anchor).
      const tx = await (program.methods as any)
        .verifyAndPay(seal, journalOutputs, AGENT_GUEST_ID)
        .accountsPartial({
          job:             verifyJob.publicKey,
          agent:           anchorWallet.publicKey,
          routerAccount:   SystemProgram.programId,
          verifierEntry:   SystemProgram.programId,
          verifierProgram: SystemProgram.programId,
        })
        .rpc();

      setVerifyTxHash(tx);
      await fetchMyJobs();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Transaction failed";
      setVerifyError(
        msg.includes("ReportHashMismatch")
          ? "Journal rechazado: jobspec_hash no coincide con el job on-chain"
          : msg.includes("AuditorMismatch")
          ? "Journal rechazado: auditor_pubkey no coincide con tu wallet"
          : msg.includes("InvalidJournal")
          ? "Journal inválido: debe ser exactamente 132 bytes"
          : msg.includes("Hex inválido")
          ? msg
          : `Error on-chain: ${msg.slice(0, 120)}`
      );
    } finally {
      setVerifying(false);
    }
  }

  function openVerifyModal(job: JobWithPubkey) {
    setVerifyJob(job);
    setSealHex("");
    setJournalHex("");
    setVerifyError(null);
    setVerifyTxHash(null);
  }

  function closeVerifyModal() {
    setVerifyJob(null);
    setSealHex("");
    setJournalHex("");
    setVerifyError(null);
    setVerifyTxHash(null);
  }

  // Stats
  const totalEarned = myJobs
    .filter((j) => "completed" in j.account.status)
    .reduce((acc, j) => acc + j.account.reward.toNumber(), 0);

  const openJobs = myJobs.filter((j) => "inProgress" in j.account.status).length;
  const completedJobs = myJobs.filter((j) => "completed" in j.account.status).length;

  if (!connected) {
    return (
      <div className="flex min-h-[80vh] items-center justify-center px-4">
        <div className="text-center">
          <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-full border border-border bg-surface">
            <User className="h-7 w-7 text-zinc-500" />
          </div>
          <h2 className="mb-2 text-xl font-bold text-white">Agent Dashboard</h2>
          <p className="mb-6 text-zinc-500">
            Connect your wallet to view your audit jobs and earnings
          </p>
          <WalletButton />
        </div>
      </div>
    );
  }

  return (
    <>
    <div className="min-h-screen px-4 py-10 sm:px-6">
      <div className="mx-auto max-w-5xl">
        {/* Header */}
        <div className="mb-8 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <div className="mb-1 flex items-center gap-2">
              <Briefcase className="h-5 w-5 text-purple-400" />
              <h1 className="text-2xl font-bold text-white">Agent Dashboard</h1>
            </div>
            <p className="font-mono text-sm text-zinc-500">
              {truncateAddress(publicKey!.toBase58(), 8)}
            </p>
          </div>
          <Button
            variant="ghost"
            size="sm"
            onClick={fetchMyJobs}
            disabled={loading}
            className="gap-2"
          >
            <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
            Refresh
          </Button>
        </div>

        {/* Stats */}
        <div className="mb-8 grid grid-cols-3 gap-4">
          <div className="rounded-xl border border-border bg-surface p-5">
            <div className="mb-2 flex items-center gap-2">
              <Coins className="h-4 w-4 text-purple-400" />
              <span className="text-xs text-zinc-500">Total Earned</span>
            </div>
            <p className="text-2xl font-bold text-white">
              {formatSol(new BN(totalEarned), 3)}
            </p>
            <p className="text-sm text-zinc-500">SOL</p>
          </div>

          <div className="rounded-xl border border-border bg-surface p-5">
            <div className="mb-2 flex items-center gap-2">
              <Clock className="h-4 w-4 text-blue-400" />
              <span className="text-xs text-zinc-500">Active Jobs</span>
            </div>
            <p className="text-2xl font-bold text-white">{openJobs}</p>
            <p className="text-sm text-zinc-500">In progress</p>
          </div>

          <div className="rounded-xl border border-border bg-surface p-5">
            <div className="mb-2 flex items-center gap-2">
              <CheckCircle className="h-4 w-4 text-green-400" />
              <span className="text-xs text-zinc-500">Completed</span>
            </div>
            <p className="text-2xl font-bold text-white">{completedJobs}</p>
            <p className="text-sm text-zinc-500">Audits</p>
          </div>
        </div>

        {/* Error */}
        {error && (
          <div className="mb-6 flex items-start gap-3 rounded-xl border border-red-500/20 bg-red-500/10 p-4">
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-red-400" />
            <p className="text-sm text-red-300">{error}</p>
          </div>
        )}

        {/* Loading */}
        {loading && (
          <div className="space-y-3">
            {[...Array(3)].map((_, i) => (
              <div
                key={i}
                className="h-28 rounded-xl border border-border bg-surface animate-pulse"
              />
            ))}
          </div>
        )}

        {/* Jobs list */}
        {!loading && myJobs.length === 0 && (
          <div className="flex flex-col items-center justify-center py-16 text-center">
            <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-full border border-border bg-surface">
              <Briefcase className="h-6 w-6 text-zinc-600" />
            </div>
            <p className="mb-2 font-medium text-white">No jobs assigned yet</p>
            <p className="mb-6 text-sm text-zinc-500">
              Go to the marketplace to claim audit jobs and start earning
            </p>
            <Button
              onClick={() => (window.location.href = "/marketplace")}
              variant="outline"
            >
              Browse Marketplace
            </Button>
          </div>
        )}

        {!loading && myJobs.length > 0 && (
          <div className="space-y-3">
            <h2 className="text-sm font-medium text-zinc-400">
              Your Jobs ({myJobs.length})
            </h2>
            {myJobs.map((job) => {
              const isInProgress = "inProgress" in job.account.status;
              const isComp = "completed" in job.account.status;
              const isPending = "pendingVerification" in job.account.status;
              const jobKey = job.publicKey.toBase58();

              return (
                <div
                  key={jobKey}
                  className="rounded-xl border border-border bg-surface p-5 hover:border-purple-500/20 transition-colors"
                >
                  <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
                    <div className="flex-1 min-w-0">
                      <div className="mb-2 flex flex-wrap items-center gap-2">
                        <StatusBadge status={job.account.status} />
                        {isComp && <ZkVerifiedBadge />}
                      </div>

                      <div className="grid gap-2 sm:grid-cols-3">
                        <div>
                          <p className="text-xs text-zinc-600">Job PDA</p>
                          <p className="font-mono text-xs text-zinc-400">
                            {truncateAddress(jobKey)}
                          </p>
                        </div>
                        <div>
                          <p className="text-xs text-zinc-600">Client</p>
                          <p className="font-mono text-xs text-zinc-400">
                            {truncateAddress(job.account.client.toBase58())}
                          </p>
                        </div>
                        <div>
                          <p className="text-xs text-zinc-600">Created</p>
                          <p className="text-xs text-zinc-400">
                            {formatTimestamp(job.account.createdAt)}
                          </p>
                        </div>
                      </div>

                      {isComp && (
                        <div className="mt-2">
                          <p className="text-xs text-zinc-600">Result Hash</p>
                          <p className="font-mono text-xs text-purple-400">
                            {bytesToHex(job.account.resultHash).slice(0, 32)}...
                          </p>
                        </div>
                      )}
                    </div>

                    <div className="flex shrink-0 flex-col items-end gap-3">
                      <div className="text-right">
                        <p className="text-xs text-zinc-600">Reward</p>
                        <p className="text-lg font-bold text-white">
                          {formatSol(job.account.reward, 3)}{" "}
                          <span className="text-sm font-normal text-zinc-400">
                            SOL
                          </span>
                        </p>
                      </div>

                      {isInProgress && (
                        <Button
                          size="sm"
                          onClick={() => handleSubmitResult(job)}
                          disabled={submitting === jobKey}
                          className="gap-2"
                        >
                          {submitting === jobKey ? (
                            <>
                              <Loader2 className="h-3.5 w-3.5 animate-spin" />
                              Submitting...
                            </>
                          ) : (
                            <>
                              <Send className="h-3.5 w-3.5" />
                              Submit Result
                            </>
                          )}
                        </Button>
                      )}

                      {isComp && (
                        <Button size="sm" variant="outline" className="gap-2">
                          <Shield className="h-3.5 w-3.5 text-purple-400" />
                          View ZK Proof
                        </Button>
                      )}

                      {isPending && (
                        <Button
                          size="sm"
                          onClick={() => openVerifyModal(job)}
                          className="gap-2 bg-purple-600 hover:bg-purple-500"
                        >
                          <Zap className="h-3.5 w-3.5" />
                          Verify &amp; Pay
                        </Button>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>

    {/* ── Verify & Pay Modal ─────────────────────────────────────────────── */}

    {verifyJob && (
      <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
        {/* Backdrop */}
        <div
          className="absolute inset-0 bg-black/70 backdrop-blur-sm"
          onClick={closeVerifyModal}
        />

        {/* Modal */}
        <div className="relative w-full max-w-lg rounded-2xl border border-border bg-zinc-900 shadow-2xl shadow-black/60">
          {/* Header */}
          <div className="flex items-center justify-between border-b border-border px-6 py-4">
            <div className="flex items-center gap-2">
              <Zap className="h-5 w-5 text-purple-400" />
              <h2 className="font-semibold text-white">Verify &amp; Pay</h2>
            </div>
            <button
              onClick={closeVerifyModal}
              className="rounded-lg p-1 text-zinc-500 hover:bg-white/5 hover:text-white transition-colors"
            >
              <X className="h-4 w-4" />
            </button>
          </div>

          <div className="px-6 py-5 space-y-5">
            {/* Job info */}
            <div className="rounded-lg border border-border bg-white/5 px-4 py-3">
              <p className="text-xs text-zinc-500 mb-1">Job PDA</p>
              <p className="font-mono text-xs text-zinc-300">
                {verifyJob.publicKey.toBase58()}
              </p>
              <p className="text-xs text-zinc-500 mt-2 mb-1">Reward</p>
              <p className="font-semibold text-white">
                {formatSol(verifyJob.account.reward, 3)}{" "}
                <span className="text-sm font-normal text-zinc-400">SOL</span>
              </p>
            </div>

            <p className="text-xs text-zinc-500 leading-relaxed">
              Pega los valores de{" "}
              <span className="font-mono text-zinc-400">audit_proof.json</span>{" "}
              generado por el ZK host. Con{" "}
              <span className="font-mono text-zinc-400">no-zk</span> activo en
              Devnet el contrato valida el journal pero omite la CPI al
              VerifierRouter.
            </p>

            {/* seal_hex */}
            <div>
              <Label htmlFor="seal-hex" className="mb-1.5 block text-zinc-300">
                seal_hex
              </Label>
              <textarea
                id="seal-hex"
                value={sealHex}
                onChange={(e) => setSealHex(e.target.value)}
                placeholder="030000000000..."
                rows={3}
                className="w-full rounded-lg border border-border bg-white/5 px-3 py-2 font-mono text-xs text-zinc-300 placeholder-zinc-700 focus:border-purple-500/50 focus:outline-none focus:ring-1 focus:ring-purple-500/30 resize-none"
              />
            </div>

            {/* journal_outputs_hex */}
            <div>
              <Label htmlFor="journal-hex" className="mb-1.5 block text-zinc-300">
                journal_outputs_hex
              </Label>
              <textarea
                id="journal-hex"
                value={journalHex}
                onChange={(e) => setJournalHex(e.target.value)}
                placeholder="8a00000066000000..."
                rows={3}
                className="w-full rounded-lg border border-border bg-white/5 px-3 py-2 font-mono text-xs text-zinc-300 placeholder-zinc-700 focus:border-purple-500/50 focus:outline-none focus:ring-1 focus:ring-purple-500/30 resize-none"
              />
              <p className="mt-1 text-xs text-zinc-600">
                Debe ser exactamente 132 bytes (264 hex chars) — AuditJournal
                del guest.
              </p>
            </div>

            {/* Error */}
            {verifyError && (
              <div className="flex items-start gap-3 rounded-lg border border-red-500/20 bg-red-500/10 px-4 py-3">
                <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-red-400" />
                <p className="text-xs text-red-300">{verifyError}</p>
              </div>
            )}

            {/* Success */}
            {verifyTxHash && (
              <div className="flex items-start gap-3 rounded-lg border border-green-500/20 bg-green-500/10 px-4 py-3">
                <CheckCircle className="mt-0.5 h-4 w-4 shrink-0 text-green-400" />
                <div className="min-w-0">
                  <p className="text-sm font-medium text-green-300">
                    ✓ Payment received!
                  </p>
                  <a
                    href={`https://explorer.solana.com/tx/${verifyTxHash}?cluster=devnet`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="mt-1 flex items-center gap-1 font-mono text-xs text-purple-400 hover:text-purple-300 truncate"
                  >
                    {verifyTxHash.slice(0, 24)}...{verifyTxHash.slice(-8)}
                    <ExternalLink className="h-3 w-3 shrink-0" />
                  </a>
                </div>
              </div>
            )}
          </div>

          {/* Footer */}
          <div className="flex items-center justify-end gap-3 border-t border-border px-6 py-4">
            <Button variant="ghost" onClick={closeVerifyModal} disabled={verifying}>
              Cancel
            </Button>
            <Button
              onClick={handleVerifyAndPay}
              disabled={verifying || !sealHex.trim() || !journalHex.trim() || !!verifyTxHash}
              className="gap-2 bg-purple-600 hover:bg-purple-500 disabled:opacity-50"
            >
              {verifying ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Verifying ZK proof...
                </>
              ) : (
                <>
                  <Zap className="h-4 w-4" />
                  Verify &amp; Pay
                </>
              )}
            </Button>
          </div>
        </div>
      </div>
    )}
    </>
  );
}
