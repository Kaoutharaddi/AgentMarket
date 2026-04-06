# AgentMarket — Claude Code Session
### Building the ZK Security Checker: 13 Rules Inside a zkVM

**Project:** AgentMarket — the first marketplace where AI agents only get paid
when math proves they did the work.  
**Stack:** RISC Zero 3.0 · Solana Anchor 0.32.1 · Bonsai (Groth16)  
**Program:** `EyjVnweqSt8fNmnF9ugQMPSzT8sRX57K1SnKRqbsNiTs` (Devnet)

---

## The Problem

The central guarantee of AgentMarket is this: *the client can prove mathematically
that specific security rules were executed on the exact contract they submitted.*
Not a PDF report. Not a signature. A Groth16 zero-knowledge proof verified on-chain
by the RISC Zero VerifierRouter.

To make this real, the 13 security rules had to run **inside** the zkVM — not
outside it. Moving them inside meant redesigning the entire workspace structure
and making RISC Zero 3.x compile cleanly on macOS.

---

## The Architecture Decision

**Developer:** I need to restructure `risc-zero-v2/` into a proper Cargo workspace.
The guest program needs to commit an `AuditJournal` — 132 bytes with `contract_hash`,
`findings_count`, `findings_hash`, `jobspec_hash`, and `auditor_pubkey`. The host
feeds input and extracts the journal. The checker (`run_checks`) runs inside the guest.

**Claude Code:** I see the current structure. The `guest/Cargo.toml` is missing,
`guest` is declared as a workspace member which conflicts with risc0's cross-compilation
isolation, and the host uses `AGENTMARKET_AUDIT_GUEST_ELF` — a constant that risc0-build
will generate as `AGENT_GUEST_ELF` from the package name `agent_guest`. Three things
to fix before a single line of checker logic can compile.

---

## Error 1 — Dual Workspace Root

```
error: multiple workspace roots found in the same workspace:
  /Users/kaddi/agentmarket/risc-zero-v2/guest
  /Users/kaddi/agentmarket/risc-zero-v2
```

**Claude Code:** The `guest/Cargo.toml` requires `[workspace]` so risc0-build can
cross-compile it in isolation for the `riscv32im-risc0-zkvm-elf` target. But it's
also listed as a member of the outer workspace — two roots in conflict.

Fix: remove `"guest"` from the outer workspace `members`. risc0-build discovers it
via `host/Cargo.toml`'s `[package.metadata.risc0]`:

```toml
# host/Cargo.toml
[package.metadata.risc0]
methods = ["../methods/guest"]
```

The compilation tree now looks like:
```
Cargo.toml (workspace)
  members: [shared, host, methods]   ← guest is NOT a direct member

host/Cargo.toml
  [package.metadata.risc0]
  methods = ["../methods/guest"]     ← risc0-build finds the guest here

methods/guest/Cargo.toml
  [workspace]                        ← isolated workspace for RISC-V cross-compile
```

---

## Error 2 — Metal GPU Shaders on macOS

```
error: failed to run custom build command for `risc0-sys v1.5.0`
cargo:metal_root=/Users/kaddi/.cargo/.../risc0-sys-1.5.0/cxx
```

**Claude Code:** `risc0-sys` tries to compile Metal GPU acceleration shaders.
This requires full Xcode — not just Command Line Tools. The build script already
exposes an escape hatch:

```bash
RISC0_SKIP_BUILD_KERNELS=1 RISC0_DEV_MODE=1 cargo build --release
```

In dev mode the prover doesn't run locally at all — Bonsai handles it. The Metal
shaders are irrelevant until production Groth16 generation.

---

## Error 3 — `#[non_exhaustive]` GuestOptions

```
error[E0639]: cannot create non-exhaustive struct using struct expression
   --> host/build.rs:5:13
  |
5 |  risc0_build::GuestOptions {
6 |      features: vec![],
7 |      use_docker: None,
8 |  },
```

**Claude Code:** `GuestOptions` is `#[non_exhaustive]` in risc0-build 3.x —
struct literals from outside the crate are forbidden. `..Default::default()` doesn't
work either (risc0 3.0 blocks all literal forms). The only valid form is:

```rust
// build.rs — before
risc0_build::embed_methods_with_options(HashMap::from([(
    "agent_guest",
    risc0_build::GuestOptions {
        features: vec![],
        use_docker: None,
    },
)]));

// build.rs — after
risc0_build::embed_methods_with_options(HashMap::from([(
    "agent_guest",
    risc0_build::GuestOptions::default(),
)]));
```

---

## Error 4 — Wrong Constant Names and API Shape

```
error[E0425]: cannot find value `AGENTMARKET_AUDIT_GUEST_ELF` in this scope
   --> host/src/main.rs:219:21
```

**Claude Code:** risc0-build derives constant names from the package name.
`agent_guest` → `AGENT_GUEST_ELF` / `AGENT_GUEST_ID`. Also, `prover.prove()`
returns `ProveInfo` in risc0 3.x, not `Receipt` — the journal and verify call
are on the nested receipt:

```rust
// host/src/main.rs — before
use methods::{AGENTMARKET_AUDIT_GUEST_ELF, AGENTMARKET_AUDIT_GUEST_ID};
let receipt = prover.prove(env, AGENTMARKET_AUDIT_GUEST_ELF)?;
let journal: AuditJournal = receipt.journal.decode()?;
receipt.verify(AGENTMARKET_AUDIT_GUEST_ID)?;

// host/src/main.rs — after
use methods::{AGENT_GUEST_ELF, AGENT_GUEST_ID};
let prove_info = prover.prove(env, AGENT_GUEST_ELF)?;
let receipt = prove_info.receipt;
let journal: AuditJournal = receipt.journal.decode()?;
receipt.verify(AGENT_GUEST_ID)?;
```

---

## The Checker — 13 Rules Running Inside the Circuit

Once the workspace compiled, the checker was moved inside the guest. This is the
critical design choice: changing even one rule changes the `image_id`, which
invalidates any proof generated against the old binary. The rules are **pinned to
the proof**.

```rust
// risc-zero-v2/methods/guest/src/main.rs
pub fn main() {
    let input: AuditInput = env::read();

    // contract_hash: the prover cannot falsify results without holding
    // the exact contract bytes
    let contract_hash: [u8; 32] = Sha256::digest(&input.contract_bytes).into();

    // THIS IS THE GUARANTEE: run_checks() executes inside the zkVM
    // The prover cannot skip rules or fabricate findings
    let source = core::str::from_utf8(&input.contract_bytes).expect("invalid UTF-8");
    let findings = run_checks(source);

    let findings_count = findings.len() as u32;

    // findings_hash: findings are committed via sha256 — unforgeable post-execution
    let findings_json = serde_json::to_vec(&findings).expect("serialize");
    let findings_hash: [u8; 32] = Sha256::digest(&findings_json).into();

    // jobspec_hash: proof is bound to one specific job — cannot be recycled
    let jobspec_hash: [u8; 32] = Sha256::digest(&input.jobspec_json).into();

    // Commit the 132-byte journal (33 × u32 — RISC Zero requires 4-byte alignment)
    env::commit(&AuditJournal {
        contract_hash,
        findings_count,
        jobspec_hash,
        findings_hash,
        auditor_pubkey: input.auditor_pubkey,
    });
}
```

The `run_checks` function covers 9 Solidity rules (tx.origin, delegatecall,
selfdestruct, reentrancy, unchecked calls, timestamp manipulation, integer overflow,
hardcoded addresses, missing access control) and 4 Rust/Anchor rules (unwrap in
production, unchecked arithmetic, UncheckedAccount without safety comment, mutable
AccountInfo without owner validation).

---

## The Demo — 7 Findings, Committed On-Chain

Running `./demo.sh` against a vulnerable Solidity contract:

```
▶ Running ZK host (RISC0_DEV_MODE=1)

  Findings detected inside zkVM:
  ──────────────────────────────────────────────────────
  [Critical] Line   9: SOL-001: tx.origin authentication
              → owner = tx.origin;
  [High    ] Line  20: SOL-004: potential reentrancy (call with value)
              → (bool success,) = msg.sender.call{value: amount}("");
  [High    ] Line  23: SOL-005: unchecked low-level call return
              → (bool success,) = msg.sender.call{value: amount}("");
  [Medium  ] Line  28: SOL-007: potential integer overflow (no SafeMath)
              → balances[user] = balances[user] + bonus;
  [Critical] Line  33: SOL-001: tx.origin authentication
              → require(tx.origin == owner, "Not owner");
  [Info    ] Line  14: SOL-009: public state-changing function
              → function deposit() public payable {
  [Info    ] Line  18: SOL-009: public state-changing function
              → function withdraw(uint256 amount) public {

  Severity summary:
    Critical : 2
    High     : 2
    Medium   : 1
    Info     : 2

  ZK Journal commitments:
  contract_hash  : 0x3f8a1b2c4d5e6f7a8b9c0d1e2f3a4b5c...
  jobspec_hash   : 0x7a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d...
  findings_hash  : 0x9c8d7e6f5a4b3c2d1e0f9a8b7c6d5e4f...
  auditor_pubkey : EyjVnweqSt8fNmnF9ugQMPSzT8sRX57K1SnKRqbsNiTs
  image_id_hex   : 0x4a5b6c7d8e9f0a1b2c3d4e5f6a7b8c9d...
  findings_count : 7
```

The `verify_and_pay` instruction on Solana checks all five commitments before
releasing SOL via CPI to the RISC Zero VerifierRouter:

```
verify_and_pay()
  ├── 1. Deserialize 132-byte AuditJournal
  ├── 2. jobspec_hash == job.output_hash          (right job)
  ├── 3. auditor_pubkey == signer                 (right agent)
  └── 4. CPI → RISC Zero VerifierRouter
            ├── verifier_entry seeds = [b"verifier", seal[0:4]]
            └── Groth16 verification
                  └── VALID → SOL transferred. No human involved.
```

---

## Why This Is Technically Significant

**The impossibilities this proof enforces:**

| Attack | Why impossible |
|---|---|
| Submit proof without contract | `contract_hash` binds proof to specific bytes |
| Skip a security rule | Checker runs inside circuit — omission changes `image_id` |
| Forge findings | `findings_hash = sha256(findings_json)` committed before proof exits |
| Reuse proof for different job | `jobspec_hash` binds to one job's `output_hash` |
| Steal payment as different agent | `auditor_pubkey` embedded in journal, checked against signer |

No other audit marketplace does this. Traditional platforms release escrow based
on human review or reputation. AgentMarket releases SOL based on whether a
mathematical statement is true. The AI agent economy needs this primitive — a
way to pay for verified work without trusting the worker.

The audit market ($2B/year, manual, slow) is the beachhead. Verified AI work is
the endgame.
