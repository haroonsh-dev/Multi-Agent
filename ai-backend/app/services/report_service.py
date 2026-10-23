import json
import logging
from io import BytesIO
from datetime import datetime
from ..database import SupabaseDB
import pymupdf as fitz

logger = logging.getLogger("visibility-docs")

KEY_FIELDS_MAP = {
    "invoice": ["document_title", "document_number", "vendor_name", "customer_name", "invoice_number", "invoice_date", "due_date", "currency", "subtotal", "tax_amount", "tax_rate", "discount", "shipping_charges", "total_amount", "payment_terms", "bank_details", "approval_status", "accounting_codes", "notes"],
    "financial_statement": ["document_title", "document_number", "vendor_name", "total_amount", "currency", "accounting_codes", "notes"],
    "purchase_order": ["document_title", "po_number", "vendor_name", "buyer_name", "order_date", "delivery_date", "currency", "total_amount", "incoterms", "payment_terms", "shipping_terms", "requested_by", "approved_by", "approval_status", "notes"],
    "quotation": ["document_title", "quote_number", "vendor_name", "buyer_name", "order_date", "delivery_date", "currency", "total_amount", "incoterms", "payment_terms", "notes"],
    "contract": ["document_title", "party_a", "party_b", "contract_number", "effective_date", "expiry_date", "renewal_terms", "payment_terms", "governing_law", "jurisdiction", "signature_required", "obligations", "clauses", "termination_notice", "risk_flags", "notes"],
    "hr_document": ["document_title", "employee_name", "employee_id", "department", "designation", "manager_name", "issue_date", "effective_date", "end_date", "salary", "leave_type", "leave_duration", "policy_name", "training_name", "appraisal_period", "status", "key_terms", "notes"],
    "resume": ["document_title", "employee_name", "designation", "department", "key_terms", "notes"],
    "transcript": ["document_title", "employee_name", "training_name", "issue_date", "status", "notes"],
    "certificate": ["document_title", "certificate_number", "issue_date", "expiry_date", "standard_or_regulation", "compliance_status", "findings", "observations", "notes"],
    "audit_report": ["document_title", "report_number", "audit_date", "compliance_status", "findings", "deviations", "corrective_actions", "observations", "recommendations", "notes"],
    "quality_report": ["document_title", "report_number", "compliance_status", "findings", "observations", "recommendations", "notes"],
    "maintenance_report": ["document_title", "equipment_or_asset_id", "findings", "observations", "recommendations", "notes"],
    "sop": ["document_title", "standard_or_regulation", "responsible_person", "effective_date", "findings", "notes"],
    "engineering_drawing": ["document_title", "document_number", "equipment_or_asset_id", "notes"],
    "other": ["document_title", "document_date", "author_or_sender", "recipient", "subject", "summary", "key_points", "action_items", "deadlines", "references", "department", "priority", "notes"],
}


def _fmt_val(v) -> str:
    if v is None:
        return "—"
    if isinstance(v, list):
        parts = []
        for item in v[:5]:
            if isinstance(item, dict):
                parts.append("; ".join(f"{k}: {v}" for k, v in item.items() if v is not None)[:150])
            else:
                parts.append(str(item)[:150])
        return "<br>".join(parts) if parts else "—"
    if isinstance(v, dict):
        parts = [f"{k}: {v}" for k, v in v.items() if v is not None]
        return "<br>".join(parts[:6]) if parts else "—"
    return str(v)[:200]


def _build_line_items_table(extracted: dict) -> str:
    items = extracted.get("line_items")
    if not items or not isinstance(items, list):
        return ""
    rows = []
    for item in items[:20]:
        if isinstance(item, dict):
            desc = item.get("description") or ""
            qty = item.get("qty") or ""
            rate = item.get("rate") or ""
            amount = item.get("amount") or ""
            rows.append(f"<tr><td style='padding:4px 8px;border-bottom:1px solid #f1f5f9;font-size:12px;'>{desc}</td><td style='padding:4px 8px;border-bottom:1px solid #f1f5f9;font-size:12px;'>{qty}</td><td style='padding:4px 8px;border-bottom:1px solid #f1f5f9;font-size:12px;'>{rate}</td><td style='padding:4px 8px;border-bottom:1px solid #f1f5f9;font-size:12px;'>{amount}</td></tr>")
    if not rows:
        return ""
    return f"""<table style="width:100%;border-collapse:collapse;margin-top:6px;background:#f8fafc;border-radius:6px;">
    <thead><tr style="background:#e2e8f0;"><th style="padding:4px 8px;font-size:11px;text-align:left;">Description</th><th style="padding:4px 8px;font-size:11px;text-align:left;">Qty</th><th style="padding:4px 8px;font-size:11px;text-align:left;">Rate</th><th style="padding:4px 8px;font-size:11px;text-align:left;">Amount</th></tr></thead>
    <tbody>{"".join(rows)}</tbody></table>"""


def _build_detail_card(d: dict, extracted: dict, confidence: float, idx: int) -> str:
    dt = d.get("document_type", "unknown") or "unknown"
    title = d.get("title", "?")
    status = d.get("status", "?")
    agent = d.get("phase3_agent", "unassigned") or "unassigned"
    pages = d.get("page_count") or "—"
    file_size = d.get("file_size") or "—"
    lang = d.get("language") or "—"
    created = d.get("created_at", "")[:10] if d.get("created_at") else "—"

    all_fields = []
    if extracted:
        wanted = KEY_FIELDS_MAP.get(dt, ["document_title", "document_date", "author_or_sender", "subject", "summary", "key_points", "action_items", "deadlines", "references", "department", "priority", "notes"])
        for fname in wanted:
            val = extracted.get(fname)
            if val is not None and val != "" and val != 0 and val != [] and val != {}:
                fv = _fmt_val(val)
                if fv != "—":
                    all_fields.append(f"""<tr><td style="padding:6px 10px;border-bottom:1px solid #f1f5f9;font-size:12px;font-weight:500;color:#475569;white-space:nowrap;width:160px;">{fname.replace('_', ' ').title()}</td><td style="padding:6px 10px;border-bottom:1px solid #f1f5f9;font-size:12px;">{fv}</td></tr>""")
        if not all_fields:
            for k, v in extracted.items():
                fv = _fmt_val(v)
                if fv != "—":
                    all_fields.append(f"""<tr><td style="padding:6px 10px;border-bottom:1px solid #f1f5f9;font-size:12px;font-weight:500;color:#475569;white-space:nowrap;width:160px;">{k.replace('_', ' ').title()}</td><td style="padding:6px 10px;border-bottom:1px solid #f1f5f9;font-size:12px;">{fv}</td></tr>""")

    line_items_table = _build_line_items_table(extracted)

    raw_text = d.get("raw_text", "") or ""
    text_preview = ""
    if raw_text:
        cleaned = raw_text.strip()[:400]
        text_preview = f"""<details style="margin-top:10px;"><summary style="cursor:pointer;font-size:12px;font-weight:600;color:#64748b;">📝 Raw Text Preview</summary><pre style="background:#f8fafc;padding:12px;border-radius:6px;font-size:11px;line-height:1.5;max-height:150px;overflow-y:auto;margin-top:6px;white-space:pre-wrap;word-break:break-word;">{cleaned}</pre></details>"""

    return f"""<div class="doc-card" id="doc-{idx}">
    <div class="doc-header">
        <span class="doc-num">#{idx}</span>
        <h3 style="margin:0;font-size:15px;flex:1;">{title}</h3>
        <span class="badge">{dt}</span>
        <span class="badge badge-agent">{agent}</span>
        <span class="badge badge-status-{status if status in ('processed','failed','processing') else 'other'}">{status}</span>
    </div>
    <table class="meta-table">
        <tr><td>Pages</td><td>{pages}</td><td>Size</td><td>{file_size}</td><td>Language</td><td>{lang}</td><td>Created</td><td>{created}</td><td>Confidence</td><td>{f"{confidence:.0%}" if confidence else "—"}</td></tr>
    </table>
    {line_items_table if line_items_table else ""}
    {"<table class='fields-table'><tbody>" + "".join(all_fields) + "</tbody></table>" if all_fields else "<p style='color:#94a3b8;font-size:13px;padding:10px;'>No extracted data available.</p>"}
    {text_preview}
</div>"""


def generate_report(organization_id: str, phase3_agent: str = "") -> tuple[str, str]:
    filters = {"organization_id": organization_id}
    if phase3_agent:
        filters["phase3_agent"] = phase3_agent

    docs = SupabaseDB.select("documents", filters=filters, limit=1000)
    docs_data = getattr(docs, "data", docs if isinstance(docs, list) else [])
    if not isinstance(docs_data, list):
        docs_data = []

    total = len(docs_data)
    by_type: dict[str, int] = {}
    by_status: dict[str, int] = {}
    by_agent: dict[str, int] = {}
    table_rows: list[str] = []
    detail_cards: list[str] = []

    total_pages = 0
    total_bytes = 0

    for idx, d in enumerate(docs_data, 1):
        dt = d.get("document_type", "unknown") or "unknown"
        st = d.get("status", "unknown") or "unknown"
        ag = d.get("phase3_agent", "unassigned") or "unassigned"
        by_type[dt] = by_type.get(dt, 0) + 1
        by_status[st] = by_status.get(st, 0) + 1
        by_agent[ag] = by_agent.get(ag, 0) + 1
        total_pages += d.get("page_count", 0) or 0
        total_bytes += d.get("file_size", 0) or 0

        meta_result = SupabaseDB.select("documents_metadata", filters={"document_id": d["id"], "organization_id": organization_id}, limit=1)
        meta_data = getattr(meta_result, "data", meta_result if isinstance(meta_result, list) else [])
        extracted = {}
        confidence = 0
        if isinstance(meta_data, list) and meta_data:
            m = meta_data[0]
            try:
                extracted = json.loads(m.get("extracted_data", "{}")) if isinstance(m.get("extracted_data"), str) else m.get("extracted_data", {})
            except Exception:
                extracted = {}
            confidence = m.get("overall_confidence", 0) or 0

        key_fields = []
        if extracted:
            wanted = KEY_FIELDS_MAP.get(dt, ["document_title", "document_date", "author_or_sender", "subject", "summary", "key_points", "action_items", "deadlines", "references", "department", "priority", "notes"])
            for fname in wanted:
                val = extracted.get(fname)
                if val is not None and val != "" and val != 0 and val != [] and val != {}:
                    fv = _fmt_val(val)
                    if fv != "—":
                        key_fields.append(f"<b>{fname.replace('_', ' ').title()}:</b> {fv}")
            if not key_fields:
                for k, v in extracted.items():
                    fv = _fmt_val(v)
                    if fv != "—":
                        key_fields.append(f"<b>{k.replace('_', ' ').title()}:</b> {fv}")
                        if len(key_fields) >= 6:
                            break

        table_rows.append(f"""<tr>
            <td style="padding:8px;border-bottom:1px solid #e2e8f0;font-size:13px;"><a href="#doc-{idx}" style="color:#667eea;text-decoration:none;">{d.get("title","?")}</a></td>
            <td style="padding:8px;border-bottom:1px solid #e2e8f0;font-size:13px;"><span class="badge">{dt}</span></td>
            <td style="padding:8px;border-bottom:1px solid #e2e8f0;font-size:13px;"><span class="badge badge-agent">{ag}</span></td>
            <td style="padding:8px;border-bottom:1px solid #e2e8f0;font-size:13px;">{st}</td>
            <td style="padding:8px;border-bottom:1px solid #e2e8f0;font-size:12px;max-width:350px;">{'<br>'.join(key_fields[:5]) if key_fields else '—'}</td>
            <td style="padding:8px;border-bottom:1px solid #e2e8f0;font-size:13px;">{f"{confidence:.0%}" if confidence else "—"}</td>
        </tr>""")

        detail_cards.append(_build_detail_card(d, extracted, confidence, idx))

    type_summary_lines = "".join(f"<tr><td style='padding:8px 12px;border-bottom:1px solid #f1f5f9;font-size:13px;'>{k}</td><td style='padding:8px 12px;border-bottom:1px solid #f1f5f9;font-size:13px;font-weight:600;'>{v}</td></tr>" for k, v in sorted(by_type.items()))
    agent_summary_lines = "".join(f"<tr><td style='padding:8px 12px;border-bottom:1px solid #f1f5f9;font-size:13px;'>{k}</td><td style='padding:8px 12px;border-bottom:1px solid #f1f5f9;font-size:13px;font-weight:600;'>{v}</td></tr>" for k, v in sorted(by_agent.items()))
    status_summary_lines = "".join(f"<tr><td style='padding:8px 12px;border-bottom:1px solid #f1f5f9;font-size:13px;'>{k}</td><td style='padding:8px 12px;border-bottom:1px solid #f1f5f9;font-size:13px;font-weight:600;'>{v}</td></tr>" for k, v in sorted(by_status.items()))

    filter_label = f" (Filter: {phase3_agent})" if phase3_agent else " (All Agents)"
    now_str = datetime.utcnow().strftime("%B %d, %Y at %H:%M UTC")

    def _fmt_size(b):
        if not b: return "—"
        for unit in ("B", "KB", "MB", "GB"):
            if b < 1024: return f"{b:.1f} {unit}"
            b /= 1024
        return f"{b:.1f} TB"

    html = f"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>
* {{ margin:0; padding:0; box-sizing:border-box; }}
body {{ font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #f1f5f9; color: #1e293b; line-height:1.5; }}
.container {{ max-width: 960px; margin: 0 auto; padding: 32px 16px; }}
.header {{ background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); border-radius: 16px; padding: 32px; color: white; margin-bottom: 24px; }}
.header h1 {{ margin: 0 0 6px; font-size: 26px; }}
.header p {{ margin: 0; opacity: 0.85; font-size: 13px; }}
.header .org {{ font-size:15px; opacity:0.9; margin-top:4px; }}
.summary-grid {{ display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 12px; margin-bottom: 24px; }}
.card {{ background: white; border-radius: 12px; padding: 18px; box-shadow: 0 1px 3px rgba(0,0,0,0.06); text-align:center; }}
.card .num {{ font-size: 30px; font-weight: 700; color: #667eea; }}
.card .label {{ font-size: 11px; color: #94a3b8; text-transform: uppercase; letter-spacing: 0.8px; margin-top:4px; }}
.section {{ background: white; border-radius: 12px; padding: 20px; margin-bottom: 16px; box-shadow: 0 1px 3px rgba(0,0,0,0.06); }}
.section h2 {{ margin: 0 0 14px; font-size: 16px; color: #334155; display:flex; align-items:center; gap:8px; }}
.split {{ display:grid; grid-template-columns:1fr 1fr; gap:16px; margin-bottom:16px; }}
@media (max-width:600px) {{ .split {{ grid-template-columns:1fr; }} }}
.mini-table {{ width:100%; border-collapse:collapse; }}
.mini-table th {{ text-align:left; padding:8px 12px; font-size:11px; text-transform:uppercase; letter-spacing:0.5px; color:#94a3b8; border-bottom:2px solid #e2e8f0; }}
.mini-table td {{ padding:8px 12px; border-bottom:1px solid #f1f5f9; font-size:13px; }}
.main-table {{ width:100%; border-collapse:collapse; }}
.main-table th {{ text-align:left; padding:10px 8px; font-size:11px; text-transform:uppercase; letter-spacing:0.5px; color:#94a3b8; border-bottom:2px solid #e2e8f0; background:#f8fafc; position:sticky; top:0; }}
.badge {{ display:inline-block; padding:2px 8px; border-radius:999px; font-size:11px; font-weight:500; background:#e2e8f0; color:#475569; }}
.badge-agent {{ background:#ede9fe; color:#7c3aed; }}
.badge-status-processed {{ background:#dcfce7; color:#166534; }}
.badge-status-failed {{ background:#fee2e2; color:#991b1b; }}
.badge-status-processing {{ background:#fef9c3; color:#854d0e; }}
.badge-status-other {{ background:#f1f5f9; color:#475569; }}
.doc-card {{ background:white; border-radius:12px; margin-bottom:16px; box-shadow:0 1px 4px rgba(0,0,0,0.06); overflow:hidden; }}
.doc-header {{ display:flex; align-items:center; gap:10px; padding:14px 16px; background:#f8fafc; border-bottom:1px solid #e2e8f0; }}
.doc-num {{ display:inline-flex; align-items:center; justify-content:center; width:28px; height:28px; border-radius:50%; background:#667eea; color:white; font-size:13px; font-weight:600; }}
.meta-table {{ width:100%; border-collapse:collapse; }}
.meta-table td {{ padding:6px 12px; font-size:11px; color:#64748b; border-bottom:1px solid #f8fafc; }}
.meta-table td:nth-child(odd) {{ font-weight:600; color:#475569; width:65px; }}
.fields-table {{ width:100%; border-collapse:collapse; }}
.fields-table td {{ vertical-align:top; }}
.footer {{ text-align: center; font-size: 12px; color: #94a3b8; padding: 24px 0; border-top:1px solid #e2e8f0; margin-top:16px; }}
</style>
</head>
<body>
<div class="container">

    <div class="header">
        <h1>Visibility Docs AI — Comprehensive Report</h1>
        <p class="org">Organization: {organization_id}{filter_label}</p>
        <p>Generated: {now_str}</p>
    </div>

    <div class="summary-grid">
        <div class="card"><div class="num">{total}</div><div class="label">Total Docs</div></div>
        <div class="card"><div class="num">{total_pages}</div><div class="label">Total Pages</div></div>
        <div class="card"><div class="num">{_fmt_size(total_bytes)}</div><div class="label">Total Size</div></div>
        <div class="card"><div class="num">{len(by_type)}</div><div class="label">Doc Types</div></div>
        <div class="card"><div class="num">{sum(1 for d in docs_data if d.get("status") == "processed")}</div><div class="label">Processed</div></div>
        <div class="card"><div class="num">{sum(1 for d in docs_data if d.get("status") == "failed")}</div><div class="label">Failed</div></div>
    </div>

    <div class="split">
        <div class="section">
            <h2>📁 By Type</h2>
            {"<table class='mini-table'><thead><tr><th>Type</th><th>Count</th></tr></thead><tbody>" + type_summary_lines + "</tbody></table>" if type_summary_lines else "<p style='font-size:13px;color:#94a3b8;'>No documents</p>"}
        </div>
        <div class="section">
            <h2>🤖 By Agent</h2>
            {"<table class='mini-table'><thead><tr><th>Agent</th><th>Count</th></tr></thead><tbody>" + agent_summary_lines + "</tbody></table>" if agent_summary_lines else "<p style='font-size:13px;color:#94a3b8;'>No documents</p>"}
        </div>
    </div>

    <div class="section">
        <h2>📋 Status Overview</h2>
        {"<table class='mini-table' style='max-width:400px;'><thead><tr><th>Status</th><th>Count</th></tr></thead><tbody>" + status_summary_lines + "</tbody></table>" if status_summary_lines else "<p style='font-size:13px;color:#94a3b8;'>No documents</p>"}
    </div>

    <div class="section">
        <h2>📄 Document Summary Table</h2>
        {"<div style='overflow-x:auto;'><table class='main-table'><thead><tr><th>Title</th><th>Type</th><th>Agent</th><th>Status</th><th>Key Details</th><th>Confidence</th></tr></thead><tbody>" + "".join(table_rows) + "</tbody></table></div>" if table_rows else "<p style='font-size:13px;color:#94a3b8;'>No documents found.</p>"}
    </div>

    <div class="section">
        <h2>🔍 Detailed Document Analysis</h2>
        {"".join(detail_cards) if detail_cards else "<p style='font-size:13px;color:#94a3b8;'>No documents found.</p>"}
    </div>

    <div class="footer">
        Visibility Docs AI &mdash; Automated Report &mdash; {now_str}
    </div>
</div>
</body>
</html>"""

    agent_label = f" [{phase3_agent}]" if phase3_agent else ""
    subject = f"Visibility Docs AI Comprehensive Report — {organization_id}{agent_label}"

    return html, subject


def generate_pdf_from_html(html: str) -> bytes:
    """
    Render HTML into a print-ready PDF using PyMuPDF.

    Keep styling/layout fairly simple to avoid unsupported HTML constructs.
    """
    if not html or not isinstance(html, str):
        raise ValueError("html is required")

    mediabox = fitz.paper_rect("a4")
    where = mediabox + (42, 42, -42, -42)

    buf = BytesIO()
    writer = fitz.DocumentWriter(buf)
    story = fitz.Story(
        html=html,
        user_css="body { font-family: Helvetica, Arial, sans-serif; font-size: 9.5pt; line-height: 1.35; }",
    )

    while True:
        device = writer.begin_page(mediabox)
        more, _ = story.place(where)
        story.draw(device)
        writer.end_page()
        if not more:
            break

    writer.close()
    return buf.getvalue()
