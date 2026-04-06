/// Reglas de seguridad deterministas que corren DENTRO del zkVM.
///
/// Cada regla recibe el source del contrato y retorna findings.
/// El resultado se commitea en el journal — el cliente puede verificar
/// matemáticamente que estas reglas se ejecutaron sobre este contrato exacto.

#[derive(serde::Serialize, serde::Deserialize, Debug, Clone)]
pub struct Finding {
    pub rule:     String,
    pub line:     u32,
    pub severity: Severity,
    pub snippet:  String,  // ≤ 80 chars
}

#[derive(serde::Serialize, serde::Deserialize, Debug, Clone, PartialEq)]
pub enum Severity {
    Critical,
    High,
    Medium,
    Info,
}

/// Ejecuta todas las reglas sobre `source` y retorna los findings.
pub fn run_checks(source: &str) -> Vec<Finding> {
    let mut findings = Vec::new();
    // Pre-collect so we can look ahead (SOL-005) and look behind (RS-003).
    let lines: Vec<&str> = source.lines().collect();

    for (i, raw_line) in lines.iter().enumerate() {
        let line_no = (i + 1) as u32;
        let line = raw_line.trim();
        // Skip comments
        if line.starts_with("//") || line.starts_with("*") || line.starts_with("/*") {
            continue;
        }

        // ── Solidity rules ────────────────────────────────────────────────────

        // CRITICAL: tx.origin used for auth (phishing vector)
        if line.contains("tx.origin") {
            findings.push(Finding {
                rule: "SOL-001: tx.origin authentication".to_string(),
                line: line_no,
                severity: Severity::Critical,
                snippet: truncate(line),
            });
        }

        // CRITICAL: delegatecall to arbitrary address
        if line.contains("delegatecall") && !line.contains("//") {
            findings.push(Finding {
                rule: "SOL-002: delegatecall".to_string(),
                line: line_no,
                severity: Severity::Critical,
                snippet: truncate(line),
            });
        }

        // HIGH: selfdestruct
        if line.contains("selfdestruct(") || line.contains("suicide(") {
            findings.push(Finding {
                rule: "SOL-003: selfdestruct".to_string(),
                line: line_no,
                severity: Severity::High,
                snippet: truncate(line),
            });
        }

        // HIGH: reentrancy pattern — external call before state change
        if (line.contains(".call{") || line.contains(".call("))
            && line.contains("value:")
        {
            findings.push(Finding {
                rule: "SOL-004: potential reentrancy (call with value)".to_string(),
                line: line_no,
                severity: Severity::High,
                snippet: truncate(line),
            });
        }

        // HIGH: unchecked return value from low-level call.
        // The require() / bool check may appear on the same line OR on either
        // of the next 2 lines (e.g. `bool ok = addr.send(v);` split across
        // lines, or `require(ok, "failed");` immediately after).
        if line.contains(".send(") || line.contains(".call(") {
            let window_end = (i + 3).min(lines.len());
            let window_has_check = lines[i..window_end]
                .iter()
                .any(|l| {
                    let t = l.trim();
                    t.contains("require(") || t.contains("bool ")
                });
            if !window_has_check {
                findings.push(Finding {
                    rule: "SOL-005: unchecked low-level call return".to_string(),
                    line: line_no,
                    severity: Severity::High,
                    snippet: truncate(line),
                });
            }
        }

        // MEDIUM: block.timestamp used for logic (miner manipulation)
        if line.contains("block.timestamp") && (line.contains("==") || line.contains("<=") || line.contains(">=")) {
            findings.push(Finding {
                rule: "SOL-006: block.timestamp comparison".to_string(),
                line: line_no,
                severity: Severity::Medium,
                snippet: truncate(line),
            });
        }

        // MEDIUM: integer overflow (pre-0.8.0 pattern)
        if line.contains("+ ") && line.contains("uint") && !line.contains("SafeMath") {
            findings.push(Finding {
                rule: "SOL-007: potential integer overflow (no SafeMath)".to_string(),
                line: line_no,
                severity: Severity::Medium,
                snippet: truncate(line),
            });
        }

        // MEDIUM: hardcoded address (deployment fragility)
        if contains_hex_address(line) {
            findings.push(Finding {
                rule: "SOL-008: hardcoded address".to_string(),
                line: line_no,
                severity: Severity::Medium,
                snippet: truncate(line),
            });
        }

        // INFO: public function with no access control
        if line.contains("function ")
            && line.contains("public")
            && !line.contains("view")
            && !line.contains("pure")
            && !line.contains("onlyOwner")
            && !line.contains("onlyRole")
        {
            findings.push(Finding {
                rule: "SOL-009: public state-changing function (verify access control)".to_string(),
                line: line_no,
                severity: Severity::Info,
                snippet: truncate(line),
            });
        }

        // ── Solana / Rust rules ───────────────────────────────────────────────

        // HIGH: unwrap() in production code (panic = transaction abort)
        if line.contains(".unwrap()") && !line.contains("#[test]") {
            findings.push(Finding {
                rule: "RS-001: unwrap() — panics abort the transaction".to_string(),
                line: line_no,
                severity: Severity::High,
                snippet: truncate(line),
            });
        }

        // HIGH: unchecked arithmetic in Rust (integer overflow)
        if line.contains("unchecked {") {
            findings.push(Finding {
                rule: "RS-002: unchecked arithmetic block".to_string(),
                line: line_no,
                severity: Severity::High,
                snippet: truncate(line),
            });
        }

        // CRITICAL: UncheckedAccount without safety comment.
        // Anchor allows `/// CHECK:` on the line immediately before the field
        // declaration, so we inspect both the current line and line i-1.
        if line.contains("UncheckedAccount") {
            let prev_has_check = i > 0 && lines[i - 1].trim().contains("/// CHECK:");
            let curr_has_check = line.contains("/// CHECK:");
            if !curr_has_check && !prev_has_check {
                findings.push(Finding {
                    rule: "RS-003: UncheckedAccount without CHECK comment".to_string(),
                    line: line_no,
                    severity: Severity::Critical,
                    snippet: truncate(line),
                });
            }
        }

        // MEDIUM: owner not validated
        if line.contains("AccountInfo") && line.contains("mut") && !line.contains("owner") {
            findings.push(Finding {
                rule: "RS-004: mutable AccountInfo — verify owner check exists".to_string(),
                line: line_no,
                severity: Severity::Medium,
                snippet: truncate(line),
            });
        }

        // INFO: TODO / FIXME comments
        if line.to_uppercase().contains("TODO") || line.to_uppercase().contains("FIXME") {
            findings.push(Finding {
                rule: "INF-001: TODO/FIXME marker".to_string(),
                line: line_no,
                severity: Severity::Info,
                snippet: truncate(line),
            });
        }
    }
    findings
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    fn has_rule(findings: &[Finding], rule_prefix: &str) -> bool {
        findings.iter().any(|f| f.rule.starts_with(rule_prefix))
    }

    // ── SOL-005 ───────────────────────────────────────────────────────────────

    /// require() en la MISMA línea → no debe disparar SOL-005.
    #[test]
    fn sol005_no_finding_when_require_same_line() {
        let src = r#"require(addr.send(amount), "failed");"#;
        assert!(!has_rule(&run_checks(src), "SOL-005"));
    }

    /// bool en la MISMA línea → no debe disparar SOL-005.
    #[test]
    fn sol005_no_finding_when_bool_same_line() {
        let src = r#"bool ok = addr.send(amount);"#;
        assert!(!has_rule(&run_checks(src), "SOL-005"));
    }

    /// require() en la línea SIGUIENTE → no debe disparar SOL-005.
    #[test]
    fn sol005_no_finding_when_require_next_line() {
        let src = "addr.send(amount);\nrequire(ok, \"failed\");";
        assert!(!has_rule(&run_checks(src), "SOL-005"), "require on next line should suppress SOL-005");
    }

    /// bool en 2 líneas más adelante → no debe disparar SOL-005.
    #[test]
    fn sol005_no_finding_when_bool_two_lines_ahead() {
        let src = "addr.send(amount);\n// comment\nbool ok = true;";
        assert!(!has_rule(&run_checks(src), "SOL-005"), "bool two lines ahead should suppress SOL-005");
    }

    /// Sin require ni bool en las 3 líneas → SÍ debe disparar SOL-005.
    #[test]
    fn sol005_finding_when_no_check_in_window() {
        let src = "addr.send(amount);\nbalance -= amount;\nemit Sent();";
        assert!(has_rule(&run_checks(src), "SOL-005"), "missing check should fire SOL-005");
    }

    /// require() a 3+ líneas de distancia → SÍ debe disparar SOL-005
    /// (ventana de solo 2 líneas de look-ahead).
    #[test]
    fn sol005_finding_when_require_outside_window() {
        let src = "addr.send(amount);\nfoo();\nbar();\nrequire(ok);";
        assert!(has_rule(&run_checks(src), "SOL-005"), "require outside window should still fire SOL-005");
    }

    // ── RS-003 ────────────────────────────────────────────────────────────────

    /// `/// CHECK:` en la MISMA línea → no debe disparar RS-003.
    #[test]
    fn rs003_no_finding_when_check_same_line() {
        let src = r#"pub foo: UncheckedAccount<'info>, /// CHECK: verified by seeds"#;
        assert!(!has_rule(&run_checks(src), "RS-003"));
    }

    /// `/// CHECK:` en la línea ANTERIOR → no debe disparar RS-003.
    #[test]
    fn rs003_no_finding_when_check_prev_line() {
        let src = "/// CHECK: owner validated via seeds\npub foo: UncheckedAccount<'info>,";
        assert!(!has_rule(&run_checks(src), "RS-003"), "CHECK on prev line should suppress RS-003");
    }

    /// Sin `/// CHECK:` en ninguna de las dos líneas → SÍ debe disparar RS-003.
    #[test]
    fn rs003_finding_when_no_check_comment() {
        let src = "// some other comment\npub foo: UncheckedAccount<'info>,";
        assert!(has_rule(&run_checks(src), "RS-003"), "missing CHECK should fire RS-003");
    }

    /// Primera línea del archivo con UncheckedAccount (i=0, sin línea anterior) → SÍ dispara.
    #[test]
    fn rs003_finding_at_first_line() {
        let src = "pub foo: UncheckedAccount<'info>,";
        assert!(has_rule(&run_checks(src), "RS-003"));
    }
}

fn truncate(s: &str) -> String {
    let s = s.trim();
    if s.len() <= 80 {
        s.to_string()
    } else {
        format!("{}…", &s[..77])
    }
}

fn contains_hex_address(line: &str) -> bool {
    // Looks for 0x followed by exactly 40 hex chars (Ethereum) or 64 hex chars (Solana)
    let bytes = line.as_bytes();
    let mut i = 0;
    while i + 2 < bytes.len() {
        if bytes[i] == b'0' && bytes[i + 1] == b'x' {
            let start = i + 2;
            let mut end = start;
            while end < bytes.len() && bytes[end].is_ascii_hexdigit() {
                end += 1;
            }
            let len = end - start;
            if len == 40 || len == 64 {
                return true;
            }
        }
        i += 1;
    }
    false
}
