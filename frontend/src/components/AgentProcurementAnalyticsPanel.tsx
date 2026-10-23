"use client";

import React, { useMemo, useState } from "react";
import { MessageSquare } from "lucide-react";
import ChatAnalyticsSidePanel, { type AnalyticsPanelView } from "@/components/ChatAnalyticsSidePanel";
import AgentProcurementRegisterTable from "@/components/AgentProcurementRegisterTable";
import type {
    AgentAnalyticsCoverage,
    ChatVisualSpec,
    ComplianceAnalyticsCoverage,
    FinanceAnalyticsCoverage,
} from "@/types/chatVisuals";
import {
    PROC_ANALYTICS_GROUPS,
    deriveProcViewKpis,
    extractOrderRegister,
    procGroupForView,
    type ProcAnalyticsGroupId,
    type ProcurementSnapshot,
} from "@/lib/agentWorkspaceProcurement";
import { cn } from "@/lib/utils";

type Props = {
    accent: string;
    snapshot: ProcurementSnapshot;
    visuals: ChatVisualSpec[];
    loading: boolean;
    documentCount?: number;
    scopeMode: "all" | "selected";
    coverage: FinanceAnalyticsCoverage | ComplianceAnalyticsCoverage | AgentAnalyticsCoverage | null;
    view: AnalyticsPanelView;
    onViewChange: (view: AnalyticsPanelView) => void;
    onRefresh: () => void;
    onRunPrompt: (prompt: string) => void;
    onClose: () => void;
};

export default function AgentProcurementAnalyticsPanel({
    accent,
    snapshot,
    visuals,
    loading,
    documentCount,
    scopeMode,
    coverage,
    view,
    onViewChange,
    onRefresh,
    onRunPrompt,
    onClose,
}: Props) {
    const [group, setGroup] = useState<ProcAnalyticsGroupId>(() => procGroupForView(view));

    const activeGroup = PROC_ANALYTICS_GROUPS.find((g) => g.id === group) || PROC_ANALYTICS_GROUPS[0];
    const kpis = useMemo(() => deriveProcViewKpis(visuals, view), [visuals, view]);
    const register = useMemo(() => extractOrderRegister(visuals, 10), [visuals]);
    const showRegister =
        register.length > 0 && (view === "po_status" || view === "overview" || group === "orders");

    const selectGroup = (id: ProcAnalyticsGroupId) => {
        setGroup(id);
        const g = PROC_ANALYTICS_GROUPS.find((x) => x.id === id);
        if (g) onViewChange(g.defaultView as AnalyticsPanelView);
    };

    return (
        <div className="flex flex-col rounded-2xl border border-border bg-surface/30 overflow-hidden">
            <div className="shrink-0 border-b border-border bg-surface/40 px-4 sm:px-5 py-4 space-y-3">
                <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                        <p className="text-sm font-bold text-foreground">Procurement analytics</p>
                        <p className="text-xs text-foreground-muted mt-0.5">
                            {snapshot.stats.totalFiles} files · {snapshot.stats.totalOrders} orders · {visuals.length}{" "}
                            chart{visuals.length === 1 ? "" : "s"}
                        </p>
                    </div>
                    <div className="flex flex-wrap gap-1.5">
                        {PROC_ANALYTICS_GROUPS.map((g) => (
                            <button
                                key={g.id}
                                type="button"
                                onClick={() => selectGroup(g.id)}
                                className={cn(
                                    "rounded-lg px-2.5 py-1.5 text-[11px] font-semibold transition-colors border",
                                    group === g.id
                                        ? "border-accent bg-accent-muted text-accent"
                                        : "border-border text-foreground-muted hover:text-foreground hover:bg-surface-2"
                                )}
                            >
                                {g.label}
                            </button>
                        ))}
                    </div>
                </div>

                {kpis.length > 0 && (
                    <div className="flex flex-wrap gap-4 pt-1">
                        {kpis.map((k) => (
                            <div key={k.label}>
                                <p className="text-[10px] font-medium uppercase tracking-wider text-foreground-muted">
                                    {k.label}
                                </p>
                                <p className="text-base font-bold tabular-nums">{k.value}</p>
                            </div>
                        ))}
                    </div>
                )}

                {!loading && visuals.length === 0 && (
                    <div className="rounded-xl border border-dashed border-border bg-background/50 px-4 py-3 flex flex-wrap items-center justify-between gap-3">
                        <p className="text-xs text-foreground-muted max-w-lg">{activeGroup.emptyHint}</p>
                        <button
                            type="button"
                            onClick={() => onRunPrompt(activeGroup.askPrompt)}
                            className="inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-[11px] font-semibold hover:bg-surface-2"
                        >
                            <MessageSquare size={12} style={{ color: accent }} />
                            Run in chat
                        </button>
                    </div>
                )}
            </div>

            {showRegister && (
                <div className="shrink-0 px-4 sm:px-5 py-3 border-b border-border">
                    <AgentProcurementRegisterTable
                        rows={register}
                        accent={accent}
                        maxRows={5}
                        onAsk={onRunPrompt}
                        compact
                    />
                </div>
            )}

            <div className="flex-1 min-h-0 flex flex-col">
                <ChatAnalyticsSidePanel
                    layout="page"
                    open
                    onClose={onClose}
                    agentId="procurement_agent"
                    visuals={visuals}
                    loading={loading}
                    onRefresh={onRefresh}
                    view={view}
                    onViewChange={(v) => {
                        setGroup(procGroupForView(v));
                        onViewChange(v);
                    }}
                    documentCount={documentCount}
                    unifiedHeader
                    suppressCoverageBanner
                    scopeMode={scopeMode}
                    coverage={coverage}
                    scopeDocCount={documentCount}
                    onRunPrompt={onRunPrompt}
                />
            </div>
        </div>
    );
}
