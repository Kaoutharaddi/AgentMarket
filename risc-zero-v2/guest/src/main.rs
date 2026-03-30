#![no_main]

use risc0_zkvm::guest::env;
use sha2::{Digest, Sha256};

use agentmarket_audit_shared::{AuditInput, AuditJournal};

risc0_zkvm::guest::entry!(main);

// ─── Guest entry point ────────────────────────────────────────────────────────

fn main() {
    // ── Paso 1: leer AuditInput del host ──────────────────────────────────────
    let input: AuditInput = env::read();

    // ── Paso 2: calcular contract_hash = sha256(contract_bytes) ───────────────
    let contract_hash: [u8; 32] = Sha256::digest(&input.contract_bytes).into();

    // ── Paso 3: verificar que function_names no está vacío ────────────────────
    assert!(
        !input.function_names.is_empty(),
        "function_names no puede estar vacío: el reporte debe cubrir al menos una función"
    );

    let functions_covered: u32 = input
        .function_names
        .len()
        .try_into()
        .expect("demasiadas funciones: no cabe en u32");

    // ── Paso 4: calcular jobspec_hash = sha256(jobspec_json) ──────────────────
    // jobspec_json es el JSON con claves ordenadas que el frontend hashea para
    // producir job.output_hash. verify_and_pay verifica:
    //   journal.jobspec_hash == job.output_hash
    let jobspec_hash: [u8; 32] = Sha256::digest(&input.jobspec_json).into();

    // ── Paso 5: commitear AuditJournal al journal público ─────────────────────
    let journal = AuditJournal {
        contract_hash,
        functions_covered,
        jobspec_hash,
        auditor_pubkey: input.auditor_pubkey,
    };

    env::commit(&journal);
}
