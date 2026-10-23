"use client";

import React, { useMemo, useState } from "react";
import AgentPortfolioPanel from "@/components/AgentPortfolioPanel";
import type { AgentVaultDoc } from "@/hooks/useAgentPortfolio";
import type { PortfolioFile } from "@/lib/agentWorkspaceKpis";
import { HR_ANALYTICS_GROUPS, filterPortfolioByPillar, type HrPillarId } from "@/lib/agentWorkspaceHr";
import { cn } from "@/lib/utils";

type Props = {
    files: PortfolioFile[];
    vaultDocs: AgentVaultDoc[];
    loading?: boolean;
    accent: string;
    onAskFix: (filename: string) => void;
};

const PILLAR_FILTERS: Array<{ id: HrPillarId | "all"; label: string }> = [
    { id: "all", label: "All HR files" },
    { id: "hiring", label: "Hiring" },
    { id: "people", label: "People" },
    { id: "time", label: "Leave" },
    { id: "pay", label: "Pay & dev" },
];

export default function AgentHrPortfolioPanel({ files, vaultDocs, loading, accent, onAskFix }: Props) {
    const [pillar, setPillar] = useState<HrPillarId | "all">("all");

    const filtered = useMemo(
        () => filterPortfolioByPillar(files, vaultDocs, pillar),
        [files, vaultDocs, pillar]
    );

    const counts = useMemo(() => {
        const map: Record<string, number> = { all: files.length };
        for (const g of HR_ANALYTICS_GROUPS) {
            if (g.id === "all") continue;
            map[g.id] = filterPortfolioByPillar(files, vaultDocs, g.id as HrPillarId).length;
        }
        return map;
    }, [files, vaultDocs]);

    return (
        <div className="space-y-4">
            <div className="flex flex-wrap gap-1.5">
                {PILLAR_FILTERS.map((f) => (
                    <button
                        key={f.id}
                        type="button"
                        onClick={() => setPillar(f.id)}
                        className={cn(
                            "rounded-full px-3 py-1.5 text-[11px] font-semibold border transition-colors",
                            pillar === f.id
                                ? "border-accent bg-accent-muted text-accent"
                                : "border-border text-foreground-muted hover:text-foreground"
                        )}
                    >
                        {f.label}
                        <span className="ml-1 opacity-80 tabular-nums">({counts[f.id] ?? 0})</span>
                    </button>
                ))}
            </div>
            <AgentPortfolioPanel
                files={filtered}
                loading={loading}
                accent={accent}
                onAskFix={onAskFix}
            />
        </div>
    );
}
