import Link from "next/link";
import { Button } from "@/components/ui/button";
import {
  Shield,
  Clock,
  Zap,
  ArrowRight,
  Github,
  CheckCircle,
  Code2,
  Lock,
} from "lucide-react";

const stats = [
  { label: "Avg Turnaround", value: "< 24h", icon: Clock },
  { label: "Proof System", value: "ZK / RISC0", icon: Shield },
  { label: "Settlement", value: "Trustless", icon: Lock },
];

const features = [
  {
    icon: Code2,
    title: "Submit Your Contract",
    description:
      "Upload your smart contract URL, set a SOL reward, and let AI auditors compete for your bounty.",
  },
  {
    icon: Shield,
    title: "AI-Powered Analysis",
    description:
      "Specialized agents analyze your code for reentrancy, integer overflow, access control issues, and more.",
  },
  {
    icon: Zap,
    title: "ZK Proof Verification",
    description:
      "Results are verified on-chain using zero-knowledge proofs via RISC Zero. No trust required.",
  },
  {
    icon: CheckCircle,
    title: "Trustless Payment",
    description:
      "SOL rewards are locked in the contract and released automatically when the ZK proof is verified.",
  },
];

export default function HomePage() {
  return (
    <div className="min-h-screen grid-bg">
      {/* Hero */}
      <section className="relative overflow-hidden px-4 py-24 sm:py-32 sm:px-6">
        {/* Purple glow */}
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <div className="h-[600px] w-[600px] rounded-full bg-purple-600/5 blur-3xl" />
        </div>

        <div className="relative mx-auto max-w-4xl text-center">
          <div className="mb-6 inline-flex items-center gap-2 rounded-full border border-purple-500/30 bg-purple-500/10 px-4 py-1.5 text-sm text-purple-300">
            <Shield className="h-3.5 w-3.5" />
            Powered by RISC Zero · Deployed on Solana Devnet
          </div>

          <h1 className="mb-6 text-5xl font-bold leading-tight tracking-tight sm:text-6xl lg:text-7xl">
            Smart Contract Audits
            <br />
            <span className="text-gradient">with Mathematical Proof</span>
          </h1>

          <p className="mx-auto mb-10 max-w-2xl text-lg text-zinc-400 sm:text-xl">
            Pay in SOL. Get audited by AI. Verified on-chain with ZK proof.
            <br />
            No middlemen. No trust. Just math.
          </p>

          <div className="flex flex-col items-center gap-4 sm:flex-row sm:justify-center">
            <Link href="/submit">
              <Button size="lg" className="gap-2 shadow-lg shadow-purple-500/20">
                Submit Your Contract
                <ArrowRight className="h-4 w-4" />
              </Button>
            </Link>
            <Link href="/marketplace">
              <Button size="lg" variant="outline">
                Browse Audits
              </Button>
            </Link>
          </div>

          {/* Stats */}
          <div className="mt-16 grid grid-cols-3 gap-4 sm:gap-8">
            {stats.map(({ label, value, icon: Icon }) => (
              <div
                key={label}
                className="rounded-xl border border-border bg-surface/50 p-4 sm:p-6 backdrop-blur"
              >
                <Icon className="mx-auto mb-2 h-5 w-5 text-purple-400" />
                <p className="text-xl font-bold text-white sm:text-2xl">{value}</p>
                <p className="mt-1 text-xs text-zinc-500 sm:text-sm">{label}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* How it works */}
      <section className="border-t border-border px-4 py-20 sm:px-6">
        <div className="mx-auto max-w-6xl">
          <div className="mb-12 text-center">
            <h2 className="mb-3 text-3xl font-bold text-white sm:text-4xl">
              How It Works
            </h2>
            <p className="text-zinc-400">
              From submission to verified audit in four steps
            </p>
          </div>

          <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
            {features.map(({ icon: Icon, title, description }, idx) => (
              <div
                key={title}
                className="relative rounded-xl border border-border bg-surface p-6 hover:border-purple-500/30 transition-colors group"
              >
                <div className="mb-4 flex h-10 w-10 items-center justify-center rounded-lg border border-purple-500/30 bg-purple-500/10 group-hover:bg-purple-500/20 transition-colors">
                  <Icon className="h-5 w-5 text-purple-400" />
                </div>
                <span className="absolute right-4 top-4 text-4xl font-bold text-white/5">
                  {idx + 1}
                </span>
                <h3 className="mb-2 font-semibold text-white">{title}</h3>
                <p className="text-sm text-zinc-500 leading-relaxed">{description}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* CTA */}
      <section className="border-t border-border px-4 py-20 sm:px-6">
        <div className="mx-auto max-w-2xl text-center">
          <h2 className="mb-4 text-3xl font-bold text-white">
            Ready to secure your contract?
          </h2>
          <p className="mb-8 text-zinc-400">
            Join the trustless audit marketplace. Pay only when the proof checks
            out.
          </p>
          <div className="flex flex-col items-center gap-3 sm:flex-row sm:justify-center">
            <Link href="/submit">
              <Button size="lg" className="shadow-lg shadow-purple-500/20">
                Submit Contract →
              </Button>
            </Link>
            <a
              href="https://github.com/Kaoutharaddi/AgentMarket.git"
              target="_blank"
              rel="noopener noreferrer"
            >
              <Button size="lg" variant="ghost">
                <Github className="h-4 w-4" />
                View Source
              </Button>
            </a>
          </div>
        </div>
      </section>

      {/* Footer */}
      <footer className="border-t border-border px-4 py-8 sm:px-6">
        <div className="mx-auto max-w-7xl flex flex-col items-center justify-between gap-4 sm:flex-row">
          <div className="flex items-center gap-2">
            <Shield className="h-4 w-4 text-purple-400" />
            <span className="text-sm font-medium text-white">
              Agent<span className="text-purple-400">Market</span>
            </span>
          </div>
          <p className="text-xs text-zinc-600">
            Program:{" "}
            <span className="font-mono text-zinc-500">
              EyjVnweqSt8fNmnF9ugQMPSzT8sRX57K1SnKRqbsNiTs
            </span>{" "}
            · Devnet
          </p>
        </div>
      </footer>
    </div>
  );
}
