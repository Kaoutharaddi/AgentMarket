// Migrations are an early feature. Currently, they're nothing more than this
// single deploy script that's invoked from the CLI, injecting a provider
// configured from the workspace's Anchor.toml.
//
// AgentMarket deployment notes:
//   The program is already deployed on Devnet:
//     Program ID: EyjVnweqSt8fNmnF9ugQMPSzT8sRX57K1SnKRqbsNiTs
//
//   To deploy or upgrade:
//     anchor build --no-default-features   # production build (enables ZK verification)
//     anchor deploy --provider.cluster devnet
//
//   The no-zk feature (default) skips on-chain ZK proof verification.
//   Remove it from Cargo.toml [features] default before mainnet deployment.

import * as anchor from "@coral-xyz/anchor";

module.exports = async function (provider: anchor.AnchorProvider) {
  // Configure client to use the provider.
  anchor.setProvider(provider);
};
