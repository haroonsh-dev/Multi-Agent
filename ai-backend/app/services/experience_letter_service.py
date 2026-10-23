"""Generate experience / employment certificate PDF from resume extractions + HR fields."""
from __future__ import annotations

import html as html_module
import re
from datetime import date
from io import BytesIO
from typing import Any

import pymupdf as fitz

from .offer_letter_service import (
    merge_resume_extraction,
    prefill_from_resume,
    safe_filename,
    _parse_iso_date,
)


def prefill_experience_from_resume(extractions: list[dict]) -> dict[str, Any]:
    base = prefill_from_resume(extractions)
    data = merge_resume_extraction(extractions)
    summary = (
        data.get("evaluation_summary")
        or data.get("professional_summary")
        or data.get("summary")
        or ""
    )
    if isinstance(summary, str):
        summary = summary.strip()[:600]
    return {
        **base,
        "duties_summary": summary or None,
    }


def validate_experience_dates(payload: dict[str, Any]) -> list[str]:
    errors: list[str] = []
    letter_d = _parse_iso_date(payload.get("letter_date"))
    from_d = _parse_iso_date(payload.get("employment_from"))
    to_d = _parse_iso_date(payload.get("employment_to"))
    today = date.today()
    if letter_d and letter_d > today:
        errors.append("Letter date cannot be in the future.")
    if from_d and to_d and to_d < from_d:
        errors.append("Employment end date must be on or after the start date.")
    return errors


def _normalize_experience(
    payload: dict[str, Any], resume_hint: dict[str, Any] | None
) -> dict[str, str]:
    resume_hint = resume_hint or {}
    employee = (
        payload.get("employee_name")
        or payload.get("candidate_name")
        or resume_hint.get("candidate_name")
        or "Employee"
    ).strip()
    return {
        "employee": employee,
        "company": (payload.get("company_name") or "Company").strip(),
        "company_address": (payload.get("company_address") or "").strip(),
        "job_title": (
            payload.get("job_title")
            or resume_hint.get("job_title")
            or "Employee"
        ).strip(),
        "department": (payload.get("department") or "").strip(),
        "cnic": (payload.get("cnic") or resume_hint.get("cnic") or "").strip(),
        "employment_from": (payload.get("employment_from") or "").strip(),
        "employment_to": (payload.get("employment_to") or "").strip(),
        "duties": (payload.get("duties_summary") or resume_hint.get("duties_summary") or "").strip(),
        "reason": (payload.get("reason_for_leaving") or "").strip(),
        "letter_date": (payload.get("letter_date") or date.today().isoformat()).strip(),
        "signatory_name": (payload.get("signatory_name") or "Human Resources").strip(),
        "signatory_title": (payload.get("signatory_title") or "Authorized Signatory").strip(),
    }


def build_experience_letter_html(
    payload: dict[str, Any], resume_hint: dict[str, Any] | None = None
) -> str:
    f = _normalize_experience(payload, resume_hint)
    esc = html_module.escape

    addr_block = ""
    if f["company_address"]:
        addr_block = f'<p style="margin:2px 0 0;font-size:8.5pt;color:#475569;">{esc(f["company_address"])}</p>'

    period = "the period stated below"
    if f["employment_from"] and f["employment_to"]:
        period = f'{esc(f["employment_from"])} to {esc(f["employment_to"])}'
    elif f["employment_from"]:
        period = f'from {esc(f["employment_from"])} to date'

    dept_part = f" ({esc(f['department'])})" if f["department"] else ""
    cnic_line = f'<p style="margin:0 0 6px;font-size:9pt;"><b>CNIC:</b> {esc(f["cnic"])}</p>' if f["cnic"] else ""

    duties_block = ""
    if f["duties"]:
        duties_block = (
            f'<p style="margin:8px 0;text-align:justify;font-size:9pt;">'
            f"During this tenure, {esc(f['employee'])} performed duties including: {esc(f['duties'])}</p>"
        )

    reason_block = ""
    if f["reason"]:
        reason_block = (
            f'<p style="margin:6px 0;text-align:justify;font-size:9pt;">'
            f"<b>Reason for separation:</b> {esc(f['reason'])}</p>"
        )

    return f"""<!DOCTYPE html>
<html><head><meta charset="utf-8"/></head>
<body style="font-family:Helvetica,Arial,sans-serif;font-size:9.5pt;line-height:1.38;color:#0f172a;margin:0;">
  <div style="text-align:center;margin-bottom:10px;border-bottom:2px solid #1e3a5f;padding-bottom:8px;">
    <div style="font-size:14pt;font-weight:bold;color:#1e3a5f;">{esc(f['company'])}</div>
    {addr_block}
    <div style="font-size:10pt;font-weight:600;margin-top:6px;">EXPERIENCE CERTIFICATE</div>
  </div>
  <p style="margin:0 0 6px;"><b>Date:</b> {esc(f['letter_date'])}</p>
  <p style="margin:0 0 8px;text-align:justify;">
    This is to certify that <b>{esc(f['employee'])}</b> was employed with <b>{esc(f['company'])}</b>
    as <b>{esc(f['job_title'])}</b>{dept_part} for the period <b>{period}</b>.
  </p>
  {cnic_line}
  <p style="margin:0 0 6px;text-align:justify;font-size:9pt;">
    {esc(f['employee'])} served the organization with diligence and professionalism. We found {esc('their')}
    conduct and performance satisfactory during employment.
  </p>
  {duties_block}
  {reason_block}
  <p style="margin:10px 0 8px;text-align:justify;font-size:9pt;">
    We wish {esc(f['employee'])} success in future endeavours. This certificate is issued upon request for
    whatever legal purpose it may serve.
  </p>
  <p style="margin:0 0 20px;">Yours sincerely,</p>
  <p style="margin:0 0 2px;font-weight:700;">{esc(f['signatory_name'])}</p>
  <p style="margin:0;font-size:9pt;">{esc(f['signatory_title'])} · {esc(f['company'])}</p>
</body></html>"""


def experience_safe_filename(employee: str, ext: str = "pdf") -> str:
    base = re.sub(r"[^\w\s-]", "", employee or "Employee").strip().replace(" ", "_")
    if not base:
        base = "Employee"
    return f"Experience_Letter_{base[:48]}.{ext.lstrip('.') or 'pdf'}"


def generate_experience_letter_pdf(
    payload: dict[str, Any], resume_hint: dict[str, Any] | None = None
) -> bytes:
    errors = validate_experience_dates(payload)
    if errors:
        raise ValueError("; ".join(errors))
    html = build_experience_letter_html(payload, resume_hint)
    mediabox = fitz.paper_rect("a4")
    where = mediabox + (42, 42, -42, -42)
    buf = BytesIO()
    writer = fitz.DocumentWriter(buf)
    story = fitz.Story(
        html=html,
        user_css="body { font-family: Helvetica, Arial, sans-serif; font-size: 9.5pt; }",
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
