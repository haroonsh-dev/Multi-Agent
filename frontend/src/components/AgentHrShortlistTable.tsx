"use client";

import React from "react";
import Link from "next/link";
import type { CvPendingShortlistRow, CvShortlistRow } from "@/lib/agentWorkspaceHr";
import { cn } from "@/lib/utils";

type Props = {
    rows: CvShortlistRow[];
    pendingRows?: CvPendingShortlistRow[];
    accent: string;
    maxRows?: number;
    loading?: boolean;
    onAsk?: (prompt: string) => void;
    onOpenOutreach?: () => void;
    onExportPdf?: () => void | Promise<void>;
    exporting?: boolean;
    compact?: boolean;
    onApproveOne?: (documentId: string) => void | Promise<void>;
    onApproveAllPending?: () => void | Promise<void>;
    approving?: boolean;
    approvingDocumentId?: string | null;
};

function scoreTone(score: number): string {
    if (score >= 80) return "text-emerald-600 dark:text-emerald-400 bg-emerald-500/10";
    if (score >= 60) return "text-amber-700 dark:text-amber-400 bg-amber-500/10";
    return "text-foreground-muted bg-surface-2";
}

function ShortlistSkeleton() {
    return (
        <div className="px-4 py-3 space-y-2 animate-pulse">
            {[1, 2, 3].map((i) => (
                <div key={i} className="h-9 rounded-lg bg-surface-2" />
            ))}
        </div>
    );
}

export default function AgentHrShortlistTable({
    rows,
    pendingRows = [],
    accent,
    maxRows = 8,
    loading,
    onAsk,
    onOpenOutreach,
    onExportPdf,
    exporting,
    compact,
    onApproveOne,
    onApproveAllPending,
    approving,
    approvingDocumentId,
}: Props) {
    const shown = rows.slice(0, maxRows);
    const hasPending = pendingRows.length > 0;
    const hasRanked = shown.length > 0;

    if (loading && !hasPending && !hasRanked) {
        return (
            <section className="rounded-2xl border border-border overflow-hidden bg-surface/50">
                <div className="px-4 py-3 border-b border-border bg-surface-2/30">
                    <p className="text-xs font-bold text-foreground">Candidate shortlist</p>
                    <p className="text-[10px] text-foreground-muted mt-0.5">Loading candidates…</p>
                </div>
                <ShortlistSkeleton />
            </section>
        );
    }

    if (!hasPending && !hasRanked) {
        if (compact) return null;
        return (
            <section className="rounded-2xl border border-dashed border-border overflow-hidden bg-surface/30 px-4 py-6 text-center">
                <p className="text-xs font-semibold text-foreground">No ranked candidates yet</p>
                <p className="text-[10px] text-foreground-muted mt-1">
                    Upload CVs and approve them to populate the shortlist.
                </p>
            </section>
        );
    }

    return (
        <section className={cn("rounded-2xl border border-border overflow-hidden", compact ? "bg-surface/30" : "bg-surface/50")}>
            <div className="flex items-center justify-between gap-2 px-4 py-3 border-b border-border bg-surface-2/30">
                <div>
                    <p className="text-xs font-bold text-foreground">Candidate shortlist</p>
                    {!compact && (
                        <p className="text-[10px] text-foreground-muted mt-0.5">
                            {hasPending && hasRanked
                                ? `${pendingRows.length} pending · ${shown.length} ranked`
                                : hasPending
                                  ? `${pendingRows.length} awaiting approval`
                                  : "Ranked by CV score from your portfolio"}
                        </p>
                    )}
                </div>
                <div className="flex items-center gap-3">
                    {onOpenOutreach && hasRanked && (
                        <button
                            type="button"
                            onClick={onOpenOutreach}
                            className="text-[10px] font-semibold hover:underline"
                            style={{ color: accent }}
                        >
                            Email candidates →
                        </button>
                    )}
                    {onExportPdf ? (
                        <button
                            type="button"
                            onClick={() => void onExportPdf()}
                            disabled={exporting || !hasRanked}
                            className="text-[10px] font-semibold hover:underline disabled:opacity-50 inline-flex items-center gap-1"
                            style={{ color: accent }}
                        >
                            {exporting ? "Generating…" : "Export PDF →"}
                        </button>
                    ) : onAsk && hasRanked ? (
                        <button
                            type="button"
                            onClick={() => onAsk("Export shortlist top 10 candidates")}
                            className="text-[10px] font-semibold hover:underline"
                            style={{ color: accent }}
                        >
                            Export PDF →
                        </button>
                    ) : null}
                </div>
            </div>

            {hasPending && (
                <div className="border-b border-border bg-amber-500/5">
                    <div className="px-4 py-2 flex items-center justify-between gap-2 border-b border-border/50">
                        <p className="text-[10px] font-bold uppercase tracking-wider text-amber-800 dark:text-amber-300">
                            Pending approval
                        </p>
                        {onApproveAllPending && pendingRows.length > 1 && (
                            <button
                                type="button"
                                onClick={() => void onApproveAllPending()}
                                disabled={approving}
                                className="text-[10px] font-semibold hover:underline disabled:opacity-50"
                                style={{ color: accent }}
                            >
                                {approving && !approvingDocumentId ? "Approving…" : "Approve all"}
                            </button>
                        )}
                    </div>
                    <div className="divide-y divide-border/50">
                        {pendingRows.map((row) => {
                            const isApproving = approving && approvingDocumentId === row.documentId;
                            return (
                                <div
                                    key={row.documentId}
                                    className="px-4 py-2.5 flex items-center justify-between gap-3 hover:bg-surface-2/40"
                                >
                                    <div className="min-w-0">
                                        <Link
                                            href={`/documents/${row.documentId}/details`}
                                            className="text-xs font-semibold text-foreground hover:underline truncate block"
                                        >
                                            {row.name}
                                        </Link>
                                        <p className="text-[10px] text-foreground-muted truncate">{row.filename}</p>
                                    </div>
                                    {onApproveOne && (
                                        <button
                                            type="button"
                                            onClick={() => void onApproveOne(row.documentId)}
                                            disabled={Boolean(approving)}
                                            className="shrink-0 rounded-lg border border-emerald-500/40 bg-emerald-500/10 px-2.5 py-1 text-[10px] font-bold text-emerald-800 dark:text-emerald-300 hover:bg-emerald-500/15 disabled:opacity-50"
                                        >
                                            {isApproving ? "Adding…" : "Approve"}
                                        </button>
                                    )}
                                </div>
                            );
                        })}
                    </div>
                </div>
            )}

            {loading && hasRanked ? <ShortlistSkeleton /> : null}

            {hasRanked && !loading && (
                <div className="overflow-x-auto">
                    <table className="w-full text-left text-xs">
                        <thead>
                            <tr className="text-[10px] uppercase tracking-wider text-foreground-muted border-b border-border">
                                <th className="px-4 py-2 font-semibold w-10">#</th>
                                <th className="px-4 py-2 font-semibold">Candidate</th>
                                <th className="px-4 py-2 font-semibold text-right w-24">Status</th>
                                <th className="px-4 py-2 font-semibold text-right w-28">Score</th>
                                <th className="px-4 py-2 font-semibold text-right w-28">Action</th>
                            </tr>
                        </thead>
                        <tbody>
                            {shown.map((row) => (
                                <tr
                                    key={`${row.rank}-${row.documentId || row.name}`}
                                    className="border-b border-border/50 last:border-0 hover:bg-surface-2/50"
                                >
                                    <td className="px-4 py-2.5 tabular-nums text-foreground-muted font-medium">
                                        {row.rank}
                                    </td>
                                    <td className="px-4 py-2.5 font-medium text-foreground">
                                        {row.documentId ? (
                                            <Link
                                                href={`/documents/${row.documentId}/details`}
                                                className="hover:underline"
                                            >
                                                {row.name}
                                            </Link>
                                        ) : (
                                            row.name
                                        )}
                                    </td>
                                    <td className="px-4 py-2.5 text-right">
                                        <span
                                            className={cn(
                                                "inline-flex rounded-md px-2 py-0.5 text-[10px] font-bold uppercase",
                                                row.score >= 80
                                                    ? "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400"
                                                    : row.score >= 60
                                                      ? "bg-amber-500/10 text-amber-800 dark:text-amber-300"
                                                      : "bg-surface-2 text-foreground-muted"
                                            )}
                                        >
                                            {row.pipelineStatus}
                                        </span>
                                    </td>
                                    <td className="px-4 py-2.5 text-right">
                                        <div className="inline-flex flex-col items-end gap-0.5">
                                            <span
                                                className={cn(
                                                    "inline-flex rounded-md px-2 py-0.5 font-bold tabular-nums",
                                                    scoreTone(row.score)
                                                )}
                                            >
                                                {Math.round(row.score)}
                                            </span>
                                            {row.scoreSource === "hr_approved" && (
                                                <span className="text-[9px] text-foreground-muted">HR approved</span>
                                            )}
                                        </div>
                                    </td>
                                    <td className="px-4 py-2.5 text-right">
                                        {onAsk ? (
                                            <button
                                                type="button"
                                                onClick={() =>
                                                    onAsk(
                                                        row.agentAction === "Shortlist"
                                                            ? `Prepare offer letter for ${row.name}`
                                                            : `Review CV for ${row.name}`
                                                    )
                                                }
                                                className="text-[10px] font-semibold hover:underline"
                                                style={{ color: accent }}
                                            >
                                                {row.agentAction === "Shortlist" ? "Offer letter" : row.agentAction}
                                            </button>
                                        ) : (
                                            <span className="text-[10px] font-semibold text-foreground-muted">
                                                {row.agentAction}
                                            </span>
                                        )}
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            )}
        </section>
    );
}
