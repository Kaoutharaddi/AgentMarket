from job_spec import SmartContractAuditJob, compute_hashes
from agent import JobExecutor
from datetime import datetime, timezone
import hashlib, json, httpx
from unittest.mock import patch

contract_code = """
pragma solidity ^0.8.0;
contract Vulnerable {
    mapping(address => uint) balances;
    function withdraw() public {
        uint amount = balances[msg.sender];
        (bool success,) = msg.sender.call{value: amount}("");
        require(success);
        balances[msg.sender] = 0;
    }
}
"""

expected = hashlib.sha256(b"audit_result").hexdigest()

job = SmartContractAuditJob(
    schema_version="1.0",
    job_id="audit-test-001",
    title="Test reentrancy audit",
    job_type="smart_contract_audit",
    expected_output_hash=expected,
    timeout_seconds=3600,
    created_at=datetime.now(timezone.utc),
    contract_name="Vulnerable",
    contract_address="EyjVnweqSt8fNmnF9ugQMPSzT8sRX57K1SnKRqbsNiTs",
    contract_code_url="ipfs://QmTest",
    chain="ethereum",
    vulnerabilities_to_check=["reentrancy", "access_control"],
    severity_threshold="low",
    deadline_hours=24
)

def mock_get(self, url, **kwargs):
    class R:
        content = contract_code.encode()
        def raise_for_status(self): pass
    return R()

executor = JobExecutor()
with patch.object(httpx.Client, 'get', mock_get):
    result = executor._execute_audit(job)

report = json.loads(result)
print(f"Contrato: {report['contract_address']}")
print(f"Líneas revisadas: {report['lines_reviewed']}")
print(f"Vulnerabilidades: {len(report['vulnerabilities_found'])}")
print(f"Audit hash: {report['audit_hash']}")
print("OK — agente auditor funciona")
