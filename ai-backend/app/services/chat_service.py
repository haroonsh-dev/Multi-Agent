import json
import re
import time
from .conversation_service import conversation_service
from .rag_service import rag_service
from .document_service import document_service
from ..database import SupabaseDB
from .orchestration_logger import get_chat_logger, C
from .agent_orchestrator import _load_phase3_prompt, _load_prompt, get_phase3_prompt_for_doc, DOCUMENT_TO_PHASE3_AGENT, PHASE3_AGENT_PROMPT_MAP
from .agent_registry import agent_ids as _registry_agent_ids, doc_type_to_agent as _registry_doc_types
from ..utils.agent_allowlist import clamp_agent, parse_allowed_agents

_RESUME_KEYWORDS = ["resume", r"\bcv\b", "candidate", "applicant", "hiring", "recruit",
                    "top.*resume", "best.*candidate", "rank.*resume", "score.*resume",
                    "sorted.*resume", "highest.*score", "top.*candidate",
                    "give me.*top", "list.*resume", "show.*candidate", "list.*candidate",
                    "top.*resume", "recommend.*candidate", "best.*fit"]

_AGGREGATE_KEYWORDS = [r"\bsum\b", r"\btotal\b", r"\baggregate\b", r"\bcombine\b",
                       r"\boverall\b", r"\bgrand total\b", r"\ball\b.*\btotal\b",
                       r"\btotal\b.*\ball\b", r"\badd up\b", r"\bsum up\b",
                       r"\baccumulated\b", r"\bcombined\b", r"\btogether\b"]

_CHITCHAT_PATTERNS = [
    r"^(hi|hii+|hello|hey|hy|helo|hola|salam|assalam.?o.?alaikum|aoa|slm)\b",
    r"^(good\s*(morning|afternoon|evening|night)|gm|gn)\b",
    r"^(how are you|how's it going|how r u|whats? up|sup)\??$",
    r"^(thanks?|thank you|thx|ty|shukriya|jazakallah)\b",
    r"^(ok|okay|okaye|k|kk|cool|great|nice|awesome|perfect|alright)\b",
    r"^(bye|goodbye|see you|take care|tc)\b",
    r"^(yes|no|yep|yup|nope|yeah|nah)\b",
    r"^(who are you|what can you do|what you can do|help|help me)\??$",
]

# Cross-document "list a field from every file" intent (used when NO document is selected)
_CROSS_DOC_PHRASES = [
    "all files", "all documents", "all the files", "all of the files", "all of them",
    "every file", "every document", "each file", "each document", "each of the",
    "from all", "across all", "in every", "of every", "saari files", "har file",
    "tamam documents", "sari files", "تمام فائلیں",
]
_CROSS_DOC_WORDS = {
    "all", "every", "each", "list", "both", "saari", "sari", "har", "tamam", "sab",
    "تمام", "ساری", "ہر",
}
# Tokens to drop when extracting the target field from the query
_CROSS_DOC_DROP = {
    "all", "every", "each", "both", "list", "the", "of", "for", "with", "in", "on",
    "my", "me", "do", "la", "give", "show", "find", "from", "across", "and", "or",
    "files", "file", "documents", "document", "docs", "mujhe", "batao",
    "dikhao", "nikal", "nikalo", "chahiye", "ke", "ki", "ka", "kay", "kai", "ko",
    "please", "can", "you", "could",
}

# Reply language — English by default; Urdu only when the user clearly writes in Urdu
_LANGUAGE_RULE = (
    "LANGUAGE: Default to English. If the user writes in English, you MUST answer in English only. "
    "Use Urdu or Roman Urdu only when the user's message is clearly in Urdu (Arabic script or Roman Urdu). "
    "Do not answer in Urdu because document context contains Urdu text."
)

_TONE_RULE = (
    "TONE: Be professional and concise. Do NOT use emojis, emoticons, or decorative symbols in any reply."
)

_CAPABILITY_PATTERNS = [
    r"what can you do",
    r"what you can do",
    r"what (?:are you|can you) able to",
    r"what tasks can you",
    r"what you can accomplish",
    r"your capabilities",
    r"how (?:can|do) i proceed",
    r"how to proceed",
    r"what do you support",
    r"list (?:your )?(?:capabilities|features|tasks)",
    r"what(?:'s| is) possible",
    r"help me understand what you",
    r"structured breakdown",
    r"what (?:can|could) you help",
]


def _is_capability_question(question: str) -> bool:
    q = (question or "").strip().lower()
    if not q or len(q) > 260:
        return False
    return any(re.search(p, q, re.IGNORECASE) for p in _CAPABILITY_PATTERNS)


def _sanitize_extraction_prompt_for_chat(raw: str) -> str:
    """Strip JSON/schema extraction instructions — chat must not regurgitate skill.md as a task list."""
    cleaned = raw or ""
    section_patterns = [
        r"##\s*(?:Field Extraction Example|Extraction Example|Field Specifications|Few-Shot Example|Edge Cases).*?(?=\n##|\n# |\Z)",
        r"#\s*(?:Strict Rules|Chain-of-Thought|Source Grounding|Required Output Format|CRITICAL).*?(?=\n# |\Z)",
        r"##\s*Visual Graph & Chart Generation.*?(?=\n##|\n# |\Z)",
        r"##\s*Multi-invoice / vendor total questions.*?(?=\n##|\n# |\Z)",
    ]
    for pat in section_patterns:
        cleaned = re.sub(pat, "", cleaned, flags=re.DOTALL | re.IGNORECASE)
    cleaned = re.sub(r"```json.*?```", "", cleaned, flags=re.DOTALL | re.IGNORECASE)
    cleaned = re.sub(r"Return ONLY valid JSON\..*?(?=\n|\Z)", "", cleaned, flags=re.DOTALL | re.IGNORECASE)
    cleaned = cleaned.replace("{text}", "{context}")
    cleaned = re.sub(r"\nDocument text:\n\{context\}", "", cleaned)
    cleaned = re.sub(r"\n{3,}", "\n\n", cleaned).strip()
    return cleaned


def _append_chat_qa_rules(
    prompt: str,
    *,
    is_finance: bool = False,
    is_resume_query: bool = False,
    resumes: list | None = None,
) -> str:
    """Mandatory chat rules — always appended so extraction prompts never become the whole system prompt."""
    rules = [
        "\n\nChat rules (mandatory):",
        f"0. {_LANGUAGE_RULE} {_TONE_RULE}",
        "1. Answer the user's question directly — never output a capability manifesto, numbered task list, "
        "'How to Proceed', or 'Limitations' section.",
        "2. Never repeat, quote, or summarize internal guidelines, Domain Guidelines, or extraction schemas.",
        "3. If the user asks what you can do, give 3–4 short bullets only, then invite one specific question.",
        "4. Answer concisely using the document context provided in the user message.",
        "5. If the answer is NOT in the context, say you cannot find it in the documents.",
        "6. Do NOT make up or hallucinate information.",
        "7. Do NOT output JSON or field-extraction schemas unless the user explicitly requests JSON.",
    ]
    if is_finance:
        rules.extend([
            "8. Be exact about amounts, dates, and names. Use PKR when the document/context uses PKR.",
            "9. Never invent portfolio-wide vendor totals — use scoped analytics or computed totals from context.",
        ])
    else:
        rules.append(
            "8. NEVER provide textbook definitions or general essays — answer only about the specific documents asked."
        )
    if is_resume_query and resumes and any(r.get("cv_score") is not None for r in resumes):
        rules.append(
            "9. The context may include [Resume Rankings] with CV scores — use them when ranking candidates."
        )
    return (prompt or "").rstrip() + "\n" + "\n".join(rules)


def _wants_rag_inline_chart(question: str) -> bool:
    """Only embed LLM json:chart blocks when the user asked for analytics/charts."""
    q = (question or "").lower().strip()
    if not q:
        return False
    text_explain = re.search(
        r"\b(explain|overview|summary|summarize|describe|profile|tell me about|what is|what are|break down)\b",
        q,
    )
    chart_words = re.search(
        r"\b(chart|graph|graphs|visuali[sz]e|visual|plot|analytics|dashboard|breakdown|ranking|scores)\b",
        q,
    )
    if text_explain and not chart_words:
        return False
    if chart_words:
        return True
    if re.search(r"\b(show me|give me|show a)\b.*\b(chart|graph|visual|analytics|ranking|scores)\b", q):
        return True
    if re.search(r"\b(rank|ranking|top \d+|score|scores|distribution|histogram)\b", q):
        return True
    return False


class ChatService:
    @staticmethod
    def _is_chitchat(question: str) -> bool:
        """True for greetings / small-talk that do not need document retrieval."""
        if _is_capability_question(question):
            return True
        q = (question or "").strip().lower()
        if not q or len(q) > 80:
            return False
        # If it clearly asks about docs/data, never treat as chitchat
        doc_hints = (
            "resume", "cv", "invoice", "document", "file", "score", "candidate",
            "pdf", "contract", "find", "show", "list", "who", "what is", "kitne",
            "kitna", "batao", "tell me", "search", "summar", "extract",
        )
        if any(h in q for h in doc_hints):
            return False
        return any(re.search(p, q, re.IGNORECASE) for p in _CHITCHAT_PATTERNS)

    @staticmethod
    def _capability_reply(agent: str) -> str:
        replies = {
            "finance_agent": (
                "I analyze finance files in scope as **AP (vendors)** and **AR (clients)** — spend, aging, trends, and line items. "
                "Try: **grand total**, **chart vendor spend**, **overdue invoices**, or **generate a finance report**. "
                "Name a file to focus on one invoice."
            ),
            "hr_agent": (
                "I handle HR work from your scoped documents — CVs, leave, certificates, payroll, attendance, and letters. "
                "Ask in plain language, e.g. **top candidates**, **generate offer letter**, or **summarize this resume**."
            ),
            "legal_agent": (
                "I answer from scoped contracts — parties, dates, risk flags, clause types, and values when extracted. "
                "Try: **expiring contracts**, **chart risk flags**, or **summarize this agreement**."
            ),
            "compliance_agent": (
                "I work on compliance docs — expiry, findings, status, missing items, and reports. "
                "Try: **overdue certificates**, **compliance report**, or **list open findings**."
            ),
            "procurement_agent": (
                "I analyze POs, quotations, and RFQs in scope — supplier amounts and PO vs invoice when fields exist. "
                "Try: **chart supplier spend** or **compare PO to invoice**."
            ),
        }
        return replies.get(
            agent or "",
            "I answer questions from your uploaded documents — summaries, fields, totals, and comparisons. "
            "Ask something specific about a file or topic in your library.",
        )

    def _chitchat_reply(self, question: str, session_id: str, is_first: bool,
                        provider: str = None, model: str = None,
                        provider_config: dict | None = None,
                        phase3_agent: str = None):
        q = (question or "").strip().lower()
        if _is_capability_question(question):
            return {
                "answer": self._capability_reply(phase3_agent or "other_agent"),
                "provider": provider,
                "model": model,
            }
        # Instant templates for common greetings — skip LLM latency.
        if re.match(r"^(hi|hii+|hello|hey|hy|helo|hola|salam|assalam.?o.?alaikum|aoa|slm)[\s!.]*$", q):
            answer = (
                "Hello. How can I help you today? "
                "Ask about summaries, fields, or anything in your uploaded documents."
            )
            return {"answer": answer, "provider": provider, "model": model}
        if re.match(r"^(thanks?|thank you|thx|ty|shukriya|jazakallah)[\s!.]*$", q):
            return {
                "answer": "You're welcome. Let me know if you need anything else from your documents.",
                "provider": provider,
                "model": model,
            }
        if re.match(r"^(bye|goodbye|see you|take care|tc)[\s!.]*$", q):
            return {
                "answer": "Goodbye. Come back anytime you need help with your documents.",
                "provider": provider,
                "model": model,
            }

        prompt = (
            "You are Visibility Docs AI, a professional document assistant.\n"
            "The user sent a greeting or casual message — NOT a document question.\n"
            f"{_LANGUAGE_RULE}\n"
            f"{_TONE_RULE}\n"
            "Reply in 1–2 short professional sentences.\n"
            "Match a simple greeting briefly, then offer to help with their uploaded documents.\n"
            "Do NOT say you cannot find information in documents.\n"
            "Do NOT invent document facts."
        )
        return conversation_service.chat(
            question,
            "",
            session_id=session_id,
            is_followup=not is_first,
            system_prompt=prompt,
            provider=provider,
            model=model,
            provider_config=provider_config,
        )

    # Keyword → agent intent map for query-type detection (used when no doc is selected).
    # Agent KEYS are bound to the registry (agent_registry.agent_ids) at use time so a
    # new agent added upstream is never silently ignored; keyword lists stay chat-specific.
    _AGENT_INTENT_KEYWORDS = {
        "hr_agent": ["resume", "cv", "candidate", "candidates", "applicant", "applicants",
                     "hiring", "recruit", "recruitment", "experience", "skill", "skills",
                     "qualification", "interview", "employee"],
        "finance_agent": ["invoice", "inv", "payment", "due date", "vendor", "supplier",
                          "seller", "tax", "vat", "gst", "subtotal", "line item", "line items",
                          "amount due", "bill to", "ship to", "purchase order", "po", "total amount",
                          "رقم", "انوائس", "بل", "ٹوٹل", "وصولی"],
        "procurement_agent": ["rfq", "quotation", "quote", "suggestive", "required language",
                        "bid", "tender", "proposal", "procurement", "request for quotation",
                        "رقم", "کوٹیشن", "درخواست"],
        "legal_agent": ["contract", "agreement", "clause", "liability", "terms and conditions",
                        "legal", "party", "indemnity", "jurisdiction", "معاہدہ", "قانون"],
        "compliance_agent": ["audit", "audit report", "finding", "findings", "corrective action",
                             "compliance", "non-compliance", "non compliance", "sop", "procedure",
                             "certificate", "certification", "quality report", "qc", "maintenance",
                             "inspection", "safety", "regulatory", "standard operating",
                             "deviation", "pass fail", "آڈٹ", "سرٹیفکیٹ", "کوالٹی", "مرمت",
                             "حفاظت", "طریقہ کار", "تعمیل", "خلاف ورزی", "معائنہ"],
    }

    # Keyword → document_type map for query-type detection (org-wide chat).
    # Doc_type KEYS are bound to the classifier's canonical set
    # (agent_registry.doc_type_to_agent) so a stale filter can never be returned.
    KEYWORD_TO_DOC_TYPE = {
        "invoice": ["invoice", "inv ", "inv.", "bill", "انوائس", "بل", "رسید"],
        "expense_report": ["expense report", "expense", "reimbursement", "اخراجات", "اخراجات رپورٹ"],
        "bank_statement": ["bank statement", "bank stmt", "statement of account", "بینک سٹیٹمنٹ"],
        "payment_receipt": ["payment receipt", "receipt", "وصولی", "رسید ادائیگی"],
        "tax_document": ["tax document", "tax return", "wht", "withholding", "ٹیکس"],
        "budget": ["budget", "बजٹ"],
        "financial_statement": ["financial statement", "balance sheet", "پروفٹ", "مالیاتی بیان"],
        "purchase_order": ["purchase order", "po ", "p.o.", "خریداری", "خریداری آرڈر"],
        "quotation": ["quotation", "quote", "کوٹیشن"],
        "rfq": ["rfq", "request for quotation", "درخواست برائے کوٹیشن"],
        "delivery_note": ["delivery note", "delivery slip", "ڈیلیوری نوٹ"],
        "procurement_request": ["procurement request", "purchase request", "خریداری کی درخواست"],
        "contract": ["contract", "معاہدہ"],
        "agreement": ["agreement", "اتفاق نامہ"],
        "nda": ["nda", "non-disclosure", "non disclosure", "confidentiality agreement", "این ڈی اے"],
        "service_agreement": ["service agreement", "سروس معاہدہ"],
        "lease_agreement": ["lease agreement", "lease", "کرایہ نامہ"],
        "vendor_contract": ["vendor contract", "supplier contract"],
        "resume": ["resume", "cv", "c.v.", "bio data", "بائیو ڈیٹا", "ریزیومہ", "امیدوار"],
        "transcript": ["transcript", "نتیجہ", "رزلٹ", "transcripts"],
        "offer_letter": ["offer letter", "آفر لیٹر", "پیشکش"],
        "payroll": ["payroll", "salary slip", "payslip", "تنخواہ"],
        "leave_application": ["leave application", "leave request", "چھٹی"],
        "attendance": ["attendance", "حاضری"],
        "employee_record": ["employee record", "hr document", "ملازم", "اسناد ملازمین"],
        "certificate": ["certificate", "سرٹیفکیٹ", "سند"],
        "audit_report": ["audit", "audit report", "آڈٹ", "آڈٹ رپورٹ"],
        "quality_report": ["quality report", "کوالٹی", "معیاری رپورٹ"],
        "maintenance_report": ["maintenance report", "دیکھ بھال", "مرمت"],
        "sop": ["sop", "standard operating", "ایس او پی", "ایسوپی"],
        "engineering_drawing": ["engineering drawing", "نقشہ", "ڈرائنگ", "انجینئرنگ ڈرائنگ"],
        "inspection_report": ["inspection report", "معائنہ رپورٹ"],
        "safety_manual": ["safety manual", "حفاظتی دستی"],
        # HR additions so classifier doc types are detectable from chat
        "employment_contract": ["employment contract", "job contract", "ملازمت کا معاہدہ"],
        "experience_letter": ["experience letter", "service letter", "تجربے کا خط"],
        "hr_document": ["hr document", "hr file", "human resource document"],
        "performance_review": ["performance review", "performance appraisal", "appraisal"],
        "training_certificate": ["training certificate", "training cert", "تربیت سرٹیفکیٹ"],
        # Procurement additions
        "supplier_agreement": ["supplier agreement", "vendor agreement"],
        "vendor_list": ["vendor list", "supplier list", "vendor master"],
        # Compliance additions
        "compliance_form": ["compliance form", "کمپلائنس فارم"],
        "iso_document": ["iso document", "iso cert", "iso certificate"],
        "regulatory_document": ["regulatory document", "regulatory file"],
        "other": ["other", "general", "عام", "general document"],
    }

    def _detect_query_agent(self, query: str) -> str | None:
        """Detect the most likely document agent from query keywords.

        Returns the agent name when intent is clear, or None when no/ambiguous intent
        (so the caller can fall back to a generic Q&A agent).
        """
        q = (query or "").lower()
        if not q:
            return None
        known_agents = set(_registry_agent_ids())
        scores = {}
        for agent, kws in self._AGENT_INTENT_KEYWORDS.items():
            if agent not in known_agents:
                continue  # registry doesn't know this agent — skip stale intent keys
            hits = sum(1 for kw in kws if kw in q)
            if hits:
                scores[agent] = hits
        if not scores:
            return None
        # Only commit if a single intent clearly dominates (no tie)
        ranked = sorted(scores.items(), key=lambda x: -x[1])
        if len(ranked) > 1 and ranked[0][1] == ranked[1][1]:
            return None
        return ranked[0][0]

    def detect_doc_type_keyword(self, query: str) -> str | None:
        """Detect a document_type from query keywords (bilingual EN+UR).

        Used for org-wide chat: if the user's question mentions a type (e.g.
        'invoice', 'quotation', 'ریزیومہ'), retrieval is restricted to documents
        of that type. Returns the best-matching document_type, or None when no
        keyword matches (or multiple types tie) so the caller searches all docs.
        """
        q = (query or "").lower()
        if not q:
            return None
        known_types = set(_registry_doc_types().keys())
        scores = {}
        for doc_type, kws in self.KEYWORD_TO_DOC_TYPE.items():
            if doc_type not in known_types:
                continue  # classifier doesn't produce this type — skip stale filters
            hits = sum(1 for kw in kws if kw in q)
            if hits:
                scores[doc_type] = hits
        if not scores:
            return None
        ranked = sorted(scores.items(), key=lambda x: -x[1])
        if len(ranked) > 1 and ranked[0][1] == ranked[1][1]:
            return None
        return ranked[0][0]

    @staticmethod
    def _doc_type_matches(stored: str, target: str) -> bool:
        stored = (stored or "").lower().strip()
        target = (target or "").lower().strip()
        if not stored or not target:
            return False
        if stored == target:
            return True
        if target == "resume" and stored in ("resume", "cv", "curriculum_vitae", "curriculum"):
            return True
        return False

    def _fetch_scoped_doc_meta(self, document_ids: list[str], organization_id: str) -> dict[str, dict]:
        """Map python document id → {document_type, phase3_agent}."""
        if not document_ids:
            return {}
        unique_ids = list(dict.fromkeys(document_ids))
        out: dict[str, dict] = {}
        try:
            from ..database import _get_supabase, _use_supabase, _local_select_in

            if _use_supabase():
                client = _get_supabase()
                if client:
                    r = (
                        client.table("documents")
                        .select("id, document_type, phase3_agent")
                        .in_("id", unique_ids)
                        .eq("organization_id", organization_id)
                        .execute()
                    )
                    for row in r.data or []:
                        if not row.get("id"):
                            continue
                        out[row["id"]] = {
                            "document_type": (row.get("document_type") or "").lower(),
                            "phase3_agent": (row.get("phase3_agent") or "").lower(),
                        }
            else:
                rows = _local_select_in(
                    "documents",
                    columns="id, document_type, phase3_agent",
                    in_column="id",
                    in_values=unique_ids,
                )
                for row in rows or []:
                    if row.get("id"):
                        out[row["id"]] = {
                            "document_type": (row.get("document_type") or "").lower(),
                            "phase3_agent": (row.get("phase3_agent") or "").lower(),
                        }
        except Exception as e:
            get_chat_logger().warn(f"Scoped doc meta fetch failed: {e}")
        return out

    def _resolve_doc_agent(self, meta: dict) -> str:
        p3 = (meta.get("phase3_agent") or "").strip()
        if p3:
            return p3
        dtype = (meta.get("document_type") or "").strip()
        return DOCUMENT_TO_PHASE3_AGENT.get(dtype, "other_agent")

    def _narrow_resolved_ids(
        self,
        question: str,
        resolved_ids: list[str],
        organization_id: str,
        phase3_agent: str | None,
        document_type: str | None,
    ) -> tuple[list[str], str | None, str | None]:
        """Shrink scoped doc list by agent (UI) or inferred document type (question)."""
        if not resolved_ids or len(resolved_ids) <= 1:
            return resolved_ids, document_type, phase3_agent

        chat_log = get_chat_logger()
        meta_map = self._fetch_scoped_doc_meta(resolved_ids, organization_id)
        if not meta_map:
            return resolved_ids, document_type, phase3_agent

        if phase3_agent:
            agent = phase3_agent.lower().strip()
            filtered = [
                did
                for did in resolved_ids
                if self._resolve_doc_agent(meta_map.get(did, {})) == agent
            ]
            if filtered and len(filtered) < len(resolved_ids):
                chat_log.info(
                    f"Agent partition: {len(resolved_ids)} → {len(filtered)} doc(s) ({agent})"
                )
                return filtered, document_type, phase3_agent
            if filtered:
                return filtered, document_type, phase3_agent

        target_type = (document_type or "").lower().strip() or None
        if not target_type:
            target_type = self.detect_doc_type_keyword(question)

        q_lower = (question or "").lower()
        if not target_type:
            import re as _re

            for kw in _RESUME_KEYWORDS:
                if _re.search(kw, q_lower):
                    target_type = "resume"
                    break

        if target_type:
            filtered = [
                did
                for did in resolved_ids
                if self._doc_type_matches(meta_map.get(did, {}).get("document_type", ""), target_type)
            ]
            if filtered and len(filtered) < len(resolved_ids):
                chat_log.info(
                    f"Query-type partition: {len(resolved_ids)} → {len(filtered)} doc(s) (type={target_type})"
                )
                agent_hint = DOCUMENT_TO_PHASE3_AGENT.get(target_type)
                return filtered, target_type, phase3_agent or agent_hint

        return resolved_ids, document_type, phase3_agent

    def _detect_cross_doc_intent(self, query: str):
        """Detect 'list a field from EVERY document' intent (when no doc is selected).

        Returns (is_cross_doc, field_terms) where field_terms is the cleaned list of
        query words (aggregation/stopwords removed) used to scan each document.
        """
        import re
        q = (query or "").lower().strip()
        if not q:
            return False, []
        is_cross = any(p in q for p in _CROSS_DOC_PHRASES)
        # We no longer aggressively trigger cross_doc on single words like "all" or "list" 
        # unless accompanied by explicit document phrases.
        if not is_cross:
            return False, []
        terms = [t for t in re.sub(r'[^\w\s]', ' ', q).split()
                 if t and t not in _CROSS_DOC_DROP and t not in _CROSS_DOC_WORDS and len(t) >= 2]
        return True, terms

    def _get_or_create_session(
        self,
        session_id: str,
        organization_id: str,
        document_ids: list = None,
        user_id: str = None,
    ) -> tuple[str, list | None, bool]:
        """document_ids=None means all docs; a list means selected scope only."""
        is_first = True
        if session_id:
            existing = SupabaseDB.get_chat_session(session_id)
            if existing:
                # Do not continue another user's session
                owner = existing.get("user_id")
                session_org = existing.get("organization_id")
                if user_id and owner and owner != user_id:
                    existing = None
                elif session_org and session_org != organization_id:
                    existing = None
            if existing:
                stored_ids = existing.get("document_ids") or []
                messages = existing.get("messages") or []
                is_first = len(messages) == 0
                if messages:
                    conversation_service.load_history_from_db(session_id, messages)
                if document_ids is not None:
                    resolved = list(document_ids)
                    if set(resolved) != set(stored_ids):
                        SupabaseDB.update_chat_session_doc_ids(session_id, resolved)
                else:
                    # All-documents mode: do not restrict by previously stored selection
                    resolved = None
                return session_id, resolved, is_first
        doc_list = list(document_ids) if document_ids is not None else []
        new_id = SupabaseDB.create_chat_session(organization_id, "New Chat", doc_list, user_id=user_id)
        return new_id, (list(document_ids) if document_ids is not None else None), True

    @staticmethod
    def _dedupe_sources(sources: list, limit: int = 3) -> list:
        """One source chip per document (drop duplicate chunks)."""
        seen = set()
        out = []
        for s in sources or []:
            did = s.get("document_id")
            if not did or did in seen:
                continue
            seen.add(did)
            out.append(s)
            if len(out) >= limit:
                break
        return out

    def _build_scoped_document_context(
        self, document_ids: list, organization_id: str, max_chunks_per_doc: int = 40
    ) -> str:
        """Extraction → raw_text → chunk fallback for explicitly selected documents."""
        if not document_ids:
            return ""
        chat_log = get_chat_logger()
        summary = self._fetch_extraction_summary(document_ids, organization_id)
        raw = self._fetch_raw_text(document_ids, organization_id)
        parts = []
        if summary:
            parts.append(summary)
        if raw:
            parts.append(raw)
        if parts:
            return "\n\n".join(parts)
        chunks = rag_service._fetch_any_chunks(
            document_ids, organization_id, limit_per_doc=max_chunks_per_doc
        )
        if chunks:
            chat_log.info(
                f"Scoped chunk fallback: {len(chunks)} chunk(s) from {len(document_ids)} document(s)"
            )
            return "\n\n".join(
                f'<document filename="{c["document_title"]}">\n{c["chunk_text"]}\n</document>'
                for c in chunks
            )
        chat_log.warn(
            f"No scoped context for document_ids={document_ids[:3]}{'…' if len(document_ids) > 3 else ''} "
            f"org={organization_id} — check AI processing / pythonDocumentId sync"
        )
        return ""

    def _find_related_document_ids(self, question: str, organization_id: str, limit: int = 8) -> list[str]:
        """Match library docs by title/raw_text keywords when vector search is empty."""
        import re
        q = (question or "").lower()
        drop = {
            "give", "me", "my", "the", "a", "an", "of", "for", "to", "in", "on", "at", "all",
            "get", "show", "list", "tell", "what", "which", "from", "with", "who", "best",
            "that", "this", "rule", "role", "find", "please", "about",
        }
        # Keep topic words; also keep known entity-ish tokens even if short
        words = [w for w in re.sub(r"[^\w\s]", " ", q).split() if len(w) >= 3 and w not in drop]
        # Always try these high-signal phrases from the question
        phrases = []
        for p in (
            "vendor", "client", "clients", "invoice", "resume", "cv", "pakistan", "bata",
            "quotation", "purchase", "supplier", "customer", "science", "sceince",
        ):
            if p in q:
                phrases.append(p)
        needles = list(dict.fromkeys(phrases + words))[:12]
        if not needles:
            return []
        try:
            result = SupabaseDB.select(
                "documents",
                columns="id, title, document_type, raw_text",
                filters={"organization_id": organization_id},
                limit=200,
            )
            docs = getattr(result, "data", result if isinstance(result, list) else [])
            if not isinstance(docs, list):
                docs = []
        except Exception:
            return []
        scored: list[tuple[int, str]] = []
        for d in docs:
            if not isinstance(d, dict) or not d.get("id"):
                continue
            title = (d.get("title") or "").lower()
            dtype = (d.get("document_type") or "").lower()
            blob = f"{title} {dtype}"
            raw = (d.get("raw_text") or "")[:8000].lower()
            if raw:
                blob += " " + raw
            score = 0
            for n in needles:
                if n in title:
                    score += 8
                elif n in raw:
                    score += 4
                elif n in blob:
                    score += 2
            if score:
                scored.append((score, d["id"]))
        scored.sort(key=lambda x: -x[0])
        return [did for _, did in scored[:limit]]

    def _build_multi_prompt_for_search_results(self, doc_type_counts: dict, agents: set, allowed_agents: list = None) -> tuple[str, list[str]]:
        """Load and sanitize multiple .md prompt files for top matched document types.
        Strictly enforces user plan entitlements: Only loads skill files for agents allowed in allowed_agents.
        Compactly limits loaded prompts to top 3 matched types (max ~1,200 chars per prompt)
        to stay safely under Groq token limits while providing specialized domain guidelines."""
        import re
        loaded_prompts = []
        loaded_paths = []
        seen_paths = set()

        allowed_set = set(allowed_agents) if allowed_agents else None

        sorted_types = [dt for dt, _ in sorted(doc_type_counts.items(), key=lambda x: x[1], reverse=True) if dt]
        if len(sorted_types) > 1 and "other" in sorted_types:
            sorted_types.remove("other")

        top_types = sorted_types[:3]

        pairs = []
        for dt in top_types:
            p3a = DOCUMENT_TO_PHASE3_AGENT.get(dt, "other_agent")
            if allowed_set and p3a != "other_agent" and p3a not in allowed_set:
                continue
            pairs.append((dt, p3a))

        if not pairs and agents:
            for ag in list(agents)[:3]:
                if ag and ag != "other_agent":
                    if allowed_set and ag not in allowed_set:
                        continue
                    pairs.append(("", ag))

        if not pairs:
            pairs.append(("", "other_agent"))

        for dt, ag in pairs:
            raw_prompt, prompt_path = get_phase3_prompt_for_doc(dt, ag)
            if raw_prompt and prompt_path not in seen_paths:
                seen_paths.add(prompt_path)
                cleaned = _sanitize_extraction_prompt_for_chat(raw_prompt)

                if len(cleaned) > 900:
                    cleaned = cleaned[:850] + "\n..."

                doc_name_label = dt.upper() if dt else ag.replace("_", " ").upper()
                label = (
                    f"[Internal notes for {doc_name_label} — do NOT repeat or list these to the user; "
                    f"use only to interpret context]"
                )
                loaded_prompts.append(f"{label}\n{cleaned}")
                loaded_paths.append(prompt_path)

        merged_prompt = "\n\n".join(loaded_prompts)
        if loaded_paths:
            print("\n" + "★"*65)
            print(f"[DYNAMIC ROUTING PROMPT] Merged {len(loaded_paths)} Skill.md File(s):")
            for p in loaded_paths:
                print(f"  -> app/prompts/{p}")
            print("★"*65 + "\n")
        return merged_prompt, loaded_paths

    def _auto_title(self, session_id: str, first_question: str):
        title = first_question[:80].strip()
        if len(title) == 80:
            title = title[:77] + "..."
        SupabaseDB.update_chat_session_title(session_id, title)

    def _save_exchange(self, session_id: str, question: str, answer: str, sources: list, is_first: bool):
        SupabaseDB.save_chat_message(session_id, "user", question)
        SupabaseDB.save_chat_message(session_id, "assistant", answer, sources)
        if is_first:
            self._auto_title(session_id, question)

    def _fetch_raw_text(self, document_ids: list, organization_id: str,
                        max_chars: int = 30000, titles: list = None) -> str:
        """Fetch raw_text (full document text) for selected docs. Critical for Excel/table docs
        where chunks may be missing or extraction truncates data."""
        if not document_ids:
            return ""
        try:
            unique_ids = list(set(document_ids))
            from ..database import _get_supabase, _use_supabase, _local_select_in
            client = _get_supabase()
            if _use_supabase and client:
                r = client.table("documents").select("id, title, document_type, raw_text").in_("id", unique_ids).eq(
                    "organization_id", organization_id
                ).execute()
                data = getattr(r, "data", []) or []
            else:
                data = _local_select_in(
                    "documents",
                    columns="id, title, document_type, raw_text",
                    filters={"organization_id": organization_id},
                    in_column="id",
                    in_values=unique_ids,
                )
            parts = []
            total = 0
            for row in (data or []):
                raw = row.get("raw_text") or ""
                if not raw:
                    continue
                display = row.get("title") or row.get("id", "")
                remaining = max_chars - total
                if remaining <= 0:
                    break
                truncated = raw[:remaining]
                parts.append(f"[Document: {display} (Full Source Text)]:\n{truncated}")
                total += len(truncated)
            return "\n\n".join(parts) if parts else ""
        except Exception:
            return ""

    def _fetch_extraction_summary(self, document_ids: list, organization_id: str) -> str:
        if not document_ids:
            return ""
        try:
            import json
            from ..database import _get_supabase, _use_supabase, _local_select_in
            unique_ids = list(set(document_ids))
            client = _get_supabase()
            if _use_supabase and client:
                r = client.table("document_extractions") \
                    .select("document_id, extraction_type, extracted_data, confidence") \
                    .in_("document_id", unique_ids) \
                    .eq("organization_id", organization_id) \
                    .execute()
                rows = getattr(r, "data", [])
                if not rows:
                    r = client.table("document_extractions") \
                        .select("document_id, extraction_type, extracted_data, confidence") \
                        .in_("document_id", unique_ids) \
                        .execute()
                    rows = getattr(r, "data", [])
            else:
                rows = _local_select_in("document_extractions",
                    columns="document_id, extraction_type, extracted_data, confidence",
                    filters={"organization_id": organization_id},
                    in_column="document_id", in_values=unique_ids)
                if not rows:
                    rows = _local_select_in("document_extractions",
                        columns="document_id, extraction_type, extracted_data, confidence",
                        in_column="document_id", in_values=unique_ids)
            if not rows:
                return ""

            doc_info = {}
            try:
                title_result = SupabaseDB.select("documents",
                    columns="id, title",
                    filters={"organization_id": organization_id},
                )
                title_data = getattr(title_result, "data", title_result if isinstance(title_result, list) else [])
                for row in title_data:
                    doc_info[row["id"]] = row.get("title", "")
            except Exception:
                pass

            lines = ["[Structured Document Data for Aggregation]"]
            totals = {}
            parsed_count = 0

            # Group extractions by document_id, merging image data into main extraction
            doc_extractions = {}
            for row in rows:
                did = row.get("document_id", "")
                ext_type = row.get("extraction_type", "")
                raw = row.get("extracted_data", "{}")
                if isinstance(raw, str):
                    try:
                        parsed = json.loads(raw)
                    except Exception:
                        continue
                else:
                    parsed = raw or {}
                if not isinstance(parsed, dict):
                    continue

                if did not in doc_extractions:
                    doc_extractions[did] = {"type": ext_type, "data": {}}
                if ext_type == "image_extraction":
                    doc_extractions[did]["has_images"] = True
                    doc_extractions[did]["images"] = parsed.get("images", [])
                else:
                    doc_extractions[did]["type"] = ext_type
                    doc_extractions[did]["data"].update(parsed)

            for did, ext_info in doc_extractions.items():
                parsed = ext_info["data"]
                title = doc_info.get(did, did)
                lines.append(f"\n  Document: {title}  (id: {did})")
                lines.append(f"  Type: {ext_info['type']}")

                for key, val in parsed.items():
                    if key.startswith("_"):
                        continue
                    if isinstance(val, str) and val:
                        lines.append(f"    {key}: {val}")
                    elif isinstance(val, (int, float)):
                        lines.append(f"    {key}: {val}")
                        totals[key] = totals.get(key, 0) + val
                    elif isinstance(val, list) and val:
                        lines.append(f"    {key}:")
                        for item in val[:500]:
                            if isinstance(item, dict):
                                parts = [f"{k}={v}" for k, v in item.items() if v not in (None, "", [], {})]
                                if parts:
                                    lines.append("      - " + ", ".join(parts))
                            else:
                                lines.append(f"      - {item}")

                if ext_info.get("has_images"):
                    img_count = len(ext_info.get("images", []))
                    lines.append(f"    images: {img_count} image(s) with vision descriptions in document context")
                parsed_count += 1

            if parsed_count > 1 and totals:
                lines.append("\n  --- Aggregated Totals ---")
                for key, val in sorted(totals.items()):
                    lines.append(f"    Sum of {key}: {val}")

            result = "\n".join(lines)
            return result
        except Exception as e:
            chat_log = get_chat_logger()
            chat_log.warn(f"Extraction summary error: {e}")
            return ""

    def append_exchange(
        self,
        organization_id: str,
        question: str,
        answer: str,
        session_id: str = None,
        user_id: str = None,
        sources: list = None,
    ) -> dict:
        sid, _, is_first = self._get_or_create_session(session_id, organization_id, None, user_id=user_id)
        self._save_exchange(sid, question, answer, sources or [], is_first)
        return {
            "answer": answer,
            "sources": sources or [],
            "document_id": "",
            "history": conversation_service.get_history(sid),
            "session_id": sid,
        }

    def chat_with_document(self, question: str, document_ids: list, organization_id: str,
                           document_type: str = None, phase3_agent: str = None,
                           allowed_agents: list = None,
                           provider_config: dict | None = None,
                           status: str = None, date_from: str = None, date_to: str = None,
                           chat_history: list[dict] = None, session_id: str = None,
                           user_id: str = None, selected_text: str = None,
                           provider: str = None, model: str = None) -> dict:
        chat_log = get_chat_logger()
        chat_log.chat_start(question, session_id=session_id or "", doc_count=len(document_ids or []))
        t_start = time.time()
        allowed_list = parse_allowed_agents(allowed_agents)
        if phase3_agent and allowed_list:
            phase3_agent = clamp_agent(phase3_agent, allowed_list)

        sid, resolved_ids, is_first = self._get_or_create_session(
            session_id, organization_id, document_ids, user_id=user_id
        )

        if resolved_ids:
            resolved_ids, document_type, phase3_agent = self._narrow_resolved_ids(
                question,
                list(resolved_ids),
                organization_id,
                phase3_agent,
                document_type,
            )

        preloaded_scoped_context = ""
        if resolved_ids:
            preloaded_scoped_context = self._build_scoped_document_context(
                resolved_ids, organization_id
            )

        # ── Focused Q&A on a selected excerpt (ChatGPT-style "ask about this") ──
        if selected_text and selected_text.strip():
            return self._answer_on_excerpt(
                question=question, selected_text=selected_text.strip(),
                organization_id=organization_id, sid=sid, is_first=is_first,
                provider=provider, model=model, provider_config=provider_config,
            )

        # Greetings / small-talk → reply without searching documents
        if self._is_chitchat(question):
            chat_log.info("Chitchat detected — skipping document search")
            res_dict = self._chitchat_reply(
                question, sid, is_first, provider=provider, model=model,
                provider_config=provider_config, phase3_agent=phase3_agent,
            )
            answer = res_dict.get("answer", "") if isinstance(res_dict, dict) else str(res_dict)
            res_provider = res_dict.get("provider", provider) if isinstance(res_dict, dict) else provider
            res_model = res_dict.get("model", model) if isinstance(res_dict, dict) else model
            self._save_exchange(sid, question, answer, [], is_first)
            total = time.time() - t_start
            chat_log.chat_end(total, 0)
            return {
                "answer": answer,
                "sources": [],
                "document_id": "",
                "history": conversation_service.get_history(sid),
                "session_id": sid,
                "provider": res_provider,
                "model": res_model,
            }

        # Capability / help asks — short reply, never dump extraction skill.md as a task list
        if _is_capability_question(question):
            chat_log.info("Capability question detected — returning short agent reply")
            agent_for_reply = phase3_agent or "other_agent"
            answer = self._capability_reply(agent_for_reply)
            self._save_exchange(sid, question, answer, [], is_first)
            total = time.time() - t_start
            chat_log.chat_end(total, 0)
            return {
                "answer": answer,
                "sources": [],
                "document_id": "",
                "history": conversation_service.get_history(sid),
                "session_id": sid,
                "provider": provider,
                "model": model,
            }

        # Selected scope with empty list → no docs (do not search everything)
        if document_ids is not None and not resolved_ids:
            answer = "No documents selected. Select at least one document and try again."
            self._save_exchange(sid, question, answer, [], is_first)
            return {
                "answer": answer,
                "sources": [],
                "document_id": "",
                "history": conversation_service.get_history(sid),
                "session_id": sid,
            }

        # ── SEARCH-FIRST ROUTING: Search WITHOUT keyword bias, then route by metadata ──
        # Step 1: Use the raw question for search (no keyword-based agent anchoring)
        search_query = question

        # If follow-up, contextualize the search query with the previous question
        if not is_first:
            try:
                hist = conversation_service.get_history(sid)
                if hist:
                    for m in reversed(hist):
                        if m.get("role") == "user":
                            last_q = m.get("content", "")
                            if last_q and last_q != question:
                                search_query = f"{last_q} - {question}"
                                chat_log.info(f"Contextualized search query: '{search_query}'")
                            break
            except Exception as e:
                chat_log.warn(f"Failed to contextualize search query: {e}")

        # Cross-document "list a field from every file" intent (only when no doc chosen)
        cross_doc = False
        agg_field_terms = []
        if not resolved_ids:
            cross_doc, agg_field_terms = self._detect_cross_doc_intent(question)

        q_lower = question.lower()
        is_finance_query = (
            document_type in ("invoice", "purchase_order", "quotation", "rfq")
            or phase3_agent in ("finance_agent", "procurement_agent")
            or any(term in q_lower for term in [
                "invoice", "subtotal", "amount due", "grand total", "due date",
                "payment terms", "vendor", "customer", "bill to", "ship to",
                "tax", "vat", "gst", "line item", "line items", "invoice number",
                "purchase order", "po number", "quotation", "rfq", "supplier",
            ])
        )

        # Scoped docs: preload only for a few files; larger/mixed scopes use vector search (faster, type-filtered).
        _PRELOAD_MAX_DOCS = 4
        if (
            resolved_ids
            and preloaded_scoped_context
            and not cross_doc
            and len(resolved_ids) <= _PRELOAD_MAX_DOCS
        ):
            chat_log.info(
                f"Using preloaded scoped context ({len(preloaded_scoped_context)} chars) for {len(resolved_ids)} doc(s)"
            )
            scoped_prompt = (
                "You are Visibility Docs AI. Answer using ONLY the document context below.\n"
                "If the answer is not in the context, say clearly that it is not in the selected documents.\n"
                "Do not invent facts.\n"
            )
            chat_log.llm_call(model or "default", len(preloaded_scoped_context), len(question), len(resolved_ids), provider=provider)
            llm_t0 = time.time()
            res_dict = conversation_service.chat(
                question,
                preloaded_scoped_context,
                session_id=sid,
                system_prompt=scoped_prompt,
                is_followup=not is_first,
                provider=provider,
                model=model,
                provider_config=provider_config,
            )
            answer = res_dict.get("answer", "") if isinstance(res_dict, dict) else str(res_dict)
            res_provider = res_dict.get("provider", provider) if isinstance(res_dict, dict) else provider
            res_model = res_dict.get("model", model) if isinstance(res_dict, dict) else model
            chat_log.llm_response(time.time() - llm_t0, len(answer))
            self._save_exchange(sid, question, answer, [], is_first)
            total = time.time() - t_start
            chat_log.chat_end(total, 0)
            return {
                "answer": answer,
                "sources": [],
                "document_id": resolved_ids[0] if resolved_ids else "",
                "history": conversation_service.get_history(sid),
                "session_id": sid,
                "provider": res_provider,
                "model": res_model,
            }

        # All-library mode: if we can match related files by title/content, answer from them
        # instead of spending ~40s on empty Pinecone/vector search.
        if not resolved_ids and not cross_doc:
            related_early = self._find_related_document_ids(question, organization_id)
            if related_early:
                related_early = related_early[:6]
                early_ctx = self._build_scoped_document_context(related_early, organization_id)
                if early_ctx and len(early_ctx) > 200:
                    chat_log.info(
                        f"Related-document fast path: {len(related_early)} file(s), {len(early_ctx)} chars (skip vector search)"
                    )
                    prompt = (
                        "You are Visibility Docs AI.\n\n"
                        "Use ONLY the provided document context to answer the user's question.\n"
                        "If the user asks for vendor/client lists, invoices, or CVs, extract the matching rows/fields from the context.\n"
                        "If the answer is missing, say clearly what is not in the documents.\n"
                        "Do not invent numbers, dates, or names.\n"
                    )
                    chat_log.llm_call(model or "default", len(early_ctx), len(question), len(related_early), provider=provider)
                    llm_t0 = time.time()
                    res_dict = conversation_service.chat(
                        question,
                        early_ctx,
                        session_id=sid,
                        system_prompt=prompt,
                        is_followup=not is_first,
                        provider=provider,
                        model=model,
                        provider_config=provider_config,
                    )
                    answer = res_dict.get("answer", "") if isinstance(res_dict, dict) else str(res_dict)
                    res_provider = res_dict.get("provider", provider) if isinstance(res_dict, dict) else provider
                    res_model = res_dict.get("model", model) if isinstance(res_dict, dict) else model
                    chat_log.llm_response(time.time() - llm_t0, len(answer))
                    sources = [{"document_id": did, "document_title": "", "score": 1.0} for did in related_early]
                    self._save_exchange(sid, question, answer, sources, is_first)
                    total = time.time() - t_start
                    chat_log.chat_end(total, len(sources))
                    return {
                        "answer": answer,
                        "sources": sources,
                        "document_id": related_early[0],
                        "history": conversation_service.get_history(sid),
                        "session_id": sid,
                        "provider": res_provider,
                        "model": res_model,
                    }

        search_limit = 120 if cross_doc else 60
        if resolved_ids and len(resolved_ids) > 8 and not cross_doc:
            search_limit = 40

        hybrid_kwargs = dict(
            query=search_query,
            organization_id=organization_id,
            document_type=document_type,
            phase3_agent=phase3_agent,
            status=status,
            date_from=date_from,
            date_to=date_to,
            document_ids=resolved_ids,  # None = all; list = selected only
            limit=search_limit,
            aggregate=cross_doc,
        )
        if cross_doc:
            chat_log.info("Cross-doc intent detected — using aggregate_search")
            search_results = rag_service.aggregate_search(
                query=search_query,
                organization_id=organization_id,
                document_ids=resolved_ids if resolved_ids else None,
                max_docs=150,
            )
            if not search_results:
                search_results = rag_service.hybrid_search(**hybrid_kwargs)
        else:
            search_results = rag_service.hybrid_search(**hybrid_kwargs)

        # Step 2: Determine agents from ACTUAL search result metadata (not keywords)
        _search_doc_types = {}
        for r in search_results:
            dt = r.get("document_type") or ""
            if dt:
                _search_doc_types[dt] = _search_doc_types.get(dt, 0) + 1
        if _search_doc_types:
            chat_log.info(f"[SEARCH-FIRST ROUTING] Document types found in results: {_search_doc_types}")
        else:
            chat_log.info("[SEARCH-FIRST ROUTING] No document types in results — will use fallback")

        q_lower = question.lower()
        is_resume_query = any(
            re.search(kw, q_lower) for kw in _RESUME_KEYWORDS
        )

        if not search_results and not is_resume_query and document_type:
            chat_log.warn(f"No results with document_type={document_type} — light retry without type filter")
            retry_kwargs = {k: v for k, v in hybrid_kwargs.items() if k != "document_type"}
            search_results = rag_service.hybrid_search(**retry_kwargs, light=True)

        if not search_results:
            resumes = []
            if is_resume_query:
                try:
                    import json
                    resumes = document_service.list_documents(organization_id, limit=200)
                    if resolved_ids:
                        resolved_set = set(resolved_ids)
                        resumes = [r for r in resumes if r["id"] in resolved_set]
                    document_service._batch_attach_extractions(resumes, organization_id)
                    # Keep resume-type docs even without CV score (user may ask for CV text, not ranking)
                    resume_like = [
                        r for r in resumes
                        if (r.get("document_type") or "").lower() == "resume"
                        or r.get("cv_score") is not None
                        or "resume" in (r.get("title") or "").lower()
                        or "cv" in (r.get("title") or "").lower()
                    ]
                    if resume_like:
                        resumes = resume_like
                    # Match role/topic words (e.g. data science / sceince typo)
                    topic_words = [
                        w for w in re.sub(r"[^\w\s]", " ", q_lower).split()
                        if len(w) >= 3 and w not in ("give", "show", "list", "resume", "curriculum")
                    ]
                    if topic_words:
                        def _resume_hits(r: dict) -> bool:
                            title = (r.get("title") or "").lower()
                            blob = title
                            ext = r.get("extracted_data") or r.get("extraction") or {}
                            if isinstance(ext, dict):
                                blob += " " + json.dumps(ext).lower()
                            return any(w in blob for w in topic_words)

                        narrowed = [r for r in resumes if _resume_hits(r)]
                        if narrowed:
                            resumes = narrowed
                    scored = [r for r in resumes if r.get("cv_score") is not None]
                    if scored:
                        resumes = scored
                    resumes.sort(key=lambda x: x.get("cv_score", 0) or 0, reverse=True)
                except Exception:
                    resumes = []

            resume_context = ""
            resume_sources = []
            if resumes:
                lines = ["[Resume Rankings (sorted by CV evaluation score)]"]
                for i, r in enumerate(resumes[:20], 1):
                    score_str = f"{r['cv_score']}/100" if r["cv_score"] is not None else "N/A"
                    lines.append(f"{i}. {r['title']} — {score_str}")
                    resume_sources.append({
                        "document_id": r["id"],
                        "document_title": r["title"],
                        "cv_score": r.get("cv_score"),
                        "score": r.get("cv_score", 0) / 100.0,
                    })
                resume_context = "\n".join(lines)

            if is_resume_query and resumes and not resume_context.strip():
                resume_ids = [r["id"] for r in resumes[:8]]
                body = self._build_scoped_document_context(resume_ids, organization_id, max_chunks_per_doc=50)
                if body:
                    resume_context = (
                        "[Resume documents in your library]\n"
                        + "\n".join(f"- {r.get('title', r['id'])}" for r in resumes[:8])
                        + "\n\n"
                        + body
                    )

            # If search returned nothing but we are clearly in finance/invoice mode,
            # answer directly from structured extraction data when available.
            finance_context = ""
            related_ids = list(resolved_ids) if resolved_ids else []
            if not related_ids:
                related_ids = self._find_related_document_ids(question, organization_id)
                if related_ids:
                    chat_log.info(
                        f"Related-document fallback matched {len(related_ids)} library file(s) by title/content"
                    )
                    # Prefer the strongest matches so resumes don't drown vendor/client tables
                    related_ids = related_ids[:2]
            if related_ids:
                finance_context = self._build_scoped_document_context(related_ids, organization_id)
            if finance_context:
                chat_log.search_strategy(
                    "Related document fallback",
                    "no vector matches; answering from matched library documents",
                )
                finance_prompt = (
                    "You are Visibility Docs AI.\n\n"
                    "Use ONLY the provided document context to answer the user's question.\n"
                    "If the user asks for vendor/client lists, invoices, or CVs, extract the matching rows/fields from the context.\n"
                    "If the answer is missing, say clearly what is not in the documents.\n"
                    "Do not invent numbers, dates, or names.\n"
                )
                chat_log.llm_call("llama-3.3-70b-versatile", len(finance_context), len(question), 1, provider=provider)
                llm_t0 = time.time()
                res_dict = conversation_service.chat(
                    question, finance_context, session_id=sid, system_prompt=finance_prompt,
                    provider=provider, model=model, provider_config=provider_config,
                )
                answer = res_dict.get("answer", "") if isinstance(res_dict, dict) else str(res_dict)
                res_provider = res_dict.get("provider", provider) if isinstance(res_dict, dict) else provider
                res_model = res_dict.get("model", model) if isinstance(res_dict, dict) else model
                chat_log.llm_response(time.time() - llm_t0, len(answer))
                self._save_exchange(sid, question, answer, [], is_first)
                total = time.time() - t_start
                chat_log.chat_end(total, 0)
                return {
                    "answer": answer,
                    "sources": [
                        {"document_id": did, "document_title": "", "score": 1.0}
                        for did in related_ids[:5]
                    ],
                    "document_id": related_ids[0] if related_ids else "",
                    "history": conversation_service.get_history(sid),
                    "session_id": sid,
                    "provider": res_provider,
                    "model": res_model,
                }

            chat_log.search_strategy("Context Building", "no results found")
            chat_log.warn("No relevant documents found in search")

            # Last resort: answer from the strongest related library files, or list what exists
            if not resume_context:
                library_ids = self._find_related_document_ids(question, organization_id, limit=5)
                if not library_ids:
                    try:
                        catalog = document_service.list_documents(organization_id, limit=30)
                        library_ids = [
                            d["id"] for d in catalog
                            if isinstance(d, dict) and d.get("id")
                        ][:3]
                    except Exception:
                        library_ids = []
                if library_ids:
                    resume_context = self._build_scoped_document_context(
                        library_ids, organization_id, max_chunks_per_doc=30
                    )
                    if resume_context:
                        chat_log.info(
                            f"Library last-resort context: {len(library_ids)} doc(s), {len(resume_context)} chars"
                        )

            if not (resume_context or "").strip():
                try:
                    catalog = document_service.list_documents(organization_id, limit=40)
                    titles = [
                        d.get("title") or d.get("id")
                        for d in catalog
                        if isinstance(d, dict)
                    ]
                except Exception:
                    titles = []
                if titles:
                    answer = (
                        "I could not load searchable text for your question yet. "
                        "These documents are in your library — open Documents and click Reprocess "
                        "(or re-upload) so chat can read them, then ask again:\n\n- "
                        + "\n- ".join(titles[:20])
                    )
                else:
                    answer = (
                        "No processed document text is available for chat yet. "
                        "Upload a file on Documents and wait until processing finishes, then ask again."
                    )
                self._save_exchange(sid, question, answer, [], is_first)
                total = time.time() - t_start
                chat_log.chat_end(total, 0)
                return {
                    "answer": answer,
                    "sources": [],
                    "document_id": resolved_ids[0] if resolved_ids else "",
                    "history": conversation_service.get_history(sid),
                    "session_id": sid,
                    "provider": provider,
                    "model": model,
                }

            chat_log.llm_call(model or "default", len(resume_context), len(question), 1, provider=provider)
            system_prompt = (
                "You are Visibility Docs AI. Use the document context below to answer the user. "
                "Extract the closest matching facts (lists, tables, CV fields). "
                "If something is missing, say what is missing and what documents you used."
            )
            if is_resume_query:
                system_prompt = (
                    "You are a Resume Screening assistant. Use the resume document context below. "
                    "Summarize or extract what the user asked for (e.g. CV details, skills, experience). "
                    "If the topic is not in the documents, say which resumes you have and what is missing."
                )
            llm_t0 = time.time()
            res_dict = conversation_service.chat(
                question,
                resume_context,
                session_id=sid,
                system_prompt=system_prompt,
                is_followup=not is_first,
                provider=provider,
                model=model,
                provider_config=provider_config,
            )
            answer = res_dict.get("answer", "") if isinstance(res_dict, dict) else str(res_dict)
            res_provider = res_dict.get("provider", provider) if isinstance(res_dict, dict) else provider
            res_model = res_dict.get("model", model) if isinstance(res_dict, dict) else model
            chat_log.llm_response(time.time() - llm_t0, len(answer))
            unique_resume_sources = self._dedupe_sources(resume_sources, limit=3)
            self._save_exchange(sid, question, answer, unique_resume_sources, is_first)
            total = time.time() - t_start
            chat_log.chat_end(total, 0)
            return {
                "answer": answer,
                "sources": unique_resume_sources,
                "document_id": resolved_ids[0] if resolved_ids else "",
                "history": conversation_service.get_history(sid),
                "session_id": sid,
                "provider": res_provider,
                "model": res_model,
            }

        context_parts = []
        sources = []
        for r in search_results:
            context_parts.append(f'<document filename="{r["document_title"]}">\n{r["chunk_text"]}\n</document>')
            sources.append({
                "document_id": r["document_id"],
                "document_title": r["document_title"],
                "document_type": r.get("document_type", ""),
                "cv_score": r.get("cv_score"),
                "phase3_agent": r.get("phase3_agent", ""),
                "page_number": r["page_number"],
                "score": r["score"],
            })
        sources = self._dedupe_sources(sources, limit=25)

        context = "\n\n".join(context_parts)
        
        print("\n" + "="*70)
        print("[CHAT RAG] === FINALIZED CHUNKS FOR LLM CONTEXT ===")
        for idx, cp in enumerate(context_parts, 1):
            print(f"\n--- [Finalized Chunk {idx}/{len(context_parts)}] ---")
            print(cp)
            print("-" * 50)
        print("="*70 + "\n")

        # Limit context size to prevent exceeding LLM context limits
        if len(context) > 32000:
            chat_log.warn(f"Truncating search context from {len(context)} to 32000 characters to respect token limits.")
            context = context[:32000] + "\n...[Content Truncated due to API token limits]..."
            
        context_len = len(context)

        # ── Attach file_url to sources for frontend file name display ──
        try:
            unique_ids = list(set(s["document_id"] for s in sources))
            if unique_ids:
                file_result = SupabaseDB.select("documents",
                    columns="id, original_file_url",
                    filters={"organization_id": organization_id},
                )
                file_data = getattr(file_result, "data", file_result if isinstance(file_result, list) else [])
                if isinstance(file_data, list):
                    id_to_url = {row["id"]: row.get("original_file_url", "") for row in file_data if row.get("id") in unique_ids}
                    for s in sources:
                        s["file_url"] = id_to_url.get(s["document_id"], "")
        except Exception:
            pass

        # ── Resume ranking: if query mentions resumes, inject sorted scores ──
        resumes = []
        if is_resume_query:
            try:
                resumes = document_service.list_documents(organization_id)
                if resolved_ids:
                    resolved_set = set(resolved_ids)
                    resumes = [r for r in resumes if r["id"] in resolved_set]
                document_service._batch_attach_extractions(resumes, organization_id)
                resumes = [r for r in resumes if r.get("cv_score") is not None]
                resumes.sort(key=lambda x: x.get("cv_score", 0) or 0, reverse=True)
            except Exception:
                resumes = []
            if resumes:
                lines = ["[Resume Rankings (sorted by CV evaluation score)]"]
                for i, r in enumerate(resumes[:20], 1):
                    score_str = f"{r['cv_score']}/100" if r["cv_score"] is not None else "N/A"
                    lines.append(f"{i}. {r['title']} — {score_str}")
                resume_block = "\n".join(lines)
                context = resume_block + "\n\n" + context if context else resume_block
                chat_log.info(f"Injected {len(resumes)} resume scores into context")

        # ── Structured extraction summary for aggregate/multi-doc queries ──
        is_aggregate_query = any(
            __import__("re").search(kw, q_lower) for kw in _AGGREGATE_KEYWORDS
        )
        # Target document IDs: selected docs if specified, otherwise top unique docs from search results
        target_doc_ids = resolved_ids if resolved_ids else list(dict.fromkeys(r["document_id"] for r in search_results))[:10]
        if target_doc_ids:
            extraction_summary = self._fetch_extraction_summary(target_doc_ids, organization_id)
            if extraction_summary:
                context = extraction_summary + "\n\n" + context if context else extraction_summary
                chat_log.info(f"Injected structured extraction summary for {len(target_doc_ids)} documents")
            # Also inject raw source text for complete accuracy across All Documents
            raw_text_block = self._fetch_raw_text(target_doc_ids, organization_id)
            if raw_text_block:
                context = context + "\n\n" + raw_text_block if context else raw_text_block
                chat_log.info(f"Injected raw text: {len(raw_text_block)} chars for {len(target_doc_ids)} documents")

        chat_log.search_strategy("Context Building", f"{len(search_results)} chunks → {context_len} chars")
        doc_types_seen = {}
        agent_prompts_seen = {}
        for r in search_results:
            dt = r.get("document_type", "unknown")
            doc_types_seen[dt] = doc_types_seen.get(dt, 0) + 1
            p3a = r.get("phase3_agent", "")
            if p3a:
                _, prompt_file = get_phase3_prompt_for_doc(dt, p3a)
                agent_prompts_seen[prompt_file] = agent_prompts_seen.get(prompt_file, 0) + 1
        if doc_types_seen:
            chat_log.info(f"Document types: {', '.join(f'{k}={v}' for k, v in doc_types_seen.items())}")
        if agent_prompts_seen:
            chat_log.info(f"Agent prompts used: {', '.join(f'{k}' for k, v in agent_prompts_seen.items())}")

        unique_docs = list(set(r["document_id"] for r in search_results))
        chat_log.info(f"Unique documents: {len(unique_docs)}")
        for i, s in enumerate(sources[:5]):
            p3a = s.get("phase3_agent", "")
            agent_tag = f" [{p3a}]" if p3a else ""
            chat_log.source_item(i, s["document_title"], (s.get("document_type") or "") + agent_tag, s["score"])

        # ── SEARCH-FIRST: Determine dominant agent from ACTUAL document metadata ──
        doc_agent_counts = {}
        doc_type_counts = {}
        if resolved_ids:
            try:
                doc_result = SupabaseDB.select("documents",
                    columns="id, document_type, phase3_agent",
                    filters={"organization_id": organization_id},
                )
                doc_data = getattr(doc_result, "data", doc_result if isinstance(doc_result, list) else [])
                resolved_set = set(resolved_ids)
                for d in doc_data:
                    if d.get("id") in resolved_set:
                        dt = d.get("document_type", "")
                        if dt:
                            doc_type_counts[dt] = doc_type_counts.get(dt, 0) + 1
                        p3a = d.get("phase3_agent") or DOCUMENT_TO_PHASE3_AGENT.get(dt, "other_agent")
                        if p3a:
                            doc_agent_counts[p3a] = doc_agent_counts.get(p3a, 0) + 1
            except Exception:
                pass

        # Primary: Use search result metadata (most reliable — based on actual matched docs)
        search_doc_type_counts = {}
        agent_counts = {}
        for r in search_results:
            dt = r.get("document_type") or ""
            if dt:
                search_doc_type_counts[dt] = search_doc_type_counts.get(dt, 0) + 1
            p3a = r.get("phase3_agent") or DOCUMENT_TO_PHASE3_AGENT.get(dt, "other_agent")
            agent_counts[p3a] = agent_counts.get(p3a, 0) + 1

        # Merge: selected doc metadata + search result metadata (search results take priority)
        merged_type_counts = dict(doc_type_counts)
        for dt, cnt in search_doc_type_counts.items():
            merged_type_counts[dt] = merged_type_counts.get(dt, 0) + cnt
        merged_agent_counts = dict(doc_agent_counts)
        for ag, cnt in agent_counts.items():
            merged_agent_counts[ag] = merged_agent_counts.get(ag, 0) + cnt

        dominant_agent = max(merged_agent_counts, key=merged_agent_counts.get) if merged_agent_counts else "other_agent"
        dominant_doc_type = max(merged_type_counts, key=merged_type_counts.get) if merged_type_counts else (document_type or "")

        no_scope = not resolved_ids and not document_type and not phase3_agent
        is_folder_selection = bool(phase3_agent and not resolved_ids and not document_type)
        target_doc_type = "" if is_folder_selection else dominant_doc_type

        if phase3_agent and (is_folder_selection or not merged_agent_counts):
            dominant_agent = phase3_agent
        # NOTE: We do NOT fall back to keyword detection anymore.
        # The agent is determined purely from search result document metadata.

        if allowed_list:
            dominant_agent = clamp_agent(dominant_agent, allowed_list) or dominant_agent

        chat_log.info(f"[SEARCH-FIRST ROUTING] Dominant agent: {dominant_agent} | Dominant doc_type: {dominant_doc_type}")
        chat_log.info(f"[SEARCH-FIRST ROUTING] All types: {merged_type_counts} | All agents: {merged_agent_counts}")

        # Load agent / per-type .md prompts dynamically based on search result metadata
        qa_prompt = ""
        try:
            # Build prompts from ACTUAL document types found in search results, strictly filtered by user plan entitlements
            matched_agents = set(merged_agent_counts.keys())
            if allowed_list:
                matched_agents = {ag for ag in matched_agents if ag in allowed_list}
            if phase3_agent:
                if not allowed_list or phase3_agent in allowed_list:
                    matched_agents.add(phase3_agent)
            merged_rules, loaded_paths = self._build_multi_prompt_for_search_results(
                merged_type_counts, matched_agents, allowed_agents=allowed_list
            )
            if merged_rules:
                chat_log.info(
                    f"[SEARCH-FIRST GENERIC] Loaded skill.md files from search result metadata "
                    f"({len(loaded_paths)} files): {', '.join(loaded_paths)}"
                )
                qa_prompt = merged_rules
            elif not qa_prompt:
                raw_prompt, prompt_path = get_phase3_prompt_for_doc(
                    target_doc_type or dominant_doc_type, dominant_agent
                )
                if raw_prompt:
                    chat_log.info(
                        f"Loaded prompt file: {prompt_path} "
                        f"(folder_selection={is_folder_selection}, "
                        f"doc_type='{target_doc_type or dominant_doc_type}', "
                        f"agent='{dominant_agent}')"
                    )
                    qa_prompt = _sanitize_extraction_prompt_for_chat(raw_prompt)

            if qa_prompt:
                qa_prompt = _append_chat_qa_rules(
                    qa_prompt,
                    is_finance=(is_finance_query or dominant_agent == "finance_agent"),
                    is_resume_query=is_resume_query,
                    resumes=resumes,
                )
        except Exception:
            pass

        if not qa_prompt:
            # Fallback: generic prompt with agent label
            agent_label = dominant_agent.replace("_", " ").title()
            if is_finance_query or dominant_agent == "finance_agent":
                qa_prompt = (
                    "You are a Finance Agent for Visibility Docs AI.\n\n"
                    "Answer only from the provided context and structured summary.\n\n"
                    "Rules:\n"
                    f"0. {_LANGUAGE_RULE} {_TONE_RULE}\n"
                    "1. Be exact about amounts, dates, and names.\n"
                    "2. If the user asks for PKR, report every amount as PKR (code PKR). Never use ₹ or INR. Never mix USD into a PKR answer unless you also convert it to PKR and label the rate.\n"
                    "3. Keep percentages intact. Do not guess rounded totals like ~10,000,000.\n"
                    "3. If the answer is missing, say you cannot find it in the documents.\n"
                    "4. Do not hallucinate or infer unsupported numbers.\n"
                    "5. Do not output JSON, unless the user explicitly requests JSON format.\n"
                )
            else:
                resume_rank_instruction = (
                    "\n7. The context may include a [Resume Rankings] block with CV evaluation scores. "
                    "Use those scores to rank, compare, or recommend candidates when asked.\n"
                ) if is_resume_query and any(r.get("cv_score") is not None for r in resumes) else ""
                qa_prompt = (
                    f"You are the {agent_label} - a document Q&A assistant for Visibility Docs AI.\n\n"
                    "Your job is to answer the user's question based ONLY on the provided document context below.\n\n"
                    "Rules:\n"
                    f"0. {_LANGUAGE_RULE} {_TONE_RULE}\n"
                    "1. Answer concisely and directly using the context.\n"
                    "2. If the context contains image/vision descriptions, use them to answer.\n"
                    "3. If the answer is NOT in the context, say \"I cannot find this information in the documents.\"\n"
                    "4. Do NOT make up or hallucinate information.\n"
                    "5. Do NOT output JSON or extract fields, unless the user explicitly requests JSON format.\n"
                    "6. If the context has tables or diagrams, explain what they show.\n"
                    "7. NEVER output `<document>` XML tags or repeat the document metadata in your response. Speak naturally to the user.\n"
                    "8. Use rich Markdown formatting. Always make labels, headers, and key terms **bold** (e.g., **Vendor Name:** Acme Corp) so the data is easy to read.\n"
                    "9. When performing math or calculating sums, NEVER write out a messy running tally (e.g., do not write A+B=C, C+D=E). \n"
                    "10. When asked to sum or compare data across rows, present the data in a clean Markdown Table, and place the **Grand Total** in bold on a new line below the table.\n"
                    "11. NEVER provide general background definitions, textbook explanations, or introductory essays (e.g. NEVER explain what 'Electrical Engineering' or 'Invoices' are in general).\n"
                    "12. Answer DIRECTLY and ONLY about the specific person, document, or facts requested.\n"
                    f"{resume_rank_instruction}"
                )

        # Cross-document aggregation instruction (list a field from EVERY file)
        if cross_doc:
            field_str = " ".join(agg_field_terms) if agg_field_terms else "the requested information"
            qa_prompt += (
                f"\n\nIMPORTANT — CROSS-DOCUMENT REQUEST:\n"
                f"The user asked for '{field_str}' from EVERY document (no specific file was selected).\n"
                f"Go through the provided context document-by-document and list the value for each one.\n"
                f"Format as a clear per-document list, e.g.:\n"
                f"  • <Document Title>: <value>\n"
                f"If a particular document does not contain the requested information, write:\n"
                f"  • <Document Title>: not found in this document\n"
                f"Cover ALL documents present in the context. Do not collapse into a single answer; show each document's value separately.\n"
            )

        chat_log.info(f"Built Q&A prompt for agent: {dominant_agent} ({len(qa_prompt)} chars)")

        chat_log.llm_call(model or "active-llm", context_len, len(question), len(sources), provider=provider)
        llm_t0 = time.time()
        is_followup = not is_first
        res_dict = conversation_service.chat(
            question, context, session_id=sid, is_followup=is_followup,
            system_prompt=qa_prompt, provider=provider, model=model,
            provider_config=provider_config,
        )
        answer = res_dict.get("answer", "") if isinstance(res_dict, dict) else str(res_dict)
        res_provider = res_dict.get("provider", provider) if isinstance(res_dict, dict) else provider
        res_model = res_dict.get("model", model) if isinstance(res_dict, dict) else model

        # Append bold tip message for All Documents scope
        if not resolved_ids and answer and not answer.startswith("⚠️"):
            tip_msg = "\n\n💡 **Note:** *For more detailed and complete information, please select specific file(s) from the document list.*"
            answer = answer.rstrip() + tip_msg

        chat_log.llm_response(time.time() - llm_t0, len(answer))

        history = conversation_service.get_history(sid)
        self._save_exchange(sid, question, answer, sources, is_first)

        chart_data = None
        if _wants_rag_inline_chart(question):
            chart_match = re.search(r"```json:chart\s*({[\s\S]*?})\s*```", answer)
            if chart_match:
                try:
                    chart_data = json.loads(chart_match.group(1))
                    answer = re.sub(r"```json:chart\s*{[\s\S]*?}\s*```", "", answer).strip()
                except Exception:
                    chart_data = None

        total = time.time() - t_start
        chat_log.chat_end(total, len(sources))
        chat_log.info(f"Answer length: {len(answer)} chars")

        return {
            "answer": answer,
            "sources": sources,
            "document_id": sources[0]["document_id"] if sources else "",
            "history": history,
            "session_id": sid,
            "provider": res_provider,
            "model": res_model,
            "chart_data": chart_data,
        }

    def _answer_on_excerpt(self, question: str, selected_text: str, organization_id: str,
                           sid: str, is_first: bool, provider: str = None,
                           model: str = None, provider_config: dict | None = None) -> dict:
        """Answer a follow-up question grounded STRICTLY on a user-selected excerpt.

        Used for the ChatGPT-style "highlight a response → ask about it" flow. No
        document retrieval is performed; the model may only use the excerpt.
        """
        chat_log = get_chat_logger()
        excerpt_context = (
            "The following is an excerpt the user selected from a previous answer. "
            "Answer the user's question using ONLY this excerpt.\n\n"
            f"[Selected Excerpt]\n{selected_text}\n[/Selected Excerpt]"
        )
        system_prompt = (
            "You are a helpful assistant for Visibility Docs AI.\n\n"
            "The user selected a specific portion of a previous response and is asking a "
            "follow-up question about it. Answer the question using ONLY the provided "
            "[Selected Excerpt]. Do not use any outside knowledge or other documents.\n\n"
            "Base every claim on the excerpt — quote or reference the relevant part when useful. "
            "If the excerpt does not contain the information needed, say so naturally and "
            "ask one short clarifying question about what they would like to know instead. "
            f"Keep the answer concise. {_LANGUAGE_RULE} {_TONE_RULE} "
            "Do not invent facts.\n"
        )
        chat_log.info(f"Focused excerpt Q&A — excerpt {len(selected_text)} chars, question {len(question)} chars")
        chat_log.llm_call("llama-3.3-70b-versatile", len(excerpt_context), len(question), 0, provider=provider)
        llm_t0 = time.time()
        res_dict = conversation_service.chat(
            question, excerpt_context, session_id=sid,
            is_followup=not is_first, system_prompt=system_prompt,
            provider=provider, model=model, provider_config=provider_config,
        )
        answer = res_dict.get("answer", "") if isinstance(res_dict, dict) else str(res_dict)
        res_provider = res_dict.get("provider", provider) if isinstance(res_dict, dict) else provider
        res_model = res_dict.get("model", model) if isinstance(res_dict, dict) else model
        chat_log.llm_response(time.time() - llm_t0, len(answer))
        self._save_exchange(sid, question, answer, [], is_first)
        history = conversation_service.get_history(sid)
        return {
            "answer": answer,
            "sources": [],
            "document_id": "",
            "history": history,
            "session_id": sid,
            "provider": res_provider,
            "model": res_model,
        }


chat_service = ChatService()

# ── Catalog drift check ──────────────────────────────────────────────
# The agent / doc_type KEYS in the maps above are bound to the registry at use
# time (see _detect_query_agent / detect_doc_type_keyword). Log once at import
# if any key has drifted out of the canonical sets so a new registry agent or
# classifier doc_type is noticed instead of silently ignored.
def _log_chat_catalog_drift() -> None:
    try:
        known_agents = set(_registry_agent_ids())
        known_types = set(_registry_doc_types().keys())
        unknown_agents = [k for k in ChatService._AGENT_INTENT_KEYWORDS if k not in known_agents]
        unknown_types = [k for k in ChatService.KEYWORD_TO_DOC_TYPE if k not in known_types]
        # other_agent is the intentional catch-all bucket — it never has intent keywords.
        missing_agents = sorted(
            (known_agents - set(ChatService._AGENT_INTENT_KEYWORDS)) - {"other_agent"}
        )
        missing_types = sorted(known_types - set(ChatService.KEYWORD_TO_DOC_TYPE))
        if unknown_agents:
            print(f"[chat_service] intent keywords reference agents NOT in registry: {unknown_agents}")
        if unknown_types:
            print(f"[chat_service] doc-type keywords reference types NOT in classifier: {unknown_types}")
        if missing_agents:
            print(f"[chat_service] registry agents without chat intent keywords (detection gap): {missing_agents}")
        if missing_types:
            print(f"[chat_service] classifier doc-types without chat keywords (detection gap): {missing_types}")
    except Exception as e:
        print(f"[chat_service] catalog drift check skipped: {e}")


_log_chat_catalog_drift()