import logging
import base64
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from ..auth_deps import get_current_user
from ..services.report_service import generate_report, generate_pdf_from_html
from ..services.email_service import send_email

logger = logging.getLogger("visibility-docs")

router = APIRouter(prefix="/api/v1/reports", tags=["reports"])


class GenerateReportRequest(BaseModel):
    organization_id: str = Field(..., min_length=1)
    phase3_agent: str = ""


@router.post("/generate", summary="Generate extraction report HTML (for gateway / scheduled email)")
async def generate_report_html(body: GenerateReportRequest):
    html, subject = generate_report(body.organization_id, body.phase3_agent or "")
    return {
        "subject": subject,
        "html": html,
        "organization_id": body.organization_id,
        "phase3_agent": body.phase3_agent or None,
    }


class GenerateComplianceReportPdfRequest(BaseModel):
    html: str = Field(..., min_length=1, max_length=2_000_000)
    filename: str = Field(default="Compliance_Report.pdf")


@router.post("/compliance/pdf", summary="Generate a compliance report PDF (base64)")
async def generate_compliance_report_pdf(body: GenerateComplianceReportPdfRequest):
    pdf_bytes = generate_pdf_from_html(body.html)
    safe_name = body.filename.strip() or "Compliance_Report.pdf"

    return {
        "filename": safe_name,
        "mime_type": "application/pdf",
        "pdf_base64": base64.b64encode(pdf_bytes).decode("ascii"),
        "size_bytes": len(pdf_bytes),
    }


@router.post("/email", summary="Generate and email report of all documents")
async def email_report(
    organization_id: str,
    phase3_agent: str = "",
    current_user: dict = Depends(get_current_user),
):
    user_email = current_user.get("email", "")
    if not user_email:
        raise HTTPException(status_code=400, detail="User email not found in token")

    html, subject = generate_report(organization_id, phase3_agent)

    sent = send_email(user_email, subject, html)
    if not sent:
        raise HTTPException(status_code=500, detail="Failed to send email — check SMTP configuration")

    return {
        "message": "Report sent successfully",
        "sent_to": user_email,
        "subject": subject,
        "organization_id": organization_id,
        "phase3_agent": phase3_agent or None,
    }
