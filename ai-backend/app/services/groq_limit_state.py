"""Persistent Groq rate-limit lock shared across workers/requests."""
from __future__ import annotations

import json
import os
import re
import time
from pathlib import Path
from typing import Any

_STATE_PATH = Path(
    os.getenv("GROQ_LIMIT_STATE_PATH")
    or Path(__file__).resolve().parents[2] / "data" / "groq_rate_limit.json"
)


def _ensure_parent():
    _STATE_PATH.parent.mkdir(parents=True, exist_ok=True)


def read_state() -> dict[str, Any]:
    try:
        if _STATE_PATH.exists():
            return json.loads(_STATE_PATH.read_text(encoding="utf-8"))
    except Exception:
        pass
    return {}


def write_state(data: dict[str, Any]) -> None:
    _ensure_parent()
    _STATE_PATH.write_text(json.dumps(data, indent=2), encoding="utf-8")


def clear_limit() -> None:
    write_state({})


def is_limited() -> bool:
    state = read_state()
    until = float(state.get("until_ts") or 0)
    return until > time.time()


def seconds_remaining() -> int:
    state = read_state()
    until = float(state.get("until_ts") or 0)
    return max(0, int(until - time.time()))


def status_payload() -> dict[str, Any]:
    state = read_state()
    until = float(state.get("until_ts") or 0)
    limited = until > time.time()
    return {
        "limited": limited,
        "until_ts": until if limited else None,
        "retry_after_seconds": max(0, int(until - time.time())) if limited else 0,
        "message": state.get("message") or None,
        "model": state.get("model") or None,
        "console_url": "https://console.groq.com/keys",
        "billing_url": "https://console.groq.com/settings/billing",
    }


def parse_retry_seconds(err_msg: str) -> int:
    """Parse Groq retry hint; TPD (tokens per day) defaults toward 24h, TPM toward 60s."""
    msg = err_msg or ""
    lower = msg.lower()

    hours = minutes = seconds = 0.0
    hm = re.search(r"(\d+)\s*h", lower)
    mm = re.search(r"(\d+)\s*m", lower)
    sm = re.search(r"([\d.]+)\s*s", lower)
    if hm:
        hours = float(hm.group(1))
    if mm:
        minutes = float(mm.group(1))
    if sm:
        seconds = float(sm.group(1))
    parsed = int(hours * 3600 + minutes * 60 + seconds)

    # Daily token budget — UI shows ~24h wait as requested
    if "per day" in lower or "tpd" in lower or "tokens per day" in lower:
        return max(parsed, 24 * 3600) if parsed else 24 * 3600

    if parsed > 0:
        return parsed

    # Tokens per minute (TPM) or 413 Payload Too Large — lock for 60s max
    if "per minute" in lower or "tpm" in lower or "tokens per minute" in lower or "413" in lower or "too large" in lower:
        return 60

    return 60


def mark_limited(err_msg: str, model: str | None = None) -> dict[str, Any]:
    retry = parse_retry_seconds(err_msg)
    until = time.time() + retry
    state = {
        "until_ts": until,
        "message": (err_msg or "")[:500],
        "model": model,
        "set_at": time.time(),
    }
    write_state(state)
    return status_payload()
