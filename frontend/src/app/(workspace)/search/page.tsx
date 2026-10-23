"use client";

import React, { useState } from "react";
import Link from "next/link";
import { FileText, Loader2, Search as SearchIcon } from "lucide-react";
import FilterSelect from "@/components/FilterSelect";
import { PageHeader, EmptyState } from "@/components/ui";
import { apiRequest } from "@/lib/apiClient";
import { AGENT_FILTER_OPTIONS, agentLabel, DOC_TYPE_FILTER_OPTIONS } from "@/lib/documentAgents";
import { usePermissions } from "@/context/PermissionsContext";
import { usePlanAgents } from "@/hooks/usePlanAgents";

type SearchHit = {
    document_id?: string;
    document_title?: string;
    document_type?: string;
    chunk_text?: string;
    page_number?: number;
    score?: number;
    nodeDocumentId?: string | null;
    previewDocumentId?: string | null;
    status?: string;
    metadata?: { phase3Agent?: string } | null;
};

const STATUS_OPTIONS = [
    { value: "", label: "All statuses" },
    { value: "processed", label: "Processed" },
    { value: "ready", label: "Ready" },
    { value: "failed", label: "Failed" },
    { value: "processing", label: "Processing" },
    { value: "uploaded", label: "Uploaded" },
];

function SearchContent() {
    const { canViewDocs } = usePermissions();
    const { agentOptions } = usePlanAgents();
    const agentFilterOptions = [
        { value: "", label: "All agents" },
        ...agentOptions,
    ];
    const [query, setQuery] = useState("");
    const [docType, setDocType] = useState("");
    const [agent, setAgent] = useState("");
    const [status, setStatus] = useState("");
    const [loading, setLoading] = useState(false);
    const [searched, setSearched] = useState(false);
    const [results, setResults] = useState<SearchHit[]>([]);
    const [total, setTotal] = useState(0);
    const [error, setError] = useState<string | null>(null);

    const doSearch = async () => {
        const q = query.trim();
        if (!q) return;
        setLoading(true);
        setError(null);
        setSearched(true);
        try {
            const params = new URLSearchParams({ q, limit: "20", offset: "0" });
            if (docType) params.set("documentType", docType);
            if (agent) params.set("phase3Agent", agent);
            if (status) params.set("status", status);
            const data = await apiRequest(`/docs/search?${params}`);
            const hits: SearchHit[] = data?.data?.results || [];
            setResults(hits);
            setTotal(data?.data?.total ?? hits.length);
        } catch (e: any) {
            setError(e.message || "Search failed");
            setResults([]);
            setTotal(0);
        } finally {
            setLoading(false);
        }
    };

    if (!canViewDocs()) {
        return (
            <div className="p-6 max-w-3xl mx-auto">
                <div className="rounded-xl border border-amber-200 bg-amber-50 text-amber-700 px-4 py-3 text-sm">
                    You do not have permission to search documents.
                </div>
            </div>
        );
    }

    return (
        <div className="p-4 sm:p-6 lg:p-8 space-y-5 max-w-4xl mx-auto">
            <PageHeader title="Search" subtitle="Semantic search across your processed document library." />

            <div className="surface-card overflow-visible">
                <div className="px-5 py-4 border-b border-slate-100 space-y-3">
                    <div className="flex flex-col sm:flex-row gap-2">
                        <div className="relative flex-1 min-w-0">
                            <SearchIcon size={16} className="absolute left-3.5 top-1/2 -translate-y-1/2 pointer-events-none text-slate-400" />
                            <input
                                value={query}
                                onChange={(e) => setQuery(e.target.value)}
                                onKeyDown={(e) => e.key === "Enter" && doSearch()}
                                placeholder="Search documents…"
                                className="w-full premium-input rounded-xl py-2.5 pl-10 pr-4 text-sm h-11"
                            />
                        </div>
                        <button
                            type="button"
                            onClick={doSearch}
                            disabled={loading || !query.trim()}
                            className="btn-gradient rounded-xl px-5 text-sm font-medium h-11 shrink-0 inline-flex items-center justify-center gap-2 disabled:opacity-50"
                        >
                            {loading ? <Loader2 size={14} className="animate-spin" /> : <SearchIcon size={14} />}
                            Search
                        </button>
                    </div>
                    <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                        <FilterSelect label="Doc type" value={docType} onChange={setDocType} options={DOC_TYPE_FILTER_OPTIONS} minWidth="w-full" />
                        <FilterSelect label="Agent" value={agent} onChange={setAgent} options={agentFilterOptions} minWidth="w-full" />
                        <FilterSelect label="Status" value={status} onChange={setStatus} options={STATUS_OPTIONS} minWidth="w-full" />
                    </div>
                </div>

                {error && (
                    <div className="mx-5 mt-4 rounded-xl border border-rose-200 bg-rose-50 text-rose-700 px-4 py-3 text-sm">
                        {error}
                    </div>
                )}

                <div className="p-2 sm:p-3">
                    {loading ? (
                        <div className="p-8 text-sm text-slate-500 flex items-center gap-2 justify-center">
                            <Loader2 size={14} className="animate-spin" /> Searching…
                        </div>
                    ) : !searched ? (
                        <EmptyState
                            icon={<SearchIcon size={22} />}
                            title="Search your library"
                            description="Enter a query to find matching chunks across processed documents."
                        />
                    ) : results.length === 0 ? (
                        <EmptyState
                            icon={<FileText size={22} />}
                            title="No results"
                            description="Try a different query or clear filters."
                        />
                    ) : (
                        <>
                            <p className="px-3 py-2 text-xs text-slate-400">
                                {total} result{total !== 1 ? "s" : ""}
                                {agent ? ` · ${agentLabel(agent)}` : ""}
                            </p>
                            <ul className="space-y-2">
                                {results.map((hit, i) => {
                                    const docId = hit.nodeDocumentId || hit.previewDocumentId || "";
                                    const title = hit.document_title || hit.document_id?.slice(0, 12) || "Document";
                                    const pct =
                                        hit.score != null ? `${Math.round(Number(hit.score) * 100)}%` : null;
                                    const content = (
                                        <div className="flex items-start justify-between gap-3">
                                            <div className="min-w-0 flex-1">
                                                <div className="flex items-center gap-2 flex-wrap">
                                                    <p className="text-sm font-semibold text-slate-800 truncate">
                                                        {title}
                                                    </p>
                                                    {pct && (
                                                        <span className="inline-flex px-2 py-0.5 rounded-full text-[10px] font-bold border bg-[rgba(56,182,255,0.1)] text-(--vb-blue-dark) border-[rgba(56,182,255,0.28)]">
                                                            {pct}
                                                        </span>
                                                    )}
                                                    {hit.document_type && (
                                                        <span className="inline-flex px-2 py-0.5 rounded-full text-[10px] font-semibold border bg-slate-50 text-slate-500 border-slate-200">
                                                            {hit.document_type}
                                                        </span>
                                                    )}
                                                    {hit.page_number != null && (
                                                        <span className="text-[10px] text-slate-400">
                                                            p.{hit.page_number}
                                                        </span>
                                                    )}
                                                </div>
                                                {hit.chunk_text && (
                                                    <p className="text-xs text-slate-500 mt-1.5 line-clamp-3 leading-relaxed">
                                                        {hit.chunk_text}
                                                    </p>
                                                )}
                                            </div>
                                            <FileText size={14} className="text-slate-300 shrink-0 mt-1" />
                                        </div>
                                    );
                                    return (
                                        <li key={`${hit.document_id}-${i}`}>
                                            {docId ? (
                                                <Link
                                                    href={`/documents/details?doc=${docId}`}
                                                    className="block rounded-xl border border-slate-200 bg-white px-4 py-3 hover:border-[rgba(56,182,255,0.4)] hover:bg-[rgba(56,182,255,0.03)] transition-colors"
                                                >
                                                    {content}
                                                </Link>
                                            ) : (
                                                <div className="rounded-xl border border-slate-200 bg-white px-4 py-3">
                                                    {content}
                                                </div>
                                            )}
                                        </li>
                                    );
                                })}
                            </ul>
                        </>
                    )}
                </div>
            </div>
        </div>
    );
}

export default function SearchPage() {
    return (
        <SearchContent />
    );
}
