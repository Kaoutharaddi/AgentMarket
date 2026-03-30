"""
AgentMarket — Watcher Bot
=========================
Bot que escucha eventos de submit_result vía webhook Helius,
verifica resultados con JobVerifier y somete disputas si el hash no coincide.

Estructura:
  - WatcherConfig: configuración desde .env
  - JobVerifier: verifica result_hash ejecutando test suite (stub)
  - DisputeSubmitter: llama raise_dispute en contrato (stub)
  - WatcherBot: orquestador FastAPI + webhook
"""

from __future__ import annotations

import logging
from dataclasses import dataclass

from dotenv import load_dotenv
from fastapi import FastAPI, Request
from uvicorn import run

load_dotenv()

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
logger = logging.getLogger("watcher_bot")


# ─── CLASE 1 — WatcherConfig ──────────────────────────────────────────────────

@dataclass
class WatcherConfig:
    """Configuración del watcher cargada desde .env."""

    program_id: str
    rpc_url: str
    watcher_private_key: str
    helius_api_key: str
    dispute_stake_pct: float = 0.10

    @classmethod
    def from_env(cls) -> "WatcherConfig":
        import os

        dispute_pct = float(os.getenv("DISPUTE_STAKE_PCT", "0.10"))
        return cls(
            program_id=os.environ["PROGRAM_ID"],
            rpc_url=os.environ["RPC_URL"],
            watcher_private_key=os.environ["WATCHER_PRIVATE_KEY"],
            helius_api_key=os.environ["HELIUS_API_KEY"],
            dispute_stake_pct=dispute_pct,
        )


# ─── CLASE 2 — JobVerifier ────────────────────────────────────────────────────

import hashlib
import subprocess
import tempfile
from pathlib import Path

import httpx


class JobVerifier:
    """
    Verifica que result_hash coincida con sha256(stdout + stderr) del test suite.
    Descarga desde IPFS, ejecuta pytest o jest, calcula hash del output.
    """

    async def verify(
        self,
        job_id: str,
        result_hash: bytes,
        test_suite_ipfs_url: str,
    ) -> bool:
        if not test_suite_ipfs_url.startswith("ipfs://"):
            logger.warning("Job %s: URL no es ipfs://, omitiendo", job_id)
            return False

        http_url = test_suite_ipfs_url.replace("ipfs://", "https://ipfs.io/ipfs/")
        is_pytest = "pytest" in test_suite_ipfs_url.lower() or test_suite_ipfs_url.endswith(".py")
        is_jest = "jest" in test_suite_ipfs_url.lower() or test_suite_ipfs_url.endswith(".js")

        with tempfile.TemporaryDirectory() as tmpdir:
            async with httpx.AsyncClient(timeout=30.0) as client:
                resp = await client.get(http_url)
                resp.raise_for_status()
                content = resp.content

            suffix = ".py" if is_pytest else (".js" if is_jest else ".py")
            suite_path = Path(tmpdir) / f"test_suite{suffix}"
            suite_path.write_bytes(content)

            if is_jest:
                cmd = ["npx", "jest", str(suite_path), "--no-cache", "--silent"]
            else:
                cmd = ["pytest", str(suite_path), "-v", "--tb=short"]

            proc = subprocess.run(
                cmd,
                capture_output=True,
                text=True,
                timeout=60,
                cwd=tmpdir,
            )
            output = (proc.stdout or "") + (proc.stderr or "")
            output_bytes = output.encode("utf-8")

        computed_hash = hashlib.sha256(output_bytes).digest()

        if computed_hash == result_hash:
            logger.info("Job %s: verificación OK", job_id)
            return True

        logger.warning(
            "Job %s: hash no coincide — esperado %s, computado %s",
            job_id,
            result_hash.hex(),
            computed_hash.hex(),
        )
        return False


# ─── CLASE 3 — DisputeSubmitter ───────────────────────────────────────────────

from pathlib import Path

from anchorpy.provider import AsyncClient, Provider, Wallet
from solders.instruction import AccountMeta, Instruction
from solders.keypair import Keypair
from solders.message import Message
from solders.pubkey import Pubkey
from solders.system_program import ID as SYS_PROGRAM_ID
from solders.transaction import Transaction

# verify_and_pay discriminator (Anchor instruction hash)
VERIFY_AND_PAY_DISCRIMINATOR = bytes([232, 197, 99, 115, 240, 124, 158, 31])

# Job account layout: 8 discriminator + 32 client + 1 (Option tag) + 32 agent
JOB_AGENT_OFFSET = 8 + 32 + 1
JOB_AGENT_LEN = 32


class DisputeSubmitter:
    """
    Llama verify_and_pay() del contrato. Si result_hash != output_hash,
    el contrato marca Disputed. El watcher activa esa verificación.
    """

    def __init__(self, config: WatcherConfig) -> None:
        self.config = config
        self._program_id = Pubkey.from_string(config.program_id)
        self._wallet = Wallet(Keypair.from_base58_string(config.watcher_private_key))
        self._provider = Provider(AsyncClient(config.rpc_url), self._wallet)
        # TODO: anchorpy Idl.from_json falla con IDL de Anchor 0.32 (pda seeds format).
        # Construimos la instrucción manualmente con solders.
        self._idl_path = Path(__file__).resolve().parent.parent / "target" / "idl" / "agentmarket.json"

    def _parse_agent_from_job_account(self, data: bytes) -> Pubkey | None:
        """Extrae agent (Pubkey) de la cuenta Job. Option<Pubkey>: 0=None, 1=Some(+32bytes)."""
        if len(data) < JOB_AGENT_OFFSET + JOB_AGENT_LEN:
            return None
        opt_tag = data[8 + 32]  # byte 41
        if opt_tag != 1:
            return None
        agent_bytes = data[JOB_AGENT_OFFSET : JOB_AGENT_OFFSET + JOB_AGENT_LEN]
        return Pubkey.from_bytes(agent_bytes)

    async def submit_dispute(self, job_pda: str) -> str:
        """
        Llama verify_and_pay() con el job PDA. Retorna la firma de la tx.
        job_pda: dirección de la cuenta Job (PDA).
        """
        job_pubkey = Pubkey.from_string(job_pda)

        resp = await self._provider.connection.get_account_info(job_pubkey)
        if resp.value is None:
            raise ValueError(f"Cuenta Job no encontrada: {job_pda}")

        data = bytes(resp.value.data)
        agent_pubkey = self._parse_agent_from_job_account(data)
        if agent_pubkey is None:
            raise ValueError(f"Job {job_pda} no tiene agent asignado")

        ix = Instruction(
            program_id=self._program_id,
            accounts=[
                AccountMeta(job_pubkey, is_signer=False, is_writable=True),
                AccountMeta(agent_pubkey, is_signer=False, is_writable=True),
                AccountMeta(SYS_PROGRAM_ID, is_signer=False, is_writable=False),
            ],
            data=VERIFY_AND_PAY_DISCRIMINATOR,
        )

        latest = await self._provider.connection.get_latest_blockhash()
        blockhash = latest.value.blockhash
        msg = Message.new_with_blockhash([ix], self._wallet.pubkey(), blockhash)
        tx = Transaction.new_unsigned(msg)
        tx.partial_sign([self._wallet.payer], blockhash)
        raw = bytes(tx)
        sig = await self._provider.connection.send_raw_transaction(raw)
        return str(sig.value)


# ─── CLASE 4 — WatcherBot ────────────────────────────────────────────────────

class WatcherBot:
    """Orquestador: webhook Helius → JobVerifier → DisputeSubmitter."""

    def __init__(self, config: WatcherConfig) -> None:
        self.config = config
        self.verifier = JobVerifier()
        self.dispute_submitter = DisputeSubmitter(config)
        self.app = FastAPI(title="AgentMarket Watcher", version="0.1.0")

        @self.app.post("/webhook")
        async def webhook(request: Request) -> dict:
            return await self._handle_webhook(request)

    async def _handle_webhook(self, request: Request) -> dict:
        """Procesa payload de Helius y filtra eventos submit_result."""
        try:
            payload = await request.json()
        except Exception as e:
            logger.warning("Webhook: cuerpo JSON inválido: %s", e)
            return {"status": "error", "reason": "invalid_json"}

        # Helius envía array de transacciones en diferentes formatos según webhookType
        # TODO: Ajustar según documentación Helius (enhanced vs raw)
        txs = payload if isinstance(payload, list) else payload.get("transactions", [payload])
        if not isinstance(txs, list):
            txs = [txs]

        processed = 0
        for tx in txs:
            if not self._is_submit_result_event(tx):
                continue

            processed += 1
            await self._process_submit_result(tx)

        logger.info("Webhook procesado: %d eventos submit_result", processed)
        return {"status": "ok", "processed": processed}

    def _is_submit_result_event(self, tx: dict) -> bool:
        """Filtra solo transacciones con instrucción submit_result del programa."""
        # TODO: Verificar estructura real del payload Helius
        # Buscar instrucciones que involucren nuestro program_id y submit_result
        instructions = tx.get("instructions", []) or tx.get("instructionData", [])
        program_id = self.config.program_id

        for ix in instructions:
            if ix.get("programId") == program_id:
                # Anchor usa discriminator; submit_result tiene uno específico
                # Alternativa: ix.get("name") == "submitResult" si Helius parsea
                if "submit_result" in str(ix).lower() or "submitResult" in str(ix):
                    return True
        return False

    def _extract_job_pda_from_tx(self, tx: dict) -> str | None:
        """Extrae la cuenta job PDA del payload de submit_result."""
        # TODO: Ajustar según formato real de Helius (accountKeys + indices en instruction)
        account_keys = tx.get("accountKeys") or tx.get("account_keys") or []
        if account_keys and isinstance(account_keys[0], dict):
            account_keys = [a.get("pubkey", a) for a in account_keys]
        instructions = tx.get("instructions", []) or tx.get("instructionData", [])
        for ix in instructions:
            if ix.get("programId") != self.config.program_id:
                continue
            # submit_result: accounts = [agent, job]; job es el índice 1
            accounts = ix.get("accounts", ix.get("accountIndexes", []))
            if len(accounts) >= 2 and account_keys:
                idx = accounts[1] if isinstance(accounts[1], int) else None
                if idx is not None:
                    val = account_keys[idx]
                    return val if isinstance(val, str) else val.get("pubkey", str(val))
        return None

    async def _process_submit_result(self, tx: dict) -> None:
        """Verifica resultado y somete disputa si falla."""
        # TODO: Extraer job_id, result_hash, test_suite_ipfs_url del tx
        job_id = tx.get("jobId") or "unknown"
        result_hash_b64 = tx.get("resultHash") or ""
        test_suite_url = tx.get("testSuiteIpfsUrl") or ""
        job_pda = self._extract_job_pda_from_tx(tx)

        try:
            result_hash = bytes.fromhex(result_hash_b64) if result_hash_b64 else b"\x00" * 32
        except Exception:
            result_hash = b"\x00" * 32

        logger.info("Procesando submit_result: job_id=%s", job_id)

        try:
            valid = await self.verifier.verify(job_id, result_hash, test_suite_url)
        except NotImplementedError:
            logger.warning("JobVerifier.verify() no implementado; omitiendo verificación")
            return

        if valid:
            logger.info("Job %s: verificación OK", job_id)
            return

        logger.warning("Job %s: verificación fallida, sometiendo disputa", job_id)
        if not job_pda:
            logger.warning("No se pudo extraer job_pda del tx; omitiendo disputa")
            return
        try:
            sig = await self.dispute_submitter.submit_dispute(job_pda)
            logger.info("Job %s: disputa enviada, tx=%s", job_id, sig)
        except Exception as e:
            logger.exception("Error enviando disputa: %s", e)

    def start(self, host: str = "0.0.0.0", port: int = 8000) -> None:
        """Levanta el servidor FastAPI en /webhook."""
        logger.info("Iniciando WatcherBot en http://%s:%d/webhook", host, port)
        run(self.app, host=host, port=port)


# ─── main ────────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    config = WatcherConfig.from_env()
    bot = WatcherBot(config)
    bot.start()
