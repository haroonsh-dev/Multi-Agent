"""
Provider Manager - Manages multiple AI provider keys and routes requests.

Providers supported: groq, openai, gemini, anthropic, custom
Each provider has its own API key, model, and base URL.
The manager handles fallback logic when a provider fails.
"""

import os
import json
import logging
from typing import Optional, Dict, Any, List
from pathlib import Path

logger = logging.getLogger(__name__)

STATE_DIR = Path(__file__).parent.parent.parent / "data"
PROVIDERS_STATE_FILE = STATE_DIR / "providers_config.json"


class ProviderConfig:
    """Configuration for a single AI provider."""
    def __init__(self, provider: str, api_key: str, model: str = "", base_url: str = "", label: str = ""):
        self.provider = (provider or "").strip().lower()
        self.api_key = (api_key or "").strip()
        self.model = (model or "").strip()
        self.base_url = (base_url or "").strip()
        self.label = (label or provider.title()).strip()

    def to_dict(self) -> dict:
        return {
            "provider": self.provider,
            "api_key": self.api_key,
            "model": self.model,
            "base_url": self.base_url,
            "label": self.label,
        }


def _is_valid_key(provider: str, api_key: str) -> bool:
    key = (api_key or "").strip()
    if not key or len(key) < 8:
        return False
    placeholders = {"gsk_your_groq_api_key", "gsk_your_groq_key_here", "your-api-key-here"}
    if key in placeholders or key.startswith("gsk_your_"):
        return False
    p = (provider or "").lower().strip()
    if p == "groq" and not key.startswith("gsk_"):
        return False
    if p == "gemini" and not (key.startswith("AIza") or (len(key) >= 30 and not key.startswith("AQ."))):
        return False
    if p == "openai" and (key.startswith("gsk_") or key.startswith("AIza") or key.startswith("sk-ant-")):
        return False
    return True


class ProviderManager:
    """
    Manages AI provider configurations with fallback support.

    Priority order: groq > openai > gemini > anthropic > custom
    When a provider hits rate limit, the next available provider is used.
    """

    PROVIDER_PRIORITY = ["gemini", "groq", "openai", "anthropic", "custom"]

    def __init__(self):
        self._providers: Dict[str, ProviderConfig] = {}
        self._primary_provider: Optional[str] = None
        self._load_from_state()

    def _load_from_state(self):
        """Load provider configs from persistent state file."""
        try:
            if PROVIDERS_STATE_FILE.exists():
                with open(PROVIDERS_STATE_FILE, "r") as f:
                    data = json.load(f)
                self._primary_provider = data.get("primary")
                for p in data.get("providers", []):
                    if _is_valid_key(p.get("provider", ""), p.get("api_key", "")):
                        self._providers[p["provider"]] = ProviderConfig(**p)
                logger.info(f"Loaded {len(self._providers)} providers from state file (primary={self._primary_provider})")
        except Exception as e:
            logger.warning(f"Failed to load providers state: {e}")

    def _save_state(self):
        """Persist provider configs to disk."""
        try:
            STATE_DIR.mkdir(parents=True, exist_ok=True)
            data = {
                "providers": [p.to_dict() for p in self._providers.values()],
                "primary": self._primary_provider or (list(self._providers.keys())[0] if self._providers else None),
            }
            with open(PROVIDERS_STATE_FILE, "w") as f:
                json.dump(data, f, indent=2)
        except Exception as e:
            logger.warning(f"Failed to save providers state: {e}")

    def set_provider(self, provider: str, api_key: str, model: str = "", base_url: str = ""):
        """Add or update a provider configuration."""
        if not _is_valid_key(provider, api_key):
            logger.warning(f"Rejecting invalid API key for provider '{provider}'")
            return
        self._providers[provider] = ProviderConfig(
            provider=provider, api_key=api_key, model=model, base_url=base_url
        )
        self._primary_provider = provider
        self._save_state()
        # Also update environment variables for compatibility
        env_key_map = {
            "groq": "GROQ_API_KEY",
            "openai": "OPENAI_API_KEY",
            "gemini": "GEMINI_API_KEY",
            "anthropic": "ANTHROPIC_API_KEY",
        }
        if provider in env_key_map:
            os.environ[env_key_map[provider]] = api_key
        logger.info(f"Provider {provider} configured with model={model}")

    def remove_provider(self, provider: str):
        """Remove a provider configuration."""
        self._providers.pop(provider, None)
        if getattr(self, "_primary_provider", None) == provider:
            self._primary_provider = list(self._providers.keys())[0] if self._providers else None
        env_key_map = {
            "groq": "GROQ_API_KEY",
            "openai": "OPENAI_API_KEY",
            "gemini": "GEMINI_API_KEY",
            "anthropic": "ANTHROPIC_API_KEY",
        }
        if provider in env_key_map:
            os.environ.pop(env_key_map[provider], None)
        self._save_state()

    def clear_all_providers(self):
        """Clear all configured providers."""
        self._providers.clear()
        self._primary_provider = None
        env_keys = ["GROQ_API_KEY", "OPENAI_API_KEY", "GEMINI_API_KEY", "ANTHROPIC_API_KEY"]
        for k in env_keys:
            os.environ.pop(k, None)
        self._save_state()

    def get_provider(self, provider: str) -> Optional[ProviderConfig]:
        """Get a specific provider config."""
        return self._providers.get(provider)

    def get_active_providers(self, preferred_provider: str = None) -> List[ProviderConfig]:
        """Get all configured providers in priority order, placing preferred_provider or primary provider first."""
        result = []
        for p in self.PROVIDER_PRIORITY:
            if p in self._providers and _is_valid_key(p, self._providers[p].api_key):
                result.append(self._providers[p])

        target_pref = (preferred_provider or getattr(self, "_primary_provider", None) or "").lower().strip()
        if target_pref:
            pref_cfg = next((cfg for cfg in result if cfg.provider == target_pref), None)
            if pref_cfg:
                result.remove(pref_cfg)
                result.insert(0, pref_cfg)

        return result

    def get_primary_provider(self) -> Optional[ProviderConfig]:
        """Get the primary (first available) provider."""
        active = self.get_active_providers()
        return active[0] if active else None

    def get_fallback_provider(self, failed_provider: str) -> Optional[ProviderConfig]:
        """
        Get the next available provider after the failed one.
        Used for automatic fallback when a provider hits rate limits or is not configured.
        """
        active = self.get_active_providers()
        if not active:
            return None
        failed_clean = (failed_provider or "").lower().strip()
        for i, p in enumerate(active):
            if p.provider == failed_clean:
                if i + 1 < len(active):
                    return active[i + 1]
                # Wrap around to the first provider (if multiple providers)
                if len(active) > 1:
                    return active[0]
                return None
        # If failed_provider was not in active, return first available alternative
        candidates = [p for p in active if p.provider != failed_clean]
        return candidates[0] if candidates else None

    def get_groq_key(self) -> str:
        """Get Groq API key configured from AI Settings."""
        p = self._providers.get("groq")
        return p.api_key if p else ""

    def get_config_summary(self) -> dict:
        """Get a summary of all configured providers."""
        return {
            "providers": [
                {
                    "provider": p.provider,
                    "label": p.label,
                    "model": p.model,
                    "hasKey": bool(p.api_key),
                    "isPrimary": p == self.get_primary_provider(),
                }
                for p in self._providers.values()
            ],
            "primary": self.get_primary_provider().provider if self.get_primary_provider() else None,
        }


# Module-level singleton
provider_manager = ProviderManager()
