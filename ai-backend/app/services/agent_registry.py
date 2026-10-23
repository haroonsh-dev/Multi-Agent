"""
Universal Agent Registry + Tool Gateway
========================================

This module adapts the "Universal Agent Gateway" plan (MCP standardization,
central tool registry, semantic tool routing, risk-tiered policy, audit
trail) to THIS codebase.

Important reality check baked into this file: our agents are NOT external
tool-calling bots. They are document-intelligence roles (classify -> extract
-> QA) implemented as prompt/skill packages (see prompts/phase3/). There is
no MCP wire protocol here because there is no third-party tool surface yet —
but the *structure* the plan asks for is valuable right now:

  Step 1  -> a single source of truth for "who are the agents, what tools
             do they have" (GET /agents, GET /agents/{id}/tools)
  Step 3  -> semantic routing that injects only the top-N matching tools
             instead of the full catalog (route_tools)
  Step 4  -> every tool has a risk tier + policy action (auto / audit /
             approval), and every invocation is written to a tamper-proof
             audit table (agent_tool_audit)
  Step 6  -> a capability catalog the UI can render as a marketplace

The module is deliberately import-light: it imports only the document->agent
map from agent_orchestrator (the existing source of truth for routing) and
lazy-imports the database on write, so nothing here can break the pipeline.
"""

from __future__ import annotations

import json
import re
import time
from typing import Any, Iterable, Optional

# The existing document -> agent routing map is the canonical mapping. We
# reuse it so the registry never drifts from the live classification path.
from .agent_orchestrator import DOCUMENT_TO_PHASE3_AGENT, PHASE3_AGENT_PROMPT_MAP

# ---------------------------------------------------------------------------
# Risk tiers (plan Step 4 — action classification)
# ---------------------------------------------------------------------------

TIERS = {
    "read": {
        "label": "Tier 1 — Read / Safe",
        "order": 1,
        "action": "auto",
        "description": "Read-only. No state is changed. Auto-executes.",
    },
    "low_risk_mutate": {
        "label": "Tier 2 — Mutating / Low-Risk",
        "order": 2,
        "action": "audit",
        "description": "Changes platform state but is reversible / low impact. Auto-executes with an audit log + undo record.",
    },
    "high_risk": {
        "label": "Tier 3 — High-Risk / Irreversible",
        "order": 3,
        "action": "approval",
        "description": "Irreversible or externally visible (outbound). Requires an authorized human to approve.",
    },
}

TIER_ORDER = {name: meta["order"] for name, meta in TIERS.items()}
DEFAULT_TIER = "read"


def tier_label(tier: str) -> str:
    meta = TIERS.get(tier)
    return meta["label"] if meta else tier


def tier_action(tier: str) -> str:
    meta = TIERS.get(tier)
    return meta["action"] if meta else "auto"


# ---------------------------------------------------------------------------
# Tool definitions
# ---------------------------------------------------------------------------
# Each tool maps to a real capability of the platform. `keywords` drive the
# semantic router (Step 3): a user prompt is scored against these to pick the
# 3-5 tools to inject, instead of dumping the whole catalog into context.
#
# name         -> stable tool id (dots, lower-case)
# agent_id     -> owning agent ("" = shared / all agents)
# risk_tier    -> read | low_risk_mutate | high_risk
# action       -> auto | audit | approval (derived from tier, kept explicit)
# external     -> True when the tool reaches an outside system (Slack/Drive/webhook)
# schema       -> minimal JSON-ish parameter description (MCP-style)
# keywords     -> routing terms (EN + UR) used by route_tools()

_shared_read_tools = [
    {
        "name": "chat.ask",
        "description": "Answer a question grounded in uploaded documents (RAG Q&A).",
        "risk_tier": "read",
        "external": False,
        "schema": {"question": {"type": "string", "required": True}, "document_ids": {"type": "array", "required": False}},
        "keywords": ["ask", "question", "chat", "tell", "explain", "summar", "find", "show",
                     "پوچھ", "بتا", "دیکھ", "سوال"],
    },
    {
        "name": "documents.search",
        "description": "Hybrid (vector + keyword) search across the document library.",
        "risk_tier": "read",
        "external": False,
        "schema": {"query": {"type": "string", "required": True}, "document_type": {"type": "string", "required": False}},
        "keywords": ["search", "find", "look", "document", "file", "search result", "تلاش", "ڈھونڈ"],
    },
    {
        "name": "documents.classify",
        "description": "Classify a document into a type + owning agent (finance/invoice, hr/resume ...).",
        "risk_tier": "read",
        "external": False,
        "schema": {"text": {"type": "string", "required": True}},
        "keywords": ["classif", "type", "category", "sort", "what kind", "درجہ", "قسم"],
    },
]

_shared_low_risk_tools = [
    {
        "name": "documents.extract",
        "description": "Extract structured fields from a document (invoice line items, CV skills ...).",
        "risk_tier": "low_risk_mutate",
        "external": False,
        "schema": {"document_id": {"type": "string", "required": True}},
        "keywords": ["extract", "field", "line item", "total", "data", "نکال", "فیصلڈ"],
    },
    {
        "name": "documents.validate",
        "description": "Cross-check extracted values against a source document (validation result).",
        "risk_tier": "low_risk_mutate",
        "external": False,
        "schema": {"source_document_id": {"type": "string", "required": True}},
        "keywords": ["validate", "check", "reconcile", "match", "verify", "تصدیق", "جانچ"],
    },
    {
        "name": "documents.reprocess",
        "description": "Re-run the AI pipeline (OCR -> classify -> extract) for a document.",
        "risk_tier": "low_risk_mutate",
        "external": False,
        "schema": {"document_id": {"type": "string", "required": True}},
        "keywords": ["reprocess", "rerun", "re-", "again", "re-index", "دوبارہ", "نیا"],
    },
    {
        "name": "report.generate",
        "description": "Generate a PDF / structured report (finance, compliance, HR shortlist ...).",
        "risk_tier": "low_risk_mutate",
        "external": False,
        "schema": {"agent_id": {"type": "string", "required": False}, "scope": {"type": "string", "required": False}},
        "keywords": ["report", "pdf", "generate", "summary report", "shortlist", "رپورٹ"],
    },
]

_shared_high_risk_tools = [
    {
        "name": "documents.delete",
        "description": "Permanently delete a document and its chunks/extractions.",
        "risk_tier": "high_risk",
        "external": False,
        "schema": {"document_id": {"type": "string", "required": True}},
        "keywords": ["delete", "remove", "drop", "ختم", "حذف"],
    },
    {
        "name": "workflow.approve",
        "description": "Approve a document workflow (invoice approval, compliance review).",
        "risk_tier": "high_risk",
        "external": False,
        "schema": {"document_id": {"type": "string", "required": True}},
        "keywords": ["approve", "approval", "sign off", "green light", "منظور"],
    },
    {
        "name": "workflow.reject",
        "description": "Reject a document workflow, moving the document to rejected status.",
        "risk_tier": "high_risk",
        "external": False,
        "schema": {"document_id": {"type": "string", "required": True}, "reason": {"type": "string", "required": True}},
        "keywords": ["reject", "decline", "deny", "رد", "مسترد"],
    },
    {
        "name": "integrations.send",
        "description": "Send documents / summaries to an external system (Google Drive folder or webhook).",
        "risk_tier": "high_risk",
        "external": True,
        "schema": {"connection_id": {"type": "string", "required": True}, "document_ids": {"type": "array", "required": True}},
        "keywords": ["send", "export", "upload", "drive", "webhook", "push", "بھیج", "بھیجو"],
    },
]

# Per-agent tools beyond the shared set (Step 6 capability marketplace).
_AGENT_EXTRA_TOOLS: dict[str, list[dict]] = {
    "finance_agent": [
        {
            "name": "finance.totals",
            "description": "Portfolio-wide finance analytics: totals, AP/AR, aging, monthly trend.",
            "risk_tier": "read",
            "external": False,
            "schema": {"scope": {"type": "string", "required": False}},
            "keywords": ["total", "sum", "aggregate", "aging", "ap", "ar", "vendor", "client", "trend", "مجموعہ", "ٹوٹل"],
        },
        {
            "name": "finance.export",
            "description": "Export finance data / extracted invoices to an external workbook or system.",
            "risk_tier": "high_risk",
            "external": True,
            "schema": {"format": {"type": "string", "required": False}},
            "keywords": ["export", "download", "excel", "csv", "برآمد", "ڈاؤن لوڈ"],
        },
    ],
    "hr_agent": [
        {
            "name": "hr.shortlist",
            "description": "Rank / shortlist candidates from resumes by CV evaluation score.",
            "risk_tier": "read",
            "external": False,
            "schema": {"top_n": {"type": "integer", "required": False}},
            "keywords": ["shortlist", "rank", "top", "candidate", "resume", "score", "شورٹ لسٹ", "امیدوار"],
        },
        {
            "name": "hr.letter",
            "description": "Generate offer / experience / promotion / warning letters from employee records.",
            "risk_tier": "low_risk_mutate",
            "external": False,
            "schema": {"employee_id": {"type": "string", "required": True}, "letter_type": {"type": "string", "required": True}},
            "keywords": ["offer letter", "experience letter", "promotion", "warning letter", "letter", "خط"],
        },
    ],
    "compliance_agent": [
        {
            "name": "compliance.expiry",
            "description": "Certificate expiry timeline + validity across compliance documents.",
            "risk_tier": "read",
            "external": False,
            "schema": {"window_days": {"type": "integer", "required": False}},
            "keywords": ["expiry", "expire", "valid", "certificate", "timeline", "میعاد"],
        },
    ],
    "procurement_agent": [
        {
            "name": "procurement.spend",
            "description": "Supplier spend / PO vs invoice comparison analytics.",
            "risk_tier": "read",
            "external": False,
            "schema": {"scope": {"type": "string", "required": False}},
            "keywords": ["supplier", "spend", "po", "invoice", "vendor", "خریداری", "سپلائر"],
        },
    ],
    "legal_agent": [
        {
            "name": "legal.risk",
            "description": "Contract risk flags, clause-type mix, party liabilities.",
            "risk_tier": "read",
            "external": False,
            "schema": {"scope": {"type": "string", "required": False}},
            "keywords": ["risk", "clause", "liability", "party", "jurisdiction", "contract", "خطرہ", "شرط"],
        },
    ],
}


def _build_tool_catalog() -> list[dict]:
    """Assemble the full tool catalog: shared tools + per-agent tools."""
    catalog: list[dict] = []
    for t in _shared_read_tools + _shared_low_risk_tools + _shared_high_risk_tools:
        entry = dict(t)
        entry.setdefault("agent_id", "all")
        entry["action"] = tier_action(entry["risk_tier"])
        catalog.append(entry)
    for agent_id, tools in _AGENT_EXTRA_TOOLS.items():
        for t in tools:
            entry = dict(t)
            entry["agent_id"] = agent_id
            entry["action"] = tier_action(entry["risk_tier"])
            catalog.append(entry)
    return catalog


TOOL_CATALOG: list[dict] = _build_tool_catalog()

# name -> tool (fast lookup)
TOOL_INDEX: dict[str, dict] = {t["name"]: t for t in TOOL_CATALOG}


# ---------------------------------------------------------------------------
# Agent catalog (Step 6 — capability marketplace)
# ---------------------------------------------------------------------------

AGENT_CATALOG: list[dict] = [
    {
        "id": "finance_agent",
        "label": "Finance Agent",
        "description": "Invoices, financial statements, expenses, taxes, bank statements, budgets.",
        "doc_types": [],
        "prompt_path": PHASE3_AGENT_PROMPT_MAP["finance_agent"],
    },
    {
        "id": "hr_agent",
        "label": "HR Agent",
        "description": "Resumes/CVs, transcripts, offers, payroll, leave, attendance, performance, employee records.",
        "doc_types": [],
        "prompt_path": PHASE3_AGENT_PROMPT_MAP["hr_agent"],
    },
    {
        "id": "legal_agent",
        "label": "Legal Agent",
        "description": "Contracts, agreements, NDAs, service/lease/vendor agreements.",
        "doc_types": [],
        "prompt_path": PHASE3_AGENT_PROMPT_MAP["legal_agent"],
    },
    {
        "id": "procurement_agent",
        "label": "Procurement Agent",
        "description": "Purchase orders, quotations, RFQs, delivery notes, supplier agreements.",
        "doc_types": [],
        "prompt_path": PHASE3_AGENT_PROMPT_MAP["procurement_agent"],
    },
    {
        "id": "compliance_agent",
        "label": "Compliance Agent",
        "description": "SOPs, audit/quality/maintenance reports, certificates, inspections, engineering drawings.",
        "doc_types": [],
        "prompt_path": PHASE3_AGENT_PROMPT_MAP["compliance_agent"],
    },
    {
        "id": "other_agent",
        "label": "Other Agent",
        "description": "General / unclassified documents.",
        "doc_types": [],
        "prompt_path": PHASE3_AGENT_PROMPT_MAP["other_agent"],
    },
]


def _attach_doc_types() -> None:
    """Fill doc_types from the canonical document->agent map (keeps DRY)."""
    for agent in AGENT_CATALOG:
        agent["doc_types"] = sorted(
            dt for dt, ag in DOCUMENT_TO_PHASE3_AGENT.items() if ag == agent["id"]
        )


_attach_doc_types()
AGENT_INDEX: dict[str, dict] = {a["id"]: a for a in AGENT_CATALOG}

# ---------------------------------------------------------------------------
# Public lookups
# ---------------------------------------------------------------------------


def list_agents() -> list[dict]:
    """Full agent catalog with resolved capabilities + tools."""
    return [
        {
            "id": a["id"],
            "label": a["label"],
            "description": a["description"],
            "doc_types": a["doc_types"],
            "prompt_path": a["prompt_path"],
            "tools": agent_tools(a["id"]),
            "capabilities": sorted(
                {t["name"] for t in agent_tools(a["id"])}
            ),
        }
        for a in AGENT_CATALOG
    ]


def agent_tools(agent_id: str) -> list[dict]:
    """Tools available to an agent: shared tools + its own extras."""
    if not agent_id or agent_id == "other_agent":
        shared = [t for t in TOOL_CATALOG if t["agent_id"] == "all"]
        return [{"name": t["name"], "description": t["description"],
                 "risk_tier": t["risk_tier"], "action": t["action"]} for t in shared]
    extras = [dict(t) for t in _AGENT_EXTRA_TOOLS.get(agent_id, [])]
    for t in extras:
        t["action"] = tier_action(t["risk_tier"])
    shared = [t for t in TOOL_CATALOG if t["agent_id"] == "all"]
    return [
        {"name": t["name"], "description": t["description"],
         "risk_tier": t["risk_tier"], "action": t["action"]}
        for t in shared + extras
    ]


def get_tool(name: str) -> Optional[dict]:
    return TOOL_INDEX.get(name)


def agent_ids() -> list[str]:
    """Canonical list of agent ids (single source of truth for the catalog).

    Backed by AGENT_CATALOG, which is derived from the live routing map
    (DOCUMENT_TO_PHASE3_AGENT). New agents added upstream automatically appear
    here; the gateway / frontend derive from this rather than duplicating ids.
    """
    return [a["id"] for a in AGENT_CATALOG]


def doc_type_to_agent() -> dict[str, str]:
    """Canonical doc_type -> agent map (mirrors the live classifier routing)."""
    return dict(DOCUMENT_TO_PHASE3_AGENT)


def resolve_agent_for_doc(doc_type: str) -> str:
    """Canonical agent for a document type (delegates to the live routing map)."""
    if not doc_type:
        return "other_agent"
    return DOCUMENT_TO_PHASE3_AGENT.get(doc_type, "other_agent")


def catalog_consistency_report() -> dict:
    """Detect drift between this registry and the hard-coded catalog copies.

    The frontend (documentAgents.ts) and gateway (AgentStoragePricing) each
    keep their own list of agents / doc_type mappings. This report surfaces
    any mismatch so a new agent added to the registry is propagated rather
    than silently missing from the UI or plan entitlements.
    """
    return {
        "agent_ids": agent_ids(),
        "agent_labels": {a["id"]: a["label"] for a in AGENT_CATALOG},
        "doc_type_to_agent": doc_type_to_agent(),
        "tool_count": len(TOOL_CATALOG),
    }


# ---------------------------------------------------------------------------
# Step 3 — Semantic tool routing (inject only the top-N matching tools)
# ---------------------------------------------------------------------------


def _tokenize(text: str) -> list[str]:
    if not text:
        return []
    text = text.lower()
    tokens = set(re.findall(r"[a-z0-9]+", text))
    return list(tokens)


def _normalize_keyword(kw: str) -> str:
    return kw.lower().strip()


def route_tools(
    query: str,
    doc_type: str = None,
    agent: str = None,
    limit: int = 5,
) -> list[dict]:
    """Score the tool catalog against a user prompt and return the top-N.

    Mirrors the plan's two-stage semantic routing: instead of handing the LLM
    the full catalog (token bloat + confusion), we retrieve only the 3-5 tools
    that match the request, optionally narrowed by the resolved agent / doc type.
    """
    q = (query or "").lower()
    q_tokens = set(_tokenize(q))

    # Agent-narrowed candidate set first (cheap + keeps intent correct).
    if agent and agent in AGENT_INDEX:
        candidates = agent_tools(agent)
        candidates = [get_tool(c["name"]) for c in candidates if get_tool(c["name"])]
    elif doc_type:
        ag = resolve_agent_for_doc(doc_type)
        candidates = [get_tool(c["name"]) for c in agent_tools(ag) if get_tool(c["name"])]
    else:
        candidates = TOOL_CATALOG

    scored: list[tuple[float, dict]] = []
    for tool in candidates:
        score = 0.0
        for kw in tool.get("keywords", []):
            nkw = _normalize_keyword(kw)
            if nkw in q:
                score += 3.0
            elif nkw in q_tokens:
                score += 2.0
            elif " " not in nkw and any(t.startswith(nkw) for t in q_tokens):
                score += 1.0
        # A tiny boost so deterministic "what can you do" queries surface the read tools.
        if not q or q in ("help", "hi", "hello", "what can you do", "tools"):
            if tool["risk_tier"] == "read":
                score += 0.5
        if score > 0:
            scored.append((score, tool))

    scored.sort(key=lambda x: (-x[0], TIER_ORDER.get(x[1]["risk_tier"], 99)))

    # Graceful fallback: if nothing matches, always surface the shared read
    # tools so the caller can still answer (e.g. "chat.ask" over documents).
    # Never return an empty injection list.
    if not scored:
        for t in TOOL_CATALOG:
            if t["agent_id"] == "all" and t["risk_tier"] == "read":
                scored.append((0.1, t))
        scored = scored[:limit]

    results = [t for _, t in scored[:limit]]

    return [
        {
            "name": t["name"],
            "description": t["description"],
            "risk_tier": t["risk_tier"],
            "tier_label": tier_label(t["risk_tier"]),
            "action": t["action"],
            "agent_id": t.get("agent_id", "all"),
            "external": t.get("external", False),
            "score": round(s, 2),
        }
        for s, t in [(score, t) for score, t in scored[:limit]]
    ]


# ---------------------------------------------------------------------------
# Step 4 — Policy engine (zero-trust gate before a tool call runs)
# ---------------------------------------------------------------------------


def classify_tool(tool_name: str) -> dict:
    """Return tier + action metadata for a tool (with safety fallback).

    Unknown tools are treated as high-risk: we cannot assess what they do, so
    they must never auto-execute. `known: False` marks them so evaluate_tool
    can fail closed (decision == "blocked") regardless of caller identity.
    """
    tool = get_tool(tool_name)
    if not tool:
        return {
            "tool": tool_name,
            "risk_tier": "high_risk",
            "tier_label": tier_label("high_risk"),
            "action": "approval",
            "external": False,
            "known": False,
        }
    return {
        "tool": tool["name"],
        "risk_tier": tool["risk_tier"],
        "tier_label": tier_label(tool["risk_tier"]),
        "action": tool["action"],
        "external": tool.get("external", False),
        "known": True,
    }


class PolicyDenied(Exception):
    """Raised when a tool invocation is blocked by the policy gate.

    Carries the evaluation result so callers can surface the reason (and the
    HTTP layer can translate it to a 403 approval_required).
    """

    def __init__(self, evaluation: dict):
        self.evaluation = evaluation
        super().__init__(evaluation.get("reason", "Tool call blocked by policy"))


def enforce_tool_policy(
    tool_name: str,
    organization_id: str,
    principal: dict,
    agent_id: str = "",
    input_payload: Any = None,
    result_summary: str = "",
) -> dict:
    """Gate a tool invocation right before it actually runs.

    Two identity sources (see auth_deps.get_internal_or_user):
      - source="internal"  -> the api-gateway, which already enforced RBAC.
                              High-risk tools are allow_with_audit (trusted
                              edge), and every call is written to the audit trail.
      - source="user"      -> a directly-authenticated JWT caller. evaluate_tool
                              runs against the token's permissions; Tier-3 tools
                              raise PolicyDenied unless an override is held.

    Returns the evaluation dict {decision, risk_tier, reason, ...}. Raises
    PolicyDenied when the call must NOT proceed.
    """
    source = (principal or {}).get("source", "user")

    if source == "internal":
        evaluation = evaluate_tool(tool_name, permissions=None)
        # Gateway already enforced RBAC; high-risk becomes allow_with_audit.
        if evaluation["decision"] == "approval_required":
            evaluation = {
                **evaluation,
                "decision": "allow_with_audit",
                "reason": "Trusted internal gateway caller — RBAC enforced upstream; invocation audited.",
            }
        decision = evaluation["decision"]
    else:
        permissions = (principal or {}).get("permissions")
        evaluation = evaluate_tool(tool_name, permissions=permissions)
        decision = evaluation["decision"]
        if decision == "approval_required":
            record_tool_invocation(
                organization_id=organization_id,
                tool_name=tool_name,
                agent_id=agent_id,
                user_id=(principal or {}).get("user_id", ""),
                input_payload=input_payload,
                result_status="blocked",
                result_summary=result_summary or evaluation.get("reason", ""),
                decision="approval_required",
                risk_tier=evaluation["risk_tier"],
            )
            raise PolicyDenied(evaluation)

    # Fail closed on tools we cannot assess (unknown to the registry): never
    # let them execute, for internal callers or user callers alike.
    if decision == "blocked":
        record_tool_invocation(
            organization_id=organization_id,
            tool_name=tool_name,
            agent_id=agent_id,
            user_id=(principal or {}).get("user_id", ""),
            input_payload=input_payload,
            result_status="blocked",
            result_summary=result_summary or evaluation.get("reason", ""),
            decision="blocked",
            risk_tier=evaluation.get("risk_tier", "high_risk"),
        )
        raise PolicyDenied(evaluation)

    audit = record_tool_invocation(
        organization_id=organization_id,
        tool_name=tool_name,
        agent_id=agent_id,
        user_id=(principal or {}).get("user_id", ""),
        input_payload=input_payload,
        result_status="completed",
        result_summary=result_summary,
        decision=decision,
        risk_tier=evaluation["risk_tier"],
    )

    # Audit is the contract for Tier-3: if the invocation cannot be recorded,
    # do not execute it. Fail closed on audit write failure.
    if not audit.get("ok") and evaluation.get("risk_tier") == "high_risk":
        raise PolicyDenied({
            **evaluation,
            "decision": "blocked",
            "reason": "Audit write failed — the high-risk invocation could not be recorded, so it was blocked.",
        })

    return evaluation


def evaluate_tool(tool_name: str, permissions: Iterable[str] | None = None) -> dict:
    """Zero-trust evaluation: is this tool call allowed to proceed?

    - Unknown tools default to 'read' (safe) but are flagged unknown.
    - Tier 1 (read)       -> allow
    - Tier 2 (mutate)     -> allow, but MUST be audited
    - Tier 3 (high-risk)  -> approval_required unless the caller's permission
                             set explicitly grants an override (e.g. 'tool.workflow.approve')
    permissions: list of permission strings the calling user holds (e.g.
    from the gateway's RBAC) used to shortcut high-risk approvals.
    """
    cls = classify_tool(tool_name)
    # Fail closed on unknown tools: a tool not in the registry cannot be
    # risk-assessed, so it is blocked for every caller — no override can
    # re-allow a tool whose side effects are unknown.
    if not cls.get("known", True):
        return {
            **cls,
            "decision": "blocked",
            "reason": "Unknown tool — not in the registry; risk cannot be assessed, so the call is blocked.",
        }
    tier = cls["risk_tier"]
    perms = {str(p).lower() for p in (permissions or [])}

    if tier == "high_risk":
        override = f"tool.{tool_name}"
        granted = override in perms or f"tool.{tool_name.split('.')[0]}.*" in perms
        if granted:
            return {**cls, "decision": "allow", "reason": "Caller holds an explicit tool override permission."}
        return {
            **cls,
            "decision": "approval_required",
            "reason": "Tier 3 tool — requires an authorized human to approve before the payload is sent.",
        }

    if tier == "low_risk_mutate":
        return {
            **cls,
            "decision": "allow_with_audit",
            "reason": "Tier 2 tool — runs automatically but every invocation is written to the audit trail.",
        }

    return {**cls, "decision": "allow", "reason": "Tier 1 read tool — safe to auto-execute."}


# ---------------------------------------------------------------------------
# Step 4 — Tamper-proof audit trail (agent_tool_audit)
# ---------------------------------------------------------------------------


def record_tool_invocation(
    organization_id: str,
    tool_name: str,
    agent_id: str = "",
    user_id: str = "",
    input_payload: Any = None,
    result_status: str = "started",
    result_summary: str = "",
    decision: str = "allow",
    risk_tier: str = "read",
    duration_ms: Optional[int] = None,
) -> dict:
    """Best-effort write of a tool invocation to agent_tool_audit.

    Never raises: audit is critical-path-adjacent, not critical path.
    The one exception is enforced by the CALLER: enforce_tool_policy treats a
    failed write as a hard block for Tier-3 (high-risk) tools, because those
    must not execute unless the invocation was recorded. Tier-1/2 keep the
    best-effort contract.
    Mirrors the plan's audit columns: timestamp, agent_id, user_id,
    tool_name, input_payload, result_status.
    """
    try:
        from ..database import SupabaseDB

        row = {
            "organization_id": organization_id or "",
            "tool_name": tool_name,
            "agent_id": agent_id or "",
            "user_id": user_id or "",
            "risk_tier": risk_tier,
            "decision": decision,
            "input_payload": json.dumps(input_payload, default=str)[:4000] if input_payload is not None else "",
            "result_status": result_status or "started",
            "result_summary": str(result_summary or "")[:2000],
            "duration_ms": duration_ms,
            "created_at": _utc_now(),
        }
        SupabaseDB.insert("agent_tool_audit", row)
        return {"ok": True, "id": row.get("id")}
    except Exception as e:  # audit must never break the caller
        print(f"[agent_registry] audit write skipped: {e}")
        return {"ok": False, "error": str(e)}


def _utc_now() -> str:
    try:
        from datetime import datetime, timezone
        return datetime.now(timezone.utc).isoformat()
    except Exception:
        return str(time.time())


def list_tool_invocations(organization_id: str, limit: int = 50, tool_name: str = None) -> list[dict]:
    """Recent audit entries for an org (newest first)."""
    try:
        from ..database import SupabaseDB

        result = SupabaseDB.select(
            "agent_tool_audit",
            columns="id, tool_name, agent_id, user_id, risk_tier, decision, result_status, result_summary, duration_ms, created_at",
            filters={"organization_id": organization_id},
            limit=limit,
        )
        data = getattr(result, "data", result if isinstance(result, list) else [])
        rows = list(data or [])
        if tool_name:
            rows = [r for r in rows if r.get("tool_name") == tool_name]
        return rows
    except Exception as e:
        print(f"[agent_registry] audit list failed: {e}")
        return []
