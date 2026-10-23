import type { AnalyticsAgentId } from "@/lib/documentAgents";
import type { PortfolioFile } from "@/lib/agentWorkspaceKpis";
import type { WorkspaceMetrics } from "@/lib/agentWorkspaceInsights";
import { connectionSummaryLine, type WorkspaceIntegration } from "@/lib/integrationConnections";

/** Operational status only — business KPIs belong on the Command tab. */
export type WorkspacePulseData = {
    /** One-line human summary */
    summary: string;
    chartCoveragePct: number;
    /** Primary recommended action */
    primaryAction: "fix" | "analytics" | "upload" | "none";
    primaryActionLabel: string;
    /** Top issue type for subtitle, if any */
    topIssueLabel?: string;
};

function topIssue(portfolio: PortfolioFile[]): string | undefined {
    const labels: Record<string, string> = {
        no_extraction: "extraction pending",
        missing_amount: "missing amounts",
        not_linked: "not linked to charts",
        processing: "still processing",
    };
    const counts = new Map<string, number>();
    for (const f of portfolio) {
        if (f.inCharts) continue;
        const key = f.status in labels ? labels[f.status] : "needs review";
        counts.set(key, (counts.get(key) || 0) + 1);
    }
    if (!counts.size) return undefined;
    return [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
}

export function deriveWorkspacePulse(
    _agentId: AnalyticsAgentId,
    metrics: WorkspaceMetrics,
    portfolio: PortfolioFile[],
    chartCount: number,
    integrations: WorkspaceIntegration[] = []
): WorkspacePulseData {
    const chartCoveragePct =
        metrics.totalDocs > 0 ? Math.round((metrics.chartedDocs / metrics.totalDocs) * 100) : 0;
    const topIssueLabel = topIssue(portfolio);

    if (metrics.totalDocs === 0) {
        return {
            summary: "No documents in this workspace yet.",
            chartCoveragePct: 0,
            primaryAction: "upload",
            primaryActionLabel: "Upload documents",
        };
    }

    if (metrics.skippedDocs > 0) {
        const issueHint = topIssueLabel ? ` — mostly ${topIssueLabel}` : "";
        return {
            summary: `${metrics.skippedDocs} of ${metrics.totalDocs} files are not chart-ready${issueHint}.`,
            chartCoveragePct,
            primaryAction: "fix",
            primaryActionLabel: `Review ${metrics.skippedDocs} issue${metrics.skippedDocs === 1 ? "" : "s"}`,
            topIssueLabel,
        };
    }

    if (chartCount === 0) {
        return {
            summary: `${metrics.chartedDocs} files ready — ask the agent or open analytics to generate charts.`,
            chartCoveragePct,
            primaryAction: "analytics",
            primaryActionLabel: "Open analytics",
        };
    }

    const feed =
        integrations.length > 0 ? connectionSummaryLine(integrations) : "manual uploads only";
    return {
        summary: `Portfolio is healthy · ${chartCount} live chart${chartCount === 1 ? "" : "s"} · ${feed}.`,
        chartCoveragePct,
        primaryAction: "analytics",
        primaryActionLabel: "View analytics",
    };
}

export type PulseStatusTone = "empty" | "attention" | "ready";

export function pulseStatusTone(metrics: WorkspaceMetrics): PulseStatusTone {
    if (metrics.totalDocs === 0) return "empty";
    if (metrics.skippedDocs > 0 || metrics.healthScore < 85) return "attention";
    return "ready";
}
