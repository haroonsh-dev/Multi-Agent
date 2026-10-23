"use client";

import React from "react";
import { Download, FileBarChart, MessageSquare, Sparkles } from "lucide-react";
import type { AnalyticsAgentId } from "@/lib/documentAgents";
import { AGENT_POWER_ACTIONS, AGENT_QUICK_ASKS } from "@/lib/agentWorkspace";
import type { ChatVisualSpec } from "@/types/chatVisuals";
import { downloadVisualsCsv } from "@/lib/analyticsExport";

type Props = {
    agentId: AnalyticsAgentId;
    accent: string;
    accentMuted: string;
    shortName: string;
    visuals: ChatVisualSpec[];
    onRunInChat: (prompt: string) => void;
    onOpenFullChat: (prompt?: string) => void;
};

export default function AgentReportsPanel({
    agentId,
    accent,
    accentMuted,
    shortName,
    visuals,
    onRunInChat,
    onOpenFullChat,
}: Props) {
    const powerActions = AGENT_POWER_ACTIONS[agentId] || [];
    const quickAsks = AGENT_QUICK_ASKS[agentId] || [];

    return (
        <div className="space-y-6">
            <div
                className="rounded-2xl border px-4 py-4 flex flex-wrap items-start justify-between gap-4"
                style={{ borderColor: `${accent}33`, backgroundColor: accentMuted }}
            >
                <div>
                    <p className="text-sm font-bold text-foreground flex items-center gap-2">
                        <Sparkles size={16} style={{ color: accent }} />
                        Reports & deep tasks
                    </p>
                    <p className="text-xs text-foreground-muted mt-1 max-w-xl">
                        Run in the inline chat on desktop — charts and summaries refresh automatically. PDF reports open in full chat when needed.
                    </p>
                </div>
                {visuals.length > 0 && (
                    <button
                        type="button"
                        onClick={() => downloadVisualsCsv(visuals, `${agentId}-export.csv`)}
                        className="btn-secondary rounded-xl px-3 py-2 text-xs inline-flex items-center gap-1.5 shrink-0"
                    >
                        <Download size={13} /> Export CSV
                    </button>
                )}
            </div>

            <section>
                <p className="text-[10px] font-semibold uppercase tracking-wider text-foreground-muted mb-3 flex items-center gap-1.5">
                    <FileBarChart size={12} /> Power actions
                </p>
                <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-3">
                    {powerActions.map((action) => (
                        <div
                            key={action.id}
                            className="group rounded-2xl border border-border bg-surface/60 p-4 flex flex-col gap-3 hover:border-accent/40 hover:shadow-lg transition-all"
                        >
                            <div className="flex items-start gap-3">
                                <div
                                    className="h-9 w-9 rounded-xl flex items-center justify-center shrink-0"
                                    style={{ backgroundColor: accentMuted }}
                                >
                                    <FileBarChart size={16} style={{ color: accent }} />
                                </div>
                                <div>
                                    <p className="text-sm font-bold text-foreground group-hover:text-accent transition-colors">
                                        {action.label}
                                    </p>
                                    <p className="text-[11px] text-foreground-muted mt-1">{action.description}</p>
                                </div>
                            </div>
                            <div className="flex flex-wrap gap-2 mt-auto">
                                <button
                                    type="button"
                                    onClick={() => onRunInChat(action.prompt)}
                                    className="rounded-lg px-3 py-1.5 text-[11px] font-semibold text-white"
                                    style={{ backgroundColor: accent }}
                                >
                                    Run here
                                </button>
                                <button
                                    type="button"
                                    onClick={() => onOpenFullChat(action.prompt)}
                                    className="rounded-lg border border-border px-3 py-1.5 text-[11px] font-semibold hover:bg-surface-2"
                                >
                                    Full chat
                                </button>
                            </div>
                        </div>
                    ))}
                </div>
            </section>

            <section>
                <p className="text-[10px] font-semibold uppercase tracking-wider text-foreground-muted mb-3 flex items-center gap-1.5">
                    <MessageSquare size={12} /> Quick asks for {shortName}
                </p>
                <div className="flex flex-wrap gap-2">
                    {quickAsks.map((prompt) => (
                        <button
                            key={prompt}
                            type="button"
                            onClick={() => onRunInChat(prompt)}
                            className="rounded-full border border-border bg-background px-3 py-2 text-xs font-medium hover:border-accent/40 text-left"
                        >
                            {prompt}
                        </button>
                    ))}
                </div>
            </section>
        </div>
    );
}
