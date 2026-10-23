"use client";

import React from "react";
import { cn } from "@/lib/utils";
import type { WorkspaceMetrics } from "@/lib/agentWorkspaceInsights";

type Props = {
    metrics: WorkspaceMetrics;
    accent: string;
    live?: boolean;
    activeTab: string;
    className?: string;
};

const TAB_LABELS: Record<string, string> = {
    home: "Command",
    charts: "Analytics",
    files: "Portfolio",
    reports: "Reports",
    fix: "Fix",
    ask: "Ask",
};

export default function AgentWorkspaceStatusBar({ metrics, accent, live, activeTab, className }: Props) {
    return (
        <div className={cn("shrink-0 border-t border-border bg-surface/60 backdrop-blur-md", className)}>
            <div className="max-w-[1600px] mx-auto px-4 sm:px-6 lg:px-8 py-2 flex flex-wrap items-center justify-between gap-3 text-[10px]">
                <span className="font-semibold uppercase tracking-wider text-foreground-muted">
                    Viewing <span style={{ color: accent }}>{TAB_LABELS[activeTab] || activeTab}</span>
                </span>
                <div className="flex items-center gap-4">
                    {metrics.skippedDocs > 0 && (
                        <span className="font-semibold text-amber-700 dark:text-amber-400 tabular-nums">
                            {metrics.skippedDocs} issue{metrics.skippedDocs === 1 ? "" : "s"}
                        </span>
                    )}
                    {live !== undefined && (
                        <span
                            className={cn(
                                "font-semibold uppercase tracking-wider",
                                live ? "text-emerald-600 dark:text-emerald-400" : "text-foreground-muted"
                            )}
                        >
                            {live ? "● Live" : "Paused"}
                        </span>
                    )}
                </div>
            </div>
        </div>
    );
}
