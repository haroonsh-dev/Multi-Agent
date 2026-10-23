"use client";

import React, { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Eye, RefreshCw, Search, FileText, Copy, Filter, Loader2, Info, X } from "lucide-react";
import FilterSelect from "@/components/FilterSelect";
import LibraryPagination from "@/components/LibraryPagination";
import ChatWithDocumentLink from "@/components/ChatWithDocumentLink";
import { shouldShowChatWithDocument } from "@/lib/generatedDocuments";
import { PageHeader, EmptyState } from "@/components/ui";
import { useTheme } from "@/context/ColorContext";
import { apiRequest } from "@/lib/apiClient";
import { FILE_TYPE_MIME, FILE_TYPE_OPTIONS, getFileTypeLabel } from "@/lib/fileValidation";

type DocItem = {
    documentId: string;
    originalFilename: string;
    mimeType?: string;
    sizeBytes: number;
    status: string;
    organizationId?: string;
    uploadedBy: string;
    createdAt: string;
    duplicateCount?: number;
    isDuplicate?: boolean;
    visibilityScope?: "personal" | "department";
    uploaderIsLeader?: boolean;
    classification?: string | null;
    metadata?: { phase3Agent?: string; cvScore?: number } | null;
    aiErrorMessage?: string | null;
    pythonDocumentId?: string | null;
};

type Pagination = { page: number; limit: number; total: number; totalPages: number };

const SORT_PRESETS = [
    { value: "newest", label: "Newest first", sortBy: "createdAt", sortOrder: "desc" },
    { value: "oldest", label: "Oldest first", sortBy: "createdAt", sortOrder: "asc" },
    { value: "score_high", label: "Score: high → low", sortBy: "score", sortOrder: "desc" },
    { value: "score_low", label: "Score: low → high", sortBy: "score", sortOrder: "asc" },
    { value: "name", label: "Name A–Z", sortBy: "name", sortOrder: "asc" },
] as const;

const SCORE_FILTER_OPTIONS = [
    { value: "", label: "All scores" },
    { value: "high", label: "High (70+)" },
    { value: "medium", label: "Medium (40–69)" },
    { value: "low", label: "Low (<40)" },
    { value: "scored", label: "Scored only" },
];

const STATUS_OPTIONS = [
    { value: "", label: "All statuses" },
    { value: "uploaded", label: "Uploaded" },
    { value: "processing", label: "Processing" },
    { value: "ready", label: "Complete" },
    { value: "failed", label: "Failed" },
];

const DUPLICATE_OPTIONS = [
    { value: "", label: "All files" },
    { value: "true", label: "Duplicates only" },
];

function formatBytes(n: number) {
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function statusBadge(status: string) {
    const s = status.toLowerCase();
    if (s === "ready" || s === "processed" || s === "completed" || s === "complete" || s === "done") {
        return "bg-(--success-muted) text-(--success) border-[rgba(52,211,153,0.25)]";
    }
    if (s === "processing" || s === "uploaded" || s === "queued" || s === "uploading") {
        return "bg-(--warning-muted) text-(--warning) border-[rgba(251,191,36,0.25)]";
    }
    if (s === "failed" || s.includes("fail") || s.includes("error")) {
        return "bg-error-muted text-error border-[rgba(248,113,113,0.25)]";
    }
    return "bg-surface-3 text-foreground-muted border-border";
}

const IN_PROGRESS_AI = ["queued", "running", "processing", "ocr", "classify", "extract", "embed", "uploaded", "pending"];

function getDisplayStatus(doc: DocItem): { label: string; isProcessing: boolean; isComplete: boolean } {
    if (doc.status === "failed" || (doc.aiErrorMessage && !doc.metadata?.phase3Agent)) {
        return { label: "Failed", isProcessing: false, isComplete: false };
    }
    if (doc.status === "ready") {
        return { label: "Complete", isProcessing: false, isComplete: true };
    }
    const ai = (doc.status || "").toLowerCase();
    if (ai.includes("fail")) {
        return { label: "Failed", isProcessing: false, isComplete: false };
    }
    if (doc.status === "processing" || doc.status === "uploaded") {
        const inProgress = !ai || IN_PROGRESS_AI.some((s) => ai.includes(s));
        if (inProgress) {
            return { label: "Processing", isProcessing: true, isComplete: false };
        }
    }
    if (doc.status === "uploaded") {
        return { label: "Uploaded", isProcessing: false, isComplete: false };
    }
    return { label: doc.status, isProcessing: false, isComplete: false };
}

function AdminDocumentsContent() {
    const { theme } = useTheme();
    const colors = theme.colors;
    const [docs, setDocs] = useState<DocItem[]>([]);
    const [pagination, setPagination] = useState<Pagination>({ page: 1, limit: 15, total: 0, totalPages: 0 });
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [searchInput, setSearchInput] = useState("");
    const [q, setQ] = useState("");
    const [sortPreset, setSortPreset] = useState<string>("newest");
    const [scoreFilter, setScoreFilter] = useState("");
    const [statusFilter, setStatusFilter] = useState("");
    const [fileTypeFilter, setFileTypeFilter] = useState("");
    const [duplicatesOnly, setDuplicatesOnly] = useState("");
    const [filtersOpen, setFiltersOpen] = useState(false);

    const activeSort = SORT_PRESETS.find((s) => s.value === sortPreset) || SORT_PRESETS[0];
    const hasActiveFilters = Boolean(scoreFilter || statusFilter || fileTypeFilter || duplicatesOnly || sortPreset !== "newest");

    const load = useCallback(async () => {
        setLoading(true);
        setError(null);
        try {
            const params = new URLSearchParams({
                page: String(pagination.page),
                limit: String(pagination.limit),
                sortBy: activeSort.sortBy,
                sortOrder: activeSort.sortOrder,
            });
            if (q) params.set("q", q);
            if (scoreFilter) params.set("scoreFilter", scoreFilter);
            if (statusFilter) params.set("status", statusFilter);
            if (fileTypeFilter && FILE_TYPE_MIME[fileTypeFilter]) {
                params.set("mimeType", FILE_TYPE_MIME[fileTypeFilter]);
            }
            if (duplicatesOnly === "true") params.set("duplicatesOnly", "true");
            const data = await apiRequest(`/docs/super-admin/documents?${params}`);
            setDocs(data?.data?.documents || []);
            setPagination(data?.data?.pagination || { page: pagination.page, limit: pagination.limit, total: 0, totalPages: 0 });
        } catch (e: any) {
            setError(e.message || "Failed to load documents");
        } finally {
            setLoading(false);
        }
    }, [pagination.page, pagination.limit, q, activeSort.sortBy, activeSort.sortOrder, scoreFilter, statusFilter, fileTypeFilter, duplicatesOnly]);

    useEffect(() => { load(); }, [load]);

    const applySearch = () => {
        setQ(searchInput);
        setPagination((prev) => ({ ...prev, page: 1 }));
    };

    const clearFilters = () => {
        setSearchInput("");
        setQ("");
        setScoreFilter("");
        setStatusFilter("");
        setFileTypeFilter("");
        setDuplicatesOnly("");
        setSortPreset("newest");
        setPagination((prev) => ({ ...prev, page: 1 }));
    };

    const remove = async (id: string) => {
        if (!confirm("Delete this document permanently?")) return;
        try {
            await apiRequest(`/docs/documents/${id}`, { method: "DELETE" });
            await load();
        } catch (e: any) {
            setError(e.message || "Delete failed");
        }
    };

    return (
        <div className="p-4 sm:p-6 lg:p-8 max-w-6xl mx-auto space-y-6 animate-fade-in-up">
            <PageHeader title="Document Vault" subtitle="Platform-wide document library" />

            <div className="surface-card">
                <div className={`px-5 py-4 border-b ${colors.borderPrimary} flex flex-wrap items-center justify-between gap-3`}>
                    <div className="flex items-center gap-2">
                        <FileText size={16} className={colors.textMuted} />
                        <h2 className={`text-sm font-semibold ${colors.textPrimary}`}>Library</h2>
                        <span className={`text-xs ${colors.textMuted}`}>({pagination.total})</span>
                    </div>
                    <button type="button" onClick={load} className="btn-secondary rounded-xl px-3 py-2 text-sm flex items-center gap-2">
                        <RefreshCw size={14} /> Refresh
                    </button>
                </div>

                <div className={`px-5 py-4 border-b ${colors.borderPrimary} bg-white/[0.02]`}>
                    <div className="flex flex-col sm:flex-row gap-2 sm:items-stretch">
                        <div className="relative flex-1 min-w-0">
                            <Search size={16} className={`absolute left-3.5 top-1/2 -translate-y-1/2 pointer-events-none ${colors.textMuted}`} />
                            <input
                                value={searchInput}
                                onChange={(e) => setSearchInput(e.target.value)}
                                onKeyDown={(e) => e.key === "Enter" && applySearch()}
                                placeholder="Search by filename…"
                                className="w-full premium-input rounded-xl py-2.5 pl-10 pr-4 text-sm h-11"
                            />
                        </div>
                        <button type="button" onClick={applySearch} className="btn-gradient rounded-xl px-5 text-sm font-medium h-11 shrink-0 sm:w-auto w-full">
                            Search
                        </button>
                        <button
                            type="button"
                            onClick={() => setFiltersOpen((v) => !v)}
                            className={`rounded-xl px-4 text-sm font-medium h-11 shrink-0 inline-flex items-center justify-center gap-2 border transition-colors ${
                                filtersOpen || hasActiveFilters
                                    ? "bg-accent-muted border-[rgba(56,182,255,0.35)] text-accent"
                                    : "btn-secondary"
                            }`}
                            aria-expanded={filtersOpen}
                        >
                            <Filter size={15} />
                            Filters
                        </button>
                    </div>
                    {filtersOpen && (
                        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2 pt-3 animate-fade-in-up">
                            <FilterSelect
                                label="Status"
                                value={statusFilter}
                                onChange={(v) => { setStatusFilter(v); setPagination((prev) => ({ ...prev, page: 1 })); }}
                                options={STATUS_OPTIONS}
                                minWidth="w-full"
                            />
                            <FilterSelect
                                label="File type"
                                value={fileTypeFilter}
                                onChange={(v) => { setFileTypeFilter(v); setPagination((prev) => ({ ...prev, page: 1 })); }}
                                options={[...FILE_TYPE_OPTIONS]}
                                minWidth="w-full"
                            />
                            <FilterSelect
                                label="Score"
                                value={scoreFilter}
                                onChange={(v) => { setScoreFilter(v); setPagination((prev) => ({ ...prev, page: 1 })); }}
                                options={SCORE_FILTER_OPTIONS}
                                minWidth="w-full"
                            />
                            <FilterSelect
                                label="Sort"
                                value={sortPreset}
                                onChange={(v) => { setSortPreset(v); setPagination((prev) => ({ ...prev, page: 1 })); }}
                                options={SORT_PRESETS.map((s) => ({ value: s.value, label: s.label }))}
                                minWidth="w-full"
                            />
                            <FilterSelect
                                label="Duplicates"
                                value={duplicatesOnly}
                                onChange={(v) => { setDuplicatesOnly(v); setPagination((prev) => ({ ...prev, page: 1 })); }}
                                options={DUPLICATE_OPTIONS}
                                minWidth="w-full"
                            />
                        </div>
                    )}
                    {(q || scoreFilter || statusFilter || fileTypeFilter || duplicatesOnly || sortPreset !== "newest") && (
                        <div className="flex flex-wrap items-center gap-2 mt-3">
                            {q && (
                                <span className="inline-flex items-center gap-1.5 rounded-full border border-white/10 bg-white/5 px-2.5 py-1 text-[11px] text-slate-300">
                                    “{q}”
                                    <button type="button" onClick={() => { setSearchInput(""); setQ(""); setPagination((prev) => ({ ...prev, page: 1 })); }} className="hover:text-white" aria-label="Clear search">
                                        <X size={11} />
                                    </button>
                                </span>
                            )}
                            {statusFilter && (
                                <span className="inline-flex items-center gap-1.5 rounded-full border border-emerald-500/20 bg-emerald-500/10 px-2.5 py-1 text-[11px] text-emerald-300">
                                    {STATUS_OPTIONS.find((o) => o.value === statusFilter)?.label}
                                    <button type="button" onClick={() => { setStatusFilter(""); setPagination((prev) => ({ ...prev, page: 1 })); }} className="hover:text-white" aria-label="Clear status">
                                        <X size={11} />
                                    </button>
                                </span>
                            )}
                            {scoreFilter && (
                                <span className="inline-flex items-center gap-1.5 rounded-full border border-[rgba(56,182,255,0.2)] bg-blue-500/10 px-2.5 py-1 text-[11px] text-(--vb-blue-bright)">
                                    {SCORE_FILTER_OPTIONS.find((o) => o.value === scoreFilter)?.label}
                                    <button type="button" onClick={() => { setScoreFilter(""); setPagination((prev) => ({ ...prev, page: 1 })); }} className="hover:text-white" aria-label="Clear score">
                                        <X size={11} />
                                    </button>
                                </span>
                            )}
                            <button
                                type="button"
                                onClick={clearFilters}
                                className={`text-[11px] ${colors.textMuted} hover:text-accent underline-offset-2 hover:underline`}
                            >
                                Clear filters
                            </button>
                        </div>
                    )}
                </div>

                {error && <div className="rounded-xl border border-red-500/30 bg-red-500/10 text-red-300 px-4 py-3 text-sm">{error}</div>}

                <div className="rounded-b-2xl">
                    {loading ? (
                        <div className={`p-8 text-sm ${colors.textMuted}`}>Loading…</div>
                    ) : docs.length === 0 ? (
                        <EmptyState
                            icon={<FileText size={22} />}
                            title="No documents found"
                            description="Adjust filters or search to locate documents."
                        />
                    ) : (
                        <ul className="divide-y divide-border">
                            {docs.map((doc) => {
                                const { label: displayStatus, isProcessing, isComplete } = getDisplayStatus(doc);
                                const rowWarnClass = !isComplete ? 'border-l-4 border-red-500/20' : '';
                                return (
                                    <li key={doc.documentId} className={`px-4 sm:px-5 py-4 flex flex-col sm:flex-row sm:flex-wrap sm:items-center justify-between gap-3 ${colors.bgHover} ${rowWarnClass}`}>
                                        <div className="min-w-0 flex-1">
                                            <div className="flex items-center gap-2 flex-wrap">
                                                <p className={`font-medium truncate min-w-0 ${colors.textPrimary}`}>{doc.originalFilename}</p>
                                                {doc.metadata?.cvScore != null ? (
                                                    <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-semibold uppercase border bg-accent-muted text-accent border-[rgba(56,182,255,0.25)]">
                                                        Score: {doc.metadata.cvScore}
                                                    </span>
                                                ) : (
                                                    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold uppercase border ${statusBadge(displayStatus)}`}>
                                                        {isProcessing && <Loader2 size={10} className="animate-spin" />}
                                                        {displayStatus}
                                                    </span>
                                                )}
                                                {doc.isDuplicate && (
                                                    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold uppercase bg-amber-500/15 text-amber-300 border border-amber-500/25">
                                                        Duplicate ×{doc.duplicateCount}
                                                    </span>
                                                )}
                                                {doc.visibilityScope === "department" && (
                                                    <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-semibold uppercase bg-accent-muted text-accent border border-[rgba(56,182,255,0.25)]">
                                                        Department
                                                    </span>
                                                )}
                                                {doc.visibilityScope === "personal" && (
                                                    <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-semibold uppercase bg-white/5 text-foreground-muted border border-border">
                                                        Personal
                                                    </span>
                                                )}
                                                {doc.uploaderIsLeader && (
                                                    <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-semibold uppercase bg-amber-500/15 text-amber-300 border border-amber-500/25">
                                                        Leader
                                                    </span>
                                                )}
                                            </div>
                                            <p className={`text-xs mt-1 ${colors.textMuted}`}>
                                                <span className="inline-block px-1.5 py-0.5 rounded text-[10px] font-semibold uppercase mr-2 bg-accent-muted text-accent border border-[rgba(56,182,255,0.2)]">
                                                    {getFileTypeLabel(doc.mimeType, doc.originalFilename)}
                                                </span>
                                                {formatBytes(doc.sizeBytes)} · {new Date(doc.createdAt).toLocaleString()}
                                                {doc.classification && ` · ${doc.classification}`}
                                            </p>
                                            {doc.aiErrorMessage && (
                                                <p className="text-xs text-red-400 mt-1">{doc.aiErrorMessage}</p>
                                            )}
                                        </div>
                                        <div className="flex gap-2 flex-wrap w-full sm:w-auto">
                                            <ChatWithDocumentLink
                                                documentId={doc.documentId}
                                                ready={!!doc.pythonDocumentId}
                                                hidden={!shouldShowChatWithDocument(doc)}
                                            />
                                            <Link href={`/documents/${doc.documentId}`} className="btn-secondary rounded-lg px-3 py-2 text-sm flex items-center justify-center gap-1.5 flex-1 sm:flex-initial min-h-10">
                                                <Eye size={14} /> Preview
                                            </Link>
                                            <Link href={`/documents/details?doc=${doc.documentId}`} className="btn-secondary rounded-lg px-3 py-2 text-sm flex items-center justify-center gap-1.5 flex-1 sm:flex-initial min-h-10">
                                                <Info size={14} /> Details
                                            </Link>
                                        </div>
                                    </li>
                                );
                            })}
                        </ul>
                    )}
                </div>

                <LibraryPagination
                    page={pagination.page}
                    limit={pagination.limit}
                    total={pagination.total}
                    totalPages={pagination.totalPages}
                    onPageChange={(page) => setPagination((prev) => ({ ...prev, page }))}
                    onLimitChange={(limit) => setPagination({ page: 1, limit, total: pagination.total, totalPages: pagination.totalPages })}
                    borderClass={colors.borderPrimary}
                    textMutedClass={colors.textMuted}
                />
            </div>
        </div>
    );
}

export default function AdminDocumentsPage() {
    return (
        <AdminDocumentsContent />
    );
}
