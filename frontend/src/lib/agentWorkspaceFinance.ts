import type { ChatVisualSpec, FinanceAnalyticsCoverage } from "@/types/chatVisuals";
import type { PortfolioFile } from "@/lib/agentWorkspaceKpis";
import {
    getMissingAmountDocumentIds,
    getSkippedDocumentIds,
    type WorkspaceCoverage,
    type WorkspaceMetrics,
} from "@/lib/agentWorkspaceInsights";
import type { AgentVaultDoc } from "@/hooks/useAgentPortfolio";
import { docTypeLabel, inferDocTypeFromFilename } from "@/lib/documentAgents";

export type FinPillarId = "ap" | "ar" | "banking" | "tax";

export type FinPillar = {
    id: FinPillarId;
    label: string;
    subtitle: string;
    count: number;
    chartView?: string;
    askPrompt: string;
    status: "ready" | "partial" | "empty";
};

export type FinPriority = {
    id: string;
    title: string;
    detail: string;
    tone: "warn" | "info";
    prompt?: string;
    chartView?: string;
    documentIds?: string[];
    approveKind?: "shortlist" | "reprocess";
};

export type FinanceSnapshot = {
    headline: string;
    subline: string;
    pillars: FinPillar[];
    priorities: FinPriority[];
    docMix: Array<{ type: string; label: string; count: number }>;
    stats: {
        totalFiles: number;
        apSpend: number;
        arTotal: number;
        currency: string;
        vendorCount: number;
        clientCount: number;
        overdueAmount: number;
        missingAmountCount: number;
        topVendorShare?: number;
    };
};

export type InvoiceRegisterRow = {
    rank: number;
    ref: string;
    counterparty: string;
    amount: string;
    status: string;
    statusTone: "current" | "overdue" | "unknown";
    documentId?: string;
    agentAction: string;
};

const PILLAR_TYPES: Record<FinPillarId, string[]> = {
    ap: ["invoice", "expense_report", "payment_receipt"],
    ar: ["financial_statement"],
    banking: ["bank_statement", "budget"],
    tax: ["tax_document"],
};

const PILLAR_META: Record<FinPillarId, { label: string; subtitle: string; chartView?: string; askPrompt: string }> = {
    ap: {
        label: "Accounts payable",
        subtitle: "Vendor invoices, expenses, and payment receipts",
        chartView: "vendors",
        askPrompt: "Show vendor totals ranked by spend",
    },
    ar: {
        label: "Accounts receivable",
        subtitle: "Client billing and receivable statements",
        chartView: "clients",
        askPrompt: "Show client totals ranked by revenue",
    },
    banking: {
        label: "Banking & GL",
        subtitle: "Bank statements, budgets, and period close",
        chartView: "trend",
        askPrompt: "Chart invoice trend by month",
    },
    tax: {
        label: "Tax & compliance",
        subtitle: "Tax filings and statutory documents",
        chartView: "mix",
        askPrompt: "Show finance document type mix",
    },
};

function resolveDocType(doc: AgentVaultDoc): string {
    const cls = String(doc.classification || "").trim().toLowerCase();
    if (cls && cls !== "unclassified" && cls !== "other") return cls;
    return inferDocTypeFromFilename(doc.originalFilename || "") || "invoice";
}

function countByPillar(vaultDocs: AgentVaultDoc[]): Record<FinPillarId, number> {
    const counts: Record<FinPillarId, number> = { ap: 0, ar: 0, banking: 0, tax: 0 };
    for (const doc of vaultDocs) {
        const type = resolveDocType(doc);
        for (const [pillar, types] of Object.entries(PILLAR_TYPES) as [FinPillarId, string[]][]) {
            if (types.includes(type)) counts[pillar]++;
        }
    }
    return counts;
}

function docMix(vaultDocs: AgentVaultDoc[]): FinanceSnapshot["docMix"] {
    const counts = new Map<string, number>();
    for (const doc of vaultDocs) {
        const type = resolveDocType(doc);
        counts.set(type, (counts.get(type) || 0) + 1);
    }
    return [...counts.entries()]
        .map(([type, count]) => ({ type, label: docTypeLabel(type), count }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 6);
}

function apStats(visuals: ChatVisualSpec[]) {
    const visual =
        visuals.find((v) => /payable.*vendor|AP.*vendor/i.test(v.title) && v.kind === "bar") ||
        visuals.find((v) => /vendor/i.test(v.title) && v.kind === "bar");
    if (!visual?.data.length) {
        return { apSpend: 0, currency: "USD", vendorCount: 0, topVendorShare: undefined as number | undefined };
    }
    const key = visual.series[0]?.key || "amount";
    const amounts = visual.data.map((r) => Number(r[key] || 0)).filter((n) => Number.isFinite(n) && n > 0);
    const apSpend = amounts.reduce((s, n) => s + n, 0);
    const top = amounts.length ? Math.max(...amounts) : 0;
    return {
        apSpend,
        currency: visual.currency || "USD",
        vendorCount: visual.data.length,
        topVendorShare: apSpend > 0 && top > 0 ? Math.round((top / apSpend) * 100) : undefined,
    };
}

function arStats(visuals: ChatVisualSpec[]) {
    const visual = visuals.find((v) => /receivable.*client|AR.*client/i.test(v.title) && v.kind === "bar");
    if (!visual?.data.length) return { arTotal: 0, clientCount: 0 };
    const key = visual.series[0]?.key || "amount";
    const amounts = visual.data.map((r) => Number(r[key] || 0)).filter((n) => Number.isFinite(n) && n > 0);
    return {
        arTotal: amounts.reduce((s, n) => s + n, 0),
        clientCount: visual.data.length,
    };
}

function agingStats(visuals: ChatVisualSpec[]) {
    const aging = visuals.find((v) => /aging/i.test(v.title));
    if (!aging?.data.length) return { overdueAmount: 0 };
    const key = aging.series[0]?.key || "amount";
    let overdueAmount = 0;
    for (const row of aging.data) {
        const bucket = String(row.bucket || row.category || "");
        if (/current|not due/i.test(bucket)) continue;
        overdueAmount += Number(row[key] || 0) || 0;
    }
    return { overdueAmount };
}

export function extractVendorRegister(visuals: ChatVisualSpec[], limit = 12): InvoiceRegisterRow[] {
    const visual =
        visuals.find((v) => /payable.*vendor|AP.*vendor/i.test(v.title) && v.kind === "bar") ||
        visuals.find((v) => /vendor/i.test(v.title) && v.kind === "bar" && !/client/i.test(v.title));
    if (!visual?.data.length) return [];

    const key = visual.series[0]?.key || "amount";
    const currency = visual.currency || "USD";

    return visual.data.slice(0, limit).map((row, i) => {
        const amount = Number(row[key] || 0);
        return {
            rank: i + 1,
            ref: String(row.vendor || row.category || "—"),
            counterparty: String(row.vendor || row.category || "—"),
            amount: Number.isFinite(amount) ? `${currency} ${Math.round(amount).toLocaleString()}` : "—",
            status: "AP balance",
            statusTone: "current" as const,
            documentId: row._documentIds ? String(row._documentIds).split(",")[0] : undefined,
            agentAction: "View AP",
        };
    });
}

export function extractOverdueQueue(visuals: ChatVisualSpec[], limit = 8): InvoiceRegisterRow[] {
    const aging = visuals.find((v) => /aging/i.test(v.title));
    if (!aging?.data.length) return [];

    const key = aging.series[0]?.key || "amount";
    const currency = aging.currency || "USD";
    const rows: InvoiceRegisterRow[] = [];

    for (const row of aging.data) {
        const bucket = String(row.bucket || "");
        if (/current|not due/i.test(bucket)) continue;
        const amount = Number(row[key] || 0);
        if (!Number.isFinite(amount) || amount <= 0) continue;
        rows.push({
            rank: rows.length + 1,
            ref: bucket,
            counterparty: "Multiple vendors",
            amount: `${currency} ${Math.round(amount).toLocaleString()}`,
            status: "Overdue",
            statusTone: "overdue",
            documentId: row._documentIds ? String(row._documentIds).split(",")[0] : undefined,
            agentAction: "Follow up",
        });
        if (rows.length >= limit) break;
    }
    return rows;
}

export function deriveFinanceSnapshot(
    vaultDocs: AgentVaultDoc[],
    visuals: ChatVisualSpec[],
    coverage: WorkspaceCoverage | FinanceAnalyticsCoverage | null,
    metrics: WorkspaceMetrics
): FinanceSnapshot {
    const pillarCounts = countByPillar(vaultDocs);
    const ap = apStats(visuals);
    const ar = arStats(visuals);
    const aging = agingStats(visuals);
    const currency = ap.currency;

    const missingAmountIds = getMissingAmountDocumentIds(coverage);
    const skippedIds = getSkippedDocumentIds(coverage);
    const missingAmountCount =
        missingAmountIds.length > 0
            ? missingAmountIds.length
            : coverage && "documentsWithAmount" in coverage
              ? Math.max(0, (coverage.documentsInScope || metrics.totalDocs) - (coverage.documentsWithAmount || 0))
              : 0;

    const pillars: FinPillar[] = (Object.keys(PILLAR_META) as FinPillarId[]).map((id) => {
        const count = pillarCounts[id];
        const meta = PILLAR_META[id];
        return {
            id,
            label: meta.label,
            subtitle: meta.subtitle,
            count,
            chartView: meta.chartView,
            askPrompt: meta.askPrompt,
            status: count === 0 ? "empty" : count >= 3 ? "ready" : "partial",
        };
    });

    const priorities: FinPriority[] = [];

    if (aging.overdueAmount > 0) {
        priorities.push({
            id: "overdue",
            title: `${currency} ${Math.round(aging.overdueAmount).toLocaleString()} past due`,
            detail: "Review AP aging buckets and follow up with vendors on overdue payables.",
            tone: "warn",
            chartView: "aging",
            prompt: "Chart AP aging and summarize overdue vendors",
        });
    }
    if (missingAmountCount > 0) {
        priorities.push({
            id: "missing-amount",
            title: `${missingAmountCount} file${missingAmountCount === 1 ? "" : "s"} missing amounts`,
            detail: "Approve to reprocess invoices so vendor totals and aging charts populate.",
            tone: "warn",
            documentIds: missingAmountIds.length ? missingAmountIds : undefined,
            approveKind: missingAmountIds.length ? "reprocess" : undefined,
            prompt: missingAmountIds.length
                ? undefined
                : "Which invoices are missing total_amount in extraction?",
        });
    }
    if (metrics.skippedDocs > 0) {
        priorities.push({
            id: "fix",
            title: `${metrics.skippedDocs} file${metrics.skippedDocs === 1 ? "" : "s"} not in charts`,
            detail: "Approve to reprocess extraction gaps for full AP/AR portfolio views.",
            tone: "warn",
            documentIds: skippedIds.length ? skippedIds : undefined,
            approveKind: skippedIds.length ? "reprocess" : undefined,
            prompt: skippedIds.length ? undefined : "Why are some finance files not in charts?",
        });
    }
    if (ap.topVendorShare != null && ap.topVendorShare >= 35) {
        priorities.push({
            id: "concentration",
            title: `Top vendor = ${ap.topVendorShare}% of AP spend`,
            detail: "Review vendor concentration and payment terms.",
            tone: "info",
            chartView: "vendors",
            prompt: "Show vendor totals and flag concentration risk",
        });
    }
    if (pillarCounts.ap > 0 && pillarCounts.ar === 0 && ar.clientCount === 0) {
        priorities.push({
            id: "ar-empty",
            title: "AR portfolio empty",
            detail: "Upload client invoices or receivable statements for AR charts.",
            tone: "info",
            chartView: "clients",
            prompt: "Show client totals ranked by revenue",
        });
    }
    if (priorities.length === 0 && metrics.totalDocs > 0) {
        priorities.push({
            id: "healthy",
            title: "Finance portfolio looks chart-ready",
            detail: "Run AP aging or generate a finance report PDF.",
            tone: "info",
            prompt: "Generate finance report",
        });
    }

    let headline = "Build your finance control tower";
    let subline = "Upload AP invoices, AR statements, bank files, and tax docs — connect ERP feeds via Integrations.";
    if (metrics.totalDocs > 0) {
        const parts: string[] = [];
        if (pillarCounts.ap > 0) parts.push(`${pillarCounts.ap} AP`);
        if (pillarCounts.ar > 0 || ar.clientCount > 0) parts.push(`${Math.max(pillarCounts.ar, ar.clientCount)} AR`);
        if (pillarCounts.banking > 0) parts.push(`${pillarCounts.banking} banking`);
        if (pillarCounts.tax > 0) parts.push(`${pillarCounts.tax} tax`);
        headline = parts.length ? parts.join(" · ") : `${metrics.totalDocs} finance files`;
        subline =
            metrics.skippedDocs > 0
                ? `${metrics.chartedDocs} of ${metrics.totalDocs} files feeding charts — fix gaps for full AP/AR views.`
                : ap.apSpend > 0
                  ? `${currency} ${Math.round(ap.apSpend).toLocaleString()} AP · ${visuals.length} live chart${visuals.length === 1 ? "" : "s"}`
                  : `${metrics.chartedDocs} files chart-ready · ${visuals.length} live view${visuals.length === 1 ? "" : "s"}`;
    }

    return {
        headline,
        subline,
        pillars,
        priorities: priorities.slice(0, 4),
        docMix: docMix(vaultDocs),
        stats: {
            totalFiles: metrics.totalDocs,
            apSpend: ap.apSpend,
            arTotal: ar.arTotal,
            currency,
            vendorCount: ap.vendorCount,
            clientCount: ar.clientCount,
            overdueAmount: aging.overdueAmount,
            missingAmountCount,
            topVendorShare: ap.topVendorShare,
        },
    };
}

export type FinAnalyticsGroupId = "all" | FinPillarId;

export const FIN_ANALYTICS_GROUPS: Array<{
    id: FinAnalyticsGroupId;
    label: string;
    views: string[];
    defaultView: string;
    emptyHint: string;
    askPrompt: string;
}> = [
    {
        id: "all",
        label: "Overview",
        views: ["overview"],
        defaultView: "overview",
        emptyHint: "Upload invoices and finance exports across your portfolio.",
        askPrompt: "Show vendor totals",
    },
    {
        id: "ap",
        label: "AP",
        views: ["vendors", "aging", "trend"],
        defaultView: "vendors",
        emptyHint: "Add vendor invoices with extracted amounts.",
        askPrompt: "Chart AP aging and summarize overdue vendors",
    },
    {
        id: "ar",
        label: "AR",
        views: ["clients", "trend"],
        defaultView: "clients",
        emptyHint: "Upload client invoices or receivable statements.",
        askPrompt: "Show client totals ranked by revenue",
    },
    {
        id: "banking",
        label: "Banking",
        views: ["trend", "mix"],
        defaultView: "trend",
        emptyHint: "Add bank statements and monthly finance exports.",
        askPrompt: "Chart invoice trend by month",
    },
    {
        id: "tax",
        label: "Tax",
        views: ["mix"],
        defaultView: "mix",
        emptyHint: "Upload tax filings and statutory documents.",
        askPrompt: "Show finance document type mix",
    },
];

export function finGroupForView(view: string): FinAnalyticsGroupId {
    for (const g of FIN_ANALYTICS_GROUPS) {
        if (g.id === "all") continue;
        if (g.views.includes(view)) return g.id;
    }
    return "all";
}

export function deriveFinViewKpis(visuals: ChatVisualSpec[], view: string) {
    const ap = apStats(visuals);
    const ar = arStats(visuals);
    const aging = agingStats(visuals);
    if (view === "aging") {
        return [
            { label: "Overdue AP", value: aging.overdueAmount > 0 ? `${ap.currency} ${Math.round(aging.overdueAmount).toLocaleString()}` : "—" },
            { label: "Vendors", value: String(ap.vendorCount || "—") },
        ];
    }
    if (view === "clients") {
        return [
            { label: "AR total", value: ar.arTotal > 0 ? `${ap.currency} ${Math.round(ar.arTotal).toLocaleString()}` : "—" },
            { label: "Clients", value: String(ar.clientCount || "—") },
        ];
    }
    return [
        { label: "AP spend", value: ap.apSpend > 0 ? `${ap.currency} ${Math.round(ap.apSpend).toLocaleString()}` : "—" },
        { label: "Vendors", value: String(ap.vendorCount || "—") },
    ];
}

export function filterPortfolioByFinPillar(
    files: PortfolioFile[],
    vaultDocs: AgentVaultDoc[],
    pillar: FinPillarId | "all"
): PortfolioFile[] {
    if (pillar === "all") return files;
    const types = new Set(PILLAR_TYPES[pillar]);
    const docTypeById = new Map(vaultDocs.map((d) => [d.documentId, resolveDocType(d)]));
    return files.filter((f) => {
        const type = docTypeById.get(f.documentId) || inferDocTypeFromFilename(f.filename) || "invoice";
        if (pillar === "ap" && type === "invoice") return true;
        return types.has(type);
    });
}
