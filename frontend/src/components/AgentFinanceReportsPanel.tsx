"use client";

import React from "react";
import { Clock, Copy, FileBarChart, LineChart, Sparkles } from "lucide-react";
import type { ChatVisualSpec } from "@/types/chatVisuals";
import type { FinanceSnapshot } from "@/lib/agentWorkspaceFinance";
import { extractOverdueQueue, extractVendorRegister } from "@/lib/agentWorkspaceFinance";
import AgentFinanceRegisterTable from "@/components/AgentFinanceRegisterTable";

const REPORT_ACTIONS = [
    {
        id: "aging",
        label: "AP aging analysis",
        description: "Overdue payables by due-date bucket",
        prompt: "Chart AP aging and summarize overdue vendors",
        icon: Clock,
    },
    {
        id: "vendors",
        label: "Vendor concentration",
        description: "Top vendors by spend and outstanding balance",
        prompt: "Show vendor totals ranked by spend",
        icon: LineChart,
    },
    {
        id: "report",
        label: "Finance report PDF",
        description: "Printable AP/AR summary for leadership",
        prompt: "Generate finance report",
        icon: FileBarChart,
    },
    {
        id: "duplicates",
        label: "Duplicate invoice scan",
        description: "Flag possible duplicate billings in scope",
        prompt: "Are there duplicate invoices in my scoped documents?",
        icon: Copy,
    },
];

const DEEP_ACTIONS = [
    {
        id: "trend",
        label: "Monthly trend",
        description: "Invoice volume and spend over time",
        prompt: "Chart invoice trend by month",
        icon: Sparkles,
    },
    {
        id: "line-items",
        label: "Line item breakdown",
        description: "Item-level detail from scoped invoices",
        prompt: "Show items list and chart",
        icon: Sparkles,
    },
];

type Props = {
    snapshot: FinanceSnapshot;
    accent: string;
    visuals: ChatVisualSpec[];
    onRunInChat: (prompt: string) => void;
};

export default function AgentFinanceReportsPanel({
    snapshot,
    accent,
    visuals,
    onRunInChat,
}: Props) {
    const overdueQueue = extractOverdueQueue(visuals, 8);
    const vendorRegister = extractVendorRegister(visuals, 10);

    return (
        <section className="rounded-2xl border border-border overflow-hidden bg-surface/50">
            <div
                className="px-4 py-4 border-b border-border bg-surface/40"
                style={{ boxShadow: `inset 3px 0 0 ${accent}` }}
            >
                <p className="text-sm font-bold text-foreground flex items-center gap-2">
                    <FileBarChart size={16} style={{ color: accent }} />
                    Finance reports hub
                </p>
                <p className="text-xs text-foreground-muted mt-1 max-w-xl">
                    Senior finance workflows — AP aging, vendor analysis, printable reports, and data-quality checks.
                </p>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-0 sm:divide-x divide-border border-b border-border">
                {REPORT_ACTIONS.map((action) => {
                    const Icon = action.icon;
                    return (
                        <button
                            key={action.id}
                            type="button"
                            onClick={() => onRunInChat(action.prompt)}
                            className="text-left px-4 py-4 hover:bg-surface-2/50 transition-colors"
                        >
                            <Icon size={18} style={{ color: accent }} className="mb-2" />
                            <p className="text-xs font-bold text-foreground">{action.label}</p>
                            <p className="text-[10px] text-foreground-muted mt-1">{action.description}</p>
                        </button>
                    );
                })}
            </div>

            <div className="px-4 py-3 border-b border-border bg-surface-2/20 flex flex-wrap gap-4 text-xs">
                <span>
                    <strong className="text-foreground">
                        {snapshot.stats.apSpend > 0
                            ? `${snapshot.stats.currency} ${Math.round(snapshot.stats.apSpend).toLocaleString()}`
                            : "—"}
                    </strong>{" "}
                    <span className="text-foreground-muted">AP spend</span>
                </span>
                <span>
                    <strong className="text-foreground">{snapshot.stats.vendorCount}</strong>{" "}
                    <span className="text-foreground-muted">vendors</span>
                </span>
                <span>
                    <strong className="text-foreground">
                        {snapshot.stats.overdueAmount > 0
                            ? `${snapshot.stats.currency} ${Math.round(snapshot.stats.overdueAmount).toLocaleString()}`
                            : "—"}
                    </strong>{" "}
                    <span className="text-foreground-muted">overdue</span>
                </span>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-0 sm:divide-x divide-border border-b border-border">
                {DEEP_ACTIONS.map((action) => {
                    const Icon = action.icon;
                    return (
                        <button
                            key={action.id}
                            type="button"
                            onClick={() => onRunInChat(action.prompt)}
                            className="text-left px-4 py-3 hover:bg-surface-2/40 transition-colors flex items-start gap-3"
                        >
                            <Icon size={16} style={{ color: accent }} className="shrink-0 mt-0.5" />
                            <div>
                                <p className="text-xs font-semibold text-foreground">{action.label}</p>
                                <p className="text-[10px] text-foreground-muted">{action.description}</p>
                            </div>
                        </button>
                    );
                })}
            </div>

            {overdueQueue.length > 0 ? (
                <div className="p-4">
                    <AgentFinanceRegisterTable
                        rows={overdueQueue}
                        accent={accent}
                        title="Overdue AP — action list"
                        onAsk={() => onRunInChat("Chart AP aging and summarize overdue vendors")}
                    />
                </div>
            ) : vendorRegister.length > 0 ? (
                <div className="p-4">
                    <AgentFinanceRegisterTable
                        rows={vendorRegister}
                        accent={accent}
                        title="Top vendors by AP"
                        onAsk={() => onRunInChat("Show vendor totals ranked by spend")}
                    />
                </div>
            ) : (
                <div className="px-4 py-8 text-center text-sm text-foreground-muted">
                    Upload invoices with extracted amounts, then run{" "}
                    <button
                        type="button"
                        className="font-semibold underline"
                        style={{ color: accent }}
                        onClick={() => onRunInChat("Show vendor totals")}
                    >
                        Show vendor totals
                    </button>{" "}
                    in chat to populate reports.
                </div>
            )}
        </section>
    );
}
