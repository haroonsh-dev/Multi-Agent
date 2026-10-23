import time
import logging
from typing import Optional
from langchain_core.chat_history import InMemoryChatMessageHistory
from langchain_core.messages import AIMessage, HumanMessage, SystemMessage
from langchain_core.prompts import ChatPromptTemplate, MessagesPlaceholder
from langchain_core.runnables.history import RunnableWithMessageHistory
from ..config import settings
from .orchestration_logger import get_chat_logger, C

_logger = logging.getLogger("visibility-docs")

_store: dict[str, InMemoryChatMessageHistory] = {}

SYSTEM_PROMPT = (
    "You are a strict, direct document analysis assistant.\n"
    "CRITICAL RULES:\n"
    "1. Answer questions DIRECTLY using ONLY the provided Document Context.\n"
    "2. DO NOT provide general background info, textbook definitions, introductory essays, or domain explanations.\n"
    "3. DO NOT use external world knowledge. DO NOT hallucinate, guess, or invent details.\n"
    "4. LANGUAGE: Default to English. If the user writes in English, answer in English only. "
    "Use Urdu or Roman Urdu only when the user's message is clearly in Urdu — do not reply in Urdu "
    "because document context contains Urdu text.\n"
    "5. TONE: Be professional and concise. Do NOT use emojis, emoticons, or decorative symbols.\n"
    "6. Prefer answering with the closest matching facts from the Document Context "
    "(summarize tables, list fields, quote relevant rows). "
    "Only if the context is empty or clearly unrelated may you say the information is not in the uploaded documents — "
    "and then briefly name what documents/sections you do have."
)

AGENT_SYSTEM_PROMPT = (
    "You are a strict, direct document analysis assistant. Follow the Agent Instructions carefully.\n"
    "CRITICAL RULES:\n"
    "1. Answer DIRECTLY using ONLY the provided Document Context.\n"
    "2. DO NOT include general background info, textbook definitions, or domain explanations.\n"
    "3. DO NOT use external world knowledge. DO NOT hallucinate, guess, or invent details.\n"
    "4. LANGUAGE: Default to English. If the user writes in English, answer in English only. "
    "Use Urdu or Roman Urdu only when the user's message is clearly in Urdu.\n"
    "5. TONE: Be professional and concise. Do NOT use emojis, emoticons, or decorative symbols.\n"
    "6. Prefer answering with the closest matching facts from the Document Context. "
    "Only if nothing relevant is present may you say it is not available in the documents."
)


def get_session_history(session_id: str) -> InMemoryChatMessageHistory:
    if session_id not in _store:
        _store[session_id] = InMemoryChatMessageHistory()
    return _store[session_id]


# Free-tier friendly Gemini models (gemini-2.5-pro often has limit:0 on free tier)
GEMINI_QUOTA_FALLBACK_MODELS = (
    "gemini-2.0-flash",
    "gemini-2.0-flash-lite",
    "gemini-1.5-flash",
    "gemini-1.5-flash-latest",
    "gemini-flash-latest",
)


def _is_rate_limit_error(err_str: str) -> bool:
    s = (err_str or "").lower()
    return any(
        term in s
        for term in (
            "429",
            "413",
            "rate limit",
            "rate_limit",
            "quota",
            "tpm",
            "tokens per minute",
            "request too large",
            "too many requests",
            "resource_exhausted",
        )
    )


def _normalize_provider_config(provider_cfg):
    """Fix common mistakes (OpenRouter key saved under OpenAI, etc.)."""
    if not provider_cfg:
        return provider_cfg
    from .provider_manager import ProviderConfig

    p_name = (provider_cfg.provider or "").lower().strip()
    key = (provider_cfg.api_key or "").strip()
    base_url = (provider_cfg.base_url or "").strip()
    model_name = (provider_cfg.model or "").strip()

    if key.startswith("sk-or-v1") and p_name in ("openai", "custom", ""):
        return ProviderConfig(
            provider="custom",
            api_key=key,
            model=model_name or "openai/gpt-4o-mini",
            base_url=base_url or "https://openrouter.ai/api/v1",
            label=getattr(provider_cfg, "label", "") or "OpenRouter",
        )
    return provider_cfg


def create_llm_from_config(provider_cfg):
    """Factory to create dynamic LangChain LLM instance for Groq, OpenAI, Anthropic, Gemini, or Custom endpoints.

    Returns (llm, provider_name) or (None, None). On failure, logs the reason.
    """
    provider_cfg = _normalize_provider_config(provider_cfg)
    if not provider_cfg or not provider_cfg.api_key:
        return None, None

    p_name = (provider_cfg.provider or "").lower().strip()
    key = (provider_cfg.api_key or "").strip()
    model_name = (provider_cfg.model or "").strip()
    base_url = (provider_cfg.base_url or "").strip()

    if not key or len(key) < 6:
        return None, None

    try:
        if p_name == "groq":
            try:
                from langchain_groq import ChatGroq
                return ChatGroq(
                    api_key=key,
                    model=model_name or "llama-3.3-70b-versatile",
                    temperature=0.0,
                    max_tokens=4096,
                ), "groq"
            except Exception as e:
                _logger.warning(f"ChatGroq import failed ({e}), using ChatOpenAI with Groq endpoint")
                from langchain_openai import ChatOpenAI
                return ChatOpenAI(
                    api_key=key,
                    base_url="https://api.groq.com/openai/v1",
                    model=model_name or "llama-3.3-70b-versatile",
                    temperature=0.0,
                    max_tokens=4096,
                ), "groq"
        elif p_name == "openai":
            from langchain_openai import ChatOpenAI
            return ChatOpenAI(
                api_key=key,
                model=model_name or "gpt-4o",
                temperature=0.0,
                max_tokens=4096,
            ), "openai"
        elif p_name == "anthropic":
            from langchain_anthropic import ChatAnthropic
            return ChatAnthropic(
                api_key=key,
                model=model_name or "claude-3-5-sonnet-20241022",
                temperature=0.0,
                max_tokens=4096,
            ), "anthropic"
        elif p_name == "gemini":
            from langchain_google_genai import ChatGoogleGenerativeAI
            # Flash is the free-tier-friendly default (Pro often has no free quota)
            g_model = model_name or "gemini-2.0-flash"
            return ChatGoogleGenerativeAI(
                google_api_key=key,
                model=g_model,
                temperature=0.0,
                max_output_tokens=4096,
                max_retries=1,
            ), "gemini"
        elif p_name == "custom":
            from langchain_openai import ChatOpenAI
            return ChatOpenAI(
                api_key=key,
                base_url=base_url or "https://api.mistral.ai/v1",
                model=model_name or "ministral-3b-latest",
                temperature=0.0,
                max_tokens=4096,
            ), "custom"
        else:
            _logger.warning(f"Unknown LLM provider: {p_name}")
            return None, None
    except ImportError as e:
        _logger.error(
            f"Missing package for provider '{p_name}': {e}. "
            f"Install with: pip install langchain-openai langchain-google-genai langchain-anthropic"
        )
        return None, None
    except Exception as e:
        _logger.warning(f"Failed to create LLM for provider {p_name}: {e}")
        return None, None


class ConversationService:
    def __init__(self):
        self.llm = None
        self._chain = None
        self._chain_with_history = None
        self._last_context: dict[str, str] = {}
        self._current_system_prompt = SYSTEM_PROMPT
        self.reconfigure()

    def reconfigure(self, preferred_provider: str = None):
        """Re-initializes LLMs using all active providers in priority order."""
        from .provider_manager import provider_manager
        active_providers = provider_manager.get_active_providers(preferred_provider=preferred_provider)
        self.llm = None
        self._chain = None
        self._chain_with_history = None

        for p_cfg in active_providers:
            llm_inst, p_name = create_llm_from_config(p_cfg)
            if llm_inst:
                self.llm = llm_inst
                self._setup_chain(self._current_system_prompt)
                _logger.info(f"[CONVERSATION_SERVICE] Active primary LLM set to {p_name} ({p_cfg.model})")
                return True

        _logger.warning("[CONVERSATION_SERVICE] No valid active AI providers configured.")
        return False

    def _setup_chain(self, system_prompt: str = None):
        if not self.llm:
            self._chain = None
            self._chain_with_history = None
            return

        sp = system_prompt or SYSTEM_PROMPT
        if sp == SYSTEM_PROMPT or "{" not in sp:
            prompt = ChatPromptTemplate.from_messages([
                ("system", sp),
                MessagesPlaceholder(variable_name="history"),
                ("human", "{agent_instructions}Document Context:\n{context}\n\nCRITICAL INSTRUCTION: If the context contains a table or list, carefully scan the ENTIRE table from top to bottom. Extract ALL matching rows or data points. DO NOT skip any rows or hallucinate missing data.\n\nQuestion: {question}"),
            ])
        else:
            prompt = ChatPromptTemplate.from_messages([
                ("system", AGENT_SYSTEM_PROMPT),
                MessagesPlaceholder(variable_name="history"),
                ("human", "{agent_instructions}Document Context:\n{context}\n\nCRITICAL INSTRUCTION: If the context contains a table or list, carefully scan the ENTIRE table from top to bottom. Extract ALL matching rows or data points. DO NOT skip any rows or hallucinate missing data.\n\nQuestion: {question}"),
            ])

        self._chain = prompt | self.llm

        self._chain_with_history = RunnableWithMessageHistory(
            self._chain,
            get_session_history,
            input_messages_key="question",
            history_messages_key="history",
        )

    def update_system_prompt(self, prompt_text: str):
        if prompt_text and prompt_text != self._current_system_prompt:
            self._current_system_prompt = prompt_text
            return True
        return False

    def load_history_from_db(self, session_id: str, messages: list[dict]):
        """Seed in-memory history from DB messages for this session."""
        sid = session_id or "default"
        history = get_session_history(sid)
        if history.messages:
            chat_log = get_chat_logger()
            chat_log.info(f"History already in memory for session '{sid}' ({len(history.messages)} msgs)")
            return
        for msg in messages:
            role = msg.get("role")
            content = msg.get("content", "")
            if role == "user":
                history.add_user_message(content)
            elif role == "assistant":
                history.add_ai_message(content)
        if messages:
            chat_log = get_chat_logger()
            chat_log.info(f"Loaded {len(messages)} messages from DB into session '{sid}'")

    def set_last_context(self, session_id: str, context: str):
        if session_id:
            self._last_context[session_id] = context

    def get_last_context(self, session_id: str) -> str:
        return self._last_context.get(session_id, "")

    def chat(self, question: str, context: str, session_id: str = None, is_followup: bool = False,
             system_prompt: str = None, provider: str = None, model: str = None,
             provider_config: dict | None = None) -> dict:
        chat_log = get_chat_logger()
        config = {"configurable": {"session_id": session_id or "default"}} if session_id else \
                 {"configurable": {"session_id": "default"}}

        chain_inputs = {"question": question}

        if system_prompt:
            changed = self.update_system_prompt(system_prompt)
            if changed:
                chat_log.info(f"System prompt updated to agent-specific prompt ({len(system_prompt)} chars)")

        if system_prompt and "{" in system_prompt:
            chain_inputs["agent_instructions"] = "Agent Instructions:\n" + system_prompt + "\n\n"
        else:
            chain_inputs["agent_instructions"] = ""
        chain_inputs["context"] = context

        if is_followup and not context:
            context = self.get_last_context(session_id)
            chat_log.info(f"No new context — reusing previous session context ({len(context)} chars)")
            chain_inputs["context"] = context

        if context:
            self.set_last_context(session_id, context)

        if context:
            try:
                hist = get_session_history(session_id or "default")
                for m in reversed(hist.messages):
                    if isinstance(m, AIMessage):
                        txt = m.content.strip()
                        if txt and txt not in context:
                            context += f"\n--\n[Previous Response]\n{txt}\n[/Previous Response]"
                            chain_inputs["context"] = context
                        break
            except Exception:
                pass

        # Keep last question and answer
        hist = None
        try:
            hist = get_session_history(session_id or "default")
            if hist is not None and len(hist.messages) > 2:
                messages_to_compress = hist.messages[:-4]
                kept = hist.messages[-4:]

                # Summarize old messages using active LLM
                old_text = ""
                for m in messages_to_compress:
                    role = "User" if isinstance(m, HumanMessage) else "Assistant"
                    old_text += f"{role}: {m.content}\n"

                summary_prompt = "Summarize the key points of the following chat history in 1-2 short sentences so an AI assistant can remember the context:\n\n" + old_text
                summary_result = ""
                if self.llm:
                    res = self.llm.invoke([HumanMessage(content=summary_prompt)])
                    summary_result = res.content if hasattr(res, "content") else str(res)
                else:
                    from .groq_service import groq_service
                    summary_result = groq_service.chat([{"role": "user", "content": summary_prompt}], max_tokens=150, temperature=0.1, model="llama-3.3-70b-versatile")

                hist.clear()
                hist.add_message(SystemMessage(content=f"[Prior Conversation Summary: {summary_result.strip()}]"))
                for m in kept:
                    hist.add_message(m)
                chat_log.info(f"Compressed {len(messages_to_compress)} old messages into a summary.")
        except Exception as e:
            chat_log.info(f"History compression failed: {e}")

        # Ensure active provider is loaded from provider_manager (placing selected provider first)
        from .provider_manager import ProviderConfig, provider_manager
        active_providers = provider_manager.get_active_providers(preferred_provider=provider)

        # Gateway may pass MongoDB API keys so chat works even if local provider_manager isn't synced
        if provider_config:
            api_key = (provider_config.get("api_key") or provider_config.get("apiKey") or "").strip()
            if api_key:
                injected = ProviderConfig(
                    provider=(provider_config.get("provider") or provider or "custom"),
                    api_key=api_key,
                    model=(provider_config.get("model") or model or ""),
                    base_url=(provider_config.get("base_url") or provider_config.get("baseUrl") or ""),
                )
                rest = [
                    p for p in active_providers
                    if not (p.provider == injected.provider and p.api_key == injected.api_key)
                ]
                active_providers = [injected] + rest

        if not active_providers:
            chat_log.warn("No active AI provider configured in settings")
            return {
                "answer": "⚠️ No active AI provider configured. Please go to AI Settings and enter your API key (Groq, OpenAI, Gemini, or Anthropic).",
                "provider": "system",
                "model": "configuration_required",
            }

        last_error = None
        preferred = (provider or "").lower().strip()
        preferred_create_failed = False
        fallback_from = None  # e.g. "gemini/gemini-2.5-pro" when we had to switch

        # Expand Gemini configs: on quota, try Flash models before leaving Gemini
        expanded: list = []
        for p_cfg in active_providers:
            expanded.append(p_cfg)
            if (p_cfg.provider or "").lower().strip() == "gemini":
                current = (p_cfg.model or model or "").strip()
                for alt in GEMINI_QUOTA_FALLBACK_MODELS:
                    if alt == current:
                        continue
                    expanded.append(
                        ProviderConfig(
                            provider="gemini",
                            api_key=p_cfg.api_key,
                            model=alt,
                            base_url=p_cfg.base_url,
                            label=getattr(p_cfg, "label", "") or "",
                        )
                    )

        # Provider Failover Waterfall
        for p_cfg in expanded:
            cfg_to_use = p_cfg

            llm_inst, p_name = create_llm_from_config(cfg_to_use)
            if not llm_inst:
                if preferred and (cfg_to_use.provider or "").lower().strip() == preferred:
                    if (cfg_to_use.provider or "").lower().strip() == "gemini":
                        continue
                    preferred_create_failed = True
                    last_error = (
                        f"Could not start provider '{preferred}'. "
                        "Missing Python package or invalid API key. "
                        "Run in ai-backend venv: pip install langchain-openai langchain-google-genai langchain-anthropic"
                    )
                    break
                continue

            self.llm = llm_inst
            self._setup_chain(self._current_system_prompt)

            if not self._chain_with_history:
                continue

            m_name = getattr(cfg_to_use, "model", "") or "default"
            print(f"\n==================================================")
            print(f"  🤖 [CHAT EXECUTION]")
            print(f"  Active Provider: {p_name.upper()}")
            print(f"  Active Model:    {m_name}")
            print(f"  Session ID:      {session_id or 'default'}")
            print(f"==================================================\n")

            chat_log.info(f"Invoking LangChain chain: provider={p_name}, model={m_name}, followup={is_followup}")
            _logger.info(f"[CHAT] session={session_id}, provider={p_name}, model={m_name}, context_len={len(context)}, is_followup={is_followup}")

            try:
                t0 = time.time()
                response = self._chain_with_history.invoke(
                    chain_inputs,
                    config=config,
                )
                duration = time.time() - t0
                output_len = len(response.content)
                chat_log.info(f"LangChain invoke done on {p_name}: {output_len} chars in {duration:.1f}s")

                content = response.content if hasattr(response, "content") else str(response)
                import re
                content = re.sub(r"<think>.*?</think>", "", content, flags=re.DOTALL).strip()
                result = {
                    "answer": content,
                    "provider": p_name,
                    "model": m_name,
                }
                if fallback_from and fallback_from != f"{p_name}/{m_name}":
                    result["fallback_from"] = fallback_from
                    result["answer"] = (
                        f"_(Used {p_name}/{m_name} — {fallback_from} hit quota)_\n\n" + content
                    )
                return result
            except Exception as e:
                err_str = str(e)
                last_error = err_str
                _logger.warning(f"LLM call failed on provider '{cfg_to_use.provider}': {err_str}")
                if _is_rate_limit_error(err_str):
                    fallback_from = f"{p_name}/{m_name}"
                    chat_log.info(
                        f"Rate/Token limit hit on {p_name}/{m_name} — trying next model/provider..."
                    )
                    continue
                if preferred and p_name == preferred:
                    if p_name == "gemini":
                        fallback_from = f"{p_name}/{m_name}"
                        continue
                    break
                continue

        if preferred_create_failed:
            return {
                "answer": f"⚠️ {last_error}",
                "provider": "system",
                "model": "provider_unavailable",
            }

        if _is_rate_limit_error(last_error or ""):
            return {
                "answer": (
                    "⚠️ Gemini/OpenAI quota limit hit"
                    + (f" ({fallback_from})" if fallback_from else "")
                    + ". Free tier often blocks gemini-2.5-pro — switch model to "
                    "**gemini-2.0-flash** in AI Settings, wait ~1 minute, or use Groq."
                ),
                "provider": "system",
                "model": "rate_limit_cooldown",
                "fallback_from": fallback_from,
            }

        return {
            "answer": f"⚠️ AI Service Call Failed: {last_error or 'No active provider available. Please check your API key in AI Settings.'}",
            "provider": "system",
            "model": "error",
        }

    def get_history(self, session_id: str = None) -> list[dict]:
        sid = session_id or "default"
        history = _store.get(sid)
        if not history:
            return []
        msgs = history.messages
        result = []
        for m in msgs:
            if isinstance(m, HumanMessage):
                result.append({"role": "user", "content": m.content})
            elif isinstance(m, AIMessage):
                result.append({"role": "assistant", "content": m.content})
        return result


conversation_service = ConversationService()
