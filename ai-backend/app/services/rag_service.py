import re
import hashlib
from ..database import SupabaseDB
from ..config import settings
from .embedding_service import embedding_service
from .pinecone_service import pinecone_service


_NUMERED_RE = None
_CHAPTER_RE = None

_cross_encoder_instance = None
_ce_failed = False

def _get_cross_encoder():
    global _cross_encoder_instance, _ce_failed
    if _ce_failed:
        return None
    if _cross_encoder_instance is None:
        try:
            import os
            from sentence_transformers import CrossEncoder
            import logging
            logger = logging.getLogger("visibility-docs")

            model_name = "cross-encoder/ms-marco-MiniLM-L-6-v2"
            base_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
            safe_name = model_name.replace("/", "_").replace("-", "_")
            local_model_dir = os.path.join(base_dir, "data", "local_models", safe_name)

            if os.path.exists(local_model_dir) and os.path.isdir(local_model_dir) and any(os.scandir(local_model_dir)):
                logger.info(f"Loading 88MB Reranker directly from local project folder: {local_model_dir}...")
                _cross_encoder_instance = CrossEncoder(local_model_dir, device="cpu")
            else:
                logger.info(f"Loading Reranker '{model_name}' from HuggingFace...")
                _cross_encoder_instance = CrossEncoder(model_name, device="cpu")
                os.makedirs(local_model_dir, exist_ok=True)
                _cross_encoder_instance.save(local_model_dir)
                logger.info(f"Saved Reranker locally at: {local_model_dir}")

            print("[RERANKER] Loaded ms-marco-MiniLM-L-6-v2 Cross-Encoder (88MB) successfully")
        except Exception as e:
            _ce_failed = True
            print(f"[RERANKER] Cross-Encoder load notice: {e}")
            return None
    return _cross_encoder_instance


def _embedding_model_name() -> str:
    return getattr(settings, "EMBEDDING_MODEL", "BAAI/bge-large-en-v1.5") or "BAAI/bge-large-en-v1.5"


def _get_patterns():
    global _NUMERED_RE, _CHAPTER_RE
    if _NUMERED_RE is None:
        import re
        _NUMBERED_RE = re.compile(r'^\d+(?:\.\d+)*(?:\s+|\.\s+)(.+)')
        _CHAPTER_RE = re.compile(r'^(?:chapter|section|appendix|part|article)\s+\d+', re.IGNORECASE)
    return _NUMBERED_RE, _CHAPTER_RE


# Field-label detection: lines like "Suggestive Language:", "Required Language:",
# "Example:", "Note:", "Background:" etc. that act as sub-headings inside a section.
_PAGE_MARKER_RE = re.compile(r'<!--\s*Page\s+(\d+)\s*-->')

def _extract_page_from_content(text: str, default: int = None) -> int | None:
    """Extract the page number from a chunk's content by scanning for ``<!-- Page N -->`` markers."""
    matches = _PAGE_MARKER_RE.findall(text or "")
    if matches:
        return int(matches[0])
    return default


_LABEL_COLON_RE = None
_TITLECASE_RE = None


def _get_label_patterns():
    global _LABEL_COLON_RE, _TITLECASE_RE
    if _LABEL_COLON_RE is None:
        import re
        # Short label ending with a colon, starts with a capital letter
        _LABEL_COLON_RE = re.compile(r'^([A-Z][A-Za-z0-9\s\'"\-&/()]{1,79}):\s*$')
        # Title-Case short label (e.g. "Suggestive Language") without trailing punctuation
        _TITLECASE_RE = re.compile(r'^([A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,7})$')
    return _LABEL_COLON_RE, _TITLECASE_RE


def _detect_headings_from_file(file_path: str) -> list[dict]:
    import fitz
    numbered_re, chapter_re = _get_patterns()
    label_colon_re, _ = _get_label_patterns()

    doc = fitz.open(file_path)
    page_height = doc[0].rect.height if doc.page_count > 0 else 842
    headings = []
    for page_num in range(doc.page_count):
        page = doc[page_num]
        blocks = page.get_text("dict").get("blocks", [])
        font_sizes = []
        spans_data = []
        for block in blocks:
            if block.get("type") != 0:
                continue
            for line in block.get("lines", []):
                for span in line.get("spans", []):
                    txt = span.get("text", "").strip()
                    if txt:
                        font_sizes.append(span.get("size", 0))
                        spans_data.append({
                            "text": txt,
                            "size": span.get("size", 0),
                            "flags": span.get("flags", 0),
                            "font": span.get("font", ""),
                            "bbox": line.get("bbox", [0, 0, 0, 0]),
                        })
        if not font_sizes:
            continue
        font_sizes.sort()
        body_size = font_sizes[len(font_sizes) // 2]

        for sp in spans_data:
            txt = sp["text"]
            if len(txt) < 2 or len(txt) > 150:
                continue
            if txt.isdigit():
                continue
            size = sp["size"]
            flags = sp["flags"]
            font = sp["font"]
            is_bold = bool(flags & 16) or "bold" in font.lower()
            y0 = sp["bbox"][1]
            if y0 < page_height * 0.06 or y0 > page_height * 0.94:
                continue

            is_heading = False
            level = 0
            if size > body_size * 1.15:
                is_heading = True
                level = 1 if size > body_size * 1.4 else 2
            elif is_bold and len(txt) < 100 and size >= body_size * 0.9:
                is_heading = True
                level = 3
            m = numbered_re.match(txt)
            if m:
                is_heading = True
                level = min(level, 3) if level else 3
            if chapter_re.match(txt):
                is_heading = True
                level = 1
            m_label = label_colon_re.match(txt)
            if m_label:
                is_heading = True
                level = 3
                txt = m_label.group(1).strip()
            if txt.isupper() and len(txt) > 3 and len(txt) < 60 and not is_bold:
                is_heading = True
                level = min(level, 2) if level else 2

            if is_heading:
                headings.append({
                    "heading": txt,
                    "page": page_num + 1,
                    "level": level,
                    "y0": y0,
                })
    doc.close()

    headings.sort(key=lambda h: (h["page"], h["y0"]))
    collapsed = []
    for h in headings:
        if collapsed and collapsed[-1]["heading"] == h["heading"] and collapsed[-1]["page"] == h["page"]:
            continue
        collapsed.append(h)

    page1_top = [h for h in collapsed if h["page"] == 1 and h["y0"] < page_height * 0.15]
    if len(page1_top) >= 3:
        page1_top_set = {h["heading"] for h in page1_top}
        collapsed = [h for h in collapsed if h["heading"] not in page1_top_set or h["page"] != 1]

    collapsed = [h for h in collapsed if not (h["level"] == 3 and len(h["heading"].split()) == 1)]

    return collapsed


def _detect_headings_from_text(text: str) -> list[dict]:
    numbered_re, chapter_re = _get_patterns()
    label_colon_re, titlecase_re = _get_label_patterns()
    headings = []
    lines = text.split("\n")
    body_sizes = [len(l.split()) for l in lines if l.strip()]
    avg_line_words = sum(body_sizes) / max(len(body_sizes), 1) if body_sizes else 10

    for idx, line in enumerate(lines):
        stripped = line.strip()
        if not stripped:
            continue
        md_match = re.match(r'^(#{1,6})\s+(.+)', stripped)
        if md_match:
            level = len(md_match.group(1))
            headings.append({"heading": md_match.group(2), "level": level})
        elif numbered_re.match(stripped):
            prev_line = lines[idx - 1].strip() if idx > 0 else ""
            if prev_line and len(prev_line) > 3 and not numbered_re.match(prev_line):
                headings.append({"heading": stripped, "level": 3})
        elif chapter_re.match(stripped):
            headings.append({"heading": stripped, "level": 1})
        elif label_colon_re.match(stripped):
            m = label_colon_re.match(stripped)
            headings.append({"heading": m.group(1).strip(), "level": 3})
        elif titlecase_re.match(stripped) and len(stripped) <= 60 and len(stripped.split()) >= 2:
            # Title-Case short label without colon (e.g. "Suggestive Language")
            headings.append({"heading": stripped, "level": 3})
        elif stripped.isupper() and len(stripped) > 3 and len(stripped) < 80:
            word_count = len(stripped.split())
            if word_count < avg_line_words * 0.7:
                headings.append({"heading": stripped, "level": 2})

    return headings


def _merge_headings(text_headings: list[dict], pdf_headings: list[dict]) -> list[dict]:
    seen = set()
    merged = []
    for h in pdf_headings + text_headings:
        key = h.get("heading", "").strip().lower()
        if key and key not in seen:
            seen.add(key)
            merged.append(h)
    return merged


def _build_sections(text: str, headings: list[dict]) -> list[dict]:
    if not headings:
        return []
    # Retain any preamble (text before the first detected heading) as its own
    # section. Without this, form-like documents (invoices/RFQs with "Label: value"
    # lines) lose all their field content when the first real heading appears late.
    first_heading = headings[0]["heading"]
    first_idx = text.find(first_heading)
    preamble = text[:first_idx].strip() if first_idx > 0 else ""
    raw_sections = []
    if preamble:
        raw_sections.append({
            "heading": "",
            "content": preamble,
            "level": 1,
        })
    search_pos = 0
    for i, h in enumerate(headings):
        start_text = h["heading"]
        start_idx = text.find(start_text, search_pos)
        if start_idx < 0:
            continue
        end_idx = len(text)
        if i + 1 < len(headings):
            next_text = headings[i + 1]["heading"]
            nxt = text.find(next_text, start_idx + len(start_text))
            if nxt > start_idx:
                end_idx = nxt
        section_text = text[start_idx:end_idx].strip()
        if section_text:
            raw_sections.append({
                "heading": h["heading"],
                "content": section_text,
                "level": h.get("level", 3),
            })
            search_pos = end_idx
    if not raw_sections:
        return []

    merged = []
    buffer = None
    for sec in raw_sections:
        content_words = len(sec["content"].split())
        is_tiny = content_words < 30 and sec["level"] >= 2
        if is_tiny:
            if buffer is None:
                buffer = sec
            else:
                buffer["content"] += "\n" + sec["content"]
        else:
            if buffer:
                merged.append(buffer)
                buffer = None
            merged.append(sec)
    if buffer:
        # Keep trailing tiny section as its own chunk (don't merge into previous
        # section) so field labels like "Required Language" stay retrievable.
        merged.append(buffer)
    return merged


def _chunk_by_sections(text: str, headings: list[dict], max_words: int = 350) -> list[dict]:
    sections = _build_sections(text, headings)
    if not sections:
        return []

    chunks = []
    import re
    for sec in sections:
        content = sec["content"]
        words = content.split()
        if len(words) <= max_words:
            cid = hashlib.md5(content.encode()).hexdigest()
            chunks.append({
                "content": content,
                "chunk_id": cid,
                "chunk_index": len(chunks),
                "word_count": len(words),
                "heading": sec["heading"],
                "chunk_type": "section",
            })
        else:
            sentences = re.split(r'(?<=[.!?])\s+', content)
            current = []
            current_words = 0
            for sent in sentences:
                sw = len(sent.split())
                if current_words + sw > max_words and current:
                    chunk_text = " ".join(current)
                    cid = hashlib.md5(chunk_text.encode()).hexdigest()
                    chunks.append({
                        "content": chunk_text,
                        "chunk_id": cid,
                        "chunk_index": len(chunks),
                        "word_count": current_words,
                        "heading": sec["heading"],
                        "chunk_type": "section",
                    })
                    current = [sent]
                    current_words = sw
                else:
                    current.append(sent)
                    current_words += sw
            if current:
                chunk_text = " ".join(current)
                cid = hashlib.md5(chunk_text.encode()).hexdigest()
                chunks.append({
                    "content": chunk_text,
                    "chunk_id": cid,
                    "chunk_index": len(chunks),
                    "word_count": current_words,
                    "heading": sec["heading"],
                    "chunk_type": "section",
                })
    return chunks


ATOMIC_PATTERNS = [
    (re.compile(r'^\|.+\|$'), "table"),
    (re.compile(r'^```'), "code_block"),
    (re.compile(r'^(?:>?\s*)?(?:\*\*)?(?:Warning|Note|Caution|Important|Notice|Danger|Info)(?:\*\*)?\s*[:]?\s*', re.IGNORECASE), "admonition"),
    (re.compile(r'^\s*(?:-\s+|\*\s+|\d+[.)]\s+)'), "list_item"),
]

INVOICE_HINT_RE = re.compile(
    r'\b(invoice|inv\.?|bill to|ship to|subtotal|tax|vat|gst|grand total|amount due|due date|payment terms|line item|unit price|purchase order|po number)\b',
    re.IGNORECASE,
)
INVOICE_FIELD_RE = re.compile(
    r'^\s*[A-Za-z][A-Za-z0-9 /&().,-]{1,40}\s*[:\-]\s*.+$'
)
INVOICE_TOTAL_RE = re.compile(
    r'\b(subtotal|tax|vat|gst|discount|shipping|total|amount due|balance due|paid|due)\b',
    re.IGNORECASE,
)
INVOICE_LINE_ITEM_RE = re.compile(
    r'^\s*[\w\s().,&/-]{2,80}\s+\d[\d,]*([.]\d+)?\s+\d[\d,]*([.]\d+)?\s+\d[\d,]*([.]\d+)?\s*$'
)


def _is_atomic_start(line: str) -> str | None:
    for pat, atype in ATOMIC_PATTERNS:
        if pat.match(line):
            return atype
    return None


def _parse_atomic_blocks(text: str) -> list[dict]:
    lines = text.split('\n')
    blocks = []
    i = 0
    while i < len(lines):
        line = lines[i]
        stripped = line.strip()
        atype = _is_atomic_start(stripped)

        if atype == "code_block":
            block_lines = [line]
            i += 1
            while i < len(lines):
                block_lines.append(lines[i])
                if lines[i].strip().startswith("```"):
                    break
                i += 1
            blocks.append({"type": "code", "content": "\n".join(block_lines), "words": len(" ".join(block_lines).split())})
            i += 1

        elif stripped.startswith("|") and stripped.endswith("|"):
            table_lines = [line]
            i += 1
            while i < len(lines) and lines[i].strip().startswith("|"):
                table_lines.append(lines[i])
                i += 1
            blocks.append({"type": "table", "content": "\n".join(table_lines), "words": len(" ".join(table_lines).split())})

        elif not stripped:
            i += 1
            continue

        elif atype == "admonition":
            admon_lines = [line]
            i += 1
            while i < len(lines) and lines[i].strip() and not _is_atomic_start(lines[i].strip()):
                admon_lines.append(lines[i])
                i += 1
            blocks.append({"type": "admonition", "content": "\n".join(admon_lines), "words": len(" ".join(admon_lines).split())})

        elif re.match(r'^\d+[.)]\s', stripped):
            list_lines = [line]
            i += 1
            while i < len(lines) and re.match(r'^\d+[.)]\s', lines[i].strip()):
                list_lines.append(lines[i])
                i += 1
            blocks.append({"type": "numbered_list", "content": "\n".join(list_lines), "words": len(" ".join(list_lines).split())})

        elif re.match(r'^[-*]\s', stripped):
            list_lines = [line]
            i += 1
            while i < len(lines) and re.match(r'^[-*]\s', lines[i].strip()):
                list_lines.append(lines[i])
                i += 1
            blocks.append({"type": "bullet_list", "content": "\n".join(list_lines), "words": len(" ".join(list_lines).split())})

        elif stripped.startswith("---"):
            i += 1
            continue

        elif stripped.startswith("<!--"):
            i += 1
            continue

        else:
            para_lines = [line]
            i += 1
            while i < len(lines) and lines[i].strip() and not _is_atomic_start(lines[i].strip()):
                stripped_next = lines[i].strip()
                if re.match(r'^\d+[.)]\s', stripped_next) or re.match(r'^[-*]\s', stripped_next):
                    break
                para_lines.append(lines[i])
                i += 1
            text_content = "\n".join(para_lines)
            blocks.append({"type": "paragraph", "content": text_content, "words": len(text_content.split())})

    return blocks


def _looks_like_invoice(text: str) -> bool:
    if not text:
        return False
    lowered = text.lower()
    score = 0
    for token in (
        "invoice", "subtotal", "tax", "vat", "gst", "total", "amount due",
        "due date", "payment terms", "bill to", "ship to", "unit price",
        "line item", "invoice #", "invoice no", "inv-", "po number",
    ):
        if token in lowered:
            score += 1
    return score >= 3


def _invoice_aware_chunk(text: str, max_words: int = 180) -> list[dict]:
    if not text:
        return []

    lines = [ln.rstrip() for ln in text.splitlines()]
    chunks = []
    current = []
    current_words = 0
    chunk_index = 0

    def flush_current():
        nonlocal current, current_words, chunk_index
        content = "\n".join(current).strip()
        if not content:
            current = []
            current_words = 0
            return
        chunks.append({
            "content": content,
            "chunk_id": hashlib.md5(content.encode()).hexdigest(),
            "chunk_index": chunk_index,
            "word_count": len(content.split()),
            "chunk_type": "invoice_section",
        })
        chunk_index += 1
        current = []
        current_words = 0

    for raw_line in lines:
        line = raw_line.strip()
        if not line:
            flush_current()
            continue

        is_field = bool(INVOICE_FIELD_RE.match(line) and (":" in line or "-" in line)) and len(line) < 140
        is_total = bool(INVOICE_TOTAL_RE.search(line))
        is_item = bool(INVOICE_LINE_ITEM_RE.match(line))
        words = len(line.split())

        if is_field or is_total:
            flush_current()
            chunks.append({
                "content": line,
                "chunk_id": hashlib.md5(line.encode()).hexdigest(),
                "chunk_index": chunk_index,
                "word_count": words,
                "chunk_type": "invoice_field" if is_field else "invoice_total",
            })
            chunk_index += 1
            continue

        if is_item:
            if current and current_words + words > max_words:
                flush_current()
            current.append(line)
            current_words += words
            continue

        if current_words + words > max_words and current:
            flush_current()
        current.append(line)
        current_words += words

    flush_current()
    return chunks


def _markdown_aware_chunk(text: str, max_words: int = 250) -> list[dict]:
    if not text:
        return []

    blocks = _parse_atomic_blocks(text)
    if not blocks:
        return []

    chunks = []
    current_blocks = []
    current_words = 0
    chunk_id = 0
    current_heading = None

    for block in blocks:
        bw = block["words"]
        if bw > max_words:
            if current_blocks:
                ct = "\n\n".join(b["content"] for b in current_blocks)
                chunks.append({
                    "content": ct,
                    "chunk_id": hashlib.md5(ct.encode()).hexdigest(),
                    "chunk_index": chunk_id,
                    "word_count": current_words,
                    "heading": current_heading,
                    "chunk_type": "markdown_section",
                })
                chunk_id += 1
                current_blocks = []
                current_words = 0

            ct = block["content"]
            chunks.append({
                "content": ct,
                "chunk_id": hashlib.md5(ct.encode()).hexdigest(),
                "chunk_index": chunk_id,
                "word_count": bw,
                "heading": current_heading,
                "chunk_type": block["type"],
            })
            chunk_id += 1
            continue

        if current_words + bw > max_words and current_blocks:
            ct = "\n\n".join(b["content"] for b in current_blocks)
            chunks.append({
                "content": ct,
                "chunk_id": hashlib.md5(ct.encode()).hexdigest(),
                "chunk_index": chunk_id,
                "word_count": current_words,
                "heading": current_heading,
                "chunk_type": "markdown_section",
            })
            chunk_id += 1
            current_blocks = [block]
            current_words = bw
        else:
            current_blocks.append(block)
            current_words += bw

        content = block["content"]
        first_line = content.split("\n")[0].strip()
        if first_line.startswith("#"):
            current_heading = first_line.lstrip("#").strip()
        elif first_line.startswith("##"):
            current_heading = first_line.lstrip("#").strip()

    if current_blocks:
        ct = "\n\n".join(b["content"] for b in current_blocks)
        chunks.append({
            "content": ct,
            "chunk_id": hashlib.md5(ct.encode()).hexdigest(),
            "chunk_index": chunk_id,
            "word_count": current_words,
            "heading": current_heading,
            "chunk_type": "markdown_section",
        })

    return chunks


class RAGService:
    def _expand_query(self, query: str) -> list[str]:
        """Generate alternative search queries via LLM for better recall."""
        if not query or len(query) < 3:
            return []
        try:
            from .groq_service import groq_service
            prompt = (
                "Given the user's search query below, generate 2 alternative versions "
                "that would match the same information need but use DIFFERENT words. "
                "Return ONLY a JSON array of strings, nothing else.\n\n"
                f"Query: {query}"
            )
            resp = groq_service.chat(
                [{"role": "user", "content": prompt}],
                temperature=0.3, max_tokens=256,
                model="llama-3.3-70b-versatile",
            )
            import json
            alt = json.loads(resp.strip())
            if isinstance(alt, list) and len(alt) > 0:
                valid = [q for q in alt if isinstance(q, str) and q.strip() and q != query]
                print(f"[SEARCH] Query expansion: '{query}' → {valid}")
                return valid[:3]
        except Exception as e:
            print(f"[SEARCH] Query expansion failed: {e}")
        return []

    def _expand_finance_query(self, query: str) -> list[str]:
        """Deterministic finance/invoice query expansion for better keyword recall."""
        if not query:
            return []
        q = query.lower()
        variants = set()

        def add_variant(text: str):
            clean = " ".join(text.split()).strip()
            if clean and clean != query:
                variants.add(clean)

        synonym_map = [
            (("invoice number", "invoice no", "inv no", "inv #"), ["invoice #", "invoice number", "inv no"]),
            (("due date", "payment due", "pay by", "deadline"), ["due date", "payment due date", "pay by date"]),
            (("total", "amount due", "grand total", "final amount"), ["total amount", "amount due", "grand total"]),
            (("subtotal", "sub total"), ["subtotal", "sub total"]),
            (("tax", "vat", "gst"), ["tax amount", "vat amount", "gst amount"]),
            (("vendor", "supplier", "seller"), ["vendor name", "supplier name", "seller name"]),
            (("customer", "buyer", "bill to"), ["customer name", "bill to"]),
            (("line item", "items", "item list"), ["line items", "items", "item list"]),
            (("کل رقم", "رقم", "ٹوٹل"), ["total amount", "کل رقم", "grand total"]),
            (("انوائس", "بل", "رسید"), ["invoice", "bill", "invoice number"]),
            (("تاریخ", "due date"), ["due date", "تاریخ وصولی", "payment due date"]),
            (("vendor", "فروشندہ", "سپلائر"), ["vendor name", "فروشندہ کا نام", "supplier name"]),
            (("customer", "گاہک", "خریدار"), ["customer name", "گاہک کا نام", "bill to"]),
            (("total amount", "کل رقم", "مجموعی رقم"), ["total amount", "کل رقم", "grand total", "amount due"]),
        ]

        for needles, replacements in synonym_map:
            if any(n in q for n in needles):
                for repl in replacements:
                    add_variant(query.replace(next((n for n in needles if n in q), needles[0]), repl))
                add_variant(f"{query} invoice")
                add_variant(f"{query} amount")

        if "invoice" in q or "bill" in q or "amount" in q:
            add_variant(f"invoice total {query}")
            add_variant(f"invoice number due date total {query}")

        return list(variants)[:4]

    def _expand_general_query(self, query: str) -> list[str]:
        """Deterministic synonym expansion for resume / RFQ / legal / general concepts
        (incl. Urdu) to improve recall without an extra LLM call."""
        if not query:
            return []
        q = query.lower()
        variants = set()

        def add_variant(text: str):
            clean = " ".join(text.split()).strip()
            if clean and clean != query:
                variants.add(clean)

        synonym_map = [
            (("resume", "cv", "c.v.", "bio data", "بائیو ڈیٹا", "ریزیومہ"), ["resume CV candidate experience skills"]),
            (("candidate", "applicant", "امیدوار"), ["candidate applicant experience"]),
            (("experience", "تجربہ"), ["work experience years skills"]),
            (("skills", "مہارت"), ["skills technical communication"]),
            (("rfq", "quotation", "quote", "request for quotation", "کوٹیشن", "درخواست"), ["rfq quotation required language suggestive language"]),
            (("suggestive", "suggestive language"), ["suggestive language example GSA"]),
            (("required language", "required text"), ["required language English documentation"]),
            (("contract", "agreement", "معاہدہ"), ["contract agreement terms clause"]),
            (("delivery", "deliver", "ترسیل"), ["delivery date days shipping"]),
            (("pricing", "price", "قیمت"), ["pricing structure cost total"]),
            (("deadline", "due date", "تاریخ"), ["deadline due date submission"]),
        ]
        for needles, replacements in synonym_map:
            if any(n in q for n in needles):
                for repl in replacements:
                    add_variant(repl)
        return list(variants)[:4]

    def _build_structured_summary_text(self, document_ids: list[str], organization_id: str) -> str:
        if not document_ids:
            return ""
        try:
            import json
            from ..database import _get_supabase, _use_supabase, _local_select_in
            unique_ids = list(set(document_ids))
            client = _get_supabase()
            if _use_supabase and client:
                r = client.table("documents_metadata") \
                    .select("document_id, document_type, extracted_data, field_confidence, overall_confidence") \
                    .in_("document_id", unique_ids) \
                    .eq("organization_id", organization_id) \
                    .execute()
                rows = getattr(r, "data", [])
            else:
                rows = _local_select_in(
                    "documents_metadata",
                    columns="document_id, document_type, extracted_data, field_confidence, overall_confidence",
                    filters={"organization_id": organization_id},
                    in_column="document_id",
                    in_values=unique_ids,
                )
            if not rows:
                return ""

            doc_titles = self._fetch_doc_titles(unique_ids, organization_id)
            parts = ["[Structured Document Summary]"]
            for row in rows:
                if not isinstance(row, dict):
                    continue
                raw = row.get("extracted_data", "{}")
                if isinstance(raw, str):
                    try:
                        extracted = json.loads(raw)
                    except Exception:
                        extracted = {}
                else:
                    extracted = raw or {}
                if not isinstance(extracted, dict) or not extracted:
                    continue

                did = row.get("document_id", "")
                title, dtype, p3a = doc_titles.get(did, ("", "", ""))
                label = title or did or "Document"
                parts.append(f"\nDocument: {label}")
                if dtype:
                    parts.append(f"Type: {dtype}")
                if p3a:
                    parts.append(f"Agent: {p3a}")

                # Finance docs benefit from compact, field-exact summaries.
                for key, value in extracted.items():
                    if key.startswith("_"):
                        continue
                    if value in (None, "", [], {}):
                        continue
                    if isinstance(value, (str, int, float, bool)):
                        parts.append(f"{key}: {value}")
                    elif isinstance(value, list):
                        if key == "line_items":
                            parts.append("line_items:")
                            for item in value[:500]:
                                if isinstance(item, dict):
                                    item_bits = []
                                    for field in ("description", "quantity", "unit_price", "price", "total", "amount"):
                                        if item.get(field) not in (None, "", []):
                                            item_bits.append(f"{field}={item.get(field)}")
                                    if item_bits:
                                        parts.append("  - " + ", ".join(item_bits))
                                else:
                                    parts.append(f"  - {item}")
                        else:
                            parts.append(f"{key}: {value[:100]}")
                    elif isinstance(value, dict):
                        nested_bits = []
                        for nested_key, nested_val in value.items():
                            if nested_val not in (None, "", [], {}):
                                nested_bits.append(f"{nested_key}={nested_val}")
                        if nested_bits:
                            parts.append(f"{key}: " + ", ".join(nested_bits[:100]))

            summary = "\n".join(parts).strip()
            return summary if len(summary) > len("[Structured Document Summary]") else ""
        except Exception:
            return ""

    def index_structured_summary(self, document_id: str, organization_id: str, document_type: str,
                                 extracted_data: dict, field_confidence: dict | None = None):
        if not extracted_data or not isinstance(extracted_data, dict):
            return
        try:
            import json
            title_map = self._fetch_doc_titles([document_id], organization_id)
            title, dtype, p3a = title_map.get(document_id, ("", document_type or "", ""))
            summary_lines = ["Structured Document Summary"]
            if title:
                summary_lines.append(f"Title: {title}")
            if dtype:
                summary_lines.append(f"Type: {dtype}")
            if p3a:
                summary_lines.append(f"Agent: {p3a}")
            for key, value in extracted_data.items():
                if key.startswith("_"):
                    continue
                if value in (None, "", [], {}):
                    continue
                if isinstance(value, (str, int, float, bool)):
                    summary_lines.append(f"{key}: {value}")
                elif isinstance(value, list):
                    if key == "line_items":
                        summary_lines.append("line_items:")
                        for item in value[:500]:
                            if isinstance(item, dict):
                                parts = []
                                for field in ("description", "quantity", "unit_price", "price", "total", "amount"):
                                    if item.get(field) not in (None, "", []):
                                        parts.append(f"{field}={item.get(field)}")
                                if parts:
                                    summary_lines.append("  - " + ", ".join(parts))
                            else:
                                summary_lines.append(f"  - {item}")
                    else:
                        summary_lines.append(f"{key}: {json.dumps(value[:100], ensure_ascii=False)}")
                elif isinstance(value, dict):
                    nested = ", ".join(f"{k}={v}" for k, v in value.items() if v not in (None, "", [], {}))
                    if nested:
                        summary_lines.append(f"{key}: {nested}")

            if field_confidence:
                conf_bits = []
                for key, value in field_confidence.items():
                    if isinstance(value, (int, float)):
                        conf_bits.append(f"{key}={value:.2f}")
                if conf_bits:
                    summary_lines.append("field_confidence: " + ", ".join(conf_bits[:500]))

            summary_text = "\n".join(summary_lines).strip()
            if len(summary_text.split()) < 5:
                return

            heading = "Structured Invoice Summary" if document_type == "invoice" else "Structured Document Summary"
            chunk = {
                "content": summary_text,
                "chunk_id": hashlib.md5(summary_text.encode()).hexdigest(),
                "chunk_index": 0,
                "word_count": len(summary_text.split()),
                "heading": heading,
                "chunk_type": "structured_summary",
            }
            embedding = embedding_service.embed_text(summary_text)
            chunk_rec = {
                "organization_id": organization_id,
                "document_id": document_id,
                "page_id": None,
                "chunk_index": 0,
                "chunk_type": "structured_summary",
                "heading": heading,
                "content": summary_text,
                "chunk_text": summary_text,
                "metadata": {
                    "chunk_index": 0,
                    "word_count": len(summary_text.split()),
                    "heading": heading,
                    "document_type": document_type,
                    "source": "structured_summary",
                },
            }
            emb_rec = {
                "organization_id": organization_id,
                "document_id": document_id,
                "embedding": embedding,
                "model_name": _embedding_model_name(),
            }
            SupabaseDB.insert("document_chunks", chunk_rec)
            SupabaseDB.insert("document_embeddings", emb_rec)
            if pinecone_service.available:
                vid = f"{document_id}_{chunk['chunk_id']}"
                pinecone_service.upsert([(vid, embedding, {
                    "document_id": document_id,
                    "organization_id": organization_id,
                    "chunk_index": 0,
                    "chunk_type": "structured_summary",
                    "chunk_text": summary_text[:1000],
                    "heading": heading,
                    "document_type": document_type,
                })], namespace=organization_id)
        except Exception as e:
            print(f"[INDEX] Structured summary indexing failed: {e}")

    def _rrf_fuse(self, per_strategy: list[list[dict]], k: int = 60) -> list[dict]:
        """Reciprocal Rank Fusion — fair scoring across heterogeneous search strategies."""
        rrf_map = {}
        for strategy_res in per_strategy:
            for rank, r in enumerate(strategy_res):
                key = r.get("_rrf_key")
                if not key:
                    key = r["document_id"] + "::" + str(r.get("chunk_index", r.get("chunk_text", "")[:80]))
                    r["_rrf_key"] = key
                if key not in rrf_map:
                    rrf_map[key] = {**r, "_rrf_score": 0.0, "_rank_sum": 0, "_vec_sum": 0.0, "_vec_n": 0}
                rrf_map[key]["_rrf_score"] += 1.0 / (k + rank)
                rrf_map[key]["_rank_sum"] += rank
                vs = r.get("score") or 0.0
                rrf_map[key]["_vec_sum"] += vs
                rrf_map[key]["_vec_n"] += 1
        results = []
        for r in rrf_map.values():
            r["_vec_score"] = r["_vec_sum"] / r["_vec_n"] if r["_vec_n"] else 0.0
            r["score"] = r["_rrf_score"]
            results.append(r)
        results.sort(key=lambda x: (-x["_rrf_score"], x["_rank_sum"]))
        return results

    _STOPWORDS = {"what", "is", "the", "a", "an", "of", "for", "to", "in", "on", "with",
                  "and", "or", "does", "do", "did", "mean", "how", "why", "who", "which",
                  "this", "that", "these", "those", "from", "by", "at", "as", "be", "are"}

    _TYPE_KEYWORDS = {
        "invoice": ["invoice", "inv ", "bill", "payment", "due date", "vendor", "tax", "vat",
                    "gst", "subtotal", "line item", "amount due", "انوائس", "بل"],
        "quotation": ["rfq", "quotation", "quote", "suggestive", "required language", "bid",
                      "tender", "proposal", "procurement", "کوٹیشن"],
        "resume": ["resume", "cv", "candidate", "applicant", "experience", "skill", "skills",
                   "ریزیومہ", "امیدوار"],
        "contract": ["contract", "agreement", "clause", "liability", "معاہدہ"],
    }



    def _rerank(self, results: list[dict], query: str, top_n: int = 30) -> list[dict]:
        """SOTA Reranker combining Hybrid Search + Cross-Encoder (ms-marco-MiniLM-L-6-v2)."""
        import re
        import numpy as np

        raw_terms = [t for t in re.sub(r'[^\w\s]', ' ', (query or "").lower()).split()]
        q_terms = [t for t in raw_terms if len(t) >= 2 and t not in self._STOPWORDS]
        n_terms = max(1, len(q_terms))

        ql = (query or "").lower().strip()
        type_boost = 0.0
        for dtype, kws in self._TYPE_KEYWORDS.items():
            if any(k in ql for k in kws):
                type_boost = dtype
                break

        query_words_orig = (query or "").split()
        entity_terms = [
            w.lower().strip(".,;:?!'\"()[]{}")
            for w in query_words_orig
            if len(w) >= 3 and w[0].isupper() and w.lower() not in self._STOPWORDS
        ]

        for r in results:
            ct = (r.get("chunk_text") or "").lower()
            doc_title = (r.get("document_title") or "").lower()
            combined_text = ct + " " + doc_title

            overlap = sum(1 for t in q_terms if t and t in ct)
            norm_overlap = min(overlap / n_terms, 1.0)
            vec = max(0.0, min(1.0, r.get("_vec_score", 0.0)))
            rrf = r.get("_rrf_score", 0.0)
            rrf_norm = min(rrf / (1.0 / 60.0), 1.0)

            score = 0.15 * rrf_norm + 0.35 * vec + 0.50 * norm_overlap

            if ql and len(ql) >= 4 and ql in combined_text:
                score += 0.40

            if entity_terms:
                entity_matches = sum(1 for et in entity_terms if et in combined_text)
                if entity_matches == len(entity_terms):
                    score += 0.35
                elif entity_matches > 0:
                    score += 0.15
                else:
                    score -= 0.40

            if type_boost and r.get("document_type") == type_boost:
                score += 0.15

            r["_combined"] = score

        # Apply Cross-Encoder ms-marco-MiniLM-L-6-v2 Reranking
        ce_model = _get_cross_encoder()
        if ce_model and results:
            try:
                top_candidates = results[:min(25, len(results))]
                pairs = [[query, c.get("chunk_text", "")] for c in top_candidates]
                ce_scores = ce_model.predict(pairs)
                for candidate, ce_score in zip(top_candidates, ce_scores):
                    norm_ce = float(1.0 / (1.0 + np.exp(-float(ce_score))))
                    candidate["_combined"] += 0.45 * norm_ce
            except Exception as e:
                pass

        results.sort(key=lambda x: -x["_combined"])
        return results[:top_n] if top_n else results

    def _fetch_neighbor_chunks(self, chunks: list[dict], org_id: str) -> list[dict]:
        """For each chunk, attach text of neighboring chunks (previous/next by chunk_index) for context."""
        if not chunks:
            return chunks
        from collections import defaultdict
        groups = defaultdict(list)
        for c in chunks:
            did = c["document_id"]
            ci = c.get("chunk_index")
            if ci is not None:
                groups[did].append((ci, c))
        neighbor_texts = defaultdict(list)
        for did, items in groups.items():
            items.sort(key=lambda x: x[0])
            indices = {ci: i for i, (ci, _) in enumerate(items)}
            try:
                result = SupabaseDB.select("document_chunks",
                    columns="chunk_index, content",
                    filters={"document_id": did, "organization_id": org_id},
                    limit=50,
                )
                all_chunks = getattr(result, "data", result if isinstance(result, list) else [])
                if isinstance(all_chunks, list):
                    chunk_map = {}
                    for rc in all_chunks:
                        if isinstance(rc, dict):
                            ci = rc.get("chunk_index")
                            if ci is not None:
                                chunk_map[ci] = rc.get("content", "")
                    for ci, _ in items:
                        prev_content = chunk_map.get(ci - 1, "")
                        next_content = chunk_map.get(ci + 1, "")
                        parts = []
                        if prev_content:
                            parts.append(f"[Previous section]: {prev_content[:800]}")
                        current_content = chunk_map.get(ci, "")
                        if current_content:
                            parts.append(current_content[:1200])
                        if next_content:
                            parts.append(f"[Next section]: {next_content[:800]}")
                        neighbor_texts[did + "::" + str(ci)].append("\n\n".join(parts))
            except Exception:
                pass
        for c in chunks:
            key = c["document_id"] + "::" + str(c.get("chunk_index", ""))
            if key in neighbor_texts and neighbor_texts[key]:
                nt = neighbor_texts[key][0]
                if nt and nt != c.get("chunk_text", ""):
                    c["chunk_text"] = nt
        return chunks

    def chunk_text(self, text: str, max_words: int = 250) -> list[dict]:
        if not text:
            return []

        if _looks_like_invoice(text):
            invoice_chunks = _invoice_aware_chunk(text, max_words=max(120, min(max_words, 180)))
            if invoice_chunks:
                return invoice_chunks

        chunks = _markdown_aware_chunk(text, max_words)
        if chunks:
            return chunks

        import re
        sentences = re.split(r'(?<=[.!?])\s+', text)
        sentences = [s.strip() for s in sentences if s.strip()]

        if len(sentences) <= 1:
            sentences = re.split(r'(?<=[,;:\u060C\u061F])\s+|\n+', text)
            sentences = [s.strip() for s in sentences if s.strip()]

        if len(sentences) <= 1 or len(sentences) >= 0.8 * len(text.split()):
            words = text.split()
            chunks = []
            chunk_id = 0
            for i in range(0, len(words), max_words):
                chunk_words = words[i:i + max_words]
                chunk_text = " ".join(chunk_words)
                chunks.append({
                    "content": chunk_text,
                    "chunk_id": hashlib.md5(chunk_text.encode()).hexdigest(),
                    "chunk_index": chunk_id,
                    "word_count": len(chunk_words),
                })
                chunk_id += 1
            return chunks

        chunks = []
        current_chunk = []
        current_word_count = 0
        chunk_id = 0

        for sentence in sentences:
            sentence_words = len(sentence.split())
            if current_word_count + sentence_words > max_words and current_chunk:
                chunk_text = " ".join(current_chunk)
                chunks.append({
                    "content": chunk_text,
                    "chunk_id": hashlib.md5(chunk_text.encode()).hexdigest(),
                    "chunk_index": chunk_id,
                    "word_count": current_word_count,
                })
                chunk_id += 1
                current_chunk = [sentence]
                current_word_count = sentence_words
            else:
                current_chunk.append(sentence)
                current_word_count += sentence_words

        if current_chunk:
            chunk_text = " ".join(current_chunk)
            chunks.append({
                "content": chunk_text,
                "chunk_id": hashlib.md5(chunk_text.encode()).hexdigest(),
                "chunk_index": chunk_id,
                "word_count": current_word_count,
            })

        return chunks

    def index_document(self, document_id: str, organization_id: str, text: str, file_path: str = None,
                       page_number: int = None, document_type: str = None, machine_id: str = None, filename: str = None,
                       phase3_agent: str = None):
        print(f"\n[INDEX] Indexing document {document_id[:12] if document_id else '?'}... ({len(text)} chars)")

        headings = []
        if file_path:
            try:
                headings = _detect_headings_from_file(file_path)
                if headings:
                    print(f"[INDEX] PyMuPDF detected {len(headings)} headings")
            except Exception as e:
                print(f"[INDEX] PyMuPDF heading detection failed: {e}")
        text_headings = _detect_headings_from_text(text)
        if text_headings:
            print(f"[INDEX] Text regex detected {len(text_headings)} heading patterns")
        headings = _merge_headings(text_headings, headings)

        if headings:
            chunks = _chunk_by_sections(text, headings)
            if chunks:
                print(f"[INDEX] Topic-wise chunking: {len(chunks)} chunks from {len(headings)} headings")
            else:
                chunks = self.chunk_text(text)
                print(f"[INDEX] Section building produced empty chunks, falling back to word-count chunking")
        else:
            chunks = self.chunk_text(text)
            print(f"[INDEX] No headings detected, using word-count chunking ({len(chunks)} chunks)")

        if not chunks:
            print(f"[INDEX] No chunks generated")
            return

        print(f"\n[INDEX-VERBOSE] === STEP BY STEP FULL CHUNK EXTRACTION ===")
        for i, chunk in enumerate(chunks):
            chunk_str = chunk if isinstance(chunk, str) else chunk.get("text", str(chunk))
            print(f"\n--- [Chunk {i+1}/{len(chunks)}] (Size: {len(chunk_str)} chars) ---")
            print(chunk_str)
            print("-" * 50)
        print(f"[INDEX-VERBOSE] =======================================\n")
        print(f"[INDEX] Generated {len(chunks)} chunks")

        # Build enriched chunk metadata for embedding + storage
        import re as _re
        chunk_metadata = []
        for c in chunks:
            heading = c.get("heading", "")
            sec_num = ""
            if heading:
                m = _re.match(r'^(\d+(?:\.\d+)*)', heading.strip())
                if m:
                    sec_num = m.group(1)
            chunk_page = _extract_page_from_content(c["content"], page_number)
            chunk_metadata.append({
                "heading": heading,
                "page_number": chunk_page,
                "document_type": document_type,
                "phase3_agent": phase3_agent,
                "section": c.get("chunk_type", ""),
                "section_number": sec_num,
                "machine_id": machine_id,
                "filename": filename or (file_path.split("\\")[-1] if file_path else ""),
            })

        embeddings = embedding_service.embed_chunks(
            [c["content"] for c in chunks],
            document_id=document_id,
            organization_id=organization_id,
            chunk_metadata=chunk_metadata,
        )
        print(f"[INDEX] Got {len(embeddings)} embeddings")

        try:
            chunk_records = []
            emb_records = []
            for chunk, embedding, cm in zip(chunks, embeddings, chunk_metadata):
                heading = chunk.get("heading")
                ctype = chunk.get("chunk_type", "paragraph")
                meta = {"chunk_index": chunk.get("chunk_index", 0), "word_count": chunk.get("word_count", 0)}
                if heading:
                    meta["heading"] = heading
                section = cm.get("section", "")
                section_number = cm.get("section_number", "")
                chunk_records.append({
                    "organization_id": organization_id,
                    "document_id": document_id,
                    "page_id": cm.get("page_number"),
                    "chunk_index": chunk.get("chunk_index", 0),
                    "chunk_type": ctype,
                    "heading": heading,
                    "section": section,
                    "section_number": section_number,
                    "machine_id": machine_id,
                    "filename": cm.get("filename", ""),
                    "content": chunk["content"],
                    "chunk_text": chunk["content"],
                    "metadata": meta,
                })
                emb_records.append({
                    "organization_id": organization_id,
                    "document_id": document_id,
                    "embedding": embedding,
                    "model_name": _embedding_model_name(),
                })
            # Insert chunks first to get their IDs for chunk_id in embeddings
            inserted = SupabaseDB.batch_insert("document_chunks", chunk_records)
            if inserted:
                for i, rec in enumerate(inserted):
                    rid = rec.get("id") if isinstance(rec, dict) else None
                    if rid is not None and i < len(emb_records):
                        emb_records[i]["chunk_id"] = rid
            SupabaseDB.batch_insert("document_embeddings", emb_records)
            print(f"[INDEX] Saved {len(chunk_records)} chunks + {len(emb_records)} embeddings to DB")
        except Exception as e:
            print(f"[INDEX] DB save FAILED: {e}")

    def index_image_content(self, markdown: str, document_id: str, organization_id: str, image_metadata: dict = None):
        if not markdown.strip():
            return

        meta = image_metadata or {}
        page_num = meta.get("page_number", 1)
        heading = f"Figure Page {page_num}"

        chunk_text = markdown.strip()
        chunk_id = hashlib.md5(chunk_text.encode()).hexdigest()

        embedding = embedding_service.embed_text(chunk_text)
        print(f"[IMAGE-INDEX] Embedded image {meta.get('image_id','?')}: dim={len(embedding)}")

        try:
            enriched_meta = {
                "chunk_index": 0,
                "word_count": len(chunk_text.split()),
                "heading": heading,
                "image_id": meta.get("image_id", ""),
                "image_path": meta.get("image_path", ""),
                "page_number": page_num,
                "image_index": meta.get("image_index", 0),
                "chunk_type": "image",
                "source": "vision_image",
            }
            chunk_rec = {
                "organization_id": organization_id,
                "document_id": document_id,
                "page_id": page_num,
                "chunk_index": 0,
                "chunk_type": "image",
                "heading": heading,
                "content": chunk_text,
                "chunk_text": chunk_text,
                "metadata": enriched_meta,
            }
            emb_rec = {
                "organization_id": organization_id,
                "document_id": document_id,
                "embedding": embedding,
                "model_name": _embedding_model_name(),
            }
            SupabaseDB.insert("document_chunks", chunk_rec)
            SupabaseDB.insert("document_embeddings", emb_rec)
            print(f"[IMAGE-INDEX] Saved image chunk + embedding to DB")

            # Also upsert to Pinecone
            if pinecone_service.available:
                vid = f"{document_id}_{chunk_id}"
                pinecone_service.upsert([(vid, embedding, {
                    "document_id": document_id,
                    "organization_id": organization_id,
                    "chunk_index": 0,
                    "chunk_type": "image",
                    "chunk_text": chunk_text[:1000],
                    "image_id": meta.get("image_id", ""),
                    "page_number": page_num,
                })], namespace=organization_id)
                print(f"[IMAGE-INDEX] Upserted to Pinecone")
        except Exception as e:
            print(f"[IMAGE-INDEX] DB save FAILED: {e}")

    def _resolve_doc_filters(self, organization_id: str, document_type: str = None,
                              phase3_agent: str = None, status: str = None,
                              date_from: str = None, date_to: str = None) -> list[str] | None:
        filters = {"organization_id": organization_id}
        if document_type:
            filters["document_type"] = document_type
        if phase3_agent:
            filters["phase3_agent"] = phase3_agent
        if status:
            filters["status"] = status

        if not any([document_type, phase3_agent, status, date_from, date_to]):
            return None

        try:
            from ..database import _local_select, _get_supabase, _use_supabase, SupabaseDB
            result = SupabaseDB.select("documents", columns="id", filters=filters, limit=10000)
            data = getattr(result, "data", result if isinstance(result, list) else [])
            ids = [r["id"] for r in data if isinstance(r, dict)]
            if not ids:
                return []

            if date_from or date_to:
                local_result = _local_select("documents", columns="id", filters={"organization_id": organization_id})
                local_data = getattr(local_result, "data", local_result if isinstance(local_result, list) else [])
                import re
                filtered = []
                for r in local_data:
                    if isinstance(r, dict):
                        created = r.get("created_at", "")
                        if created:
                            if date_from and created < date_from:
                                continue
                            if date_to and created > date_to + "T23:59:59":
                                continue
                            if r["id"] in ids:
                                filtered.append(r["id"])
                ids = filtered

            return ids
        except Exception:
            return None

    def _fetch_doc_cv_scores(self, doc_ids: list[str], org_id: str) -> dict[str, float]:
        scores = {}
        if not doc_ids:
            return scores
        try:
            import json
            unique_ids = list(set(doc_ids))
            from ..database import _get_supabase, _use_supabase, _local_select_in
            client = _get_supabase()
            if _use_supabase and client:
                r = client.table("document_extractions") \
                    .select("document_id, extracted_data") \
                    .in_("document_id", unique_ids) \
                    .eq("organization_id", org_id) \
                    .execute()
                rows = getattr(r, "data", [])
            else:
                rows = _local_select_in("document_extractions",
                    columns="document_id, extracted_data",
                    filters={"organization_id": org_id},
                    in_column="document_id", in_values=unique_ids)
            for row in rows:
                raw = row.get("extracted_data", "{}")
                if isinstance(raw, str):
                    parsed = json.loads(raw)
                else:
                    parsed = raw or {}
                if not isinstance(parsed, dict):
                    continue
                score = parsed.get("cv_score")
                if score is None:
                    ev = parsed.get("cv_evaluation") or {}
                    if isinstance(ev, dict):
                        score = ev.get("overall_score")
                if score is not None:
                    try:
                        scores[row["document_id"]] = float(score)
                    except (TypeError, ValueError):
                        pass
        except Exception:
            pass
        return scores

    def _fetch_doc_titles(self, doc_ids: list[str], org_id: str) -> dict:
        titles = {}
        if not doc_ids:
            return titles
        try:
            unique_ids = list(set(doc_ids))
            from ..database import _local_select_in, _get_supabase, _use_supabase
            client = _get_supabase()
            if _use_supabase and client:
                r = client.table("documents").select("id, title, document_type, phase3_agent").in_("id", unique_ids).eq("organization_id", org_id).execute()
                if getattr(r, "data", None):
                    for row in r.data:
                        titles[row["id"]] = (row.get("title", "") or "", row.get("document_type", "") or "", row.get("phase3_agent", "") or "")
            else:
                rows = _local_select_in("documents", columns="id, title, document_type, phase3_agent",
                                        filters={"organization_id": org_id}, in_column="id", in_values=unique_ids)
                for r in rows:
                    titles[r["id"]] = (r.get("title", "") or "", r.get("document_type", "") or "", r.get("phase3_agent", "") or "")
        except Exception:
            pass
        return titles

    def _fetch_chunks_by_ids(self, chunk_ids: list[str], organization_id: str) -> list[dict]:
        """Load chunk rows by primary key (fixes LIKE search missing rows due to arbitrary limit scans)."""
        if not chunk_ids or not organization_id:
            return []
        unique = list(dict.fromkeys(chunk_ids))[:200]
        try:
            from ..database import _get_supabase, _use_supabase, _local_select_in
            client = _get_supabase()
            if _use_supabase and client:
                r = client.table("document_chunks").select(
                    "id, document_id, organization_id, page_id, chunk_index, content, metadata"
                ).in_("id", unique).eq("organization_id", organization_id).execute()
                rows = getattr(r, "data", []) or []
            else:
                rows = _local_select_in(
                    "document_chunks",
                    columns="id, document_id, organization_id, page_id, chunk_index, content, metadata",
                    filters={"organization_id": organization_id},
                    in_column="id",
                    in_values=unique,
                )
            rows = [row for row in rows if isinstance(row, dict)]
            if rows:
                return rows
            if _use_supabase and client:
                r = client.table("document_chunks").select(
                    "id, document_id, organization_id, page_id, chunk_index, content, metadata"
                ).in_("id", unique).execute()
                rows = getattr(r, "data", []) or []
            else:
                rows = _local_select_in(
                    "document_chunks",
                    columns="id, document_id, organization_id, page_id, chunk_index, content, metadata",
                    in_column="id",
                    in_values=unique,
                )
            return [row for row in rows if isinstance(row, dict)]
        except Exception:
            return []

    def hybrid_search(self, query: str, organization_id: str, document_type: str = None,
                      phase3_agent: str = None, status: str = None,
                      date_from: str = None, date_to: str = None,
                      document_ids: list = None, limit: int = 20, offset: int = 0,
                      aggregate: bool = False, light: bool = False) -> list[dict]:
        from .orchestration_logger import get_chat_logger
        from .vector_org import resolve_vector_namespace

        chat_log = get_chat_logger()
        organization_id = resolve_vector_namespace(organization_id, document_ids)

        # When no explicit status filter is given, do NOT restrict to "processed" only.
        # This lets the search span ALL documents in the org (e.g. when no doc is selected).
        effective_status = status

        # When the user explicitly scoped documents in chat, trust that selection.
        # Metadata filters (invoice type, finance_agent) often disagree with Mongo/gateway labels
        # and would zero out scoped ids → empty RAG context.
        explicit_scope = document_ids is not None and len(document_ids) > 0
        if not explicit_scope:
            filter_doc_ids = self._resolve_doc_filters(
                organization_id=organization_id,
                document_type=document_type,
                phase3_agent=phase3_agent,
                status=effective_status,
                date_from=date_from,
                date_to=date_to,
            )
            if filter_doc_ids is not None:
                document_ids = filter_doc_ids
        else:
            print(f"[SEARCH] Using explicit document scope ({len(document_ids)} ids); skipping metadata doc-id filter")

        print(f"\n[SEARCH] Query: '{query}' | org={organization_id} | type={document_type or 'all'} | agent={phase3_agent or 'all'} | status={status or 'all'} | docs={len(document_ids) if document_ids else 'all'} | limit={limit}")
        query_embedding = embedding_service.embed_query(query)
        import re
        _drop_like = {
            "give", "me", "my", "the", "a", "an", "of", "for", "to", "in", "on", "at",
            "all", "get", "show", "list", "tell", "what", "which", "from", "with",
        }
        query_words = [
            w for w in re.sub(r"[^\w\s]", " ", query).lower().split()
            if len(w) >= 2 and w not in _drop_like
        ]

        scoped_docs = document_ids is not None and len(document_ids) > 0

        # ── Query expansion: skip slow LLM expansion when scoped or light retry ──
        alt_queries: list[str] = []
        if not light:
            if scoped_docs and len(document_ids) <= 50:
                alt_queries.extend(self._expand_finance_query(query))
                alt_queries.extend(self._expand_general_query(query))
            else:
                alt_queries = self._expand_query(query)
                alt_queries.extend(self._expand_finance_query(query))
                alt_queries.extend(self._expand_general_query(query))
        deduped_alt = []
        seen_alt = set()
        for aq in alt_queries:
            key = aq.strip().lower()
            if key and key not in seen_alt:
                seen_alt.add(key)
                deduped_alt.append(aq)
        max_alt = 0 if light else (1 if scoped_docs else 4)
        alt_queries = deduped_alt[:max_alt]
        alt_embeddings = []
        if not light and not scoped_docs:
            for aq in alt_queries:
                ae = embedding_service.embed_query(aq)
                alt_embeddings.append(ae)
        if light:
            all_embeddings = []
        elif scoped_docs:
            all_embeddings = [query_embedding]
        else:
            all_embeddings = [query_embedding] + alt_embeddings
        if alt_queries:
            chat_log.info(f"Query expansion: {len(alt_queries)} alternatives")

        # Build filter for Pinecone
        def _pinecone_filter():
            f = {"organization_id": organization_id}
            if scoped_docs:
                f["document_id"] = {"$in": document_ids}
                return f
            if document_type:
                f["document_type"] = document_type
            if phase3_agent:
                f["phase3_agent"] = phase3_agent
            if document_ids:
                f["document_id"] = {"$in": document_ids}
            return f if len(f) > 1 else None

        per_strategy = []  # list of lists for RRF fusion

        # ──── 1. Pinecone vector search (with query expansion) ────
        if all_embeddings:
            chat_log.search_strategy("Pinecone Vector Search", f"queries={len(all_embeddings)}, top_k={limit + 10}")
        pinecone_all = []
        pinecone_seen_ids = set()
        if all_embeddings and pinecone_service.available:
            pf = _pinecone_filter()
            # When searching ALL documents (no doc selected), scan many more chunks for recall
            pinecone_top_k = (limit * 4 + 20) if not document_ids else (limit + 10)
            if scoped_docs:
                pinecone_top_k = min(pinecone_top_k, 50)
            print(f"[SEARCH] Querying Pinecone (ns='{organization_id}') with {len(all_embeddings)} embeddings, top_k={pinecone_top_k}...")
            for ei, emb in enumerate(all_embeddings):
                tag = f"alt{ei}" if ei > 0 else "orig"
                pr = pinecone_service.query(emb, top_k=pinecone_top_k, filter=pf, namespace=organization_id)
                if pr:
                    print(f"[SEARCH] Pinecone [{tag}]: {len(pr)} results")
                    for r in pr:
                        pid = r.get("id", "")
                        if pid not in pinecone_seen_ids:
                            pinecone_seen_ids.add(pid)
                            pinecone_all.append(r)
            if pinecone_all:
                print(f"[SEARCH] Pinecone merged: {len(pinecone_all)} unique results")
                doc_ids = list(set(r["metadata"].get("document_id", "") for r in pinecone_all))
                title_map = self._fetch_doc_titles(doc_ids, organization_id)
                pinecone_res = []
                for r in pinecone_all:
                    meta = r.get("metadata", {})
                    did = meta.get("document_id", "")
                    title, dtype, p3a = title_map.get(did, ("", "", ""))
                    if document_type and dtype != document_type:
                        continue
                    ci = meta.get("chunk_index")
                    pinecone_res.append({
                        "document_id": did,
                        "document_title": title,
                        "document_type": dtype or meta.get("_document_type"),
                        "phase3_agent": p3a,
                        "chunk_text": meta.get("chunk_text", "")[:32000],
                        "page_number": meta.get("page_number"),
                        "heading": meta.get("heading"),
                        "section": meta.get("section"),
                        "section_number": meta.get("section_number"),
                        "machine_id": meta.get("machine_id"),
                        "filename": meta.get("filename"),
                        "chunk_index": ci,
                        "score": r.get("score", 0),
                        "metadata": meta,
                    })
                per_strategy.append(pinecone_res)
                chat_log.search_result("Pinecone", len(pinecone_all), len(pinecone_res), f"from {len(all_embeddings)} queries")
                print(f"[SEARCH] Pinecone results: {len(pinecone_res)} after dedup")
            else:
                chat_log.search_result("Pinecone", 0, 0, "no results")
                print(f"[SEARCH] Pinecone returned no results")
        else:
            if not all_embeddings:
                chat_log.search_result("Pinecone", 0, 0, "skipped (light/scoped)")
            else:
                chat_log.search_result("Pinecone", 0, 0, "unavailable")

        # ──── 2. FTS5 keyword search ────
        chat_log.search_strategy("FTS5 Keyword Search", f"words: {len(query_words)}")
        print(f"[SEARCH] Running keyword search (FTS5)...")
        try:
            from ..database import _local_keyword_search
            kw_results = _local_keyword_search(query, organization_id, limit=limit * 2)
            fts5_res = []
            if kw_results:
                print(f"[SEARCH] FTS5 returned {len(kw_results)} results")
                doc_ids = list(set(r["document_id"] for r in kw_results))
                title_map = self._fetch_doc_titles(doc_ids, organization_id)
                for item in kw_results:
                    did = item.get("document_id", "")
                    title, dtype, p3a = title_map.get(did, ("", "", ""))
                    if document_type and dtype != document_type:
                        continue
                    fts5_res.append({
                        "document_id": did,
                        "document_title": title,
                        "document_type": dtype,
                        "phase3_agent": p3a,
                        "chunk_text": item.get("content", "")[:3000],
                        "page_number": item.get("page_id"),
                        "heading": item.get("heading"),
                        "section": item.get("section"),
                        "section_number": item.get("section_number"),
                        "machine_id": item.get("machine_id"),
                        "filename": item.get("filename"),
                        "chunk_index": item.get("chunk_index"),
                        "score": 0.9,
                        "metadata": item.get("metadata"),
                    })
                chat_log.search_result("FTS5", len(kw_results), len(fts5_res))
                print(f"[SEARCH] FTS5 contributed {len(fts5_res)} results")
            else:
                chat_log.search_result("FTS5", 0, 0, "no results")
            per_strategy.append(fts5_res)
        except Exception as e:
            chat_log.search_result("FTS5", 0, 0, f"error: {e}")
            per_strategy.append([])

        # ──── 3. Per-word LIKE search ────
        chat_log.search_strategy("Per-word LIKE Search (typo-tolerant)", f"{len(query_words)} words: {query_words[:5]}")
        like_res = []
        try:
            like_rows: dict[str, dict] = {}
            for word in query_words:
                wr = SupabaseDB.select(
                    "document_chunks",
                    columns="id, document_id, organization_id, page_id, chunk_index, content, metadata",
                    filters={"organization_id": organization_id},
                    like={"content": word},
                    limit=limit,
                )
                wdata = getattr(wr, "data", wr if isinstance(wr, list) else [])
                if isinstance(wdata, list):
                    for item in wdata:
                        if isinstance(item, dict) and item.get("id"):
                            like_rows[item["id"]] = item
            if not like_rows:
                chat_log.search_result("LIKE", 0, 0, "no matches")
            else:
                ldata = list(like_rows.values())
                if len(ldata) < len(like_rows):
                    missing = [cid for cid in like_rows if cid not in {r.get("id") for r in ldata}]
                    if missing:
                        extra = self._fetch_chunks_by_ids(missing, organization_id)
                        by_id = {r.get("id"): r for r in ldata}
                        for row in extra:
                            if row.get("id"):
                                by_id[row["id"]] = row
                        ldata = list(by_id.values())
                doc_ids = list(set(r.get("document_id", "") for r in ldata if r.get("document_id")))
                title_map = self._fetch_doc_titles(doc_ids, organization_id)
                for item in ldata:
                    did = item.get("document_id", "")
                    title, dtype, p3a = title_map.get(did, ("", "", ""))
                    if document_type and dtype != document_type:
                        continue
                    like_res.append({
                        "document_id": did,
                        "document_title": title,
                        "document_type": dtype,
                        "phase3_agent": p3a,
                        "chunk_text": item.get("content", "")[:32000],
                        "page_number": item.get("page_id"),
                        "heading": item.get("heading"),
                        "section": item.get("section"),
                        "section_number": item.get("section_number"),
                        "machine_id": item.get("machine_id"),
                        "filename": item.get("filename"),
                        "chunk_index": item.get("chunk_index"),
                        "score": 0.7,
                        "metadata": item.get("metadata"),
                    })
                chat_log.search_result("LIKE", len(like_rows), len(like_res))
        except Exception as e:
            chat_log.search_result("LIKE", 0, 0, f"error: {e}")
        per_strategy.append(like_res)

        # ──── 4. Supabase vector search ────
        sqs_res = []
        if not light:
            chat_log.search_strategy("Supabase Vector Search", f"threshold=0.2, top_k={limit * 2}")
            try:
                vector_results = SupabaseDB.search_vector(
                    "document_chunks",
                    query_embedding,
                    match_threshold=0.2,
                    match_count=limit * 2,
                    filter_org_id=organization_id,
                )
                vector_count = len(getattr(vector_results, "data", vector_results if isinstance(vector_results, list) else []))
            except Exception:
                vector_results = {"data": []}
                vector_count = 0
            vec_doc_ids = list(set(chunk.get("document_id", "") for chunk in (getattr(vector_results, "data", vector_results if isinstance(vector_results, list) else []) if isinstance(vector_results, (list, dict)) else [])))
            vec_title_map = self._fetch_doc_titles(vec_doc_ids, organization_id) if vec_doc_ids else {}
            for item in getattr(vector_results, "data", vector_results if isinstance(vector_results, list) else []):
                chunk = item if isinstance(item, dict) else {}
                did = chunk.get("document_id", "")
                title, dtype, p3a = vec_title_map.get(did, ("", "", ""))
                if document_type and dtype != document_type:
                    continue
                sqs_res.append({
                    "document_id": did,
                    "document_title": title or chunk.get("document_title", ""),
                    "document_type": dtype or chunk.get("document_type"),
                    "phase3_agent": p3a,
                    "chunk_text": chunk.get("content", chunk.get("chunk_text", "")),
                    "page_number": chunk.get("page_number", chunk.get("page_id")),
                    "heading": chunk.get("heading"),
                    "section": chunk.get("section"),
                    "section_number": chunk.get("section_number"),
                    "machine_id": chunk.get("machine_id"),
                    "filename": chunk.get("filename"),
                    "chunk_index": chunk.get("chunk_index"),
                    "score": chunk.get("similarity", chunk.get("score", 0)),
                    "metadata": chunk.get("metadata"),
                })
            chat_log.search_result("Supabase Vector", vector_count, len(sqs_res))
        else:
            chat_log.search_result("Supabase Vector", 0, 0, "skipped (light)")
        per_strategy.append(sqs_res)

        # ──── RRF Fusion ────
        filtered_strategies = [s for s in per_strategy if s]
        if filtered_strategies:
            results = self._rrf_fuse(filtered_strategies, k=60)
        else:
            results = []
        chat_log.info(f"RRF fused {len(filtered_strategies)} strategies → {len(results)} unique chunks")

        # ── Lightweight rerank (RRF + vector similarity + keyword overlap) ──
        if results:
            results = self._rerank(results, query, limit * 2)

        # Attach cv_score to resume search results
        cv_doc_ids = list(set(r["document_id"] for r in results if r.get("document_type") == "resume"))
        cv_scores = self._fetch_doc_cv_scores(cv_doc_ids, organization_id) if cv_doc_ids else {}
        for r in results:
            r["cv_score"] = cv_scores.get(r["document_id"])

        if document_ids:
            doc_set = set(document_ids)
            results = [r for r in results if r["document_id"] in doc_set]

        # Neighbor chunks for context
        results = self._fetch_neighbor_chunks(results[:limit * 2], organization_id)

        # Diversity cap: avoid one document dominating the context while ensuring multiple relevant docs are represented.
        MAX_PER_DOC = 10 if aggregate else 6
        if document_ids is None:
            capped = []
            per_doc = {}
            for r in results:
                did = r.get("document_id", "")
                if per_doc.get(did, 0) >= MAX_PER_DOC:
                    continue
                per_doc[did] = per_doc.get(did, 0) + 1
                capped.append(r)
            results = capped

        # ── Enrich missing page numbers from chunk content ──
        for r in results:
            if r.get("page_number") is None:
                pn = _extract_page_from_content(r.get("chunk_text", ""))
                if pn:
                    r["page_number"] = pn

        final = results[offset:offset + limit]
        chat_log.info(f"Total after RRF+filter: {len(final)} chunks (from {len(results)} unique)")
        top_scores = [f"{r['document_title'][:30]}: {r['score']:.3f}" for r in final[:3]]
        if top_scores:
            chat_log.info(f"Top results: {', '.join(top_scores)}")
        return final

    def get_document_context(self, document_id: str, organization_id: str, max_chunks: int = 10) -> str:
        try:
            result = SupabaseDB.select(
                "document_chunks",
                columns="content, page_id",
                filters={"document_id": document_id, "organization_id": organization_id},
            )
            chunks = getattr(result, "data", result if isinstance(result, list) else [])
            texts = []
            for c in chunks[:max_chunks]:
                if isinstance(c, dict):
                    page = c.get("page_id", "")
                    content = c.get("content", "")
                    if page:
                        texts.append(f"[Page {page}]: {content}")
                    else:
                        texts.append(content)
            return "\n\n".join(texts)
        except Exception:
            return ""


    def _get_first_embedding(self, document_id: str, organization_id: str) -> list[float] | None:
        try:
            result = SupabaseDB.select("document_embeddings", filters={"document_id": document_id, "organization_id": organization_id})
            data = getattr(result, "data", [])
            if isinstance(data, list) and data:
                emb = data[0].get("embedding") if isinstance(data[0], dict) else None
                if isinstance(emb, str):
                    import ast
                    emb = ast.literal_eval(emb)
                if emb:
                    return emb
        except Exception:
            pass
        return None

    def find_similar(self, document_id: str, organization_id: str, limit: int = 5) -> list[dict]:
        from .vector_org import resolve_vector_namespace

        organization_id = resolve_vector_namespace(organization_id, [document_id])
        try:
            emb = self._get_first_embedding(document_id, organization_id)
            if emb is None:
                return []

            seen_ids = set()
            results = []

            if pinecone_service.available:
                filter_dict = {"organization_id": organization_id}
                pinecone_results = pinecone_service.query(emb, top_k=limit + 5, filter=filter_dict, namespace=organization_id)
                title_map = {}
                if pinecone_results:
                    doc_ids = list(set(r["metadata"].get("document_id", "") for r in pinecone_results))
                    title_map = self._fetch_doc_titles(doc_ids, organization_id)
                for r in pinecone_results:
                    meta = r.get("metadata", {})
                    did = meta.get("document_id", "")
                    if did == document_id or did in seen_ids:
                        continue
                    seen_ids.add(did)
                    title, dtype = title_map.get(did, ("", ""))
                    results.append({
                        "document_id": did,
                        "document_title": title,
                        "document_type": dtype,
                        "chunk_text": meta.get("chunk_text", "")[:500],
                        "page_number": meta.get("page_number"),
                        "score": r.get("score", 0),
                        "metadata": meta,
                    })
                    if len(results) >= limit:
                        break

            if not results:
                similar = SupabaseDB.search_vector("document_chunks", emb, match_threshold=0.6, match_count=limit * 2, filter_org_id=organization_id)
                items = getattr(similar, "data", similar if isinstance(similar, list) else [])
                for item in items:
                    if isinstance(item, dict):
                        d_id = item.get("document_id", "")
                        if d_id == document_id or d_id in seen_ids:
                            continue
                        seen_ids.add(d_id)
                        results.append({
                            "document_id": d_id,
                            "document_title": item.get("document_title", item.get("content", "")[:50]),
                            "document_type": item.get("document_type"),
                            "chunk_text": item.get("content", item.get("chunk_text", "")),
                            "page_number": item.get("page_number", item.get("page_id")),
                            "score": item.get("similarity", item.get("score", 0)),
                            "metadata": item.get("metadata"),
                        })
                        if len(results) >= limit:
                            break
            return results
        except Exception as e:
            import logging
            logging.getLogger("visibility-docs").error(f"find_similar error: {e}")
            return []

    def _list_org_document_ids(self, organization_id: str, limit: int = 150,
                                document_type: str = None,
                                phase3_agent: str = None) -> list[str]:
        """List document IDs for an organization, up to ``limit``."""
        try:
            filters = {"organization_id": organization_id}
            if document_type:
                filters["document_type"] = document_type
            if phase3_agent:
                filters["phase3_agent"] = phase3_agent
            result = SupabaseDB.select("documents",
                columns="id",
                filters=filters,
            )
            data = getattr(result, "data", result if isinstance(result, list) else [])
            if isinstance(data, list):
                return [row["id"] for row in data[:limit] if isinstance(row, dict) and row.get("id")]
            return []
        except Exception:
            return []

    def _fetch_any_chunks(self, document_ids: list[str], org_id: str, limit_per_doc: int = 1) -> list[dict]:
        """Fast fallback: grab the first chunk(s) from each doc via direct DB query,
        with proper document titles."""
        if not document_ids:
            return []
        # Batch-fetch document titles
        title_map = self._fetch_doc_titles(document_ids, org_id)
        results = []
        try:
            for did in document_ids:
                rows = SupabaseDB.select(
                    "document_chunks",
                    columns="id, document_id, content, chunk_index, page_id",
                    filters={"document_id": did, "organization_id": org_id},
                    limit=limit_per_doc,
                )
                data = getattr(rows, "data", rows if isinstance(rows, list) else [])
                if not isinstance(data, list) or not data:
                    rows = SupabaseDB.select(
                        "document_chunks",
                        columns="id, document_id, content, chunk_index, page_id",
                        filters={"document_id": did},
                        limit=limit_per_doc,
                    )
                    data = getattr(rows, "data", rows if isinstance(rows, list) else [])
                if isinstance(data, list):
                    for row in data[:limit_per_doc]:
                        if isinstance(row, dict):
                            raw_title, dtype, _ = title_map.get(did, ("", "", ""))
                            title = raw_title or did  # fallback to ID only if title is truly empty
                            results.append({
                                "document_id": row.get("document_id", did),
                                "document_title": title,
                                "document_type": dtype,
                                "chunk_text": row.get("content", ""),
                                "page_number": row.get("page_id", ""),
                                "score": 0.0,
                            })
        except Exception:
            pass
        return results

    def aggregate_search(self, query: str, organization_id: str,
                         document_ids: list = None,
                         max_docs: int = 150) -> list[dict]:
        """
        Fast cross-document search that guarantees every document contributes
        at least 1 chunk.  Uses a single broad search + lazy fallback (no
        per-doc loops), so it's fast even for 100+ documents.
        """
        from .orchestration_logger import get_chat_logger
        chat_log = get_chat_logger()

        target_ids = document_ids or self._list_org_document_ids(organization_id, limit=max_docs)
        if not target_ids:
            return []
        chat_log.info(f"Aggregate search targeting {len(target_ids)} docs")

        # Phase 1 – single broad search
        broad_limit = min(len(target_ids) * 6, 300)  # cap at 300 for speed
        broad_results = self.hybrid_search(
            query=query,
            organization_id=organization_id,
            document_ids=target_ids,
            limit=broad_limit,
            aggregate=True,
        )

        # Phase 2 – per-doc guarantee: keep best chunks per doc (up to 8)
        best_per_doc = {}
        for r in broad_results:
            did = r["document_id"]
            if did not in best_per_doc:
                best_per_doc[did] = []
            if len(best_per_doc[did]) < 8:
                best_per_doc[did].append(r)

        # Phase 3 – omitted (no lazy fallback of empty chunks)
        
        # Phase 4 – merge and fetch neighbors
        merged = []
        for did, chunks in best_per_doc.items():
            merged.extend(chunks)
            
        if merged:
            merged = self._rerank(merged, query, len(merged))
            
        merged = self._fetch_neighbor_chunks(merged, organization_id)
        chat_log.info(f"Aggregate final: {len(merged)} chunks across {len(set(r['document_id'] for r in merged))} docs")
        return merged


rag_service = RAGService()
