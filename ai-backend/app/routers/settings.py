"""
Settings router - Receives provider configurations from the API gateway
and manages multi-provider support with fallback logic.
"""

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field
from typing import Optional
from ..services.provider_manager import provider_manager

router = APIRouter(prefix="/api/v1/settings", tags=["settings"])


class ProviderUpdateBody(BaseModel):
    provider: str = Field(..., min_length=1)
    apiKey: Optional[str] = ""
    model: Optional[str] = ""
    baseUrl: Optional[str] = ""


class ProviderDeleteBody(BaseModel):
    provider: str = Field(..., min_length=1)


@router.get("/providers")
async def list_providers():
    """List all configured providers and their status."""
    return {
        "success": True,
        "data": provider_manager.get_config_summary(),
    }


@router.post("/providers")
async def update_provider(body: ProviderUpdateBody):
    """Add or update a provider configuration."""
    valid_providers = ["groq", "openai", "gemini", "anthropic", "custom"]
    if body.provider not in valid_providers:
        raise HTTPException(status_code=400, detail=f"Invalid provider. Must be one of: {valid_providers}")

    api_key = (body.apiKey or "").strip()
    if "*" in api_key:
        existing_cfg = provider_manager.get_provider(body.provider)
        if existing_cfg:
            api_key = existing_cfg.api_key

    if api_key:
        provider_manager.set_provider(
            provider=body.provider,
            api_key=api_key,
            model=body.model or "",
            base_url=body.baseUrl or "",
        )

    try:
        from ..services.conversation_service import conversation_service
        conversation_service.reconfigure(preferred_provider=body.provider)
        if body.provider == "groq" and api_key and "*" not in api_key:
            from ..services.groq_service import groq_service
            groq_service.reconfigure(api_key)
    except Exception as e:
        print(f"[SETTINGS] Warning reconfiguring Services for {body.provider}: {e}")

    return {
        "success": True,
        "message": f"Provider {body.provider} configured successfully",
        "data": provider_manager.get_config_summary(),
    }


@router.delete("/providers")
async def clear_all_providers():
    """Clear all configured providers."""
    provider_manager.clear_all_providers()
    try:
        from ..services.groq_service import groq_service
        groq_service._configure("")
    except Exception:
        pass
    try:
        from ..services.conversation_service import conversation_service
        conversation_service.reconfigure(preferred_provider="")
    except Exception:
        pass
    return {
        "success": True,
        "message": "All providers removed",
        "data": provider_manager.get_config_summary(),
    }


@router.delete("/providers/{provider}")
async def remove_provider(provider: str):
    """Remove a provider configuration."""
    provider_manager.remove_provider(provider)
    if provider == "groq":
        try:
            from ..services.groq_service import groq_service
            groq_service._configure("")
        except Exception:
            pass
    try:
        from ..services.conversation_service import conversation_service
        conversation_service.reconfigure(preferred_provider="")
    except Exception:
        pass
    return {
        "success": True,
        "message": f"Provider {provider} removed",
        "data": provider_manager.get_config_summary(),
    }


class PrimaryProviderBody(BaseModel):
    provider: str
    apiKey: Optional[str] = ""
    model: Optional[str] = ""
    baseUrl: Optional[str] = ""


@router.get("/providers/primary")
async def get_primary():
    """Get the primary (currently active) provider."""
    primary = provider_manager.get_primary_provider()
    if not primary:
        return {"success": True, "data": {"provider": None, "message": "No providers configured"}}
    return {
        "success": True,
        "data": {
            "provider": primary.provider,
            "model": primary.model,
            "base_url": primary.base_url,
        },
    }


@router.post("/providers/primary")
async def set_primary_provider(body: PrimaryProviderBody):
    """Set the primary (active) AI provider."""
    valid_providers = ["groq", "openai", "gemini", "anthropic", "custom"]
    if body.provider not in valid_providers:
        raise HTTPException(status_code=400, detail=f"Invalid provider. Must be one of: {valid_providers}")

    if body.apiKey:
        provider_manager.set_provider(
            provider=body.provider,
            api_key=body.apiKey,
            model=body.model or "",
            base_url=body.baseUrl or "",
        )
    else:
        provider_manager._primary_provider = body.provider
        provider_manager._save_state()

    try:
        from ..services.conversation_service import conversation_service
        conversation_service.reconfigure(preferred_provider=body.provider)
        if body.provider == "groq" and body.apiKey:
            from ..services.groq_service import groq_service
            groq_service.reconfigure(body.apiKey)
    except Exception as e:
        print(f"[SETTINGS] Warning setting primary provider {body.provider}: {e}")

    return {
        "success": True,
        "message": f"Primary active provider set to {body.provider}",
        "data": provider_manager.get_config_summary(),
    }
