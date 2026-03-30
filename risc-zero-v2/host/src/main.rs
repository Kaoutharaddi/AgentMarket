use std::{fs, path::PathBuf};

use anyhow::{Context, Result};
use clap::Parser;
use risc0_zkvm::{default_prover, ExecutorEnv};
use serde_json::json;

use agentmarket_audit_shared::{checker::Finding, AuditInput, AuditJournal};

include!(concat!(env!("OUT_DIR"), "/methods.rs"));

#[derive(Parser)]
#[command(name = "agentmarket-audit-host")]
struct Args {
    /// Ruta al contrato a auditar (.sol o .rs)
    #[arg(long)]
    contract: PathBuf,

    /// Ruta al jobspec JSON (claves ordenadas: contract_address, contract_code_url,
    /// deadline_hours, vulnerabilities). sha256 de este archivo debe coincidir con
    /// job.output_hash on-chain.
    #[arg(long)]
    jobspec: PathBuf,

    /// Reglas a ejecutar separadas por coma (ej: "SOL-001,SOL-004,RS-001").
    /// Si se omite, se ejecutan todas las reglas.
    #[arg(long, default_value = "")]
    rules: String,

    /// Pubkey Solana del auditor en base58
    #[arg(long)]
    auditor: String,

    /// Archivo de salida
    #[arg(long, default_value = "audit_proof.json")]
    output: PathBuf,
}

fn decode_pubkey(s: &str) -> Result<[u8; 32]> {
    let bytes = bs58::decode(s).into_vec()
        .with_context(|| format!("pubkey base58 inválida: {s}"))?;
    anyhow::ensure!(bytes.len() == 32, "pubkey debe ser 32 bytes, got {}", bytes.len());
    let mut arr = [0u8; 32];
    arr.copy_from_slice(&bytes);
    Ok(arr)
}

fn to_hex(b: &[u8; 32]) -> String {
    format!("0x{}", hex::encode(b))
}

fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::from_default_env())
        .init();

    let args = Args::parse();

    let contract_bytes = fs::read(&args.contract)
        .with_context(|| format!("no se pudo leer {:?}", args.contract))?;
    let jobspec_json = fs::read(&args.jobspec)
        .with_context(|| format!("no se pudo leer {:?}", args.jobspec))?;

    serde_json::from_slice::<serde_json::Value>(&jobspec_json)
        .context("el jobspec no es JSON válido")?;

    let rules_to_check: Vec<String> = if args.rules.is_empty() {
        vec![]
    } else {
        args.rules.split(',').map(|s| s.trim().to_string()).collect()
    };

    let auditor_pubkey = decode_pubkey(&args.auditor)?;

    // Conservar los datos que necesitamos después del prove()
    let contract_source = String::from_utf8_lossy(&contract_bytes).into_owned();
    let rules_to_check_copy = rules_to_check.clone();

    let audit_input = AuditInput {
        contract_bytes,
        jobspec_json,
        rules_to_check,
        auditor_pubkey,
    };

    println!("\nGenerando proof (RISC0_DEV_MODE={})…",
        std::env::var("RISC0_DEV_MODE").unwrap_or_default());

    let env = ExecutorEnv::builder()
        .write(&audit_input)
        .context("no se pudo serializar AuditInput")?
        .build()
        .context("no se pudo construir ExecutorEnv")?;

    let prove_info = default_prover()
        .prove(env, AGENT_GUEST_ELF)
        .context("el proof falló")?;

    let receipt = prove_info.receipt;

    let journal: AuditJournal = receipt.journal.decode()
        .context("no se pudo deserializar AuditJournal")?;

    receipt.verify(AGENT_GUEST_ID)
        .context("verificación local del receipt falló")?;

    // journal_outputs: bytes exactos del AuditJournal — van directo a verify_and_pay.
    // El journal es exactamente 132 bytes (33 palabras de u32), múltiplo de 4.
    let journal_outputs: Vec<u8> = receipt.journal.bytes.clone();

    // Re-ejecutar el checker localmente para generar los findings legibles.
    // El proof garantiza findings_hash — el host solo los materializa para la salida.
    let all_findings = agentmarket_audit_shared::checker::run_checks(&contract_source);
    let findings: Vec<Finding> = if rules_to_check_copy.is_empty() {
        all_findings
    } else {
        all_findings
            .into_iter()
            .filter(|f| rules_to_check_copy.iter().any(|r| f.rule.starts_with(r.as_str())))
            .collect()
    };

    // seal: extraer el Groth16 seal real cuando está disponible (Bonsai / producción).
    let seal: Vec<u8> = match &receipt.inner {
        risc0_zkvm::InnerReceipt::Groth16(g) => {
            g.seal.clone()
        }
        _ => {
            eprintln!("[WARN] Receipt no es Groth16. On-chain verificación fallará.");
            eprintln!("[WARN] Usa Bonsai API (BONSAI_API_KEY + BONSAI_API_URL) para generar proofs reales.");
            bincode::serialize(&receipt).context("no se pudo serializar receipt fallback")?
        }
    };

    // image_id: [u32; 8] → [u8; 32] big-endian.
    let image_id_bytes: Vec<u8> = AGENT_GUEST_ID
        .iter()
        .flat_map(|x| x.to_be_bytes())
        .collect();

    // Agrupar findings por severidad para el resumen
    let critical = findings.iter().filter(|f| f.severity == agentmarket_audit_shared::checker::Severity::Critical).count();
    let high     = findings.iter().filter(|f| f.severity == agentmarket_audit_shared::checker::Severity::High).count();
    let medium   = findings.iter().filter(|f| f.severity == agentmarket_audit_shared::checker::Severity::Medium).count();
    let info     = findings.iter().filter(|f| f.severity == agentmarket_audit_shared::checker::Severity::Info).count();

    let out = json!({
        "contract_hash":       to_hex(&journal.contract_hash),
        "findings_count":      journal.findings_count,
        "findings":            findings,
        "findings_hash":       to_hex(&journal.findings_hash),
        "jobspec_hash":        to_hex(&journal.jobspec_hash),
        "auditor_pubkey":      bs58::encode(&journal.auditor_pubkey).into_string(),
        "proof_size_bytes":    seal.len(),
        "seal_hex":            hex::encode(&seal),
        "journal_outputs_hex": hex::encode(&journal_outputs),
        "image_id_hex":        hex::encode(&image_id_bytes),
        "image_id":            image_id_bytes,
        "severity_summary": {
            "critical": critical,
            "high":     high,
            "medium":   medium,
            "info":     info,
        }
    });

    fs::write(&args.output, serde_json::to_string_pretty(&out)?)
        .with_context(|| format!("no se pudo escribir {:?}", args.output))?;

    println!("\n✓ Proof generado: {} findings", journal.findings_count);
    println!("  CRITICAL: {}  HIGH: {}  MEDIUM: {}  INFO: {}", critical, high, medium, info);
    println!("  contract_hash:  {}", to_hex(&journal.contract_hash));
    println!("  jobspec_hash:   {}", to_hex(&journal.jobspec_hash));
    println!("  findings_hash:  {}", to_hex(&journal.findings_hash));
    println!("  journal_bytes:  {} bytes", journal_outputs.len());
    println!("  proof_size:     {} bytes", seal.len());
    println!("  guardado en:    {:?}", args.output);

    Ok(())
}
