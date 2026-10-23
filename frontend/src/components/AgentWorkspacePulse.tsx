"use client";

import React from "react";
import Link from "next/link";
import { ArrowRight, Upload } from "lucide-react";
import type { WorkspaceMetrics } from "@/lib/agentWorkspaceInsights";
import { pulseStatusTone, type WorkspacePulseData } from "@/lib/agentWorkspacePulse";
import { cn } from "@/lib/utils";

type Props = {
    shortName: string;
    metrics: WorkspaceMetrics;
    pulse: WorkspacePulseData;
    accent: string;
    live?: boolean;
    lastUpdated?: string | null;
    onPrimaryAction?: () => void;
};

function formatUpdated(iso: string | null | undefined): string | null {
    if (!iso) return null;
    const mins = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
    if (mins < 1) return "Just now";
    if (mins < 60) return `${mins}m ago`;
    return `${Math.floor(mins / 60)}h ago`;
}

const TONE = {
    empty: {
        dot: "bg-foreground-muted",
        bar: "bg-foreground-muted/40",
        label: "text-foreground-muted",
    },
    attention: {
        dot: "bg-amber-500",
        bar: "bg-amber-500",
        label: "text-amber-700 dark:text-amber-400",
    },
    ready: {
        dot: "bg-emerald-500",
        bar: "bg-emerald-500",
        label: "text-emerald-700 dark:text-emerald-400",
    },
} as const;

export default function AgentWorkspacePulse({
    shortName,
    metrics,
    pulse,
    accent,
    live,
    lastUpdated,
    onPrimaryAction,
}: Props) {
    const tone = pulseStatusTone(metrics);
    const styles = TONE[tone];
    const updated = formatUpdated(lastUpdated);

    return (
        <div className="rounded-xl border border-border bg-surface/30 overflow-hidden">
            <div className="h-0.5 w-full" style={{ backgroundColor: accent, opacity: 0.45 }} />

            <div className="px-3 py-2 sm:px-4">
                <div className="flex flex-col sm:flex-row sm:items-center gap-2 sm:gap-4">
                    <div className="flex items-center gap-2 shrink-0">
                        <div>
                            <p className="text-lg font-bold tabular-nums leading-none text-foreground">
                                {metrics.healthScore}%
                            </p>
                            <p className={cn("text-[10px] font-medium mt-0.5", styles.label)}>
                                {metrics.healthLabel}
                            </p>
                        </div>
                        <div className="hidden sm:block h-8 w-px bg-border" />
                    </div>

                    <div className="flex-1 min-w-0 space-y-2">
                        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                            <span className="text-xs font-semibold text-foreground">{shortName}</span>
                            <span className="text-xs text-foreground-muted hidden sm:inline">·</span>
                            <p className="text-xs text-foreground-muted leading-snug">{pulse.summary}</p>
                        </div>

                        {metrics.totalDocs > 0 && (
                            <div className="flex items-center gap-3">
                                <div className="flex-1 h-1 rounded-full bg-border overflow-hidden">
                                    <div
                                        className={cn("h-full rounded-full transition-all duration-500", styles.bar)}
                                        style={{ width: `${pulse.chartCoveragePct}%` }}
                                    />
                                </div>
                                <span className="text-[10px] tabular-nums text-foreground-muted shrink-0">
                                    {metrics.chartedDocs}/{metrics.totalDocs} charted
                                </span>
                            </div>
                        )}
                    </div>

                    <div className="flex items-center gap-3 shrink-0 sm:pl-2">
                        <div className="hidden md:flex flex-col items-end text-[10px] text-foreground-muted tabular-nums">
                            {live !== undefined && (
                                <span className="inline-flex items-center gap-1">
                                    <span
                                        className={cn(
                                            "h-1.5 w-1.5 rounded-full",
                                            live ? styles.dot : "bg-foreground-muted"
                                        )}
                                    />
                                    {live ? "Live" : "Paused"}
                                </span>
                            )}
                            {updated && <span>{updated}</span>}
                        </div>

                        {pulse.primaryAction === "upload" ? (
                            <Link
                                href="/documents"
                                className="inline-flex items-center gap-1.5 rounded-lg border border-accent bg-accent-muted text-accent px-3 py-2 text-xs font-semibold hover:bg-accent-muted/80"
                            >
                                <Upload size={13} />
                                {pulse.primaryActionLabel}
                            </Link>
                        ) : pulse.primaryAction !== "none" && onPrimaryAction ? (
                            <button
                                type="button"
                                onClick={onPrimaryAction}
                                className={cn(
                                    "inline-flex items-center gap-1.5 rounded-lg px-3 py-2 text-xs font-semibold transition-colors border",
                                    tone === "attention"
                                        ? "border-amber-500/40 bg-amber-500/10 text-amber-900 dark:text-amber-200 hover:bg-amber-500/15"
                                        : "border-border bg-background hover:bg-surface-2 text-foreground"
                                )}
                            >
                                {pulse.primaryActionLabel}
                                <ArrowRight size={13} />
                            </button>
                        ) : null}
                    </div>
                </div>
            </div>
        </div>
    );
}
