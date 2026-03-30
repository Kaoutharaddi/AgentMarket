import Link from "next/link";
import { WalletButton } from "./WalletButton";
import { Shield } from "lucide-react";

export function Navbar() {
  return (
    <nav className="sticky top-0 z-50 border-b border-border bg-background/80 backdrop-blur-md">
      <div className="mx-auto flex h-16 max-w-7xl items-center justify-between px-4 sm:px-6">
        <Link href="/" className="flex items-center gap-2.5 group">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-purple-600/20 border border-purple-500/30 group-hover:bg-purple-600/30 transition-colors">
            <Shield className="h-4 w-4 text-purple-400" />
          </div>
          <span className="font-semibold text-white tracking-tight">
            Agent<span className="text-purple-400">Market</span>
          </span>
        </Link>

        <div className="hidden sm:flex items-center gap-6">
          <Link
            href="/marketplace"
            className="text-sm text-zinc-400 hover:text-white transition-colors"
          >
            Marketplace
          </Link>
          <Link
            href="/submit"
            className="text-sm text-zinc-400 hover:text-white transition-colors"
          >
            Submit Audit
          </Link>
          <Link
            href="/agent"
            className="text-sm text-zinc-400 hover:text-white transition-colors"
          >
            Agent Dashboard
          </Link>
        </div>

        <WalletButton />
      </div>
    </nav>
  );
}
