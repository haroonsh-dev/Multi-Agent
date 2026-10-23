from fastapi import APIRouter, Body, HTTPException
from pydantic import BaseModel, Field
from ..services.groq_service import groq_service, GroqRateLimitExceeded
from ..services import groq_limit_state
from ..config import settings
import os
import re
from pathlib import Path

router = APIRouter(prefix="/api/v1/groq", tags=["groq"])


class GroqKeyBody(BaseModel):
    api_key: str = Field(..., min_length=10)


def _persist_env_key(api_key: str) -> bool:
    """Best-effort write GROQ_API_KEY into ai-backend/.env"""
    env_path = Path(__file__).resolve().parents[2] / ".env"
    try:
        text = env_path.read_text(encoding="utf-8") if env_path.exists() else ""
        line = f"GROQ_API_KEY={api_key}"
        if re.search(r"^GROQ_API_KEY=.*$", text, flags=re.M):
            text = re.sub(r"^GROQ_API_KEY=.*$", line, text, flags=re.M)
        else:
            text = (text.rstrip() + "\n" + line + "\n") if text else line + "\n"
        env_path.write_text(text, encoding="utf-8")
        return True
    except Exception:
        return False


@router.get("/status")
async def groq_status():
    payload = groq_limit_state.status_payload()
    payload["configured"] = bool(groq_service.available)
    payload["key_hint"] = (
        (settings.GROQ_API_KEY[:7] + "…" + settings.GROQ_API_KEY[-4:])
        if settings.GROQ_API_KEY and len(settings.GROQ_API_KEY) > 12
        else None
    )
    return payload


@router.post("/api-key")
async def set_groq_api_key(body: GroqKeyBody = Body(...)):
    key = body.api_key.strip()
    if not key.startswith("gsk_"):
        raise HTTPException(status_code=400, detail="Groq API keys usually start with gsk_")
    ok = groq_service.reconfigure(key)
    if not ok:
        raise HTTPException(status_code=400, detail="Invalid or placeholder Groq API key")
    persisted = _persist_env_key(key)
    return {
        "success": True,
        "configured": True,
        "persisted_to_env": persisted,
        "status": groq_limit_state.status_payload(),
        "message": "Groq API key updated. Rate-limit lock cleared.",
    }
