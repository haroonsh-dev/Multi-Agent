import type { AnalyticsAgentId } from "@/lib/documentAgents";
import type { ChatVisualSpec } from "@/types/chatVisuals";
import type { WorkspaceMetrics } from "@/lib/agentWorkspaceInsights";

export type WorkspaceHero = {
    title: string;
    value: string;
    subtitle?: string;
    variant?: "metric" | "empty" | "highlight";
};

const EMPTY_HERO: Record<AnalyticsAgentId, { title: string; subtitle: string }> = {
    finance_agent: {
        title: "Finance command center",
        subtitle: "Upload AP/AR spreadsheets or invoices to unlock PKR totals and aging views",
    },
    hr_agent: {
        title: "HR workforce hub",
        subtitle: "Add CVs, payroll, and employee records to rank candidates and track certs",
    },
    compliance_agent: {
        title: "Compliance oversight",
        subtitle: "Upload certificates and audit reports for expiry timelines and findings",
    },
    legal_agent: {
        title: "Legal risk desk",
        subtitle: "Add contracts to surface risk flags, clause gaps, and obligations",
    },
    procurement_agent: {
        title: "Procurement control",
        subtitle: "Upload POs and supplier invoices for spend and match analytics",
    },
    other_agent: {
        title: "Document intelligence",
        subtitle: "Upload any files — ask for summaries, mixes, and cross-doc insights",
    },
};

function sumVisualByCurrency(visuals: ChatVisualSpec[], match: RegExp): Map<string, number> {
    const totals = new Map<string, number>();
    for (const v of visuals) {
        if (!match.test(v.title)) continue;
        const key = v.series[0]?.key;
        if (!key) continue;
        const cur = v.currency || "TOTAL";
        const sum = v.data.reduce((s, row) => s + Number(row[key] || 0), 0);
        totals.set(cur, (totals.get(cur) || 0) + sum);
    }
    return totals;
}

function pickPrimaryCurrency(totals: Map<string, number>): { currency: string; amount: number } | null {
    if (!totals.size) return null;
    const pkr = totals.get("PKR");
    if (pkr != null && pkr > 0) return { currency: "PKR", amount: pkr };
    const sorted = [...totals.entries()].sort((a, b) => b[1] - a[1]);
    return { currency: sorted[0][0], amount: sorted[0][1] };
}

function fmt(amount: number, currency: string): string {
    return `${currency} ${amount.toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
}

function heroFromMetrics(agentId: AnalyticsAgentId, metrics: WorkspaceMetrics): WorkspaceHero | null {
    if (metrics.totalDocs === 0) return null;

    const base = {
        title: `${metrics.healthLabel} portfolio`,
        value: `${metrics.healthScore}%`,
        subtitle: `${metrics.chartedDocs} of ${metrics.totalDocs} documents chart-ready`,
        variant: "metric" as const,
    };

    if (agentId === "finance_agent" && metrics.chartedDocs === 0) {
        return {
            ...base,
            subtitle: `${metrics.totalDocs} finance docs uploaded — ask to chart vendor totals or AP aging`,
        };
    }

    return base;
}

export function deriveWorkspaceHero(
    agentId: AnalyticsAgentId,
    visuals: ChatVisualSpec[],
    metrics?: WorkspaceMetrics
): WorkspaceHero {
    if (visuals.length) {
        const fromCharts = deriveChartHero(agentId, visuals);
        if (fromCharts) return { ...fromCharts, variant: "highlight" };
    }

    if (metrics) {
        const fromMetrics = heroFromMetrics(agentId, metrics);
        if (fromMetrics) return fromMetrics;
    }

    const empty = EMPTY_HERO[agentId];
    return {
        title: empty.title,
        value: "Get started",
        subtitle: empty.subtitle,
        variant: "empty",
    };
}

function deriveChartHero(agentId: AnalyticsAgentId, visuals: ChatVisualSpec[]): WorkspaceHero | null {
    if (agentId === "finance_agent") {
        const ap = sumVisualByCurrency(visuals, /vendor|AP/i);
        const ar = sumVisualByCurrency(visuals, /client|AR/i);
        const apPrimary = pickPrimaryCurrency(ap);
        const arPrimary = pickPrimaryCurrency(ar);
        if (apPrimary && arPrimary && apPrimary.currency === arPrimary.currency) {
            return {
                title: "Portfolio value",
                value: fmt(apPrimary.amount + arPrimary.amount, apPrimary.currency),
                subtitle: `AP ${fmt(apPrimary.amount, apPrimary.currency)} · AR ${fmt(arPrimary.amount, arPrimary.currency)}`,
            };
        }
        if (apPrimary) {
            return {
                title: "Accounts payable",
                value: fmt(apPrimary.amount, apPrimary.currency),
                subtitle: `${visuals.find((v) => /vendor/i.test(v.title))?.data.length || 0} vendors in scope`,
            };
        }
        if (arPrimary) {
            return {
                title: "Accounts receivable",
                value: fmt(arPrimary.amount, arPrimary.currency),
                subtitle: "Client invoice totals",
            };
        }
    }

    if (agentId === "procurement_agent") {
        const spend = sumVisualByCurrency(visuals, /spend|supplier/i);
        const primary = pickPrimaryCurrency(spend);
        if (primary) {
            return {
                title: "Supplier spend",
                value: fmt(primary.amount, primary.currency),
                subtitle: "Across scoped POs & invoices",
            };
        }
    }

    if (agentId === "hr_agent") {
        const scores = visuals.find((v) => /score|cv/i.test(v.title));
        if (scores?.data.length) {
            return {
                title: "CV profiles ranked",
                value: String(scores.data.length),
                subtitle: scores.title,
            };
        }
    }

    if (agentId === "compliance_agent") {
        const findings = visuals.find((v) => /finding|severity/i.test(v.title));
        if (findings?.data.length) {
            const key = findings.series[0]?.key;
            const total = key
                ? findings.data.reduce((s, row) => s + Number(row[key] || 0), 0)
                : findings.data.length;
            return {
                title: "Audit findings tracked",
                value: String(total),
                subtitle: findings.title,
            };
        }
    }

    if (agentId === "legal_agent") {
        const risk = visuals.find((v) => /risk/i.test(v.title));
        if (risk?.data.length) {
            return {
                title: "Risk signals",
                value: String(risk.data.length),
                subtitle: risk.title,
            };
        }
    }

    const chartCount = visuals.length;
    const first = visuals[0];
    if (first?.data.length) {
        return {
            title: first.title,
            value: `${first.data.length} data points`,
            subtitle: `${chartCount} chart${chartCount === 1 ? "" : "s"} loaded`,
        };
    }

    return null;
}
