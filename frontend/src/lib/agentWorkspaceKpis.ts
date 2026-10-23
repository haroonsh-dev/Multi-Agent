import type { AnalyticsAgentId } from "@/lib/documentAgents";
import type { ChatVisualSpec } from "@/types/chatVisuals";
import type { WorkspaceCoverage, WorkspaceMetrics } from "@/lib/agentWorkspaceInsights";

export type SpotlightKpi = {
    label: string;
    value: string;
    hint?: string;
    tone?: "default" | "success" | "warn" | "accent";
};

export type PortfolioFile = {
    documentId: string;
    filename: string;
    status: string;
    detail?: string;
    inCharts: boolean;
};

function sumVisual(
    visuals: ChatVisualSpec[],
    titleMatch: RegExp,
    currencyOnly = true
): { total: number; currency?: string; rows: number } {
    const v = visuals.find((x) => titleMatch.test(x.title));
    if (!v?.series[0]?.key) return { total: 0, rows: 0 };
    const key = v.series[0].key;
    const total = v.data.reduce((s, row) => s + Number(row[key] || 0), 0);
    return { total, currency: currencyOnly ? v.currency : undefined, rows: v.data.length };
}

function fmtMoney(amount: number, currency?: string): string {
    if (!currency) return amount.toLocaleString(undefined, { maximumFractionDigits: 0 });
    return `${currency} ${amount.toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
}

export function deriveSpotlightKpis(
    agentId: AnalyticsAgentId,
    visuals: ChatVisualSpec[],
    coverage: WorkspaceCoverage,
    metrics: WorkspaceMetrics
): SpotlightKpi[] {
    const base: SpotlightKpi[] = [
        {
            label: "Portfolio",
            value: String(metrics.totalDocs),
            hint: `${metrics.chartedDocs} chart-ready`,
            tone: metrics.totalDocs > 0 ? "success" : "default",
        },
        {
            label: "Readiness",
            value: `${metrics.healthScore}%`,
            hint: metrics.healthLabel,
            tone: metrics.healthScore >= 85 ? "success" : metrics.healthScore >= 45 ? "accent" : "warn",
        },
    ];

    if (agentId === "finance_agent") {
        const vendors = sumVisual(visuals, /vendor|AP/i);
        const clients = sumVisual(visuals, /client|AR/i);
        const aging = visuals.find((v) => /aging/i.test(v.title));
        const kpis: SpotlightKpi[] = [...base];
        if (vendors.total > 0) {
            kpis.push({
                label: "AP · Vendors",
                value: fmtMoney(vendors.total, vendors.currency),
                hint: `${vendors.rows} vendor${vendors.rows === 1 ? "" : "s"}`,
                tone: "accent",
            });
        }
        if (clients.total > 0) {
            kpis.push({
                label: "AR · Clients",
                value: fmtMoney(clients.total, clients.currency),
                hint: `${clients.rows} client${clients.rows === 1 ? "" : "s"}`,
                tone: "accent",
            });
        }
        if (coverage && "documentsWithAmount" in coverage) {
            kpis.push({
                label: "With amounts",
                value: String(coverage.documentsWithAmount),
                hint: `${coverage.documentsWithVendor} vendors · ${coverage.documentsWithClient} clients`,
            });
        }
        if (aging) {
            kpis.push({
                label: "Aging view",
                value: "Ready",
                hint: "Open Charts → AP Aging",
                tone: "success",
            });
        }
        return kpis.slice(0, 6) as SpotlightKpi[];
    }

    if (agentId === "hr_agent") {
        const scores = sumVisual(visuals, /score|cv/i, false);
        const expiring = coverage && "documentsWithExpiry" in coverage ? coverage.documentsWithExpiry : null;
        return [
            ...base,
            {
                label: "CV profiles",
                value: scores.rows > 0 ? String(scores.rows) : "—",
                hint: scores.rows > 0 ? "In score charts" : "Upload CVs to rank",
            },
            {
                label: "Certs tracked",
                value: expiring != null ? String(expiring) : "—",
                hint: "Expiry & training certs",
                tone: (expiring && expiring > 0 ? "warn" : "default") as SpotlightKpi["tone"],
            },
            {
                label: "Charts",
                value: String(visuals.length),
                hint: "Leave, payroll, directory…",
            },
        ].slice(0, 6) as SpotlightKpi[];
    }

    if (agentId === "compliance_agent") {
        const register = visuals.find(
            (v) => v.id === "compliance_cert_register" || /certificate.*register/i.test(v.title)
        );
        let expiring = 0;
        let expired = 0;
        if (register?.data.length) {
            for (const row of register.data) {
                const st = String(row.status || "").toUpperCase();
                if (st.includes("EXPIRING")) expiring++;
                if (st.includes("EXPIRED")) expired++;
            }
        }
        const findingsVisual = visuals.find((v) => /findings by severity/i.test(v.title));
        const findingTotal = findingsVisual?.data.reduce((s, r) => s + Number(r.count || 0), 0) ?? 0;
        const expiryCov =
            coverage && "documentsWithExpiry" in coverage ? coverage.documentsWithExpiry : undefined;
        return [
            ...base,
            {
                label: "Certs tracked",
                value:
                    expiryCov != null && expiryCov > 0
                        ? String(expiryCov)
                        : register?.data.length
                          ? String(register.data.length)
                          : "—",
                hint: "With expiry or status",
                tone: ((expiryCov ?? 0) > 0 ? "accent" : "default") as SpotlightKpi["tone"],
            },
            {
                label: "Expiring / expired",
                value: expiring + expired > 0 ? String(expiring + expired) : "—",
                hint: expiring + expired > 0 ? "Renewal queue" : "All clear",
                tone: (expiring + expired > 0 ? "warn" : "success") as SpotlightKpi["tone"],
            },
            {
                label: "Findings",
                value: findingTotal > 0 ? String(findingTotal) : "—",
                hint: findingTotal > 0 ? "Across audits" : "None extracted",
                tone: (findingTotal > 0 ? "warn" : "success") as SpotlightKpi["tone"],
            },
        ].slice(0, 6) as SpotlightKpi[];
    }

    if (agentId === "legal_agent") {
        const risk = sumVisual(visuals, /risk/i, false);
        const clauses = sumVisual(visuals, /clause/i, false);
        return [
            ...base,
            {
                label: "Risk flags",
                value: risk.rows > 0 ? String(risk.rows) : "—",
                hint: "Documents with risk data",
                tone: (risk.rows > 0 ? "warn" : "default") as SpotlightKpi["tone"],
            },
            {
                label: "Clause types",
                value: clauses.rows > 0 ? String(clauses.rows) : "—",
                hint: "Clause mix in portfolio",
            },
            { label: "Charts", value: String(visuals.length), hint: "Risk, clauses, missing" },
        ].slice(0, 6) as SpotlightKpi[];
    }

    if (agentId === "procurement_agent") {
        const spend = sumVisual(visuals, /spend|supplier/i);
        const register = visuals.find((v) => v.id === "procurement_kpi_grid" || /order register/i.test(v.title));
        let openCount = 0;
        let reviewCount = 0;
        if (register?.data.length) {
            for (const row of register.data) {
                const st = String(row.status || "").toUpperCase();
                if (st.includes("OPEN") || st.includes("PENDING")) openCount++;
                if (st.includes("DISCREPANCY")) reviewCount++;
            }
        }
        return [
            ...base,
            {
                label: "Committed spend",
                value: spend.total > 0 ? fmtMoney(spend.total, spend.currency) : "—",
                hint: spend.rows > 0 ? `${spend.rows} suppliers` : "Add POs with amounts",
                tone: (spend.total > 0 ? "accent" : "default") as SpotlightKpi["tone"],
            },
            {
                label: "Open POs",
                value: openCount > 0 ? String(openCount) : "—",
                hint: openCount > 0 ? "Pending delivery" : "All clear",
                tone: (openCount > 0 ? "warn" : "default") as SpotlightKpi["tone"],
            },
            {
                label: "Needs review",
                value: reviewCount > 0 ? String(reviewCount) : "—",
                hint: reviewCount > 0 ? "Match variances" : "None flagged",
                tone: (reviewCount > 0 ? "warn" : "success") as SpotlightKpi["tone"],
            },
        ].slice(0, 6) as SpotlightKpi[];
    }

    return [
        ...base,
        {
            label: "Charts",
            value: String(visuals.length),
            hint: metrics.skippedDocs > 0 ? `${metrics.skippedDocs} need attention` : "All clear",
        },
        {
            label: "Issues",
            value: String(metrics.skippedDocs),
            hint: metrics.skippedDocs === 0 ? "None" : "See Fix tab",
            tone: (metrics.skippedDocs > 0 ? "warn" : "success") as SpotlightKpi["tone"],
        },
    ].slice(0, 6) as SpotlightKpi[];
}

/** Agent-specific chart shortcuts → analytics view id */
export const AGENT_CHART_SHORTCUTS: Record<
    AnalyticsAgentId,
    Array<{ label: string; view: string; prompt?: string }>
> = {
    finance_agent: [
        { label: "AP vendors", view: "vendors" },
        { label: "AR clients", view: "clients" },
        { label: "Trend", view: "trend" },
        { label: "AP aging", view: "aging" },
    ],
    hr_agent: [
        { label: "CV scores", view: "scores" },
        { label: "Leave", view: "leave" },
        { label: "Payroll", view: "payroll" },
        { label: "Directory", view: "directory" },
    ],
    compliance_agent: [
        { label: "Cert expiry", view: "expiry" },
        { label: "Findings", view: "findings" },
        { label: "Posture", view: "status_mix" },
    ],
    legal_agent: [
        { label: "Risk", view: "risk" },
        { label: "Clauses", view: "clauses" },
        { label: "Missing", view: "missing" },
    ],
    procurement_agent: [
        { label: "Spend", view: "po_spend" },
        { label: "PO status", view: "po_status" },
        { label: "3-way match", view: "po_match" },
    ],
    other_agent: [{ label: "Doc mix", view: "doc_mix" }],
};

export function getPortfolioFiles(coverage: WorkspaceCoverage): PortfolioFile[] {
    if (!coverage?.files?.length) return [];
    return mapCoverageFiles(coverage.files);
}

function mapCoverageFiles(
    files: NonNullable<NonNullable<WorkspaceCoverage>["files"]>
): PortfolioFile[] {
    return [...files]
        .map((f) => ({
            documentId: f.documentId,
            filename: f.filename,
            status: f.status,
            detail: f.detail,
            inCharts: f.status === "in_charts",
        }))
        .sort((a, b) => {
            if (a.inCharts !== b.inCharts) return a.inCharts ? 1 : -1;
            return a.filename.localeCompare(b.filename);
        });
}

/** Merge analytics coverage files with vault documents (fills gaps when coverage.files is partial). */
export function mergePortfolioFiles(
    coverage: WorkspaceCoverage,
    vaultDocs: Array<{
        documentId: string;
        originalFilename: string;
        status?: string | null;
    }>
): PortfolioFile[] {
    const fromCoverage = coverage?.files?.length ? mapCoverageFiles(coverage.files) : [];
    const byId = new Map(fromCoverage.map((f) => [f.documentId, f]));

    for (const doc of vaultDocs) {
        if (byId.has(doc.documentId)) continue;
        const processing = String(doc.status || "").toLowerCase();
        byId.set(doc.documentId, {
            documentId: doc.documentId,
            filename: doc.originalFilename,
            status:
                processing === "processing" || processing === "uploaded"
                    ? "processing"
                    : processing === "failed"
                      ? "no_extraction"
                      : "not_linked",
            detail: processing === "ready" ? "In vault — not yet in charts" : undefined,
            inCharts: false,
        });
    }

    return [...byId.values()].sort((a, b) => {
        if (a.inCharts !== b.inCharts) return a.inCharts ? 1 : -1;
        return a.filename.localeCompare(b.filename);
    });
}
