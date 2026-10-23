"use client";

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import {
    AlertTriangle,
    BarChart3,
    CheckCircle2,
    CircleDashed,
    FileStack,
    Plug,
    RefreshCw,
    Sparkles,
    Upload,
    XCircle,
} from "lucide-react";
import type { AnalyticsAgentId } from "@/lib/documentAgents";
import { AGENT_QUICK_ASKS } from "@/lib/agentWorkspace";
import type { AttentionItem, WorkspaceMetrics } from "@/lib/agentWorkspaceInsights";
import type { PortfolioFile, SpotlightKpi } from "@/lib/agentWorkspaceKpis";
import type { WorkspaceIntegration } from "@/lib/integrationConnections";
import { formatLastSync } from "@/lib/integrationConnections";
import {
    deriveAgentVerdict,
    derivePendingActions,
    type AgentRecommendation,
    type PendingAction,
} from "@/lib/agentWorkspaceVerdict";
import { resolveCvShortlist, type CvPendingShortlistRow, type CvShortlistRow } from "@/lib/agentWorkspaceHr";
import type { HrShortlistNote } from "@/hooks/useHrShortlist";
import { extractVendorRegister } from "@/lib/agentWorkspaceFinance";
import { extractCertRegister } from "@/lib/agentWorkspaceCompliance";
import { extractOrderRegister } from "@/lib/agentWorkspaceProcurement";
import type { ChatVisualSpec } from "@/types/chatVisuals";
import AgentKpiStrip from "@/components/AgentKpiStrip";
import AgentChartPreviews from "@/components/AgentChartPreviews";
import AgentHrShortlistTable from "@/components/AgentHrShortlistTable";
import AgentFinanceRegisterTable from "@/components/AgentFinanceRegisterTable";
import AgentComplianceRegisterTable from "@/components/AgentComplianceRegisterTable";
import AgentProcurementRegisterTable from "@/components/AgentProcurementRegisterTable";
import AgentDataCoveragePanel from "@/components/AgentDataCoveragePanel";
import AgentDashboardSkeleton from "@/components/AgentDashboardSkeleton";
import AgentHrQuickActions from "@/components/AgentHrQuickActions";
import { cn } from "@/lib/utils";

type PriorityLike = {
    id: string;
    title: string;
    detail: string;
    tone: "warn" | "info";
    prompt?: string;
    chartView?: string;
};

type PillarLike = {
    id: string;
    label: string;
    subtitle?: string;
    count: number;
    chartView?: string;
    askPrompt: string;
    status?: "ready" | "partial" | "empty";
};

type Props = {
    agentId: AnalyticsAgentId;
    agentName: string;
    tagline: string;
    accent: string;
    accentMuted: string;
    kpis: SpotlightKpi[];
    metrics: WorkspaceMetrics;
    attention: AttentionItem[];
    plainSummary: string;
    visuals: ChatVisualSpec[];
    skippedFiles: PortfolioFile[];
    headline?: string;
    subline?: string;
    pillars?: PillarLike[];
    priorities?: PriorityLike[];
    integrations: WorkspaceIntegration[];
    loading?: boolean;
    lastUpdated?: string | null;
    onAsk: (prompt: string) => void;
    onOpenChart: (view: string) => void;
    onOpenFix: () => void;
    onOpenReports: () => void;
    onOpenOutreach?: () => void;
    onOpenAnalytics: () => void;
    hrShortlist?: CvShortlistRow[];
    hrPendingShortlistRows?: CvPendingShortlistRow[];
    hrPendingShortlistIds?: string[];
    hrShortlistLoading?: boolean;
    hrShortlistApprovingId?: string | null;
    onRefresh?: () => void;
    onApproveShortlist?: (documentIds: string[]) => void | Promise<void>;
    /** Approve Action Center items that reprocess extraction gaps (all agents). */
    onApproveReprocess?: (documentIds: string[]) => void | Promise<void>;
    skippedDocumentIds?: string[];
    shortlistApproving?: boolean;
    actionApproving?: boolean;
    shortlistNote?: HrShortlistNote | null;
    onDismissShortlistNote?: () => void;
    onSyncConnection?: (connectionId: string) => void;
    footer?: React.ReactNode;
};

const VERDICT_STYLES = {
    good: { icon: CheckCircle2, className: "text-emerald-600 dark:text-emerald-400", bg: "bg-emerald-500/8 border-emerald-500/25" },
    attention: { icon: AlertTriangle, className: "text-amber-700 dark:text-amber-300", bg: "bg-amber-500/8 border-amber-500/25" },
    critical: { icon: XCircle, className: "text-red-600 dark:text-red-400", bg: "bg-red-500/8 border-red-500/25" },
    empty: { icon: CircleDashed, className: "text-foreground-muted", bg: "bg-surface/40 border-border" },
} as const;

const IMPACT_BADGE = {
    high: "bg-red-500/12 text-red-700 dark:text-red-400",
    medium: "bg-amber-500/12 text-amber-800 dark:text-amber-300",
    low: "bg-surface-2 text-foreground-muted",
};

const ACTION_BTN = {
    Approve: "bg-emerald-600 text-white hover:bg-emerald-700 border-transparent",
    Shortlist: "bg-emerald-600 text-white hover:bg-emerald-700 border-transparent",
    Review: "border-border bg-background hover:bg-surface-2 text-foreground",
    Run: "bg-accent text-white hover:opacity-90 border-transparent",
    Fix: "border-amber-500/40 bg-amber-500/10 text-amber-900 dark:text-amber-200 hover:bg-amber-500/15",
} as const;

function formatUpdated(iso: string | null | undefined): string | null {
    if (!iso) return null;
    const mins = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
    if (mins < 1) return "Just now";
    if (mins < 60) return `${mins}m ago`;
    return `${Math.floor(mins / 60)}h ago`;
}

function IntelligenceRail({
    verdict,
    accent,
    pendingActions,
    onRecommend,
    onAction,
    actionApproving,
}: {
    verdict: ReturnType<typeof deriveAgentVerdict>;
    accent: string;
    pendingActions: PendingAction[];
    onRecommend: (rec: AgentRecommendation) => void;
    onAction: (action: PendingAction) => void;
    actionApproving?: boolean;
}) {
    const vStyle = VERDICT_STYLES[verdict.status];
    const VerdictIcon = vStyle.icon;

    return (
        <div className="space-y-4">
            <section className={cn("rounded-2xl border p-4", vStyle.bg)}>
                <p className="text-[10px] font-bold uppercase tracking-wider text-foreground-muted">Agent verdict</p>
                <div className="flex items-center gap-2 mt-2">
                    <VerdictIcon size={16} className={vStyle.className} />
                    <p className={cn("text-sm font-bold", vStyle.className)}>{verdict.statusLabel}</p>
                </div>
                <p className="text-xs text-foreground-muted mt-2 leading-relaxed">{verdict.summary}</p>
            </section>

            <section className="rounded-2xl border border-border bg-surface/30 overflow-hidden">
                <div className="px-4 py-3 border-b border-border flex items-center gap-2">
                    <Sparkles size={13} style={{ color: accent }} />
                    <p className="text-xs font-bold text-foreground">Recommendations</p>
                </div>
                <div className="divide-y divide-border">
                    {verdict.recommendations.slice(0, 4).map((rec) => (
                        <button
                            key={rec.id}
                            type="button"
                            onClick={() => onRecommend(rec)}
                            className="w-full text-left px-4 py-3 hover:bg-surface-2/40 transition-colors"
                        >
                            <div className="flex items-start gap-2">
                                <span
                                    className={cn(
                                        "text-[8px] font-bold uppercase rounded px-1.5 py-0.5 shrink-0 mt-0.5",
                                        IMPACT_BADGE[rec.impact]
                                    )}
                                >
                                    {rec.impact}
                                </span>
                                <div className="min-w-0">
                                    <p className="text-xs font-semibold text-foreground">{rec.title}</p>
                                    {rec.detail && (
                                        <p className="text-[10px] text-foreground-muted mt-0.5 line-clamp-2">{rec.detail}</p>
                                    )}
                                </div>
                            </div>
                        </button>
                    ))}
                </div>
            </section>

            {pendingActions.length > 0 && (
                <section className="rounded-2xl border border-border bg-surface/30 overflow-hidden">
                    <div className="px-4 py-3 border-b border-border flex items-center justify-between">
                        <p className="text-xs font-bold text-foreground">Action center</p>
                        <span className="text-[10px] font-bold tabular-nums rounded-full px-2 py-0.5 bg-amber-500/15 text-amber-800 dark:text-amber-300">
                            {pendingActions.length}
                        </span>
                    </div>
                    <div className="divide-y divide-border">
                        {pendingActions.slice(0, 4).map((action) => {
                            const isExecutableApprove =
                                action.actionLabel === "Approve" &&
                                (action.approveKind === "shortlist" || action.approveKind === "reprocess") &&
                                (action.documentIds?.length ?? 0) > 0;
                            const disabled = Boolean(actionApproving && isExecutableApprove);
                            const busyLabel =
                                action.approveKind === "reprocess" ? "Queuing…" : "Adding…";
                            return (
                            <div key={action.id} className="px-4 py-3 flex items-start justify-between gap-2">
                                <div className="min-w-0 flex-1">
                                    <p className="text-xs font-semibold text-foreground leading-snug">{action.title}</p>
                                    {action.detail && (
                                        <p className="text-[10px] text-foreground-muted mt-0.5 line-clamp-2">{action.detail}</p>
                                    )}
                                </div>
                                <button
                                    type="button"
                                    onClick={() => onAction(action)}
                                    disabled={disabled}
                                    className={cn(
                                        "shrink-0 rounded-md border px-2.5 py-1 text-[10px] font-bold transition-colors disabled:opacity-50",
                                        ACTION_BTN[action.actionLabel]
                                    )}
                                >
                                    {disabled ? busyLabel : action.actionLabel}
                                </button>
                            </div>
                            );
                        })}
                    </div>
                </section>
            )}
        </div>
    );
}

export default function AgentCommandDashboard({
    agentId,
    agentName,
    tagline,
    accent,
    accentMuted,
    kpis,
    metrics,
    attention,
    plainSummary,
    visuals,
    skippedFiles,
    headline,
    subline,
    pillars,
    priorities,
    integrations,
    loading,
    lastUpdated,
    onAsk,
    onOpenChart,
    onOpenFix,
    onOpenReports,
    onOpenOutreach,
    onOpenAnalytics,
    hrShortlist,
    hrPendingShortlistRows,
    hrPendingShortlistIds,
    hrShortlistLoading,
    hrShortlistApprovingId,
    onRefresh,
    onApproveShortlist,
    onApproveReprocess,
    skippedDocumentIds,
    shortlistApproving,
    actionApproving,
    shortlistNote,
    onDismissShortlistNote,
    onSyncConnection,
    footer,
}: Props) {
    const verdict = useMemo(
        () => deriveAgentVerdict(agentId, metrics, attention, plainSummary, priorities),
        [agentId, metrics, attention, plainSummary, priorities]
    );

    const pendingActions = useMemo(
        () =>
            derivePendingActions(agentId, metrics, attention, priorities, integrations, {
                skippedDocumentIds,
            }),
        [agentId, metrics, attention, priorities, integrations, skippedDocumentIds]
    );

    const railApproving = Boolean(actionApproving || shortlistApproving);

    const quickAsks = AGENT_QUICK_ASKS[agentId] || [];
    const updatedLabel = formatUpdated(lastUpdated);
    const cvShortlist = useMemo(
        () => (agentId === "hr_agent" ? resolveCvShortlist(hrShortlist, visuals, 8) : []),
        [agentId, hrShortlist, visuals]
    );

    const displayHeadline = headline || (metrics.totalDocs > 0 ? `${metrics.totalDocs} documents in portfolio` : "No documents yet");
    const displaySubline =
        subline ||
        (metrics.totalDocs > 0
            ? `${metrics.chartedDocs} chart-ready · ${metrics.healthScore}% readiness`
            : tagline);

    const handleRecommend = (rec: AgentRecommendation) => {
        if (rec.href) {
            window.location.href = rec.href;
            return;
        }
        if (rec.chartView) onOpenChart(rec.chartView);
        else if (rec.prompt) onAsk(rec.prompt);
    };

    const handleAction = (action: PendingAction) => {
        if (action.connectionId && onSyncConnection) {
            onSyncConnection(action.connectionId);
            return;
        }
        if (action.href) {
            window.location.href = action.href;
            return;
        }
        if (action.actionLabel === "Fix") {
            onOpenFix();
            return;
        }
        if (action.actionLabel === "Approve" && action.documentIds?.length) {
            if (action.approveKind === "shortlist" && onApproveShortlist) {
                void onApproveShortlist(action.documentIds);
                return;
            }
            if (action.approveKind === "reprocess" && onApproveReprocess) {
                void onApproveReprocess(action.documentIds);
                return;
            }
            // Legacy HR shortlist actions without approveKind
            if (!action.approveKind && onApproveShortlist) {
                void onApproveShortlist(action.documentIds);
                return;
            }
        }
        if (action.actionLabel === "Approve" || action.actionLabel === "Run" || action.actionLabel === "Shortlist") {
            if (action.prompt) {
                void onAsk(action.prompt);
                return;
            }
        }
        if (action.actionLabel === "Review" && action.chartView) {
            onOpenChart(action.chartView);
            return;
        }
        if (action.chartView) onOpenChart(action.chartView);
        else if (action.prompt) void onAsk(action.prompt);
    };

    const openOutreach = onOpenOutreach ?? onOpenReports;
    const shortlistRef = useRef<HTMLDivElement>(null);
    const [shortlistPanelVisible, setShortlistPanelVisible] = useState(false);
    const [shortlistHighlight, setShortlistHighlight] = useState(false);

    const hasHrShortlist = cvShortlist.length > 0;
    const hasHrPendingShortlist =
        (hrPendingShortlistRows?.length ?? 0) > 0 || (hrPendingShortlistIds?.length ?? 0) > 0;

    useEffect(() => {
        if (hasHrShortlist || hasHrPendingShortlist) {
            setShortlistPanelVisible(true);
        }
    }, [hasHrShortlist, hasHrPendingShortlist]);

    const handleOpenShortlist = useCallback(() => {
        setShortlistPanelVisible(true);
        setShortlistHighlight(true);
        onRefresh?.();
        window.setTimeout(() => {
            shortlistRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
        }, 50);
        window.setTimeout(() => setShortlistHighlight(false), 2500);
    }, [onRefresh]);

    const hrShortlistSection = useMemo(() => {
        if (agentId !== "hr_agent") return null;
        if (!shortlistPanelVisible && !hasHrShortlist && !hasHrPendingShortlist) return null;
        return (
            <AgentHrShortlistTable
                rows={cvShortlist}
                pendingRows={hrPendingShortlistRows}
                accent={accent}
                loading={hrShortlistLoading}
                onAsk={onAsk}
                onOpenOutreach={openOutreach}
                onApproveOne={
                    onApproveShortlist ? (documentId) => onApproveShortlist([documentId]) : undefined
                }
                onApproveAllPending={
                    onApproveShortlist && hrPendingShortlistIds?.length
                        ? () => onApproveShortlist(hrPendingShortlistIds)
                        : undefined
                }
                approving={shortlistApproving}
                approvingDocumentId={hrShortlistApprovingId}
            />
        );
    }, [
        agentId,
        shortlistPanelVisible,
        hasHrShortlist,
        hasHrPendingShortlist,
        cvShortlist,
        hrPendingShortlistRows,
        hrPendingShortlistIds,
        hrShortlistLoading,
        hrShortlistApprovingId,
        accent,
        onAsk,
        openOutreach,
        onApproveShortlist,
        shortlistApproving,
    ]);

    const registerSection = useMemo(() => {
        if (agentId === "hr_agent") return null;
        if (agentId === "finance_agent") {
            const rows = extractVendorRegister(visuals, 8);
            if (!rows.length) return null;
            return <AgentFinanceRegisterTable rows={rows} accent={accent} onAsk={onAsk} title="AP register" />;
        }
        if (agentId === "compliance_agent") {
            const rows = extractCertRegister(visuals, 8);
            if (!rows.length) return null;
            return <AgentComplianceRegisterTable rows={rows} accent={accent} onAsk={onAsk} />;
        }
        if (agentId === "procurement_agent") {
            const rows = extractOrderRegister(visuals, 8);
            if (!rows.length) return null;
            return <AgentProcurementRegisterTable rows={rows} accent={accent} onAsk={onAsk} />;
        }
        return null;
    }, [agentId, visuals, accent, onAsk, openOutreach, hrPendingShortlistIds, onApproveShortlist, shortlistApproving]);

    const isEmpty = metrics.totalDocs === 0;
    const primaryIntegration = integrations.find((c) => c.isActive);

    if (loading && metrics.totalDocs === 0 && visuals.length === 0) {
        return <AgentDashboardSkeleton />;
    }

    return (
        <div className="space-y-3 animate-in fade-in duration-300 pb-2">
            <div className="flex flex-wrap items-start justify-between gap-2 border-b border-border/60 pb-3">
                <div className="min-w-0 flex-1">
                    <h2 className="text-base font-bold text-foreground tracking-tight">{displayHeadline}</h2>
                    <p className="text-[11px] text-foreground-muted mt-0.5 max-w-2xl leading-relaxed">{displaySubline}</p>
                    {updatedLabel && (
                        <p className="text-[10px] text-foreground-muted mt-1">Updated {updatedLabel}</p>
                    )}
                </div>
                <div className="flex flex-wrap gap-1.5 shrink-0">
                    {onRefresh && (
                        <button
                            type="button"
                            onClick={onRefresh}
                            className="inline-flex items-center gap-1 rounded-lg border border-border bg-background/80 px-2.5 py-1.5 text-[11px] font-semibold hover:bg-surface-2"
                        >
                            <RefreshCw size={13} className={loading ? "animate-spin" : ""} /> Refresh
                        </button>
                    )}
                    <button
                        type="button"
                        onClick={onOpenAnalytics}
                        className="inline-flex items-center gap-1 rounded-lg border border-border bg-background/80 px-2.5 py-1.5 text-[11px] font-semibold hover:bg-surface-2"
                    >
                        <BarChart3 size={13} /> Analytics
                    </button>
                    <button
                        type="button"
                        onClick={onOpenReports}
                        className="inline-flex items-center gap-1 rounded-lg border border-border bg-background/80 px-2.5 py-1.5 text-[11px] font-semibold hover:bg-surface-2"
                    >
                        <FileStack size={13} /> Reports
                    </button>
                    <Link
                        href="/documents"
                        className="inline-flex items-center gap-1 rounded-lg px-2.5 py-1.5 text-[11px] font-semibold text-white hover:opacity-90"
                        style={{ backgroundColor: accent }}
                    >
                        <Upload size={13} /> Upload
                    </Link>
                </div>
            </div>

            {quickAsks.length > 0 && (
                <div className="flex flex-wrap gap-1.5 -mt-1">
                    {quickAsks.slice(0, 4).map((prompt) => (
                        <button
                            key={prompt}
                            type="button"
                            onClick={() => onAsk(prompt)}
                            className="rounded-full border border-border bg-background/70 px-2.5 py-1 text-[10px] font-medium hover:border-accent/40 hover:bg-surface-2 transition-colors"
                        >
                            {prompt}
                        </button>
                    ))}
                </div>
            )}

            <AgentKpiStrip kpis={kpis} accent={accent} />

            {shortlistNote && (
                <div
                    className={cn(
                        "rounded-xl border px-4 py-2.5 flex flex-wrap items-center justify-between gap-2 text-xs",
                        shortlistNote.tone === "ok"
                            ? "border-emerald-500/30 bg-emerald-500/8 text-emerald-900 dark:text-emerald-200"
                            : "border-red-500/30 bg-red-500/8 text-red-900 dark:text-red-200"
                    )}
                >
                    <p>{shortlistNote.text}</p>
                    {onDismissShortlistNote && (
                        <button
                            type="button"
                            onClick={onDismissShortlistNote}
                            className="text-[10px] font-semibold underline opacity-80 hover:opacity-100"
                        >
                            Dismiss
                        </button>
                    )}
                </div>
            )}

            {!isEmpty && (
                <AgentDataCoveragePanel
                    totalDocs={metrics.totalDocs}
                    chartedDocs={metrics.chartedDocs}
                    skippedDocs={metrics.skippedDocs}
                    healthScore={metrics.healthScore}
                    skippedFiles={skippedFiles}
                    accent={accent}
                    onOpenFix={onOpenFix}
                />
            )}

            {agentId === "hr_agent" && integrations.length === 0 && !isEmpty && (
                <div className="rounded-xl border border-dashed border-border bg-surface/20 px-4 py-3 flex flex-wrap items-center justify-between gap-3">
                    <div className="flex items-center gap-2 text-xs text-foreground-muted">
                        <Plug size={14} />
                        Connect ClickUp or Google Drive to auto-sync CVs into this workspace.
                    </div>
                    <Link href="/admin/integrations" className="text-xs font-semibold hover:underline" style={{ color: accent }}>
                        Connect →
                    </Link>
                </div>
            )}

            {agentId === "hr_agent" && primaryIntegration && (
                <p className="text-[10px] text-foreground-muted px-1">
                    Connected: <strong className="text-foreground">{primaryIntegration.label}</strong>
                    {primaryIntegration.lastSyncAt ? ` · ${formatLastSync(primaryIntegration.lastSyncAt)}` : ""}
                    {primaryIntegration.lastSyncSummary ? ` · ${primaryIntegration.lastSyncSummary}` : ""}
                </p>
            )}

            {agentId === "hr_agent" && !isEmpty && (
                <>
                    <AgentHrQuickActions
                        accent={accent}
                        onAsk={onAsk}
                        onOpenOutreach={openOutreach}
                        onOpenShortlist={handleOpenShortlist}
                        onOpenReports={onOpenReports}
                        hasShortlist={hasHrShortlist}
                    />
                    {hrShortlistSection && (
                        <div
                            ref={shortlistRef}
                            className={cn(
                                "transition-shadow duration-500 rounded-2xl",
                                shortlistHighlight && "ring-2 ring-offset-2 ring-offset-background"
                            )}
                            style={shortlistHighlight ? { boxShadow: `0 0 0 2px ${accent}` } : undefined}
                        >
                            {hrShortlistSection}
                        </div>
                    )}
                </>
            )}

            {isEmpty ? (
                <div className="rounded-2xl border border-dashed border-border bg-surface/30 px-6 py-14 text-center">
                    <p className="text-sm font-semibold text-foreground">Start your {agentName} dashboard</p>
                    <p className="text-xs text-foreground-muted mt-2 max-w-md mx-auto">{tagline}</p>
                    <div className="flex flex-wrap justify-center gap-2 mt-6">
                        <Link
                            href="/documents"
                            className="inline-flex items-center gap-2 rounded-xl px-4 py-2.5 text-sm font-semibold text-white"
                            style={{ backgroundColor: accent }}
                        >
                            <Upload size={15} /> Upload documents
                        </Link>
                        <Link
                            href="/admin/integrations"
                            className="inline-flex items-center gap-2 rounded-xl border border-border px-4 py-2.5 text-sm font-semibold hover:bg-surface-2"
                        >
                            Connect integration
                        </Link>
                    </div>
                </div>
            ) : (
                <div className="grid grid-cols-1 xl:grid-cols-12 gap-4 items-start">
                    {/* Mobile: intelligence first */}
                    <div className="xl:hidden order-1">
                        <IntelligenceRail
                            verdict={verdict}
                            accent={accent}
                            pendingActions={pendingActions}
                            onRecommend={handleRecommend}
                            onAction={handleAction}
                            actionApproving={railApproving}
                        />
                    </div>

                    <div className="xl:col-span-8 space-y-4 order-2 xl:order-1">
                        {visuals.length > 0 && (
                            <section className="rounded-2xl border border-border bg-surface/30 overflow-hidden">
                                <div className="px-4 py-3 border-b border-border flex items-center justify-between">
                                    <p className="text-xs font-bold text-foreground">Performance overview</p>
                                    <button
                                        type="button"
                                        onClick={onOpenAnalytics}
                                        className="text-[10px] font-semibold text-accent hover:underline"
                                    >
                                        Open analytics →
                                    </button>
                                </div>
                                <div className="p-4">
                                    <AgentChartPreviews
                                        visuals={visuals}
                                        maxCharts={2}
                                        onOpenCharts={onOpenAnalytics}
                                        hideHeader
                                    />
                                </div>
                            </section>
                        )}

                        {registerSection}

                        {pillars && pillars.length > 0 && (
                            <section className="rounded-2xl border border-border bg-surface/30 p-4">
                                <p className="text-[10px] font-bold uppercase tracking-wider text-foreground-muted mb-3">
                                    Workstreams
                                </p>
                                <div className="grid grid-cols-2 lg:grid-cols-4 gap-2">
                                    {pillars.map((pillar) => (
                                        <button
                                            key={pillar.id}
                                            type="button"
                                            onClick={() => {
                                                if (pillar.count > 0 && pillar.chartView) onOpenChart(pillar.chartView);
                                                else onAsk(pillar.askPrompt);
                                            }}
                                            className="text-left rounded-xl border border-border bg-background/50 px-3 py-3 hover:border-accent/30 hover:bg-surface-2/50 transition-colors"
                                        >
                                            <p className="text-[10px] font-medium text-foreground-muted truncate">{pillar.label}</p>
                                            <p className="text-lg font-bold tabular-nums text-foreground mt-0.5">
                                                {pillar.count > 0 ? pillar.count : "—"}
                                            </p>
                                            <p className="text-[9px] text-foreground-muted mt-0.5 truncate">
                                                {pillar.count > 0 ? "files" : "Get started"}
                                            </p>
                                        </button>
                                    ))}
                                </div>
                            </section>
                        )}
                    </div>

                    <div className="hidden xl:block xl:col-span-4 xl:sticky xl:top-4 order-3">
                        <IntelligenceRail
                            verdict={verdict}
                            accent={accent}
                            pendingActions={pendingActions}
                            onRecommend={handleRecommend}
                            onAction={handleAction}
                            actionApproving={railApproving}
                        />
                    </div>
                </div>
            )}

            {footer}
        </div>
    );
}
