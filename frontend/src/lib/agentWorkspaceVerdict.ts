import type { AnalyticsAgentId } from "@/lib/documentAgents";
import type { AttentionItem, WorkspaceMetrics } from "@/lib/agentWorkspaceInsights";
import type { WorkspaceIntegration } from "@/lib/integrationConnections";

export type VerdictStatus = "good" | "attention" | "critical" | "empty";

export type AgentRecommendation = {
    id: string;
    title: string;
    detail?: string;
    impact: "high" | "medium" | "low";
    prompt?: string;
    chartView?: string;
    href?: string;
};

export type PendingAction = {
    id: string;
    title: string;
    detail?: string;
    impact: "high" | "medium" | "low";
    actionLabel: "Approve" | "Review" | "Run" | "Fix" | "Shortlist";
    /** Approve executes shortlist (HR) or document reprocess (all agents). */
    approveKind?: "shortlist" | "reprocess";
    prompt?: string;
    chartView?: string;
    href?: string;
    connectionId?: string;
    documentIds?: string[];
};

export type AgentVerdict = {
    status: VerdictStatus;
    statusLabel: string;
    summary: string;
    recommendations: AgentRecommendation[];
};

type PriorityLike = {
    id: string;
    title: string;
    detail: string;
    tone: "warn" | "info";
    prompt?: string;
    chartView?: string;
    documentIds?: string[];
    approveKind?: "shortlist" | "reprocess";
};

const STATUS_LABEL: Record<VerdictStatus, string> = {
    good: "Portfolio healthy",
    attention: "Needs attention",
    critical: "Action required",
    empty: "Getting started",
};

function verdictStatus(metrics: WorkspaceMetrics, attention: AttentionItem[]): VerdictStatus {
    if (metrics.totalDocs === 0) return "empty";
    const warnings = attention.filter((a) => a.severity === "warning").length;
    if (metrics.healthScore < 45 || warnings >= 3) return "critical";
    if (metrics.healthScore < 85 || warnings > 0 || metrics.skippedDocs > 0) return "attention";
    return "good";
}

function agentSummary(
    agentId: AnalyticsAgentId,
    status: VerdictStatus,
    metrics: WorkspaceMetrics,
    plainSummary: string
): string {
    if (plainSummary && plainSummary.length > 20) {
        return plainSummary.slice(0, 280);
    }
    const agent = agentId.replace("_agent", "").toUpperCase();
    if (status === "empty") {
        return `Upload ${agent} documents or connect an integration to activate this workspace.`;
    }
    if (status === "good") {
        return `${metrics.chartedDocs} of ${metrics.totalDocs} files are chart-ready. Ask the agent for reports, rankings, or analytics.`;
    }
    if (status === "critical") {
        return `Only ${metrics.healthScore}% of your portfolio is ready. Fix extraction gaps before trusting charts and reports.`;
    }
    return `${metrics.chartedDocs}/${metrics.totalDocs} files feeding charts · ${metrics.skippedDocs} need attention.`;
}

function defaultRecommendations(
    agentId: AnalyticsAgentId,
    status: VerdictStatus
): AgentRecommendation[] {
    const map: Record<AnalyticsAgentId, AgentRecommendation[]> = {
        finance_agent: [
            { id: "r-vendors", title: "Review vendor spend", impact: "high", prompt: "Show vendor totals ranked by spend", chartView: "vendors" },
            { id: "r-aging", title: "Check AP aging", impact: "medium", prompt: "Chart AP aging and summarize overdue vendors", chartView: "aging" },
            { id: "r-report", title: "Generate finance report", impact: "medium", prompt: "Generate finance report" },
        ],
        hr_agent: [
            { id: "r-shortlist", title: "Rank top candidates", impact: "high", prompt: "Show CV score ranking", chartView: "scores" },
            { id: "r-offer", title: "Generate offer letters", impact: "high", prompt: "Generate offer letters for top 3 candidates" },
            { id: "r-certs", title: "Check cert expiry", impact: "medium", prompt: "Any certificates expiring in 30 days?", chartView: "expiry" },
        ],
        compliance_agent: [
            { id: "r-expiry", title: "Review expiring certificates", impact: "high", prompt: "Chart certificate expiry", chartView: "expiry" },
            { id: "r-findings", title: "Audit findings summary", impact: "medium", prompt: "Chart audit findings by severity", chartView: "findings" },
            { id: "r-report", title: "Download compliance PDF", impact: "medium", prompt: "Generate compliance report" },
        ],
        procurement_agent: [
            { id: "r-spend", title: "Review supplier spend", impact: "high", prompt: "Chart spend by supplier", chartView: "po_spend" },
            { id: "r-match", title: "Check 3-way match", impact: "medium", prompt: "Show PO invoice match variances", chartView: "po_match" },
            { id: "r-open", title: "Open PO queue", impact: "medium", chartView: "po_status" },
        ],
        legal_agent: [
            { id: "r-risk", title: "Review contract risk", impact: "high", prompt: "Chart risk flags by document", chartView: "risk" },
            { id: "r-clauses", title: "Clause coverage", impact: "medium", chartView: "clauses" },
        ],
        other_agent: [
            { id: "r-mix", title: "Document type mix", impact: "medium", chartView: "doc_mix" },
            { id: "r-search", title: "Cross-document search", impact: "medium", prompt: "Summarize my uploaded documents" },
        ],
    };
    const base = map[agentId] || map.other_agent;
    if (status === "empty") {
        return [{ id: "r-upload", title: "Upload documents", impact: "high", href: "/documents" }];
    }
    return base;
}

function recommendationsFromPriorities(priorities: PriorityLike[]): AgentRecommendation[] {
    return priorities.slice(0, 3).map((p) => ({
        id: p.id,
        title: p.title,
        detail: p.detail,
        impact: p.tone === "warn" ? ("high" as const) : ("medium" as const),
        prompt: p.prompt,
        chartView: p.chartView,
    }));
}

function recommendationsFromAttention(attention: AttentionItem[]): AgentRecommendation[] {
    return attention.slice(0, 3).map((a) => ({
        id: a.id,
        title: a.title,
        detail: a.detail,
        impact: a.severity === "warning" ? ("high" as const) : ("low" as const),
        prompt: a.prompt,
        href: a.href,
    }));
}

export function deriveAgentVerdict(
    agentId: AnalyticsAgentId,
    metrics: WorkspaceMetrics,
    attention: AttentionItem[],
    plainSummary: string,
    priorities?: PriorityLike[]
): AgentVerdict {
    const status = verdictStatus(metrics, attention);
    const recommendations =
        priorities && priorities.length > 0
            ? recommendationsFromPriorities(priorities)
            : attention.length > 0
              ? recommendationsFromAttention(attention)
              : defaultRecommendations(agentId, status);

    return {
        status,
        statusLabel: STATUS_LABEL[status],
        summary: agentSummary(agentId, status, metrics, plainSummary),
        recommendations,
    };
}

const REPROCESS_PRIORITY_IDS = new Set(["missing-amount", "fix"]);

export function derivePendingActions(
    agentId: AnalyticsAgentId,
    metrics: WorkspaceMetrics,
    attention: AttentionItem[],
    priorities: PriorityLike[] | undefined,
    integrations: WorkspaceIntegration[],
    options?: { skippedDocumentIds?: string[] }
): PendingAction[] {
    const actions: PendingAction[] = [];
    const skippedDocumentIds = options?.skippedDocumentIds?.filter(Boolean) ?? [];

    for (const p of (priorities || []).filter((x) => x.tone === "warn").slice(0, 3)) {
        const shortlistPending =
            (p.approveKind === "shortlist" || p.id === "unscored-cvs") &&
            (p.documentIds?.length ?? 0) > 0;
        const reprocessPending =
            (p.approveKind === "reprocess" || REPROCESS_PRIORITY_IDS.has(p.id)) &&
            (p.documentIds?.length ?? 0) > 0;
        const canApprove = shortlistPending || reprocessPending || Boolean(p.prompt);
        actions.push({
            id: `priority-${p.id}`,
            title: p.title,
            detail: p.detail,
            impact: "high",
            actionLabel: canApprove ? "Approve" : "Review",
            approveKind: shortlistPending ? "shortlist" : reprocessPending ? "reprocess" : undefined,
            prompt: shortlistPending || reprocessPending ? undefined : p.prompt,
            chartView: p.id === "unscored-cvs" ? undefined : p.chartView,
            documentIds: p.documentIds,
        });
    }

    for (const a of attention.filter((x) => x.severity === "warning").slice(0, 2)) {
        if (actions.some((x) => x.title === a.title)) continue;
        actions.push({
            id: `attn-${a.id}`,
            title: a.title,
            detail: a.detail,
            impact: "medium",
            actionLabel: a.href ? "Review" : "Fix",
            prompt: a.prompt,
            href: a.href,
        });
    }

    const syncable = integrations.filter(
        (c) => c.isActive && (c.providerId === "clickup" || c.providerId === "google_drive")
    );
    for (const conn of syncable.slice(0, 1)) {
        const stale =
            !conn.lastSyncAt ||
            Date.now() - new Date(conn.lastSyncAt).getTime() > 24 * 60 * 60 * 1000;
        if (stale) {
            actions.push({
                id: `sync-${conn.connectionId}`,
                title: `Sync ${conn.label}`,
                detail: "Pull latest files from your connected system.",
                impact: "medium",
                actionLabel: "Run",
                connectionId: conn.connectionId,
            });
        }
    }

    const hasSkippedPriority = actions.some(
        (a) => a.id === "priority-fix" || a.id === "fix-skipped"
    );
    if (metrics.skippedDocs > 0 && !hasSkippedPriority) {
        const canReprocess = skippedDocumentIds.length > 0;
        actions.push({
            id: "fix-skipped",
            title: `${metrics.skippedDocs} file${metrics.skippedDocs === 1 ? "" : "s"} not in charts`,
            detail: "Approve to reprocess extraction gaps for full portfolio coverage.",
            impact: metrics.skippedDocs >= 3 ? "high" : "medium",
            actionLabel: canReprocess ? "Approve" : "Fix",
            approveKind: canReprocess ? "reprocess" : undefined,
            documentIds: canReprocess ? skippedDocumentIds : undefined,
            prompt: canReprocess ? undefined : `Why are ${metrics.skippedDocs} files not in charts?`,
        });
    }

    if (actions.length === 0 && metrics.totalDocs > 0) {
        const ask: Record<AnalyticsAgentId, string> = {
            finance_agent: "Generate finance report",
            hr_agent: "Generate HR report",
            compliance_agent: "Generate compliance report",
            procurement_agent: "Summarize open purchase orders",
            legal_agent: "Summarize contract risk across portfolio",
            other_agent: "Summarize my documents",
        };
        actions.push({
            id: "default-run",
            title: "Run agent report",
            detail: "Portfolio looks ready — generate a summary PDF or chart view.",
            impact: "low",
            actionLabel: "Approve",
            prompt: ask[agentId],
        });
    }

    return actions.slice(0, 5);
}

export const AGENT_WORKFLOW_STEPS: Record<
    AnalyticsAgentId,
    Array<{ label: string; detail: string }>
> = {
    finance_agent: [
        { label: "Ingest", detail: "Upload invoices or push from ERP/webhook" },
        { label: "Classify", detail: "AP, AR, banking, tax" },
        { label: "Extract", detail: "Amounts, vendors, clients, dates" },
        { label: "Analyze", detail: "Aging, spend, trends" },
        { label: "Act", detail: "Reports, flags, chat commands" },
    ],
    hr_agent: [
        { label: "Ingest", detail: "Upload CVs or sync ClickUp/Drive" },
        { label: "Classify", detail: "CV, cert, payroll, leave" },
        { label: "Extract", detail: "Skills, scores, expiry dates" },
        { label: "Analyze", detail: "Shortlist, directory, expiry" },
        { label: "Act", detail: "Offers, outreach, HR reports" },
    ],
    compliance_agent: [
        { label: "Ingest", detail: "Upload certs and audit files" },
        { label: "Classify", detail: "Certificates, audits, policies" },
        { label: "Extract", detail: "Expiry, findings, status" },
        { label: "Analyze", detail: "Posture, expiry, findings" },
        { label: "Act", detail: "Compliance PDF reports" },
    ],
    procurement_agent: [
        { label: "Ingest", detail: "Upload POs, RFQs, invoices" },
        { label: "Classify", detail: "PO, supplier, match docs" },
        { label: "Extract", detail: "Spend, status, variances" },
        { label: "Analyze", detail: "Spend, open POs, match" },
        { label: "Act", detail: "Review queue, supplier charts" },
    ],
    legal_agent: [
        { label: "Ingest", detail: "Upload contracts and agreements" },
        { label: "Classify", detail: "Contract type and parties" },
        { label: "Extract", detail: "Clauses, risk, obligations" },
        { label: "Analyze", detail: "Risk and clause mix" },
        { label: "Act", detail: "Flags, summaries, chat" },
    ],
    other_agent: [
        { label: "Ingest", detail: "Upload any document type" },
        { label: "Classify", detail: "Auto-detect document type" },
        { label: "Extract", detail: "Key fields and text" },
        { label: "Analyze", detail: "Search and summaries" },
        { label: "Act", detail: "Chat and exports" },
    ],
};

export function deriveRowAgentAction(
    agentId: AnalyticsAgentId,
    context: { score?: number; statusTone?: string; status?: string }
): string {
    if (agentId === "hr_agent" && context.score != null) {
        if (context.score >= 80) return "Shortlist";
        if (context.score >= 60) return "Review CV";
        return "Archive";
    }
    if (agentId === "finance_agent") {
        if (context.statusTone === "overdue" || /overdue/i.test(context.status || "")) return "Follow up";
        return "View AP";
    }
    if (agentId === "compliance_agent") {
        if (/expir/i.test(context.status || "")) return "Renew";
        return "Review";
    }
    if (agentId === "procurement_agent") {
        if (/discrepancy|review/i.test(context.status || "")) return "Match review";
        return "Track PO";
    }
    return "Open";
}
