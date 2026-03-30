import type { Metadata } from "next";
import "./globals.css";
import SolanaProvider from "@/components/WalletProvider";
import { Navbar } from "@/components/Navbar";

export const metadata: Metadata = {
  title: "AgentMarket — Smart Contract Audits with ZK Proof",
  description:
    "Pay in SOL. Get audited by AI. Verified on-chain with zero-knowledge proof.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body>
        <SolanaProvider>
          <Navbar />
          <main>{children}</main>
        </SolanaProvider>
      </body>
    </html>
  );
}
