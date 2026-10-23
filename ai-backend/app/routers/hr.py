"""HR workflows: offer letter generation from resume extractions."""
from __future__ import annotations

import base64
import logging

from fastapi import APIRouter, HTTPException, status
from pydantic import BaseModel, Field

from ..database import SupabaseDB
from ..services.experience_letter_service import (
    experience_safe_filename,
    generate_experience_letter_pdf,
    prefill_experience_from_resume,
    validate_experience_dates,
)
from ..services.offer_letter_service import (
    generate_offer_letter_pdf,
    prefill_from_resume,
    safe_filename,
    validate_offer_dates,
)

logger = logging.getLogger("visibility-docs")

router = APIRouter(prefix="/api/v1/hr", tags=["hr"])


class OfferLetterPayload(BaseModel):
    candidate_name: str | None = None
    company_name: str = Field(default="Company", min_length=1)
    company_address: str | None = None
    job_title: str | None = None
    department: str | None = None
    work_location: str | None = None
    cnic: str | None = None
    offered_salary: float | int | str | None = None
    currency: str = "PKR"
    pay_frequency: str = "Monthly"
    joining_date: str | None = None
    offer_valid_until: str | None = None
    probation_period: str | None = "3 months"
    notice_period: str | None = "30 days"
    letter_date: str | None = None
    signatory_name: str | None = None
    signatory_title: str | None = None
    additional_notes: str | None = None
    include_background: bool = False


class GenerateOfferLetterRequest(BaseModel):
    organization_id: str = Field(..., min_length=1)
    offer: OfferLetterPayload


class ExperienceLetterPayload(BaseModel):
    employee_name: str | None = None
    company_name: str = Field(default="Company", min_length=1)
    company_address: str | None = None
    job_title: str | None = None
    department: str | None = None
    cnic: str | None = None
    employment_from: str | None = None
    employment_to: str | None = None
    duties_summary: str | None = None
    reason_for_leaving: str | None = None
    letter_date: str | None = None
    signatory_name: str | None = None
    signatory_title: str | None = None


class GenerateExperienceLetterRequest(BaseModel):
    organization_id: str = Field(..., min_length=1)
    experience: ExperienceLetterPayload


def _load_extractions(document_id: str, organization_id: str) -> list[dict]:
    filters: dict = {"document_id": document_id}
    if organization_id:
        filters["organization_id"] = organization_id
    result = SupabaseDB.select("document_extractions", filters=filters)
    data = getattr(result, "data", result if isinstance(result, list) else [])
    if not isinstance(data, list):
        return []
    return [row for row in data if isinstance(row, dict)]


@router.get(
    "/documents/{document_id}/offer-letter/prefill",
    summary="Prefill offer letter fields from resume extractions",
)
async def offer_letter_prefill(document_id: str, organization_id: str = ""):
    if not organization_id:
        raise HTTPException(status_code=400, detail="organization_id is required")
    extractions = _load_extractions(document_id, organization_id)
    prefill = prefill_from_resume(extractions)
    return {"prefill": prefill, "extraction_count": len(extractions)}


@router.post(
    "/documents/{document_id}/offer-letter/generate",
    summary="Generate offer letter PDF (base64, print-ready)",
)
async def offer_letter_generate(document_id: str, body: GenerateOfferLetterRequest):
    extractions = _load_extractions(document_id, body.organization_id)
    resume_hint = prefill_from_resume(extractions)
    offer = body.offer.model_dump()
    if not offer.get("candidate_name") and resume_hint.get("candidate_name"):
        offer["candidate_name"] = resume_hint["candidate_name"]
    if not offer.get("job_title") and resume_hint.get("job_title"):
        offer["job_title"] = resume_hint["job_title"]
    if not offer.get("cnic") and resume_hint.get("cnic"):
        offer["cnic"] = resume_hint["cnic"]

    date_errors = validate_offer_dates(offer)
    if date_errors:
        raise HTTPException(status_code=400, detail="; ".join(date_errors))

    try:
        pdf_bytes = generate_offer_letter_pdf(offer, resume_hint)
    except Exception as exc:
        logger.error("offer letter pdf failed: %s", exc)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to generate offer letter: {exc}",
        ) from exc

    candidate = offer.get("candidate_name") or resume_hint.get("candidate_name") or "Candidate"
    return {
        "filename": safe_filename(str(candidate), "pdf"),
        "mime_type": "application/pdf",
        "pdf_base64": base64.b64encode(pdf_bytes).decode("ascii"),
        "size_bytes": len(pdf_bytes),
    }


@router.get(
    "/documents/{document_id}/experience-letter/prefill",
    summary="Prefill experience letter fields from resume extractions",
)
async def experience_letter_prefill(document_id: str, organization_id: str = ""):
    if not organization_id:
        raise HTTPException(status_code=400, detail="organization_id is required")
    extractions = _load_extractions(document_id, organization_id)
    prefill = prefill_experience_from_resume(extractions)
    return {"prefill": prefill, "extraction_count": len(extractions)}


@router.post(
    "/documents/{document_id}/experience-letter/generate",
    summary="Generate experience certificate PDF (base64, print-ready)",
)
async def experience_letter_generate(document_id: str, body: GenerateExperienceLetterRequest):
    extractions = _load_extractions(document_id, body.organization_id)
    resume_hint = prefill_experience_from_resume(extractions)
    exp = body.experience.model_dump()
    if not exp.get("employee_name") and resume_hint.get("candidate_name"):
        exp["employee_name"] = resume_hint["candidate_name"]
    if not exp.get("job_title") and resume_hint.get("job_title"):
        exp["job_title"] = resume_hint["job_title"]
    if not exp.get("cnic") and resume_hint.get("cnic"):
        exp["cnic"] = resume_hint["cnic"]
    if not exp.get("duties_summary") and resume_hint.get("duties_summary"):
        exp["duties_summary"] = resume_hint["duties_summary"]

    date_errors = validate_experience_dates(exp)
    if date_errors:
        raise HTTPException(status_code=400, detail="; ".join(date_errors))

    try:
        pdf_bytes = generate_experience_letter_pdf(exp, resume_hint)
    except Exception as exc:
        logger.error("experience letter pdf failed: %s", exc)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to generate experience letter: {exc}",
        ) from exc

    employee = exp.get("employee_name") or resume_hint.get("candidate_name") or "Employee"
    return {
        "filename": experience_safe_filename(str(employee), "pdf"),
        "mime_type": "application/pdf",
        "pdf_base64": base64.b64encode(pdf_bytes).decode("ascii"),
        "size_bytes": len(pdf_bytes),
    }
