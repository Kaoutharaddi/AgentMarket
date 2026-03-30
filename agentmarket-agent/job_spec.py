"""
AgentMarket — JobSpec v1.0
==========================
Capa 2 del marketplace descentralizado en Solana.

Contenido:
  - Cuatro modelos Pydantic v2 discriminados por job_type:
      CodeTestJob | ClassificationJob | ExtractionJob | SmartContractAuditJob
  - AuditReport con VulnerabilityFinding como submodelo
  - Union discriminada JobSpec lista para TypeAdapter
  - compute_hashes() → (input_hash, output_hash) como bytes[32] para Anchor
  - verify_audit_report() → bool

Dependencias: pydantic>=2.0, hashlib, json (stdlib)
"""

from __future__ import annotations

import hashlib
import json
import re
from datetime import datetime
from typing import Annotated, Literal, Union

from pydantic import BaseModel, Discriminator, Field, Tag, TypeAdapter, model_validator


# ─── constantes ───────────────────────────────────────────────────────────────

SCHEMA_VERSION = "1.0"
_HEX64_RE = re.compile(r"^[0-9a-f]{64}$")


# ─── sub-modelos ──────────────────────────────────────────────────────────────

class InputRef(BaseModel):
    """Referencia a un artefacto en IPFS con integridad sha256."""

    ipfs_url: str = Field(pattern=r"^ipfs://")
    sha256: str = Field(pattern=r"^[0-9a-f]{64}$")

    model_config = {"extra": "forbid"}


class TestSuite(BaseModel):
    """Ubicación del test suite y runtime requerido."""

    ipfs_url: str = Field(pattern=r"^ipfs://")
    sha256: str = Field(pattern=r"^[0-9a-f]{64}$")
    runner: Literal["pytest", "jest"]

    model_config = {"extra": "forbid"}


# ─── tipos de job ─────────────────────────────────────────────────────────────

class CodeTestJob(BaseModel):
    """
    job_type = 'code_test'
    El agente descarga el test suite desde IPFS, lo ejecuta con pytest o jest
    y entrega sha256(output) == expected_output_hash para cobrar.
    """

    schema_version: Literal["1.0"]
    job_id: str
    title: str = Field(min_length=1, max_length=120)
    job_type: Literal["code_test"]
    inputs: InputRef
    expected_output_hash: str
    timeout_seconds: int = Field(ge=10, le=86400)
    created_at: datetime
    test_suite: TestSuite

    model_config = {"extra": "forbid"}

    @model_validator(mode="after")
    def _validate_output_hash(self) -> "CodeTestJob":
        if not _HEX64_RE.match(self.expected_output_hash):
            raise ValueError(
                f"expected_output_hash debe tener exactamente 64 caracteres hex; "
                f"recibido: {len(self.expected_output_hash)} chars"
            )
        return self


class ClassificationJob(BaseModel):
    """
    job_type = 'classification'
    El agente clasifica el input en una de las categorías definidas
    con confianza mínima >= min_confidence.
    """

    schema_version: Literal["1.0"]
    job_id: str
    title: str = Field(min_length=1, max_length=120)
    job_type: Literal["classification"]
    inputs: InputRef
    expected_output_hash: str
    timeout_seconds: int = Field(ge=10, le=86400)
    created_at: datetime
    categories: list[str] = Field(min_length=2)
    min_confidence: float = Field(ge=0.0, le=1.0)

    model_config = {"extra": "forbid"}

    @model_validator(mode="after")
    def _validate_output_hash(self) -> "ClassificationJob":
        if not _HEX64_RE.match(self.expected_output_hash):
            raise ValueError(
                f"expected_output_hash debe tener exactamente 64 caracteres hex; "
                f"recibido: {len(self.expected_output_hash)} chars"
            )
        return self


class ExtractionJob(BaseModel):
    """
    job_type = 'extraction'
    El agente extrae los campos especificados del documento en inputs
    y devuelve el resultado en json o csv.
    """

    schema_version: Literal["1.0"]
    job_id: str
    title: str = Field(min_length=1, max_length=120)
    job_type: Literal["extraction"]
    inputs: InputRef
    expected_output_hash: str
    timeout_seconds: int = Field(ge=10, le=86400)
    created_at: datetime
    fields_to_extract: list[str] = Field(min_length=1)
    output_format: Literal["json", "csv"]

    model_config = {"extra": "forbid"}

    @model_validator(mode="after")
    def _validate_output_hash(self) -> "ExtractionJob":
        if not _HEX64_RE.match(self.expected_output_hash):
            raise ValueError(
                f"expected_output_hash debe tener exactamente 64 caracteres hex; "
                f"recibido: {len(self.expected_output_hash)} chars"
            )
        return self


# ─── constantes de auditoría ──────────────────────────────────────────────────

VALID_VULNERABILITIES = frozenset({
    "reentrancy",
    "integer_overflow",
    "access_control",
    "flash_loan",
    "oracle_manipulation",
    "signer_check",
    "cpi_validation",
    "pdas_validation",
})

VALID_SEVERITIES = ("low", "medium", "high", "critical")

_SOLANA_PUBKEY_RE = re.compile(r"^[1-9A-HJ-NP-Za-km-z]{32,44}$")


class SmartContractAuditJob(BaseModel):
    """
    job_type = 'smart_contract_audit'
    El agente descarga el código fuente desde IPFS, analiza las vulnerabilidades
    solicitadas y entrega un AuditReport cuyo audit_hash == expected_output_hash.

    input_hash  = sha256(contract_address + chain + contract_code_url)
    output_hash = expected_output_hash  (= audit_hash del reporte entregado)
    """

    schema_version: Literal["1.0"]
    job_id: str
    title: str = Field(min_length=1, max_length=120)
    job_type: Literal["smart_contract_audit"]
    expected_output_hash: str
    timeout_seconds: int = Field(ge=10, le=86400)
    created_at: datetime
    contract_name: str = Field(min_length=1, max_length=120)
    contract_address: str
    contract_code_url: str = Field(pattern=r"^ipfs://")
    chain: Literal["solana", "ethereum"]
    vulnerabilities_to_check: list[str] = Field(min_length=1)
    severity_threshold: Literal["low", "medium", "high", "critical"]
    deadline_hours: int = Field(ge=1, le=72)

    model_config = {"extra": "forbid"}

    @model_validator(mode="after")
    def _validate_fields(self) -> "SmartContractAuditJob":
        if not _HEX64_RE.match(self.expected_output_hash):
            raise ValueError(
                f"expected_output_hash debe tener exactamente 64 caracteres hex; "
                f"recibido: {len(self.expected_output_hash)} chars"
            )
        if self.chain == "solana" and not _SOLANA_PUBKEY_RE.match(self.contract_address):
            raise ValueError(
                f"contract_address no parece una pubkey Solana válida (base58, 32-44 chars): "
                f"{self.contract_address!r}"
            )
        unknown = set(self.vulnerabilities_to_check) - VALID_VULNERABILITIES
        if unknown:
            raise ValueError(
                f"vulnerabilities_to_check contiene valores desconocidos: {unknown}. "
                f"Permitidos: {sorted(VALID_VULNERABILITIES)}"
            )
        if len(self.vulnerabilities_to_check) != len(set(self.vulnerabilities_to_check)):
            raise ValueError("vulnerabilities_to_check no debe tener duplicados")
        return self


# ─── modelos de reporte de auditoría ─────────────────────────────────────────

class VulnerabilityFinding(BaseModel):
    """Un hallazgo individual dentro de un AuditReport."""

    id: str = Field(pattern=r"^VULN-\d{3,}$")
    type: Literal[
        "reentrancy",
        "integer_overflow",
        "access_control",
        "flash_loan",
        "oracle_manipulation",
        "signer_check",
        "cpi_validation",
        "pdas_validation",
    ]
    severity: Literal["low", "medium", "high", "critical"]
    line: int = Field(ge=1)
    description: str = Field(min_length=1)
    recommendation: str = Field(min_length=1)
    hash: str = Field(pattern=r"^[0-9a-f]{64}$")

    model_config = {"extra": "forbid"}

    @model_validator(mode="after")
    def _validate_finding_hash(self) -> "VulnerabilityFinding":
        expected = hashlib.sha256(
            (self.id + self.type + self.description).encode()
        ).hexdigest()
        if self.hash != expected:
            raise ValueError(
                f"hash del finding {self.id!r} no coincide. "
                f"Esperado: {expected}, recibido: {self.hash}"
            )
        return self


class AuditReport(BaseModel):
    """
    Reporte producido por el agente auditor.
    audit_hash se calcula automáticamente a partir del contenido del reporte
    (todos los campos excepto audit_hash mismo).
    """

    contract_address: str
    vulnerabilities_found: list[VulnerabilityFinding]
    lines_reviewed: int = Field(ge=0)
    tools_used: list[str] = Field(min_length=1)
    audit_hash: str = Field(default="", pattern=r"^([0-9a-f]{64})?$")

    model_config = {"extra": "forbid"}

    @model_validator(mode="after")
    def _compute_audit_hash(self) -> "AuditReport":
        payload = {
            "contract_address": self.contract_address,
            "vulnerabilities_found": [
                f.model_dump() for f in self.vulnerabilities_found
            ],
            "lines_reviewed": self.lines_reviewed,
            "tools_used": self.tools_used,
        }
        computed = hashlib.sha256(
            json.dumps(payload, sort_keys=True, separators=(",", ":")).encode()
        ).hexdigest()
        if self.audit_hash and self.audit_hash != computed:
            raise ValueError(
                f"audit_hash declarado no coincide con el calculado. "
                f"Calculado: {computed}, declarado: {self.audit_hash}"
            )
        object.__setattr__(self, "audit_hash", computed)
        return self


# ─── union discriminada ───────────────────────────────────────────────────────

JobSpec = Annotated[
    Union[
        Annotated[CodeTestJob, Tag("code_test")],
        Annotated[ClassificationJob, Tag("classification")],
        Annotated[ExtractionJob, Tag("extraction")],
        Annotated[SmartContractAuditJob, Tag("smart_contract_audit")],
    ],
    Discriminator("job_type"),
]

# TypeAdapter reutilizable (instanciarlo una sola vez es más eficiente)
JobSpecAdapter: TypeAdapter[JobSpec] = TypeAdapter(JobSpec)


def parse_job_spec(
    data: dict,
) -> CodeTestJob | ClassificationJob | ExtractionJob | SmartContractAuditJob:
    """
    Parsea y valida un dict raw como JobSpec.
    Lanza ValidationError si el schema no se cumple.
    """
    return JobSpecAdapter.validate_python(data)


# ─── compute_hashes ───────────────────────────────────────────────────────────

def compute_hashes(
    job_spec: CodeTestJob | ClassificationJob | ExtractionJob | SmartContractAuditJob,
) -> tuple[bytes, bytes]:
    """
    Retorna (input_hash, output_hash) como bytes[32] listos para el contrato Anchor.

    input_hash
        Para CodeTestJob / ClassificationJob / ExtractionJob:
            sha256( json.dumps(inputs, sort_keys=True) )
        Para SmartContractAuditJob:
            sha256( json.dumps({contract_address, chain, contract_code_url}, sort_keys=True) )
        Permite que el contrato verifique que el agente trabajó sobre el input correcto.

    output_hash
        bytes.fromhex(job_spec.expected_output_hash)
        El cliente comprometió este valor al llamar create_job().
        Para auditorías debe coincidir con AuditReport.audit_hash.

    Ambos son [u8; 32] compatibles con Anchor:
        program.rpc["create_job"](list(input_hash), list(output_hash), reward, ...)
    """
    if isinstance(job_spec, SmartContractAuditJob):
        # El "input" de una auditoría es la identidad del contrato a revisar
        inputs_dict = {
            "contract_address": job_spec.contract_address,
            "chain": job_spec.chain,
            "contract_code_url": job_spec.contract_code_url,
        }
    else:
        inputs_dict = job_spec.inputs.model_dump()

    inputs_json: bytes = json.dumps(
        inputs_dict, sort_keys=True, separators=(",", ":")
    ).encode()
    input_hash: bytes = hashlib.sha256(inputs_json).digest()

    # output_hash — el model_validator ya garantizó 64 hex chars
    output_hash: bytes = bytes.fromhex(job_spec.expected_output_hash)

    assert len(input_hash) == 32, "input_hash debe ser 32 bytes"
    assert len(output_hash) == 32, "output_hash debe ser 32 bytes"

    return input_hash, output_hash


# ─── verify_audit_report ──────────────────────────────────────────────────────

_SEVERITY_ORDER = {s: i for i, s in enumerate(VALID_SEVERITIES)}


def verify_audit_report(report: AuditReport, job: SmartContractAuditJob) -> bool:
    """
    Verifica que un AuditReport es válido para el SmartContractAuditJob dado.

    Comprobaciones:
    1. El contract_address del reporte coincide con el del job.
    2. El audit_hash del reporte coincide con el expected_output_hash del job.
    3. Todos los tipos de vulnerabilidad encontrados estaban en
       vulnerabilities_to_check.
    4. Ningún finding tiene severidad por debajo de severity_threshold
       (no reportar hallazgos irrelevantes según el umbral acordado).

    Retorna True solo si todas las comprobaciones pasan; False en cualquier otro
    caso (no lanza excepciones para que el contrato pueda usarla como predicado).
    """
    if report.contract_address != job.contract_address:
        return False

    if report.audit_hash != job.expected_output_hash:
        return False

    requested = set(job.vulnerabilities_to_check)
    threshold_level = _SEVERITY_ORDER[job.severity_threshold]

    for finding in report.vulnerabilities_found:
        if finding.type not in requested:
            return False
        if _SEVERITY_ORDER[finding.severity] < threshold_level:
            return False

    return True


# ─── ejemplo de uso ───────────────────────────────────────────────────────────

if __name__ == "__main__":
    _FAKE_IPFS = "ipfs://bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi"

    examples = [
        {
            "schema_version": "1.0",
            "job_id": "018e8f2a-7b3c-7000-8000-abcdef000001",
            "title": "Validar suite pytest del módulo auth",
            "job_type": "code_test",
            "inputs": {"ipfs_url": _FAKE_IPFS, "sha256": "a" * 64},
            "expected_output_hash": "b" * 64,
            "timeout_seconds": 300,
            "created_at": "2025-01-15T10:30:00Z",
            "test_suite": {"ipfs_url": _FAKE_IPFS, "sha256": "c" * 64, "runner": "pytest"},
        },
        {
            "schema_version": "1.0",
            "job_id": "018e8f2a-7b3c-7000-8000-abcdef000002",
            "title": "Clasificar reseña de producto",
            "job_type": "classification",
            "inputs": {"ipfs_url": _FAKE_IPFS, "sha256": "d" * 64},
            "expected_output_hash": "e" * 64,
            "timeout_seconds": 60,
            "created_at": "2025-01-15T11:00:00Z",
            "categories": ["positivo", "negativo", "neutro"],
            "min_confidence": 0.85,
        },
        {
            "schema_version": "1.0",
            "job_id": "018e8f2a-7b3c-7000-8000-abcdef000003",
            "title": "Extraer datos de factura PDF",
            "job_type": "extraction",
            "inputs": {"ipfs_url": _FAKE_IPFS, "sha256": "f" * 64},
            "expected_output_hash": "0" * 64,
            "timeout_seconds": 120,
            "created_at": "2025-01-15T12:00:00Z",
            "fields_to_extract": ["numero_factura", "fecha", "total", "proveedor"],
            "output_format": "json",
        },
    ]

    # Ejemplo de SmartContractAuditJob + AuditReport
    _FAKE_CONTRACT = "So11111111111111111111111111111111111111112"
    _FAKE_CODE_IPFS = "ipfs://bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi"

    # 1. Construir el reporte primero para obtener audit_hash
    finding = VulnerabilityFinding(
        id="VULN-001",
        type="reentrancy",
        severity="high",
        line=42,
        description="Llamada externa antes de actualizar el estado interno.",
        recommendation="Aplicar patrón checks-effects-interactions.",
        hash=hashlib.sha256(
            ("VULN-001" + "reentrancy" + "Llamada externa antes de actualizar el estado interno.").encode()
        ).hexdigest(),
    )
    report = AuditReport(
        contract_address=_FAKE_CONTRACT,
        vulnerabilities_found=[finding],
        lines_reviewed=150,
        tools_used=["slither", "claude-sonnet-4-6"],
    )
    print(f"[audit_report] audit_hash : {report.audit_hash}")

    # 2. Crear el job con expected_output_hash = audit_hash
    audit_raw = {
        "schema_version": "1.0",
        "job_id": "018e8f2a-7b3c-7000-8000-abcdef000004",
        "title": "Auditoría de contrato de staking",
        "job_type": "smart_contract_audit",
        "expected_output_hash": report.audit_hash,
        "timeout_seconds": 7200,
        "created_at": "2025-01-15T13:00:00Z",
        "contract_name": "StakingPool",
        "contract_address": _FAKE_CONTRACT,
        "contract_code_url": _FAKE_CODE_IPFS,
        "chain": "solana",
        "vulnerabilities_to_check": ["reentrancy", "access_control", "signer_check"],
        "severity_threshold": "medium",
        "deadline_hours": 24,
    }

    examples.append(audit_raw)

    for raw in examples:
        spec = parse_job_spec(raw)
        ih, oh = compute_hashes(spec)
        print(f"[{spec.job_type}] {spec.title}")
        print(f"  input_hash  : {ih.hex()}")
        print(f"  output_hash : {oh.hex()}")
        print(f"  anchor [u8] : {list(ih)[:4]}...  (32 bytes)")
        print()

    # 3. Verificar el reporte contra el job
    audit_spec = parse_job_spec(audit_raw)
    assert isinstance(audit_spec, SmartContractAuditJob)
    ok = verify_audit_report(report, audit_spec)
    print(f"[verify_audit_report] válido: {ok}")  # True

    # ── test SmartContractAuditJob directo ────────────────────────────────────
    from datetime import timezone

    _TEST_CONTRACT = "EyjVnweqSt8fNmnF9ugQMPSzT8sRX57K1SnKRqbsNiTs"

    # expected_output_hash: sha256 del payload que AuditReport calcularía
    # (excluye audit_hash, igual que model_validator de AuditReport)
    _test_payload = {
        "contract_address": _TEST_CONTRACT,
        "vulnerabilities_found": [],
        "lines_reviewed": 100,
        "tools_used": ["slither", "claude-3-5-sonnet"],
    }
    expected_hash = hashlib.sha256(
        json.dumps(_test_payload, sort_keys=True, separators=(",", ":")).encode()
    ).hexdigest()

    audit_job = SmartContractAuditJob(
        schema_version="1.0",
        job_id="audit-001",
        title="Audit AgentMarket contract",
        job_type="smart_contract_audit",
        expected_output_hash=expected_hash,
        timeout_seconds=3600,
        created_at=datetime.now(timezone.utc),
        contract_name="AgentMarket",
        contract_address=_TEST_CONTRACT,
        contract_code_url="ipfs://QmCode123",
        chain="solana",
        vulnerabilities_to_check=["reentrancy", "access_control"],
        severity_threshold="medium",
        deadline_hours=24,
    )

    ih, oh = compute_hashes(audit_job)
    print(f"\n[smart_contract_audit] {audit_job.title}")
    print(f"  input_hash:  {ih.hex()}")
    print(f"  output_hash: {oh.hex()}")
    print(f"  Longitud: {len(ih)} bytes")
    print("OK — SmartContractAuditJob funciona")