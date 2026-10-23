"use client";

import React from "react";
import { AlertTriangle, CheckCircle2, CircleDashed, Sparkles, XCircle } from "lucide-react";
import type { AgentVerdict } from "@/lib/agentWorkspaceVerdict";
import { cn } from "@/lib/utils";

type Props = {
    agentName: string;
    verdict: AgentVerdict;
    accent: string;
    onRecommend?: (rec: AgentVerdict["recommendations"][number]) => void;
};

const STATUS_STYLES = {
    good: {
        icon: CheckCircle2,
        border: "border-emerald-500/30",
        bg: "bg-emerald-500/5",
        text: "text-emerald-700 dark:text-emerald-400",
        dot: "bg-emerald-500",
    },
    attention: {
        icon: AlertTriangle,
        border: "border-amber-500/30",
        bg: "bg-amber-500/5",
        text: "text-amber-800 dark:text-amber-300",
        dot: "bg-amber-500",
    },
    critical: {
        icon: XCircle,
        border: "border-red-500/30",
        bg: "bg-red-500/5",
        text: "text-red-700 dark:text-red-400",
        dot: "bg-red-500",
    },
    empty: {
        icon: CircleDashed,
        border: "border-border",
        bg: "bg-surface/40",
        text: "text-foreground-muted",
        dot: "bg-foreground-muted",
    },
} as const;

const IMPACT_CLASS = {
    high: "bg-red-500/10 text-red-700 dark:text-red-400",
    medium: "bg-amber-500/10 text-amber-800 dark:text-amber-300",
    low: "bg-surface-2 text-foreground-muted",
};

export default function AgentVerdictPanel({ agentName, verdict, accent, onRecommend }: Props) {
    const styles = STATUS_STYLES[verdict.status];
    const Icon = styles.icon;

    return (
        <div className="grid grid-cols-1 lg:grid-cols-5 gap-3">
            <div
                className={cn("lg:col-span-2 rounded-2xl border p-4", styles.border, styles.bg)}
                style={{ boxShadow: `inset 3px 0 0 ${accent}` }}
            >
                <p className="text-[10px] font-bold uppercase tracking-[0.14em] text-foreground-muted">
                    {agentName} agent verdict
                </p>
                <div className="flex items-center gap-2 mt-2">
                    <Icon size={18} className={styles.text} />
                    <p className={cn("text-sm font-bold", styles.text)}>{verdict.statusLabel}</p>
                </div>
                <p className="text-xs text-foreground-muted mt-2 leading-relaxed">{verdict.summary}</p>
            </div>

            <div className="lg:col-span-3 rounded-2xl border border-border bg-surface/30 p-4">
                <p className="text-[10px] font-bold uppercase tracking-[0.14em] text-foreground-muted flex items-center gap-1.5 mb-3">
                    <Sparkles size={12} style={{ color: accent }} />
                    Top recommendations
                </p>
                <div className="space-y-2">
                    {verdict.recommendations.map((rec) => (
                        <button
                            key={rec.id}
                            type="button"
                            onClick={() => onRecommend?.(rec)}
                            className="w-full text-left rounded-xl border border-border bg-background/50 px-3 py-2.5 hover:border-accent/40 hover:bg-surface-2/50 transition-colors flex items-start gap-2"
                        >
                            <span
                                className={cn(
                                    "text-[9px] font-bold uppercase tracking-wider rounded-full px-2 py-0.5 shrink-0 mt-0.5",
                                    IMPACT_CLASS[rec.impact]
                                )}
                            >
                                {rec.impact}
                            </span>
                            <div className="min-w-0 flex-1">
                                <p className="text-xs font-semibold text-foreground">{rec.title}</p>
                                {rec.detail && (
                                    <p className="text-[10px] text-foreground-muted mt-0.5 line-clamp-2">{rec.detail}</p>
                                )}
                            </div>
                        </button>
                    ))}
                </div>
            </div>
        </div>
    );
}
