"use client";

import React from "react";
import Link from "next/link";
import { BarChart3, MessageSquare, Upload } from "lucide-react";
import type { AnalyticsAgentId } from "@/lib/documentAgents";
import { AGENT_QUICK_ASKS } from "@/lib/agentWorkspace";
import type { AgentWorkspaceMeta } from "@/lib/agentWorkspace";

const EMPTY_GUIDANCE: Record<AnalyticsAgentId, { title: string; steps: string[] }> = {
    finance_agent: {
        title: "Finance analytics unlock from AP invoices, bank files, and extracted amounts",
        steps: [
            "Upload vendor invoices or connect ERP via Integrations",
            "Open Command → AP workstream or ask “Show vendor totals”",
            "Review AP aging and Reports hub for overdue payables",
        ],
    },
    hr_agent: {
        title: "HR charts unlock from CVs, payroll, leave, and employee records",
        steps: ["Upload CVs or HR exports", "Ask: “Rank candidates by score”", "Track cert expiry from compliance docs"],
    },
    compliance_agent: {
        title: "Compliance views need certificates, audit reports, and policy documents",
        steps: ["Upload certs with expiry dates", "Ask: “Chart certificate expiry”", "Review findings by severity"],
    },
    legal_agent: {
        title: "Legal analytics come from contracts and agreements with extractable clauses",
        steps: ["Upload contracts", "Ask: “Chart risk flags by document”", "Review missing clause gaps"],
    },
    procurement_agent: {
        title: "Procurement charts need POs, invoices, and supplier spend data",
        steps: ["Upload PO and invoice files", "Ask: “Chart spend by supplier”", "Compare PO vs invoice match"],
    },
    other_agent: {
        title: "General analytics summarize whatever is in your document vault",
        steps: ["Upload any document type", "Ask: “Show document type mix”", "Summarize across all files"],
    },
};

type Props = {
    agentId: AnalyticsAgentId;
    meta: AgentWorkspaceMeta;
    documentCount?: number;
    onRunPrompt: (prompt: string) => void;
    onOpenCharts?: () => void;
};

export default function AgentAnalyticsEmptyState({
    agentId,
    meta,
    documentCount = 0,
    onRunPrompt,
}: Props) {
    const guidance = EMPTY_GUIDANCE[agentId];
    const starter = AGENT_QUICK_ASKS[agentId]?.[0];

    return (
        <div className="rounded-2xl border border-dashed border-border bg-surface/30 p-8 sm:p-10 text-center max-w-lg mx-auto my-8">
            <div
                className="mx-auto h-14 w-14 rounded-2xl flex items-center justify-center mb-4"
                style={{ backgroundColor: meta.accentMuted }}
            >
                <BarChart3 size={26} style={{ color: meta.accent }} />
            </div>
            <h3 className="text-base font-bold text-foreground">No live charts yet</h3>
            <p className="text-sm text-foreground-muted mt-2 leading-relaxed">{guidance.title}</p>

            {documentCount === 0 ? (
                <Link
                    href="/documents"
                    className="btn-gradient rounded-xl px-4 py-2 text-sm inline-flex items-center gap-1.5 mt-6"
                >
                    <Upload size={14} /> Upload documents
                </Link>
            ) : (
                <p className="text-xs text-amber-700 dark:text-amber-400 mt-4">
                    {documentCount} document{documentCount === 1 ? "" : "s"} in scope — some may still need extraction. Check the Fix tab.
                </p>
            )}

            <ol className="text-left text-xs text-foreground-muted mt-6 space-y-2 max-w-sm mx-auto list-decimal list-inside">
                {guidance.steps.map((step) => (
                    <li key={step}>{step}</li>
                ))}
            </ol>

            {starter && (
                <button
                    type="button"
                    onClick={() => onRunPrompt(starter)}
                    className="mt-6 rounded-xl border border-border bg-background px-4 py-2 text-sm font-medium inline-flex items-center gap-2 hover:border-accent/40"
                >
                    <MessageSquare size={14} style={{ color: meta.accent }} />
                    Try: {starter}
                </button>
            )}
        </div>
    );
}
