import os
os.environ["USE_SHARED_MEMORY"] = "0"
os.environ["OMP_NUM_THREADS"] = "1"
os.environ["MKL_NUM_THREADS"] = "1"

import logging
import traceback
import time
from contextlib import asynccontextmanager
from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException as StarletteHTTPException
from fastapi.exceptions import RequestValidationError
from .routers import documents, search, chat, auth, reports, groq_config, settings as settings_router, hr, agents as agents_router
from .auth_deps import get_internal_or_user
from fastapi import Depends
from .config import settings
from .services.groq_service import GroqRateLimitExceeded
from .services import groq_limit_state

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
logger = logging.getLogger("docugemma-ai")


@asynccontextmanager
async def lifespan(app: FastAPI):
    try:
        if settings.DATABASE_URL:
            from .init_supabase import init_supabase_schema
            init_supabase_schema(settings.DATABASE_URL)
        from .database import _get_supabase
        _get_supabase()
        # Load embedding model FIRST (before PaddleOCR) to avoid torch DLL conflict
        _warmup_embedding()
        logger.info("Startup complete")
    except Exception as e:
        logger.warning(f"Startup error (non-fatal): {e}")
    yield


def _warmup_embedding():
    try:
        from .services.embedding_service import embedding_service
        embedding_service.load()
        logger.info("Embedding model loaded")
        
        from .services.rag_service import _get_cross_encoder
        _get_cross_encoder()
        logger.info("Reranker model loaded")
        
        print("✅ Models load ho gaye hain! (1024-Dim BAAI & 88MB ms-marco)")
    except Exception as e:
        logger.warning(f"Embedding model warmup failed (will skip embeddings): {e}")


app = FastAPI(
    title="DocuGemma AI",
    description="Open-Weight Document Intelligence Platform Powered by Google Gemma",
    version="1.0.0",
    lifespan=lifespan,
    docs_url="/docs",
    redoc_url="/redoc",
    openapi_tags=[
        {"name": "documents", "description": "Upload, process, classify & extract document data"},
        {"name": "search", "description": "Hybrid semantic search across documents"},
        {"name": "chat", "description": "AI chat with document context (RAG)"},
    ],
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.middleware("http")
async def audit_middleware(request: Request, call_next):
    start = time.time()
    response = await call_next(request)
    response.headers["X-Response-Time-Ms"] = str(int((time.time() - start) * 1000))
    return response


@app.exception_handler(StarletteHTTPException)
async def http_exception_handler(request: Request, exc):
    return JSONResponse(status_code=exc.status_code, content={"detail": exc.detail})


@app.exception_handler(RequestValidationError)
async def validation_handler(request: Request, exc):
    return JSONResponse(status_code=422, content={"detail": str(exc.errors())})


@app.exception_handler(GroqRateLimitExceeded)
async def groq_rate_limit_handler(request: Request, exc: GroqRateLimitExceeded):
    status = exc.status or groq_limit_state.status_payload()
    return JSONResponse(
        status_code=429,
        content={
            "detail": str(exc),
            "code": "GROQ_RATE_LIMIT",
            "message": "Groq API rate limit reached. Enter a new API key or wait for the cooldown.",
            "retry_after_seconds": status.get("retry_after_seconds"),
            "until_ts": status.get("until_ts"),
            "console_url": status.get("console_url") or "https://console.groq.com/keys",
            "billing_url": status.get("billing_url") or "https://console.groq.com/settings/billing",
            "model": status.get("model"),
        },
    )


@app.exception_handler(Exception)
async def global_exception_handler(request: Request, exc):
    # Some call sites catch loosely; still map RateLimit-looking errors
    err = str(exc).lower()
    if "rate_limit" in err or "rate limit" in err or "429" in err:
        status = groq_limit_state.mark_limited(str(exc))
        return JSONResponse(
            status_code=429,
            content={
                "detail": str(exc),
                "code": "GROQ_RATE_LIMIT",
                "message": "Groq API rate limit reached. Enter a new API key or wait for the cooldown.",
                "retry_after_seconds": status.get("retry_after_seconds"),
                "until_ts": status.get("until_ts"),
                "console_url": "https://console.groq.com/keys",
                "billing_url": "https://console.groq.com/settings/billing",
            },
        )
    logger.error(f"Unhandled error on {request.method} {request.url.path}: {exc}\n{traceback.format_exc()}")
    return JSONResponse(status_code=500, content={"detail": f"Internal server error: {str(exc)}"})


app.include_router(auth.router)
# The gateway signs every request with X-Internal-Service-Key; any caller that
# can't prove it is the gateway (or a valid user JWT) is rejected at the router
# level. This closes the "ai-backend trusts the gateway blindly" hole.
app.include_router(documents.router, dependencies=[Depends(get_internal_or_user)])
app.include_router(search.router, dependencies=[Depends(get_internal_or_user)])
app.include_router(chat.router, dependencies=[Depends(get_internal_or_user)])
app.include_router(hr.router, dependencies=[Depends(get_internal_or_user)])
app.include_router(reports.router, dependencies=[Depends(get_internal_or_user)])
app.include_router(groq_config.router)
app.include_router(settings_router.router)
# Agents/tools surface: catalog reads are meant to be introspectable, but the
# audit trail (GET /tools/audit) is org-scoped data. The gateway signs every call
# with the internal key, so requiring it here closes that exposure without
# breaking the frontend's indirect access (it goes through the gateway).
app.include_router(agents_router.router, dependencies=[Depends(get_internal_or_user)])


@app.get("/", tags=["status"])
async def root():
    return {
        "service": "DocuGemma AI",
        "version": "1.0.0",
        "status": "running",
        "docs": "/docs",
        "openapi": "/openapi.json",
        "endpoints": {
            "upload": "POST /api/v1/documents/upload",
            "process": "POST /api/v1/documents/{id}/process",
            "documents": "GET /api/v1/documents",
            "classify": "POST /api/v1/documents/classify-text",
            "extract": "POST /api/v1/documents/extract-entities",
            "search": "POST /api/v1/search",
            "chat": "POST /api/v1/chat",
            "chat_all": "POST /api/v1/chat/all",
            "similar": "GET /api/v1/search/similar/{id}",
            "by_type": "GET /api/v1/search/by-type/{type}",
            "validate": "POST /api/v1/documents/{id}/validate",
            "workflow": "GET /api/v1/documents/{id}/workflow",
            "approve": "POST /api/v1/documents/{id}/workflow/approve",
            "reject": "POST /api/v1/documents/{id}/workflow/reject",
            "pending_approvals": "GET /api/v1/documents/workflows/pending",
            "validations_list": "GET /api/v1/documents/validations/list",
            "job_status": "GET /api/v1/documents/{id}/job",
            "dashboard_stats": "GET /api/v1/dashboard/stats",
        },
    }


@app.get("/json", tags=["status"])
@app.get("/json/version", tags=["status"])
async def json_version():
    """Inspector probe endpoint to silence Chrome DevTools / IDE 404 errors."""
    return {
        "Browser": "DocuGemma AI/1.0.0",
        "Protocol-Version": "1.3",
        "User-Agent": "docugemma-ai",
        "V8-Version": "none",
    }


@app.get("/health", tags=["status"])
async def health():
    from .database import _get_supabase, _use_supabase
    _get_supabase()
    db_status = "supabase" if _use_supabase else "local-sqlite"
    return {
        "status": "healthy",
        "database": db_status,
        "groq_api": settings.GROQ_API_KEY[:8] + "..." if settings.GROQ_API_KEY and settings.GROQ_API_KEY != "gsk_your_groq_api_key" else "not configured",
    }


@app.get("/api/v1/dashboard/stats", tags=["status"])
async def dashboard_stats(organization_id: str = "default-org"):
    from .database import _get_supabase, _use_supabase, _get_local_db
    try:
        client = _get_supabase()
        if _use_supabase and client:
            total = len(getattr(client.table("documents").select("id", count="exact").eq("organization_id", organization_id).execute(), "data", []))
            processed = len(getattr(client.table("documents").select("id", count="exact").eq("organization_id", organization_id).eq("status", "processed").execute(), "data", []))
            failed = len(getattr(client.table("documents").select("id", count="exact").eq("organization_id", organization_id).eq("status", "failed").execute(), "data", []))
            pending_approvals = len(getattr(client.table("workflow_instances").select("id", count="exact").eq("organization_id", organization_id).eq("status", "active").execute(), "data", []))
            return {"total_documents": total, "processed": processed, "failed": failed, "pending": total - processed - failed, "by_type": {}, "pending_approvals": pending_approvals}
    except Exception:
        pass
    conn = _get_local_db()
    total = conn.execute("SELECT COUNT(*) FROM documents WHERE organization_id=?", (organization_id,)).fetchone()[0]
    processed = conn.execute("SELECT COUNT(*) FROM documents WHERE organization_id=? AND status='processed'", (organization_id,)).fetchone()[0]
    failed = conn.execute("SELECT COUNT(*) FROM documents WHERE organization_id=? AND status='failed'", (organization_id,)).fetchone()[0]
    pending_approvals = conn.execute("SELECT COUNT(*) FROM workflow_instances WHERE organization_id=? AND status='active'", (organization_id,)).fetchone()[0]
    return {
        "total_documents": total,
        "processed": processed,
        "failed": failed,
        "pending": total - processed - failed,
        "by_type": {},
        "pending_approvals": pending_approvals,
    }
