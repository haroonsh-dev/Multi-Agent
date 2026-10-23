"use client";

import React, { useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
    AlertCircle,
    BarChart3,
    CheckCircle2,
    Download,
    FileStack,
    FolderOpen,
    Home,
    MessageSquare,
    Plug,
    RefreshCw,
    Sparkles,
    Upload,
    Wrench,
    Zap,
} from "lucide-react";
import ChatAnalyticsSidePanel, { type AnalyticsPanelView } from "@/components/ChatAnalyticsSidePanel";
import AgentWorkspaceNav from "@/components/AgentWorkspaceNav";
import AgentWorkspaceChatRail, { type AgentWorkspaceChatRailHandle } from "@/components/AgentWorkspaceChatRail";
import AgentWorkspaceTabs, { MOBILE_ASK_TAB, type WorkspaceTabId } from "@/components/AgentWorkspaceTabs";
import AgentWorkspacePulse from "@/components/AgentWorkspacePulse";
import AgentPortfolioPanel from "@/components/AgentPortfolioPanel";
import AgentReportsPanel from "@/components/AgentReportsPanel";
import AgentAnalyticsEmptyState from "@/components/AgentAnalyticsEmptyState";
import type {
    AgentAnalyticsCoverage,
    ChatVisualSpec,
    ComplianceAnalyticsCoverage,
    FinanceAnalyticsCoverage,
} from "@/types/chatVisuals";
import type { AnalyticsAgentId } from "@/lib/documentAgents";
import { agentChatPath } from "@/lib/documentAgents";
import { type AgentWorkspaceMeta } from "@/lib/agentWorkspace";
import {
    deriveAttentionItems,
    deriveWorkspaceMetrics,
    getSkippedDocumentIds,
    getSkippedFiles,
} from "@/lib/agentWorkspaceInsights";
import { reprocessDocuments } from "@/lib/documentReprocess";
import {
    deriveSpotlightKpis,
    mergePortfolioFiles,
} from "@/lib/agentWorkspaceKpis";
import { useAgentPortfolio } from "@/hooks/useAgentPortfolio";
import type { PlanAgentOption } from "@/hooks/usePlanAgents";
import { downloadVisualsCsv } from "@/lib/analyticsExport";
import { deriveWorkspacePulse } from "@/lib/agentWorkspacePulse";
import type { WorkspaceIntegration } from "@/lib/integrationConnections";
import AgentConnectedSystemsPanel from "@/components/AgentConnectedSystemsPanel";
import AgentCommandDashboard from "@/components/AgentCommandDashboard";
import { deriveHrWorkforceSnapshot } from "@/lib/agentWorkspaceHr";
import { useHrShortlist, type HrShortlistNote } from "@/hooks/useHrShortlist";
import { deriveProcurementSnapshot } from "@/lib/agentWorkspaceProcurement";
import { deriveComplianceSnapshot } from "@/lib/agentWorkspaceCompliance";
import { deriveFinanceSnapshot } from "@/lib/agentWorkspaceFinance";
import AgentFinanceAnalyticsPanel from "@/components/AgentFinanceAnalyticsPanel";
import AgentFinancePortfolioPanel from "@/components/AgentFinancePortfolioPanel";
import AgentFinanceReportsPanel from "@/components/AgentFinanceReportsPanel";
import AgentHrAnalyticsPanel from "@/components/AgentHrAnalyticsPanel";
import AgentHrPortfolioPanel from "@/components/AgentHrPortfolioPanel";
import AgentHrOutreachPanel from "@/components/AgentHrOutreachPanel";
import AgentHrReportsPanel from "@/components/AgentHrReportsPanel";
import AgentProcurementAnalyticsPanel from "@/components/AgentProcurementAnalyticsPanel";
import AgentProcurementPortfolioPanel from "@/components/AgentProcurementPortfolioPanel";
import AgentProcurementReviewPanel from "@/components/AgentProcurementReviewPanel";
import AgentComplianceAnalyticsPanel from "@/components/AgentComplianceAnalyticsPanel";
import AgentCompliancePortfolioPanel from "@/components/AgentCompliancePortfolioPanel";
import AgentComplianceReportsPanel from "@/components/AgentComplianceReportsPanel";
import { cn } from "@/lib/utils";

type WorkspaceTab = WorkspaceTabId;

type Props = {
    agentId: AnalyticsAgentId;
    meta: AgentWorkspaceMeta;
    agentOptions: PlanAgentOption[];
    visuals: ChatVisualSpec[];
    loading: boolean;
    documentCount?: number;
    summary: string;
    scopeMode: "all" | "selected";
    coverage: FinanceAnalyticsCoverage | ComplianceAnalyticsCoverage | AgentAnalyticsCoverage | null;
    integrations: WorkspaceIntegration[];
    integrationsLoading?: boolean;
    view: AnalyticsPanelView;
    onViewChange: (view: AnalyticsPanelView) => void;
    onRefresh: () => void;
    onSyncIntegration?: (connectionId: string) => Promise<string | undefined>;
    lastUpdated?: string | null;
    live?: boolean;
    onLiveChange?: (live: boolean) => void;
    initialTab?: WorkspaceTab;
};

const DESKTOP_TABS: { id: WorkspaceTab; label: string; icon: React.ElementType }[] = [
    { id: "home", label: "Command", icon: Home },
    { id: "charts", label: "Analytics", icon: BarChart3 },
    { id: "files", label: "Portfolio", icon: FolderOpen },
    { id: "reports", label: "Reports", icon: FileStack },
    { id: "fix", label: "Fix", icon: Wrench },
];

export default function AgentWorkspaceShell({
    agentId,
    meta,
    agentOptions,
    visuals,
    loading,
    documentCount,
    summary,
    scopeMode,
    coverage,
    integrations,
    integrationsLoading = false,
    view,
    onViewChange,
    onRefresh,
    onSyncIntegration,
    lastUpdated,
    live = true,
    onLiveChange,
    initialTab = "home",
}: Props) {
    const router = useRouter();
    const chatRef = useRef<AgentWorkspaceChatRailHandle>(null);
    const [tab, setTab] = useState<WorkspaceTab>(initialTab);
    const [hrReportsView, setHrReportsView] = useState<"reports" | "outreach">("reports");
    const Icon = meta.icon;
    const { docs: vaultDocs, loading: portfolioLoading, refresh: refreshPortfolio } = useAgentPortfolio(agentId);

    const portfolio = useMemo(
        () => mergePortfolioFiles(coverage, vaultDocs),
        [coverage, vaultDocs]
    );
    const metrics = useMemo(() => {
        const base = deriveWorkspaceMetrics(documentCount, coverage, integrations.length);
        if (portfolio.length <= base.totalDocs) return base;

        const totalDocs = portfolio.length;
        const chartedDocs = portfolio.filter((f) => f.inCharts).length;
        const skippedDocs = Math.max(0, totalDocs - chartedDocs);
        let healthScore = 0;
        let healthLabel: typeof base.healthLabel = "Empty";
        if (totalDocs === 0) {
            healthScore = 0;
            healthLabel = "Empty";
        } else {
            healthScore = Math.round((chartedDocs / totalDocs) * 100);
            if (healthScore >= 85) healthLabel = "Ready";
            else if (healthScore >= 45) healthLabel = "Partial";
            else healthLabel = "Needs work";
        }
        return { ...base, totalDocs, chartedDocs, skippedDocs, healthScore, healthLabel };
    }, [documentCount, coverage, integrations.length, portfolio]);
    const spotlight = useMemo(
        () => deriveSpotlightKpis(agentId, visuals, coverage, metrics),
        [agentId, visuals, coverage, metrics]
    );
    const attention = useMemo(
        () => deriveAttentionItems(agentId, coverage, metrics.totalDocs || documentCount),
        [agentId, coverage, metrics.totalDocs, documentCount]
    );
    const skippedFiles = useMemo(() => getSkippedFiles(coverage), [coverage]);
    const skippedDocumentIds = useMemo(() => {
        const fromCoverage = getSkippedDocumentIds(coverage);
        if (fromCoverage.length) return fromCoverage;
        return portfolio.filter((f) => !f.inCharts).map((f) => f.documentId).filter(Boolean);
    }, [coverage, portfolio]);
    const plainSummary = summary.replace(/\*\*/g, "").trim();
    const fixCount = metrics.skippedDocs;
    const [actionApproving, setActionApproving] = useState(false);
    const [actionNote, setActionNote] = useState<HrShortlistNote | null>(null);
    const pulse = useMemo(
        () =>
            deriveWorkspacePulse(agentId, metrics, portfolio, visuals.length, integrations),
        [agentId, metrics, portfolio, visuals.length, integrations]
    );

    const handlePulsePrimaryAction = () => {
        if (pulse.primaryAction === "fix") setTab("fix");
        else if (pulse.primaryAction === "analytics") setTab("charts");
        else if (pulse.primaryAction === "upload") router.push("/documents");
    };

    const {
        rows: hrShortlist,
        pendingRows: hrPendingShortlistRows,
        pendingDocumentIds: hrPendingShortlistIds,
        loading: hrShortlistLoading,
        approving: hrShortlistApproving,
        approvingDocumentId: hrShortlistApprovingId,
        note: hrShortlistNote,
        refresh: refreshHrShortlist,
        approve: approveHrShortlist,
        clearNote: clearHrShortlistNote,
    } = useHrShortlist(agentId === "hr_agent");

    const hrSnapshot = useMemo(
        () =>
            agentId === "hr_agent"
                ? deriveHrWorkforceSnapshot(vaultDocs, portfolio, visuals, coverage, metrics, {
                      shortlist: hrShortlist,
                      pendingShortlistIds: hrPendingShortlistIds,
                      pendingShortlistRows: hrPendingShortlistRows,
                  })
                : null,
        [agentId, vaultDocs, portfolio, visuals, coverage, metrics, hrShortlist, hrPendingShortlistIds, hrPendingShortlistRows]
    );

    const procSnapshot = useMemo(
        () =>
            agentId === "procurement_agent"
                ? deriveProcurementSnapshot(vaultDocs, visuals, coverage, metrics)
                : null,
        [agentId, vaultDocs, visuals, coverage, metrics]
    );

    const compSnapshot = useMemo(
        () =>
            agentId === "compliance_agent"
                ? deriveComplianceSnapshot(vaultDocs, visuals, coverage, metrics)
                : null,
        [agentId, vaultDocs, visuals, coverage, metrics]
    );

    const financeSnapshot = useMemo(
        () =>
            agentId === "finance_agent"
                ? deriveFinanceSnapshot(vaultDocs, visuals, coverage, metrics)
                : null,
        [agentId, vaultDocs, visuals, coverage, metrics]
    );
    const [syncingId, setSyncingId] = useState<string | null>(null);

    const formatUpdated = (iso: string | null | undefined) => {
        if (!iso) return null;
        const mins = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
        if (mins < 1) return "Updated just now";
        if (mins < 60) return `Updated ${mins}m ago`;
        return `Updated ${Math.floor(mins / 60)}h ago`;
    };

    const goAsk = (prompt?: string) => {
        const base = agentChatPath(agentId);
        router.push(prompt ? `${base}&q=${encodeURIComponent(prompt)}` : base);
    };

    const runInChat = async (prompt: string) => {
        if (typeof window !== "undefined" && window.matchMedia("(min-width: 1024px)").matches) {
            await chatRef.current?.sendPrompt(prompt);
            return;
        }
        goAsk(prompt);
    };

    const handleRefresh = () => {
        onRefresh();
        void refreshPortfolio();
        if (agentId === "hr_agent") void refreshHrShortlist();
    };

    const handleApproveShortlist = async (documentIds: string[]) => {
        await approveHrShortlist(documentIds);
        void refreshPortfolio();
        onRefresh();
    };

    const handleApproveReprocess = async (documentIds: string[]) => {
        const ids = [...new Set(documentIds.map(String).filter(Boolean))];
        if (!ids.length || actionApproving) return;
        setActionApproving(true);
        setActionNote(null);
        try {
            const result = await reprocessDocuments(ids);
            const queued = result.queued.length;
            const failed = result.failed.length;
            if (queued > 0) {
                setActionNote({
                    tone: failed > 0 ? "err" : "ok",
                    text:
                        failed > 0
                            ? `Queued reprocess for ${queued} file${queued === 1 ? "" : "s"} (${failed} failed). Refresh charts when processing finishes.`
                            : `Approved — reprocessing ${queued} file${queued === 1 ? "" : "s"}. Refresh charts when processing finishes.`,
                });
            } else {
                setActionNote({
                    tone: "err",
                    text: result.failed[0]?.message || "Could not queue reprocess.",
                });
            }
            void refreshPortfolio();
            onRefresh();
        } catch (e: unknown) {
            setActionNote({
                tone: "err",
                text: e instanceof Error ? e.message : "Reprocess failed",
            });
        } finally {
            setActionApproving(false);
        }
    };

    const openChartView = (viewId: string) => {
        onViewChange(viewId as AnalyticsPanelView);
        setTab("charts");
    };

    const [integrationSyncNote, setIntegrationSyncNote] = useState<{
        tone: "ok" | "err";
        text: string;
    } | null>(null);

    const handleIntegrationSync = async (connectionId: string) => {
        if (!onSyncIntegration) return;
        setSyncingId(connectionId);
        setIntegrationSyncNote(null);
        try {
            const message = await onSyncIntegration(connectionId);
            setIntegrationSyncNote({
                tone: "ok",
                text: message || "Sync complete",
            });
            handleRefresh();
        } catch (e: unknown) {
            const msg = e instanceof Error ? e.message : "Sync failed";
            setIntegrationSyncNote({ tone: "err", text: msg });
        } finally {
            setSyncingId(null);
        }
    };

    const renderConnectedSystems = () => (
        <AgentConnectedSystemsPanel
            agentName={meta.shortName}
            accent={meta.accent}
            connections={integrations}
            loading={integrationsLoading}
            syncingId={syncingId}
            onSync={onSyncIntegration ? handleIntegrationSync : undefined}
            syncNote={integrationSyncNote}
        />
    );

    const agentSnapshot =
        financeSnapshot || hrSnapshot || procSnapshot || compSnapshot || null;

    const openHrReports = () => {
        setTab("reports");
        setHrReportsView("reports");
    };
    const openHrOutreach = () => {
        setTab("reports");
        setHrReportsView("outreach");
    };

    const renderHome = () => (
        <AgentCommandDashboard
            agentId={agentId}
            agentName={meta.shortName}
            tagline={meta.tagline}
            accent={meta.accent}
            accentMuted={meta.accentMuted}
            kpis={spotlight}
            metrics={metrics}
            attention={attention}
            plainSummary={plainSummary}
            visuals={visuals}
            skippedFiles={portfolio.filter((f) => !f.inCharts)}
            loading={loading}
            lastUpdated={lastUpdated}
            headline={agentSnapshot?.headline}
            subline={agentSnapshot?.subline}
            pillars={agentSnapshot?.pillars}
            priorities={agentSnapshot?.priorities}
            integrations={integrations}
            onAsk={(p) => void runInChat(p)}
            onOpenChart={openChartView}
            onOpenFix={() => setTab("fix")}
            onOpenReports={agentId === "hr_agent" ? openHrReports : () => setTab("reports")}
            onOpenOutreach={agentId === "hr_agent" ? openHrOutreach : undefined}
            onOpenAnalytics={() => setTab("charts")}
            onRefresh={handleRefresh}
            onApproveShortlist={agentId === "hr_agent" ? handleApproveShortlist : undefined}
            onApproveReprocess={handleApproveReprocess}
            skippedDocumentIds={skippedDocumentIds}
            shortlistApproving={agentId === "hr_agent" ? hrShortlistApproving : false}
            actionApproving={actionApproving}
            shortlistNote={
                agentId === "hr_agent" ? hrShortlistNote || actionNote : actionNote
            }
            onDismissShortlistNote={() => {
                setActionNote(null);
                if (agentId === "hr_agent") clearHrShortlistNote();
            }}
            onSyncConnection={onSyncIntegration ? handleIntegrationSync : undefined}
            footer={renderConnectedSystems()}
            hrShortlist={agentId === "hr_agent" ? hrShortlist : undefined}
            hrPendingShortlistRows={agentId === "hr_agent" ? hrPendingShortlistRows : undefined}
            hrPendingShortlistIds={agentId === "hr_agent" ? hrPendingShortlistIds : undefined}
            hrShortlistLoading={agentId === "hr_agent" ? hrShortlistLoading : undefined}
            hrShortlistApprovingId={agentId === "hr_agent" ? hrShortlistApprovingId : undefined}
        />
    );

    const renderCharts = () => (
        <div className="flex flex-col">
            {agentId === "finance_agent" && financeSnapshot ? (
                <AgentFinanceAnalyticsPanel
                    accent={meta.accent}
                    snapshot={financeSnapshot}
                    visuals={visuals}
                    loading={loading}
                    documentCount={documentCount}
                    scopeMode={scopeMode}
                    coverage={coverage}
                    view={view}
                    onViewChange={onViewChange}
                    onRefresh={handleRefresh}
                    onRunPrompt={(p) => void runInChat(p)}
                    onClose={() => setTab("home")}
                />
            ) : agentId === "hr_agent" && hrSnapshot ? (
                <AgentHrAnalyticsPanel
                    accent={meta.accent}
                    snapshot={hrSnapshot}
                    visuals={visuals}
                    loading={loading}
                    documentCount={documentCount}
                    scopeMode={scopeMode}
                    coverage={coverage}
                    view={view}
                    onViewChange={onViewChange}
                    onRefresh={handleRefresh}
                    onRunPrompt={(p) => void runInChat(p)}
                    onClose={() => setTab("home")}
                    onOpenOutreach={openHrOutreach}
                    hrShortlist={hrShortlist}
                    hrPendingShortlistRows={hrPendingShortlistRows}
                    hrPendingShortlistIds={hrPendingShortlistIds}
                    hrShortlistLoading={hrShortlistLoading}
                    hrShortlistApproving={hrShortlistApproving}
                    hrShortlistApprovingId={hrShortlistApprovingId}
                    onApproveShortlist={handleApproveShortlist}
                />
            ) : agentId === "procurement_agent" && procSnapshot ? (
                <AgentProcurementAnalyticsPanel
                    accent={meta.accent}
                    snapshot={procSnapshot}
                    visuals={visuals}
                    loading={loading}
                    documentCount={documentCount}
                    scopeMode={scopeMode}
                    coverage={coverage}
                    view={view}
                    onViewChange={onViewChange}
                    onRefresh={handleRefresh}
                    onRunPrompt={(p) => void runInChat(p)}
                    onClose={() => setTab("home")}
                />
            ) : agentId === "compliance_agent" && compSnapshot ? (
                <AgentComplianceAnalyticsPanel
                    accent={meta.accent}
                    snapshot={compSnapshot}
                    visuals={visuals}
                    loading={loading}
                    documentCount={documentCount}
                    scopeMode={scopeMode}
                    coverage={coverage}
                    view={view}
                    onViewChange={onViewChange}
                    onRefresh={handleRefresh}
                    onRunPrompt={(p) => void runInChat(p)}
                    onClose={() => setTab("home")}
                />
            ) : !loading && visuals.length === 0 ? (
                <div className="rounded-2xl border border-border bg-surface/30 overflow-hidden flex-1">
                    <AgentAnalyticsEmptyState
                        agentId={agentId}
                        meta={meta}
                        documentCount={documentCount}
                        onRunPrompt={(p) => void runInChat(p)}
                        onOpenCharts={() => setTab("charts")}
                    />
                </div>
            ) : (
                <div className="rounded-2xl border border-border bg-surface/30 overflow-hidden flex-1 flex flex-col">
                <ChatAnalyticsSidePanel
                    layout="page"
                    open
                    onClose={() => setTab("home")}
                    agentId={agentId}
                    visuals={visuals}
                    loading={loading}
                    onRefresh={handleRefresh}
                    view={view}
                    onViewChange={onViewChange}
                    documentCount={documentCount}
                    unifiedHeader
                    suppressCoverageBanner
                    scopeMode={scopeMode}
                    coverage={coverage}
                    scopeDocCount={documentCount}
                    onRunPrompt={(p) => void runInChat(p)}
                />
                </div>
            )}
        </div>
    );

    const renderFiles = () =>
        agentId === "finance_agent" ? (
            <AgentFinancePortfolioPanel
                files={portfolio}
                vaultDocs={vaultDocs}
                loading={portfolioLoading}
                accent={meta.accent}
                onAskFix={(filename) => void runInChat(`Fix ${filename} for charts`)}
            />
        ) : agentId === "hr_agent" ? (
            <AgentHrPortfolioPanel
                files={portfolio}
                vaultDocs={vaultDocs}
                loading={portfolioLoading}
                accent={meta.accent}
                onAskFix={(filename) => void runInChat(`Fix ${filename} for charts`)}
            />
        ) : agentId === "procurement_agent" ? (
            <AgentProcurementPortfolioPanel
                files={portfolio}
                vaultDocs={vaultDocs}
                loading={portfolioLoading}
                accent={meta.accent}
                onAskFix={(filename) => void runInChat(`Fix ${filename} for charts`)}
            />
        ) : agentId === "compliance_agent" ? (
            <AgentCompliancePortfolioPanel
                files={portfolio}
                vaultDocs={vaultDocs}
                loading={portfolioLoading}
                accent={meta.accent}
                onAskFix={(filename) => void runInChat(`Fix ${filename} for charts`)}
            />
        ) : (
            <AgentPortfolioPanel
                files={portfolio}
                loading={portfolioLoading}
                accent={meta.accent}
                onAskFix={(filename) => void runInChat(`Fix ${filename} for charts`)}
            />
        );

    const renderReports = () => (
        <div className="space-y-4">
            {agentId === "finance_agent" && financeSnapshot && (
                <AgentFinanceReportsPanel
                    snapshot={financeSnapshot}
                    accent={meta.accent}
                    visuals={visuals}
                    onRunInChat={(p) => void runInChat(p)}
                />
            )}
            {agentId === "hr_agent" && hrSnapshot && (
                <>
                    <div className="flex gap-1 p-1 rounded-xl border border-border bg-surface/40 w-fit">
                        <button
                            type="button"
                            onClick={() => setHrReportsView("reports")}
                            className={cn(
                                "rounded-lg px-3 py-1.5 text-xs font-semibold transition-colors",
                                hrReportsView === "reports"
                                    ? "bg-accent-muted text-accent shadow-sm"
                                    : "text-foreground-muted hover:text-foreground"
                            )}
                        >
                            Reports & PDFs
                        </button>
                        <button
                            type="button"
                            onClick={() => setHrReportsView("outreach")}
                            className={cn(
                                "rounded-lg px-3 py-1.5 text-xs font-semibold transition-colors",
                                hrReportsView === "outreach"
                                    ? "bg-accent-muted text-accent shadow-sm"
                                    : "text-foreground-muted hover:text-foreground"
                            )}
                        >
                            Candidate outreach
                        </button>
                    </div>
                    {hrReportsView === "reports" ? (
                        <AgentHrReportsPanel
                            snapshot={hrSnapshot}
                            accent={meta.accent}
                            visuals={visuals}
                            hrShortlist={hrShortlist}
                            onOpenOutreach={() => setHrReportsView("outreach")}
                            onRunInChat={(p) => void runInChat(p)}
                        />
                    ) : (
                        <AgentHrOutreachPanel
                            accent={meta.accent}
                            accentMuted={meta.accentMuted}
                            onRunInChat={(p) => void runInChat(p)}
                        />
                    )}
                </>
            )}
            {agentId === "procurement_agent" && procSnapshot && (
                <AgentProcurementReviewPanel
                    snapshot={procSnapshot}
                    accent={meta.accent}
                    visuals={visuals}
                    onRunInChat={(p) => void runInChat(p)}
                />
            )}
            {agentId === "compliance_agent" && compSnapshot && (
                <AgentComplianceReportsPanel
                    snapshot={compSnapshot}
                    accent={meta.accent}
                    visuals={visuals}
                    onRunInChat={(p) => void runInChat(p)}
                />
            )}
            {agentId !== "hr_agent" && (
                <AgentReportsPanel
                    agentId={agentId}
                    accent={meta.accent}
                    accentMuted={meta.accentMuted}
                    shortName={meta.shortName}
                    visuals={visuals}
                    onRunInChat={(p) => void runInChat(p)}
                    onOpenFullChat={goAsk}
                />
            )}
        </div>
    );

    const renderFix = () => (
        <div className="space-y-4 animate-in fade-in duration-300">
            <div
                className="rounded-2xl border px-4 py-3 flex flex-wrap items-center justify-between gap-3"
                style={{ borderColor: `${meta.accent}33`, backgroundColor: meta.accentMuted }}
            >
                <div>
                    <p className="text-sm font-bold">Fix queue</p>
                    <p className="text-xs text-foreground-muted mt-0.5">
                        {fixCount === 0
                            ? "All portfolio files are chart-ready"
                            : `${fixCount} file${fixCount === 1 ? "" : "s"} blocking full analytics`}
                    </p>
                </div>
                {fixCount > 0 && (
                    <button
                        type="button"
                        onClick={() => void runInChat("Why are some files not in charts? Summarize fixes needed.")}
                        className="btn-secondary rounded-xl px-3 py-2 text-xs font-semibold"
                    >
                        Ask AI to diagnose all
                    </button>
                )}
            </div>
            <div className="space-y-2">
            {skippedFiles.length === 0 ? (
                <div className="rounded-2xl border border-dashed py-16 text-center">
                    <Sparkles size={36} className="mx-auto text-emerald-500 mb-3" />
                    <p className="text-sm font-semibold">All clear</p>
                    <button type="button" onClick={() => setTab("charts")} className="mt-3 text-sm text-accent font-medium">
                        View analytics →
                    </button>
                </div>
            ) : (
                skippedFiles.map((f) => (
                    <div
                        key={f.documentId}
                        className="rounded-xl border border-amber-500/20 bg-amber-500/5 px-4 py-3 flex flex-wrap items-center gap-3"
                    >
                        <AlertCircle size={16} className="text-amber-600 shrink-0" />
                        <div className="flex-1 min-w-0">
                            <Link
                                href={`/documents/${f.documentId}/details`}
                                className="text-sm font-semibold hover:text-accent truncate block"
                            >
                                {f.filename}
                            </Link>
                            <p className="text-xs text-foreground-muted">{f.detail || f.status}</p>
                        </div>
                        <button
                            type="button"
                            onClick={() => void runInChat(`Why is ${f.filename} not in charts?`)}
                            className="btn-secondary rounded-lg px-3 py-1.5 text-xs"
                        >
                            Ask AI
                        </button>
                        <Link href={`/documents/${f.documentId}/details`} className="text-xs text-accent">
                            Open →
                        </Link>
                    </div>
                ))
            )}
            </div>
        </div>
    );

    const mainContent = (
        <>
            {tab === "home" && renderHome()}
            {tab === "charts" && renderCharts()}
            {tab === "files" && renderFiles()}
            {tab === "reports" && renderReports()}
            {tab === "fix" && renderFix()}
            {tab === "ask" && (
                <div className="lg:hidden h-[min(70vh,640px)]">
                    <AgentWorkspaceChatRail
                        agentId={agentId}
                        shortName={meta.shortName}
                        accent={meta.accent}
                        onAnalyticsReply={onRefresh}
                        className="h-full"
                    />
                </div>
            )}
        </>
    );

    const showPulse = tab === "files" || tab === "reports" || tab === "fix";

    return (
        <div className="flex flex-col h-full min-h-0 bg-background relative lg:overflow-hidden">
            <div
                className="pointer-events-none absolute inset-0 opacity-[0.35]"
                style={{
                    background: `radial-gradient(ellipse 70% 50% at 100% 0%, ${meta.accentMuted}, transparent 50%)`,
                }}
            />

            <header className="relative shrink-0 border-b border-border bg-surface/40 backdrop-blur-md">
                <div className="max-w-[1600px] mx-auto px-4 sm:px-6 lg:px-8 pt-2.5 pb-2 space-y-2">
                    <div className="flex flex-wrap items-start justify-between gap-3">
                        <div className="flex items-center gap-3">
                            <Link
                                href="/agents"
                                className="text-[10px] font-semibold text-foreground-muted hover:text-accent uppercase tracking-wider"
                            >
                                ← All workspaces
                            </Link>
                        </div>
                        <div className="flex flex-wrap items-center gap-2">
                            {onLiveChange && (
                                <button
                                    type="button"
                                    onClick={() => onLiveChange(!live)}
                                    className={cn(
                                        "rounded-lg px-2.5 py-1.5 text-[11px] font-semibold border",
                                        live
                                            ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400"
                                            : "border-border text-foreground-muted"
                                    )}
                                >
                                    {live ? "● Live" : "Paused"}
                                </button>
                            )}
                            {lastUpdated && (
                                <span className="text-[10px] text-foreground-muted hidden sm:inline">
                                    {formatUpdated(lastUpdated)}
                                </span>
                            )}
                            <button
                                type="button"
                                onClick={handleRefresh}
                                disabled={loading}
                                className="btn-secondary rounded-xl px-3 py-2 text-xs inline-flex items-center gap-1.5 disabled:opacity-50"
                            >
                                <RefreshCw size={13} className={loading ? "animate-spin" : ""} />
                                Sync
                            </button>
                            {visuals.length > 0 && (
                                <button
                                    type="button"
                                    onClick={() => downloadVisualsCsv(visuals, `${agentId}-export.csv`)}
                                    className="btn-secondary rounded-xl px-3 py-2 text-xs inline-flex items-center gap-1.5"
                                >
                                    <Download size={13} /> CSV
                                </button>
                            )}
                        </div>
                    </div>

                    <div className="flex flex-wrap items-center gap-3">
                        <div
                            className="h-9 w-9 rounded-xl flex items-center justify-center shrink-0"
                            style={{ backgroundColor: meta.accentMuted }}
                        >
                            <Icon size={18} style={{ color: meta.accent }} />
                        </div>
                        <div className="flex-1 min-w-0">
                            <h1 className="text-lg font-bold tracking-tight">{meta.shortName} workspace</h1>
                            <p className="text-[11px] text-foreground-muted line-clamp-1">{meta.tagline}</p>
                        </div>
                    </div>

                    <AgentWorkspaceNav agents={agentOptions} currentAgentId={agentId} />
                </div>
            </header>

            <div className="relative shrink-0 border-b border-border bg-surface/20 py-1.5">
                <div className="max-w-[1600px] mx-auto px-4 sm:px-6 lg:px-8 flex flex-wrap items-center justify-between gap-2">
                    <AgentWorkspaceTabs
                        tabs={DESKTOP_TABS}
                        mobileTabs={[...DESKTOP_TABS, MOBILE_ASK_TAB]}
                        active={tab}
                        accent={meta.accent}
                        fixCount={fixCount}
                        onChange={setTab}
                    />
                    <div className="hidden sm:flex items-center gap-3 text-[10px] font-semibold uppercase tracking-wider text-foreground-muted">
                        {metrics.skippedDocs > 0 && (
                            <span className="text-amber-700 dark:text-amber-400 tabular-nums normal-case">
                                {metrics.skippedDocs} issue{metrics.skippedDocs === 1 ? "" : "s"}
                            </span>
                        )}
                        {live !== undefined && (
                            <span className={live ? "text-emerald-600 dark:text-emerald-400" : ""}>
                                {live ? "● Live" : "Paused"}
                            </span>
                        )}
                    </div>
                </div>
            </div>

            <div className="relative flex-1 min-h-0 flex flex-col overflow-hidden">
                {showPulse && (
                    <div className="shrink-0 max-w-[1600px] w-full mx-auto px-4 sm:px-6 lg:px-8 pt-2 pb-1">
                        <AgentWorkspacePulse
                            shortName={meta.shortName}
                            metrics={metrics}
                            pulse={pulse}
                            accent={meta.accent}
                            live={live}
                            lastUpdated={lastUpdated}
                            onPrimaryAction={pulse.primaryAction !== "none" ? handlePulsePrimaryAction : undefined}
                        />
                    </div>
                )}
                <div className="flex-1 min-h-0 max-w-[1600px] w-full mx-auto px-4 sm:px-6 lg:px-8 py-2 overflow-hidden">
                    <div className="h-full min-h-0 grid grid-cols-1 lg:grid-cols-[minmax(272px,300px)_1fr] gap-3 overflow-hidden">
                        <div className="hidden lg:flex flex-col min-h-0 h-full">
                            <AgentWorkspaceChatRail
                                ref={chatRef}
                                agentId={agentId}
                                shortName={meta.shortName}
                                accent={meta.accent}
                                onAnalyticsReply={handleRefresh}
                                className="flex-1 min-h-0 h-full"
                            />
                        </div>
                        <div className="min-h-0 h-full overflow-y-auto overscroll-contain pr-0.5">
                            {mainContent}
                        </div>
                    </div>
                </div>
            </div>
        </div>
    );
}
