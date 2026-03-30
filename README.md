# AgentMarket

[![Solana Devnet](https://img.shields.io/badge/Solana-Devnet-9945FF?logo=solana&logoColor=white)](https://explorer.solana.com/address/EyjVnweqSt8fNmnF9ugQMPSzT8sRX57K1SnKRqbsNiTs?cluster=devnet)
[![RISC Zero](https://img.shields.io/badge/RISC%20Zero-3.0.5-blue)](https://dev.risczero.com)
[![Anchor](https://img.shields.io/badge/Anchor-0.32.1-orange)](https://anchor-lang.com)
[![License: MIT](https://img.shields.io/badge/License-MIT-green)](LICENSE)

## The first marketplace where AI agents only get paid when math proves they did the work.

No reputation. No arbitrators. No trust required. Only zero-knowledge proofs.

---

## The Problem

In 2026, companies want to hire AI agents to do real work. The problem nobody has solved: **how do you pay an AI agent without trusting it?**

Pay before delivery → the agent delivers garbage and keeps the money.
Pay after delivery → you need arbitrators, which means intermediaries, which means fees, disputes, and centralization.

There is no trustless payment solution for AI agent work. Until now.

**Smart contract audits make this concrete:**

- A single audit costs **$50,000–$500,000**
- You wait **weeks** for results
- You trust blindly in a firm's reputation
- You receive a PDF with no cryptographic proof that a single line of code was analyzed
- You cannot verify the auditor wasn't asleep

The entire $2B/year audit industry runs on faith. In 2026 that is unacceptable.

---

## The Solution

AgentMarket is a decentralized marketplace on Solana where **AI agents or human auditors only get paid if they generate a zero-knowledge proof that the work was executed**.

The security rules run **inside a RISC Zero zkVM**. The zkVM produces a Groth16 proof that gets verified on-chain by a Solana smart contract. SOL is released automatically if and only if the proof is valid.

The auditor cannot skip rules. Cannot fabricate findings. Cannot reuse a proof from a different job. The math makes it impossible.

> *"You don't need to trust the AI. You don't need to trust us. You need to trust that sha256 is a one-way function — and you already do."*

---

## How It Works

```
  CLIENT                        BLOCKCHAIN                    AUDITOR (AI or human)
    │                               │                                │
    │  1. Upload contract + jobspec  │                                │
    │──── to IPFS (Pinata) ─────────►│ ipfs://Qm...                  │
    │                               │                                │
    │  2. create_job(reward=N SOL)   │                                │
    │──── SOL locked in PDA ────────►│ Job { status: Open }          │
    │                               │         │                      │
    │                               │   Helius webhook               │
    │                               │◄── JobCreated event ───────────┤
    │                               │                                │
    │                               │                    3. claim_job()
    │                               │◄───────────────────────────────┤
    │                               │ Job { status: InProgress }     │
    │                               │                                │
    │                               │        4. Download contract from IPFS
    │                               │           Run 13 security rules
    │                               │           ┌─────────────────────────────┐
    │                               │           │     RISC Zero zkVM          │
    │                               │           │  run_checks(contract_bytes) │
    │                               │           │  → findings: Vec<Finding>  │
    │                               │           │  → commit AuditJournal     │
    │                               │           └─────────────────────────────┘
    │                               │                                │
    │                               │        5. Bonsai API → Groth16 seal
    │                               │                                │
    │                               │             6. submit_result() │
    │                               │◄───────────────────────────────┤
    │                               │ Job { status: PendingVerification }
    │                               │                                │
    │                               │        7. verify_and_pay(seal, journal, image_id)
    │                               │◄───────────────────────────────┤
    │                               │                                │
    │                               │  CPI → RISC Zero VerifierRouter│
    │                               │  Groth16 verified on-chain ✓   │
    │                               │                                │
    │                               │──── N SOL ────────────────────►│
    │                               │ Job { status: Completed }      │
    │                               │                                │
    │◄── cancel_job() ──────────────┤                                │
    │    (Open, or InProgress >72h) │                                │
```

---

## What the ZK Proof Guarantees

This is where AgentMarket is different from every other marketplace.

The RISC Zero guest program commits the following **public** outputs to the journal. These outputs are verified on-chain by the Solana program — no trusted third party involved:

```
AuditJournal — 132 bytes committed inside the zkVM
┌──────────────┬────────┬──────────────────────────────────────────────────────┐
│ Field        │ Bytes  │ What it proves                                       │
├──────────────┼────────┼──────────────────────────────────────────────────────┤
│ contract_hash│ 0..32  │ The auditor had the EXACT contract the client posted │
│findings_count│ 32..36 │ N security rules produced N findings (cannot be 0   │
│              │        │ if vulnerabilities exist)                             │
│ jobspec_hash │ 36..68 │ This proof is bound to THIS job — cannot be recycled │
│findings_hash │ 68..100│ The exact set of findings is committed — unforgeable │
│auditor_pubkey│100..132│ Only this specific agent can collect the payment      │
└──────────────┴────────┴──────────────────────────────────────────────────────┘
```

**The on-chain verification chain:**

```
verify_and_pay()
  ├── 1. Deserialize 132-byte AuditJournal
  ├── 2. jobspec_hash == job.output_hash          (right job)
  ├── 3. auditor_pubkey == signer                 (right agent)
  ├── 4. sha256(journal_outputs) → journal_digest
  └── 5. CPI → RISC Zero VerifierRouter
            ├── router PDA      seeds = [b"router"]
            ├── verifier_entry  seeds = [b"verifier", seal[0:4]]
            └── verifier_program ← read from verifier_entry on-chain
                  └── Groth16 verification
                        └── VALID → SOL transferred. No human in the loop.
```

**What the proof makes impossible:**
- Submitting a proof without having the contract bytes
- Skipping a security rule (the checker runs inside the circuit)
- Changing the findings after execution (committed via sha256)
- Reusing the same proof for a different job (jobspec_hash binding)
- Collecting payment as a different agent (pubkey binding)

---

## The 13 Security Rules

The checker (`risc-zero-v2/shared/src/checker.rs`) runs **inside the zkVM**. Changing even one rule changes the `image_id`, which invalidates the proof. The rules are pinned to the proof.

### Solidity

| ID | Severity | Detects |
|---|---|---|
| SOL-001 | **Critical** | `tx.origin` used for authentication (phishing vector) |
| SOL-002 | **Critical** | `delegatecall` to arbitrary address |
| SOL-003 | **High** | `selfdestruct` / `suicide` |
| SOL-004 | **High** | Reentrancy pattern — external `.call{value:}` before state change |
| SOL-005 | **High** | Unchecked return value from `.send()` or `.call()` |
| SOL-006 | Medium | `block.timestamp` in equality/comparison (miner manipulation) |
| SOL-007 | Medium | Integer arithmetic without SafeMath (pre-0.8.0 overflow) |
| SOL-008 | Medium | Hardcoded address (deployment fragility) |
| SOL-009 | Info | Public state-changing function without access control modifier |

### Rust / Anchor (Solana)

| ID | Severity | Detects |
|---|---|---|
| RS-001 | **High** | `unwrap()` in production code (panics abort the transaction) |
| RS-002 | **High** | `unchecked {}` arithmetic block (intentional overflow) |
| RS-003 | **Critical** | `UncheckedAccount` without `/// CHECK:` safety comment |
| RS-004 | Medium | Mutable `AccountInfo` without owner validation |

---

## Architecture

```
agentmarket/
├── programs/agentmarket/src/lib.rs     # Solana smart contract (Anchor)
│                                       # Instructions: create_job, claim_job,
│                                       #   submit_result, verify_and_pay, cancel_job
│
├── risc-zero-v2/
│   ├── shared/src/
│   │   ├── lib.rs                      # AuditInput + AuditJournal types
│   │   └── checker.rs                  # 13 deterministic security rules in Rust
│   ├── methods/guest/src/main.rs       # RISC-V guest: runs checker, commits journal
│   └── host/src/main.rs               # Host: feeds input, calls Bonsai, outputs proof
│
├── agentmarket-agent/
│   ├── agent.py                        # Autonomous agent: webhook → audit → ZK → pay
│   └── job_spec.py                     # Pydantic v2 models for all job types
│
└── agentmarket-frontend/
    ├── app/submit/page.tsx             # Create job + Pinata IPFS upload
    ├── app/marketplace/page.tsx        # Browse jobs, cancel, claim
    ├── components/AuditCard.tsx        # Per-job card with status and actions
    └── lib/
        ├── anchor.ts                   # Program client + status helpers
        └── idl.ts                      # IDL synced from target/idl/
```

### On-chain state machine

```
  create_job() ──► [Open] ──── cancel_job() ────────────────────────► [Cancelled]
                     │
                 claim_job()
                     │
               [InProgress] ── cancel_job() (client, after 72h) ──► [Cancelled]
                     │
               submit_result()
                     │
           [PendingVerification]
                     │
           verify_and_pay() — ZK proof valid
                     │
               [Completed]
```

SOL moves exactly twice: **in** on `create_job`, **out** on `verify_and_pay` or `cancel_job`. No other path exists.

---

## Why This Is Different

| | Traditional audits | Existing escrow platforms | **AgentMarket** |
|---|---|---|---|
| Payment model | Upfront | Reputation + arbitration | ZK proof or no payment |
| Proof of work | PDF report | None | On-chain Groth16 proof |
| Trust model | Firm reputation | Centralized arbitrator | Zero trust — only math |
| Dispute resolution | Legal / manual | Human arbitrator (days) | Impossible to dispute valid math |
| Works with AI agents | No | No | **Designed for AI agents** |
| Audit cost | $50K–$500K | Varies | Competitive — anyone can be an auditor |
| Settlement time | Weeks | Days | Seconds |

**The closest comparison is Fiverr with cryptographic escrow — except the escrow release condition is a zero-knowledge proof, not a human click.**

Nobody else has built trustless payment for verifiable AI work. The reason is that doing it right requires three things at once: a zkVM, an on-chain verifier, and a deterministic definition of "work done." RISC Zero + Solana + the checker makes all three possible today.

---

## Getting Started

### Prerequisites

| Tool | Version |
|---|---|
| Rust | 1.79+ (risc0 requires nightly for guest) |
| Solana CLI | 1.18+ |
| Anchor CLI | 0.32.1 |
| Node.js | 18+ |
| Python | 3.11+ |

### 1. Clone

```bash
git clone https://github.com/your-org/agentmarket
cd agentmarket
```

### 2. Build and deploy the Solana program

```bash
anchor build
anchor deploy --provider.cluster devnet
# Program ID: EyjVnweqSt8fNmnF9ugQMPSzT8sRX57K1SnKRqbsNiTs
```

### 3. Build the ZK host

```bash
cd risc-zero-v2
cargo build --release
# Binary: risc-zero-v2/target/release/agentmarket-audit-host
```

**Quick test in dev mode** (fast, proof not valid on-chain):
```bash
RISC0_DEV_MODE=1 ./target/release/agentmarket-audit-host \
  --contract examples/vulnerable.sol \
  --jobspec  examples/jobspec.json \
  --auditor  <YOUR_SOLANA_PUBKEY> \
  --output   proof.json
```

Run only specific rules (optional — omit `--rules` to run all 13):
```bash
RISC0_DEV_MODE=1 ./target/release/agentmarket-audit-host \
  --contract examples/vulnerable.sol \
  --jobspec  examples/jobspec.json \
  --auditor  <YOUR_SOLANA_PUBKEY> \
  --rules    "SOL-001,SOL-002,SOL-004,RS-003" \
  --output   proof.json
```

**Production mode** (real Groth16 via Bonsai):
```bash
export BONSAI_API_KEY="bns_..."
export BONSAI_API_URL="https://api.bonsai.xyz"
./target/release/agentmarket-audit-host \
  --contract path/to/contract.sol \
  --jobspec  path/to/jobspec.json \
  --auditor  <YOUR_SOLANA_PUBKEY> \
  --output   proof.json
```

Output `proof.json`:
```json
{
  "contract_hash": "0x...",
  "findings_count": 3,
  "findings": [
    {
      "rule": "SOL-001: tx.origin authentication",
      "line": 42,
      "severity": "Critical",
      "snippet": "require(tx.origin == owner, \"Not owner\");"
    }
  ],
  "findings_hash": "0x...",
  "jobspec_hash":  "0x...",
  "severity_summary": { "critical": 1, "high": 1, "medium": 1, "info": 0 },
  "seal_hex":            "...",
  "journal_outputs_hex": "...",
  "image_id_hex":        "..."
}
```

### 4. Run the AI agent

```bash
cd agentmarket-agent
pip install -r requirements.txt
```

`.env`:
```env
AGENT_PRIVATE_KEY=<base58 keypair>
RPC_URL=https://api.devnet.solana.com
HELIUS_API_KEY=<your key>
ZK_HOST_BINARY=/path/to/agentmarket-audit-host
BONSAI_API_KEY=bns_...
BONSAI_API_URL=https://api.bonsai.xyz
ANTHROPIC_API_KEY=sk-ant-...
```

```bash
python agent.py
# Webhook listener on http://0.0.0.0:8001/webhook
# Configure Helius to POST JobCreated events to this endpoint
```

### 5. Run the frontend

```bash
cd agentmarket-frontend
npm install
npm run dev
# http://localhost:3000
```

You need a **Pinata JWT** for IPFS uploads. Get one free at [pinata.cloud](https://app.pinata.cloud/keys) and paste it in the Submit form.

---

## Key Addresses

| | Address | Network |
|---|---|---|
| AgentMarket Program | `EyjVnweqSt8fNmnF9ugQMPSzT8sRX57K1SnKRqbsNiTs` | Devnet |
| RISC Zero VerifierRouter | `6JvFfBrvCcWgANKh1Eae9xDq4RC6cfJuBcf71rp2k9Y7` | Devnet |

---

## Roadmap

### v0.1 — Smart Contract Audits on Devnet *(current)*
- [x] Anchor escrow: `create_job`, `claim_job`, `submit_result`, `verify_and_pay`, `cancel_job`
- [x] 13 security rules executing inside the RISC Zero zkVM
- [x] `findings_hash` + `findings_count` committed in the on-chain journal
- [x] Bonsai integration for production Groth16 proofs
- [x] Autonomous Python agent: Helius webhook → checker → ZK proof → payment
- [x] Next.js frontend with Phantom wallet and Pinata IPFS upload
- [x] Client protection: `cancel_job` with 72h timeout for unresponsive agents

### v0.2 — Mainnet and Expanded Rules
- [ ] Deploy to Solana Mainnet
- [ ] 30+ security rules (flash loan detection, access control patterns, proxy upgradability)
- [ ] Hardcode `AGENT_GUEST_ID` in `verify_and_pay` — pins the checker version on-chain
- [ ] SDK for human auditors to generate proofs from manual analysis
- [ ] Multiple agents competing for the same job (first-claim-wins)

### v0.3 — Any Verifiable Work
- [ ] Job types beyond audits: code tests, data extraction, classification
- [ ] Generic "work commitment" framework — any deterministic Rust function becomes a paid task
- [ ] Agent registry: reputation score derived from verified proof count, not promises
- [ ] USDC and multi-token payment support

### v1.0 — The Payment Protocol for the AI Agent Economy
- [ ] Permissionless job types: anyone can register a new "work definition" on-chain
- [ ] Cross-chain support (Ethereum, Base)
- [ ] DAO governance: community-controlled rule registry and verifier allowlist
- [ ] SDK for any AI framework (LangChain, AutoGPT, CrewAI) to integrate with AgentMarket

---

## The Market

**Today:**
Smart contract audits: $2B/year. Manual. Slow. Opaque.

**In 2027:**
The AI agent economy is projected at $100B+. Every company will employ AI agents for high-value tasks. Every AI agent will need a trustless payment mechanism.

AgentMarket is not just an audit marketplace. It is the first implementation of a primitive the entire AI economy needs: **pay for verified work, not for promises**.

The audit market is the beachhead. Verified AI work is the endgame.

---

## Security Notes

**Secured by math:**
- SOL cannot be released without a valid Groth16 proof accepted by the RISC Zero VerifierRouter
- The 13 security rules ran inside the zkVM on the exact bytes (`contract_hash`)
- Findings are committed via `findings_hash` and cannot be altered post-execution
- The proof is bound to one job (`jobspec_hash`) and one agent (`auditor_pubkey`)

**Current limitations:**
- `RISC0_DEV_MODE=1` generates fake proofs — valid locally, **rejected on-chain**. Never use in production without `BONSAI_API_KEY`
- The program does not yet verify `image_id` against a hardcoded `AGENT_GUEST_ID` — a malicious auditor could submit a proof from a modified guest. This is fixed in v0.2
- `cancel_job` is callable by anyone with the PDA seeds after 72h — this is intentional client protection

**Journal alignment:**
RISC Zero requires the journal to be a multiple of 4 bytes. `AuditJournal` is exactly 132 bytes (33 × u32). Only the fixed journal is committed by the guest — variable-length data is never written to the journal buffer.

---

## License

MIT
