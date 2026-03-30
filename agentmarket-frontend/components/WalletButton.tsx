"use client";

import { useWallet } from "@solana/wallet-adapter-react";
import { WalletName } from "@solana/wallet-adapter-base";
import { truncateAddress } from "@/lib/solana";
import { Button } from "./ui/button";
import { Wallet, LogOut, ChevronDown, ExternalLink } from "lucide-react";
import { useState, useRef, useEffect } from "react";

const PHANTOM_WALLET_NAME = "Phantom" as WalletName<"Phantom">;

function isPhantomInstalled(): boolean {
  if (typeof window === "undefined") return false;
  return !!(window as any).phantom?.solana?.isPhantom || !!(window as any).solana?.isPhantom;
}

export function WalletButton() {
  const { connected, publicKey, disconnect, connecting, select, connect } = useWallet();
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [phantomMissing, setPhantomMissing] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (
        dropdownRef.current &&
        !dropdownRef.current.contains(event.target as Node)
      ) {
        setDropdownOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  async function handleConnect() {
    if (!isPhantomInstalled()) {
      setPhantomMissing(true);
      return;
    }
    setPhantomMissing(false);
    try {
      select(PHANTOM_WALLET_NAME);
      await connect();
    } catch (e) {
      console.error(e);
    }
  }

  if (!connected) {
    return (
      <div className="flex flex-col items-end gap-1">
        <Button
          onClick={handleConnect}
          disabled={connecting}
          variant="outline"
          className="border-purple-500/40 hover:border-purple-500 hover:bg-purple-500/10 text-purple-300 hover:text-purple-200"
        >
          <Wallet className="h-4 w-4" />
          {connecting ? "Connecting..." : "Connect Wallet"}
        </Button>
        {phantomMissing && (
          <a
            href="https://phantom.app"
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-1 text-xs text-red-400 hover:text-red-300"
          >
            Please install Phantom wallet
            <ExternalLink className="h-3 w-3" />
          </a>
        )}
      </div>
    );
  }

  return (
    <div className="relative" ref={dropdownRef}>
      <button
        onClick={() => setDropdownOpen(!dropdownOpen)}
        className="flex items-center gap-2 rounded-lg border border-purple-500/30 bg-purple-500/10 px-3 py-2 text-sm text-purple-300 hover:border-purple-500/50 hover:bg-purple-500/15 transition-all"
      >
        <div className="h-2 w-2 rounded-full bg-green-400 animate-pulse" />
        <span className="font-mono">
          {truncateAddress(publicKey!.toBase58())}
        </span>
        <ChevronDown className="h-3 w-3 opacity-60" />
      </button>

      {dropdownOpen && (
        <div className="absolute right-0 top-full mt-2 w-48 rounded-xl border border-border bg-surface p-1 shadow-xl z-50">
          <button
            onClick={() => {
              navigator.clipboard.writeText(publicKey!.toBase58());
              setDropdownOpen(false);
            }}
            className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm text-zinc-400 hover:bg-white/5 hover:text-white transition-colors"
          >
            Copy address
          </button>
          <button
            onClick={() => {
              disconnect();
              setDropdownOpen(false);
            }}
            className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm text-red-400 hover:bg-red-500/10 transition-colors"
          >
            <LogOut className="h-4 w-4" />
            Disconnect
          </button>
        </div>
      )}
    </div>
  );
}
