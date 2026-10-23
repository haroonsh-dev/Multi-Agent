import os
import asyncio
import traceback
import logging
from uuid import uuid4
from fastapi import APIRouter, UploadFile, File, Form, HTTPException, Body, Request, status, Depends
from fastapi.responses import FileResponse, RedirectResponse
from pydantic import BaseModel, Field
from ..config import settings
from ..database import SupabaseDB
from ..models.schemas import UploadResponse, DocumentListResponse, ProcessResponse, ExtractionListResponse
from ..services.document_service import document_service
from ..auth_deps import get_internal_or_user
from ..services import agent_registry
from ..utils.file_utils import (
    save_upload_file,
    is_allowed_file,
    file_info_from_local_path,
    resolve_shared_storage_root,
)

logger = logging.getLogger("visibility-docs")

router = APIRouter(prefix="/api/v1/documents", tags=["documents"])


def _enforce_tool(
    tool_name: str,
    principal: dict,
    organization_id: str,
    agent_id: str = "",
    input_payload: dict | None = None,
):
    """Run the policy gate for a real mutation. Returns the evaluation.

    Raises HTTPException(403) when PolicyDenied (Tier-3 without override) and
    HTTPException(503) when the tool is blocked outright (unknown to the
    registry, or the invocation could not be recorded to the audit trail).
    """
    try:
        return agent_registry.enforce_tool_policy(
            tool_name=tool_name,
            organization_id=organization_id,
            principal=principal,
            agent_id=agent_id,
            input_payload=input_payload,
        )
    except agent_registry.PolicyDenied as pd:
        evaluation = pd.evaluation or {}
        if evaluation.get("decision") == "blocked":
            raise HTTPException(
                status_code=503,
                detail={
                    "error": "tool_blocked",
                    "tool": tool_name,
                    "reason": evaluation.get(
                        "reason", "Tool call blocked — risk could not be assessed or audited."
                    ),
                },
            )
        raise HTTPException(
            status_code=403,
            detail={
                "error": "approval_required",
                "tool": tool_name,
                "reason": evaluation.get("reason", "Tier 3 tool requires approval"),
            },
        )


class ClassifyTextRequest(BaseModel):
    text: str = Field(..., min_length=1, description="Document text to classify")
    filename: str = Field("", description="Original filename")


@router.post(
    "/upload",
    response_model=UploadResponse,
    status_code=status.HTTP_201_CREATED,
    summary="Upload a document",
    description="Upload PDF, image, DOCX, XLSX, or PPTX file for processing",
)
async def upload_document(
    organization_id: str = Form(..., description="Tenant organization ID"),
    title: str = Form(None, description="Optional document title"),
    local_file_path: str = Form(None, description="Absolute path under shared-storage (Node.js upload)"),
    phase3_agent: str = Form(None, description="Optional extraction agent"),
    allowed_agents: str = Form(None, description="Comma-separated agents allowed by org plan"),
    uploaded_by: str = Form(None, description="Uploader user id (for per-user duplicate scope)"),
    file: UploadFile = File(None, description="Document file (PDF, images, DOCX, XLSX, PPTX)"),
):
    print("\n" + "="*70)
    print(f"[UPLOAD] org={organization_id} local_path={local_file_path or '-'} file={getattr(file, 'filename', None)}")
    print(f"[UPLOAD] shared-storage root: {resolve_shared_storage_root()}")
    print("="*70)

    doc_title = title or (file.filename if file and file.filename else None)
    file_info = None

    if local_file_path and local_file_path.strip():
        source_name = (file.filename if file and file.filename else None) or os.path.basename(local_file_path)
        if not is_allowed_file(source_name):
            raise HTTPException(
                status_code=400,
                detail=f"File type not supported: {source_name}. Allowed: PDF, JPG, PNG, TIFF, BMP, WEBP, DOCX, XLSX, PPTX, TXT",
            )
        doc_title = doc_title or source_name
        try:
            file_info = file_info_from_local_path(local_file_path.strip(), organization_id, source_name)
            print(f"[UPLOAD] Using shared file: {file_info.get('file_path')} (hash: {file_info.get('file_hash', '?')[:16]}...)")
        except (FileNotFoundError, ValueError) as e:
            if file and file.filename:
                logger.warning(
                    f"[UPLOAD] Shared storage path '{local_file_path}' not accessible in this container ({e}). "
                    f"Falling back to HTTP stream upload."
                )
                try:
                    await file.seek(0)
                    file_info = await save_upload_file(file, organization_id)
                    print(f"[UPLOAD] Fallback file saved: {file_info.get('file_path', '?')} (hash: {file_info.get('file_hash', '?')[:16]}...)")
                except Exception as save_err:
                    logger.error(f"Failed to save fallback upload file: {save_err}\n{traceback.format_exc()}")
                    raise HTTPException(status_code=500, detail=f"Failed to save fallback file: {str(save_err)}")
            else:
                status_code = 404 if isinstance(e, FileNotFoundError) else 400
                raise HTTPException(status_code=status_code, detail=str(e))
        except Exception as e:
            if file and file.filename:
                logger.warning(
                    f"[UPLOAD] Error reading shared storage file '{local_file_path}' ({e}). "
                    f"Falling back to HTTP stream upload."
                )
                try:
                    await file.seek(0)
                    file_info = await save_upload_file(file, organization_id)
                    print(f"[UPLOAD] Fallback file saved: {file_info.get('file_path', '?')} (hash: {file_info.get('file_hash', '?')[:16]}...)")
                except Exception as save_err:
                    logger.error(f"Failed to save fallback upload file: {save_err}\n{traceback.format_exc()}")
                    raise HTTPException(status_code=500, detail=f"Failed to save fallback file: {str(save_err)}")
            else:
                logger.error(f"Failed to read shared file: {e}\n{traceback.format_exc()}")
                raise HTTPException(status_code=500, detail=f"Failed to read shared file: {str(e)}")
    elif file and file.filename:
        if not is_allowed_file(file.filename):
            print(f"[UPLOAD] REJECTED - unsupported type: {file.filename}")
            raise HTTPException(
                status_code=400,
                detail=f"File type not supported: {file.filename}. Allowed: PDF, JPG, PNG, TIFF, BMP, WEBP, DOCX, XLSX, PPTX, TXT",
            )
        doc_title = doc_title or file.filename
        try:
            file_info = await save_upload_file(file, organization_id)
            print(f"[UPLOAD] File saved: {file_info.get('file_path', '?')} (hash: {file_info.get('file_hash', '?')[:16]}...)")
        except Exception as e:
            logger.error(f"Failed to save upload file: {e}\n{traceback.format_exc()}")
            raise HTTPException(status_code=500, detail=f"Failed to save file: {str(e)}")
    else:
        raise HTTPException(status_code=400, detail="Provide either file upload or local_file_path under shared-storage")

    # Duplicate detection by file hash (per user within org when uploaded_by is set)
    file_hash = file_info.get("file_hash", "")
    uploader = (uploaded_by or "").strip()
    if file_hash:
        dup_filters = {"organization_id": organization_id, "file_hash": file_hash}
        if uploader:
            dup_filters["uploaded_by"] = uploader
        existing = SupabaseDB.select("documents", filters=dup_filters)
        existing_data = getattr(existing, "data", existing if isinstance(existing, list) else [])
        if isinstance(existing_data, list) and existing_data:
            dup = existing_data[0] if isinstance(existing_data[0], dict) else {}
            old_file = dup.get("original_file_url", "")
            if old_file and not os.path.exists(old_file):
                print(f"[UPLOAD] Old file missing on disk - deleting stale record and allowing re-upload")
                SupabaseDB.delete_document_cascade(dup.get("id", ""))
            else:
                print(f"[UPLOAD] DUPLICATE DETECTED - already uploaded as '{dup.get('title', 'unknown')}'")
                raise HTTPException(
                    status_code=409,
                    detail=f"Duplicate file detected. Already uploaded as '{dup.get('title', 'unknown')}' (status: {dup.get('status', '?')})",
                )

    try:
        doc = await document_service.create_document(
            organization_id=organization_id,
            title=doc_title,
            file_info=file_info,
            uploaded_by=uploader or None,
            phase3_agent=(phase3_agent or "").strip() or None,
            allowed_agents=(allowed_agents or "").strip() or None,
        )
        print(f"[UPLOAD] Document record created: ID={doc.get('id', '?')}")
    except Exception as e:
        logger.error(f"Failed to create document record: {e}\n{traceback.format_exc()}")
        raise HTTPException(status_code=500, detail=f"Failed to create document record: {str(e)}")

    doc_id = doc.get("id", uuid4().hex) if isinstance(doc, dict) else str(doc) if doc else ""

    # Auto-start pipeline in background
    try:
        print(f"[UPLOAD] Auto-starting pipeline for document: {doc_id}")
        asyncio.ensure_future(document_service.process_document(doc_id, organization_id))
    except Exception as e:
        logger.warning(f"Failed to auto-start pipeline: {e}")

    return UploadResponse(
        id=doc_id,
        title=doc_title,
        status="processing",
        message="Document uploaded and processing started.",
    )


@router.post(
    "/{document_id}/classify",
    summary="Classify document (OCR + Groq)",
    description="Run OCR and Groq classification. Returns type suggestion for user confirmation.",
)
async def classify_document(document_id: str, request: Request):
    org_id = request.query_params.get("organization_id")
    if not org_id:
        try:
            body = await request.json()
            org_id = body.get("organization_id") if isinstance(body, dict) else None
        except Exception:
            pass
    if not org_id:
        raise HTTPException(status_code=400, detail="organization_id is required")

    from ..services.orchestrator_service import orchestrator
    loop = asyncio.get_event_loop()
    result = await loop.run_in_executor(None, orchestrator.classify_only, document_id, org_id)
    if "error" in result:
        raise HTTPException(status_code=500, detail=result["error"])
    return result


@router.get(
    "/{document_id}/file",
    summary="Download/serve uploaded file",
    description="Returns the original uploaded file for viewing or download",
)
async def get_document_file(document_id: str, organization_id: str = ""):
    doc = document_service.get_document(document_id, organization_id)
    if not doc:
        raise HTTPException(status_code=404, detail="Document not found")
    file_path = doc.get("original_file_url", "")
    if not file_path:
        raise HTTPException(status_code=404, detail="File not found")
    if file_path.startswith("http"):
        return RedirectResponse(url=file_path)
    if os.path.isfile(file_path):
        return FileResponse(file_path, filename=os.path.basename(file_path))
    supabase_url = f"{settings.SUPABASE_URL}/storage/v1/object/public/documents/{file_path}"
    return RedirectResponse(url=supabase_url)


@router.post(
    "/{document_id}/reprocess",
    summary="Re-run full document pipeline (background)",
    description="Reset and re-run OCR, classification, extraction, and indexing in the background",
)
async def reprocess_document(
    document_id: str,
    organization_id: str = "",
    principal: dict = Depends(get_internal_or_user),
):
    _enforce_tool(
        "documents.reprocess",
        principal,
        organization_id,
        input_payload={"document_id": document_id},
    )
    org_id = organization_id
    if not org_id:
        existing = document_service.get_document(document_id, "")
        org_id = (existing or {}).get("organization_id", "")
    if not org_id:
        raise HTTPException(status_code=400, detail="organization_id is required")

    from ..database import SupabaseDB
    SupabaseDB.update(
        "documents",
        {"status": "processing", "error_message": None},
        "id",
        document_id,
    )
    # Reset job so polling sees a fresh run (old "completed" jobs blocked UI updates)
    try:
        SupabaseDB.update(
            "processing_jobs",
            {
                "stage": "queued",
                "status": "queued",
                "progress": 0,
                "error_message": None,
                "started_at": None,
                "completed_at": None,
            },
            "document_id",
            document_id,
        )
    except Exception:
        SupabaseDB.insert("processing_jobs", {
            "organization_id": org_id,
            "document_id": document_id,
            "job_type": "full_pipeline",
            "stage": "queued",
            "status": "queued",
            "progress": 0,
        })
    asyncio.ensure_future(document_service.process_document(document_id, org_id))
    return {
        "document_id": document_id,
        "status": "processing",
        "message": "Reprocessing started in background",
    }


@router.post(
    "/{document_id}/process",
    response_model=ProcessResponse,
    summary="Process a document",
    description="Run OCR, classification, entity extraction, and indexing on a document",
)
async def process_document(
    document_id: str,
    request: Request,
    force: bool = False,
    principal: dict = Depends(get_internal_or_user),
):
    org_id = request.query_params.get("organization_id")
    force_run = force or request.query_params.get("force", "").lower() in ("1", "true", "yes")
    if not org_id:
        try:
            body = await request.json()
            org_id = body.get("organization_id") if isinstance(body, dict) else None
            if isinstance(body, dict) and body.get("force"):
                force_run = True
        except Exception:
            pass
    if not org_id:
        raise HTTPException(status_code=400, detail="organization_id is required in query param or JSON body")

    _enforce_tool(
        "documents.reprocess",
        principal,
        org_id,
        input_payload={"document_id": document_id, "force": force_run},
    )

    existing = document_service.get_document(document_id, org_id)
    if existing and not force_run:
        if existing.get("status") in ("processed", "processing"):
            return ProcessResponse(
                document_id=document_id,
                status=existing.get("status", "processing"),
                classification={"document_type": existing.get("document_type", "unknown"), "confidence": 0},
                extraction={"extracted_data": existing.get("extracted_data", {}), "confidence": existing.get("extraction_confidence", 0)},
            )

    if force_run and existing:
        from ..database import SupabaseDB
        SupabaseDB.update("documents", {"status": "processing", "error_message": None}, "id", document_id)

    result = await document_service.process_document_await(document_id, org_id)

    classification = result.get("classification")
    extraction = result.get("extraction")

    return ProcessResponse(
        document_id=result.get("document_id", document_id),
        status=result.get("status", "processing"),
        classification=classification if isinstance(classification, dict) else None,
        extraction=extraction if isinstance(extraction, dict) else None,
    )


@router.post(
    "/check-duplicate",
    summary="Check if document filename already exists",
    description="Returns the existing document if filename already uploaded for this org",
)
async def check_duplicate(organization_id: str = Form(...), filename: str = Form(...)):
    existing = document_service.list_documents(organization_id, search=filename)
    for d in existing:
        if d.get("title", "").lower() == filename.lower():
            return {"duplicate": True, "document": d}
    return {"duplicate": False, "document": None}


@router.get(
    "/{document_id}",
    summary="Get document details",
    description="Retrieve document metadata and status",
)
async def get_document(document_id: str, organization_id: str = ""):
    doc = document_service.get_document(document_id, organization_id)
    if not doc:
        raise HTTPException(status_code=404, detail="Document not found")
    return doc


@router.get(
    "/{document_id}/extractions",
    response_model=ExtractionListResponse,
    summary="List document extractions",
    description="Return document extraction records, optionally filtered by extraction_type.",
)
async def get_document_extractions(document_id: str, organization_id: str = "", extraction_type: str = ""):
    filters = {"document_id": document_id}
    if organization_id:
        filters["organization_id"] = organization_id
    if extraction_type:
        filters["extraction_type"] = extraction_type
    result = SupabaseDB.select("document_extractions", filters=filters)
    data = getattr(result, "data", result if isinstance(result, list) else [])
    if not isinstance(data, list):
        data = []

    normalized = []
    for row in data:
        if isinstance(row, dict):
            extracted_data = row.get("extracted_data", {})
            if isinstance(extracted_data, str):
                try:
                    import json
                    extracted_data = json.loads(extracted_data)
                except Exception:
                    extracted_data = {}
            normalized.append({**row, "extracted_data": extracted_data})
        else:
            normalized.append(row)

    return {"extractions": normalized, "total": len(normalized)}


class UpdateDocTypeRequest(BaseModel):
    document_type: str | None = Field(None, description="Document type (invoice, contract, etc.)")
    phase3_agent: str = Field("", description="Phase 3 agent to use for extraction")
    organization_id: str = Field(..., description="Tenant ID")
    original_file_url: str | None = Field(None, description="Updated local file path after storage relocate")


@router.patch(
    "/{document_id}",
    summary="Update document metadata",
    description="Update document type, phase3 agent, and/or file path after storage relocate",
)
async def update_document(document_id: str, body: UpdateDocTypeRequest):
    from ..database import SupabaseDB
    updates = {}
    if body.document_type:
        updates["document_type"] = body.document_type
    if body.phase3_agent:
        updates["phase3_agent"] = body.phase3_agent
    if body.original_file_url:
        updates["original_file_url"] = body.original_file_url.strip()
    if not updates:
        raise HTTPException(status_code=400, detail="No fields to update")
    SupabaseDB.update("documents", updates, "id", document_id)
    return {"id": document_id, **updates, "status": "updated"}


@router.get(
    "",
    response_model=DocumentListResponse,
    summary="List documents",
    description="List all documents for an organization. Use q to search by title.",
)
async def list_documents(organization_id: str = "", q: str = "", phase3_agent: str = "", limit: int = 50, offset: int = 0):
    docs = document_service.list_documents(organization_id, limit, offset, search=q, phase3_agent=phase3_agent)
    return DocumentListResponse(documents=docs, total=len(docs))


@router.get(
    "/{document_id}/job",
    summary="Get processing job status",
    description="Get the current processing job stage and status for a document",
)
async def get_job_status(document_id: str, organization_id: str = ""):
    from ..services.orchestrator_service import orchestrator
    from ..database import SupabaseDB

    # Do NOT create orphan jobs for missing documents (causes endless poll loops)
    doc = document_service.get_document(document_id, organization_id or "")
    if not doc and organization_id:
        doc = document_service.get_document(document_id, "")
    if not doc:
        return {
            "document_id": document_id,
            "stage": "failed",
            "status": "failed",
            "progress": 0,
            "error_message": "Document not found",
        }

    existing = SupabaseDB.select("processing_jobs", filters={"document_id": document_id})
    data = getattr(existing, "data", existing if isinstance(existing, list) else [])
    if isinstance(data, list) and data:
        job = data[0] if isinstance(data[0], dict) else {}
        return job

    return orchestrator.get_or_create_job(document_id, organization_id or doc.get("organization_id") or "")


@router.post(
    "/{document_id}/validate",
    summary="Run cross-document validation",
    description="Run all validations for this document against related documents",
)
async def validate_document(document_id: str, organization_id: str = ""):
    if not organization_id:
        raise HTTPException(status_code=400, detail="organization_id required")
    from ..services.validation_service import validation_service
    results = validation_service.run_all_validations(document_id, organization_id)
    return {"document_id": document_id, "validation_results": results}


@router.get(
    "/{document_id}/workflow",
    summary="Get workflow status",
    description="Get workflow/approval status for a document",
)
async def get_workflow(document_id: str, organization_id: str = ""):
    from ..services.workflow_service import workflow_service
    wf = workflow_service.get_workflow_status(document_id, organization_id)
    if not wf:
        raise HTTPException(status_code=404, detail="No workflow found for this document")
    return wf


@router.post(
    "/{document_id}/workflow/advance",
    summary="Advance workflow stage",
    description="Move the workflow to the next stage",
)
async def advance_workflow(document_id: str, organization_id: str = "", notes: str = ""):
    from ..services.workflow_service import workflow_service
    return workflow_service.advance_stage(document_id, organization_id, notes)


@router.post(
    "/{document_id}/workflow/approve",
    summary="Approve document in workflow",
    description="Approve the document at the current workflow stage",
)
async def approve_document(
    document_id: str,
    organization_id: str = "",
    approver: str = "",
    notes: str = "",
    principal: dict = Depends(get_internal_or_user),
):
    from ..services.workflow_service import workflow_service
    if not approver:
        raise HTTPException(status_code=400, detail="approver name required")
    _enforce_tool(
        "workflow.approve",
        principal,
        organization_id,
        input_payload={"document_id": document_id, "approver": approver, "notes": notes},
    )
    return workflow_service.approve(document_id, organization_id, approver, notes)


@router.post(
    "/{document_id}/workflow/reject",
    summary="Reject document in workflow",
    description="Reject the document at the current workflow stage",
)
async def reject_document(
    document_id: str,
    organization_id: str = "",
    approver: str = "",
    reason: str = "",
    principal: dict = Depends(get_internal_or_user),
):
    from ..services.workflow_service import workflow_service
    if not approver or not reason:
        raise HTTPException(status_code=400, detail="approver and reason required")
    _enforce_tool(
        "workflow.reject",
        principal,
        organization_id,
        input_payload={"document_id": document_id, "approver": approver, "reason": reason},
    )
    return workflow_service.reject(document_id, organization_id, approver, reason)


@router.get(
    "/validations/list",
    summary="List validation results",
    description="Get all validation results for an organization",
)
async def list_validations(organization_id: str = "", document_id: str = "", limit: int = 50):
    from ..database import SupabaseDB
    filters = {}
    if organization_id:
        filters["organization_id"] = organization_id
    if document_id:
        filters["source_document_id"] = document_id
    result = SupabaseDB.select("validation_results", filters=filters)
    data = getattr(result, "data", [])
    if not isinstance(data, list):
        data = []
    return {"validations": data[:limit], "total": len(data)}


@router.get(
    "/workflows/pending",
    summary="List pending approvals",
    description="Get all documents pending approval in workflows",
)
async def list_pending_approvals(organization_id: str = "", assigned_to: str = ""):
    from ..services.workflow_service import workflow_service
    pending = workflow_service.list_pending_approvals(organization_id, assigned_to or None)
    return {"pending_approvals": pending, "total": len(pending)}


@router.delete(
    "/{document_id}",
    status_code=status.HTTP_200_OK,
    summary="Delete a document",
    description="Delete document and all associated data",
)
async def delete_document(
    document_id: str,
    organization_id: str = "",
    principal: dict = Depends(get_internal_or_user),
):
    _enforce_tool(
        "documents.delete",
        principal,
        organization_id,
        input_payload={"document_id": document_id},
    )
    return document_service.delete_document(document_id, organization_id)


@router.get(
    "/image/{path:path}",
    summary="Serve extracted image file",
    description="Returns an image file from the uploads/images directory",
)
async def serve_image(path: str):
    from fastapi.responses import FileResponse
    full_path = os.path.join(settings.UPLOAD_DIR, path)
    if not os.path.exists(full_path):
        raise HTTPException(status_code=404, detail="Image not found")
    return FileResponse(full_path, media_type="image/jpeg")


@router.get(
    "/{document_id}/images",
    summary="Get detected images with descriptions",
    description="Return images extracted from the document with their Vision-generated descriptions",
)
async def get_document_images(document_id: str, organization_id: str = ""):
    result = SupabaseDB.select("document_extractions", filters={
        "document_id": document_id,
        "organization_id": organization_id,
        "extraction_type": "image_extraction",
    })
    data = getattr(result, "data", result if isinstance(result, list) else [])
    images = []
    if isinstance(data, list) and data:
        extracted = data[0].get("extracted_data", {})
        images = extracted.get("images", [])
    desc_url = f"/api/v1/documents/image/images/{document_id}/descriptions.txt" if images else ""
    return {"images": images, "descriptions_file": desc_url}


@router.post(
    "/classify-text",
    summary="Classify document text",
    description="Classify document text into invoice, contract, PO, etc. using Groq AI",
)
async def classify_text(request: ClassifyTextRequest = Body(...)):
    from ..services.classification_service import classification_service
    result = classification_service.classify(request.text, request.filename)
    return result


@router.post(
    "/reindex-all",
    summary="Re-index all documents with current RAG logic",
    description="Delete existing chunks/embeddings and re-index every document using the latest heading detection and chunking.",
)
async def reindex_all():
    from ..services.rag_service import rag_service as rag
    from ..database import _get_supabase
    from ..services.pinecone_service import pinecone_service

    print("\n" + "="*70)
    print("[REINDEX] Starting full re-index of all documents...")
    print("="*70)

    client = _get_supabase()
    if not client:
        raise HTTPException(status_code=500, detail="Supabase client unavailable")
    res = client.table("documents").select(
        "id, organization_id, raw_text, document_type, status"
    ).execute()
    docs = getattr(res, "data", []) or []
    print(f"[REINDEX] Found {len(docs)} documents in DB")

    results = {"total": len(docs), "reindexed": 0, "skipped": 0, "errors": []}

    for d in docs:
        doc_id = d.get("id")
        org_id = d.get("organization_id")
        raw_text = d.get("raw_text") or ""
        doc_type = d.get("document_type")
        if not doc_id or not org_id or not raw_text.strip():
            results["skipped"] += 1
            print(f"[REINDEX] SKIP doc={doc_id} (no org/raw_text)")
            continue

        print(f"\n[REINDEX] ({results['reindexed'] + 1}/{len(docs)}) doc={doc_id[:12]} type={doc_type} chars={len(raw_text)}")

        try:
            # Delete old chunks
            if pinecone_service.available:
                try:
                    pinecone_service.delete_by_document(doc_id, namespace=org_id)
                except Exception as e:
                    print(f"  [WARN] Pinecone delete: {e}")
            client.table("document_chunks").delete().eq("document_id", doc_id).execute()
            client.table("document_embeddings").delete().eq("document_id", doc_id).execute()

            # Re-index with current logic
            rag.index_document(
                doc_id, org_id, raw_text, None,
                document_type=doc_type,
            )
            results["reindexed"] += 1
        except Exception as e:
            import traceback as _tb
            tb = _tb.format_exc()
            print(f"  [ERROR] {e}\n{tb}")
            results["errors"].append({"doc_id": doc_id, "error": str(e)})
            results["skipped"] += 1

    print(f"\n[REINDEX] DONE: {results['reindexed']} reindexed, {results['skipped']} skipped, {len(results['errors'])} errors")
    return results



