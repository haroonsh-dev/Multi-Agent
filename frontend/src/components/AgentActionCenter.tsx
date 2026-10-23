"use client";

import React from "react";
import { ClipboardCheck } from "lucide-react";
import type { PendingAction } from "@/lib/agentWorkspaceVerdict";
import { cn } from "@/lib/utils";

type Props = {
    actions: PendingAction[];
    accent: string;
    onAction: (action: PendingAction) => void;
};

const IMPACT_CLASS = {
    high: "bg-red-500/10 text-red-700 dark:text-red-400",
    medium: "bg-amber-500/10 text-amber-800 dark:text-amber-300",
    low: "bg-surface-2 text-foreground-muted",
};

const BTN_CLASS = {
    Approve: "border-emerald-500/40 bg-emerald-500/10 text-emerald-800 dark:text-emerald-300 hover:bg-emerald-500/15",
    Shortlist: "border-emerald-500/40 bg-emerald-500/10 text-emerald-800 dark:text-emerald-300 hover:bg-emerald-500/15",
    Review: "border-border bg-background hover:bg-surface-2 text-foreground",
    Run: "border-accent/40 bg-accent-muted text-accent hover:bg-accent-muted/80",
    Fix: "border-amber-500/40 bg-amber-500/10 text-amber-900 dark:text-amber-200 hover:bg-amber-500/15",
} as const;

export default function AgentActionCenter({ actions, accent, onAction }: Props) {
    if (!actions.length) return null;

    return (
        <section className="rounded-2xl border border-border bg-surface/30 overflow-hidden">
            <div
                className="px-4 py-3 border-b border-border flex items-center justify-between gap-2"
                style={{ boxShadow: `inset 3px 0 0 ${accent}` }}
            >
                <p className="text-xs font-bold text-foreground flex items-center gap-2">
                    <ClipboardCheck size={14} style={{ color: accent }} />
                    Action center
                </p>
                <span className="text-[10px] font-bold tabular-nums rounded-full px-2 py-0.5 bg-surface-2 text-foreground-muted">
                    {actions.length} pending
                </span>
            </div>
            <div className="divide-y divide-border">
                {actions.map((action) => (
                    <div
                        key={action.id}
                        className="px-4 py-3 flex flex-wrap items-center justify-between gap-3 hover:bg-surface-2/30"
                    >
                        <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-2 flex-wrap">
                                <span
                                    className={cn(
                                        "text-[9px] font-bold uppercase tracking-wider rounded-full px-2 py-0.5",
                                        IMPACT_CLASS[action.impact]
                                    )}
                                >
                                    {action.impact}
                                </span>
                                <p className="text-xs font-semibold text-foreground">{action.title}</p>
                            </div>
                            {action.detail && (
                                <p className="text-[10px] text-foreground-muted mt-0.5">{action.detail}</p>
                            )}
                        </div>
                        <button
                            type="button"
                            onClick={() => onAction(action)}
                            className={cn(
                                "shrink-0 rounded-lg border px-3 py-1.5 text-[10px] font-bold transition-colors",
                                BTN_CLASS[action.actionLabel]
                            )}
                        >
                            {action.actionLabel}
                        </button>
                    </div>
                ))}
            </div>
        </section>
    );
}
