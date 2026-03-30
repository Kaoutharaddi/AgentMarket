//! Tipos compartidos entre el guest y el host de AgentMarket.
//!
//! Este crate no tiene dependencias de risc0-zkvm en sí mismo:
//! serde + serde_json son suficientes. El guest y el host añaden
//! risc0-zkvm cada uno en sus propios Cargo.toml.

pub mod checker;

use serde::{Deserialize, Serialize};

/// Input privado que el host pasa al guest a través del canal zkVM.
/// El verifier nunca ve este struct — solo ve AuditJournal.
#[derive(Serialize, Deserialize, Debug)]
pub struct AuditInput {
    /// Contenido completo del contrato (.sol o .rs)
    pub contract_bytes: Vec<u8>,
    /// Jobspec JSON serializado con claves ordenadas.
    /// sha256(jobspec_json) debe coincidir con job.output_hash on-chain.
    pub jobspec_json: Vec<u8>,
    /// Reglas a ejecutar (subconjunto de IDs: "SOL-001", "RS-001", …)
    /// Si está vacío, se ejecutan todas las reglas.
    pub rules_to_check: Vec<String>,
    /// Pubkey Solana del auditor (32 bytes raw)
    pub auditor_pubkey: [u8; 32],
}

/// Journal público que queda commitado en el proof.
/// Este es el struct que el smart contract Anchor deserializa
/// cuando llama a verify_and_pay().
///
/// Layout fijo (104 bytes):
///   [0..32]   contract_hash      — sha256(contract_bytes)
///   [32..36]  findings_count     — número de findings (u32 le)
///   [36..68]  jobspec_hash       — sha256(jobspec_json) ← debe == job.output_hash
///   [68..100] findings_hash      — sha256(findings JSON serializado)
///   [100..132] auditor_pubkey    — Solana pubkey del auditor
///
/// Total: 132 bytes (misma longitud que antes — sin cambio on-chain)
#[derive(Serialize, Deserialize, Debug)]
pub struct AuditJournal {
    /// sha256(contract_bytes) — compromiso sobre el contrato auditado
    pub contract_hash: [u8; 32],
    /// Número de findings detectados por el checker dentro del zkVM
    pub findings_count: u32,
    /// sha256(jobspec_json) — debe coincidir con job.output_hash on-chain
    pub jobspec_hash: [u8; 32],
    /// sha256(findings JSON) — compromiso sobre los hallazgos exactos
    /// El cliente puede recibir el JSON de findings y verificar este hash
    pub findings_hash: [u8; 32],
    /// Pubkey del auditor — el contrato verifica que coincide con el signer
    pub auditor_pubkey: [u8; 32],
}
