import type { AnalyticsAgentId } from "@/lib/documentAgents";
import {
    Briefcase,
    FileQuestion,
    MessageSquare,
    Scale,
    ShieldCheck,
    Users,
    Wallet,
    type LucideIcon,
} from "lucide-react";

export type AgentWorkspaceMeta = {
    id: AnalyticsAgentId;
    shortName: string;
    tagline: string;
    icon: LucideIcon;
    /** Sidebar + hero accent */
    accent: string;
    accentMuted: string;
};

export const AGENT_WORKSPACE_META: Record<AnalyticsAgentId, AgentWorkspaceMeta> = {
    finance_agent: {
        id: "finance_agent",
        shortName: "Finance",
        tagline: "AP, AR, aging, spend — plus synced invoices & task playbooks",
        icon: Wallet,
        accent: "var(--vb-blue-bright)",
        accentMuted: "rgba(56,182,255,0.12)",
    },
    hr_agent: {
        id: "hr_agent",
        shortName: "HR",
        tagline: "Hiring, people records, letters — and synced candidates & tasks",
        icon: Users,
        accent: "#7c3aed",
        accentMuted: "rgba(124,58,237,0.08)",
    },
    legal_agent: {
        id: "legal_agent",
        shortName: "Legal",
        tagline: "Contracts, risk, clauses — plus synced agreements & task loops",
        icon: Scale,
        accent: "#a78bfa",
        accentMuted: "rgba(167,139,250,0.12)",
    },
    compliance_agent: {
        id: "compliance_agent",
        shortName: "Compliance",
        tagline: "Certificates, audits, findings — and synced certs & CAPA tasks",
        icon: ShieldCheck,
        accent: "#fbbf24",
        accentMuted: "rgba(251,191,36,0.12)",
    },
    procurement_agent: {
        id: "procurement_agent",
        shortName: "Procurement",
        tagline: "POs, suppliers, RFQs — plus synced orders & open-task playbooks",
        icon: Briefcase,
        accent: "#ea580c",
        accentMuted: "rgba(234,88,12,0.08)",
    },
    other_agent: {
        id: "other_agent",
        shortName: "General",
        tagline: "Cross-document search, mixed files, and synced integration records",
        icon: FileQuestion,
        accent: "#94a3b8",
        accentMuted: "rgba(148,163,184,0.12)",
    },
};

/** Short chat prompts shown as chips on the workspace (not capability manifest). */
export const AGENT_QUICK_ASKS: Record<AnalyticsAgentId, string[]> = {
    finance_agent: [
        "Show synced invoices",
        "Chart AP aging",
        "Process open tasks until done",
        "Generate finance report",
    ],
    hr_agent: [
        "Show synced candidates",
        "Show CV score ranking",
        "Process open tasks until done",
        "Generate HR report",
    ],
    compliance_agent: [
        "How many certificates synced?",
        "Chart certificate expiry",
        "Process open tasks until done",
        "Generate compliance report",
    ],
    legal_agent: [
        "List contracts",
        "Chart risk flags",
        "Process open tasks until done",
        "Summarize legal portfolio",
    ],
    procurement_agent: [
        "Show purchase orders",
        "Chart spend by supplier",
        "Process open tasks until done",
        "List unmatched POs",
    ],
    other_agent: [
        "Show synced records",
        "Show synced tasks",
        "Process open tasks until done",
        "Summarize these documents",
    ],
};

/** One-click power actions (reports & deep tasks) */
export const AGENT_POWER_ACTIONS: Record<
    AnalyticsAgentId,
    Array<{ id: string; label: string; prompt: string; description: string }>
> = {
    finance_agent: [
        {
            id: "report",
            label: "Finance report PDF",
            prompt: "Generate finance report",
            description: "Printable AP/AR summary",
        },
        {
            id: "aging",
            label: "AP aging analysis",
            prompt: "Chart AP aging and summarize overdue vendors",
            description: "Overdue payables focus",
        },
        {
            id: "synced",
            label: "Synced invoices",
            prompt: "Show synced invoices",
            description: "Integration Path 2 records",
        },
        {
            id: "playbook",
            label: "Close open tasks",
            prompt: "Process open tasks until done",
            description: "Confirm with yes to loop",
        },
    ],
    hr_agent: [
        {
            id: "report",
            label: "HR report PDF",
            prompt: "Generate HR report",
            description: "Workforce snapshot",
        },
        {
            id: "shortlist",
            label: "CV shortlist",
            prompt: "Export shortlist top 10 candidates",
            description: "Ranked CV scores",
        },
        {
            id: "synced",
            label: "Synced candidates",
            prompt: "Show synced candidates",
            description: "Hiring board from integrations",
        },
        {
            id: "playbook",
            label: "Process open tasks",
            prompt: "Process open tasks until done",
            description: "Assign/complete loop",
        },
    ],
    compliance_agent: [
        {
            id: "report",
            label: "Compliance report",
            prompt: "Generate compliance report",
            description: "Full audit posture PDF",
        },
        {
            id: "ncr",
            label: "NCR letter",
            prompt: "Generate NCR letter for top critical finding. Company Visibility Bots, standard ISO 9001",
            description: "Non-conformance notice",
        },
        {
            id: "synced",
            label: "Synced certificates",
            prompt: "How many certificates synced?",
            description: "Integration compliance records",
        },
        {
            id: "playbook",
            label: "Process open tasks",
            prompt: "Process open tasks until done",
            description: "CAPA / task loop",
        },
    ],
    legal_agent: [
        {
            id: "risk",
            label: "Risk summary",
            prompt: "Chart risk flags by document and summarize",
            description: "Contract risk heatmap",
        },
        {
            id: "missing",
            label: "Missing clauses",
            prompt: "Show chart all missing data in contracts",
            description: "Gap analysis",
        },
        {
            id: "synced",
            label: "Synced contracts",
            prompt: "List contracts",
            description: "Integration legal records",
        },
        {
            id: "playbook",
            label: "Process open tasks",
            prompt: "Process open tasks until done",
            description: "Obligation / task loop",
        },
    ],
    procurement_agent: [
        {
            id: "spend",
            label: "Spend analysis",
            prompt: "Chart spend by supplier and summarize",
            description: "Supplier concentration",
        },
        {
            id: "match",
            label: "3-way match",
            prompt: "Run 3-way PO matching for all documents in scope",
            description: "PO · delivery · invoice gaps",
        },
        {
            id: "synced",
            label: "Synced POs",
            prompt: "Show purchase orders",
            description: "Integration procurement records",
        },
        {
            id: "playbook",
            label: "Process open tasks",
            prompt: "Process open tasks until done",
            description: "PO follow-up loop",
        },
    ],
    other_agent: [
        {
            id: "mix",
            label: "Document mix",
            prompt: "Show document type mix",
            description: "What you have uploaded",
        },
        {
            id: "summary",
            label: "Summarize all",
            prompt: "Summarize all documents in scope",
            description: "Cross-file overview",
        },
        {
            id: "synced",
            label: "Synced records",
            prompt: "Show synced records",
            description: "All integration JSON records",
        },
        {
            id: "playbook",
            label: "Process open tasks",
            prompt: "Process open tasks until done",
            description: "Universal task loop",
        },
    ],
};

export function getAgentWorkspaceMeta(agentId: string): AgentWorkspaceMeta | null {
    if (agentId in AGENT_WORKSPACE_META) {
        return AGENT_WORKSPACE_META[agentId as AnalyticsAgentId];
    }
    return null;
}

export function agentWorkspacePath(agentId: string): string {
    return `/agents/${encodeURIComponent(agentId)}`;
}

export function agentChatPath(agentId: string): string {
    return `/chat?agent=${encodeURIComponent(agentId)}&new=1`;
}

/** @deprecated use agentWorkspacePath */
export const agentDashboardPath = agentWorkspacePath;
