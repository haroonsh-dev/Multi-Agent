"use client";

import React from "react";
import type { SpotlightKpi } from "@/lib/agentWorkspaceKpis";
import { cn } from "@/lib/utils";

type Props = {
    kpis: SpotlightKpi[];
    accent: string;
};

function KpiCard({ kpi, accent }: { kpi: SpotlightKpi; accent: string }) {
    const toneClass =
        kpi.tone === "success"
            ? "text-emerald-600 dark:text-emerald-400"
            : kpi.tone === "warn"
              ? "text-amber-600 dark:text-amber-400"
              : kpi.tone === "accent"
                ? "text-accent"
                : "text-foreground";

    return (
        <div className="relative overflow-hidden rounded-xl border border-border/70 bg-gradient-to-br from-background to-surface/40 p-3 min-h-[72px] flex flex-col justify-between">
            <div className="absolute top-0 left-0 right-0 h-0.5 opacity-80" style={{ backgroundColor: accent }} />
            <p className="text-[10px] font-semibold uppercase tracking-wider text-foreground-muted truncate pr-1">
                {kpi.label}
            </p>
            <p className={cn("text-xl font-bold tabular-nums truncate mt-1", toneClass)}>{kpi.value}</p>
            {kpi.hint && (
                <p className="text-[10px] text-foreground-muted mt-1 truncate leading-tight">{kpi.hint}</p>
            )}
        </div>
    );
}

export default function AgentKpiStrip({ kpis, accent }: Props) {
    if (!kpis.length) return null;
    return (
        <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-3">
            {kpis.map((kpi) => (
                <KpiCard key={kpi.label} kpi={kpi} accent={accent} />
            ))}
        </div>
    );
}
