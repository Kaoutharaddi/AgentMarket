"""
AgentMarket — Webhook Router
============================
Recibe POST /webhook de Helius y reenvía según tipo de evento:
  create_job → AgentBot (8001)
  submit_result → WatcherBot (8000)
"""

import json
import logging
from typing import Any

import httpx
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from uvicorn import run

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
logger = logging.getLogger("router")

AGENTBOT_URL = "http://localhost:8001/webhook"
WATCHERBOT_URL = "http://localhost:8000/webhook"


def _payload_contains(payload: Any, *substrings: str) -> bool:
    """Comprueba si algun substring está en la representación del payload."""
    text = json.dumps(payload) if isinstance(payload, (dict, list)) else str(payload)
    return any(s in text for s in substrings)


async def webhook(request: Request) -> JSONResponse:
    try:
        payload = await request.json()
    except Exception as e:
        logger.warning("Webhook: cuerpo JSON inválido: %s", e)
        return JSONResponse({"status": "error", "reason": "invalid_json"}, status_code=400)

    if _payload_contains(payload, "createJob", "create_job"):
        logger.info("Routing createJob → AgentBot")
        async with httpx.AsyncClient(timeout=30.0) as client:
            resp = await client.post(AGENTBOT_URL, json=payload)
        try:
            content = resp.json()
        except Exception:
            content = {"raw": resp.text}
        return JSONResponse(content=content, status_code=resp.status_code)

    if _payload_contains(payload, "submitResult", "submit_result"):
        logger.info("Routing submitResult → WatcherBot")
        async with httpx.AsyncClient(timeout=30.0) as client:
            resp = await client.post(WATCHERBOT_URL, json=payload)
        try:
            content = resp.json()
        except Exception:
            content = {"raw": resp.text}
        return JSONResponse(content=content, status_code=resp.status_code)

    logger.info("Event not routed: %s", payload)
    return JSONResponse({"status": "ok", "routed": False})


app = FastAPI(title="AgentMarket Router", version="0.1.0")


@app.post("/webhook")
async def handle_webhook(request: Request):
    return await webhook(request)


if __name__ == "__main__":
    logger.info("Iniciando Router en http://0.0.0.0:8080/webhook")
    run(app, host="0.0.0.0", port=8080)
