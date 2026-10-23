"use client";

import React, { useMemo } from "react";
import Link from "next/link";
import {
    Activity,
    AlertTriangle,
    ArrowRight,
    Bot,
    CheckCircle2,
    Clock,
    FileText,
    Plug,
    Radio,
    RefreshCw,
    Server,
    Zap,
} from "lucide-react";
import { useSystemMonitor, type SystemMonitorAlert } from "@/hooks/useSystemMonitor";
import { usePlanAgents } from "@/hooks/usePlanAgents";
import { agentLabel } from "@/lib/documentAgents";
import { agentWorkspacePath, getAgentWorkspaceMeta } from "@/lib/agentWorkspace";
import { cn } from "@/lib/utils";

function timeAgo(iso: string): string {
    const diff = Date.now() - new Date(iso).getTime();
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return "just now";
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `${hrs}h ago`;
    return `${Math.floor(hrs / 24)}d ago`;
}

function ServicePill({
    label,
    status,
}: {
    label: string;
    status: "ok" | "degraded" | "offline";
}) {
    const colors = {
        ok: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400 border-emerald-500/25",
        degraded: "bg-amber-500/15 text-amber-700 dark:text-amber-400 border-amber-500/25",
        offline: "bg-rose-500/15 text-rose-700 dark:text-rose-400 border-rose-500/25",
    };
    return (
        <div className={cn("rounded-xl border px-3 py-2 flex items-center gap-2 min-w-[120px]", colors[status])}>
            <span
                className={cn(
                    "h-2 w-2 rounded-full shrink-0",
                    status === "ok" ? "bg-emerald-500 animate-pulse" : status === "degraded" ? "bg-amber-500" : "bg-rose-500"
                )}
            />
            <div className="min-w-0">
                <p className="text-[10px] font-semibold uppercase tracking-wider opacity-80">{label}</p>
                <p className="text-xs font-bold capitalize">{status === "ok" ? "Online" : status}</p>
            </div>
        </div>
    );
}

function AlertCard({ alert }: { alert: SystemMonitorAlert }) {
    const styles = {
        critical: "border-rose-500/30 bg-rose-500/5",
        warning: "border-amber-500/30 bg-amber-500/5",
        info: "border-border bg-surface/60",
    };
    const inner = (
        <div className={cn("rounded-xl border px-3 py-2.5 h-full", styles[alert.severity])}>
            <p className="text-xs font-semibold text-foreground">{alert.title}</p>
            {alert.detail && (
                <p className="text-[10px] text-foreground-muted mt-0.5 line-clamp-2">{alert.detail}</p>
            )}
        </div>
    );
    if (alert.href) {
        return (
            <Link href={alert.href} className="block hover:opacity-90 transition-opacity">
                {inner}
            </Link>
        );
    }
    return inner;
}

export default function SystemMonitorDashboard() {
    const { data, loading, error, live, setLive, refresh } = useSystemMonitor();
    const { agentOptions, isAgentAllowed } = usePlanAgents();

    const visibleAgents = useMemo(() => {
        if (!data?.agents) return [];
        const allowed = new Set(agentOptions.map((a) => a.value));
        return data.agents.filter((a) => allowed.has(a.agentId) && isAgentAllowed(a.agentId));
    }, [data?.agents, agentOptions, isAgentAllowed]);

    if (loading && !data) {
        return (
            <div className="rounded-2xl border border-border bg-surface/40 p-8 text-center text-sm text-foreground-muted">
                Loading system monitor…
            </div>
        );
    }

    if (error && !data) {
        return (
            <div className="rounded-2xl border border-rose-500/30 bg-rose-500/5 p-6 text-sm text-rose-700 dark:text-rose-400">
                {error}
            </div>
        );
    }

    if (!data) return null;

    const { pipeline, services, alerts, activity, integrations } = data;

    return (
        <div className="space-y-4">
            {/* Live bar */}
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-border bg-surface/50 px-4 py-3">
                <div className="flex items-center gap-3">
                    <div className="h-9 w-9 rounded-xl bg-accent-muted flex items-center justify-center">
                        <Radio size={18} className={live ? "text-accent animate-pulse" : "text-foreground-muted"} />
                    </div>
                    <div>
                        <h2 className="text-sm font-bold text-foreground">Live system monitor</h2>
                        <p className="text-[11px] text-foreground-muted">
                            Updated {timeAgo(data.timestamp)}
                            {live ? " · auto-refresh 30s" : " · paused"}
                        </p>
                    </div>
                </div>
                <div className="flex items-center gap-2">
                    <button
                        type="button"
                        onClick={() => setLive((v) => !v)}
                        className={cn(
                            "rounded-lg px-3 py-1.5 text-xs font-medium border transition-colors",
                            live
                                ? "border-accent/40 bg-accent-muted text-accent"
                                : "border-border bg-surface text-foreground-muted"
                        )}
                    >
                        {live ? "Live" : "Paused"}
                    </button>
                    <button
                        type="button"
                        onClick={() => refresh()}
                        disabled={loading}
                        className="btn-secondary rounded-lg px-3 py-1.5 text-xs inline-flex items-center gap-1.5 disabled:opacity-50"
                    >
                        <RefreshCw size={12} className={loading ? "animate-spin" : ""} /> Refresh
                    </button>
                </div>
            </div>

            {/* Services + pipeline */}
            <div className="grid grid-cols-1 xl:grid-cols-[1fr_1.4fr] gap-4">
                <section className="rounded-2xl border border-border bg-surface/40 p-4 space-y-3">
                    <p className="text-[10px] font-semibold uppercase tracking-wider text-foreground-muted flex items-center gap-1.5">
                        <Server size={12} /> Platform health
                    </p>
                    <div className="flex flex-wrap gap-2">
                        <ServicePill label="API Gateway" status="ok" />
                        <ServicePill label="AI Engine" status={services.aiEngine} />
                        <ServicePill
                            label="Pipeline"
                            status={
                                pipeline.failed > 0 || pipeline.stuckProcessing > 0
                                    ? "degraded"
                                    : pipeline.processing > 0
                                      ? "ok"
                                      : "ok"
                            }
                        />
                    </div>
                </section>

                <section className="rounded-2xl border border-border bg-surface/40 p-4">
                    <p className="text-[10px] font-semibold uppercase tracking-wider text-foreground-muted mb-3 flex items-center gap-1.5">
                        <Zap size={12} /> Document pipeline
                    </p>
                    <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
                        {[
                            { label: "Total", value: pipeline.total, icon: FileText },
                            { label: "Ready", value: pipeline.processed, icon: CheckCircle2, ok: true },
                            { label: "Processing", value: pipeline.processing, icon: Clock, warn: pipeline.processing > 0 },
                            { label: "Failed", value: pipeline.failed, icon: AlertTriangle, bad: pipeline.failed > 0 },
                            { label: "24h uploads", value: pipeline.uploadsLast24h, icon: Activity },
                            { label: "Success", value: `${pipeline.successRate}%`, icon: Zap },
                        ].map((m) => {
                            const Icon = m.icon;
                            return (
                                <div key={m.label} className="rounded-xl border border-border/80 bg-background/50 px-3 py-2">
                                    <div className="flex items-center gap-1.5 text-foreground-muted mb-1">
                                        <Icon size={11} />
                                        <span className="text-[10px] font-medium uppercase tracking-wide">{m.label}</span>
                                    </div>
                                    <p
                                        className={cn(
                                            "text-lg font-bold tabular-nums",
                                            "bad" in m && m.bad
                                                ? "text-rose-600"
                                                : "ok" in m && m.ok
                                                  ? "text-emerald-600 dark:text-emerald-400"
                                                  : "warn" in m && m.warn
                                                    ? "text-amber-600"
                                                    : "text-foreground"
                                        )}
                                    >
                                        {m.value}
                                    </p>
                                </div>
                            );
                        })}
                    </div>
                </section>
            </div>

            {/* Alerts */}
            {alerts.length > 0 && (
                <section>
                    <p className="text-[10px] font-semibold uppercase tracking-wider text-foreground-muted mb-2">
                        Active alerts
                    </p>
                    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-2">
                        {alerts.map((a) => (
                            <AlertCard key={a.id} alert={a} />
                        ))}
                    </div>
                </section>
            )}

            {/* Agent fleet + integrations + activity */}
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
                <section className="lg:col-span-1 rounded-2xl border border-border bg-surface/40 p-4">
                    <div className="flex items-center justify-between mb-3">
                        <p className="text-[10px] font-semibold uppercase tracking-wider text-foreground-muted flex items-center gap-1.5">
                            <Bot size={12} /> AI agent fleet
                        </p>
                        <Link href="/chat" className="text-[10px] font-medium text-accent hover:underline">
                            All workspaces
                        </Link>
                    </div>
                    <div className="space-y-1.5">
                        {visibleAgents.map((ag) => {
                            const meta = getAgentWorkspaceMeta(ag.agentId);
                            const Icon = meta?.icon;
                            const pct =
                                ag.documentCount > 0
                                    ? Math.round((ag.readyCount / ag.documentCount) * 100)
                                    : 0;
                            return (
                                <Link
                                    key={ag.agentId}
                                    href={agentWorkspacePath(ag.agentId)}
                                    className="flex items-center gap-3 rounded-xl border border-transparent hover:border-border hover:bg-surface px-2 py-2 transition-colors group"
                                >
                                    {Icon && (
                                        <div
                                            className="h-8 w-8 rounded-lg flex items-center justify-center shrink-0"
                                            style={{ backgroundColor: meta?.accentMuted }}
                                        >
                                            <Icon size={14} style={{ color: meta?.accent }} />
                                        </div>
                                    )}
                                    <div className="flex-1 min-w-0">
                                        <p className="text-xs font-semibold text-foreground truncate">
                                            {meta?.shortName || agentLabel(ag.agentId)}
                                        </p>
                                        <p className="text-[10px] text-foreground-muted tabular-nums">
                                            {ag.readyCount}/{ag.documentCount} ready · {pct}%
                                        </p>
                                    </div>
                                    <ArrowRight
                                        size={14}
                                        className="text-foreground-muted opacity-0 group-hover:opacity-100 transition-opacity shrink-0"
                                    />
                                </Link>
                            );
                        })}
                        {visibleAgents.length === 0 && (
                            <p className="text-xs text-foreground-muted py-4 text-center">No agents on your plan.</p>
                        )}
                    </div>
                </section>

                <section className="lg:col-span-1 rounded-2xl border border-border bg-surface/40 p-4">
                    <div className="flex items-center justify-between mb-3">
                        <p className="text-[10px] font-semibold uppercase tracking-wider text-foreground-muted flex items-center gap-1.5">
                            <Plug size={12} /> Integrations
                        </p>
                        <Link href="/admin/integrations" className="text-[10px] font-medium text-accent hover:underline">
                            Manage
                        </Link>
                    </div>
                    {integrations ? (
                        integrations.items.length > 0 ? (
                        <div className="space-y-2 max-h-[240px] overflow-y-auto">
                            {integrations.items.slice(0, 8).map((item) => (
                                <div
                                    key={item.connectionId}
                                    className={cn(
                                        "rounded-xl border px-3 py-2 text-xs",
                                        item.hasAlert
                                            ? "border-amber-500/30 bg-amber-500/5"
                                            : "border-border/80 bg-background/40"
                                    )}
                                >
                                    <p className="font-semibold text-foreground truncate">{item.label}</p>
                                    <p className="text-[10px] text-foreground-muted mt-0.5">
                                        {item.providerId.replace(/_/g, " ")}
                                        {item.lastSyncAt ? ` · ${timeAgo(item.lastSyncAt)}` : " · never synced"}
                                    </p>
                                    {item.lastStatus && (
                                        <p className="text-[10px] text-foreground-muted truncate">{item.lastStatus}</p>
                                    )}
                                </div>
                            ))}
                        </div>
                        ) : (
                        <div className="text-center py-6">
                            <p className="text-xs text-foreground-muted mb-2">No connections yet</p>
                            <Link
                                href="/admin/integrations"
                                className="text-xs font-medium text-accent hover:underline inline-flex items-center gap-1"
                            >
                                Connect a system <ArrowRight size={12} />
                            </Link>
                        </div>
                        )
                    ) : (
                        <p className="text-xs text-foreground-muted text-center py-6">
                            Integration monitoring requires admin access.
                        </p>
                    )}
                </section>

                <section className="lg:col-span-1 rounded-2xl border border-border bg-surface/40 p-4">
                    <div className="flex items-center justify-between mb-3">
                        <p className="text-[10px] font-semibold uppercase tracking-wider text-foreground-muted flex items-center gap-1.5">
                            <Activity size={12} /> Live activity
                        </p>
                        <Link href="/activity" className="text-[10px] font-medium text-accent hover:underline">
                            View all
                        </Link>
                    </div>
                    <div className="space-y-2 max-h-[240px] overflow-y-auto">
                        {activity.length === 0 ? (
                            <p className="text-xs text-foreground-muted text-center py-6">No recent activity.</p>
                        ) : (
                            activity.map((log) => (
                                <div
                                    key={log.logId}
                                    className="flex gap-2 rounded-lg border border-border/60 bg-background/40 px-2.5 py-2"
                                >
                                    <span
                                        className={cn(
                                            "mt-1 h-1.5 w-1.5 rounded-full shrink-0",
                                            log.outcome === "failure" ? "bg-rose-500" : "bg-emerald-500"
                                        )}
                                    />
                                    <div className="min-w-0 flex-1">
                                        <p className="text-[11px] font-medium text-foreground truncate">
                                            {log.message || log.action.replace(/[._]/g, " ")}
                                        </p>
                                        <p className="text-[10px] text-foreground-muted">
                                            {log.actorName || log.category} · {timeAgo(log.createdAt)}
                                        </p>
                                    </div>
                                </div>
                            ))
                        )}
                    </div>
                </section>
            </div>
        </div>
    );
}
