"use client";

import { useState } from "react";
import { useWallet, useAnchorWallet, useConnection } from "@solana/wallet-adapter-react";
import { SystemProgram } from "@solana/web3.js";
import BN from "bn.js";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { Card, CardContent } from "@/components/ui/card";
import { WalletButton } from "@/components/WalletButton";
import { getProgram, getProvider } from "@/lib/anchor";
import { hashString, solToLamports } from "@/lib/solana";
import {
  Shield,
  FileCode,
  Coins,
  CheckCircle,
  ExternalLink,
  AlertCircle,
  Loader2,
  Upload,
} from "lucide-react";

const VULNERABILITY_CHECKS = [
  { id: "reentrancy", label: "Reentrancy Attacks" },
  { id: "integer_overflow", label: "Integer Overflow / Underflow" },
  { id: "access_control", label: "Broken Access Control" },
  { id: "unchecked_returns", label: "Unchecked Return Values" },
  { id: "flash_loans", label: "Flash Loan Vulnerabilities" },
  { id: "price_manipulation", label: "Price Oracle Manipulation" },
  { id: "signer_authorization", label: "Missing Signer Authorization" },
  { id: "account_validation", label: "Account Validation Issues" },
];

interface FormData {
  contractName: string;
  contractAddress: string;
  contractCodeUrl: string;
  rewardSol: string;
  deadlineHours: string;
  vulnerabilities: string[];
}

type TxStatus = "idle" | "uploading" | "signing" | "success" | "error";

async function uploadToIPFS(content: object, jwt: string): Promise<string> {
  const res = await fetch("https://api.pinata.cloud/pinning/pinJSONToIPFS", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${jwt}`,
    },
    body: JSON.stringify({ pinataContent: content }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Pinata upload failed (${res.status}): ${text}`);
  }

  const data = await res.json();
  return `ipfs://${data.IpfsHash}`;
}

export default function SubmitPage() {
  const { connected } = useWallet();
  const anchorWallet = useAnchorWallet();
  const { connection } = useConnection();

  const [form, setForm] = useState<FormData>({
    contractName: "",
    contractAddress: "",
    contractCodeUrl: "",
    rewardSol: "",
    deadlineHours: "24",
    vulnerabilities: [],
  });
  // Kept outside form so it survives the post-submit reset
  const [pinataJwt, setPinataJwt] = useState("");
  const [txStatus, setTxStatus] = useState<TxStatus>("idle");
  const [txHash, setTxHash] = useState<string | null>(null);
  const [ipfsUrl, setIpfsUrl] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  function updateField(field: keyof FormData, value: string) {
    setForm((prev) => ({ ...prev, [field]: value }));
  }

  function toggleVulnerability(id: string) {
    setForm((prev) => ({
      ...prev,
      vulnerabilities: prev.vulnerabilities.includes(id)
        ? prev.vulnerabilities.filter((v) => v !== id)
        : [...prev.vulnerabilities, id],
    }));
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!anchorWallet || !connected) return;

    setTxStatus("uploading");
    setErrorMsg(null);
    setTxHash(null);
    setIpfsUrl(null);

    try {
      // ── Step 1: Build jobspec and upload to IPFS ─────────────────────────
      const jobSpec = {
        contract_address: form.contractAddress,
        contract_code_url: form.contractCodeUrl,
        deadline_hours: String(form.deadlineHours),
        vulnerabilities: [...form.vulnerabilities].sort(),
      };
      const uploadedIpfsUrl = await uploadToIPFS(jobSpec, pinataJwt);
      setIpfsUrl(uploadedIpfsUrl);

      // ── Step 2: Build hashes and submit on-chain ──────────────────────────
      setTxStatus("signing");

      const provider = getProvider(connection, anchorWallet);
      const program = getProgram(provider);

      // input_hash: commitment to what the auditor must work on
      const inputData = JSON.stringify(
        {
          contract_address: form.contractAddress,
          chain: "solana",
          contract_code_url: form.contractCodeUrl,
        },
        ["chain", "contract_address", "contract_code_url"],
      );
      const inputHash = await hashString(inputData);

      // output_hash: canonical 4-field jobspec hash that the ZK guest must reproduce
      const jobSpecPayload = JSON.stringify(
        {
          contract_address: form.contractAddress,
          contract_code_url: form.contractCodeUrl,
          deadline_hours: form.deadlineHours,
          vulnerabilities: [...form.vulnerabilities].sort(),
        },
        ["contract_address", "contract_code_url", "deadline_hours", "vulnerabilities"],
      );
      const outputHash = await hashString(jobSpecPayload);

      const rewardLamports = solToLamports(parseFloat(form.rewardSol));
      const createdAt = new BN(Math.floor(Date.now() / 1000));

      const tx = await (program.methods as any)
        .createJob(inputHash, outputHash, rewardLamports, createdAt, uploadedIpfsUrl)
        .accounts({
          client: anchorWallet.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .rpc();

      setTxHash(tx);
      setTxStatus("success");

      setForm({
        contractName: "",
        contractAddress: "",
        contractCodeUrl: "",
        rewardSol: "",
        deadlineHours: "24",
        vulnerabilities: [],
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Transaction failed";
      setErrorMsg(
        msg.includes("0x1") ? "Insufficient SOL balance" : msg,
      );
      setTxStatus("error");
    }
  }

  const isLoading = txStatus === "uploading" || txStatus === "signing";

  const isValid =
    form.contractName.trim() &&
    form.contractAddress.trim() &&
    form.contractCodeUrl.trim() &&
    pinataJwt.trim() &&
    parseFloat(form.rewardSol) > 0;

  const ipfsGatewayUrl = ipfsUrl
    ? `https://gateway.pinata.cloud/ipfs/${ipfsUrl.replace("ipfs://", "")}`
    : null;

  return (
    <div className="min-h-screen px-4 py-10 sm:px-6">
      <div className="mx-auto max-w-2xl">
        {/* Header */}
        <div className="mb-8">
          <div className="mb-2 flex items-center gap-2">
            <Shield className="h-5 w-5 text-purple-400" />
            <h1 className="text-2xl font-bold text-white">Submit Audit</h1>
          </div>
          <p className="text-sm text-zinc-500">
            Lock SOL as a reward. AI agents compete to audit your contract.
            Payment releases when ZK proof is verified on-chain.
          </p>
        </div>

        {/* Success state */}
        {txStatus === "success" && txHash && (
          <div className="mb-6 rounded-xl border border-green-500/20 bg-green-500/10 p-5">
            <div className="flex items-start gap-3">
              <CheckCircle className="mt-0.5 h-5 w-5 shrink-0 text-green-400" />
              <div className="min-w-0 flex-1">
                <p className="font-medium text-green-300">
                  Audit job created successfully!
                </p>
                <p className="mt-1 text-sm text-zinc-400">
                  Your contract is now live on the marketplace.
                </p>
                {ipfsUrl && ipfsGatewayUrl && (
                  <div className="mt-3 flex items-center gap-2">
                    <span className="text-xs text-zinc-500">Job spec:</span>
                    <a
                      href={ipfsGatewayUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="flex items-center gap-1 truncate font-mono text-xs text-purple-400 hover:text-purple-300"
                    >
                      {ipfsUrl.slice(0, 30)}...
                      <ExternalLink className="h-3 w-3 shrink-0" />
                    </a>
                  </div>
                )}
                <div className="mt-2 flex items-center gap-2">
                  <span className="font-mono text-xs text-zinc-500">Tx:</span>
                  <a
                    href={`https://explorer.solana.com/tx/${txHash}?cluster=devnet`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex items-center gap-1 font-mono text-xs text-purple-400 hover:text-purple-300"
                  >
                    {txHash.slice(0, 20)}...{txHash.slice(-8)}
                    <ExternalLink className="h-3 w-3" />
                  </a>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Not connected */}
        {!connected && (
          <div className="mb-6 rounded-xl border border-border bg-surface p-6 text-center">
            <Shield className="mx-auto mb-3 h-8 w-8 text-zinc-600" />
            <p className="mb-4 text-zinc-400">
              Connect your Phantom wallet to submit an audit
            </p>
            <div className="flex justify-center">
              <WalletButton />
            </div>
          </div>
        )}

        {/* Form */}
        <form onSubmit={handleSubmit}>
          <Card>
            <CardContent className="space-y-5">
              {/* Contract info section */}
              <div>
                <div className="mb-4 flex items-center gap-2">
                  <FileCode className="h-4 w-4 text-purple-400" />
                  <h2 className="text-sm font-semibold text-white">
                    Contract Information
                  </h2>
                </div>
                <div className="space-y-4">
                  <div>
                    <Label htmlFor="contractName" className="mb-1.5 block">
                      Contract Name
                    </Label>
                    <Input
                      id="contractName"
                      placeholder="e.g. MyDeFi Protocol v2"
                      value={form.contractName}
                      onChange={(e) => updateField("contractName", e.target.value)}
                      required
                    />
                  </div>

                  <div>
                    <Label htmlFor="contractAddress" className="mb-1.5 block">
                      Contract Address
                    </Label>
                    <Input
                      id="contractAddress"
                      placeholder="Solana program ID (base58)"
                      value={form.contractAddress}
                      onChange={(e) =>
                        updateField("contractAddress", e.target.value)
                      }
                      className="font-mono"
                      required
                    />
                  </div>

                  <div>
                    <Label htmlFor="contractCodeUrl" className="mb-1.5 block">
                      Contract Code URL (IPFS)
                    </Label>
                    <Input
                      id="contractCodeUrl"
                      placeholder="ipfs://Qm..."
                      value={form.contractCodeUrl}
                      onChange={(e) =>
                        updateField("contractCodeUrl", e.target.value)
                      }
                      className="font-mono"
                      required
                    />
                    <p className="mt-1 text-xs text-zinc-600">
                      IPFS URL pointing to the contract source file (.sol or .rs)
                    </p>
                  </div>
                </div>
              </div>

              {/* Divider */}
              <div className="border-t border-border-subtle" />

              {/* Reward & deadline */}
              <div>
                <div className="mb-4 flex items-center gap-2">
                  <Coins className="h-4 w-4 text-purple-400" />
                  <h2 className="text-sm font-semibold text-white">
                    Reward & Timeline
                  </h2>
                </div>
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <Label htmlFor="rewardSol" className="mb-1.5 block">
                      Reward (SOL)
                    </Label>
                    <Input
                      id="rewardSol"
                      type="number"
                      step="0.01"
                      min="0.01"
                      placeholder="0.5"
                      value={form.rewardSol}
                      onChange={(e) => updateField("rewardSol", e.target.value)}
                      required
                    />
                  </div>
                  <div>
                    <Label htmlFor="deadlineHours" className="mb-1.5 block">
                      Deadline (hours)
                    </Label>
                    <Input
                      id="deadlineHours"
                      type="number"
                      min="1"
                      max="168"
                      value={form.deadlineHours}
                      onChange={(e) =>
                        updateField("deadlineHours", e.target.value)
                      }
                    />
                  </div>
                </div>
                {form.rewardSol && (
                  <p className="mt-2 text-xs text-zinc-500">
                    {parseFloat(form.rewardSol).toFixed(4)} SOL will be locked
                    in the escrow contract
                  </p>
                )}
              </div>

              {/* Divider */}
              <div className="border-t border-border-subtle" />

              {/* Vulnerability checks */}
              <div>
                <div className="mb-4 flex items-center gap-2">
                  <Shield className="h-4 w-4 text-purple-400" />
                  <h2 className="text-sm font-semibold text-white">
                    Vulnerability Checks
                  </h2>
                  <span className="rounded-full bg-white/5 px-2 py-0.5 text-xs text-zinc-500">
                    {form.vulnerabilities.length} selected
                  </span>
                </div>
                <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
                  {VULNERABILITY_CHECKS.map(({ id, label }) => (
                    <label
                      key={id}
                      className="flex cursor-pointer items-center gap-3 rounded-lg border border-border-subtle px-3 py-2.5 transition-colors hover:border-border"
                    >
                      <Checkbox
                        checked={form.vulnerabilities.includes(id)}
                        onCheckedChange={() => toggleVulnerability(id)}
                      />
                      <span className="text-sm text-zinc-400">{label}</span>
                    </label>
                  ))}
                </div>
              </div>

              {/* Divider */}
              <div className="border-t border-border-subtle" />

              {/* Pinata JWT */}
              <div>
                <div className="mb-4 flex items-center gap-2">
                  <Upload className="h-4 w-4 text-purple-400" />
                  <h2 className="text-sm font-semibold text-white">
                    IPFS Storage
                  </h2>
                </div>
                <div>
                  <Label htmlFor="pinataJwt" className="mb-1.5 block">
                    Pinata JWT
                  </Label>
                  <Input
                    id="pinataJwt"
                    type="password"
                    placeholder="eyJhbGci..."
                    value={pinataJwt}
                    onChange={(e) => setPinataJwt(e.target.value)}
                    className="font-mono"
                    required
                  />
                  <p className="mt-1 text-xs text-zinc-600">
                    The job spec JSON is uploaded automatically to IPFS before
                    the on-chain transaction.{" "}
                    <a
                      href="https://app.pinata.cloud/keys"
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-purple-500 hover:text-purple-400"
                    >
                      Get your free JWT at app.pinata.cloud/keys
                    </a>
                  </p>
                </div>
              </div>
            </CardContent>
          </Card>

          {/* Error */}
          {txStatus === "error" && errorMsg && (
            <div className="mt-4 flex items-start gap-3 rounded-xl border border-red-500/20 bg-red-500/10 p-4">
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-red-400" />
              <p className="text-sm text-red-300">{errorMsg}</p>
            </div>
          )}

          {/* Submit */}
          <Button
            type="submit"
            size="lg"
            className="mt-6 w-full shadow-lg shadow-purple-500/20"
            disabled={!connected || !isValid || isLoading}
          >
            {txStatus === "uploading" ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" />
                Uploading to IPFS...
              </>
            ) : txStatus === "signing" ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" />
                Confirming transaction...
              </>
            ) : !connected ? (
              "Connect wallet to submit"
            ) : (
              <>
                <Shield className="h-4 w-4" />
                Submit Audit Job
                {form.rewardSol && ` · ${parseFloat(form.rewardSol)} SOL`}
              </>
            )}
          </Button>

          <p className="mt-3 text-center text-xs text-zinc-600">
            By submitting, you agree that the SOL reward will be held in escrow
            and released upon successful ZK proof verification.
          </p>
        </form>
      </div>
    </div>
  );
}
