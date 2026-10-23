from fastapi import APIRouter, HTTPException, Body, status, Query
from typing import Optional
from pydantic import BaseModel, Field
from ..models.schemas import ChatRequest, ChatResponse, ChatSessionResponse, ChatSessionListResponse
from ..services.chat_service import chat_service
from ..services import agent_registry
from ..database import SupabaseDB

router = APIRouter(prefix="/api/v1/chat", tags=["chat"])


def _record_chat_tool_invocation(request: ChatRequest, answer: str, status: str = "completed"):
    """Audit the chat.ask tool invocation (best-effort; never breaks chat).

    Covers every path in chat_service with one call per endpoint. The resolved
    agent is approximated from the request scope (phase3_agent or doc type);
    chat.ask is a Tier 1 read tool so the policy decision is always allow.
    """
    agent_id = request.phase3_agent or (
        agent_registry.resolve_agent_for_doc(request.document_type) if request.document_type else ""
    )
    agent_registry.record_tool_invocation(
        organization_id=request.organization_id,
        tool_name="chat.ask",
        agent_id=agent_id or "",
        user_id=request.user_id or "",
        input_payload={"question": (request.question or "")[:1000]},
        result_status=status,
        result_summary=(answer or "")[:500],
        decision="allow",
        risk_tier="read",
    )


@router.get(
    "/sessions",
    response_model=ChatSessionListResponse,
    summary="List chat sessions",
    description="List chat sessions for an organization, optionally scoped to a user",
)
async def list_sessions(
    organization_id: str,
    user_id: Optional[str] = Query(None),
):
    sessions = SupabaseDB.list_chat_sessions(organization_id, user_id=user_id)
    return {"sessions": sessions, "total": len(sessions)}


@router.get(
    "/sessions/{session_id}",
    response_model=ChatSessionResponse,
    summary="Get chat session",
    description="Get a chat session with all its messages",
)
async def get_session(session_id: str):
    session = SupabaseDB.get_chat_session(session_id)
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")
    return session


@router.patch(
    "/sessions/{session_id}",
    summary="Rename chat session",
    description="Update the display title of a chat session",
)
@router.post(
    "/sessions/{session_id}/rename",
    summary="Rename chat session",
    description="Update the display title of a chat session",
)
async def rename_session(session_id: str, body: dict = Body(...)):
    session = SupabaseDB.get_chat_session(session_id)
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")
    title = str(body.get("title") or "").strip()
    if not title:
        raise HTTPException(status_code=400, detail="Title is required")
    if len(title) > 120:
        title = title[:117] + "..."
    SupabaseDB.update_chat_session_title(session_id, title)
    updated = SupabaseDB.get_chat_session(session_id)
    return {"success": True, "session": updated or {**session, "title": title}}


@router.delete(
    "/sessions/{session_id}",
    status_code=status.HTTP_200_OK,
    summary="Delete chat session",
    description="Delete a chat session and all its messages",
)
async def delete_session(session_id: str):
    SupabaseDB.delete_chat_session(session_id)
    return {"message": "Session deleted"}


@router.post(
    "",
    response_model=ChatResponse,
    summary="Chat with documents",
    description="Ask questions about selected documents using RAG + Groq AI",
)
async def chat_with_document(request: ChatRequest = Body(...)):
    if not request.question.strip():
        raise HTTPException(status_code=400, detail="Question cannot be empty")

    # None = all docs; non-empty list = selected docs only
    if request.document_ids:
        doc_ids = list(request.document_ids)
    elif request.document_id:
        doc_ids = [request.document_id]
    else:
        doc_ids = None

    result = chat_service.chat_with_document(
        question=request.question,
        document_ids=doc_ids,
        organization_id=request.organization_id,
        document_type=request.document_type,
        phase3_agent=request.phase3_agent,
        allowed_agents=request.allowed_agents,
        status=request.status,
        date_from=request.date_from,
        date_to=request.date_to,
        chat_history=request.chat_history,
        session_id=request.session_id,
        user_id=request.user_id,
        selected_text=request.selected_text,
        provider=request.provider,
        model=request.model,
        provider_config=request.provider_config.model_dump() if request.provider_config else None,
    )

    _record_chat_tool_invocation(request, result.get("answer", ""))

    return ChatResponse(
        answer=result["answer"],
        sources=result["sources"],
        document_id=result["document_id"],
        history=result.get("history", []),
        session_id=result.get("session_id"),
        provider=result.get("provider"),
        model=result.get("model"),
    )


class AppendChatExchangeRequest(BaseModel):
    organization_id: str = Field(..., min_length=1)
    question: str = Field(..., min_length=1)
    answer: str = Field(..., min_length=1)
    session_id: Optional[str] = None
    user_id: Optional[str] = None
    sources: Optional[list] = None


@router.post(
    "/append-exchange",
    response_model=ChatResponse,
    summary="Append chat messages without RAG (gateway HR actions)",
)
async def append_chat_exchange(body: AppendChatExchangeRequest = Body(...)):
    result = chat_service.append_exchange(
        organization_id=body.organization_id,
        question=body.question.strip(),
        answer=body.answer.strip(),
        session_id=body.session_id,
        user_id=body.user_id,
        sources=body.sources or [],
    )
    return ChatResponse(
        answer=result["answer"],
        sources=result.get("sources", []),
        document_id=result.get("document_id", ""),
        history=result.get("history", []),
        session_id=result.get("session_id"),
    )


@router.post(
    "/all",
    response_model=ChatResponse,
    summary="Chat across all documents",
    description="Search across all documents and answer questions using RAG + Groq AI",
)
async def chat_all_documents(request: ChatRequest = Body(...)):
    if not request.question.strip():
        raise HTTPException(status_code=400, detail="Question cannot be empty")

    result = chat_service.chat_with_document(
        question=request.question,
        document_ids=None,  # explicitly search all documents
        organization_id=request.organization_id,
        document_type=request.document_type,
        phase3_agent=request.phase3_agent,
        allowed_agents=request.allowed_agents,
        status=request.status,
        date_from=request.date_from,
        date_to=request.date_to,
        chat_history=request.chat_history,
        session_id=request.session_id,
        user_id=request.user_id,
        selected_text=request.selected_text,
        provider=request.provider,
        model=request.model,
        provider_config=request.provider_config.model_dump() if request.provider_config else None,
    )

    _record_chat_tool_invocation(request, result.get("answer", ""))

    return ChatResponse(
        answer=result["answer"],
        sources=result["sources"],
        document_id=result["document_id"],
        history=result.get("history", []),
        session_id=result.get("session_id"),
        provider=result.get("provider"),
        model=result.get("model"),
    )
