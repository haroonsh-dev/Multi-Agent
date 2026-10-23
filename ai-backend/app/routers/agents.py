"""
Agent Registry + Tool Gateway API (plan Steps 1 / 3 / 4)

Exposes the agent/tool catalog as an introspectable surface so any caller
(a human in the UI, a future MCP client, another agent) can ask:
  - "Who are the agents and what can they do?"      GET  /agents
  - "What tools does this agent have?"              GET  /agents/{id}/tools
  - "Route my request to the tools that fit."       POST /tools/route
  - "Is this tool call safe to run?"                POST /tools/{name}/check
  - "Show me the audit trail."                      GET  /tools/audit

This is deliberately read-only for the catalog/policy surface. Execution of
the actual tools stays on their existing endpoints; this router only makes
the registry visible and records policy evaluations.
"""
from typing import Optional

from fastapi import APIRouter, Body, HTTPException, Query

from ..services import agent_registry

router = APIRouter(prefix="/api/v1", tags=["agents-tools"])


@router.get("/agents", summary="List the agent catalog with capabilities + tools")
async def list_agents():
    return {"success": True, "data": {"agents": agent_registry.list_agents()}}


@router.get("/agents/catalog", summary="Canonical agent catalog for downstream consumers (gateway/frontend)")
async def agent_catalog():
    """Compact, authoritative catalog: agent ids, labels, doc_type->agent map.

    The api-gateway syncs plan entitlements (PLAN_AGENT_IDS) from this, and the
    frontend derives its agent/doc_type lists from it — so adding an agent to
    the registry propagates everywhere instead of drifting across copies.
    """
    return {
        "success": True,
        "data": agent_registry.catalog_consistency_report(),
    }


@router.get("/agents/{agent_id}/tools", summary="Tools available to one agent")
async def get_agent_tools(agent_id: str):
    if agent_id not in agent_registry.AGENT_INDEX:
        raise HTTPException(status_code=404, detail=f"Unknown agent: {agent_id}")
    return {
        "success": True,
        "data": {
            "agent_id": agent_id,
            "agent": agent_registry.AGENT_INDEX[agent_id]["label"],
            "tools": agent_registry.agent_tools(agent_id),
        },
    }


@router.get("/tools", summary="Full tool catalog with risk tiers")
async def list_tools(
    risk_tier: Optional[str] = Query(None, description="Filter by tier: read | low_risk_mutate | high_risk"),
    agent_id: Optional[str] = Query(None),
):
    tools = list(agent_registry.TOOL_CATALOG)
    if risk_tier:
        tools = [t for t in tools if t["risk_tier"] == risk_tier]
    if agent_id:
        tools = [t for t in tools if t.get("agent_id") in ("all", agent_id)]
    return {"success": True, "data": {"tools": tools, "tiers": agent_registry.TIERS}}


@router.post("/tools/route", summary="Semantic tool routing — inject only the top-N matching tools")
async def route_tools(body: dict = Body(...)):
    """Given a user prompt (+ optional agent/doc_type context), return the 3-5
    tools that should be injected into this turn — never the whole catalog."""
    query = str(body.get("query") or "").strip()
    doc_type = body.get("doc_type") or None
    agent = body.get("agent_id") or None
    limit = int(body.get("limit") or 5)
    if not query:
        raise HTTPException(status_code=400, detail="query is required")
    tools = agent_registry.route_tools(query=query, doc_type=doc_type, agent=agent, limit=limit)
    return {
        "success": True,
        "data": {
            "query": query,
            "resolved_agent": agent or (agent_registry.resolve_agent_for_doc(doc_type) if doc_type else None),
            "injected_tools": tools,
            "total_catalog": len(agent_registry.TOOL_CATALOG),
            "injection_note": f"Injected {len(tools)}/{len(agent_registry.TOOL_CATALOG)} tools into context.",
        },
    }


@router.post("/tools/{tool_name}/check", summary="Policy evaluation for a tool call (zero-trust gate)")
async def check_tool(tool_name: str, body: dict = Body(...)):
    """Classifies a tool call into allow / allow_with_audit / approval_required.
    Pass the caller's permission strings (from the gateway's RBAC) in
    `permissions` to grant high-risk overrides."""
    permissions = body.get("permissions") or None
    org_id = body.get("organization_id") or ""
    result = agent_registry.evaluate_tool(tool_name, permissions=permissions)
    # Record the evaluation so the gate itself is auditable.
    agent_registry.record_tool_invocation(
        organization_id=org_id,
        tool_name=tool_name,
        user_id=body.get("user_id") or "",
        input_payload={"permissions": list(permissions or [])},
        result_status="policy_check",
        decision=result["decision"],
        risk_tier=result["risk_tier"],
    )
    return {"success": True, "data": result}


@router.get("/tools/audit", summary="Agent tool invocation audit trail (newest first)")
async def list_audit(
    organization_id: str = Query(...),
    limit: int = Query(50, ge=1, le=200),
    tool_name: Optional[str] = Query(None),
):
    rows = agent_registry.list_tool_invocations(
        organization_id=organization_id, limit=limit, tool_name=tool_name
    )
    return {"success": True, "data": {"total": len(rows), "rows": rows}}
