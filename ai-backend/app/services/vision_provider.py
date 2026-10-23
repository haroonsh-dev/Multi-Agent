import os
import re
import io
import time
import base64
import logging
from typing import Optional

logger = logging.getLogger("visibility-docs")

VISION_IMAGE_PROMPT = """You are a precision OCR engine and document data extractor.

Instructions:
1. Extract ALL visible text, numbers, tables, headings, and labels from this image with 100% fidelity.
2. Format any tabular data strictly as Markdown tables (| Header | Header |).
3. Output ONLY clean Markdown text — NEVER include conversational text, reasoning, self-corrections, or intros.
4. ABSOLUTELY NO internal monologue like "Wait, looking at..." or "Let me re-examine...". Output ONLY visible document text."""


def _decode_b64_to_bytes(b64_str: str) -> bytes:
    return base64.b64decode(b64_str)


def _is_blank_b64(b64_str: str, threshold: float = 10.0) -> bool:
    try:
        from PIL import Image
        img_bytes = _decode_b64_to_bytes(b64_str)
        pil = Image.open(io.BytesIO(img_bytes)).convert("L")
        pixels = list(pil.getdata())
        if len(pixels) < 100:
            return True
        avg = sum(pixels) / len(pixels)
        variance = sum((p - avg) ** 2 for p in pixels) / len(pixels)
        return variance ** 0.5 < threshold
    except Exception:
        return False


class VisionProvider:
    SUPPORTED_PROVIDERS = {"groq", "gemini", "openai", "anthropic", "ollama"}

    def __init__(self):
        from ..config import settings
        self.provider = (os.getenv("VISION_PROVIDER") or "groq").lower()
        self.api_key = os.getenv("VISION_API_KEY") or settings.GROQ_API_KEY or os.getenv("GROQ_API_KEY", "")
        self.model = os.getenv("VISION_MODEL") or ""
        self.api_base = os.getenv("VISION_API_BASE") or ""

    def analyze(self, b64_image: str) -> dict:
        if not b64_image:
            return {"markdown": "", "error": "no image data"}
        if _is_blank_b64(b64_image):
            return {"markdown": "", "error": "blank image"}

        from .provider_manager import provider_manager
        active_providers = provider_manager.get_active_providers()

        markdown = ""
        if not active_providers:
            # Fall back to env provider
            active_providers = [provider_manager.get_provider(self.provider)] if provider_manager.get_provider(self.provider) else []

        for cfg in active_providers:
            if not cfg:
                continue
            p_name = cfg.provider.lower()
            key = cfg.api_key
            model = cfg.model

            if p_name == "groq":
                markdown = self._call_groq(b64_image)
            elif p_name == "gemini":
                markdown = self._call_gemini(b64_image, api_key=key, model=model)
            elif p_name == "openai":
                markdown = self._call_openai(b64_image, api_key=key, model=model)
            elif p_name == "anthropic":
                markdown = self._call_anthropic(b64_image, api_key=key, model=model)
            elif p_name == "ollama":
                markdown = self._call_ollama(b64_image)

            if markdown and not markdown.startswith("[") and not markdown.startswith("⚠️"):
                break

        if not markdown or markdown.startswith("["):
            return {"markdown": "", "error": "Vision API call failed or no active key configured"}

        parsed = self._parse_markdown(markdown)
        parsed["markdown"] = markdown
        return parsed

    def _call_groq(self, b64_image: str) -> str:
        from .groq_service import groq_service
        if not groq_service.available or not groq_service.vision_available:
            logger.warning("Groq vision not available")
            return ""
        content = [
            {"type": "text", "text": VISION_IMAGE_PROMPT},
            {"type": "image_url", "image_url": {"url": f"data:image/jpeg;base64,{b64_image}"}},
        ]
        max_retries = 2
        for attempt in range(max_retries):
            try:
                result = groq_service.chat_vision(
                    [{"role": "user", "content": content}],
                    temperature=0.0,
                    max_tokens=2048,
                )
                if result and not result.startswith("[Groq"):
                    return result
                return ""
            except Exception as e:
                err_str = str(e)
                if "429" in err_str or "rate_limit" in err_str.lower():
                    logger.warning("Groq Vision API rate limited (429) — triggering fast local OCR fallback immediately")
                    return ""
                logger.error(f"Groq vision call failed: {e}")
                return ""
        return ""

    def _call_gemini(self, b64_image: str, api_key: str = "", model: str = "") -> str:
        key = api_key
        if not key:
            from .provider_manager import provider_manager
            cfg = provider_manager.get_provider("gemini")
            key = cfg.api_key if cfg else ""
        if not key:
            logger.warning("Gemini API key not configured in AI Settings")
            return ""

        use_model = model or "gemini-2.0-flash"
        import httpx
        url = f"https://generativelanguage.googleapis.com/v1beta/models/{use_model}:generateContent?key={key}"
        payload = {
            "contents": [
                {
                    "parts": [
                        {"text": VISION_IMAGE_PROMPT},
                        {
                            "inline_data": {
                                "mime_type": "image/jpeg",
                                "data": b64_image,
                            }
                        },
                    ]
                }
            ],
            "generationConfig": {"temperature": 0.0, "maxOutputTokens": 2048},
        }
        headers = {"Content-Type": "application/json"}
        try:
            resp = httpx.post(url, json=payload, headers=headers, timeout=120)
            resp.raise_for_status()
            data = resp.json()
            candidates = data.get("candidates", [])
            if candidates and "content" in candidates[0]:
                parts = candidates[0]["content"].get("parts", [])
                if parts:
                    return parts[0].get("text", "")
            return ""
        except Exception as e:
            logger.error(f"Gemini vision call failed: {e}")
            return ""

    def _call_openai(self, b64_image: str, api_key: str = "", model: str = "") -> str:
        key = api_key
        if not key:
            from .provider_manager import provider_manager
            cfg = provider_manager.get_provider("openai")
            key = cfg.api_key if cfg else ""
        if not key:
            logger.warning("OpenAI API key not configured in AI Settings")
            return ""

        use_model = model or self.model or "gpt-4o"
        api_base = self.api_base or "https://api.openai.com/v1"

        import httpx
        content = [
            {"type": "text", "text": VISION_IMAGE_PROMPT},
            {
                "type": "image_url",
                "image_url": {
                    "url": f"data:image/jpeg;base64,{b64_image}",
                    "detail": "high",
                },
            },
        ]
        payload = {
            "model": use_model,
            "messages": [{"role": "user", "content": content}],
            "max_tokens": 2048,
            "temperature": 0.0,
        }
        headers = {
            "Authorization": f"Bearer {key}",
            "Content-Type": "application/json",
        }
        chat_url = f"{api_base.rstrip('/')}/chat/completions"
        try:
            resp = httpx.post(chat_url, json=payload, headers=headers, timeout=120)
            resp.raise_for_status()
            return resp.json()["choices"][0]["message"]["content"]
        except Exception as e:
            err_str = str(e)
            if "429" in err_str or "rate_limit" in err_str.lower():
                logger.warning(f"OpenAI rate limited: {err_str}")
            else:
                logger.error(f"OpenAI vision call failed: {e}")
            return ""

    def _call_anthropic(self, b64_image: str, api_key: str = "", model: str = "") -> str:
        key = api_key
        if not key:
            from .provider_manager import provider_manager
            cfg = provider_manager.get_provider("anthropic")
            key = cfg.api_key if cfg else ""
        if not key:
            logger.warning("Anthropic API key not configured in AI Settings")
            return ""

        use_model = model or "claude-3-5-sonnet-20241022"
        import httpx
        url = "https://api.anthropic.com/v1/messages"
        payload = {
            "model": use_model,
            "max_tokens": 2048,
            "messages": [
                {
                    "role": "user",
                    "content": [
                        {
                            "type": "image",
                            "source": {
                                "type": "base64",
                                "media_type": "image/jpeg",
                                "data": b64_image,
                            },
                        },
                        {"type": "text", "text": VISION_IMAGE_PROMPT},
                    ],
                }
            ],
        }
        headers = {
            "x-api-key": key,
            "anthropic-version": "2023-06-01",
            "content-type": "application/json",
        }
        try:
            resp = httpx.post(url, json=payload, headers=headers, timeout=120)
            resp.raise_for_status()
            data = resp.json()
            content = data.get("content", [])
            if content and content[0].get("type") == "text":
                return content[0].get("text", "")
            return ""
        except Exception as e:
            logger.error(f"Anthropic vision call failed: {e}")
            return ""

    def _call_ollama(self, b64_image: str) -> str:
        import httpx
        payload = {
            "model": self.model or "llama3.2-vision",
            "messages": [
                {
                    "role": "user",
                    "content": VISION_IMAGE_PROMPT,
                    "images": [b64_image],
                }
            ],
            "options": {"temperature": 0.0},
        }
        try:
            resp = httpx.post(
                f"{(self.api_base or 'http://localhost:11434').rstrip('/')}/api/chat",
                json=payload,
                timeout=120,
            )
            resp.raise_for_status()
            return resp.json().get("message", {}).get("content", "")
        except Exception as e:
            logger.error(f"Ollama vision call failed: {e}")
            return ""

    def _parse_markdown(self, md: str) -> dict:
        result = {
            "title": "",
            "ocr_text": "",
            "components": [],
            "labels": [],
            "warnings": [],
            "description": "",
        }
        sections = re.split(r'^##\s+', md, flags=re.MULTILINE)
        for section in sections:
            if not section.strip():
                continue
            lines = section.strip().split("\n")
            heading = lines[0].strip().lower()
            content = "\n".join(lines[1:]).strip()
            if heading.startswith("figure title"):
                result["title"] = content
            elif heading.startswith("ocr"):
                result["ocr_text"] = content
            elif heading.startswith("component"):
                result["components"] = [c.strip() for c in content.split(",") if c.strip()]
            elif heading.startswith("label"):
                result["labels"] = [c.strip() for c in content.split(",") if c.strip()]
            elif heading.startswith("warning"):
                result["warnings"] = [c.strip() for c in content.split("\n") if c.strip()]
            elif heading.startswith("description"):
                result["description"] = content
        return result


vision_provider = VisionProvider()
