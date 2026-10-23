"use client";

import React, { useMemo, useState } from "react";
import Link from "next/link";
import { Download, FileText, LineChart, Loader2, RefreshCw, Sparkles, X } from "lucide-react";
import ChatAgentVisuals, { type VisualDataPointClick } from "@/components/ChatAgentVisuals";
import type { ChatVisualSpec, FinanceAnalyticsCoverage, ComplianceAnalyticsCoverage, AgentAnalyticsCoverage } from "@/types/chatVisuals";
import { agentLabel } from "@/lib/documentAgents";
import { downloadVisualsCsv } from "@/lib/analyticsExport";

/** Match chat column toolbar height for split-pane alignment */
export const WORKSPACE_SPLIT_HEADER =
    "shrink-0 flex flex-wrap items-center gap-2 sm:gap-3 px-3 sm:px-6 lg:px-8 py-3 sm:py-4 min-h-18 border-b border-border";

export type AnalyticsPanelView =
    | "overview"
    | "vendors"
    | "clients"
    | "trend"
    | "aging"
    | "mix"
    | "expiry"
    | "findings"
    | "cert_status"
    | "status_mix"
    | "scores"
    | "score_dist"
    | "onboarding"
    | "leave"
    | "payroll"
    | "attendance"
    | "directory"
    | "performance"
    | "transcript"
    | "risk"
    | "clauses"
    | "obligations"
    | "po_spend"
    | "po_status"
    | "po_match"
    | "doc_mix"
    | "missing";

type Props = {
    open: boolean;
    onClose: () => void;
    agentId?: string | null;
    visuals: ChatVisualSpec[];
    isDark?: boolean;
    onRunPrompt?: (prompt: string) => void;
    loading?: boolean;
    onRefresh?: () => void;
    view?: AnalyticsPanelView;
    onViewChange?: (view: AnalyticsPanelView) => void;
    documentCount?: number;
    unifiedHeader?: boolean;
    scopeMode?: "all" | "selected";
    coverage?: FinanceAnalyticsCoverage | ComplianceAnalyticsCoverage | AgentAnalyticsCoverage | null;
    resolveFilename?: (documentId: string) => string;
    onApplyChatScope?: (documentIds: string[]) => void;
    scopeDocCount?: number;
    visualsKey?: string;
    layout?: "panel" | "page";
    /** Hide in-panel coverage banners (shown in workspace shell instead) */
    suppressCoverageBanner?: boolean;
    onVisualAction?: (action: {
        label: string;
        kind: "reprocess" | "open_document" | "ask";
        documentId?: string;
        prompt?: string;
    }) => void;
};

const PROMPTS: Record<string, string[]> = {
    finance_agent: [
        "Show items list and chart",
        "Vendor totals for scoped invoices",
        "Chart invoice trend by month",
    ],
    hr_agent: [
        "Any certificates expiring soon?",
        "Who's on leave?",
        "Show performance reviews",
        "Show onboarding gaps",
        "Show employee directory",
        "How do transcripts look?",
        "Generate HR report",
        "Export shortlist top 10",
    ],
    compliance_agent: [
        "Chart certificate expiry",
        "Show audit findings by severity",
        "Visual graph for compliance status",
    ],
    legal_agent: [
        "Show chart all missing data",
        "Chart risk flags by document",
        "Show clause type mix",
    ],
    procurement_agent: [
        "Chart spend by supplier",
        "Chart PO vs invoice amounts",
        "Show procurement summary",
    ],
    other_agent: [
        "Show document type mix",
        "List files in scope",
        "Compare these documents",
    ],
};

const FINANCE_VIEWS: { id: AnalyticsPanelView; label: string }[] = [
    { id: "overview", label: "Overview" },
    { id: "clients", label: "AR · Clients" },
    { id: "vendors", label: "AP · Vendors" },
    { id: "trend", label: "Trend" },
    { id: "aging", label: "AP Aging" },
    { id: "mix", label: "Doc mix" },
];

const COMPLIANCE_VIEWS: { id: AnalyticsPanelView; label: string }[] = [
    { id: "overview", label: "Overview" },
    { id: "expiry", label: "Certs expiry" },
    { id: "findings", label: "Findings" },
    { id: "cert_status", label: "Cert status" },
    { id: "status_mix", label: "Status mix" },
];

const HR_VIEWS: { id: AnalyticsPanelView; label: string }[] = [
    { id: "overview", label: "Overview" },
    { id: "scores", label: "CV scores" },
    { id: "score_dist", label: "CV dist" },
    { id: "expiry", label: "Certs" },
    { id: "onboarding", label: "Onboarding" },
    { id: "directory", label: "Directory" },
    { id: "leave", label: "Leave" },
    { id: "payroll", label: "Payroll" },
    { id: "attendance", label: "Attendance" },
    { id: "performance", label: "Performance" },
    { id: "transcript", label: "Transcripts" },
];

const LEGAL_VIEWS: { id: AnalyticsPanelView; label: string }[] = [
    { id: "overview", label: "Overview" },
    { id: "missing", label: "Missing" },
    { id: "risk", label: "Risk" },
    { id: "expiry", label: "Expiry" },
    { id: "clauses", label: "Clauses" },
];

const PROCUREMENT_VIEWS: { id: AnalyticsPanelView; label: string }[] = [
    { id: "overview", label: "Overview" },
    { id: "po_spend", label: "Spend" },
    { id: "po_status", label: "Status" },
    { id: "po_match", label: "3-way match" },
];

const OTHER_VIEWS: { id: AnalyticsPanelView; label: string }[] = [
    { id: "overview", label: "Overview" },
    { id: "doc_mix", label: "Type mix" },
];

function deriveKpis(visuals: ChatVisualSpec[]) {
    const spendVisual =
        visuals.find((v) => /vendor|invoice volume|trend/i.test(v.title)) ||
        visuals.find((v) => v.currency && v.series[0]?.key);
    const currency = spendVisual?.currency || visuals.find((v) => v.currency)?.currency;
    let primaryMetric: number | null = null;
    const totalsByCurrency = new Map<string, number>();

    for (const v of visuals) {
        const cur = v.currency;
        const key = v.series[0]?.key;
        if (!cur || !key || v.kind === "pie") continue;
        if (!/vendor|client|invoice volume|trend|spend/i.test(v.title)) continue;
        const sum = v.data.reduce((s, row) => s + Number(row[key] || 0), 0);
        totalsByCurrency.set(cur, (totalsByCurrency.get(cur) || 0) + sum);
    }

    if (spendVisual) {
        const key = spendVisual.series[0]?.key;
        if (key && spendVisual.currency) {
            primaryMetric = spendVisual.data.reduce((s, row) => s + Number(row[key] || 0), 0);
        }
    }

    const multiCurrency =
        totalsByCurrency.size > 1
            ? [...totalsByCurrency.entries()]
                  .sort((a, b) => b[1] - a[1])
                  .map(
                      ([c, a]) =>
                          `${c} ${a.toLocaleString(undefined, { maximumFractionDigits: 2 })}`
                  )
                  .join(" · ")
            : null;

    return {
        currency,
        primaryMetric,
        multiCurrency,
        chartCount: visuals.length,
    };
}

function AnalyticsSkeleton() {
    return (
        <div className="p-4 sm:p-5 lg:p-6 space-y-4 animate-pulse">
            <div className="grid grid-cols-3 gap-2">
                <div className="h-16 rounded-xl bg-surface-2" />
                <div className="h-16 rounded-xl bg-surface-2 col-span-2" />
            </div>
            <div className="h-64 rounded-xl bg-surface-2" />
            <div className="h-48 rounded-xl bg-surface-2" />
        </div>
    );
}

export default function ChatAnalyticsSidePanel({
    open,
    onClose,
    agentId,
    visuals,
    isDark = false,
    onRunPrompt,
    loading = false,
    onRefresh,
    view = "overview",
    onViewChange,
    documentCount,
    unifiedHeader = false,
    scopeMode = "all",
    coverage,
    resolveFilename,
    onApplyChatScope,
    scopeDocCount,
    visualsKey,
    layout = "panel",
    suppressCoverageBanner = false,
    onVisualAction,
}: Props) {
    const [drillDown, setDrillDown] = useState<VisualDataPointClick | null>(null);
    const kpis = useMemo(() => (visuals.length ? deriveKpis(visuals) : null), [visuals]);

    const chartedFileIds = useMemo(() => {
        const ids = new Set<string>();
        for (const v of visuals) {
            for (const id of v.sourceDocumentIds || []) ids.add(id);
        }
        return [...ids];
    }, [visuals]);

    if (!open) return null;

    const label = agentId ? agentLabel(agentId) : "Workspace";
    const prompts = (agentId && PROMPTS[agentId]) || [];
    const showFinanceViews = agentId === "finance_agent" && onViewChange;
    const showComplianceViews = agentId === "compliance_agent" && onViewChange;
    const showHrViews = agentId === "hr_agent" && onViewChange;
    const agentViews = showFinanceViews
        ? FINANCE_VIEWS
        : showComplianceViews
          ? COMPLIANCE_VIEWS
          : showHrViews
            ? HR_VIEWS
            : agentId === "legal_agent" && onViewChange
              ? LEGAL_VIEWS
              : agentId === "procurement_agent" && onViewChange
                ? PROCUREMENT_VIEWS
                : agentId === "other_agent" && onViewChange
                  ? OTHER_VIEWS
                  : [];

    const effectiveScopeCount =
        chartedFileIds.length > 0 ? chartedFileIds.length : scopeDocCount;

    const scopeBadge =
        layout === "page"
            ? effectiveScopeCount != null && effectiveScopeCount > 0
                ? `All documents · ${effectiveScopeCount} file${effectiveScopeCount === 1 ? "" : "s"}`
                : "All documents"
            : effectiveScopeCount != null && effectiveScopeCount > 0
              ? chartedFileIds.length === 1
                  ? `Charted · 1 named file`
                  : `Chat scope · ${effectiveScopeCount} file${effectiveScopeCount === 1 ? "" : "s"}`
              : "Chat scope";

    const handleExport = () => downloadVisualsCsv(visuals, `visibility-analytics-${agentId || "export"}.csv`);

    const shellClass =
        layout === "page"
            ? suppressCoverageBanner
                ? "flex flex-col min-h-0 min-w-0 flex-1 overflow-hidden"
                : "flex flex-col min-h-0 min-w-0 flex-1 bg-surface rounded-2xl border border-border overflow-hidden"
            : "hidden lg:flex flex-col min-h-0 min-w-0 h-full bg-surface border-l border-border";

    return (
        <aside
            className={shellClass}
            aria-label={layout === "page" ? "Agent analytics dashboard" : "Analytics workspace"}
        >
            {!unifiedHeader && layout === "panel" && (
                <div className={`${WORKSPACE_SPLIT_HEADER} justify-between gap-y-2`}>
                    <div className="min-w-0">
                        <h2 className="text-sm font-bold tracking-tight truncate">Analytics</h2>
                        <p className={`text-xs truncate ${isDark ? "text-slate-400" : "text-slate-500"}`}>
                            {label}
                        </p>
                    </div>
                    <div className="flex items-center gap-1 shrink-0">
                        {onRefresh && (
                            <button
                                type="button"
                                onClick={onRefresh}
                                disabled={loading}
                                className="btn-ghost p-2.5 rounded-lg min-h-10 min-w-10 flex items-center justify-center disabled:opacity-50"
                                aria-label="Refresh analytics"
                                title="Refresh"
                            >
                                {loading ? (
                                    <Loader2 size={18} className="animate-spin" />
                                ) : (
                                    <RefreshCw size={18} />
                                )}
                            </button>
                        )}
                        <button
                            type="button"
                            onClick={onClose}
                            className="btn-ghost p-2.5 rounded-lg shrink-0 min-h-10 min-w-10 flex items-center justify-center"
                            aria-label="Hide analytics panel"
                            title="Hide panel"
                        >
                            <X size={18} />
                        </button>
                    </div>
                </div>
            )}

            {unifiedHeader && (
                <div className="shrink-0 flex flex-wrap items-center justify-between gap-2 px-4 sm:px-5 py-2.5 border-b border-border bg-surface-2/30">
                    <div className="flex flex-wrap items-center gap-1.5 min-w-0">
                        <span className="text-[10px] font-semibold uppercase tracking-wider text-foreground-muted mr-1">
                            Analytics
                        </span>
                        {agentViews.length > 0 &&
                            agentViews.map((v) => (
                                <button
                                    key={v.id}
                                    type="button"
                                    onClick={() => onViewChange!(v.id)}
                                    disabled={loading}
                                    className={`rounded-lg px-2.5 py-1 text-[11px] font-medium transition-colors ${
                                        view === v.id
                                            ? "bg-accent-muted text-accent border border-[rgba(56,182,255,0.35)]"
                                            : "text-foreground-muted hover:bg-surface-2 border border-transparent"
                                    }`}
                                >
                                    {v.label}
                                </button>
                            ))}
                    </div>
                    <div className="flex items-center gap-1 shrink-0">
                        <span className="text-[10px] text-foreground-muted max-w-[140px] truncate hidden sm:inline" title={scopeBadge}>
                            {scopeBadge}
                        </span>
                        {visuals.length > 0 && (
                            <button
                                type="button"
                                onClick={handleExport}
                                className="btn-ghost p-2 rounded-lg min-h-9 min-w-9 flex items-center justify-center"
                                title="Download CSV"
                                aria-label="Download CSV"
                            >
                                <Download size={16} />
                            </button>
                        )}
                        {(chartedFileIds.length > 0 || (documentCount != null && documentCount > 0)) && (
                            <span className="text-[11px] text-foreground-muted tabular-nums mr-1">
                                {chartedFileIds.length > 0 ? chartedFileIds.length : documentCount} doc
                                {(chartedFileIds.length > 0 ? chartedFileIds.length : documentCount) === 1
                                    ? ""
                                    : "s"}
                            </span>
                        )}
                        {onRefresh && (
                            <button
                                type="button"
                                onClick={onRefresh}
                                disabled={loading}
                                className="btn-ghost p-2 rounded-lg min-h-9 min-w-9 flex items-center justify-center disabled:opacity-50"
                                aria-label="Refresh analytics"
                                title="Refresh"
                            >
                                {loading ? (
                                    <Loader2 size={16} className="animate-spin" />
                                ) : (
                                    <RefreshCw size={16} />
                                )}
                            </button>
                        )}
                    </div>
                </div>
            )}

            <div className="flex-1 min-h-0 overflow-y-auto relative">
                {loading ? (
                    <div className="absolute inset-0 z-10 bg-surface/80 flex items-center justify-center">
                        <Loader2 size={28} className="animate-spin text-accent" />
                    </div>
                ) : null}
                {loading && visuals.length === 0 ? (
                    <AnalyticsSkeleton />
                ) : visuals.length > 0 ? (
                    <div key={visualsKey || "visuals"} className="p-4 sm:p-5 lg:p-6 space-y-5">
                        {coverage && !suppressCoverageBanner && agentId === "finance_agent" && "documentsWithAmount" in coverage && (
                            <div className="rounded-xl border border-border bg-surface-2/40 px-3 py-2.5 text-[11px] text-foreground-muted leading-relaxed space-y-2">
                                <p className="text-foreground">
                                    <span className="font-semibold">
                                        {layout === "page" ? "Portfolio: " : "Chat-scoped finance: "}
                                    </span>
                                    <span className="tabular-nums font-semibold">{coverage.documentsInScope}</span>{" "}
                                    file(s);{" "}
                                    <span className="tabular-nums font-semibold">{coverage.documentsWithAmount}</span>{" "}
                                    with amounts;{" "}
                                    <span className="tabular-nums font-semibold">{coverage.documentsWithVendor}</span>{" "}
                                    with vendors;{" "}
                                    <span className="tabular-nums font-semibold">{coverage.documentsWithClient}</span>{" "}
                                    with clients.
                                </p>
                                {coverage.warnings && coverage.warnings.length > 0 && (
                                    <ul className="space-y-1 border-t border-border pt-2 mt-1">
                                        {coverage.warnings.map((w, i) => (
                                            <li
                                                key={i}
                                                className="text-[10px] text-amber-800 dark:text-amber-300/90 leading-snug"
                                            >
                                                {w.replace(/\*\*/g, "")}
                                            </li>
                                        ))}
                                    </ul>
                                )}
                                {coverage.files && coverage.files.length > 0 && (
                                    <ul className="space-y-1.5 max-h-40 overflow-y-auto border-t border-border pt-2 mt-1">
                                        {coverage.files.map((f) => {
                                            const isCharted = f.status === "in_charts";
                                            const badgeText = isCharted
                                                ? "In charts"
                                                : f.status === "unsupported_format"
                                                  ? "Unsupported"
                                                  : f.status === "no_extraction"
                                                    ? "No extraction"
                                                    : f.status === "not_linked"
                                                      ? "Not linked"
                                                      : "Skipped";
                                            return (
                                                <li key={f.documentId} className="flex flex-col gap-0.5">
                                                    <div className="flex items-center gap-2">
                                                        <span
                                                            className={`shrink-0 rounded px-1.5 py-0.5 text-[9px] font-bold uppercase ${
                                                                isCharted
                                                                    ? "bg-emerald-500/15 text-emerald-600"
                                                                    : "bg-amber-500/15 text-amber-700 dark:text-amber-400"
                                                            }`}
                                                        >
                                                            {badgeText}
                                                        </span>
                                                        <Link
                                                            href={`/documents/${f.documentId}/details`}
                                                            className="text-accent hover:underline truncate font-medium"
                                                        >
                                                            {f.filename}
                                                        </Link>
                                                    </div>
                                                    {f.detail && !isCharted ? (
                                                        <p className="pl-0 text-[10px] leading-snug">{f.detail}</p>
                                                    ) : null}
                                                </li>
                                            );
                                        })}
                                    </ul>
                                )}
                            </div>
                        )}
                        {coverage && !suppressCoverageBanner && agentId === "compliance_agent" && "documentsWithExpiry" in coverage && (
                            <div className="rounded-xl border border-border bg-surface-2/40 px-3 py-2.5 text-[11px] text-foreground-muted leading-relaxed space-y-2">
                                <p className="text-foreground">
                                    <span className="font-semibold">Chat-scoped compliance: </span>
                                    <span className="tabular-nums font-semibold">{coverage.documentsInScope}</span>{" "}
                                    file(s);{" "}
                                    <span className="tabular-nums font-semibold">{coverage.documentsWithExpiry}</span>{" "}
                                    with expiry/status;{" "}
                                    <span className="tabular-nums font-semibold">{coverage.documentsWithFindings}</span>{" "}
                                    with audit findings.
                                </p>
                                {coverage.files && coverage.files.length > 0 && (
                                    <ul className="space-y-1.5 max-h-40 overflow-y-auto border-t border-border pt-2 mt-1">
                                        {coverage.files.map((f) => (
                                            <li key={f.documentId} className="flex flex-col gap-0.5">
                                                <div className="flex items-center gap-2">
                                                    <span
                                                        className={`shrink-0 rounded px-1.5 py-0.5 text-[9px] font-bold uppercase ${
                                                            f.status === "in_charts"
                                                                ? "bg-emerald-500/15 text-emerald-600"
                                                                : "bg-amber-500/15 text-amber-700 dark:text-amber-400"
                                                        }`}
                                                    >
                                                        {f.status === "in_charts" ? "In charts" : "Skipped"}
                                                    </span>
                                                    <Link
                                                        href={`/documents/${f.documentId}/details`}
                                                        className="text-accent hover:underline truncate font-medium"
                                                    >
                                                        {f.filename}
                                                    </Link>
                                                </div>
                                                {f.detail && f.status !== "in_charts" ? (
                                                    <p className="pl-0 text-[10px] leading-snug">{f.detail}</p>
                                                ) : null}
                                            </li>
                                        ))}
                                    </ul>
                                )}
                            </div>
                        )}
                        {coverage &&
                            !suppressCoverageBanner &&
                            coverage.documentsInScope != null &&
                            agentId !== "finance_agent" &&
                            agentId !== "compliance_agent" && (
                            <div className="rounded-xl border border-border bg-surface-2/40 px-3 py-2.5 text-[11px] text-foreground-muted leading-relaxed space-y-2">
                                <p className="text-foreground">
                                    <span className="font-semibold">Chat scope: </span>
                                    <span className="tabular-nums font-semibold">{coverage.documentsInScope}</span>{" "}
                                    file(s)
                                    {"documentsCharted" in coverage && coverage.documentsCharted != null ? (
                                        <>
                                            ;{" "}
                                            <span className="tabular-nums font-semibold">
                                                {coverage.documentsCharted}
                                            </span>{" "}
                                            in charts
                                        </>
                                    ) : null}
                                    .
                                </p>
                                {coverage.warnings && coverage.warnings.length > 0 && (
                                    <ul className="space-y-1 border-t border-border pt-2 mt-1">
                                        {coverage.warnings.map((w, i) => (
                                            <li key={i} className="text-[10px] text-amber-800 dark:text-amber-300/90">
                                                {w.replace(/\*\*/g, "")}
                                            </li>
                                        ))}
                                    </ul>
                                )}
                                {coverage.files && coverage.files.length > 0 && (
                                    <ul className="space-y-1.5 max-h-40 overflow-y-auto border-t border-border pt-2 mt-1">
                                        {coverage.files.map((f) => (
                                            <li key={f.documentId} className="flex items-center gap-2">
                                                <span
                                                    className={`shrink-0 rounded px-1.5 py-0.5 text-[9px] font-bold uppercase ${
                                                        f.status === "in_charts"
                                                            ? "bg-emerald-500/15 text-emerald-600"
                                                            : "bg-amber-500/15 text-amber-700 dark:text-amber-400"
                                                    }`}
                                                >
                                                    {f.status === "in_charts" ? "In charts" : "Skipped"}
                                                </span>
                                                <Link
                                                    href={`/documents/${f.documentId}/details`}
                                                    className="text-accent hover:underline truncate font-medium"
                                                >
                                                    {f.filename}
                                                </Link>
                                            </li>
                                        ))}
                                    </ul>
                                )}
                            </div>
                        )}
                        {drillDown && (
                            <div className="rounded-xl border border-accent/40 bg-accent-muted/30 px-3 py-3 space-y-2">
                                <div className="flex items-start justify-between gap-2">
                                    <p className="text-xs font-semibold text-foreground">
                                        Sources: {drillDown.label}
                                    </p>
                                    <button
                                        type="button"
                                        className="btn-ghost p-1 rounded"
                                        onClick={() => setDrillDown(null)}
                                        aria-label="Close sources"
                                    >
                                        <X size={14} />
                                    </button>
                                </div>
                                <ul className="space-y-1 max-h-36 overflow-y-auto">
                                    {drillDown.documentIds.map((id) => (
                                        <li key={id} className="flex items-center gap-2 text-xs">
                                            <FileText size={12} className="text-accent shrink-0" />
                                            <Link
                                                href={`/documents/${id}`}
                                                className="text-accent hover:underline truncate"
                                            >
                                                {resolveFilename?.(id) || id}
                                            </Link>
                                        </li>
                                    ))}
                                </ul>
                                {onApplyChatScope && drillDown.documentIds.length > 0 && (
                                    <button
                                        type="button"
                                        onClick={() => {
                                            onApplyChatScope(drillDown.documentIds);
                                            setDrillDown(null);
                                        }}
                                        className="text-[11px] font-medium text-accent hover:underline"
                                    >
                                        Use these {drillDown.documentIds.length} file(s) as chat scope
                                    </button>
                                )}
                            </div>
                        )}
                        {kpis && (
                            <div className="grid grid-cols-3 gap-2 sm:gap-3">
                                <div className="rounded-xl border border-border bg-surface-2/50 px-3 py-2.5">
                                    <p className="text-[10px] font-semibold uppercase tracking-wider text-foreground-muted">
                                        Charts
                                    </p>
                                    <p className="text-lg font-bold tabular-nums mt-0.5">{kpis.chartCount}</p>
                                </div>
                                <div className="rounded-xl border border-border bg-surface-2/50 px-3 py-2.5 col-span-2">
                                    <p className="text-[10px] font-semibold uppercase tracking-wider text-foreground-muted">
                                        Primary total
                                    </p>
                                    <p className="text-lg font-bold tabular-nums mt-0.5 truncate">
                                        {kpis.multiCurrency
                                            ? kpis.multiCurrency
                                            : kpis.primaryMetric != null && kpis.currency
                                              ? `${kpis.currency} ${kpis.primaryMetric.toLocaleString(undefined, { maximumFractionDigits: 2 })}`
                                              : "—"}
                                    </p>
                                </div>
                            </div>
                        )}
                        <ChatAgentVisuals
                            visuals={visuals}
                            isDark={isDark}
                            embedded
                            onDataPointClick={(p) => setDrillDown(p)}
                            onVisualAction={onVisualAction}
                        />
                        <p className="text-[10px] leading-relaxed text-foreground-muted border-t border-border pt-3">
                            Click a bar or point to see source documents. Numbers come from extractions, not the AI
                            model.
                        </p>
                    </div>
                ) : (
                    <div className="h-full min-h-[280px] flex flex-col items-center justify-center text-center px-6 py-10">
                        <div
                            className={`h-14 w-14 rounded-2xl flex items-center justify-center mb-4 border ${
                                isDark
                                    ? "border-white/10 bg-white/5 text-slate-400"
                                    : "border-border bg-surface-2 text-slate-400"
                            }`}
                        >
                            {loading ? (
                                <Loader2 size={28} className="animate-spin" />
                            ) : (
                                <LineChart size={28} strokeWidth={1.5} />
                            )}
                        </div>
                        <h3 className="text-sm font-semibold text-foreground">
                            {loading ? "Loading analytics…" : `${label} analytics`}
                        </h3>
                        <p className="text-xs mt-2 max-w-sm leading-relaxed text-foreground-muted">
                            {loading
                                ? "Pulling metrics from your document library."
                                : layout === "page"
                                  ? documentCount && documentCount > 0
                                      ? "Charts appear when extractions include structured data. Try another tab above or ask a question in chat."
                                      : "Upload documents for this agent, connect an integration, or assign files in the vault — then refresh."
                                  : agentId === "finance_agent"
                                    ? "Select invoices in chat scope or ask a question—charts update for those files only."
                                    : agentId === "compliance_agent"
                                      ? "Select certificates or audit reports in scope, or ask *chart certificate expiry* in chat."
                                      : "No chart data yet. Finish document extraction, refresh, or run a prompt in chat."}
                        </p>
                        {prompts.length > 0 && onRunPrompt && !loading && (
                            <div className="mt-6 flex flex-col gap-2 w-full max-w-sm">
                                {prompts.map((p) => (
                                    <button
                                        key={p}
                                        type="button"
                                        onClick={() => onRunPrompt(p)}
                                        className="w-full rounded-xl border border-border bg-surface px-3 py-2.5 text-xs font-medium text-left hover:border-accent hover:bg-accent-muted transition-colors inline-flex items-center gap-2"
                                    >
                                        <Sparkles size={12} className="text-accent shrink-0" />
                                        {p}
                                    </button>
                                ))}
                            </div>
                        )}
                    </div>
                )}
            </div>
        </aside>
    );
}
