#![no_main]
risc0_zkvm::guest::entry!(main);

use risc0_zkvm::guest::env;
use sha2::{Digest, Sha256};

use agentmarket_audit_shared::{
    checker::{run_checks, Finding},
    AuditInput, AuditJournal,
};

pub fn main() {
    let input: AuditInput = env::read();

    // ── 1. contract_hash ─────────────────────────────────────────────────────
    // Compromiso sobre el contrato completo. El prover no puede falsificar
    // ningún resultado sin también poseer los contract_bytes reales.
    let contract_hash: [u8; 32] = Sha256::digest(&input.contract_bytes).into();

    // ── 2. Ejecutar reglas de seguridad DENTRO del zkVM ──────────────────────
    // Esta es la garantía central: el cliente sabe matemáticamente que
    // run_checks() se ejecutó sobre estos contract_bytes exactos.
    // El prover no puede omitir reglas ni falsificar findings.
    let source = core::str::from_utf8(&input.contract_bytes)
        .expect("contract_bytes no es UTF-8 válido");

    let all_findings = run_checks(source);

    // Filtrar por reglas solicitadas si se especificaron
    let findings: Vec<Finding> = if input.rules_to_check.is_empty() {
        all_findings
    } else {
        all_findings
            .into_iter()
            .filter(|f| {
                input.rules_to_check.iter().any(|r| f.rule.starts_with(r.as_str()))
            })
            .collect()
    };

    let findings_count = findings.len() as u32;

    // ── 3. findings_hash ─────────────────────────────────────────────────────
    // Serialize findings a JSON determinista y hashear.
    // El cliente recibe este JSON off-chain y puede verificar que
    // sha256(findings_json) == findings_hash del journal.
    let findings_json = serde_json::to_vec(&findings)
        .expect("no se pudo serializar findings");
    let findings_hash: [u8; 32] = Sha256::digest(&findings_json).into();

    // ── 4. jobspec_hash — ligadura con el job on-chain ───────────────────────
    let jobspec_hash: [u8; 32] = Sha256::digest(&input.jobspec_json).into();

    // ── 5. Commit journal ────────────────────────────────────────────────────
    let journal = AuditJournal {
        contract_hash,
        findings_count,
        jobspec_hash,
        findings_hash,
        auditor_pubkey: input.auditor_pubkey,
    };

    // Solo commitear el journal fijo (132 bytes = 33 palabras).
    // RISC Zero requiere que el journal sea múltiplo de 4 bytes.
    // El host re-ejecuta el checker localmente para los findings legibles;
    // findings_hash en el journal los vincula matemáticamente al proof.
    env::commit(&journal);
}
