"use client";

import React, { useMemo, useState } from "react";
import Link from "next/link";
import { FileText, Search, Upload } from "lucide-react";
import type { PortfolioFile } from "@/lib/agentWorkspaceKpis";
import { cn } from "@/lib/utils";

type Filter = "all" | "charted" | "issues";

type Props = {
    files: PortfolioFile[];
    loading?: boolean;
    accent: string;
    onAskFix: (filename: string) => void;
};

export default function AgentPortfolioPanel({ files, loading, accent, onAskFix }: Props) {
    const [query, setQuery] = useState("");
    const [filter, setFilter] = useState<Filter>("all");

    const stats = useMemo(
        () => ({
            total: files.length,
            charted: files.filter((f) => f.inCharts).length,
            issues: files.filter((f) => !f.inCharts).length,
        }),
        [files]
    );

    const filtered = useMemo(() => {
        const q = query.trim().toLowerCase();
        return files.filter((f) => {
            if (filter === "charted" && !f.inCharts) return false;
            if (filter === "issues" && f.inCharts) return false;
            if (q && !f.filename.toLowerCase().includes(q)) return false;
            return true;
        });
    }, [files, query, filter]);

    const filters: { id: Filter; label: string; count: number }[] = [
        { id: "all", label: "All", count: stats.total },
        { id: "charted", label: "Charted", count: stats.charted },
        { id: "issues", label: "Needs work", count: stats.issues },
    ];

    if (loading && files.length === 0) {
        return (
            <div className="space-y-3 animate-pulse">
                <div className="h-10 rounded-xl bg-surface-2" />
                <div className="h-24 rounded-2xl bg-surface-2" />
                <div className="h-24 rounded-2xl bg-surface-2" />
            </div>
        );
    }

    if (files.length === 0) {
        return (
            <div className="rounded-2xl border border-dashed border-border py-16 text-center">
                <FileText size={36} className="mx-auto text-foreground-muted mb-3 opacity-50" />
                <p className="text-sm font-semibold">No portfolio files yet</p>
                <p className="text-xs text-foreground-muted mt-1 max-w-sm mx-auto">
                    Upload documents assigned to this agent, or connect an integration that feeds this workspace.
                </p>
                <div className="flex flex-wrap justify-center gap-2 mt-5">
                    <Link href="/documents" className="btn-gradient rounded-xl px-4 py-2 text-sm inline-flex items-center gap-1.5">
                        <Upload size={14} /> Upload documents
                    </Link>
                    <Link href="/admin/integrations" className="btn-secondary rounded-xl px-4 py-2 text-sm">
                        Connect integration
                    </Link>
                </div>
            </div>
        );
    }

    return (
        <div className="space-y-4">
            <div className="grid grid-cols-3 gap-2">
                {[
                    { label: "Total", value: stats.total },
                    { label: "Charted", value: stats.charted },
                    { label: "Needs work", value: stats.issues },
                ].map((s) => (
                    <div key={s.label} className="rounded-xl border border-border bg-surface/40 px-3 py-2.5">
                        <p className="text-[10px] font-semibold uppercase tracking-wider text-foreground-muted">{s.label}</p>
                        <p className="text-lg font-bold tabular-nums">{s.value}</p>
                    </div>
                ))}
            </div>

            <div className="flex flex-col sm:flex-row gap-2">
                <div className="relative flex-1">
                    <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-foreground-muted" />
                    <input
                        type="search"
                        value={query}
                        onChange={(e) => setQuery(e.target.value)}
                        placeholder="Search files…"
                        className="w-full rounded-xl border border-border bg-background pl-9 pr-3 py-2 text-sm"
                    />
                </div>
                <div className="flex gap-1 rounded-xl border border-border p-1 bg-surface/30">
                    {filters.map((f) => (
                        <button
                            key={f.id}
                            type="button"
                            onClick={() => setFilter(f.id)}
                            className={cn(
                                "rounded-lg px-2.5 py-1.5 text-[11px] font-semibold whitespace-nowrap transition-colors",
                                filter === f.id ? "text-white" : "text-foreground-muted hover:text-foreground"
                            )}
                            style={filter === f.id ? { backgroundColor: accent } : undefined}
                        >
                            {f.label} ({f.count})
                        </button>
                    ))}
                </div>
            </div>

            <div className="space-y-2">
                {filtered.length === 0 ? (
                    <p className="text-sm text-foreground-muted text-center py-8">No files match your filters.</p>
                ) : (
                    filtered.map((f) => (
                        <div
                            key={f.documentId}
                            className="flex flex-wrap items-center gap-3 rounded-xl border border-border bg-surface/50 px-4 py-3 hover:border-accent/30 transition-colors"
                        >
                            <span
                                className={cn(
                                    "shrink-0 rounded-md px-2 py-0.5 text-[9px] font-bold uppercase",
                                    f.inCharts
                                        ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400"
                                        : "bg-amber-500/15 text-amber-700 dark:text-amber-400"
                                )}
                            >
                                {f.inCharts ? "Charted" : f.status.replace(/_/g, " ")}
                            </span>
                            <Link
                                href={`/documents/${f.documentId}/details`}
                                className="flex-1 min-w-0 text-sm font-medium hover:text-accent truncate"
                            >
                                {f.filename}
                            </Link>
                            {f.detail && !f.inCharts && (
                                <span className="text-[10px] text-foreground-muted truncate max-w-[40%] hidden sm:inline">
                                    {f.detail}
                                </span>
                            )}
                            {!f.inCharts && (
                                <button
                                    type="button"
                                    onClick={() => onAskFix(f.filename)}
                                    className="text-xs text-accent font-medium shrink-0"
                                >
                                    Ask AI
                                </button>
                            )}
                        </div>
                    ))
                )}
            </div>
        </div>
    );
}
