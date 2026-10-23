import type { ChatVisualSpec, ComplianceAnalyticsCoverage } from "@/types/chatVisuals";
import type { PortfolioFile } from "@/lib/agentWorkspaceKpis";
import {
    getSkippedDocumentIds,
    type WorkspaceCoverage,
    type WorkspaceMetrics,
} from "@/lib/agentWorkspaceInsights";
import type { AgentVaultDoc } from "@/hooks/useAgentPortfolio";
import { docTypeLabel, inferDocTypeFromFilename } from "@/lib/documentAgents";

export type CompPillarId = "certs" | "audits" | "policies" | "regulatory";

export type CompPillar = {
    id: CompPillarId;
    label: string;
    subtitle: string;
    count: number;
    chartView?: string;
    askPrompt: string;
    status: "ready" | "partial" | "empty";
};

export type CompPriority = {
    id: string;
    title: string;
    detail: string;
    tone: "warn" | "info";
    prompt?: string;
    chartView?: string;
    documentIds?: string[];
    approveKind?: "shortlist" | "reprocess";
};

export type ComplianceSnapshot = {
    headline: string;
    subline: string;
    pillars: CompPillar[];
    priorities: CompPriority[];
    docMix: Array<{ type: string; label: string; count: number }>;
    stats: {
        totalFiles: number;
        certsTracked: number;
        expiringSoon: number;
        expired: number;
        findingsCount: number;
        criticalFindings: number;
        postureCompliant: number;
    };
};

export type CertRegisterRow = {
    rank: number;
    name: string;
    standard: string;
    expiry: string;
    daysLeft: string;
    status: string;
    statusTone: "valid" | "expiring" | "expired" | "unknown";
    documentId?: string;
    agentAction: string;
};

const PILLAR_TYPES: Record<CompPillarId, string[]> = {
    certs: ["certificate", "iso_document"],
    audits: ["audit_report", "inspection_report", "quality_report"],
    policies: ["sop", "safety_manual", "compliance_form"],
    regulatory: ["regulatory_document", "engineering_drawing", "maintenance_report"],
};

const PILLAR_META: Record<CompPillarId, { label: string; subtitle: string; chartView?: string; askPrompt: string }> = {
    certs: {
        label: "Certificates & licenses",
        subtitle: "Expiry tracking and renewal planning",
        chartView: "expiry",
        askPrompt: "Any certificates expiring in the next 90 days?",
    },
    audits: {
        label: "Audits & findings",
        subtitle: "Inspection reports and audit outcomes",
        chartView: "findings",
        askPrompt: "Show audit findings by severity",
    },
    policies: {
        label: "Policies & SOPs",
        subtitle: "Operating procedures and safety manuals",
        chartView: "status_mix",
        askPrompt: "Show overall compliance status mix",
    },
    regulatory: {
        label: "Regulatory files",
        subtitle: "Regulatory submissions and technical records",
        chartView: "overview",
        askPrompt: "What compliance documents are missing?",
    },
};

function resolveDocType(doc: AgentVaultDoc): string {
    const cls = String(doc.classification || "").trim().toLowerCase();
    if (cls && cls !== "unclassified" && cls !== "other") return cls;
    return inferDocTypeFromFilename(doc.originalFilename || "") || "compliance_form";
}

function countByPillar(vaultDocs: AgentVaultDoc[]): Record<CompPillarId, number> {
    const counts: Record<CompPillarId, number> = { certs: 0, audits: 0, policies: 0, regulatory: 0 };
    for (const doc of vaultDocs) {
        const type = resolveDocType(doc);
        for (const [pillar, types] of Object.entries(PILLAR_TYPES) as [CompPillarId, string[]][]) {
            if (types.includes(type)) counts[pillar]++;
        }
    }
    return counts;
}

function docMix(vaultDocs: AgentVaultDoc[]): ComplianceSnapshot["docMix"] {
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

function statusTone(status: string): CertRegisterRow["statusTone"] {
    const s = status.toUpperCase();
    if (s.includes("EXPIRED")) return "expired";
    if (s.includes("EXPIRING")) return "expiring";
    if (s.includes("VALID")) return "valid";
    return "unknown";
}

export function extractCertRegister(visuals: ChatVisualSpec[], limit = 12): CertRegisterRow[] {
    const table =
        visuals.find((v) => v.id === "compliance_cert_register") ||
        visuals.find((v) => /certificate.*register|license register/i.test(v.title) && v.kind === "table");
    if (table?.data.length) {
        return table.data.slice(0, limit).map((row, i) => {
            const status = String(row.status || "UNKNOWN");
            return {
                rank: i + 1,
                name: String(row.filename || "Certificate"),
                standard: String(row.standard || "—"),
                expiry: String(row.expiry || "—"),
                daysLeft: String(row.daysLeft || "—"),
                status: status.replace(/_/g, " "),
                statusTone: statusTone(status),
                documentId: row._documentIds ? String(row._documentIds).split(",")[0] : undefined,
                agentAction:
                    statusTone(status) === "expired"
                        ? "Renew"
                        : statusTone(status) === "expiring"
                          ? "Plan renewal"
                          : "Review",
            };
        });
    }

    const expiry = visuals.find((v) => /days until certificate expiry/i.test(v.title));
    if (!expiry?.data.length) return [];

    return expiry.data.slice(0, limit).map((row, i) => {
        const days = Number(row.days ?? row.daysLeft);
        const tone: CertRegisterRow["statusTone"] =
            Number.isFinite(days) && days < 0 ? "expired" : Number.isFinite(days) && days <= 90 ? "expiring" : "valid";
        return {
            rank: i + 1,
            name: String(row.certificate || row.filename || "Certificate"),
            standard: "—",
            expiry: "—",
            daysLeft: Number.isFinite(days) ? String(days) : "—",
            status: tone === "expired" ? "EXPIRED" : tone === "expiring" ? "EXPIRING SOON" : "VALID",
            statusTone: tone,
            documentId: row._documentIds ? String(row._documentIds).split(",")[0] : undefined,
            agentAction: tone === "expired" ? "Renew" : tone === "expiring" ? "Plan renewal" : "Review",
        };
    });
}

function certStats(visuals: ChatVisualSpec[], coverage: WorkspaceCoverage | ComplianceAnalyticsCoverage | null) {
    const register = extractCertRegister(visuals, 100);
    let expiringSoon = 0;
    let expired = 0;
    for (const r of register) {
        if (r.statusTone === "expired") expired++;
        else if (r.statusTone === "expiring") expiringSoon++;
    }

    const certPie = visuals.find((v) => /certificate validity/i.test(v.title));
    if (certPie?.data.length) {
        for (const row of certPie.data) {
            const st = String(row.status || "").toUpperCase();
            const count = Number(row.count || 0);
            if (st.includes("EXPIRING")) expiringSoon = Math.max(expiringSoon, count);
            if (st.includes("EXPIRED")) expired = Math.max(expired, count);
        }
    }

    const certsTracked =
        coverage && "documentsWithExpiry" in coverage ? (coverage.documentsWithExpiry ?? register.length) : register.length;

    return { certsTracked, expiringSoon, expired };
}

function findingsStats(visuals: ChatVisualSpec[], coverage: WorkspaceCoverage | ComplianceAnalyticsCoverage | null) {
    const findingsVisual = visuals.find((v) => /findings by severity/i.test(v.title));
    let findingsCount = 0;
    let criticalFindings = 0;
    if (findingsVisual?.data.length) {
        for (const row of findingsVisual.data) {
            const c = Number(row.count || 0);
            findingsCount += c;
            if (/critical|major|high/i.test(String(row.severity || ""))) criticalFindings += c;
        }
    }
    if (coverage && "documentsWithFindings" in coverage && findingsCount === 0) {
        findingsCount = coverage.documentsWithFindings ?? 0;
    }
    return { findingsCount, criticalFindings };
}

function postureStats(visuals: ChatVisualSpec[]) {
    const statusVisual = visuals.find((v) => /overall compliance status/i.test(v.title));
    if (!statusVisual?.data.length) return 0;
    for (const row of statusVisual.data) {
        if (/compliant/i.test(String(row.status || "")) && !/non|partial/i.test(String(row.status || ""))) {
            return Number(row.count || 0);
        }
    }
    return 0;
}

export function deriveComplianceSnapshot(
    vaultDocs: AgentVaultDoc[],
    visuals: ChatVisualSpec[],
    coverage: WorkspaceCoverage | ComplianceAnalyticsCoverage | null,
    metrics: WorkspaceMetrics
): ComplianceSnapshot {
    const pillarCounts = countByPillar(vaultDocs);
    const { certsTracked, expiringSoon, expired } = certStats(visuals, coverage);
    const { findingsCount, criticalFindings } = findingsStats(visuals, coverage);
    const postureCompliant = postureStats(visuals);

    const pillars: CompPillar[] = (Object.keys(PILLAR_META) as CompPillarId[]).map((id) => {
        const count = pillarCounts[id];
        const meta = PILLAR_META[id];
        return {
            id,
            ...meta,
            count,
            status: count === 0 ? "empty" : count >= 2 ? "ready" : "partial",
        };
    });

    const priorities: CompPriority[] = [];

    if (expired > 0) {
        priorities.push({
            id: "expired",
            title: `${expired} certificate${expired === 1 ? "" : "s"} expired`,
            detail: "Renew or replace before the next audit cycle.",
            tone: "warn",
            chartView: "expiry",
            prompt: "Any certificates expiring in the next 90 days?",
        });
    }
    if (expiringSoon > 0) {
        priorities.push({
            id: "expiring",
            title: `${expiringSoon} cert${expiringSoon === 1 ? "" : "s"} expiring within warning window`,
            detail: "Schedule renewals and update the register.",
            tone: "warn",
            chartView: "expiry",
            prompt: "Chart certificate expiry for next 12 months",
        });
    }
    if (criticalFindings > 0) {
        priorities.push({
            id: "critical-findings",
            title: `${criticalFindings} critical/major finding${criticalFindings === 1 ? "" : "s"}`,
            detail: "Raise NCR/CAPA and assign owners for closure.",
            tone: "warn",
            chartView: "findings",
            prompt: "Generate NCR letter for top critical finding",
        });
    } else if (findingsCount > 0) {
        priorities.push({
            id: "findings",
            title: `${findingsCount} audit finding${findingsCount === 1 ? "" : "s"} in scope`,
            detail: "Review severity mix and track corrective actions.",
            tone: "info",
            chartView: "findings",
            prompt: "Show audit findings by severity",
        });
    }
    if (metrics.skippedDocs > 0) {
        const skippedIds = getSkippedDocumentIds(coverage);
        priorities.push({
            id: "fix",
            title: `${metrics.skippedDocs} file${metrics.skippedDocs === 1 ? "" : "s"} not in charts`,
            detail: "Approve to reprocess so expiry, findings, and status fields populate.",
            tone: "warn",
            documentIds: skippedIds.length ? skippedIds : undefined,
            approveKind: skippedIds.length ? "reprocess" : undefined,
            prompt: skippedIds.length ? undefined : "Why are some compliance files not in charts?",
        });
    }
    if (priorities.length === 0 && metrics.totalDocs > 0) {
        priorities.push({
            id: "healthy",
            title: "Compliance posture looks current",
            detail: "Run a full report or build an audit evidence pack.",
            tone: "info",
            prompt: "Generate compliance report",
        });
    }

    let headline = "Build your compliance control tower";
    let subline = "Upload certificates, audit reports, SOPs, and regulatory files to track expiry and findings.";
    if (metrics.totalDocs > 0) {
        const parts: string[] = [];
        if (pillarCounts.certs > 0) parts.push(`${pillarCounts.certs} cert${pillarCounts.certs === 1 ? "" : "s"}`);
        if (pillarCounts.audits > 0) parts.push(`${pillarCounts.audits} audit${pillarCounts.audits === 1 ? "" : "s"}`);
        if (findingsCount > 0) parts.push(`${findingsCount} finding${findingsCount === 1 ? "" : "s"}`);
        headline = parts.length ? parts.join(" · ") : `${metrics.totalDocs} compliance files`;
        subline =
            metrics.skippedDocs > 0
                ? `${metrics.chartedDocs} of ${metrics.totalDocs} files feeding charts — fix gaps for full posture views.`
                : `${certsTracked} certs tracked · ${visuals.length} live view${visuals.length === 1 ? "" : "s"}`;
    }

    return {
        headline,
        subline,
        pillars,
        priorities: priorities.slice(0, 4),
        docMix: docMix(vaultDocs),
        stats: {
            totalFiles: metrics.totalDocs,
            certsTracked,
            expiringSoon,
            expired,
            findingsCount,
            criticalFindings,
            postureCompliant,
        },
    };
}

export type CompAnalyticsGroupId = "all" | CompPillarId;

export const COMP_ANALYTICS_GROUPS: Array<{
    id: CompAnalyticsGroupId;
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
        emptyHint: "Upload compliance files across certs, audits, policies, and regulatory records.",
        askPrompt: "Generate compliance report",
    },
    {
        id: "certs",
        label: "Certificates",
        views: ["expiry", "cert_status"],
        defaultView: "expiry",
        emptyHint: "Add certificates with expiry dates for renewal tracking.",
        askPrompt: "Any certificates expiring in the next 90 days?",
    },
    {
        id: "audits",
        label: "Findings",
        views: ["findings"],
        defaultView: "findings",
        emptyHint: "Upload audit and inspection reports with findings extracted.",
        askPrompt: "Show audit findings by severity",
    },
    {
        id: "policies",
        label: "Posture",
        views: ["status_mix"],
        defaultView: "status_mix",
        emptyHint: "Add SOPs and compliance forms with overall status fields.",
        askPrompt: "Show overall compliance status mix",
    },
    {
        id: "regulatory",
        label: "Coverage",
        views: ["overview", "status_mix"],
        defaultView: "overview",
        emptyHint: "Map required document types to your framework.",
        askPrompt: "What compliance documents are missing?",
    },
];

export function compGroupForView(view: string): CompAnalyticsGroupId {
    const found = COMP_ANALYTICS_GROUPS.find((g) => g.id !== "all" && g.views.includes(view));
    return found?.id ?? "all";
}

export type CompViewKpi = { label: string; value: string };

export function deriveCompViewKpis(visuals: ChatVisualSpec[], view: string): CompViewKpi[] {
    const register = extractCertRegister(visuals, 100);
    const findings = visuals.find((v) => /findings by severity/i.test(v.title));

    if (view === "expiry" || view === "cert_status") {
        if (!register.length) return [];
        const expiring = register.filter((r) => r.statusTone === "expiring").length;
        const expired = register.filter((r) => r.statusTone === "expired").length;
        return [
            { label: "Tracked", value: String(register.length) },
            { label: "Expiring", value: String(expiring) },
            { label: "Expired", value: String(expired) },
        ];
    }

    if (view === "findings") {
        if (!findings?.data.length) return [];
        const total = findings.data.reduce((s, r) => s + Number(r.count || 0), 0);
        return [
            { label: "Findings", value: String(total) },
            { label: "Severity bands", value: String(findings.data.length) },
        ];
    }

    if (view === "status_mix" || view === "overview") {
        const statusVisual = visuals.find((v) => /overall compliance status|certificate validity/i.test(v.title));
        if (statusVisual?.data.length) {
            return [
                { label: "Segments", value: String(statusVisual.data.length) },
                {
                    label: "Documents",
                    value: String(statusVisual.data.reduce((s, r) => s + Number(r.count || 0), 0)),
                },
            ];
        }
    }

    return register.length ? [{ label: "Certs tracked", value: String(register.length) }] : [];
}

export function filterPortfolioByCompPillar(
    files: PortfolioFile[],
    vaultDocs: AgentVaultDoc[],
    pillar: CompPillarId | "all"
): PortfolioFile[] {
    if (pillar === "all") return files;
    const types = new Set(PILLAR_TYPES[pillar]);
    const ids = new Set(vaultDocs.filter((d) => types.has(resolveDocType(d))).map((d) => d.documentId));
    return files.filter((f) => ids.has(f.documentId));
}

export function extractRenewalQueue(visuals: ChatVisualSpec[], limit = 8): CertRegisterRow[] {
    return extractCertRegister(visuals, 100)
        .filter((r) => r.statusTone === "expiring" || r.statusTone === "expired")
        .slice(0, limit);
}
