"use client";

import React from "react";
import Link from "next/link";
import { AlertCircle, CheckCircle2, ExternalLink, Loader2, Plug, RefreshCw } from "lucide-react";
import {
    connectionMode,
    formatLastSync,
    feedsAgentLabel,
    providerDisplayName,
    syncStatusTone,
    supportsManualSync,
    useCaseLabel,
    type WorkspaceIntegration,
} from "@/lib/integrationConnections";
import { cn } from "@/lib/utils";

type Props = {
    agentName: string;
    accent: string;
    connections: WorkspaceIntegration[];
    loading?: boolean;
    syncingId?: string | null;
    onSync?: (connectionId: string) => void;
    syncNote?: { tone: "ok" | "err"; text: string } | null;
    compact?: boolean;
};

function StatusDot({ status }: { status?: string | null }) {
    const tone = syncStatusTone(status);
    return (
        <span
            className={cn(
                "h-2 w-2 rounded-full shrink-0 mt-1",
                tone === "ok" && "bg-emerald-500",
                tone === "warn" && "bg-red-500",
                tone === "muted" && "bg-foreground-muted/40"
            )}
        />
    );
}

export default function AgentConnectedSystemsPanel({
    agentName,
    accent,
    connections,
    loading,
    syncingId,
    onSync,
    syncNote,
    compact,
}: Props) {
    return (
        <section
            className={cn(
                "rounded-2xl border border-border overflow-hidden",
                compact ? "bg-surface/30" : "bg-surface/50"
            )}
        >
            <div
                className="px-4 py-3 border-b border-border bg-surface/40 flex flex-wrap items-start justify-between gap-3"
                style={{ boxShadow: connections.length ? `inset 3px 0 0 ${accent}` : undefined }}
            >
                <div>
                    <p className="text-xs font-bold text-foreground flex items-center gap-2">
                        <Plug size={14} style={{ color: accent }} />
                        Connected systems
                    </p>
                    <p className="text-[10px] text-foreground-muted mt-0.5 max-w-lg">
                        External apps that feed the <strong className="font-semibold text-foreground">{agentName}</strong>{" "}
                        workspace. ERP systems (SAP, Dynamics, Odoo) use a <strong className="text-foreground">push URL</strong>{" "}
                        from your middleware — not live ledger sync.
                    </p>
                </div>
                <Link
                    href="/admin/integrations"
                    className="text-[10px] font-semibold text-accent hover:underline inline-flex items-center gap-1 shrink-0"
                >
                    Manage all <ExternalLink size={10} />
                </Link>
            </div>

            {loading ? (
                <div className="py-8 flex justify-center text-foreground-muted text-xs">
                    <RefreshCw size={16} className="animate-spin" />
                </div>
            ) : !connections.length ? (
                <div className="px-4 py-6 text-center space-y-2">
                    <p className="text-sm text-foreground-muted">No systems routed to this agent yet.</p>
                    <p className="text-[10px] text-foreground-muted max-w-md mx-auto">
                        Connect Google Drive, ClickUp, or an ERP via{" "}
                        <strong className="text-foreground">Custom Webhook / SAP / Dynamics</strong>. Set{" "}
                        <em>Use case</em> and <em>Default AI agent</em>, then POST files to your org&apos;s push URL.
                    </p>
                    <Link
                        href="/admin/integrations"
                        className="inline-flex items-center gap-1.5 mt-2 rounded-xl px-4 py-2 text-xs font-semibold text-white hover:opacity-90"
                        style={{ backgroundColor: accent }}
                    >
                        <Plug size={12} /> Connect a system
                    </Link>
                </div>
            ) : (
                <div className="divide-y divide-border">
                    {connections.map((c) => {
                        const mode = connectionMode(c.providerId);
                        const uc = useCaseLabel(c.useCase);
                        const statusTone = syncStatusTone(c.lastStatus);
                        return (
                            <div
                                key={c.connectionId}
                                className="px-4 py-3 flex flex-wrap items-start justify-between gap-3 hover:bg-surface-2/30"
                            >
                                <div className="flex items-start gap-3 min-w-0 flex-1">
                                    <StatusDot status={c.lastStatus} />
                                    <div className="min-w-0">
                                        <div className="flex flex-wrap items-center gap-2">
                                            <p className="text-xs font-bold text-foreground truncate">{c.label}</p>
                                            {!c.isActive && (
                                                <span className="text-[9px] font-bold uppercase tracking-wider rounded-full px-2 py-0.5 bg-surface-2 text-foreground-muted">
                                                    Paused
                                                </span>
                                            )}
                                        </div>
                                        <p className="text-[11px] text-foreground mt-0.5">
                                            <span className="font-semibold">{providerDisplayName(c.providerId)}</span>
                                            <span className="text-foreground-muted"> · {mode.label}</span>
                                        </p>
                                        <div className="flex flex-wrap gap-x-3 gap-y-0.5 mt-1 text-[10px] text-foreground-muted">
                                            {uc && <span>Use case: {uc}</span>}
                                            <span>Agent: {feedsAgentLabel(c.defaultPhase3Agent)}</span>
                                            <span>{formatLastSync(c.lastSyncAt)}</span>
                                            {c.hasOutboundWebhook && <span>Outbound webhook ✓</span>}
                                        </div>
                                        {c.lastSyncSummary && statusTone === "warn" && (
                                            <p className="text-[10px] text-red-600 dark:text-red-400 mt-1 flex items-start gap-1">
                                                <AlertCircle size={11} className="shrink-0 mt-0.5" />
                                                {c.lastSyncSummary}
                                            </p>
                                        )}
                                        {statusTone === "ok" && c.lastSyncSummary && (
                                            <p className="text-[10px] text-emerald-600 dark:text-emerald-400 mt-1 flex items-start gap-1">
                                                <CheckCircle2 size={11} className="shrink-0 mt-0.5" />
                                                {c.lastSyncSummary}
                                            </p>
                                        )}
                                        <p className="text-[10px] text-foreground-muted/80 mt-1">{mode.hint}</p>
                                    </div>
                                </div>
                                {onSync && supportsManualSync(c.providerId) && (
                                    <button
                                        type="button"
                                        disabled={syncingId === c.connectionId}
                                        onClick={() => onSync(c.connectionId)}
                                        className="btn-secondary rounded-lg px-2.5 py-1.5 text-[10px] font-semibold shrink-0 disabled:opacity-50 inline-flex items-center gap-1"
                                    >
                                        {syncingId === c.connectionId ? (
                                            <>
                                                <Loader2 size={11} className="animate-spin" />
                                                Syncing…
                                            </>
                                        ) : (
                                            "Sync now"
                                        )}
                                    </button>
                                )}
                            </div>
                        );
                    })}
                </div>
            )}
            {syncNote && (
                <div
                    className={cn(
                        "px-4 py-3 border-t border-border text-xs font-medium flex items-start gap-2",
                        syncNote.tone === "ok"
                            ? "text-emerald-800 dark:text-emerald-300 bg-emerald-50 dark:bg-emerald-500/10 border-emerald-200 dark:border-emerald-500/20"
                            : "text-red-800 dark:text-red-300 bg-red-50 dark:bg-red-500/10 border-red-200 dark:border-red-500/20"
                    )}
                    role="status"
                    aria-live="polite"
                >
                    {syncNote.tone === "ok" ? (
                        <CheckCircle2 size={14} className="shrink-0 mt-0.5" />
                    ) : (
                        <AlertCircle size={14} className="shrink-0 mt-0.5" />
                    )}
                    <span>{syncNote.text}</span>
                </div>
            )}
        </section>
    );
}
