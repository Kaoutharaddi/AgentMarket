"""
AgentMarket — Agente Autónomo
=============================
Bot que escucha eventos JobCreated, reclama jobs, ejecuta y envía resultados.

Estructura:
  - AgentWallet: keypair y firma de transacciones
  - JobExecutor: ejecuta job_spec (CodeTestJob, etc.)
  - AgentBot: orquestador FastAPI + webhook Helius
"""

from __future__ import annotations

import hashlib
import logging
import os
from dataclasses import dataclass
from typing import Literal, cast

from dotenv import load_dotenv
from pydantic import ValidationError
from fastapi import FastAPI, Request
from solders.keypair import Keypair
from uvicorn import run

load_dotenv()

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
logger = logging.getLogger("agent_bot")

PROGRAM_ID = "EyjVnweqSt8fNmnF9ugQMPSzT8sRX57K1SnKRqbsNiTs"


# ─── CLASE 1 — AgentWallet ────────────────────────────────────────────────────

class AgentWallet:
    """Keypair del agente cargado desde .env. Firma y envía transacciones."""

    def __init__(self) -> None:
        key = os.environ["AGENT_PRIVATE_KEY"]
        self._keypair = Keypair.from_base58_string(key)

    @property
    def pubkey(self) -> str:
        """Dirección pública del agente (base58)."""
        return str(self._keypair.pubkey())

    async def sign_and_send(self, transaction) -> str:
        """
        Firma la transacción y la envía al RPC. Retorna la firma como string.
        transaction: solders.Transaction (debe tener message con blockhash).
        """
        from anchorpy.provider import AsyncClient, Provider, Wallet
        from solders.transaction import Transaction

        rpc_url = os.environ.get("RPC_URL", "https://api.devnet.solana.com")
        provider = Provider(AsyncClient(rpc_url), Wallet(self._keypair))

        if isinstance(transaction, Transaction):
            blockhash = transaction.message.recent_blockhash
            transaction.partial_sign([self._keypair], blockhash)

        raw = bytes(transaction)
        sig = await provider.connection.send_raw_transaction(raw)
        return str(sig.value)


# ─── CLASE 2 — JobExecutor ─────────────────────────────────────────────────────

import json
import shutil
import subprocess
import tempfile
from pathlib import Path
from urllib.parse import urlparse

import docker
import docker.errors

import httpx
from job_spec import (
    AuditReport,
    ClassificationJob,
    CodeTestJob,
    ExtractionJob,
    SmartContractAuditJob,
    VulnerabilityFinding,
)

# Alineado con VulnerabilityFinding en job_spec (Literals)
_VULN_TYPE = Literal[
    "reentrancy",
    "integer_overflow",
    "access_control",
    "flash_loan",
    "oracle_manipulation",
    "signer_check",
    "cpi_validation",
    "pdas_validation",
]
_SEVERITY = Literal["low", "medium", "high", "critical"]


class JobExecutor:
    """
    Ejecuta el JobSpec y retorna el resultado como bytes.
    CodeTestJob: descarga inputs + test_suite de IPFS, ejecuta pytest/jest.
    ClassificationJob y ExtractionJob: NotImplementedError.
    """

    def execute(self, job_spec) -> bytes:
        if isinstance(job_spec, ClassificationJob):
            raise NotImplementedError("JobExecutor: ClassificationJob no implementado aún")
        if isinstance(job_spec, ExtractionJob):
            raise NotImplementedError("JobExecutor: ExtractionJob no implementado aún")
        if isinstance(job_spec, SmartContractAuditJob):
            return self._execute_audit(job_spec)
        if isinstance(job_spec, CodeTestJob):
            return self._execute_code_test(job_spec)
        raise TypeError(f"Tipo de job no soportado: {type(job_spec)}")

    def _execute_code_test(self, job_spec: CodeTestJob) -> bytes:
        # Docker is mandatory: running untrusted test suites without sandboxing
        # would allow arbitrary code execution on the host.
        try:
            docker_client = docker.from_env()
            docker_client.ping()
        except docker.errors.DockerException as exc:
            raise NotImplementedError(
                "Docker is required to execute CodeTestJob safely, but the Docker "
                f"daemon is not available: {exc}. Install Docker and ensure the "
                "daemon is running before processing CodeTestJob payloads."
            ) from exc

        ipfs_base = "https://ipfs.io/ipfs/"

        with tempfile.TemporaryDirectory() as tmpdir:
            with httpx.Client(timeout=30.0) as client:
                # 1. Descargar inputs
                inputs_url = job_spec.inputs.ipfs_url.replace("ipfs://", ipfs_base)
                resp = client.get(inputs_url)
                resp.raise_for_status()
                (Path(tmpdir) / "input_data.bin").write_bytes(resp.content)

                # 2. Descargar test suite
                suite_url = job_spec.test_suite.ipfs_url.replace("ipfs://", ipfs_base)
                resp = client.get(suite_url)
                resp.raise_for_status()

            runner = job_spec.test_suite.runner
            suffix = ".py" if runner == "pytest" else ".js"
            suite_path = Path(tmpdir) / f"test_suite{suffix}"
            suite_path.write_bytes(resp.content)

            # 3. Ejecutar dentro de un contenedor Docker desechable y aislado.
            #
            # Restricciones de seguridad:
            #   - network_mode="none"  → sin acceso a red
            #   - volumen read-only    → el contenedor no puede escribir al host
            #   - mem_limit / cpu_*    → evita DoS por consumo de recursos
            #   - timeout de 60 s      → kill automático si el test cuelga
            container_suite = f"/sandbox/test_suite{suffix}"
            if runner == "pytest":
                image = "python:3.11-slim"
                cmd = ["pytest", container_suite, "-v", "--tb=short"]
            else:
                image = "node:20-slim"
                cmd = ["npx", "jest", container_suite, "--no-cache", "--silent"]

            # pids_limit prevents fork-bomb attacks that exhaust host PIDs.
            container = docker_client.containers.run(
                image,
                command=cmd,
                volumes={str(Path(tmpdir).resolve()): {"bind": "/sandbox", "mode": "ro"}},
                network_mode="none",
                mem_limit="256m",
                cpu_period=100000,
                cpu_quota=50000,
                pids_limit=50,
                detach=True,
            )
            timed_out = False
            try:
                container.wait(timeout=60)
            except Exception:
                timed_out = True
                container.kill()
            finally:
                # tail=5000 prevents log-flood OOM from malicious print loops.
                logs: str = container.logs(stdout=True, stderr=True, tail=5000).decode(
                    "utf-8", errors="replace"
                )
                container.remove(force=True)

            if timed_out:
                logs += "\n[sandbox] Container killed: exceeded 60-second timeout."

        return logs.encode("utf-8")

    def _execute_audit(self, job_spec: SmartContractAuditJob) -> bytes:
        """Descarga código, ejecuta Slither (Solidity) o cargo-audit (Rust), arma AuditReport."""
        ipfs_base = "https://ipfs.io/ipfs/"
        _severity_rank = {"low": 0, "medium": 1, "high": 2, "critical": 3}
        threshold_rank = _severity_rank[job_spec.severity_threshold]

        cleanup_target: str | None = None
        cleanup_is_dir = False

        try:
            logger.info("Auditoría paso 1: descargando código desde %s", job_spec.contract_code_url)
            http_url = job_spec.contract_code_url.replace("ipfs://", ipfs_base)
            with httpx.Client(timeout=30) as client:
                resp = client.get(http_url)
                resp.raise_for_status()
                content: bytes = resp.content

            ext = _audit_infer_extension(job_spec.contract_code_url, job_spec.chain)
            lang = "solidity/evm" if ext == ".sol" else "rust/solana"
            logger.info("Auditoría paso 1b: lenguaje detectado %s (extensión %s)", lang, ext)

            if ext == ".sol":
                fd, sol_path = tempfile.mkstemp(suffix=".sol", prefix="audit_contract_")
                cleanup_target = sol_path
                cleanup_is_dir = False
                try:
                    os.write(fd, content)
                finally:
                    os.close(fd)
                logger.info("Auditoría paso 2: ejecutando Slither sobre %s", sol_path)
                proc = subprocess.run(
                    ["slither", str(sol_path), "--json", "-"],
                    capture_output=True,
                    text=True,
                    timeout=120,
                )
                if proc.returncode != 0:
                    logger.info(
                        "Slither terminó con código %s; stderr: %s",
                        proc.returncode,
                        (proc.stderr or "")[:4000],
                    )
                findings = _parse_slither_detectors(proc.stdout or "", job_spec, threshold_rank)
                tools_used = ["slither-0.11.5"]
                # PASO 4 — Análisis con Claude API
                contract_code_text = content.decode("utf-8", errors="replace")
                slither_findings = findings
                _anthropic_key = os.environ.get("ANTHROPIC_API_KEY")
                if not _anthropic_key:
                    logger.warning(
                        "ANTHROPIC_API_KEY no está definida; se omite el análisis con Claude API"
                    )
                else:
                    try:
                        import anthropic

                        _system = (
                            "You are an expert smart contract security auditor.\n"
                            "Analyze the provided code and identify security \n"
                            "vulnerabilities. Be specific about line numbers,\n"
                            "vulnerability types and severity levels.\n"
                            f"Focus on: {', '.join(job_spec.vulnerabilities_to_check)}"
                        )
                        _user = (
                            f"Audit this smart contract:\n\n{contract_code_text}\n\n"
                            f"Already found by Slither: {len(slither_findings)} issues. "
                            "Find additional vulnerabilities Slither may have missed. "
                            "Respond in JSON format:\n"
                            "{{\n"
                            "  'additional_findings': [\n"
                            "    {{\n"
                            "      'type': 'reentrancy|integer_overflow|access_control|...',\n"
                            "      'severity': 'low|medium|high|critical',\n"
                            "      'line': 42,\n"
                            "      'description': '...',\n"
                            "      'recommendation': '...'\n"
                            "    }}\n"
                            "  ]\n"
                            "}}\n"
                        )
                        _claude = anthropic.Anthropic(api_key=_anthropic_key)
                        _claude_msg = _claude.messages.create(
                            model="claude-sonnet-4-20250514",
                            max_tokens=2000,
                            system=_system,
                            messages=[{"role": "user", "content": _user}],
                        )
                        _claude_text = "".join(
                            b.text
                            for b in _claude_msg.content
                            if getattr(b, "type", None) == "text"
                        )
                        _json_str = _claude_text.strip()
                        _s, _e = _json_str.find("{"), _json_str.rfind("}")
                        if _s != -1 and _e != -1 and _e > _s:
                            _json_str = _json_str[_s : _e + 1]
                        _claude_data = json.loads(_json_str)
                        _extra = _claude_data.get("additional_findings") or []
                        if not isinstance(_extra, list):
                            _extra = []
                        _slither_keys = {(f.type, f.line) for f in slither_findings}
                        _allowed_t = {
                            "reentrancy",
                            "integer_overflow",
                            "access_control",
                            "flash_loan",
                            "oracle_manipulation",
                            "signer_check",
                            "cpi_validation",
                            "pdas_validation",
                        }
                        _claude_added = False
                        _idx = len(findings)
                        for _row in _extra:
                            if not isinstance(_row, dict):
                                continue
                            _t = str(_row.get("type") or "").strip()
                            if _t not in _allowed_t:
                                continue
                            try:
                                _line = int(_row.get("line"))
                            except (TypeError, ValueError):
                                continue
                            if _line < 1:
                                continue
                            if (_t, _line) in _slither_keys:
                                continue
                            _sev = str(_row.get("severity") or "").strip().lower()
                            if _sev not in _severity_rank:
                                continue
                            if _severity_rank[_sev] < threshold_rank:
                                continue
                            _desc = str(_row.get("description") or "").strip()[:500]
                            _rec = str(_row.get("recommendation") or "").strip()
                            if not _desc or not _rec:
                                continue
                            _slither_keys.add((_t, _line))
                            _idx += 1
                            _vid = f"VULN-{_idx:03d}"
                            _h = hashlib.sha256((_vid + _t + _desc).encode()).hexdigest()
                            findings.append(
                                VulnerabilityFinding(
                                    id=_vid,
                                    type=cast(_VULN_TYPE, _t),
                                    severity=cast(_SEVERITY, _sev),
                                    line=_line,
                                    description=_desc,
                                    recommendation=_rec,
                                    hash=_h,
                                )
                            )
                            _claude_added = True
                        if _claude_added and "claude-sonnet-4-20250514" not in tools_used:
                            tools_used.append("claude-sonnet-4-20250514")
                    except Exception as _claude_err:
                        logger.warning(
                            "Claude API (PASO 4) falló; se entrega el reporte solo con Slither: %s",
                            _claude_err,
                        )
            else:
                # TODO: cargo audit valida dependencias del manifest, no el .rs suelto;
                #       un único archivo IPFS sin Cargo.toml solo permite un crate mínimo artificial.
                tmpdir = tempfile.mkdtemp(prefix="audit_rust_")
                cleanup_target = tmpdir
                cleanup_is_dir = True
                Path(tmpdir, "Cargo.toml").write_text(
                    '[package]\nname = "sc_audit_target"\nversion = "0.0.0"\nedition = "2021"\n\n[lib]\npath = "lib.rs"\n',
                    encoding="utf-8",
                )
                Path(tmpdir, "lib.rs").write_bytes(content)
                logger.info("Auditoría paso 2: ejecutando cargo audit en %s", tmpdir)
                proc = subprocess.run(
                    ["cargo", "audit", "--json"],
                    cwd=tmpdir,
                    capture_output=True,
                    text=True,
                    timeout=120,
                )
                if proc.returncode != 0:
                    logger.info(
                        "cargo audit terminó con código %s; stderr: %s",
                        proc.returncode,
                        (proc.stderr or "")[:4000],
                    )
                findings = _parse_cargo_audit_json(proc.stdout or "", job_spec, threshold_rank)
                tools_used = ["cargo-audit"]

            text = content.decode("utf-8", errors="replace")
            lines_reviewed = len(text.splitlines())
            logger.info(
                "Auditoría paso 3–4: %d hallazgos, %d líneas revisadas",
                len(findings),
                lines_reviewed,
            )

            report = AuditReport(
                contract_address=job_spec.contract_address,
                vulnerabilities_found=findings,
                lines_reviewed=lines_reviewed,
                tools_used=tools_used,
            )
            out = json.dumps(report.model_dump(), sort_keys=True, separators=(",", ":")).encode("utf-8")
            logger.info("Auditoría paso 5: reporte serializado (%d bytes)", len(out))
            return out
        finally:
            if cleanup_target:
                if cleanup_is_dir:
                    shutil.rmtree(cleanup_target, ignore_errors=True)
                else:
                    try:
                        os.unlink(cleanup_target)
                    except OSError:
                        pass
                logger.info("Auditoría: artefacto temporal eliminado")


def _audit_infer_extension(contract_code_url: str, chain: str) -> str:
    path = urlparse(contract_code_url).path.lower()
    if path.endswith(".sol"):
        return ".sol"
    if path.endswith(".rs"):
        return ".rs"
    return ".rs" if chain == "solana" else ".sol"


def _vuln_keyword_matches_check(check_lower: str, vuln_id: str) -> bool:
    """True si el nombre del check de Slither contiene el identificador de vulnerabilidad del job."""
    v = vuln_id.lower().replace("_", "-")
    if v in check_lower:
        return True
    for part in v.split("-"):
        if len(part) >= 3 and part in check_lower:
            return True
    return False


def _map_check_to_job_vuln_type(check: str, vulnerabilities_to_check: list[str]) -> str | None:
    """Elige un type válido para VulnerabilityFinding entre los solicitados en el job."""
    c = check.lower()
    for v in vulnerabilities_to_check:
        if _vuln_keyword_matches_check(c, v):
            return v
    return None


def _slither_impact_to_severity(impact: str | None) -> str:
    m = (impact or "").strip().lower()
    if m == "high":
        return "high"
    if m == "medium":
        return "medium"
    if m == "low":
        return "low"
    if m == "critical":
        return "critical"
    # TODO: Slither también usa Informational, Optimization; sin mapeo explícito en el enunciado
    if m in ("informational", "optimization"):
        return "low"
    return "medium"


def _parse_slither_detectors(
    stdout: str,
    job_spec: SmartContractAuditJob,
    threshold_rank: int,
) -> list[VulnerabilityFinding]:
    _severity_rank = {"low": 0, "medium": 1, "high": 2, "critical": 3}
    out: list[VulnerabilityFinding] = []
    try:
        data = json.loads(stdout) if stdout.strip() else {}
    except json.JSONDecodeError as e:
        logger.info("Slither: no se pudo parsear JSON stdout: %s", e)
        return out

    detectors = (data.get("results") or {}).get("detectors") or []
    idx = 0
    for detector in detectors:
        check = str(detector.get("check") or "")
        if not any(
            _vuln_keyword_matches_check(check.lower(), v) for v in job_spec.vulnerabilities_to_check
        ):
            continue
        vtype = _map_check_to_job_vuln_type(check, job_spec.vulnerabilities_to_check)
        if vtype is None:
            continue
        severity = _slither_impact_to_severity(detector.get("impact"))
        if _severity_rank[severity] < threshold_rank:
            continue
        elements = detector.get("elements") or []
        line = 1
        if elements:
            sm = (elements[0] or {}).get("source_mapping") or {}
            lines_arr = sm.get("lines") or []
            if lines_arr:
                try:
                    line = max(1, int(lines_arr[0]))
                except (TypeError, ValueError):
                    line = 1
        if line < 1:
            line = 1
        desc = str(detector.get("description") or "")[:500]
        if not desc:
            desc = check
        idx += 1
        vid = f"VULN-{idx:03d}"
        rec = f"Review and fix {check}"
        fh = hashlib.sha256((vid + vtype + desc).encode()).hexdigest()
        try:
            out.append(
                VulnerabilityFinding(
                    id=vid,
                    type=cast(_VULN_TYPE, vtype),
                    severity=cast(_SEVERITY, severity),
                    line=line,
                    description=desc,
                    recommendation=rec,
                    hash=fh,
                )
            )
        except ValidationError as e:
            logger.info("Slither: omitiendo detector %r por validación: %s", check, e)
    return out


def _parse_cargo_audit_json(
    stdout: str,
    job_spec: SmartContractAuditJob,
    threshold_rank: int,
) -> list[VulnerabilityFinding]:
    _severity_rank = {"low": 0, "medium": 1, "high": 2, "critical": 3}
    out: list[VulnerabilityFinding] = []
    try:
        data = json.loads(stdout) if stdout.strip() else {}
    except json.JSONDecodeError as e:
        logger.info("cargo audit: no se pudo parsear JSON stdout: %s", e)
        return out

    vulns = (data.get("vulnerabilities") or {}).get("list") or []
    idx = 0
    for item in vulns:
        adv = (item or {}).get("advisory") or {}
        title = str(adv.get("title") or "")
        desc_full = str(adv.get("description") or title)
        aid = str(adv.get("id") or "")
        blob = f"{aid} {title} {desc_full}".lower()
        if not any(_vuln_keyword_matches_check(blob, v) for v in job_spec.vulnerabilities_to_check):
            continue
        vtype = _map_check_to_job_vuln_type(blob, job_spec.vulnerabilities_to_check)
        if vtype is None:
            continue
        # TODO: formato RUSTSEC no siempre incluye severidad; cvss opcional
        raw_sev = str(adv.get("severity") or "").strip().lower()
        if raw_sev in _severity_rank:
            severity = raw_sev
        else:
            severity = "medium"
        if _severity_rank[severity] < threshold_rank:
            continue
        desc = desc_full[:500] or aid
        idx += 1
        vid = f"VULN-{idx:03d}"
        rec = f"Review and fix {aid or title}"
        fh = hashlib.sha256((vid + vtype + desc).encode()).hexdigest()
        try:
            out.append(
                VulnerabilityFinding(
                    id=vid,
                    type=cast(_VULN_TYPE, vtype),
                    severity=cast(_SEVERITY, severity),
                    line=1,
                    description=desc,
                    recommendation=rec,
                    hash=fh,
                )
            )
        except ValidationError as e:
            logger.info("cargo audit: omitiendo advisory %r por validación: %s", aid, e)
    return out


# ─── CLASE 3 — AgentBot ────────────────────────────────────────────────────────

@dataclass
class AgentConfig:
    program_id: str
    rpc_url: str
    helius_api_key: str

    @classmethod
    def from_env(cls) -> "AgentConfig":
        return cls(
            program_id=os.getenv("PROGRAM_ID", PROGRAM_ID),
            rpc_url=os.getenv("RPC_URL", "https://api.devnet.solana.com"),
            helius_api_key=os.environ["HELIUS_API_KEY"],
        )


class AgentBot:
    """Orquestador: webhook Helius → claim_job → execute → submit_result."""

    def __init__(self, config: AgentConfig | None = None) -> None:
        self.config = config or AgentConfig.from_env()
        self.wallet = AgentWallet()
        self.executor = JobExecutor()
        self.app = FastAPI(title="AgentMarket Agent", version="0.1.0")

        @self.app.post("/webhook")
        async def webhook(request: Request) -> dict:
            return await self._handle_webhook(request)

    async def _handle_webhook(self, request: Request) -> dict:
        """Procesa payload Helius y filtra eventos JobCreated."""
        try:
            payload = await request.json()
        except Exception as e:
            logger.warning("Webhook: JSON inválido: %s", e)
            return {"status": "error", "reason": "invalid_json"}

        txs = payload if isinstance(payload, list) else payload.get("transactions", [payload])
        if not isinstance(txs, list):
            txs = [txs]

        processed = 0
        for tx in txs:
            if not self._is_job_created_event(tx):
                continue
            processed += 1
            await self._process_job_created(tx)

        logger.info("Webhook procesado: %d eventos JobCreated", processed)
        return {"status": "ok", "processed": processed}

    def _is_job_created_event(self, tx: dict) -> bool:
        """Filtra transacciones create_job del program_id via eventos Anchor."""
        for event in tx.get("events", []):
            if (
                event.get("programId") == self.config.program_id
                and event.get("name") == "JobCreated"
            ):
                return True
        # Fallback: detectar por instructionData si no hay eventos parseados
        instructions = tx.get("instructions", []) or tx.get("instructionData", [])
        for ix in instructions:
            if ix.get("programId") == self.config.program_id:
                if "create_job" in str(ix).lower() or "createJob" in str(ix):
                    return True
        return False

    async def _process_job_created(self, tx: dict) -> None:
        """Para cada job: claim → parse jobspec → execute → submit_result."""
        # Extraer datos del evento JobCreated emitido por el contrato Anchor
        job_spec_url = ""
        client = ""
        created_at = None
        for event in tx.get("events", []):
            if (
                event.get("programId") == self.config.program_id
                and event.get("name") == "JobCreated"
            ):
                data = event.get("data") or {}
                job_spec_url = data.get("jobSpecUrl") or data.get("job_spec_url") or ""
                client       = data.get("client") or ""
                created_at   = data.get("createdAt") or data.get("created_at")
                break
        # Fallback: campos directos en tx (formato legacy)
        if not job_spec_url:
            job_spec_url = tx.get("jobSpecIpfsUrl") or tx.get("job_spec_url") or ""
        if not client:
            client = tx.get("client") or ""
        if created_at is None:
            created_at = tx.get("createdAt") or tx.get("created_at")

        if not job_spec_url:
            logger.warning("JobCreated sin jobSpecIpfsUrl; omitiendo")
            return
        if not client or created_at is None:
            logger.warning("JobCreated sin client o created_at; omitiendo")
            return

        logger.info("Procesando JobCreated: jobspec=%s", job_spec_url)

        try:
            await self._claim_job(client, created_at)
        except NotImplementedError:
            logger.warning("claim_job no implementado; omitiendo")
            return

        # Descargar jobspec desde IPFS
        import httpx

        http_url = job_spec_url.replace("ipfs://", "https://ipfs.io/ipfs/")
        async with httpx.AsyncClient(timeout=30.0) as client_http:
            resp = await client_http.get(http_url)
            resp.raise_for_status()
            raw_spec = resp.json()

        from job_spec import parse_job_spec

        job_spec = parse_job_spec(raw_spec)

        try:
            result = self.executor.execute(job_spec)
        except NotImplementedError:
            logger.warning("JobExecutor.execute() no implementado; omitiendo")
            return

        result_hash = hashlib.sha256(result).digest()

        try:
            sig = await self._submit_result(client, created_at, result_hash)
            logger.info("submit_result enviado: tx=%s", sig)
        except NotImplementedError:
            logger.warning("submit_result no implementado; omitiendo")
            return

        # ── ZK proof + verify_and_pay (solo SmartContractAuditJob) ───────────
        if not isinstance(job_spec, SmartContractAuditJob):
            return

        # Construir jobspec_json con las mismas claves y tipos que el frontend.
        # El frontend serializa deadline_hours como string (valor del <input>),
        # por eso se usa str() aquí para que sha256 coincida con job.output_hash.
        jobspec_dict = {
            "contract_address": job_spec.contract_address,
            "contract_code_url": job_spec.contract_code_url,
            "deadline_hours": str(job_spec.deadline_hours),
            "vulnerabilities": sorted(job_spec.vulnerabilities_to_check),
        }
        jobspec_json_str = json.dumps(
            jobspec_dict, sort_keys=True, separators=(",", ":")
        )

        # Descargar el contrato a un archivo temporal para pasarlo al host ZK
        ipfs_base = "https://ipfs.io/ipfs/"
        contract_url = job_spec.contract_code_url.replace("ipfs://", ipfs_base)
        ext = ".rs" if job_spec.chain == "solana" else ".sol"

        contract_fd, contract_path = tempfile.mkstemp(
            suffix=ext, prefix="zk_contract_"
        )
        try:
            async with httpx.AsyncClient(timeout=30.0) as hc:
                resp = await hc.get(contract_url)
                resp.raise_for_status()
                os.write(contract_fd, resp.content)
            os.close(contract_fd)

            # Pasar las vulnerabilidades del jobspec como reglas al checker
            rules = list(job_spec.vulnerabilities_to_check) if job_spec.vulnerabilities_to_check else []
            proof_data = self._call_zk_host(
                contract_path, jobspec_json_str, self.wallet.pubkey,
                rules_to_check=rules if rules else None,
            )
            zk_sig = await self._verify_and_pay(client, created_at, proof_data)
            logger.info("verify_and_pay enviado: tx=%s", zk_sig)
        except Exception as zk_err:
            logger.error("ZK proof/verify_and_pay falló: %s", zk_err)
        finally:
            try:
                os.close(contract_fd)
            except OSError:
                pass
            try:
                os.unlink(contract_path)
            except OSError:
                pass

    def _job_pda(self, client_pubkey: "Pubkey", created_at: int) -> "Pubkey":
        """Deriva el PDA del job: seeds = [b'job', client, created_at_le]."""
        import struct

        from solders.pubkey import Pubkey

        prog_id = Pubkey.from_string(self.config.program_id)
        created_at_bytes = struct.pack("<q", created_at)
        seeds = [b"job", bytes(client_pubkey), created_at_bytes]
        pda, _ = Pubkey.find_program_address(seeds, prog_id)
        return pda

    async def _claim_job(self, client: str, created_at: int | None) -> str:
        """Llama claim_job on-chain."""
        import struct

        from anchorpy.provider import AsyncClient
        from solders.instruction import AccountMeta, Instruction
        from solders.message import Message
        from solders.pubkey import Pubkey
        from solders.transaction import Transaction

        if created_at is None:
            raise ValueError("created_at es requerido para claim_job")
        client_pk = Pubkey.from_string(client)
        job_pda = self._job_pda(client_pk, created_at)

        CLAIM_JOB_DISCRIMINATOR = bytes([9, 160, 5, 231, 116, 123, 198, 14])
        created_at_le = struct.pack("<q", created_at)
        ix_data = CLAIM_JOB_DISCRIMINATOR + created_at_le

        prog_id = Pubkey.from_string(self.config.program_id)
        ix = Instruction(
            program_id=prog_id,
            accounts=[
                AccountMeta(self.wallet._keypair.pubkey(), is_signer=True, is_writable=False),
                AccountMeta(job_pda, is_signer=False, is_writable=True),
                AccountMeta(client_pk, is_signer=False, is_writable=False),
            ],
            data=ix_data,
        )

        conn = AsyncClient(self.config.rpc_url)
        latest = await conn.get_latest_blockhash()
        blockhash = latest.value.blockhash
        msg = Message.new_with_blockhash([ix], self.wallet._keypair.pubkey(), blockhash)
        tx = Transaction.new_unsigned(msg)
        tx.partial_sign([self.wallet._keypair], blockhash)
        raw = bytes(tx)
        sig = await conn.send_raw_transaction(raw)
        return str(sig.value)

    async def _submit_result(self, client: str, created_at: int | None, result_hash: bytes) -> str:
        """Llama submit_result on-chain."""
        from anchorpy.provider import AsyncClient
        from solders.instruction import AccountMeta, Instruction
        from solders.message import Message
        from solders.pubkey import Pubkey
        from solders.transaction import Transaction

        if created_at is None:
            raise ValueError("created_at es requerido para submit_result")
        if len(result_hash) != 32:
            raise ValueError("result_hash debe ser 32 bytes")

        client_pk = Pubkey.from_string(client)
        job_pda = self._job_pda(client_pk, created_at)

        SUBMIT_RESULT_DISCRIMINATOR = bytes([98, 166, 212, 96, 52, 29, 155, 85])
        ix_data = SUBMIT_RESULT_DISCRIMINATOR + result_hash

        prog_id = Pubkey.from_string(self.config.program_id)
        ix = Instruction(
            program_id=prog_id,
            accounts=[
                AccountMeta(self.wallet._keypair.pubkey(), is_signer=True, is_writable=False),
                AccountMeta(job_pda, is_signer=False, is_writable=True),
            ],
            data=ix_data,
        )

        conn = AsyncClient(self.config.rpc_url)
        latest = await conn.get_latest_blockhash()
        blockhash = latest.value.blockhash
        msg = Message.new_with_blockhash([ix], self.wallet._keypair.pubkey(), blockhash)
        tx = Transaction.new_unsigned(msg)
        tx.partial_sign([self.wallet._keypair], blockhash)
        raw = bytes(tx)
        sig = await conn.send_raw_transaction(raw)
        return str(sig.value)

    def _call_zk_host(
        self,
        contract_path: str,
        jobspec_json: str,
        auditor_pubkey: str,
        rules_to_check: list[str] | None = None,
    ) -> dict:
        """Invoca el host RISC Zero y retorna el dict de audit_proof.json.

        El guest ejecuta run_checks() DENTRO del zkVM — el proof garantiza
        matemáticamente que las reglas de seguridad se ejecutaron sobre el
        contrato exacto. findings y findings_hash quedan en el proof output.

        Para producción usa Bonsai API (BONSAI_API_KEY env var) para Groth16.
        Sin Bonsai usa RISC0_DEV_MODE=1 (no válido on-chain).
        """
        jobspec_fd, jobspec_path = tempfile.mkstemp(
            suffix=".json", prefix="zk_jobspec_"
        )
        proof_fd, proof_path = tempfile.mkstemp(
            suffix=".json", prefix="zk_proof_"
        )
        try:
            os.write(jobspec_fd, jobspec_json.encode())
            os.close(jobspec_fd)
            os.close(proof_fd)

            host_binary = os.environ.get(
                "ZK_HOST_BINARY",
                "./risc-zero-v2/target/release/agentmarket-audit-host",
            )
            use_bonsai = bool(os.environ.get("BONSAI_API_KEY"))
            env = {**os.environ}
            if not use_bonsai:
                env["RISC0_DEV_MODE"] = "1"
                logger.warning("BONSAI_API_KEY no configurada — usando dev mode (seal no válido on-chain)")
            else:
                logger.info("Usando Bonsai API para generar Groth16 proof real")

            cmd = [
                host_binary,
                "--contract", contract_path,
                "--jobspec",  jobspec_path,
                "--auditor",  auditor_pubkey,
                "--output",   proof_path,
            ]
            if rules_to_check:
                cmd += ["--rules", ",".join(rules_to_check)]

            proc = subprocess.run(
                cmd,
                env=env,
                capture_output=True,
                text=True,
                timeout=300,
            )
            if proc.returncode != 0:
                raise RuntimeError(
                    f"ZK host terminó con código {proc.returncode}:\n{proc.stderr[:2000]}"
                )

            logger.info("ZK host stdout: %s", proc.stdout[-500:])

            with open(proof_path) as f:
                proof = json.load(f)

            # Log resumen de findings
            summary = proof.get("severity_summary", {})
            logger.info(
                "Findings: CRITICAL=%s HIGH=%s MEDIUM=%s INFO=%s",
                summary.get("critical", 0), summary.get("high", 0),
                summary.get("medium", 0), summary.get("info", 0),
            )
            return proof
        finally:
            for path in (jobspec_path, proof_path):
                try:
                    os.unlink(path)
                except OSError:
                    pass

    async def _verify_and_pay(
        self, client: str, created_at: int, proof_data: dict
    ) -> str:
        """Construye y envía la instrucción verify_and_pay on-chain.

        PDAs del VerifierRouter (risc0/risc0-solana):
          router_account  — seeds=[b"router"],              programa=ROUTER_PROGRAM
          verifier_entry  — seeds=[b"verifier", seal[0:4]], programa=ROUTER_PROGRAM
          verifier_program — Pubkey guardada en verifier_entry.verifier (bytes [12..44])

        Layout de VerifierEntry (Anchor):
          [0..8]   discriminador
          [8..12]  selector  [u8; 4]
          [12..44] verifier  Pubkey
          [44]     estopped  bool
        """
        import struct

        from anchorpy.provider import AsyncClient
        from solders.instruction import AccountMeta, Instruction
        from solders.message import Message
        from solders.pubkey import Pubkey
        from solders.transaction import Transaction

        seal = bytes.fromhex(proof_data["seal_hex"])
        journal_outputs = bytes.fromhex(proof_data["journal_outputs_hex"])

        # image_id: el host emite image_id_hex como [u8;32] big-endian.
        # Fallback al campo legacy image_id ([u32;8]) si el binario es antiguo.
        if "image_id_hex" in proof_data:
            image_id = bytes.fromhex(proof_data["image_id_hex"])
        else:
            image_id = b"".join(
                struct.pack(">I", x) for x in proof_data["image_id"]
            )

        ROUTER_PROGRAM = Pubkey.from_string(
            "6JvFfBrvCcWgANKh1Eae9xDq4RC6cfJuBcf71rp2k9Y7"
        )
        SYSTEM_PROGRAM = Pubkey.from_string("11111111111111111111111111111111")

        # ── 1. Derivar router_account PDA: seeds=[b"router"] ─────────────
        router_pda, _ = Pubkey.find_program_address([b"router"], ROUTER_PROGRAM)

        # ── 2. Derivar verifier_entry PDA: seeds=[b"verifier", seal[0:4]] ─
        selector = seal[:4]
        verifier_entry_pda, _ = Pubkey.find_program_address(
            [b"verifier", selector], ROUTER_PROGRAM
        )

        # ── 3. Leer verifier_entry on-chain para obtener verifier_program ──
        conn = AsyncClient(self.config.rpc_url)
        entry_info = await conn.get_account_info(verifier_entry_pda)
        if entry_info.value is None:
            raise RuntimeError(
                f"verifier_entry PDA no encontrado: {verifier_entry_pda}. "
                f"selector={selector.hex()} — ¿está registrado el Groth16 verifier "
                "en Devnet para este selector?"
            )
        entry_data = bytes(entry_info.value.data)
        # Anchor layout: 8 discriminador + 4 selector + 32 verifier + 1 estopped
        if len(entry_data) < 44:
            raise RuntimeError(
                f"verifier_entry data demasiado corta: {len(entry_data)} bytes"
            )
        verifier_program = Pubkey.from_bytes(entry_data[12:44])
        logger.info(
            "verify_and_pay: router_pda=%s verifier_entry=%s verifier_program=%s",
            router_pda, verifier_entry_pda, verifier_program,
        )

        # ── 4. Construir instrucción verify_and_pay ───────────────────────
        client_pk = Pubkey.from_string(client)
        job_pda = self._job_pda(client_pk, created_at)
        prog_id = Pubkey.from_string(self.config.program_id)

        # sha256("global:verify_and_pay")[0..8]
        VERIFY_AND_PAY_DISCRIMINATOR = bytes([232, 197, 99, 115, 240, 124, 158, 31])

        def _encode_vec(data: bytes) -> bytes:
            return struct.pack("<I", len(data)) + data

        ix_data = (
            VERIFY_AND_PAY_DISCRIMINATOR
            + _encode_vec(seal)
            + _encode_vec(journal_outputs)
        )

        ix = Instruction(
            program_id=prog_id,
            accounts=[
                AccountMeta(job_pda,                       is_signer=False, is_writable=True),
                AccountMeta(self.wallet._keypair.pubkey(), is_signer=False, is_writable=True),
                AccountMeta(router_pda,                    is_signer=False, is_writable=False),
                AccountMeta(verifier_entry_pda,            is_signer=False, is_writable=False),
                AccountMeta(verifier_program,              is_signer=False, is_writable=False),
                AccountMeta(SYSTEM_PROGRAM,                is_signer=False, is_writable=False),
            ],
            data=ix_data,
        )

        latest = await conn.get_latest_blockhash()
        blockhash = latest.value.blockhash
        msg = Message.new_with_blockhash(
            [ix], self.wallet._keypair.pubkey(), blockhash
        )
        tx = Transaction.new_unsigned(msg)
        tx.partial_sign([self.wallet._keypair], blockhash)
        raw = bytes(tx)
        sig = await conn.send_raw_transaction(raw)
        return str(sig.value)

    def start(self, host: str = "0.0.0.0", port: int = 8001) -> None:
        """Levanta el servidor FastAPI en /webhook."""
        logger.info("Iniciando AgentBot en http://%s:%d/webhook", host, port)
        run(self.app, host=host, port=port)


# ─── main ──────────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    config = AgentConfig.from_env()
    bot = AgentBot(config)
    bot.start()
