"use client";

import React, { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { AlertTriangle, Download, FileText, Loader2, RefreshCw, Send, Star, Trash2 } from "lucide-react";
import { apiRequest } from "@/lib/apiClient";
import { inferDocTypeFromFilename } from "@/lib/documentAgents";
import { appendAuthToken, getDocumentAiImageUrl } from "@/lib/documents";
import SendToIntegrationModal from "@/components/SendToIntegrationModal";
type DocRecord = {
    documentId: string;
    originalFilename: string;
    mimeType?: string;
    sizeBytes: number;
    status: string;
    storagePath?: string;
    pythonDocumentId?: string | null;
    classification?: string | null;
    pageCount?: number;
    createdAt: string;
    metadata?: {
        cvScore?: number;
        phase3Agent?: string;
        generatedFromDocumentId?: string;
        generatedFromFilename?: string;
    } | null;
};

type SimilarHit = {
    document_id?: string;
    document_title?: string;
    score?: number;
    nodeDocumentId?: string | null;
    previewDocumentId?: string | null;
};

type ImageItem = {
    page?: number;
    image_path?: string;
    description?: string;
};

function scoreColor(score: number) {
    if (score >= 70) return "bg-emerald-500/15 text-emerald-300 border-emerald-500/25";
    if (score >= 40) return "bg-amber-500/15 text-amber-300 border-amber-500/25";
    return "bg-red-500/15 text-red-300 border-red-500/25";
}

function barColor(pct: number) {
    if (pct >= 70) return "bg-emerald-500";
    if (pct >= 40) return "bg-amber-500";
    return "bg-red-500";
}

function statusBadgeClass(status: string) {
    const s = status.toLowerCase();
    if (s === "ready" || s === "processed") return "bg-green-500/15 text-green-300 border-green-500/25";
    if (s === "failed" || s === "error") return "bg-red-500/15 text-red-300 border-red-500/25";
    if (s === "processing" || s === "uploaded") return "bg-amber-500/15 text-amber-300 border-amber-500/25";
    return "bg-slate-500/15 text-slate-300 border-slate-500/25";
}

function typeBadgeClass(docType: string) {
    const t = docType.toLowerCase();
    if (t === "resume" || t === "cv") return "bg-blue-500/15 text-(--vb-blue-bright) border-[rgba(56,182,255,0.25)]";
    if (t === "invoice") return "bg-accent-muted text-accent border-[rgba(56,182,255,0.25)]";
    if (t === "contract") return "bg-[rgba(56,182,255,0.15)] text-(--vb-blue-bright) border-[rgba(56,182,255,0.25)]";
    return "bg-slate-500/15 text-slate-300 border-slate-500/25";
}

function statusLabel(status: string) {
    if (status === "ready") return "processed";
    if (status === "uploaded") return "processing";
    return status;
}

function formatBytes(n: number) {
    if (!n) return "—";
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
    return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function hasModelData(ai?: Record<string, unknown> | null) {
    if (!ai) return false;
    if (ai.cv_score != null) return true;
    if (ai.cv_extraction_data && typeof ai.cv_extraction_data === "object") return true;
    if (ai.extracted_data && typeof ai.extracted_data === "object" && Object.keys(ai.extracted_data as object).length) return true;
    if (typeof ai.raw_text === "string" && ai.raw_text.length > 50) return true;
    return false;
}

function isAnalysisFinished(
    ai?: Record<string, unknown> | null,
    job?: Record<string, unknown> | null,
    docStatus?: string
) {
    const aiStatus = String(ai?.status || "").toLowerCase();
    if (["processed", "ready", "completed", "failed", "error"].includes(aiStatus)) return true;
    if (docStatus === "ready" || docStatus === "failed") return true;
    const jobStatus = String(job?.status || "").toLowerCase();
    const jobStage = String(job?.stage || "").toLowerCase();
    if (jobStatus === "completed" || jobStatus === "failed") return true;
    if (jobStage === "completed") return true;
    return false;
}

function DetailSkeleton() {
    return (
        <div className="space-y-5 w-full max-w-4xl animate-fade-in-up">
            <div className="space-y-3">
                <div className="h-8 w-2/3 max-w-md rounded-lg bg-white/5 animate-shimmer" />
                <div className="flex gap-2">
                    <div className="h-6 w-16 rounded-full bg-white/5 animate-shimmer" />
                    <div className="h-6 w-20 rounded-full bg-white/5 animate-shimmer" />
                    <div className="h-6 w-14 rounded-full bg-white/5 animate-shimmer" />
                </div>
            </div>
            <div className="surface-card rounded-xl! overflow-hidden min-h-[50vh]">
                <div className="px-5 py-4 border-b border-border flex items-center gap-2">
                    <div className="h-4 w-4 rounded bg-amber-400/30 animate-pulse" />
                    <div className="h-4 w-32 rounded bg-white/5 animate-shimmer" />
                    <div className="ml-auto h-6 w-24 rounded-full bg-white/5 animate-shimmer" />
                </div>
                <div className="p-5 sm:p-6 space-y-5">
                    {[1, 2, 3, 4].map((i) => (
                        <div key={i} className="space-y-2">
                            <div className="flex justify-between">
                                <div className="h-3 w-24 rounded bg-white/5 animate-shimmer" />
                                <div className="h-3 w-12 rounded bg-white/5 animate-shimmer" />
                            </div>
                            <div className="h-2.5 w-full rounded-full bg-white/5 overflow-hidden">
                                <div
                                    className="h-full rounded-full bg-linear-to-r from-[rgba(56,182,255,0.3)] via-[rgba(126,224,255,0.5)] to-[rgba(56,182,255,0.3)] animate-shimmer"
                                    style={{ width: `${55 + i * 8}%` }}
                                />
                            </div>
                        </div>
                    ))}
                    <div className="pt-2 space-y-2">
                        <div className="h-3 w-20 rounded bg-white/5 animate-shimmer" />
                        <div className="flex flex-wrap gap-2">
                            {[1, 2, 3].map((i) => (
                                <div key={i} className="h-7 w-20 rounded-lg bg-white/5 animate-shimmer" />
                            ))}
                        </div>
                    </div>
                </div>
            </div>
            <p className="text-center text-xs text-foreground-muted flex items-center justify-center gap-2">
                <Loader2 size={12} className="animate-spin text-accent" />
                Loading evaluation…
            </p>
        </div>
    );
}

export default function DocumentDetailPanel({
    doc,
    ai,
    colors,
    onDelete,
    showDelete = false,
    analyzing = false,
    allowReprocess,
    onReprocessDone,
}: {
    doc: DocRecord;
    ai?: Record<string, unknown> | null;
    isDark?: boolean;
    colors: { textMuted: string; textPrimary: string };
    onDelete?: () => void;
    showDelete?: boolean;
    analyzing?: boolean;
    allowReprocess?: boolean;
    onReprocessDone?: () => void;
}) {
    const [descFileUrl, setDescFileUrl] = useState("");
    const [images, setImages] = useState<ImageItem[]>([]);
    const [similar, setSimilar] = useState<SimilarHit[]>([]);
    const [reclassifying, setReclassifying] = useState(false);
    const [reprocessMsg, setReprocessMsg] = useState<string | null>(null);
    const [sendOpen, setSendOpen] = useState(false);
    const [sendMsg, setSendMsg] = useState<string | null>(null);
    const router = useRouter();

    const inferredType = inferDocTypeFromFilename(doc.originalFilename);
    const docType = String(ai?.document_type || doc.classification || inferredType || "unknown");
    const cvScore = Number(ai?.cv_score ?? doc.metadata?.cvScore ?? NaN);
    const cvData = (ai?.cv_extraction_data || null) as Record<string, unknown> | null;
    const rawText = typeof ai?.raw_text === "string" ? ai.raw_text : "";
    const extracted = (ai?.extracted_data || null) as Record<string, unknown> | null;
    const extractions = Array.isArray(ai?.extractions) ? (ai?.extractions as Array<Record<string, unknown>>) : [];
    const tableExtractions = extractions.filter((ext) => String(ext?.extraction_type || "") === "table_extraction");
    // The AI backend computes a confidence score per extraction (LLM self-reported
    // + a heuristic blend) but nothing has surfaced it to a user before this —
    // it was computed, stored, and never shown. Average the non-classification
    // rows (the ones that produced `extracted`) as a document-level signal.
    const dataConfidences = extractions
        .filter((ext) => String(ext?.extraction_type || "") !== "classification" && typeof ext?.confidence === "number")
        .map((ext) => ext.confidence as number);
    const extractionConfidence = dataConfidences.length
        ? dataConfidences.reduce((a, b) => a + b, 0) / dataConfidences.length
        : null;
    const displayStatus = statusLabel(String(ai?.status || doc.status));
    const finished = isAnalysisFinished(ai, undefined, doc.status);
    const canReprocess =
        allowReprocess !== undefined
            ? allowReprocess
            : finished && (doc.status === "ready" || doc.status === "failed" || !!doc.pythonDocumentId);

    const downloadTablesMarkdown = () => {
        const parts = tableExtractions.map((table, index) => {
            const extractedData = table?.extracted_data as Record<string, unknown> | null;
            const tableText = typeof extractedData?.table_text === "string" ? extractedData.table_text : "";
            return `## Table ${index + 1}\n\n${tableText || "No markdown available."}`;
        });
        const blob = new Blob([parts.join("\n\n")], { type: "text/markdown;charset=utf-8" });
        const url = URL.createObjectURL(blob);
        const anchor = document.createElement("a");
        anchor.href = url;
        anchor.download = `${doc.originalFilename.replace(/[^\w-]+/g, "_")}_tables.md`;
        document.body.appendChild(anchor);
        anchor.click();
        document.body.removeChild(anchor);
        URL.revokeObjectURL(url);
    };
    const isProcessing = analyzing && !finished && (displayStatus === "processing" || doc.status === "processing");
    const showCv = docType === "resume" || inferredType === "resume";
    const filenameLooksLikeCv = /\b(cv|cvs|resume|curriculum|biodata|bio[\s_-]?data)\b/i.test(
        doc.originalFilename || ""
    );
    const isOfferLetterDoc =
        docType === "offer_letter" ||
        String(doc.classification || "").toLowerCase() === "offer_letter" ||
        /\boffer[\s_-]?letter\b/i.test(doc.originalFilename || "");
    const isExperienceLetterDoc =
        docType === "experience_letter" ||
        String(doc.classification || "").toLowerCase() === "experience_letter" ||
        /\bexperience[\s_-]?letter\b/i.test(doc.originalFilename || "");
    const canGenerateOffer = showCv || filenameLooksLikeCv;
    const showSkeleton = isProcessing || (analyzing && !hasModelData(ai));

    useEffect(() => {
        if (!doc.documentId) {
            setDescFileUrl("");
            setImages([]);
            setSimilar([]);
            return;
        }
        let cancelled = false;
        apiRequest(`/docs/documents/${doc.documentId}/images`)
            .then((d) => {
                if (cancelled) return;
                setDescFileUrl(d?.data?.descriptions_file || "");
                setImages(Array.isArray(d?.data?.images) ? d.data.images : []);
            })
            .catch(() => {
                if (!cancelled) {
                    setDescFileUrl("");
                    setImages([]);
                }
            });
        apiRequest(`/docs/documents/${doc.documentId}/similar?limit=5`)
            .then((d) => {
                if (cancelled) return;
                const results = Array.isArray(d?.data?.results) ? d.data.results : [];
                setSimilar(results.slice(0, 5));
            })
            .catch(() => {
                if (!cancelled) setSimilar([]);
            });
        return () => {
            cancelled = true;
        };
    }, [doc.documentId]);

    const reclassify = async () => {
        setReclassifying(true);
        setReprocessMsg(null);
        try {
            await apiRequest(`/docs/documents/${doc.documentId}/reprocess`, { method: "POST" });
            setReprocessMsg("Reclassification started — refresh in a few seconds");
            onReprocessDone?.();
        } catch (e: any) {
            setReprocessMsg(e?.message || "Reclassification failed");
        } finally {
            setReclassifying(false);
        }
    };

    const cardClass = "surface-card rounded-xl!";

    if (showSkeleton) {
        return <DetailSkeleton />;
    }

    const pageCount = doc.pageCount ?? (typeof ai?.page_count === "number" ? Number(ai.page_count) : undefined);

    return (
        <div className="space-y-5 w-full max-w-4xl animate-fade-in-up">
            <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                    <h2 className={`text-xl sm:text-2xl font-bold tracking-tight break-all ${colors.textPrimary}`}>{doc.originalFilename}</h2>
                    <div className="flex flex-wrap gap-2 mt-2">
                        <span className={`inline-flex px-2.5 py-0.5 rounded-full text-xs font-semibold border ${typeBadgeClass(docType)}`}>
                            {docType}
                        </span>
                        <span className={`inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-semibold border ${statusBadgeClass(displayStatus)}`}>
                            {displayStatus}
                        </span>
                        {showCv && !Number.isNaN(cvScore) && (
                            <span className={`inline-flex px-2.5 py-0.5 rounded-full text-xs font-semibold border ${scoreColor(cvScore)}`}>
                                Score: {cvScore}/100
                            </span>
                        )}
                    </div>
                </div>
                {showDelete && onDelete && (
                    <button type="button" onClick={onDelete} className="btn-ghost rounded-lg px-2 py-2 text-red-300 hover:bg-red-500/10 shrink-0 min-h-11 min-w-11 flex items-center justify-center" title="Delete">
                        <Trash2 size={16} />
                    </button>
                )}
            </div>

            <div className="grid grid-cols-3 gap-2 sm:gap-3">
                {[
                    ["Pages", pageCount != null ? String(pageCount) : "—"],
                    ["Size", formatBytes(doc.sizeBytes)],
                    ["Created", doc.createdAt ? new Date(doc.createdAt).toLocaleDateString() : "—"],
                ].map(([label, value]) => (
                    <div key={label} className={`${cardClass} rounded-xl! px-3 py-2.5 sm:px-4 sm:py-3`}>
                        <p className={`text-[10px] font-semibold uppercase tracking-wider ${colors.textMuted}`}>{label}</p>
                        <p className={`text-sm font-semibold mt-0.5 truncate ${colors.textPrimary}`}>{value}</p>
                    </div>
                ))}
            </div>

            {doc.metadata?.generatedFromDocumentId && (
                <div className="surface-card px-4 py-3 text-sm border border-[rgba(56,182,255,0.25)] rounded-xl">
                    <span className={colors.textMuted}>Created from resume: </span>
                    <Link
                        href={`/documents/${doc.metadata.generatedFromDocumentId}/details`}
                        className="text-(--vb-blue-bright) font-medium hover:underline"
                    >
                        {doc.metadata.generatedFromFilename || doc.metadata.generatedFromDocumentId}
                    </Link>
                </div>
            )}

            <div className="flex flex-wrap items-center gap-2">
                {isOfferLetterDoc && finished && (
                    <Link
                        href={`/documents/${doc.documentId}`}
                        className="btn-gradient rounded-xl px-4 py-2 text-sm inline-flex items-center gap-2"
                    >
                        <FileText size={14} />
                        Offer letter
                    </Link>
                )}
                {isExperienceLetterDoc && finished && (
                    <Link
                        href={`/documents/${doc.documentId}`}
                        className="btn-gradient rounded-xl px-4 py-2 text-sm inline-flex items-center gap-2"
                    >
                        <FileText size={14} />
                        Experience letter
                    </Link>
                )}
                <button
                    type="button"
                    onClick={() => setSendOpen(true)}
                    className="btn-gradient rounded-xl px-4 py-2 text-sm inline-flex items-center gap-2"
                >
                    <Send size={14} />
                    Send to integration
                </button>
                {canGenerateOffer && finished && doc.pythonDocumentId && (
                    <>
                    <button
                        type="button"
                        onClick={() => router.push(`/documents/${doc.documentId}/offer-letter`)}
                        className="btn-secondary rounded-xl px-4 py-2 text-sm inline-flex items-center gap-2"
                    >
                        <FileText size={14} />
                        Generate offer letter
                    </button>
                    <button
                        type="button"
                        onClick={() => router.push(`/documents/${doc.documentId}/experience-letter`)}
                        className="btn-secondary rounded-xl px-4 py-2 text-sm inline-flex items-center gap-2"
                    >
                        <FileText size={14} />
                        Experience letter
                    </button>
                    </>
                )}
                {canReprocess && !(canGenerateOffer && finished) && (
                    <button
                        type="button"
                        onClick={reclassify}
                        disabled={reclassifying}
                        className="btn-secondary rounded-xl px-4 py-2 text-sm inline-flex items-center gap-2 disabled:opacity-50"
                    >
                        {reclassifying ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
                        {reclassifying ? "Reclassifying…" : "Reclassify with AI"}
                    </button>
                )}
                {(reprocessMsg || sendMsg) && (
                    <span
                        className={`text-xs ${
                            (reprocessMsg || sendMsg || "").toLowerCase().includes("fail")
                                ? "text-rose-400"
                                : "text-(--vb-blue-bright)"
                        }`}
                    >
                        {sendMsg || reprocessMsg}
                    </span>
                )}
            </div>

            <SendToIntegrationModal
                open={sendOpen}
                onClose={() => setSendOpen(false)}
                documentIds={[doc.documentId]}
                filename={doc.originalFilename}
                onSent={(msg) => {
                    setSendMsg(msg);
                    setSendOpen(false);
                }}
            />

            {finished && !hasModelData(ai) && (
                <div className="surface-card px-4 py-3 text-sm text-foreground-secondary border border-border">
                    Analysis finished but scores are not available yet. Try re-opening this document in a moment.
                </div>
            )}

            {rawText && (
                <details className={`${cardClass} overflow-hidden group`}>
                    <summary className={`px-5 py-4 text-sm font-semibold cursor-pointer list-none flex items-center justify-between gap-3 ${colors.textPrimary}`}>
                        <span>OCR Preview ({rawText.length.toLocaleString()} chars)</span>
                        <span className="flex items-center gap-3 shrink-0">
                            {descFileUrl && (
                                <a
                                    href={appendAuthToken(
                                        descFileUrl.startsWith("http")
                                            ? descFileUrl
                                            : `${process.env.NEXT_PUBLIC_API_URL || "http://localhost:5100/api"}${descFileUrl.replace(/^\/api/, "")}`
                                    )}
                                    target="_blank"
                                    rel="noreferrer"
                                    onClick={(e) => e.stopPropagation()}
                                    className="text-xs font-medium text-accent hover:underline"
                                >
                                    Download All Descriptions
                                </a>
                            )}
                            <span className="text-foreground-muted text-xs group-open:rotate-180 transition-transform">▼</span>
                        </span>
                    </summary>
                    <div className={`max-h-96 overflow-y-auto px-5 pb-5 text-xs font-mono leading-relaxed whitespace-pre-wrap border-t border-border pt-4 ${colors.textMuted}`}>
                        {rawText.slice(0, 10000)}
                        {rawText.length > 10000 && "…"}
                    </div>
                </details>
            )}

            {images.length > 0 && (
                <details className={`${cardClass} overflow-hidden group`}>
                    <summary className={`px-5 py-4 text-sm font-semibold cursor-pointer list-none flex items-center justify-between gap-3 ${colors.textPrimary}`}>
                        <span>Image Previews ({images.length})</span>
                        <span className="text-foreground-muted text-xs group-open:rotate-180 transition-transform">▼</span>
                    </summary>
                    <div className="divide-y divide-border border-t border-border">
                        {images.map((img, i) => {
                            const src = img.image_path
                                ? getDocumentAiImageUrl(doc.documentId, img.image_path)
                                : "";
                            return (
                                <div key={i} className="p-4 sm:p-5">
                                    <p className={`text-xs font-medium mb-2 ${colors.textMuted}`}>
                                        Page {img.page ?? i + 1}
                                    </p>
                                    {src && (
                                        // eslint-disable-next-line @next/next/no-img-element
                                        <img
                                            src={src}
                                            alt={`Page ${img.page ?? i + 1}`}
                                            className="max-h-48 rounded-lg border border-border mb-2 object-contain bg-white/5"
                                        />
                                    )}
                                    {img.description && (
                                        <p className={`text-xs leading-relaxed ${colors.textMuted}`}>{img.description}</p>
                                    )}
                                </div>
                            );
                        })}
                    </div>
                </details>
            )}

            {showCv && cvData && (
                <div className={`${cardClass} overflow-hidden min-h-[60vh]`}>
                    <div className={`px-5 py-4 flex items-center gap-2 border-b border-border ${colors.textPrimary}`}>
                        <Star size={16} className="text-amber-400" />
                        <span className="text-base font-semibold">CV Evaluation</span>
                        {!Number.isNaN(cvScore) && (
                            <span className={`ml-auto inline-flex px-2.5 py-1 rounded-full text-xs font-semibold border ${scoreColor(cvScore)}`}>
                                Score: {cvScore}/100
                            </span>
                        )}
                    </div>
                    <div className="p-5 sm:p-6 space-y-5">
                        {(["skills_score", "experience_score", "education_score", "completeness_score"] as const).map((key) => {
                            const val = cvData[key];
                            if (val == null) return null;
                            const pct = Math.min(100, Math.max(0, Number(val)));
                            return (
                                <div key={key}>
                                    <div className={`flex justify-between text-sm mb-2 ${colors.textMuted}`}>
                                        <span className="capitalize font-medium">{key.replace(/_score$/, "")} Score</span>
                                        <span className="font-mono tabular-nums">{pct}/100</span>
                                    </div>
                                    <div className="w-full h-2.5 bg-white/10 rounded-full overflow-hidden">
                                        <div
                                            className={`h-full rounded-full transition-all duration-700 ease-out ${barColor(pct)}`}
                                            style={{ width: `${pct}%` }}
                                        />
                                    </div>
                                </div>
                            );
                        })}

                        {Array.isArray(cvData.strengths) && cvData.strengths.length > 0 && (
                            <div>
                                <p className={`text-sm font-semibold mb-2 ${colors.textPrimary}`}>Strengths</p>
                                <div className="flex flex-wrap gap-2">
                                    {(cvData.strengths as string[]).map((s, i) => (
                                        <span key={i} className="px-3 py-1.5 rounded-lg bg-emerald-500/10 text-emerald-300 text-sm border border-emerald-500/20">
                                            {s}
                                        </span>
                                    ))}
                                </div>
                            </div>
                        )}

                        {Array.isArray(cvData.areas_for_improvement) && cvData.areas_for_improvement.length > 0 && (
                            <div>
                                <p className={`text-sm font-semibold mb-2 ${colors.textPrimary}`}>Areas for Improvement</p>
                                <div className="flex flex-wrap gap-2">
                                    {(cvData.areas_for_improvement as string[]).map((a, i) => (
                                        <span key={i} className="px-3 py-1.5 rounded-lg bg-amber-500/10 text-amber-300 text-sm border border-amber-500/20">
                                            {a}
                                        </span>
                                    ))}
                                </div>
                            </div>
                        )}

                        {typeof cvData.recommendation === "string" && cvData.recommendation && (
                            <div>
                                <p className={`text-sm font-semibold mb-2 ${colors.textPrimary}`}>Recommendation</p>
                                <p className={`text-sm rounded-xl p-4 bg-accent-muted border border-[rgba(56,182,255,0.2)] ${colors.textPrimary} leading-relaxed`}>
                                    {cvData.recommendation}
                                </p>
                            </div>
                        )}

                        {typeof cvData.evaluation_summary === "string" && cvData.evaluation_summary && (
                            <div>
                                <p className={`text-sm font-semibold mb-2 ${colors.textPrimary}`}>Evaluation Summary</p>
                                <p className={`text-sm rounded-xl p-4 bg-white/3 border border-border ${colors.textMuted} leading-relaxed`}>
                                    {cvData.evaluation_summary}
                                </p>
                            </div>
                        )}
                    </div>
                </div>
            )}

            {tableExtractions.length > 0 && (
                <div className={`${cardClass} p-5`}>
                    <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
                        <p className={`text-sm font-semibold ${colors.textPrimary}`}>Extracted Tables</p>
                        <button
                            type="button"
                            onClick={downloadTablesMarkdown}
                            className="inline-flex items-center gap-2 rounded-full border border-border bg-surface px-3 py-2 text-xs font-semibold text-foreground transition hover:border-accent hover:text-accent"
                        >
                            <Download size={14} />
                            Download Markdown
                        </button>
                    </div>
                    <div className="space-y-6">
                        {tableExtractions.map((table, index) => {
                            const extractedData = table?.extracted_data as Record<string, unknown> | null;
                            const tableText = typeof extractedData?.table_text === "string" ? extractedData.table_text : "";
                            const tableCount = Number(extractedData?.table_count ?? 0);
                            const page = extractedData?.tables && Array.isArray(extractedData.tables) && extractedData.tables[index]?.page;
                            const source = typeof extractedData?.tables === "object" && Array.isArray(extractedData.tables) && extractedData.tables[index]?.source ? String(extractedData.tables[index].source) : undefined;

                            return (
                                <div key={index} className="rounded-2xl border border-border bg-surface p-4">
                                    <div className="flex flex-wrap items-center gap-2 mb-3">
                                        <span className="text-sm font-semibold">Table extraction #{index + 1}</span>
                                        <span className="text-xs text-foreground-muted">count: {tableCount}</span>
                                        {page != null && <span className="text-xs text-foreground-muted">page: {page}</span>}
                                        {source && <span className="text-xs text-foreground-muted">source: {source}</span>}
                                    </div>
                                    {tableText ? (
                                        <pre className={`text-xs overflow-x-auto max-h-[40vh] font-mono whitespace-pre-wrap ${colors.textMuted}`}>
                                            {tableText}
                                        </pre>
                                    ) : (
                                        <div className="text-sm text-foreground-muted">No table markdown available.</div>
                                    )}
                                </div>
                            );
                        })}
                    </div>
                </div>
            )}

            {extracted && Object.keys(extracted).length > 0 && !showCv && (
                <div className={`${cardClass} p-5 min-h-[40vh]`}>
                    <div className="flex items-center justify-between gap-3 mb-3 flex-wrap">
                        <p className={`text-sm font-semibold ${colors.textPrimary}`}>Extracted Data</p>
                        {extractionConfidence != null && (
                            <span
                                title="AI-estimated confidence in the extracted field values. Low confidence means the model wasn't sure — verify these fields before relying on them."
                                className={`inline-flex items-center gap-1.5 text-xs font-medium px-2.5 py-1 rounded-full border ${
                                    extractionConfidence >= 0.75
                                        ? "bg-emerald-500/10 text-emerald-400 border-emerald-500/30"
                                        : extractionConfidence >= 0.5
                                          ? "bg-amber-500/10 text-amber-400 border-amber-500/30"
                                          : "bg-rose-500/10 text-rose-400 border-rose-500/30"
                                }`}
                            >
                                {extractionConfidence < 0.5 && <AlertTriangle size={12} />}
                                {Math.round(extractionConfidence * 100)}% extraction confidence
                            </span>
                        )}
                    </div>
                    <pre className={`text-xs overflow-x-auto max-h-[60vh] font-mono ${colors.textMuted}`}>{JSON.stringify(extracted, null, 2)}</pre>
                </div>
            )}

            {showCv && !cvData && finished && (
                <div className="surface-card px-5 py-8 text-center text-sm text-foreground-muted">
                    No CV evaluation data available for this document.
                </div>
            )}

            {similar.length > 0 && (
                <div>
                    <h3 className={`text-sm font-semibold mb-3 ${colors.textPrimary}`}>Similar Documents</h3>
                    <div className="space-y-2">
                        {similar.map((s, i) => {
                            const targetId = s.nodeDocumentId || s.previewDocumentId || "";
                            const title = s.document_title || s.document_id?.slice(0, 12) || "Document";
                            const pct = s.score != null ? `${Math.round(Number(s.score) * 100)}% match` : "";
                            const rowClass = `${cardClass} rounded-xl! px-4 py-3 flex items-center justify-between gap-3 transition-colors hover:border-[rgba(56,182,255,0.35)]`;
                            if (targetId) {
                                return (
                                    <Link key={i} href={`/documents/details?doc=${targetId}`} className={rowClass}>
                                        <span className={`text-sm truncate ${colors.textPrimary}`}>{title}</span>
                                        {pct && <span className={`text-xs shrink-0 text-(--vb-blue-bright)`}>{pct}</span>}
                                    </Link>
                                );
                            }
                            return (
                                <div key={i} className={rowClass}>
                                    <span className={`text-sm truncate ${colors.textPrimary}`}>{title}</span>
                                    {pct && <span className={`text-xs shrink-0 ${colors.textMuted}`}>{pct}</span>}
                                </div>
                            );
                        })}
                    </div>
                </div>
            )}
        </div>
    );
}

export { hasModelData, isAnalysisFinished };
