"use client";

import React, { useEffect, useState } from "react";
import Link from "next/link";
import {
    Award,
    Calendar,
    Download,
    ExternalLink,
    FileBarChart,
    FileText,
    Loader2,
    Mail,
    Users,
} from "lucide-react";
import type { ChatVisualSpec } from "@/types/chatVisuals";
import type { HrWorkforceSnapshot, CvShortlistRow } from "@/lib/agentWorkspaceHr";
import { resolveCvShortlist } from "@/lib/agentWorkspaceHr";
import { HR_REPORT_ACTIONS, hrGeneratedDocLabel, type HrLetterContext, type HrReportActionId } from "@/lib/hrReports";
import { useHrReports } from "@/hooks/useHrReports";
import { generatedPreviewHref } from "@/lib/generatedDocuments";
import { getDocumentDownloadUrl } from "@/lib/documents";
import AgentHrShortlistTable from "@/components/AgentHrShortlistTable";
import { useToast } from "@/components/Toast";
import { cn } from "@/lib/utils";

const GROUP_LABELS = {
    reports: "Core reports",
    sections: "Section PDFs",
    letters: "Letters & certificates",
} as const;

const ACTION_ICONS: Partial<Record<HrReportActionId, React.ElementType>> = {
    full_report: FileBarChart,
    shortlist: Users,
    cert_report: Award,
    leave_report: Calendar,
    payroll_report: FileText,
    performance_report: FileBarChart,
    joining_letter: Mail,
    internship_letter: Mail,
    training_certificate: Award,
};

type Props = {
    snapshot: HrWorkforceSnapshot;
    accent: string;
    visuals: ChatVisualSpec[];
    hrShortlist?: CvShortlistRow[];
    onOpenOutreach: () => void;
    onRunInChat?: (prompt: string) => void;
};

function formatWhen(iso: string): string {
    try {
        const d = new Date(iso);
        return d.toLocaleDateString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
    } catch {
        return "";
    }
}

export default function AgentHrReportsPanel({
    snapshot,
    accent,
    visuals,
    hrShortlist,
    onOpenOutreach,
    onRunInChat,
}: Props) {
    const { showToast } = useToast();
    const { history, historyLoading, generatingId, lastMessage, generate, loadHistory, isGenerating } =
        useHrReports();
    const shortlist = resolveCvShortlist(hrShortlist, visuals, 10);
    const [letterContext, setLetterContext] = useState<HrLetterContext>({
        companyName: "Visibility Bots",
        candidateName: shortlist[0]?.name || "",
        jobTitle: "Software Engineer",
        department: "Engineering",
        trainingName: "Professional Development",
        duration: "4 weeks",
    });

    const handleGenerate = async (actionId: HrReportActionId) => {
        const isLetter = HR_REPORT_ACTIONS.find((a) => a.id === actionId)?.group === "letters";
        const result = await generate(actionId, {
            shortlistLimit: 10,
            letterContext: isLetter ? letterContext : undefined,
        });
        showToast(result.message, result.ok ? "success" : "error");
    };

    const groups = (["reports", "sections", "letters"] as const).map((group) => ({
        group,
        actions: HR_REPORT_ACTIONS.filter((a) => a.group === group),
    }));

    return (
        <section className="rounded-2xl border border-border overflow-hidden bg-surface/50">
            <div
                className="px-4 py-4 border-b border-border bg-surface/40"
                style={{ boxShadow: `inset 3px 0 0 ${accent}` }}
            >
                <p className="text-sm font-bold text-foreground flex items-center gap-2">
                    <FileBarChart size={16} style={{ color: accent }} />
                    HR reports hub
                </p>
                <p className="text-xs text-foreground-muted mt-1 max-w-xl">
                    One-click PDFs — workforce reports, shortlists, section registers, and HR letters. Opens in a new tab when ready.
                </p>
            </div>

            <div className="px-4 py-3 border-b border-border bg-surface-2/20 flex flex-wrap gap-x-5 gap-y-1 text-xs">
                <span>
                    <strong className="text-foreground">{snapshot.stats.totalFiles}</strong>{" "}
                    <span className="text-foreground-muted">files</span>
                </span>
                <span>
                    <strong className="text-foreground">{snapshot.stats.cvsScored}</strong>{" "}
                    <span className="text-foreground-muted">CVs scored</span>
                </span>
                <span>
                    <strong className="text-foreground">{snapshot.stats.certsTracked}</strong>{" "}
                    <span className="text-foreground-muted">certs tracked</span>
                </span>
                {snapshot.stats.certsExpiring > 0 && (
                    <span>
                        <strong className="text-foreground">{snapshot.stats.certsExpiring}</strong>{" "}
                        <span className="text-foreground-muted">expiring soon</span>
                    </span>
                )}
                {snapshot.stats.certsExpired > 0 && (
                    <span>
                        <strong className="text-foreground">{snapshot.stats.certsExpired}</strong>{" "}
                        <span className="text-foreground-muted">expired</span>
                    </span>
                )}
                {snapshot.stats.topCvScore != null && (
                    <span>
                        <strong className="text-foreground">{snapshot.stats.topCvScore}</strong>{" "}
                        <span className="text-foreground-muted">top CV score</span>
                    </span>
                )}
            </div>

            <div className="p-4 space-y-5">
                {groups.map(({ group, actions }) => (
                    <div key={group}>
                        <p className="text-[10px] font-semibold uppercase tracking-wider text-foreground-muted mb-2">
                            {GROUP_LABELS[group]}
                        </p>
                        <div
                            className={cn(
                                "grid gap-2",
                                group === "letters" ? "grid-cols-1 sm:grid-cols-3" : "grid-cols-1 sm:grid-cols-2"
                            )}
                        >
                            {actions.map((action) => {
                                const Icon = ACTION_ICONS[action.id] || FileBarChart;
                                const busy = generatingId === action.id;
                                return (
                                    <button
                                        key={action.id}
                                        type="button"
                                        disabled={isGenerating}
                                        onClick={() => void handleGenerate(action.id)}
                                        className={cn(
                                            "text-left rounded-xl border border-border bg-surface/40 px-3 py-3 transition-colors",
                                            isGenerating && !busy ? "opacity-50 cursor-not-allowed" : "hover:bg-surface-2/60",
                                            busy && "ring-1 ring-accent/30"
                                        )}
                                    >
                                        <div className="flex items-start justify-between gap-2">
                                            <Icon size={16} style={{ color: accent }} className="shrink-0 mt-0.5" />
                                            {busy && <Loader2 size={14} className="animate-spin shrink-0" style={{ color: accent }} />}
                                        </div>
                                        <p className="text-xs font-bold text-foreground mt-2">{action.label}</p>
                                        <p className="text-[10px] text-foreground-muted mt-0.5 leading-relaxed">
                                            {action.description}
                                        </p>
                                    </button>
                                );
                            })}
                        </div>
                    </div>
                ))}

                <div className="rounded-xl border border-border bg-surface/30 p-3 space-y-2">
                    <p className="text-[10px] font-semibold uppercase tracking-wider text-foreground-muted">
                        Letter details
                    </p>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                        <label className="text-[10px] font-semibold text-foreground-muted">
                            Candidate name
                            <input
                                value={letterContext.candidateName || ""}
                                onChange={(e) =>
                                    setLetterContext((c) => ({ ...c, candidateName: e.target.value }))
                                }
                                placeholder="Full name"
                                className="mt-1 w-full rounded-lg border border-border bg-background px-2.5 py-1.5 text-xs font-normal"
                            />
                        </label>
                        <label className="text-[10px] font-semibold text-foreground-muted">
                            Company
                            <input
                                value={letterContext.companyName || ""}
                                onChange={(e) =>
                                    setLetterContext((c) => ({ ...c, companyName: e.target.value }))
                                }
                                className="mt-1 w-full rounded-lg border border-border bg-background px-2.5 py-1.5 text-xs font-normal"
                            />
                        </label>
                        <label className="text-[10px] font-semibold text-foreground-muted">
                            Job title
                            <input
                                value={letterContext.jobTitle || ""}
                                onChange={(e) =>
                                    setLetterContext((c) => ({ ...c, jobTitle: e.target.value }))
                                }
                                className="mt-1 w-full rounded-lg border border-border bg-background px-2.5 py-1.5 text-xs font-normal"
                            />
                        </label>
                        <label className="text-[10px] font-semibold text-foreground-muted">
                            Department
                            <input
                                value={letterContext.department || ""}
                                onChange={(e) =>
                                    setLetterContext((c) => ({ ...c, department: e.target.value }))
                                }
                                className="mt-1 w-full rounded-lg border border-border bg-background px-2.5 py-1.5 text-xs font-normal"
                            />
                        </label>
                        <label className="text-[10px] font-semibold text-foreground-muted">
                            Training / course
                            <input
                                value={letterContext.trainingName || ""}
                                onChange={(e) =>
                                    setLetterContext((c) => ({ ...c, trainingName: e.target.value }))
                                }
                                className="mt-1 w-full rounded-lg border border-border bg-background px-2.5 py-1.5 text-xs font-normal"
                            />
                        </label>
                        <label className="text-[10px] font-semibold text-foreground-muted">
                            Duration
                            <input
                                value={letterContext.duration || ""}
                                onChange={(e) =>
                                    setLetterContext((c) => ({ ...c, duration: e.target.value }))
                                }
                                className="mt-1 w-full rounded-lg border border-border bg-background px-2.5 py-1.5 text-xs font-normal"
                            />
                        </label>
                    </div>
                    <p className="text-[10px] text-foreground-muted">
                        Used for joining, internship, and training certificate PDFs. Top shortlist candidate is prefilled when available.
                    </p>
                </div>

                {lastMessage && (
                    <p className="text-xs text-amber-800 dark:text-amber-300 bg-amber-500/10 border border-amber-500/25 rounded-xl px-3 py-2">
                        {lastMessage}
                    </p>
                )}

                <div>
                    <div className="flex items-center justify-between gap-2 mb-2">
                        <p className="text-[10px] font-semibold uppercase tracking-wider text-foreground-muted">
                            Recent reports
                        </p>
                        <button
                            type="button"
                            onClick={() => void loadHistory()}
                            disabled={historyLoading}
                            className="text-[10px] font-semibold hover:underline disabled:opacity-50"
                            style={{ color: accent }}
                        >
                            {historyLoading ? "Refreshing…" : "Refresh"}
                        </button>
                    </div>
                    {historyLoading && history.length === 0 ? (
                        <div className="flex items-center justify-center py-6 text-xs text-foreground-muted gap-2">
                            <Loader2 size={14} className="animate-spin" /> Loading…
                        </div>
                    ) : history.length === 0 ? (
                        <p className="text-xs text-foreground-muted py-4 text-center border border-dashed border-border rounded-xl">
                            No generated reports yet. Click a report above to create your first PDF.
                        </p>
                    ) : (
                        <ul className="rounded-xl border border-border divide-y divide-border overflow-hidden">
                            {history.map((doc) => (
                                <li
                                    key={doc.documentId}
                                    className="flex items-center justify-between gap-3 px-3 py-2.5 bg-surface/30 hover:bg-surface-2/40"
                                >
                                    <div className="min-w-0 flex-1">
                                        <p className="text-xs font-semibold text-foreground truncate">
                                            {hrGeneratedDocLabel(doc)}
                                        </p>
                                        <p className="text-[10px] text-foreground-muted">{formatWhen(doc.createdAt)}</p>
                                    </div>
                                    <div className="flex items-center gap-2 shrink-0">
                                        <a
                                            href={generatedPreviewHref(doc.documentId)}
                                            target="_blank"
                                            rel="noopener noreferrer"
                                            className="inline-flex items-center gap-1 rounded-lg border border-border px-2 py-1 text-[10px] font-semibold hover:bg-surface-2"
                                        >
                                            <ExternalLink size={11} /> Open
                                        </a>
                                        <a
                                            href={getDocumentDownloadUrl(doc.documentId)}
                                            className="inline-flex items-center gap-1 rounded-lg border border-border px-2 py-1 text-[10px] font-semibold hover:bg-surface-2"
                                        >
                                            <Download size={11} /> Save
                                        </a>
                                    </div>
                                </li>
                            ))}
                        </ul>
                    )}
                </div>

                {shortlist.length > 0 ? (
                    <AgentHrShortlistTable
                        rows={shortlist}
                        accent={accent}
                        maxRows={8}
                        onOpenOutreach={onOpenOutreach}
                        onExportPdf={() => void handleGenerate("shortlist")}
                        exporting={generatingId === "shortlist"}
                        onAsk={onRunInChat}
                    />
                ) : (
                    <div className="rounded-2xl border border-dashed border-border px-4 py-8 text-center">
                        <p className="text-sm font-semibold text-foreground">No CV shortlist yet</p>
                        <p className="text-xs text-foreground-muted mt-1 max-w-md mx-auto">
                            Upload resumes to your portfolio, wait for CV scores, then generate a shortlist PDF or open outreach.
                        </p>
                        <div className="flex flex-wrap justify-center gap-2 mt-4">
                            <Link
                                href="/documents"
                                className="inline-flex items-center rounded-lg px-3 py-2 text-xs font-semibold text-white"
                                style={{ backgroundColor: accent }}
                            >
                                Upload CVs
                            </Link>
                            {onRunInChat && (
                                <button
                                    type="button"
                                    onClick={() => onRunInChat("Show CV score ranking")}
                                    className="inline-flex items-center rounded-lg border border-border px-3 py-2 text-xs font-semibold hover:bg-surface-2"
                                >
                                    Run CV ranking
                                </button>
                            )}
                        </div>
                    </div>
                )}
            </div>
        </section>
    );
}
