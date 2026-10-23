"""Resume vs academic transcript disambiguation for classification."""
from __future__ import annotations

import re

_RESUME_FILENAME = re.compile(
    r"\b(cv|cvs|resume|résumé|curriculum[\s_-]?vitae|biodata|bio[\s_-]?data)\b",
    re.IGNORECASE,
)

_STRONG_RESUME = (
    "work experience",
    "professional experience",
    "employment history",
    "professional summary",
    "career objective",
    "career summary",
    "key skills",
    "technical skills",
    "core competencies",
    "curriculum vitae",
    "linkedin",
    "github",
    "portfolio",
    "references available",
    "professional references",
    "years of experience",
    "job responsibilities",
    "achievements",
    "projects",
)

_STRONG_TRANSCRIPT = (
    "official transcript",
    "academic transcript",
    "transcript of records",
    "grade point average",
    "cumulative gpa",
    "cgpa",
    "sgpa",
    "semester result",
    "semester-wise",
    "marksheet",
    "marks sheet",
    "result card",
    "controller of examinations",
    "registrar",
    "roll no",
    "roll number",
    "registration no",
    "course code",
    "course title",
    "credits earned",
    "credit hours",
    "grade report",
    "transcript issued",
)

_WEAK_TRANSCRIPT = (
    "gpa",
    "grade",
    "semester",
    "course",
    "examination",
    "credits",
)


def filename_suggests_resume(filename: str) -> bool:
    return bool(_RESUME_FILENAME.search(filename or ""))


def score_resume_vs_transcript(text: str, filename: str = "") -> tuple[int, int]:
    hay = f"{filename}\n{text}".lower()
    resume_score = 0
    transcript_score = 0

    if filename_suggests_resume(filename):
        resume_score += 10

    for marker in _STRONG_RESUME:
        if marker in hay:
            resume_score += 3

    for marker in _STRONG_TRANSCRIPT:
        if marker in hay:
            transcript_score += 4

    weak_hits = sum(1 for marker in _WEAK_TRANSCRIPT if marker in hay)
    if weak_hits >= 4 and not filename_suggests_resume(filename):
        transcript_score += weak_hits

    # CVs list education; don't treat "university" alone as transcript
    if "work experience" in hay or "employment" in hay or "skills" in hay:
        resume_score += 4

    return resume_score, transcript_score


def reconcile_resume_transcript_classification(
    result: dict,
    text: str,
    filename: str = "",
) -> dict:
    """Correct common LLM/heuristic confusion between CV and academic transcript / invoice."""
    if not result:
        return result

    doc_type = str(result.get("document_type", "")).lower().replace(" ", "_")
    if doc_type == "cv":
        result["document_type"] = "resume"
        result["agent_type"] = "hr_agent"
        doc_type = "resume"

    # Filename wins for clear CV/resume names (stops OCR junk → false "invoice")
    if filename_suggests_resume(filename) and doc_type not in ("resume",):
        result["document_type"] = "resume"
        result["agent_type"] = "hr_agent"
        result["reasoning"] = (
            f"{result.get('reasoning', '')} [Adjusted: filename indicates CV/resume, not {doc_type or 'other'}.]"
        ).strip()
        doc_type = "resume"

    if doc_type not in ("resume", "transcript"):
        return result

    resume_score, transcript_score = score_resume_vs_transcript(text, filename)

    if filename_suggests_resume(filename):
        if transcript_score < resume_score + 2:
            result["document_type"] = "resume"
            result["agent_type"] = "hr_agent"
            if transcript_score > 0 and resume_score <= transcript_score:
                result["reasoning"] = (
                    f"{result.get('reasoning', '')} [Adjusted: filename indicates CV/resume.]"
                ).strip()
            return result

    if doc_type == "transcript" and resume_score >= transcript_score + 2:
        result["document_type"] = "resume"
        result["agent_type"] = "hr_agent"
        result["reasoning"] = (
            f"{result.get('reasoning', '')} [Adjusted: hiring CV signals outweigh transcript keywords.]"
        ).strip()
    elif doc_type == "resume" and transcript_score >= resume_score + 5:
        result["document_type"] = "transcript"
        result["agent_type"] = "hr_agent"

    return result
