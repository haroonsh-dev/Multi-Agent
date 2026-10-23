from fastapi import APIRouter, HTTPException, Query, Body, status
import json
from ..models.schemas import SearchRequest, SearchResponse, SearchResult
from ..services.rag_service import rag_service

router = APIRouter(prefix="/api/v1/search", tags=["search"])


def _coerce_metadata(meta):
    """Legacy rows can store metadata as a JSON string. Ensure the API always returns a dict."""
    if isinstance(meta, dict):
        return meta
    if isinstance(meta, str):
        try:
            parsed = json.loads(meta)
            return parsed if isinstance(parsed, dict) else {}
        except Exception:
            return {}
    return {}


@router.post(
    "",
    response_model=SearchResponse,
    summary="Hybrid search documents",
    description="Vector + keyword hybrid search across all documents with filters",
)
async def search_documents(request: SearchRequest = Body(...)):
    if not request.query.strip():
        raise HTTPException(status_code=400, detail="Search query cannot be empty")

    results = rag_service.hybrid_search(
        query=request.query,
        organization_id=request.organization_id,
        document_type=request.document_type,
        phase3_agent=request.phase3_agent,
        status=request.status,
        date_from=request.date_from,
        date_to=request.date_to,
        limit=request.limit,
        offset=request.offset,
    )

    total_before_offset = len(results)
    search_results = [
        SearchResult(
            document_id=r["document_id"],
            document_title=r.get("document_title", ""),
            document_type=r.get("document_type"),
            chunk_text=r["chunk_text"][:500],
            page_number=r.get("page_number"),
            heading=r.get("heading"),
            section=r.get("section"),
            section_number=r.get("section_number"),
            machine_id=r.get("machine_id"),
            filename=r.get("filename"),
            score=r["score"],
            cv_score=r.get("cv_score"),
            metadata=_coerce_metadata(r.get("metadata")),
        )
        for r in results
    ]

    return SearchResponse(
        results=search_results,
        total=total_before_offset,
        query=request.query,
    )


@router.get(
    "",
    response_model=SearchResponse,
    summary="Search via GET",
    description="Quick search via query parameters",
)
async def search_get(
    query: str = Query(..., min_length=1, description="Search query"),
    organization_id: str = Query("", description="Tenant organization ID"),
    document_type: str = Query(None, description="Filter by document type"),
    phase3_agent: str = Query(None, description="Filter by phase3 agent"),
    status: str = Query(None, description="Filter by document status"),
    date_from: str = Query(None, description="Start date (ISO format)"),
    date_to: str = Query(None, description="End date (ISO format)"),
    limit: int = Query(20, ge=1, le=100, description="Max results"),
    offset: int = Query(0, ge=0, description="Result offset"),
):
    return await search_documents(SearchRequest(
        query=query,
        organization_id=organization_id,
        document_type=document_type,
        phase3_agent=phase3_agent,
        status=status,
        date_from=date_from,
        date_to=date_to,
        limit=limit,
        offset=offset,
    ))


@router.get(
    "/similar/{document_id}",
    summary="Find similar documents",
    description="Find documents similar to a given document using vector similarity",
)
async def similar_documents(document_id: str, organization_id: str = "", limit: int = 5):
    if not organization_id:
        raise HTTPException(status_code=400, detail="organization_id required")
    results = rag_service.find_similar(document_id, organization_id, limit)
    return {"results": [SearchResult(
        document_id=r["document_id"],
        document_title=r.get("document_title", ""),
        document_type=r.get("document_type"),
        chunk_text=r["chunk_text"][:500],
        page_number=r.get("page_number"),
        score=r["score"],
        cv_score=r.get("cv_score"),
        metadata=_coerce_metadata(r.get("metadata")),
    ) for r in results], "total": len(results)}


@router.get(
    "/by-type/{document_type}",
    summary="Search by document type",
    description="List documents of a specific type with optional text search",
)
async def search_by_type(document_type: str, organization_id: str = "", q: str = "", limit: int = 50, offset: int = 0):
    from ..database import SupabaseDB
    filters = {"organization_id": organization_id, "document_type": document_type}
    like = {"title": q} if q else None
    result = SupabaseDB.select("documents", filters=filters, like=like, limit=limit, offset=offset)
    data = getattr(result, "data", result if isinstance(result, list) else [])
    docs = data if isinstance(data, list) else []
    return {"documents": docs, "total": len(docs), "type": document_type}
