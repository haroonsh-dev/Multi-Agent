import type { AnalyticsAgentId } from "@/lib/documentAgents";
import type {
    AgentAnalyticsCoverage,
    ComplianceAnalyticsCoverage,
    FinanceAnalyticsCoverage,
} from "@/types/chatVisuals";

export type WorkspaceCoverage =
    | FinanceAnalyticsCoverage
    | ComplianceAnalyticsCoverage
    | AgentAnalyticsCoverage
    | null;

export type AttentionItem = {
    id: string;
    severity: "warning" | "info";
    title: string;
    detail?: string;
    href?: string;
    prompt?: string;
};

export type WorkspaceMetrics = {
    healthScore: number;
    healthLabel: "Ready" | "Partial" | "Empty" | "Needs work";
    totalDocs: number;
    chartedDocs: number;
    skippedDocs: number;
    integrationCount: number;
};

type CoverageFile = NonNullable<FinanceAnalyticsCoverage["files"]>[number];

function coverageFiles(coverage: WorkspaceCoverage): CoverageFile[] {
    if (!coverage?.files?.length) return [];
    return coverage.files;
}

function countCharted(coverage: WorkspaceCoverage): number {
    const files = coverageFiles(coverage);
    if (files.length) return files.filter((f) => f.status === "in_charts").length;
    if (coverage && "documentsCharted" in coverage && typeof coverage.documentsCharted === "number") {
        return coverage.documentsCharted;
    }
    return 0;
}

function countSkipped(coverage: WorkspaceCoverage): number {
    const files = coverageFiles(coverage);
    if (files.length) return files.filter((f) => f.status !== "in_charts").length;
    const inScope = coverage?.documentsInScope ?? 0;
    const charted = countCharted(coverage);
    return Math.max(0, inScope - charted);
}

export function deriveWorkspaceMetrics(
    documentCount: number | undefined,
    coverage: WorkspaceCoverage,
    integrationCount: number
): WorkspaceMetrics {
    const totalDocs = coverage?.documentsInScope ?? documentCount ?? 0;
    const chartedDocs = countCharted(coverage);
    const skippedDocs = countSkipped(coverage);

    let healthScore = 0;
    let healthLabel: WorkspaceMetrics["healthLabel"] = "Empty";

    if (totalDocs === 0) {
        healthScore = 0;
        healthLabel = "Empty";
    } else if (chartedDocs === 0 && skippedDocs > 0) {
        healthScore = Math.max(8, Math.round((chartedDocs / totalDocs) * 100));
        healthLabel = "Needs work";
    } else {
        healthScore = Math.round((chartedDocs / totalDocs) * 100);
        if (healthScore >= 85) healthLabel = "Ready";
        else if (healthScore >= 45) healthLabel = "Partial";
        else healthLabel = "Needs work";
    }

    return {
        healthScore,
        healthLabel,
        totalDocs,
        chartedDocs,
        skippedDocs,
        integrationCount,
    };
}

export function deriveAttentionItems(
    agentId: AnalyticsAgentId,
    coverage: WorkspaceCoverage,
    documentCount: number | undefined
): AttentionItem[] {
    const items: AttentionItem[] = [];
    const totalDocs = coverage?.documentsInScope ?? documentCount ?? 0;

    if (totalDocs === 0) {
        items.push({
            id: "empty",
            severity: "info",
            title: "No documents yet",
            detail: "Upload files or connect an integration for this agent.",
            href: "/documents",
        });
        return items;
    }

    for (const [i, w] of (coverage?.warnings || []).slice(0, 3).entries()) {
        items.push({
            id: `warn-${i}`,
            severity: "warning",
            title: w.replace(/\*\*/g, "").slice(0, 120),
            prompt: w.replace(/\*\*/g, "").slice(0, 200),
        });
    }

    for (const f of coverageFiles(coverage).filter((file) => file.status !== "in_charts").slice(0, 4)) {
        const label =
            f.status === "no_extraction"
                ? "Needs extraction"
                : f.status === "unsupported_format"
                  ? "Unsupported format"
                  : f.status === "missing_amount"
                    ? "Missing amounts"
                    : f.status === "not_linked"
                      ? "Not linked to charts"
                      : "Not in charts";
        items.push({
            id: `file-${f.documentId}`,
            severity: "warning",
            title: f.filename,
            detail: f.detail || label,
            href: `/documents/${f.documentId}/details`,
            prompt: `Why is ${f.filename} not in charts?`,
        });
    }

    if (items.length === 0) {
        items.push({
            id: "all-clear",
            severity: "info",
            title: "Portfolio looks good",
            detail: `All ${totalDocs} document${totalDocs === 1 ? "" : "s"} are ready for ${agentId.replace("_agent", "")} insights.`,
            prompt: getDefaultAskPrompt(agentId),
        });
    }

    return items.slice(0, 6);
}

export function getDefaultAskPrompt(agentId: AnalyticsAgentId): string {
    const defaults: Record<AnalyticsAgentId, string> = {
        finance_agent: "Show vendor totals and AP aging",
        hr_agent: "Any certificates expiring soon?",
        compliance_agent: "Chart certificate expiry and audit findings",
        legal_agent: "Chart risk flags by document",
        procurement_agent: "Chart spend by supplier",
        other_agent: "Show document type mix",
    };
    return defaults[agentId];
}

export function getSkippedFiles(coverage: WorkspaceCoverage): CoverageFile[] {
    return coverageFiles(coverage).filter((f) => f.status !== "in_charts");
}

/** Document IDs for Action Center Approve → reprocess (all agents). */
export function getSkippedDocumentIds(coverage: WorkspaceCoverage): string[] {
    return getSkippedFiles(coverage)
        .map((f) => f.documentId)
        .filter(Boolean);
}

export function getMissingAmountDocumentIds(coverage: WorkspaceCoverage): string[] {
    return coverageFiles(coverage)
        .filter((f) => f.status === "missing_amount")
        .map((f) => f.documentId)
        .filter(Boolean);
}
