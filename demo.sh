#!/usr/bin/env bash
# =============================================================================
# AgentMarket — End-to-End Demo (Dev Mode)
# =============================================================================
# Demonstrates the complete ZK audit flow:
#   contract source → zkVM execution → proof → on-chain verifiable commitment
#
# Prerequisites:
#   - solana CLI (configured for devnet)
#   - anchor CLI
#   - python3
#   - risc-zero-v2/target/release/agentmarket-audit-host (built)
#
# Usage:
#   ./demo.sh                          # uses solana address as auditor pubkey
#   AUDITOR=<base58-pubkey> ./demo.sh  # specify auditor manually
#
# Production note:
#   This demo runs with RISC0_DEV_MODE=1, which produces a fake STARK receipt.
#   Real Groth16 proofs for on-chain verification require a Bonsai API key.
# =============================================================================

set -euo pipefail

# ── Colors ────────────────────────────────────────────────────────────────────
BOLD='\033[1m'
DIM='\033[2m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
CYAN='\033[0;36m'
RED='\033[0;31m'
BLUE='\033[0;34m'
RESET='\033[0m'

# ── Helpers ───────────────────────────────────────────────────────────────────
step()    { echo -e "\n${BOLD}${BLUE}▶ $*${RESET}"; }
ok()      { echo -e "  ${GREEN}✓${RESET} $*"; }
warn()    { echo -e "  ${YELLOW}⚠${RESET}  $*"; }
fail()    { echo -e "  ${RED}✗${RESET} $*"; exit 1; }
info()    { echo -e "  ${DIM}$*${RESET}"; }
header()  {
  echo -e "\n${BOLD}${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
  echo -e "${BOLD}${CYAN}  $*${RESET}"
  echo -e "${BOLD}${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
}
divider() { echo -e "${DIM}  ────────────────────────────────────────────────${RESET}"; }

# ── Constants ─────────────────────────────────────────────────────────────────
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ZK_HOST="${ZK_HOST_BINARY:-${REPO_ROOT}/risc-zero-v2/target/release/agentmarket-audit-host}"
PROGRAM_ID="EyjVnweqSt8fNmnF9ugQMPSzT8sRX57K1SnKRqbsNiTs"
CONTRACT_PATH="/tmp/demo_contract.sol"
JOBSPEC_PATH="/tmp/demo_jobspec.json"
PROOF_PATH="/tmp/demo_proof.json"

# =============================================================================
header "AgentMarket — ZK Audit Demo"
# =============================================================================
echo -e "  ${DIM}Program: ${PROGRAM_ID}${RESET}"
echo -e "  ${DIM}Network: Devnet (Solana)${RESET}"
echo -e "  ${DIM}Mode:    RISC0_DEV_MODE=1 (fake seal, real logic)${RESET}"

# ── 1. Prerequisites ──────────────────────────────────────────────────────────
step "Checking prerequisites"

if command -v solana &>/dev/null; then
  SOLANA_VER=$(solana --version 2>&1 | head -1)
  ok "solana CLI: ${SOLANA_VER}"
else
  fail "solana CLI not found. Install: https://docs.solanalabs.com/cli/install"
fi

if command -v anchor &>/dev/null; then
  ANCHOR_VER=$(anchor --version 2>&1 | head -1)
  ok "anchor CLI: ${ANCHOR_VER}"
else
  fail "anchor CLI not found. Install: https://www.anchor-lang.com/docs/installation"
fi

if command -v python3 &>/dev/null; then
  PYTHON_VER=$(python3 --version 2>&1)
  ok "python3: ${PYTHON_VER}"
else
  fail "python3 not found"
fi

if [[ -f "${ZK_HOST}" ]]; then
  ok "ZK host binary: ${ZK_HOST}"
else
  echo -e "  ${RED}✗${RESET} ZK host binary not found at: ${ZK_HOST}"
  echo ""
  echo -e "  ${YELLOW}Build it with:${RESET}"
  echo -e "  ${DIM}  cd risc-zero-v2 && cargo build --release${RESET}"
  echo ""
  fail "Missing ZK host binary"
fi

# Resolve auditor pubkey
if [[ -n "${AUDITOR:-}" ]]; then
  AUDITOR_PUBKEY="${AUDITOR}"
  ok "Auditor pubkey (env): ${AUDITOR_PUBKEY}"
elif solana address &>/dev/null 2>&1; then
  AUDITOR_PUBKEY=$(solana address)
  ok "Auditor pubkey (solana address): ${AUDITOR_PUBKEY}"
else
  warn "solana address not configured; using demo pubkey"
  AUDITOR_PUBKEY="EyjVnweqSt8fNmnF9ugQMPSzT8sRX57K1SnKRqbsNiTs"
  info "Set AUDITOR=<pubkey> or run: solana config set --url devnet"
fi

# ── 2. Create vulnerable contract ─────────────────────────────────────────────
step "Creating vulnerable Solidity contract → ${CONTRACT_PATH}"

cat > "${CONTRACT_PATH}" << 'SOLIDITY'
// SPDX-License-Identifier: MIT
pragma solidity ^0.7.6;

// Demo contract with intentional security vulnerabilities for AgentMarket audit.
// DO NOT deploy — for demonstration purposes only.
contract VulnerableVault {
    mapping(address => uint256) public balances;
    address public owner;

    constructor() {
        owner = tx.origin;  // SOL-001: tx.origin used for auth
    }

    // SOL-009: public function without access control modifier
    function deposit() public payable {
        balances[msg.sender] += msg.value;
    }

    // SOL-004: reentrancy vulnerability — state updated after external call
    function withdraw(uint256 amount) public {
        require(balances[msg.sender] >= amount, "Insufficient balance");
        // Vulnerable: external call before state update
        (bool success,) = msg.sender.call{value: amount}("");
        require(success, "Transfer failed");
        balances[msg.sender] -= amount;  // state updated AFTER call
    }

    // SOL-007: integer arithmetic without overflow check (pre-0.8)
    function addReward(address user, uint256 bonus) public {
        balances[user] = balances[user] + bonus;
    }

    // SOL-009: public admin function with tx.origin check instead of msg.sender
    function emergencyWithdraw() public {
        require(tx.origin == owner, "Not owner");  // SOL-001 again
        payable(owner).transfer(address(this).balance);
    }
}
SOLIDITY

CONTRACT_LINES=$(wc -l < "${CONTRACT_PATH}" | tr -d ' ')
ok "Contract created (${CONTRACT_LINES} lines, 3 intentional vulnerabilities)"
info "  SOL-001: tx.origin used for authentication"
info "  SOL-004: reentrancy — call before state update"
info "  SOL-009: public functions without access control"

# ── 3. Create jobspec ─────────────────────────────────────────────────────────
step "Creating jobspec → ${JOBSPEC_PATH}"

# Keys must be sorted alphabetically — sha256 of this file = job.output_hash on-chain
python3 -c "
import json, sys
jobspec = {
    'contract_address': '0x0000000000000000000000000000000000000000',
    'contract_code_url': 'ipfs://QmDemo000000000000000000000000000000000000000',
    'deadline_hours': '24',
    'vulnerabilities': sorted(['reentrancy_attacks', 'access_control', 'integer_overflow'])
}
# Sorted keys + no extra whitespace — deterministic hash for on-chain matching
print(json.dumps(jobspec, sort_keys=True, separators=(',', ':')))
" > "${JOBSPEC_PATH}"

JOBSPEC_HASH=$(python3 -c "
import hashlib, sys
data = open('${JOBSPEC_PATH}', 'rb').read()
print('0x' + hashlib.sha256(data).hexdigest())
")

ok "Jobspec created"
info "  jobspec_hash (= job.output_hash on-chain): ${JOBSPEC_HASH}"

# ── 4. Run ZK host in dev mode ────────────────────────────────────────────────
step "Running ZK host (RISC0_DEV_MODE=1)"
echo ""
echo -e "  ${DIM}Command:${RESET}"
echo -e "  ${DIM}  RISC0_DEV_MODE=1 ${ZK_HOST} \\${RESET}"
echo -e "  ${DIM}    --contract ${CONTRACT_PATH} \\${RESET}"
echo -e "  ${DIM}    --jobspec  ${JOBSPEC_PATH} \\${RESET}"
echo -e "  ${DIM}    --auditor  ${AUDITOR_PUBKEY} \\${RESET}"
echo -e "  ${DIM}    --output   ${PROOF_PATH}${RESET}"
echo ""

RUST_LOG=warn RISC0_DEV_MODE=1 "${ZK_HOST}" \
  --contract "${CONTRACT_PATH}" \
  --jobspec  "${JOBSPEC_PATH}" \
  --auditor  "${AUDITOR_PUBKEY}" \
  --output   "${PROOF_PATH}"

if [[ ! -f "${PROOF_PATH}" ]]; then
  fail "ZK host did not produce output at ${PROOF_PATH}"
fi

# ── 5. Parse and display proof ────────────────────────────────────────────────
step "Parsing proof output"

python3 << PYEOF
import json, sys

with open("${PROOF_PATH}") as f:
    p = json.load(f)

RESET  = '\033[0m'
BOLD   = '\033[1m'
DIM    = '\033[2m'
GREEN  = '\033[0;32m'
YELLOW = '\033[0;33m'
CYAN   = '\033[0;36m'
RED    = '\033[0;31m'

findings = p.get("findings", [])
severity_map = {
    "Critical": RED + BOLD,
    "High":     RED,
    "Medium":   YELLOW,
    "Info":     DIM,
}

print()
print(f"  {BOLD}Findings detected inside zkVM:{RESET}")
print(f"  {'─'*52}")
for f in findings:
    sev   = f.get("severity", "?")
    color = severity_map.get(sev, "")
    rule  = f.get("rule", "")
    line  = f.get("line", "?")
    snip  = f.get("snippet", "").strip()
    print(f"  {color}[{sev:8s}]{RESET} Line {line:3}: {rule}")
    print(f"  {DIM}            → {snip}{RESET}")

s = p.get("severity_summary", {})
print()
print(f"  {BOLD}Severity summary:{RESET}")
print(f"  {RED+BOLD}  Critical : {s.get('critical', 0)}{RESET}")
print(f"  {RED}  High     : {s.get('high', 0)}{RESET}")
print(f"  {YELLOW}  Medium   : {s.get('medium', 0)}{RESET}")
print(f"  {DIM}  Info     : {s.get('info', 0)}{RESET}")

print()
print(f"  {'─'*52}")
print(f"  {BOLD}ZK Journal commitments:{RESET}")
print(f"  {DIM}contract_hash  {RESET}: {p.get('contract_hash', '')}")
print(f"  {DIM}jobspec_hash   {RESET}: {p.get('jobspec_hash', '')}")
print(f"  {DIM}findings_hash  {RESET}: {p.get('findings_hash', '')}")
print(f"  {DIM}auditor_pubkey {RESET}: {p.get('auditor_pubkey', '')}")
print(f"  {DIM}image_id_hex   {RESET}: {p.get('image_id_hex', '')}")
print(f"  {DIM}findings_count {RESET}: {p.get('findings_count', 0)}")
print(f"  {DIM}proof_size     {RESET}: {p.get('proof_size_bytes', 0):,} bytes")
PYEOF

# ── 6. Final summary ──────────────────────────────────────────────────────────
header "Demo Complete"

CONTRACT_HASH=$(python3 -c "import json; p=json.load(open('${PROOF_PATH}')); print(p['contract_hash'])")
FINDINGS_HASH=$(python3 -c "import json; p=json.load(open('${PROOF_PATH}')); print(p['findings_hash'])")
FINDINGS_COUNT=$(python3 -c "import json; p=json.load(open('${PROOF_PATH}')); print(p['findings_count'])")
IMAGE_ID=$(python3 -c "import json; p=json.load(open('${PROOF_PATH}')); print(p['image_id_hex'])")

echo ""
ok "ZK proof generated (${PROOF_PATH})"
ok "Guest program executed inside RISC Zero zkVM"
ok "${FINDINGS_COUNT} findings detected and committed inside the proof"
ok "contract_hash  : ${CONTRACT_HASH}"
ok "findings_hash  : ${FINDINGS_HASH}"
ok "jobspec_hash   : ${JOBSPEC_HASH}"
ok "image_id       : ${IMAGE_ID}"
divider
warn "Dev mode seal (RISC0_DEV_MODE=1): proof is not verifiable on-chain"
warn "Production: set BONSAI_API_KEY to generate real Groth16 proofs"
divider
echo ""
echo -e "  ${BOLD}What this proof guarantees (cryptographically):${RESET}"
info "  • The auditor held the exact contract bytes (contract_hash)"
info "  • The security rules ran inside the zkVM on those bytes (findings_hash)"
info "  • The job matches the client's spec (jobspec_hash = job.output_hash)"
info "  • The auditor identity is bound to this proof (auditor_pubkey)"
info "  • The guest program is the authorized one (image_id = AGENT_GUEST_ID)"
echo ""
echo -e "  ${BOLD}Next steps:${RESET}"
info "  1. Create a job on-chain:   agentmarket-frontend → Submit Audit"
info "  2. Run the agent:           cd agentmarket-agent && python agent.py"
info "  3. Generate Groth16 proof:  export BONSAI_API_KEY=<your-key>"
info "  4. Verify on-chain:         verify_and_pay instruction (Devnet)"
echo ""
echo -e "  ${DIM}Program ID:  ${PROGRAM_ID}${RESET}"
echo -e "  ${DIM}Explorer:    https://explorer.solana.com/address/${PROGRAM_ID}?cluster=devnet${RESET}"
echo ""
