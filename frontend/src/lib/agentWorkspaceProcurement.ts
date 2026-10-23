import type { ChatVisualSpec } from "@/types/chatVisuals";
import type { PortfolioFile } from "@/lib/agentWorkspaceKpis";
import {
    getSkippedDocumentIds,
    type WorkspaceCoverage,
    type WorkspaceMetrics,
} from "@/lib/agentWorkspaceInsights";
import type { AgentVaultDoc } from "@/hooks/useAgentPortfolio";
import { docTypeLabel, inferDocTypeFromFilename } from "@/lib/documentAgents";

export type ProcPillarId = "sourcing" | "orders" | "suppliers" | "receiving";

export type ProcPillar = {
    id: ProcPillarId;
    label: string;
    subtitle: string;
    count: number;
    chartView?: string;
    askPrompt: string;
    status: "ready" | "partial" | "empty";
};

export type ProcPriority = {
    id: string;
    title: string;
    detail: string;
    tone: "warn" | "info";
    prompt?: string;
    chartView?: string;
    documentIds?: string[];
    approveKind?: "shortlist" | "reprocess";
};

export type ProcurementSnapshot = {
    headline: string;
    subline: string;
    pillars: ProcPillar[];
    priorities: ProcPriority[];
    docMix: Array<{ type: string; label: string; count: number }>;
    stats: {
        totalFiles: number;
        totalOrders: number;
        openCount: number;
        fulfilledCount: number;
        discrepancyCount: number;
        totalSpend: number;
        currency: string;
        supplierCount: number;
        topSupplierShare?: number;
    };
};

export type OrderRegisterRow = {
    rank: number;
    poNumber: string;
    vendor: string;
    amount: string;
    status: string;
    statusTone: "open" | "fulfilled" | "discrepancy" | "unknown";
    documentId?: string;
    filename?: string;
    agentAction: string;
};

const PILLAR_TYPES: Record<ProcPillarId, string[]> = {
    sourcing: ["rfq", "quotation", "procurement_request"],
    orders: ["purchase_order", "po"],
    suppliers: ["supplier_agreement", "vendor_list"],
    receiving: ["delivery_note"],
};

const PILLAR_META: Record<ProcPillarId, { label: string; subtitle: string; chartView?: string; askPrompt: string }> = {
    sourcing: {
        label: "Sourcing & RFQ",
        subtitle: "Requests for quote and vendor bids",
        chartView: "po_spend",
        askPrompt: "Compare vendor quotes and rank by price",
    },
    orders: {
        label: "Purchase orders",
        subtitle: "Open commitments and PO register",
        chartView: "po_status",
        askPrompt: "Show procurement summary for all POs",
    },
    suppliers: {
        label: "Suppliers & contracts",
        subtitle: "Vendor lists and supplier agreements",
        chartView: "po_spend",
        askPrompt: "Chart spend by supplier",
    },
    receiving: {
        label: "Receiving & match",
        subtitle: "Delivery notes and 3-way match",
        chartView: "po_match",
        askPrompt: "Chart PO vs invoice amounts",
    },
};

function resolveDocType(doc: AgentVaultDoc): string {
    const cls = String(doc.classification || "").trim().toLowerCase();
    if (cls && cls !== "unclassified" && cls !== "other") return cls;
    return inferDocTypeFromFilename(doc.originalFilename || "") || "procurement_request";
}

function countByPillar(vaultDocs: AgentVaultDoc[]): Record<ProcPillarId, number> {
    const counts: Record<ProcPillarId, number> = { sourcing: 0, orders: 0, suppliers: 0, receiving: 0 };
    for (const doc of vaultDocs) {
        const type = resolveDocType(doc);
        for (const [pillar, types] of Object.entries(PILLAR_TYPES) as [ProcPillarId, string[]][]) {
            if (types.includes(type)) counts[pillar]++;
        }
    }
    return counts;
}

function docMix(vaultDocs: AgentVaultDoc[]): ProcurementSnapshot["docMix"] {
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

function statusTone(status: string): OrderRegisterRow["statusTone"] {
    const s = status.toUpperCase();
    if (s.includes("DISCREPANCY")) return "discrepancy";
    if (s.includes("FULFILLED")) return "fulfilled";
    if (s.includes("OPEN") || s.includes("PENDING")) return "open";
    return "unknown";
}

export function extractOrderRegister(visuals: ChatVisualSpec[], limit = 12): OrderRegisterRow[] {
    const visual =
        visuals.find((v) => v.id === "procurement_kpi_grid") ||
        visuals.find((v) => /order register|procurement/i.test(v.title) && v.kind === "table");
    if (!visual?.data.length) return [];

    return visual.data.slice(0, limit).map((row, i) => {
        const status = String(row.status || row.Status || "UNKNOWN");
        const tone = statusTone(status);
        return {
            rank: i + 1,
            poNumber: String(row.poNumber || row.po_number || "—"),
            vendor: String(row.vendorName || row.vendor || "—"),
            amount: String(row.totalAmount || row.amount || "—"),
            status: status.replace(/_/g, " "),
            statusTone: tone,
            documentId: row._documentIds ? String(row._documentIds).split(",")[0] : undefined,
            filename: row.filename ? String(row.filename) : undefined,
            agentAction:
                tone === "discrepancy" ? "Match review" : tone === "open" ? "Track PO" : "Review",
        };
    });
}

function spendStats(visuals: ChatVisualSpec[]) {
    const spendVisual =
        visuals.find((v) => v.id === "procurement_spend_by_supplier") ||
        visuals.find((v) => /spend|supplier/i.test(v.title) && v.kind === "bar");
    if (!spendVisual?.data.length) {
        return { totalSpend: 0, currency: "USD", supplierCount: 0, topSupplierShare: undefined as number | undefined };
    }
    const key = spendVisual.series[0]?.key || "amount";
    const amounts = spendVisual.data.map((r) => Number(r[key] || 0)).filter((n) => Number.isFinite(n) && n > 0);
    const totalSpend = amounts.reduce((s, n) => s + n, 0);
    const top = amounts.length ? Math.max(...amounts) : 0;
    return {
        totalSpend,
        currency: spendVisual.currency || "USD",
        supplierCount: spendVisual.data.length,
        topSupplierShare: totalSpend > 0 && top > 0 ? Math.round((top / totalSpend) * 100) : undefined,
    };
}

function registerStats(visuals: ChatVisualSpec[]) {
    const rows = extractOrderRegister(visuals, 200);
    let openCount = 0;
    let fulfilledCount = 0;
    let discrepancyCount = 0;
    for (const r of rows) {
        if (r.statusTone === "open") openCount++;
        else if (r.statusTone === "fulfilled") fulfilledCount++;
        else if (r.statusTone === "discrepancy") discrepancyCount++;
    }
    return { totalOrders: rows.length, openCount, fulfilledCount, discrepancyCount };
}

export function deriveProcurementSnapshot(
    vaultDocs: AgentVaultDoc[],
    visuals: ChatVisualSpec[],
    coverage: WorkspaceCoverage,
    metrics: WorkspaceMetrics
): ProcurementSnapshot {
    const pillarCounts = countByPillar(vaultDocs);
    const spend = spendStats(visuals);
    const reg = registerStats(visuals);

    const pillars: ProcPillar[] = (Object.keys(PILLAR_META) as ProcPillarId[]).map((id) => {
        const count = pillarCounts[id];
        const meta = PILLAR_META[id];
        return {
            id,
            ...meta,
            count,
            status: count === 0 ? "empty" : count >= 2 ? "ready" : "partial",
        };
    });

    const priorities: ProcPriority[] = [];

    if (reg.discrepancyCount > 0) {
        priorities.push({
            id: "discrepancies",
            title: `${reg.discrepancyCount} order${reg.discrepancyCount === 1 ? "" : "s"} flagged for review`,
            detail: "Amount variance or match gaps — reconcile PO vs delivery vs invoice.",
            tone: "warn",
            prompt: "Chart PO vs invoice amounts",
            chartView: "po_match",
        });
    }
    if (reg.openCount > 0) {
        priorities.push({
            id: "open-pos",
            title: `${reg.openCount} open PO${reg.openCount === 1 ? "" : "s"} in flight`,
            detail: "Pending delivery or awaiting supplier confirmation.",
            tone: "warn",
            chartView: "po_status",
            prompt: "Show procurement summary for all POs",
        });
    }
    if (metrics.skippedDocs > 0) {
        const skippedIds = getSkippedDocumentIds(coverage);
        priorities.push({
            id: "fix",
            title: `${metrics.skippedDocs} file${metrics.skippedDocs === 1 ? "" : "s"} not in charts`,
            detail: "Approve to reprocess POs and quotes so spend and status views populate.",
            tone: "warn",
            documentIds: skippedIds.length ? skippedIds : undefined,
            approveKind: skippedIds.length ? "reprocess" : undefined,
            prompt: skippedIds.length ? undefined : "Why are some procurement files not in charts?",
        });
    }
    if (spend.topSupplierShare != null && spend.topSupplierShare >= 40) {
        priorities.push({
            id: "concentration",
            title: `Top supplier = ${spend.topSupplierShare}% of spend`,
            detail: "Review supplier concentration and dual-source options.",
            tone: "info",
            chartView: "po_spend",
            prompt: "Chart spend by supplier and summarize",
        });
    }
    if (pillarCounts.sourcing > 0 && pillarCounts.orders === 0) {
        priorities.push({
            id: "rfq-to-po",
            title: `${pillarCounts.sourcing} quote${pillarCounts.sourcing === 1 ? "" : "s"} without POs`,
            detail: "Compare bids and convert winning quote to a purchase order.",
            tone: "info",
            prompt: "Compare vendor quotes and rank by price",
        });
    }
    if (priorities.length === 0 && metrics.totalDocs > 0) {
        priorities.push({
            id: "healthy",
            title: "Procurement portfolio looks current",
            detail: "Run a summary report or explore spend by supplier.",
            tone: "info",
            prompt: "Show procurement summary",
        });
    }

    let headline = "Build your procurement hub";
    let subline = "Upload POs, RFQs, quotes, delivery notes, and supplier contracts to unlock spend analytics.";
    if (metrics.totalDocs > 0) {
        const parts: string[] = [];
        if (pillarCounts.orders > 0) parts.push(`${pillarCounts.orders} PO${pillarCounts.orders === 1 ? "" : "s"}`);
        if (pillarCounts.sourcing > 0) parts.push(`${pillarCounts.sourcing} RFQ/quote`);
        if (pillarCounts.receiving > 0) parts.push(`${pillarCounts.receiving} delivery`);
        if (pillarCounts.suppliers > 0) parts.push(`${pillarCounts.suppliers} supplier`);
        headline = parts.length ? parts.join(" · ") : `${metrics.totalDocs} procurement files`;
        subline =
            metrics.skippedDocs > 0
                ? `${metrics.chartedDocs} of ${metrics.totalDocs} files feeding charts — fix gaps for full PO views.`
                : spend.totalSpend > 0
                  ? `${spend.currency} ${Math.round(spend.totalSpend).toLocaleString()} committed · ${visuals.length} live view${visuals.length === 1 ? "" : "s"}`
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
            totalOrders: reg.totalOrders,
            openCount: reg.openCount,
            fulfilledCount: reg.fulfilledCount,
            discrepancyCount: reg.discrepancyCount,
            totalSpend: spend.totalSpend,
            currency: spend.currency,
            supplierCount: spend.supplierCount,
            topSupplierShare: spend.topSupplierShare,
        },
    };
}

export type ProcAnalyticsGroupId = "all" | ProcPillarId;

export const PROC_ANALYTICS_GROUPS: Array<{
    id: ProcAnalyticsGroupId;
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
        emptyHint: "Upload POs, RFQs, and delivery notes across your procurement portfolio.",
        askPrompt: "Show procurement summary",
    },
    {
        id: "sourcing",
        label: "Sourcing",
        views: ["po_spend", "overview"],
        defaultView: "po_spend",
        emptyHint: "Add RFQs and vendor quotations to compare bids.",
        askPrompt: "Compare vendor quotes and rank by price",
    },
    {
        id: "orders",
        label: "Orders",
        views: ["po_status", "overview"],
        defaultView: "po_status",
        emptyHint: "Upload purchase orders to track open vs fulfilled status.",
        askPrompt: "Show procurement summary for all POs",
    },
    {
        id: "suppliers",
        label: "Suppliers",
        views: ["po_spend"],
        defaultView: "po_spend",
        emptyHint: "Add POs with vendor names to chart spend concentration.",
        askPrompt: "Chart spend by supplier",
    },
    {
        id: "receiving",
        label: "Match",
        views: ["po_match", "po_status"],
        defaultView: "po_match",
        emptyHint: "Add delivery notes and invoices for 3-way match views.",
        askPrompt: "Chart PO vs invoice amounts",
    },
];

export function procGroupForView(view: string): ProcAnalyticsGroupId {
    const found = PROC_ANALYTICS_GROUPS.find((g) => g.id !== "all" && g.views.includes(view));
    return found?.id ?? "all";
}

export type ProcViewKpi = { label: string; value: string };

export function deriveProcViewKpis(visuals: ChatVisualSpec[], view: string): ProcViewKpi[] {
    const spend = spendStats(visuals);
    const reg = registerStats(visuals);

    if (view === "po_spend" || view === "overview") {
        if (spend.totalSpend <= 0 && reg.totalOrders === 0) return [];
        return [
            {
                label: "Committed spend",
                value:
                    spend.totalSpend > 0
                        ? `${spend.currency} ${Math.round(spend.totalSpend).toLocaleString()}`
                        : "—",
            },
            { label: "Suppliers", value: spend.supplierCount > 0 ? String(spend.supplierCount) : "—" },
            { label: "Orders", value: reg.totalOrders > 0 ? String(reg.totalOrders) : "—" },
        ];
    }

    if (view === "po_status" || view === "po_match") {
        if (reg.totalOrders === 0) return [];
        return [
            { label: "Open", value: String(reg.openCount) },
            { label: "Fulfilled", value: String(reg.fulfilledCount) },
            { label: "Review", value: String(reg.discrepancyCount) },
        ];
    }

    const v = visuals[0];
    if (!v?.data.length) return [];
    return [{ label: "Rows", value: String(v.data.length) }];
}

export function filterPortfolioByProcPillar(
    files: PortfolioFile[],
    vaultDocs: AgentVaultDoc[],
    pillar: ProcPillarId | "all"
): PortfolioFile[] {
    if (pillar === "all") return files;
    const types = new Set(PILLAR_TYPES[pillar]);
    const ids = new Set(vaultDocs.filter((d) => types.has(resolveDocType(d))).map((d) => d.documentId));
    return files.filter((f) => ids.has(f.documentId));
}

export function extractDiscrepancyQueue(visuals: ChatVisualSpec[], limit = 8): OrderRegisterRow[] {
    return extractOrderRegister(visuals, 100)
        .filter((r) => r.statusTone === "discrepancy" || r.statusTone === "open")
        .slice(0, limit);
}
