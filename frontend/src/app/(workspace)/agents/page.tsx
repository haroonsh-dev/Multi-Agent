"use client";

import React, { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { ArrowRight, MessageSquare, RefreshCw, Search, Sparkles } from "lucide-react";
import { useAgentFleet } from "@/hooks/useAgentFleet";
import { usePlanAgents } from "@/hooks/usePlanAgents";
import {
    AGENT_POWER_ACTIONS,
    AGENT_WORKSPACE_META,
    agentChatPath,
    agentWorkspacePath,
} from "@/lib/agentWorkspace";
import type { AnalyticsAgentId } from "@/lib/documentAgents";
import { cn } from "@/lib/utils";

type HealthFilter = "all" | "ready" | "partial" | "empty" | "needs";

function FleetHealthRing({ score, accent }: { score: number; accent: string }) {
    const r = 22;
    const c = 2 * Math.PI * r;
    const offset = c - (score / 100) * c;
    return (
        <div className="relative h-12 w-12 shrink-0">
            <svg className="h-12 w-12 -rotate-90" viewBox="0 0 52 52">
                <circle cx="26" cy="26" r={r} fill="none" stroke="var(--border)" strokeWidth="4" />
                <circle
                    cx="26"
                    cy="26"
                    r={r}
                    fill="none"
                    stroke={accent}
                    strokeWidth="4"
                    strokeLinecap="round"
                    strokeDasharray={c}
                    strokeDashoffset={offset}
                />
            </svg>
            <span className="absolute inset-0 flex items-center justify-center text-[10px] font-bold tabular-nums">
                {score}%
            </span>
        </div>
    );
}

function healthBucket(label: string): HealthFilter {
    if (label === "Ready") return "ready";
    if (label === "Partial") return "partial";
    if (label === "Empty") return "empty";
    return "needs";
}

export default function AgentsFleetPage() {
    const { agents, loading, error, load } = useAgentFleet();
    const { agentOptions } = usePlanAgents();
    const [query, setQuery] = useState("");
    const [healthFilter, setHealthFilter] = useState<HealthFilter>("all");
    const [sortBy, setSortBy] = useState<"health" | "docs" | "name">("health");

    useEffect(() => {
        void load();
        const id = setInterval(() => void load(), 60_000);
        return () => clearInterval(id);
    }, [load]);

    const allowed = new Set(agentOptions.map((a) => a.value));
    const rows = agents.filter((a) => allowed.has(a.agentId));

    const filtered = useMemo(() => {
        const q = query.trim().toLowerCase();
        let list = rows.filter((row) => {
            const meta = AGENT_WORKSPACE_META[row.agentId as AnalyticsAgentId];
            if (!meta) return false;
            if (healthFilter !== "all" && healthBucket(row.healthLabel) !== healthFilter) return false;
            if (!q) return true;
            return (
                meta.shortName.toLowerCase().includes(q) ||
                meta.tagline.toLowerCase().includes(q) ||
                row.agentId.includes(q)
            );
        });
        list = [...list].sort((a, b) => {
            const metaA = AGENT_WORKSPACE_META[a.agentId as AnalyticsAgentId];
            const metaB = AGENT_WORKSPACE_META[b.agentId as AnalyticsAgentId];
            if (sortBy === "name") {
                return (metaA?.shortName || "").localeCompare(metaB?.shortName || "");
            }
            if (sortBy === "docs") return b.documentCount - a.documentCount;
            return b.healthScore - a.healthScore;
        });
        return list;
    }, [rows, query, healthFilter, sortBy]);

    const totals = useMemo(
        () => ({
            docs: rows.reduce((s, r) => s + r.documentCount, 0),
            ready: rows.reduce((s, r) => s + r.readyCount, 0),
            agents: rows.length,
            avgHealth: rows.length
                ? Math.round(rows.reduce((s, r) => s + r.healthScore, 0) / rows.length)
                : 0,
            needsWork: rows.filter((r) => r.healthLabel !== "Ready" && r.healthLabel !== "Empty").length,
        }),
        [rows]
    );

    const weakest = useMemo(() => {
        const candidates = rows.filter((r) => r.documentCount > 0 && r.healthScore < 85);
        if (!candidates.length) return null;
        return [...candidates].sort((a, b) => a.healthScore - b.healthScore)[0];
    }, [rows]);

    const healthFilters: { id: HealthFilter; label: string }[] = [
        { id: "all", label: "All" },
        { id: "ready", label: "Ready" },
        { id: "partial", label: "Partial" },
        { id: "needs", label: "Needs work" },
        { id: "empty", label: "Empty" },
    ];

    return (
        <div className="min-h-[calc(100vh-3.5rem)] bg-background">
            <div className="relative overflow-hidden border-b border-border">
                <div
                    className="absolute inset-0 opacity-40"
                    style={{
                        background:
                            "radial-gradient(ellipse 80% 60% at 50% -20%, rgba(56,182,255,0.25), transparent 70%)",
                    }}
                />
                <div className="relative max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 py-10 sm:py-12">
                    <div className="flex flex-wrap items-start justify-between gap-4">
                        <div>
                            <div className="flex items-center gap-2 text-accent mb-3">
                                <Sparkles size={18} />
                                <span className="text-[10px] font-bold uppercase tracking-[0.2em]">AI Workspaces</span>
                            </div>
                            <h1 className="text-3xl sm:text-4xl font-bold tracking-tight text-foreground max-w-xl">
                                Specialist agents, one command center each
                            </h1>
                            <p className="mt-3 text-sm text-foreground-muted max-w-2xl leading-relaxed">
                                Command dashboards, inline chat, portfolio search, one-click reports, and live analytics — for every agent on your plan.
                            </p>
                        </div>
                        <div className="flex gap-2">
                            <button
                                type="button"
                                onClick={() => void load()}
                                className="btn-secondary rounded-xl px-3 py-2 text-xs inline-flex items-center gap-1.5"
                            >
                                <RefreshCw size={13} /> Refresh
                            </button>
                            <Link
                                href="/chat?new=1"
                                className="btn-gradient rounded-xl px-4 py-2 text-sm inline-flex items-center gap-2"
                            >
                                <MessageSquare size={15} /> Quick chat
                            </Link>
                        </div>
                    </div>

                    {!loading && rows.length > 0 && (
                        <div className="mt-8 grid grid-cols-2 sm:grid-cols-5 gap-3">
                            {[
                                { label: "Agents", value: totals.agents },
                                { label: "Documents", value: totals.docs },
                                { label: "Chart-ready", value: totals.ready },
                                { label: "Avg readiness", value: `${totals.avgHealth}%` },
                                { label: "Need attention", value: totals.needsWork },
                            ].map((s) => (
                                <div
                                    key={s.label}
                                    className="rounded-xl border border-border/80 bg-surface/50 px-4 py-3 backdrop-blur-sm"
                                >
                                    <p className="text-[10px] font-semibold uppercase tracking-wider text-foreground-muted">
                                        {s.label}
                                    </p>
                                    <p className="text-xl font-bold tabular-nums mt-0.5">{s.value}</p>
                                </div>
                            ))}
                        </div>
                    )}

                    {weakest && (
                        <div className="mt-4 rounded-xl border border-amber-500/25 bg-amber-500/5 px-4 py-3 flex flex-wrap items-center justify-between gap-3">
                            <p className="text-xs text-foreground-muted">
                                <span className="font-semibold text-foreground">
                                    {AGENT_WORKSPACE_META[weakest.agentId as AnalyticsAgentId]?.shortName}
                                </span>{" "}
                                has the lowest readiness ({weakest.healthScore}%) — open workspace to fix portfolio gaps.
                            </p>
                            <Link
                                href={agentWorkspacePath(weakest.agentId)}
                                className="text-xs font-semibold text-accent hover:underline"
                            >
                                Open workspace →
                            </Link>
                        </div>
                    )}
                </div>
            </div>

            <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
                <div className="flex flex-col sm:flex-row gap-3 mb-6">
                    <div className="relative flex-1">
                        <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-foreground-muted" />
                        <input
                            type="search"
                            value={query}
                            onChange={(e) => setQuery(e.target.value)}
                            placeholder="Search agents…"
                            className="w-full rounded-xl border border-border bg-surface/40 pl-9 pr-3 py-2.5 text-sm"
                        />
                    </div>
                    <select
                        value={sortBy}
                        onChange={(e) => setSortBy(e.target.value as typeof sortBy)}
                        className="rounded-xl border border-border bg-surface/40 px-3 py-2.5 text-sm"
                    >
                        <option value="health">Sort: readiness</option>
                        <option value="docs">Sort: document count</option>
                        <option value="name">Sort: name</option>
                    </select>
                </div>

                <div className="flex flex-wrap gap-2 mb-6">
                    {healthFilters.map((f) => (
                        <button
                            key={f.id}
                            type="button"
                            onClick={() => setHealthFilter(f.id)}
                            className={cn(
                                "rounded-full border px-3 py-1.5 text-[11px] font-semibold transition-colors",
                                healthFilter === f.id
                                    ? "border-accent bg-accent-muted text-accent"
                                    : "border-border text-foreground-muted hover:text-foreground"
                            )}
                        >
                            {f.label}
                        </button>
                    ))}
                </div>

                {loading && (
                    <p className="text-sm text-foreground-muted text-center py-16">Loading workspaces…</p>
                )}
                {error && (
                    <p className="text-sm text-rose-600 text-center py-8 rounded-xl border border-rose-500/30 bg-rose-500/5">
                        {error}
                    </p>
                )}
                {!loading && !error && filtered.length === 0 && (
                    <p className="text-sm text-foreground-muted text-center py-16">No agents match your filters.</p>
                )}
                {!loading && !error && filtered.length > 0 && (
                    <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-4">
                        {filtered.map((row) => {
                            const meta = AGENT_WORKSPACE_META[row.agentId as AnalyticsAgentId];
                            if (!meta) return null;
                            const Icon = meta.icon;
                            const power = AGENT_POWER_ACTIONS[row.agentId as AnalyticsAgentId]?.[0];
                            return (
                                <div
                                    key={row.agentId}
                                    className="group relative rounded-2xl border border-border bg-surface/50 overflow-hidden hover:shadow-xl transition-all duration-300"
                                >
                                    <div
                                        className="absolute inset-0 opacity-0 group-hover:opacity-100 transition-opacity duration-300 pointer-events-none"
                                        style={{
                                            background: `linear-gradient(145deg, ${meta.accentMuted} 0%, transparent 55%)`,
                                        }}
                                    />
                                    <Link href={agentWorkspacePath(row.agentId)} className="block p-5 relative">
                                        <div className="flex items-start gap-4">
                                            <div
                                                className="h-14 w-14 rounded-2xl flex items-center justify-center shrink-0"
                                                style={{ backgroundColor: meta.accentMuted }}
                                            >
                                                <Icon size={26} style={{ color: meta.accent }} />
                                            </div>
                                            <div className="flex-1 min-w-0">
                                                <h2 className="text-lg font-bold text-foreground">{meta.shortName}</h2>
                                                <p className="text-xs text-foreground-muted line-clamp-2 mt-0.5">
                                                    {meta.tagline}
                                                </p>
                                                <div className="mt-3 flex flex-wrap gap-2 text-[10px] font-semibold">
                                                    <span className="rounded-full bg-background/80 border border-border px-2 py-0.5 tabular-nums">
                                                        {row.documentCount} docs · {row.readyCount} ready
                                                    </span>
                                                    <span
                                                        className={cn(
                                                            "rounded-full px-2 py-0.5",
                                                            row.healthLabel === "Ready"
                                                                ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400"
                                                                : row.healthLabel === "Empty"
                                                                  ? "bg-surface-2 text-foreground-muted"
                                                                  : "bg-amber-500/15 text-amber-700 dark:text-amber-400"
                                                        )}
                                                    >
                                                        {row.healthLabel}
                                                    </span>
                                                </div>
                                            </div>
                                            <FleetHealthRing score={row.healthScore} accent={meta.accent} />
                                        </div>
                                        <div className="mt-4 pt-4 border-t border-border/60 flex items-center justify-between">
                                            <span className="text-xs font-semibold text-accent">Open workspace</span>
                                            <ArrowRight
                                                size={16}
                                                className="text-foreground-muted group-hover:text-accent transition-colors"
                                            />
                                        </div>
                                    </Link>
                                    {power && (
                                        <div className="relative px-5 pb-4 flex gap-2">
                                            <Link
                                                href={`${agentChatPath(row.agentId)}&q=${encodeURIComponent(power.prompt)}`}
                                                onClick={(e) => e.stopPropagation()}
                                                className="flex-1 text-center rounded-lg border border-border bg-background/60 py-1.5 text-[10px] font-semibold hover:border-accent/40"
                                            >
                                                {power.label}
                                            </Link>
                                            <Link
                                                href={`${agentWorkspacePath(row.agentId)}?tab=reports`}
                                                className="rounded-lg border border-border bg-background/60 px-3 py-1.5 text-[10px] font-semibold hover:border-accent/40"
                                            >
                                                Reports
                                            </Link>
                                        </div>
                                    )}
                                </div>
                            );
                        })}
                    </div>
                )}
            </div>
        </div>
    );
}
