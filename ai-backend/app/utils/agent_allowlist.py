"""Helpers to keep phase3 agent routing inside an org's plan allowlist."""
from __future__ import annotations

from typing import Iterable, Optional


def parse_allowed_agents(raw) -> list[str]:
    if raw is None:
        return []
    if isinstance(raw, list):
        return [str(x).strip() for x in raw if str(x).strip()]
    text = str(raw).strip()
    if not text:
        return []
    # JSON list or comma-separated
    if text.startswith("["):
        try:
            import json
            data = json.loads(text)
            if isinstance(data, list):
                return [str(x).strip() for x in data if str(x).strip()]
        except Exception:
            pass
    return [p.strip() for p in text.split(",") if p.strip()]


def clamp_agent(agent_id: Optional[str], allowed: Iterable[str] | None) -> Optional[str]:
    """If allowed list is set, force agent_id into it (prefer other_agent, else first)."""
    allowed_list = [a for a in (allowed or []) if a]
    if not allowed_list:
        return agent_id
    if not agent_id:
        return allowed_list[0] if len(allowed_list) == 1 else None
    if agent_id in allowed_list:
        return agent_id
    if "other_agent" in allowed_list:
        return "other_agent"
    return allowed_list[0]
