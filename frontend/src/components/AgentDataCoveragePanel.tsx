"use client";

import React from "react";
import Link from "next/link";
import { AlertTriangle, CheckCircle2, Wrench } from "lucide-react";
import type { PortfolioFile } from "@/lib/agentWorkspaceKpis";
import { cn } from "@/lib/utils";

type Props = {
    totalDocs: number;
    chartedDocs: number;
    skippedDocs: number;
    healthScore: number;
    skippedFiles: PortfolioFile[];
    accent: string;
    onOpenFix: () => void;
};

function fileStatusLabel(status: string): string {
    if (status === "no_extraction") return "Needs extraction";
    if (status === "missing_amount") return "Missing fields";
    if (status === "processing") return "Processing";
    if (status === "unsupported_format") return "Unsupported";
    return "Not in charts";
}

export default function AgentDataCoveragePanel({
    totalDocs,
    chartedDocs,
    skippedDocs,
    healthScore,
    skippedFiles,
    accent,
    onOpenFix,
}: Props) {
    if (totalDocs === 0) return null;

    const tone =
        healthScore >= 85 ? "good" : healthScore >= 45 ? "partial" : "low";

    return (
        <section className="rounded-2xl border border-border bg-surface/30 overflow-hidden">
            <div className="px-4 py-3 border-b border-border flex flex-wrap items-center justify-between gap-3">
                <div className="flex items-center gap-2">
                    {tone === "good" ? (
                        <CheckCircle2 size={14} className="text-emerald-500" />
                    ) : (
                        <AlertTriangle size={14} className="text-amber-500" />
                    )}
                    <p className="text-xs font-bold text-foreground">Data coverage</p>
                </div>
                <div className="flex flex-wrap items-center gap-2 text-[10px] text-foreground-muted">
                    <span className="tabular-nums">
                        <strong className="text-foreground">{chartedDocs}</strong>/{totalDocs} chart-ready
                    </span>
                    <span>·</span>
                    <span className="tabular-nums">{healthScore}% quality</span>
                    {skippedDocs > 0 && (
                        <>
                            <span>·</span>
                            <button
                                type="button"
                                onClick={onOpenFix}
                                className="font-semibold text-amber-700 dark:text-amber-300 hover:underline"
                            >
                                {skippedDocs} need fix
                            </button>
                        </>
                    )}
                </div>
            </div>

            {skippedFiles.length > 0 && (
                <div className="px-4 py-3 space-y-2 max-h-40 overflow-y-auto">
                    {skippedFiles.slice(0, 5).map((f) => (
                        <div
                            key={f.documentId}
                            className="flex items-center justify-between gap-2 text-[11px] rounded-lg border border-border/60 bg-background/40 px-3 py-2"
                        >
                            <div className="min-w-0">
                                <p className="font-medium text-foreground truncate">{f.filename}</p>
                                <p className="text-[10px] text-foreground-muted">
                                    {f.detail || fileStatusLabel(f.status)}
                                </p>
                            </div>
                            <Link
                                href={`/documents/${f.documentId}/details`}
                                className="shrink-0 text-[10px] font-semibold hover:underline"
                                style={{ color: accent }}
                            >
                                Reprocess
                            </Link>
                        </div>
                    ))}
                    {skippedDocs > 5 && (
                        <button
                            type="button"
                            onClick={onOpenFix}
                            className={cn(
                                "w-full text-center text-[10px] font-semibold py-1.5 rounded-lg",
                                "text-amber-800 dark:text-amber-300 hover:bg-amber-500/10"
                            )}
                        >
                            <Wrench size={11} className="inline mr-1" />
                            View all {skippedDocs} files in Fix tab
                        </button>
                    )}
                </div>
            )}
        </section>
    );
}
