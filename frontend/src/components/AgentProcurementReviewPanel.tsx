"use client";

import React from "react";
import { GitCompare, Scale, Sparkles } from "lucide-react";
import type { ChatVisualSpec } from "@/types/chatVisuals";
import type { ProcurementSnapshot } from "@/lib/agentWorkspaceProcurement";
import { extractDiscrepancyQueue, extractOrderRegister } from "@/lib/agentWorkspaceProcurement";
import AgentProcurementRegisterTable from "@/components/AgentProcurementRegisterTable";

type Props = {
    snapshot: ProcurementSnapshot;
    accent: string;
    visuals: ChatVisualSpec[];
    onRunInChat: (prompt: string) => void;
};

const REVIEW_ACTIONS = [
    {
        id: "match",
        label: "3-way match",
        description: "Compare PO, delivery note, and invoice amounts",
        prompt: "Run 3-way PO matching for all documents in scope",
        icon: Scale,
    },
    {
        id: "quotes",
        label: "Compare quotes",
        description: "Rank vendor bids by price and terms",
        prompt: "Compare vendor quotes and rank by price",
        icon: GitCompare,
    },
    {
        id: "summary",
        label: "Procurement summary",
        description: "Full register with open, fulfilled, and flagged orders",
        prompt: "Show procurement summary for all POs",
        icon: Sparkles,
    },
];

export default function AgentProcurementReviewPanel({
    snapshot,
    accent,
    visuals,
    onRunInChat,
}: Props) {
    const reviewQueue = extractDiscrepancyQueue(visuals, 8);
    const allRegister = extractOrderRegister(visuals, 12);

    return (
        <section className="rounded-2xl border border-border overflow-hidden bg-surface/50">
            <div
                className="px-4 py-4 border-b border-border bg-surface/40"
                style={{ boxShadow: `inset 3px 0 0 ${accent}` }}
            >
                <p className="text-sm font-bold text-foreground flex items-center gap-2">
                    <Scale size={16} style={{ color: accent }} />
                    Match & review
                </p>
                <p className="text-xs text-foreground-muted mt-1 max-w-xl">
                    Senior procurement workflows — reconcile variances, compare bids, and close open PO loops.
                </p>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-0 sm:divide-x divide-border border-b border-border">
                {REVIEW_ACTIONS.map((action) => {
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
                    <strong className="text-foreground">{snapshot.stats.openCount}</strong>{" "}
                    <span className="text-foreground-muted">open</span>
                </span>
                <span>
                    <strong className="text-foreground">{snapshot.stats.discrepancyCount}</strong>{" "}
                    <span className="text-foreground-muted">need review</span>
                </span>
                <span>
                    <strong className="text-foreground">{snapshot.stats.fulfilledCount}</strong>{" "}
                    <span className="text-foreground-muted">fulfilled</span>
                </span>
            </div>

            {reviewQueue.length > 0 ? (
                <div className="p-4">
                    <AgentProcurementRegisterTable
                        rows={reviewQueue}
                        accent={accent}
                        maxRows={8}
                        onAsk={onRunInChat}
                        title="Review queue — open & flagged"
                    />
                </div>
            ) : allRegister.length > 0 ? (
                <div className="p-4">
                    <AgentProcurementRegisterTable
                        rows={allRegister}
                        accent={accent}
                        maxRows={8}
                        onAsk={onRunInChat}
                    />
                </div>
            ) : (
                <div className="py-12 px-4 text-center text-sm text-foreground-muted">
                    Upload POs and delivery notes to populate the review queue.
                </div>
            )}
        </section>
    );
}
