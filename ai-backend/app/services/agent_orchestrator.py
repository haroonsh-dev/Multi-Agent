import os
import json
import logging
from .orchestration_logger import get_logger, C
from .resume_transcript_disambiguation import reconcile_resume_transcript_classification

logger = logging.getLogger("visibility-docs")

PROMPTS_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "prompts")


def _load_prompt(filename: str) -> str:
    path = os.path.join(PROMPTS_DIR, filename)
    if os.path.exists(path):
        with open(path, "r", encoding="utf-8") as f:
            content = f.read()
            log = get_logger()
            log.info(f"Prompt loaded: {C.DIM}{filename}{C.RESET} ({len(content)} chars)")
            return content
    return ""


def _load_phase3_prompt(filename: str) -> str:
    return _load_prompt(os.path.join("phase3", filename))


def get_phase3_prompt_for_doc(doc_type: str, agent_type: str = "") -> tuple[str, str]:
    """Resolve skill.md for the *effective* agent only.

    Never loads another specialist's skills when agent_type is clamped
    (e.g. invoice + other_agent must not load finance/invoice/skill.md).
    """
    canonical_agent = DOCUMENT_TO_PHASE3_AGENT.get(doc_type, "other_agent") if doc_type else "other_agent"
    agent = agent_type or canonical_agent
    folder_name = agent.replace("_agent", "")

    # Per-type skill under the effective agent only
    if agent != "other_agent" and doc_type and doc_type != "other":
        subfolder_path = os.path.join("phase3", folder_name, doc_type, "skill.md")
        content = _load_prompt(subfolder_path)
        if content:
            print("\n" + "★"*65)
            print(f"[SKILL.MD LOADED] Subfolder Skill File Used: app/prompts/{subfolder_path}")
            print(f"[SKILL.MD LOADED] Category: '{folder_name}' | DocType: '{doc_type}' | Agent: '{agent}'")
            print("★"*65 + "\n")
            return content, subfolder_path

    # Parent agent prompt for the effective agent
    if agent and agent != "other_agent":
        agent_path = os.path.join("phase3", f"{agent}.md")
        content = _load_prompt(agent_path)
        if content:
            print("\n" + "★"*65)
            print(f"[PARENT AGENT PROMPT LOADED] Main Agent File Used: app/prompts/{agent_path}")
            print(f"[PARENT AGENT PROMPT LOADED] Agent: '{agent}'")
            print("★"*65 + "\n")
            return content, agent_path

    fallback_path = os.path.join("phase3", "other.md")
    print("\n" + "★"*65)
    print(f"[FALLBACK PROMPT LOADED] Generic File Used: app/prompts/{fallback_path}")
    print(f"[FALLBACK PROMPT LOADED] Effective agent: '{agent}' (canonical for type was '{canonical_agent}')")
    print("★"*65 + "\n")
    return _load_prompt(fallback_path), fallback_path


def get_agent_from_prompt_path(prompt_path: str) -> str:
    """Extract canonical agent ID from a resolved prompt file path."""
    if not prompt_path:
        return "other_agent"
    path_lower = prompt_path.lower().replace("\\", "/")
    if "finance" in path_lower:
        return "finance_agent"
    if "procurement" in path_lower:
        return "procurement_agent"
    if "hr" in path_lower:
        return "hr_agent"
    if "legal" in path_lower:
        return "legal_agent"
    if "compliance" in path_lower:
        return "compliance_agent"
    return "other_agent"


PHASE3_AGENT_PROMPT_MAP = {
    "finance_agent": os.path.join("phase3", "finance_agent.md"),
    "procurement_agent": os.path.join("phase3", "procurement_agent.md"),
    "hr_agent": os.path.join("phase3", "hr_agent.md"),
    "legal_agent": os.path.join("phase3", "legal_agent.md"),
    "compliance_agent": os.path.join("phase3", "compliance_agent.md"),
    "other_agent": os.path.join("phase3", "other.md"),
}

DOCUMENT_TO_PHASE3_AGENT = {
    # Finance
    "invoice": "finance_agent",
    "financial_statement": "finance_agent",
    "expense_report": "finance_agent",
    "payment_receipt": "finance_agent",
    "tax_document": "finance_agent",
    "bank_statement": "finance_agent",
    "budget": "finance_agent",
    # HR
    "employee_record": "hr_agent",
    "hr_document": "hr_agent",
    "offer_letter": "hr_agent",
    "experience_letter": "hr_agent",
    "employment_contract": "hr_agent",
    "leave_application": "hr_agent",
    "payroll": "hr_agent",
    "attendance": "hr_agent",
    "performance_review": "hr_agent",
    "training_certificate": "hr_agent",
    "resume": "hr_agent",
    "transcript": "hr_agent",
    # Legal
    "contract": "legal_agent",
    "agreement": "legal_agent",
    "nda": "legal_agent",
    "service_agreement": "legal_agent",
    "lease_agreement": "legal_agent",
    "vendor_contract": "legal_agent",
    # Procurement
    "purchase_order": "procurement_agent",
    "quotation": "procurement_agent",
    "supplier_agreement": "procurement_agent",
    "vendor_list": "procurement_agent",
    "rfq": "procurement_agent",
    "delivery_note": "procurement_agent",
    "procurement_request": "procurement_agent",
    # Compliance
    "sop": "compliance_agent",
    "audit_report": "compliance_agent",
    "quality_report": "compliance_agent",
    "certificate": "compliance_agent",
    "maintenance_report": "compliance_agent",
    "engineering_drawing": "compliance_agent",
    "inspection_report": "compliance_agent",
    "safety_manual": "compliance_agent",
    "iso_document": "compliance_agent",
    "compliance_form": "compliance_agent",
    "regulatory_document": "compliance_agent",
    "other": "other_agent",
}

VALID_PHASE3_AGENTS = set(PHASE3_AGENT_PROMPT_MAP.keys())

HEURISTIC_RULES = [
    (
        "finance_agent",
        "invoice",
        [
            "invoice", "invoice date", "tax invoice", "sales invoice", "commercial invoice",
            "invoice #", "inv-", "bill to", "ship to", "amount due", "subtotal", "due date",
            "tax amount", "payment terms", "payment method", "unit price", "line items",
            "gst", "grand total", "total amount",
            "رسید", "بل", "ٹیکس", "رقم", "واجب الادا", "تاریخ", "انوائس",
        ],
    ),
    (
        "finance_agent",
        "financial_statement",
        [
            "balance sheet", "income statement", "profit & loss", "p&l",
            "cash flow", "assets", "liabilities", "equity", "revenue",
            "expenses", "net profit", "gross margin", "operating income",
            "financial summary", "financial statement", "financial position",
            "finance position", "accounts payable", "accounts receivable",
            "ap outstanding", "ar outstanding", "net payable", "net receivable",
            "aging report", "aging summary", "aging analysis", "aging", "net position",
            "total receivables", "total payables", "ap aging", "ar aging",
            "receivable", "receivables", "payable", "payables", "trial balance", "general ledger",
            "financial report", "finance report", "billed", "collected",
            "مالی گوشوارہ", "آمدنی", "اخراجات", "منافع",
        ],
    ),
    (
        "finance_agent",
        "bank_statement",
        [
            "bank statement", "account statement", "opening balance", "closing balance",
            "account number", "iban", "statement period", "debit", "credit",
            "withdrawals", "deposits", "clearing", "bank balance",
        ],
    ),
    (
        "finance_agent",
        "expense_report",
        [
            "expense report", "expense claim", "reimbursement", "travel expense",
            "meal expense", "expense summary", "employee expense", "out of pocket",
        ],
    ),
    (
        "finance_agent",
        "payment_receipt",
        [
            "payment receipt", "receipt #", "paid by", "received from",
            "payment confirmation", "transaction receipt", "receipt voucher", "proof of payment",
        ],
    ),
    (
        "finance_agent",
        "tax_document",
        [
            "tax return", "income tax", "sales tax return", "withholding tax",
            "tax deduction certificate", "fbr", "irs", "tax year", "form 1040", "tax assessment",
        ],
    ),
    (
        "finance_agent",
        "budget",
        [
            "budget plan", "budget allocation", "budget report", "annual budget",
            "fiscal year budget", "projected budget", "departmental budget",
        ],
    ),
    (
        "hr_agent",
        "offer_letter",
        [
            "offer letter", "job offer", "employment offer", "pleased to offer",
            "terms of offer", "offer of employment", "appointment offer", "joining date",
            "starting salary", "remuneration package", "offer summary", "position and duties",
        ],
    ),
    (
        "hr_agent",
        "experience_letter",
        [
            "experience letter", "experience certificate", "relieving letter",
            "service certificate", "to whom it may concern", "was employed with",
            "employment certificate", "worked with us", "served as", "tenure with",
        ],
    ),
    (
        "hr_agent",
        "employment_contract",
        [
            "employment contract", "employment agreement", "contract of employment",
            "terms of employment", "appointment agreement",
        ],
    ),
    (
        "hr_agent",
        "payroll",
        [
            "payroll", "pay slip", "payslip", "salary slip", "wage register",
            "basic salary", "allowances", "net pay", "gross pay", "deductions",
        ],
    ),
    (
        "hr_agent",
        "hr_document",
        [
            "employee", "salary", "appraisal", "leave application",
            "hr policy", "designation", "department", "training",
            "manager", "employee id", "performance review", "appointment letter",
            "ملازم", "تنخواہ", "چھٹی", "عہدہ", "شعبہ",
        ],
    ),
    (
        "hr_agent",
        "resume",
        [
            "resume", "cv", "curriculum vitae", "work experience",
            "education", "skills", "professional summary",
            "employment history", "qualifications", "achievements",
            "certifications", "objective", "projects", "technologies",
            "personal details", "github", "linkedin",
            "سوانح عمری", "تعلیم", "تجربہ", "مہارتیں", "اسناد",
        ],
    ),
    (
        "hr_agent",
        "transcript",
        [
            "official transcript", "academic transcript", "transcript of records",
            "grade point average", "cgpa", "sgpa", "marksheet", "marks sheet",
            "result card", "controller of examinations", "registrar",
            "roll number", "roll no", "course code", "credit hours",
            "credits earned", "semester result", "grade report",
        ],
    ),
    (
        "procurement_agent",
        "purchase_order",
        [
            "purchase order", "po number", "po-", "order date", "supplier",
            "vendor", "delivery date", "ship to", "requisition",
            "payment terms", "order quantity", "buyer",
            "آرڈر", "خریداری", "سپلائر", "ونڈر",
        ],
    ),
    (
        "procurement_agent",
        "quotation",
        [
            "quotation", "quote", "quotation #", "price list", "valid until",
            "price quote", "estimate", "price proposal", "unit price",
            "کوٹیشن", "اقتباس", "قیمت", "پیشکش",
        ],
    ),
    (
        "procurement_agent",
        "delivery_note",
        [
            "delivery note", "dispatch note", "goods received note", "grn",
            "packing slip", "delivery order", "bill of lading",
        ],
    ),
    (
        "legal_agent",
        "contract",
        [
            "contract", "agreement", "party a", "party b", "nda",
            "governing law", "jurisdiction", "clause", "termination",
            "renewal", "signature", "whereas", "in witness whereof",
            "indemnity", "confidentiality", "lease agreement",
            "service agreement", "binding", "executed",
            "معاہدہ", "کنٹریکٹ", "دستخط", "شرائط", "قانون",
        ],
    ),
    (
        "compliance_agent",
        "audit_report",
        [
            "audit report", "audit findings", "observations",
            "non-conformance", "corrective action", "finding",
            "critical", "major", "minor", "recommendations",
            "auditor", "scope", "compliance status",
            "آڈٹ", "جانچ", "مشاہدات", "سفارشات",
        ],
    ),
    (
        "compliance_agent",
        "inspection_report",
        [
            "inspection report", "safety validation", "field inspection",
            "site inspection", "inspection checklist", "safety report", "validation report",
        ],
    ),
    (
        "compliance_agent",
        "quality_report",
        [
            "quality report", "quality control", "qc", "quality assurance",
            "qa", "defect", "pass rate", "fail rate",
            "specification", "tolerance", "quality metrics",
            "کوالٹی", "معیار", "جانچ", "نقص",
        ],
    ),
    (
        "compliance_agent",
        "certificate",
        [
            "certificate", "certification", "certificate of",
            "this certifies", "cert no", "certificate of analysis",
            "certificate of origin", "certificate of compliance",
            "iso certificate", "certifying body",
            "سند", "تصدیق", "سرٹیفکیٹ",
        ],
    ),
    (
        "compliance_agent",
        "maintenance_report",
        [
            "maintenance", "service report", "repair", "equipment",
            "downtime", "technician", "work order", "breakdown",
            "fault", "servicing", "preventive maintenance",
            "مرمت", "دیکھ بھال", "سروس", "خرابی",
        ],
    ),
    (
        "compliance_agent",
        "sop",
        [
            "standard operating procedure", "sop", "procedure",
            "steps", "instructions", "protocol", "step-by-step",
            "operating procedure", "process guide",
            "طریقہ کار", "ہدایات", "مراحل", "پروٹوکول",
        ],
    ),
    (
        "compliance_agent",
        "engineering_drawing",
        [
            "drawing", "dwg", "schematic", "dimension", "tolerance",
            "scale", "revision", "title block", "part no",
            "drawn by", "checked by", "blueprint", "datum",
            "ڈرائنگ", "خاکہ", "پیمائش", "طول و عرض",
        ],
    ),
]


class ClassificationAgent:
    def _heuristic_classify(self, text: str, filename: str = "") -> dict:
        import unicodedata
        normalized_text = unicodedata.normalize("NFKD", text or "")
        normalized_filename = unicodedata.normalize("NFKD", filename or "")
        haystack = f"{normalized_filename}\n{normalized_text}".lower()
        normalized_haystack = " ".join(haystack.replace("_", " ").replace("-", " ").split())

        # Guard: technical / programming / database / academic lab material
        from .resume_transcript_disambiguation import filename_suggests_resume
        is_resume_filename = filename_suggests_resume(filename)

        tech_markers = [
            "lab manual", "lab assignment", "use universitydb", "select * from",
            "primary key", "foreign key", "stored procedure", "create procedure",
            "create table", "course outline", "credit hours", "semester examination",
            "insert into", "varchar(", "alter table", "delimiter //",
        ]
        is_technical = not is_resume_filename and (
            sum(1 for m in tech_markers if (m in haystack or m in normalized_haystack)) >= 2 or (
                any(w in filename.lower() for w in ["lab", "assign", "outline", "syllabus", "adbms"])
                and any(m in haystack for m in ["database", "sql", "stored procedure", "mongodb", "course", "lecture"])
            )
        )

        if is_technical:
            return {
                "document_type": "other",
                "agent_type": "other_agent",
                "confidence": 0.35,
                "reasoning": "Technical/academic material (database, programming, or course sheet)",
                "language": "en",
                "estimated_quality": "medium",
            }

        # Guard: Accounts Payable & Receivable Position / Aging reports vs single invoice
        is_ap_ar_position = any(
            k in normalized_haystack for k in [
                "accounts payable", "accounts receivable", "aging analysis", "aging report",
                "aging summary", "finance position", "financial position", "net position",
                "total receivables", "total payables", "ap aging", "ar aging", "debtor aging"
            ]
        )

        # Guard: HR experience certificate / employment letter vs compliance certificate
        is_hr_cert = any(
            k in normalized_haystack for k in [
                "experience certificate", "experience letter", "relieving letter",
                "service certificate", "was employed with", "employment certificate",
                "training certificate"
            ]
        )

        # Invoice anchor check: invoices must possess at least one primary billing anchor
        invoice_anchors = [
            "invoice", "inv-", "tax invoice", "bill to", "amount due",
            "subtotal", "grand total", "invoice #", "amount payable", "total amount"
        ]
        has_invoice_anchor = any(a in normalized_haystack for a in invoice_anchors)

        best = None
        best_score = 0

        for agent_type, doc_type, keywords in HEURISTIC_RULES:
            # Prevent technical/programming labs from being falsely classified as HR docs
            if is_technical and agent_type == "hr_agent" and doc_type in ("hr_document", "employee_record"):
                continue

            # If document is an AP/AR aging / financial position report, do NOT let single invoice win
            if is_ap_ar_position and doc_type == "invoice":
                continue

            # Invoices require a genuine billing anchor
            if doc_type == "invoice" and not has_invoice_anchor:
                continue

            # HR experience certificates belong to hr_agent, not compliance_agent
            if is_hr_cert and agent_type == "compliance_agent" and doc_type == "certificate":
                continue

            score = sum(1 for keyword in keywords if (keyword in haystack or keyword in normalized_haystack))

            # Strict requirement for resume: avoid classifying informational summaries having only "skills"
            if doc_type == "resume":
                from .resume_transcript_disambiguation import filename_suggests_resume
                has_resume_name = filename_suggests_resume(filename)
                resume_anchors = ["work experience", "professional experience", "curriculum vitae", "employment history", "career objective"]
                has_anchors = sum(1 for a in resume_anchors if (a in haystack or a in normalized_haystack)) >= 1
                if not (has_resume_name or has_anchors or score >= 3):
                    continue

            if score > best_score:
                best = (agent_type, doc_type)
                best_score = score

        from .resume_transcript_disambiguation import filename_suggests_resume
        is_resume_filename = filename_suggests_resume(filename)

        if not best or (best_score < 2 and not (is_resume_filename and best[1] == "resume")) or (is_technical and best[1] == "hr_document"):
            return {
                "document_type": "other",
                "agent_type": "other_agent",
                "confidence": 0.25 if is_technical else 0.15,
                "reasoning": "Technical/academic material not matching specific enterprise document types" if is_technical else "Heuristic fallback did not find a strong match",
                "language": "en",
                "estimated_quality": "low",
            }

        agent_type, doc_type = best
        confidence = min(0.95, 0.35 + (best_score * 0.12))
        return reconcile_resume_transcript_classification(
            {
                "document_type": doc_type,
                "agent_type": agent_type,
                "confidence": confidence,
                "reasoning": f"Heuristic fallback matched {best_score} keyword groups for {agent_type}",
                "language": "en",
                "estimated_quality": "medium",
            },
            text,
            filename,
        )

    def classify(self, text: str, filename: str = "") -> dict:
        from .groq_service import groq_service

        log = get_logger()
        log.info(f"Text: {len(text)} chars")
        prompt_template = _load_prompt("classification_agent.md")
        if not prompt_template:
            log.warn("No prompt template found, using heuristic fallback")
            return self._heuristic_classify(text, filename)

        prompt = prompt_template.replace("{text}", text[:6000]).replace("{filename}", filename)
        log.info(f"Prompt preview: {C.DIM}{prompt[:200].replace(chr(10), ' ')}...{C.RESET}")
        log.info(f"Input text: {C.DIM}{len(text)} chars, filename='{filename}'{C.RESET}")
        try:
            t0 = __import__("time").time()
            log.info("Calling Groq API (llama-3.1-8b-instant) for classification...")
            raw_response = ""
            try:
                raw_response = groq_service.chat(
                    [{"role": "user", "content": prompt}], temperature=0.05, max_tokens=1024, model="llama-3.1-8b-instant"
                )
            except Exception as first_err:
                log.warn(f"Groq 8b classify error ({first_err}), retrying on 70b with truncated text...")
                short_text = text[:4000]
                short_prompt = prompt_template.replace("{text}", short_text[:4000]).replace("{filename}", filename)
                raw_response = groq_service.chat(
                    [{"role": "user", "content": short_prompt}], temperature=0.05, max_tokens=1024, model="llama-3.3-70b-versatile"
                )
            
            import re
            scratchpad_match = re.search(r"<scratchpad>(.*?)</scratchpad>", raw_response, re.DOTALL)
            scratchpad_text = scratchpad_match.group(1).strip() if scratchpad_match else ""
            
            result = groq_service._parse_json(raw_response, {})
            duration = __import__("time").time() - t0
            if not result:
                log.warn(f"LLM returned empty ({duration:.1f}s), falling back to heuristic")
                return self._heuristic_classify(text, filename)
            doc_type = str(result.get("document_type", "other")).lower().replace(" ", "_")
            agent_type = str(result.get("phase3_agent", "")).lower().replace(" ", "_")

            from ..models.schemas import DocumentType
            valid_types = {t.value for t in DocumentType}
            if doc_type not in valid_types:
                log.warn(f"Invalid doc_type '{doc_type}' from LLM, falling back to 'other'")
                doc_type = "other"

            if agent_type not in VALID_PHASE3_AGENTS:
                old_agent = agent_type
                agent_type = DOCUMENT_TO_PHASE3_AGENT.get(doc_type, "other_agent")
                log.warn(f"Invalid agent '{old_agent}' from LLM → mapped to '{agent_type}' for '{doc_type}'")

            result_data = {
                "document_type": doc_type,
                "agent_type": agent_type,
                "confidence": float(result.get("confidence", 0)),
                "reasoning": scratchpad_text or result.get("reasoning", ""),
                "language": result.get("language", "en"),
                "estimated_quality": result.get("estimated_quality", "medium"),
            }
            log.result("Result", f"type={doc_type}, agent={agent_type}, conf={result_data['confidence']:.2f}, time={duration:.1f}s", C.GREEN)
            return reconcile_resume_transcript_classification(result_data, text, filename)
        except Exception as e:
            log.warn(f"LLM error: {e}, falling back to heuristic")
            logger.warning(f"Classification agent fallback used: {e}")
            fallback = self._heuristic_classify(text, filename)
            fallback["reasoning"] = f"{fallback['reasoning']}; LLM fallback reason: {e}"
            return reconcile_resume_transcript_classification(fallback, text, filename)


def _clean_repetitive_ocr(text: str) -> str:
    """Strip repetitive OCR loops to keep token count compact."""
    if not text:
        return ""
    lines = text.split("\n")
    cleaned = []
    seen = set()
    repeat_count = 0
    for line in lines:
        stripped = line.strip()
        if not stripped:
            cleaned.append(line)
            continue
        # Skip OCR vision artifact repetition loops
        if "looking at" in stripped.lower() or "transcribe" in stripped.lower() or "crop" in stripped.lower():
            if stripped in seen:
                continue
        if stripped in seen:
            repeat_count += 1
            if repeat_count > 3:
                continue
        else:
            repeat_count = 0
            seen.add(stripped)
        cleaned.append(line)
    return "\n".join(cleaned)


def _heuristic_extract_fields(text: str, document_type: str) -> dict:
    """Regex-based fallback extraction when LLM hits rate limit or payload too large."""
    import re
    data = {}
    if not text:
        return data

    inv_num = re.search(r"(?:invoice\s*#?|inv\s*#?|order\s*#?|bill\s*#?)\s*:?\s*([A-Za-z0-9\-_]+)", text, re.IGNORECASE)
    if inv_num:
        data["invoice_number"] = inv_num.group(1)
        data["document_number"] = inv_num.group(1)

    inv_date = re.search(r"(?:date|invoice\s*date)\s*:?\s*(\d{1,4}[\/\.-]\d{1,4}[\/\.-]\d{1,4})", text, re.IGNORECASE)
    if inv_date:
        data["invoice_date"] = inv_date.group(1)

    total_amt = re.search(r"(?:total|net\s*amount|amount\s*due|grand\s*total)\s*:?\s*(?:rs\.?|pkr|\$|eur|usd)?\s*([\d,]+\.?\d*)", text, re.IGNORECASE)
    if total_amt:
        data["total_amount"] = total_amt.group(1)

    vendor = re.search(r"^(?:company|vendor|from)?\s*([A-Z0-9\s\.\-]{3,40})(?=\n|\r)", text, re.MULTILINE)
    if vendor:
        data["vendor_name"] = vendor.group(1).strip()

    return data


class CategoryExtractionAgent:
    def extract(self, text: str, document_type: str, agent_type: str = "") -> dict:
        from .groq_service import groq_service

        agent = agent_type or DOCUMENT_TO_PHASE3_AGENT.get(document_type, "other_agent")
        log = get_logger()
        log.info(f"DocType: {document_type} | Text: {len(text if text else '')} chars")

        raw_clean_text = (text or "").strip()
        clean_text = _clean_repetitive_ocr(raw_clean_text)
        if not clean_text or clean_text == "[OCR failed]" or len(clean_text) < 15:
            log.warn(f"Empty or failed OCR text ({len(clean_text)} chars) — skipping extraction LLM call to prevent field leakage")
            return {
                "extracted_data": {},
                "scratchpad": "Document text is empty or OCR failed.",
                "confidence": 0.0,
                "field_confidence": {},
                "agent_type": agent,
            }

        prompt_template, prompt_path = get_phase3_prompt_for_doc(document_type, agent)
        if prompt_path:
            log.info(f"LOADED PROMPT FILE: {prompt_path} for agent '{agent}'")
        if not prompt_template:
            log.warn(f"No prompt found for agent '{agent}' / type '{document_type}', returning empty")
            return {"extracted_data": {}, "confidence": 0.0}

        prompt_base = prompt_template.replace("{text}", "")
        prompt_base += "\n\nCRITICAL INSTRUCTION: You MUST extract EVERY SINGLE line item, row, and record present in the text. DO NOT truncate, summarize, or stop early to save space."
        prompt_base += "\nCRITICAL INSTRUCTION: You MUST format your response exactly as follows. First, write out your reasoning inside a `<scratchpad>` XML block. Then, output the final JSON block."
        prompt_base += "\nCRITICAL INSTRUCTION [ANTI-HALLUCINATION]: You MUST NOT invent, guess, or hallucinate ANY data. If a specific field is NOT explicitly written in the document text, output `null` or `\"\"`."

        # Cap text size to ~8,000 chars (~2,000 tokens) to prevent Groq 6,000 TPM limit 413 error
        doc_slice = clean_text[:8000]
        prompt = prompt_base + f"\n\n<document>\n{doc_slice}\n</document>"

        log.info(f"Prompt loaded ({C.DIM}{prompt_path}, {len(prompt_template)} chars{C.RESET})")
        log.info(f"Prompt preview: {C.DIM}{prompt[:200].replace(chr(10), ' ')}...{C.RESET}")

        try:
            t0 = __import__("time").time()
            # Fast model first; escalate to 70b only if the fast pass returns empty/weak JSON
            log.info("Calling Groq API (llama-3.1-8b-instant) for extraction...")
            raw_response = ""
            try:
                raw_response = groq_service.chat(
                    [{"role": "user", "content": prompt}], temperature=0.0, max_tokens=2500, model="llama-3.1-8b-instant"
                )
            except Exception as rate_err:
                log.warn(f"Groq 8b extraction error ({rate_err}), retrying on 70b with truncated text...")
                short_doc_slice = clean_text[:4000]
                short_prompt = prompt_base + f"\n\n<document>\n{short_doc_slice}\n</document>"
                raw_response = groq_service.chat(
                    [{"role": "user", "content": short_prompt}], temperature=0.0, max_tokens=2000, model="llama-3.3-70b-versatile"
                )

            import re
            scratchpad_match = re.search(r"<scratchpad>(.*?)</scratchpad>", raw_response, re.DOTALL)
            scratchpad_text = scratchpad_match.group(1).strip() if scratchpad_match else ""

            result = groq_service._parse_json(raw_response, {})
            # Escalate once if fast model produced nothing useful
            if (not isinstance(result, dict) or len(result) < 2) and clean_text:
                try:
                    log.warn("Fast extraction returned weak JSON — escalating to llama-3.3-70b-versatile")
                    raw_response = groq_service.chat(
                        [{"role": "user", "content": prompt}], temperature=0.0, max_tokens=3000, model="llama-3.3-70b-versatile"
                    )
                    scratchpad_match = re.search(r"<scratchpad>(.*?)</scratchpad>", raw_response, re.DOTALL)
                    scratchpad_text = scratchpad_match.group(1).strip() if scratchpad_match else scratchpad_text
                    result = groq_service._parse_json(raw_response, {})
                except Exception as escalate_err:
                    log.warn(f"70b escalation failed: {escalate_err}")

            duration = __import__("time").time() - t0
            field_confidence = result.pop("_field_confidence", {}) if isinstance(result, dict) else {}
            avg_confidence = 0.7
            if field_confidence:
                scores = [v for v in field_confidence.values() if isinstance(v, (int, float))]
                avg_confidence = sum(scores) / len(scores) if scores else 0.7
            fields = list(result.keys()) if isinstance(result, dict) else []
            log.result("Fields", f"{fields[:8]}", C.GREEN)
            log.result("Confidence", f"{avg_confidence:.2f}", C.GREEN)
            log.result("Duration", f"{duration:.1f}s", C.DIM)
            return {
                "extracted_data": result if isinstance(result, dict) else {},
                "scratchpad": scratchpad_text,
                "confidence": avg_confidence,
                "field_confidence": field_confidence,
                "agent_type": agent,
                "prompt_path": prompt_path,
            }
        except Exception as e:
            log.fail(f"Extraction failed: {e}, falling back to local heuristic extraction")
            logger.error(f"Category extraction agent ({document_type}) error: {e}")
            fallback_data = _heuristic_extract_fields(clean_text, document_type)
            return {
                "extracted_data": fallback_data,
                "scratchpad": f"LLM rate limit fallback: {e}",
                "confidence": 0.5 if fallback_data else 0.0,
                "field_confidence": {},
                "agent_type": agent,
            }


classification_agent = ClassificationAgent()
category_agents = CategoryExtractionAgent()
