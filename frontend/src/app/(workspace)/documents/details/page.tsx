"use client";

import React, { Suspense, useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import DocumentDetailPanel, { hasModelData, isAnalysisFinished } from "@/components/DocumentDetailPanel";
import { useTheme } from "@/context/ColorContext";
import { apiRequest } from "@/lib/apiClient";
import { usePermissions } from "@/context/PermissionsContext";
import { isGeneratedArtifactDoc } from "@/lib/generatedDocuments";

type DocRecord = {
    documentId: string;
    originalFilename: string;
    mimeType: string;
    sizeBytes: number;
    status: string;
    storagePath?: string;
    pythonDocumentId?: string | null;
    aiProcessingStatus?: string | null;
    aiErrorMessage?: string | null;
    classification?: string | null;
    pageCount?: number;
    createdAt: string;
    metadata?: { cvScore?: number; phase3Agent?: string; generatedVia?: string; source?: string } | null;
};

type DocIntel = {
    document: DocRecord;
    aiDocument?: Record<string, unknown> | null;
    job?: Record<string, unknown> | null;
    validations?: unknown[];
};

function DetailsWorkspace() {
    const { theme } = useTheme();
    const colors = theme.colors;
    const isDark = theme.name === "dark";
    const router = useRouter();
    const { canViewDocs, canDeleteDocs } = usePermissions();
    const searchParams = useSearchParams();
    const docParam = searchParams.get("doc");

    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [selected, setSelected] = useState<DocIntel | null>(null);
    const [analyzing, setAnalyzing] = useState(false);
    const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
    const attemptedRunRef = useRef<Set<string>>(new Set());

    const stopPolling = useCallback(() => {
        if (pollRef.current) {
            clearInterval(pollRef.current);
            pollRef.current = null;
        }
    }, []);

    const applyIntel = useCallback((data: Record<string, unknown>) => {
        setSelected((prev) => {
            if (!prev) {
                const doc = data.document as DocRecord | undefined;
                if (!doc?.documentId) return prev;
                return {
                    document: doc,
                    aiDocument: (data.aiDocument as Record<string, unknown> | null) ?? null,
                    job: (data.job as Record<string, unknown> | null) ?? null,
                    validations: (data.validations as unknown[]) ?? [],
                };
            }
            return {
                document: (data.document as DocRecord) || prev.document,
                aiDocument: (data.aiDocument as Record<string, unknown> | null) ?? prev.aiDocument,
                job: (data.job as Record<string, unknown> | null) ?? prev.job,
                validations: (data.validations as unknown[]) ?? prev.validations,
            };
        });
    }, []);

    const fetchIntelligence = useCallback(
        async (id: string) => {
            const intel = await apiRequest(`/docs/documents/${id}/intelligence`);
            if (intel?.data) applyIntel(intel.data);
            return intel?.data;
        },
        [applyIntel]
    );

    const startPolling = useCallback(
        (id: string) => {
            stopPolling();
            let attempts = 0;
            pollRef.current = setInterval(async () => {
                attempts += 1;
                try {
                    const data = await fetchIntelligence(id);
                    const ai = data?.aiDocument as Record<string, unknown> | null;
                    const job = data?.job as Record<string, unknown> | null;
                    const docStatus = (data?.document as { status?: string } | undefined)?.status;
                    if (hasModelData(ai) || isAnalysisFinished(ai, job, docStatus)) {
                        stopPolling();
                        setAnalyzing(false);
                    } else if (attempts >= 60) {
                        stopPolling();
                        setAnalyzing(false);
                    }
                } catch {
                    if (attempts >= 60) {
                        stopPolling();
                        setAnalyzing(false);
                    }
                }
            }, 4000);
        },
        [fetchIntelligence, stopPolling]
    );

    const runModelIfNeeded = useCallback(
        async (
            id: string,
            ai?: Record<string, unknown> | null,
            job?: Record<string, unknown> | null,
            docStatus?: string,
            doc?: DocRecord | null
        ) => {
            // Generated reports/letters are already complete PDFs — never kick off AI reprocess.
            if (isGeneratedArtifactDoc(doc)) return false;
            if (hasModelData(ai) || isAnalysisFinished(ai, job, docStatus)) return false;
            if (attemptedRunRef.current.has(id)) return false;
            // Don't re-trigger if AI already processing
            const stage = String(job?.stage || job?.status || "").toLowerCase();
            const aiStatus = String(ai?.status || "").toLowerCase();
            if (
                ["queued", "running", "processing", "ocr_processing", "classifying", "extracting", "embedding"].some(
                    (s) => stage.includes(s) || aiStatus.includes(s)
                ) ||
                docStatus === "processing" ||
                docStatus === "uploaded"
            ) {
                attemptedRunRef.current.add(id);
                setAnalyzing(true);
                startPolling(id);
                return false;
            }
            attemptedRunRef.current.add(id);
            setAnalyzing(true);
            try {
                await apiRequest(`/docs/documents/${id}/processing?runModel=true`);
            } catch {
                /* processing endpoint may still have triggered */
            }
            startPolling(id);
            return true;
        },
        [startPolling]
    );

    const loadDoc = useCallback(
        async (id: string) => {
            setLoading(true);
            setError(null);
            stopPolling();
            setAnalyzing(false);
            try {
                const data = await fetchIntelligence(id);
                const ai = data?.aiDocument as Record<string, unknown> | null;
                const job = data?.job as Record<string, unknown> | null;
                const document = data?.document as DocRecord | undefined;
                const docStatus = document?.status;

                if (!document) {
                    setSelected(null);
                    setError("Document not found");
                    return;
                }

                if (isGeneratedArtifactDoc(document)) {
                    return;
                }

                if (!hasModelData(ai) && !isAnalysisFinished(ai, job, docStatus)) {
                    const started = await runModelIfNeeded(id, ai, job, docStatus, document);
                    if (started) return;
                }

                if (hasModelData(ai)) return;

                const jobStage = String(job?.stage || "").toLowerCase();
                const jobStatus = String(job?.status || "").toLowerCase();
                const stillRunning =
                    ["running", "queued"].includes(jobStatus) ||
                    ["ocr_processing", "classifying", "extracting", "embedding", "queued"].includes(jobStage);
                if (stillRunning) {
                    setAnalyzing(true);
                    startPolling(id);
                }
            } catch (e: any) {
                setError(e.message || "Failed to load document");
                setSelected(null);
            } finally {
                setLoading(false);
            }
        },
        [fetchIntelligence, runModelIfNeeded, startPolling, stopPolling]
    );

    useEffect(() => {
        if (!docParam) {
            setLoading(false);
            setSelected(null);
            return;
        }
        attemptedRunRef.current.delete(docParam);
        loadDoc(docParam);
        return () => stopPolling();
    }, [docParam, loadDoc, stopPolling]);

    const handleDelete = async () => {
        if (!selected) return;
        if (!confirm("Delete this document?")) return;
        stopPolling();
        await apiRequest(`/docs/documents/${selected.document.documentId}`, { method: "DELETE" });
        setSelected(null);
        router.replace("/documents", { scroll: false });
    };

    if (!canViewDocs()) {
        return (
            <div className="h-full min-h-0 flex items-center justify-center p-4 sm:p-8">
                <div className={`surface-card max-w-md w-full p-6 text-center space-y-2 ${colors.textPrimary}`}>
                    <p className="text-lg font-semibold">View not available</p>
                    <p className={`text-sm ${colors.textMuted}`}>
                        You do not have View permission. Ask your admin to enable document access.
                    </p>
                    <Link href="/documents" className="inline-block mt-2 text-sm text-accent hover:underline">
                        Back to documents
                    </Link>
                </div>
            </div>
        );
    }

    return (
        <div className="h-full min-h-0 flex flex-col overflow-hidden">
            <div className="shrink-0 px-4 sm:px-6 lg:px-8 pt-4 sm:pt-5 pb-2">
                <Link
                    href="/documents"
                    className={`inline-flex items-center gap-2 text-sm min-h-11 ${colors.textMuted} hover:text-accent transition-colors`}
                >
                    <ArrowLeft size={14} /> Back to documents
                </Link>
            </div>

            <div className="flex-1 min-h-0 overflow-y-auto bg-linear-to-br from-transparent via-[rgba(56,182,255,0.03)] to-blue-600/[0.05]">
                {error && <div className="px-4 sm:px-6 lg:px-8 text-red-400 text-sm">{error}</div>}

                {!docParam && !loading && (
                    <div className={`h-full flex items-center justify-center ${colors.textMuted}`}>
                        <div className="text-center space-y-2 px-4 sm:px-6">
                            <p className={`text-lg font-medium ${colors.textPrimary}`}>No document selected</p>
                            <p className="text-sm">Open a document from the library to view its details.</p>
                            <Link href="/documents" className="inline-block mt-2 text-sm text-accent hover:underline">
                                Go to documents
                            </Link>
                        </div>
                    </div>
                )}

                {loading && (
                    <div className="p-4 sm:p-6 lg:p-8 h-full flex items-start justify-center">
                        <div className="w-full max-w-4xl space-y-4 animate-fade-in-up">
                            <div className="h-8 w-1/2 rounded-lg bg-white/5 animate-shimmer" />
                            <div className="flex gap-2">
                                <div className="h-6 w-16 rounded-full bg-white/5 animate-shimmer" />
                                <div className="h-6 w-20 rounded-full bg-white/5 animate-shimmer" />
                            </div>
                            <div className="surface-card !rounded-xl p-4 sm:p-6 space-y-4 min-h-[50vh]">
                                {[1, 2, 3, 4].map((i) => (
                                    <div key={i} className="space-y-2">
                                        <div className="h-3 w-28 rounded bg-white/5 animate-shimmer" />
                                        <div className="h-2.5 w-full rounded-full bg-white/5 animate-shimmer" />
                                    </div>
                                ))}
                            </div>
                            <p className="text-center text-xs text-foreground-muted">Loading document details…</p>
                        </div>
                    </div>
                )}

                {!loading && selected && (
                    <div className="p-4 sm:p-6 lg:p-8 pb-10">
                        <DocumentDetailPanel
                            doc={selected.document}
                            ai={selected.aiDocument}
                            isDark={isDark}
                            colors={colors}
                            onDelete={handleDelete}
                            showDelete={canDeleteDocs()}
                            analyzing={analyzing && !isAnalysisFinished(selected.aiDocument, selected.job, selected.document.status)}
                        />
                    </div>
                )}
            </div>
        </div>
    );
}

export default function AllFilesDetailsPage() {
    return (
        <Suspense fallback={<div className="h-full flex items-center justify-center text-sm text-slate-400">Loading…</div>}>
            <DetailsWorkspace />
        </Suspense>
    );
}
