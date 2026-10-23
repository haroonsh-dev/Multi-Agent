"use client";

import React, { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { motion } from "framer-motion";
import { FileText, Loader2, RefreshCw, Search, Filter, X, Info, Eye, Trash2, Share2, Users, Crown, FolderOpen, ChevronRight, Activity } from "lucide-react";
import FilterSelect from "@/components/FilterSelect";
import LibraryPagination from "@/components/LibraryPagination";
import ShareModal from "@/components/ShareModal";
import ChatWithDocumentLink from "@/components/ChatWithDocumentLink";
import { isGeneratedArtifactDoc, shouldShowChatWithDocument } from "@/lib/generatedDocuments";
import { PageHeader, EmptyState } from "@/components/ui";
import { usePermissions } from "@/context/PermissionsContext";
import { apiRequest } from "@/lib/apiClient";
import { getStoredUser } from "@/lib/authSession";
import { agentLabel, resolveDocAgent, filterAgentFilterOptions, filterDocTypeFilterOptions } from "@/lib/documentAgents";
import { usePlanAgents } from "@/hooks/usePlanAgents";
import { getFileTypeLabel } from "@/lib/fileValidation";

type Overview = {
    department: { departmentId: string; name: string; description?: string; allowedDocumentTypes?: string[] };
    members: Array<{
        userId: string;
        user?: { fullName?: string; email?: string; status?: string } | null;
        role?: { name: string; isLeader: boolean; rank?: number } | null;
    }>;
    leaders: Array<{ user?: { fullName?: string } | null; role?: { name: string } | null }>;
    supervision?: {
        viewerRank: number;
        isAdmin: boolean;
        supervisableUserIds: string[];
        supervisableMembers: Array<{
            userId: string;
            user?: { fullName?: string; email?: string; status?: string; lastLogin?: string } | null;
            role?: { name: string; isLeader: boolean; rank?: number } | null;
            joinedAt?: string;
        }>;
    };
};

type DocItem = {
    documentId: string; originalFilename: string; mimeType: string; sizeBytes: number; status: string;
    classification?: string | null; visibilityScope?: "personal" | "department" | null;
    departmentId?: string | null; uploaderIsLeader?: boolean; createdAt: string;
    duplicateCount?: number; isDuplicate?: boolean; pythonDocumentId?: string | null;
    aiProcessingStatus?: string | null; aiErrorMessage?: string | null;
    metadata?: { phase3Agent?: string; cvScore?: number } | null;
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
    { value: "", label: "All scores" }, { value: "high", label: "High (70+)" },
    { value: "medium", label: "Medium (40–69)" }, { value: "low", label: "Low (<40)" },
    { value: "scored", label: "Scored only" },
];

function formatBytes(n: number) {
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function statusBadge(status: string) {
    const s = status.toLowerCase();
    if (["ready", "processed", "completed", "complete", "done"].includes(s)) return "bg-emerald-50 text-emerald-700 border-emerald-200";
    if (["processing", "uploaded", "queued", "uploading"].includes(s)) return "bg-amber-50 text-amber-700 border-amber-200";
    if (s === "failed" || s.includes("fail") || s.includes("error")) return "bg-rose-50 text-rose-700 border-rose-200";
    return "bg-slate-50 text-slate-500 border-slate-200";
}

const IN_PROGRESS_AI = ["queued", "running", "processing", "ocr", "classify", "extract", "embed", "uploaded", "pending"];

function getDisplayStatus(doc: DocItem) {
    if (doc.status === "failed" || (doc.aiErrorMessage && !doc.pythonDocumentId)) return { label: "Failed", isProcessing: false, isComplete: false };
    if (doc.status === "ready") return { label: "Complete", isProcessing: false, isComplete: true };
    const ai = (doc.aiProcessingStatus || "").toLowerCase();
    if (ai.includes("fail")) return { label: "Failed", isProcessing: false, isComplete: false };
    if (doc.status === "processing" || doc.status === "uploaded") {
        const inProgress = !ai || IN_PROGRESS_AI.some((s) => ai.includes(s));
        if (inProgress) return { label: "Processing", isProcessing: true, isComplete: false };
    }
    if (doc.status === "uploaded") return { label: "Uploaded", isProcessing: false, isComplete: false };
    return { label: doc.status, isProcessing: false, isComplete: false };
}

function DeptStatCard({ icon: Icon, label, value, accent, delay = 0 }: { icon: any; label: string; value: string | number; accent: string; delay?: number }) {
    return (
        <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ delay, duration: 0.4, ease: [0.22, 1, 0.36, 1] as [number, number, number, number] }}
            className={`stat-card ${accent} p-5`}>
            <div className="flex items-center gap-4">
                <div className={`icon-box ${accent}`}><Icon size={20} /></div>
                <div className="min-w-0">
                    <p className="text-[10px] text-slate-400 font-semibold uppercase tracking-wider">{label}</p>
                    <p className="text-xl font-bold text-slate-800 mt-0.5 truncate">{value}</p>
                </div>
            </div>
        </motion.div>
    );
}

function DepartmentContent() {
    const params = useParams();
    const departmentId = String(params?.id || "");
    const { canViewDocs, canDeleteDocs, canShareDocs } = usePermissions();
    const { allowedIds } = usePlanAgents();
    const agentFilterOptions = filterAgentFilterOptions(allowedIds);
    const typeFilterOptions = filterDocTypeFilterOptions(allowedIds);
    const me = getStoredUser<{ userId?: string; orgRole?: { isLeader?: boolean } }>();

    const [overview, setOverview] = useState<Overview | null>(null);
    const [docs, setDocs] = useState<DocItem[]>([]);
    const [pagination, setPagination] = useState<Pagination>({ page: 1, limit: 10, total: 0, totalPages: 0 });
    const [loadingOverview, setLoadingOverview] = useState(true);
    const [loadingDocs, setLoadingDocs] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [searchInput, setSearchInput] = useState("");
    const [q, setQ] = useState("");
    const [sortPreset, setSortPreset] = useState<string>("newest");
    const [scoreFilter, setScoreFilter] = useState("");
    const [scopeFilter, setScopeFilter] = useState("");
    const [typeFilter, setTypeFilter] = useState("");
    const [agentFilter, setAgentFilter] = useState("");
    const [page, setPage] = useState(1);
    const [pageLimit, setPageLimit] = useState(10);
    const [filtersOpen, setFiltersOpen] = useState(false);
    const [sharingDoc, setSharingDoc] = useState<{ documentId: string; filename: string } | null>(null);

    const activeSort = SORT_PRESETS.find((s) => s.value === sortPreset) || SORT_PRESETS[0];
    const hasActiveFilters = Boolean(scoreFilter || agentFilter || scopeFilter || typeFilter || sortPreset !== "newest");

    const loadOverview = useCallback(async () => {
        if (!departmentId) return;
        setLoadingOverview(true);
        try { const res = await apiRequest(`/docs/departments/${departmentId}/overview`); setOverview(res?.data || null); }
        catch (e: any) { setError(e.message || "Failed to load department"); setOverview(null); }
        finally { setLoadingOverview(false); }
    }, [departmentId]);

    const loadDocs = useCallback(async () => {
        if (!departmentId) return;
        setLoadingDocs(true); setError(null);
        try {
            const params = new URLSearchParams({ page: String(page), limit: String(pageLimit), sortBy: activeSort.sortBy, sortOrder: activeSort.sortOrder, departmentId });
            if (q) params.set("q", q);
            if (scoreFilter) params.set("scoreFilter", scoreFilter);
            if (scopeFilter) params.set("scope", scopeFilter);
            if (typeFilter) params.set("classification", typeFilter);
            if (agentFilter) params.set("agent", agentFilter);
            const data = await apiRequest(`/docs/documents?${params}`);
            setDocs(data?.data?.documents || []);
            setPagination(data?.data?.pagination || { page: 1, limit: 10, total: 0, totalPages: 0 });
        } catch (e: any) { setError(e.message || "Failed to load documents"); setDocs([]); }
        finally { setLoadingDocs(false); }
    }, [departmentId, page, pageLimit, q, activeSort.sortBy, activeSort.sortOrder, scoreFilter, scopeFilter, typeFilter, agentFilter]);

    useEffect(() => { loadOverview(); }, [loadOverview]);
    useEffect(() => { loadDocs(); }, [loadDocs]);

    const applySearch = () => { setQ(searchInput); setPage(1); };
    const filteredDocs = agentFilter ? docs.filter((d) => resolveDocAgent(d) === agentFilter) : docs;
    const clearFilters = () => { setSearchInput(""); setQ(""); setScoreFilter(""); setScopeFilter(""); setTypeFilter(""); setAgentFilter(""); setSortPreset("newest"); setPage(1); };

    const removeDocument = async (id: string, name: string) => {
        if (!confirm(`Delete "${name}" permanently?`)) return;
        try { await apiRequest(`/docs/documents/${id}`, { method: "DELETE" }); await loadDocs(); }
        catch (e: any) { setError(e.message || "Delete failed"); }
    };

    if (loadingOverview) return (
        <div className="flex flex-col items-center justify-center py-24 gap-4">
            <div className="w-12 h-12 rounded-2xl bg-[rgba(56,182,255,0.1)] flex items-center justify-center"><Loader2 className="h-6 w-6 animate-spin text-(--vb-blue-dark)" /></div>
            <p className="text-sm text-slate-500 font-medium">Loading department...</p>
        </div>
    );

    if (!overview) return (
        <div className="p-8 text-center">
            <div className="w-16 h-16 rounded-2xl bg-slate-100 flex items-center justify-center mx-auto mb-4"><span className="text-2xl">🏢</span></div>
            <p className="text-sm font-medium text-slate-600">Department not found or access denied.</p>
        </div>
    );

    const leaderNames = overview.leaders.map((l) => l.user?.fullName).filter(Boolean) as string[];

    return (
        <div className="p-4 sm:p-6 lg:p-8 max-w-7xl mx-auto space-y-6">
            <motion.div initial={{ opacity: 0, y: -10 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.4 }}>
                <PageHeader title={overview.department.name} subtitle={overview.department.description || "Department document workspace"}
                    actions={<button type="button" onClick={() => { loadOverview(); loadDocs(); }} className="btn-secondary rounded-xl px-4 py-2.5 text-sm inline-flex items-center gap-2"><RefreshCw size={14} className={loadingDocs ? "animate-spin" : ""} /> Refresh</button>}
                />
            </motion.div>

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                <DeptStatCard icon={Users} label="Members" value={overview.members.length} accent="blue" delay={0.08} />
                <DeptStatCard icon={FolderOpen} label="Documents" value={pagination.total} accent="blue" delay={0.12} />
                <DeptStatCard icon={Crown} label="Leaders" value={leaderNames.length ? leaderNames.join(", ") : "None"} accent="amber" delay={0.16} />
            </div>

            {!!overview.supervision?.supervisableMembers?.length && (
                <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.18 }} className="surface-card overflow-hidden">
                    <div className="px-5 py-4 border-b border-slate-200 flex flex-wrap items-center justify-between gap-3">
                        <div className="flex items-center gap-3">
                            <div className="w-9 h-9 rounded-xl bg-linear-to-br from-violet-500 to-indigo-500 flex items-center justify-center shadow-lg shadow-violet-500/20">
                                <Activity size={16} className="text-white" />
                            </div>
                            <div>
                                <h2 className="text-sm font-bold text-slate-800">Team oversight</h2>
                                <p className="text-[11px] text-slate-400">
                                    Lower-rank employees you can review — activity, uploads, and access
                                </p>
                            </div>
                        </div>
                        <span className="text-[11px] font-semibold text-slate-500 bg-slate-50 border border-slate-200 rounded-full px-2.5 py-1">
                            {overview.supervision.supervisableMembers.length} people
                        </span>
                    </div>
                    <ul className="divide-y divide-slate-100">
                        {overview.supervision.supervisableMembers.map((m) => {
                            const name = m.user?.fullName || m.userId;
                            const initials = name
                                .trim()
                                .split(/\s+/)
                                .slice(0, 2)
                                .map((p) => p[0]?.toUpperCase() || "")
                                .join("") || "?";
                            return (
                                <li key={m.userId}>
                                    <Link
                                        href={`/departments/${departmentId}/members/${m.userId}`}
                                        className="px-4 sm:px-5 py-4 flex items-center gap-3 hover:bg-slate-50/70 transition-colors"
                                    >
                                        <div className="h-10 w-10 rounded-xl bg-linear-to-br from-[rgba(56,182,255,0.15)] to-blue-600/15 text-(--vb-blue-dark) flex items-center justify-center text-sm font-bold shrink-0 border border-[rgba(56,182,255,0.2)]">
                                            {initials}
                                        </div>
                                        <div className="min-w-0 flex-1">
                                            <div className="flex items-center gap-2 flex-wrap">
                                                <p className="text-sm font-semibold text-slate-800 truncate">{name}</p>
                                                {m.user?.status === "blocked" && (
                                                    <span className="text-[10px] font-semibold uppercase px-2 py-0.5 rounded-full bg-rose-50 text-rose-700 border border-rose-200">
                                                        Blocked
                                                    </span>
                                                )}
                                                {m.role?.name && (
                                                    <span className="text-[10px] font-semibold uppercase px-2 py-0.5 rounded-full bg-violet-50 text-violet-700 border border-violet-200">
                                                        {m.role.name}
                                                        {typeof m.role.rank === "number" ? ` · R${m.role.rank}` : ""}
                                                    </span>
                                                )}
                                            </div>
                                            <p className="text-xs text-slate-500 truncate mt-0.5">
                                                {m.user?.email || "No email"}
                                                {m.user?.lastLogin
                                                    ? ` · Last login ${new Date(m.user.lastLogin).toLocaleString()}`
                                                    : ""}
                                            </p>
                                        </div>
                                        <span className="text-xs font-medium text-(--vb-blue-dark) inline-flex items-center gap-1 shrink-0">
                                            View details <ChevronRight size={14} />
                                        </span>
                                    </Link>
                                </li>
                            );
                        })}
                    </ul>
                </motion.div>
            )}

            <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.2 }} className="surface-card">
                <div className="px-5 py-4 border-b border-slate-200 flex flex-wrap items-center justify-between gap-3">
                    <div className="flex items-center gap-3">
                        <div className="w-9 h-9 rounded-xl bg-(--vb-blue) text-(--vb-color-primary-btn-fg) flex items-center justify-center shadow-(--vb-glow)"><FileText size={16} /></div>
                        <div>
                            <h2 className="text-sm font-bold text-slate-800">Department Documents</h2>
                            <p className="text-[11px] text-slate-400">All files uploaded by this department</p>
                        </div>
                    </div>
                    <button type="button" onClick={() => { loadOverview(); loadDocs(); }} className="btn-secondary rounded-xl px-3 py-2 text-sm flex items-center gap-2"><RefreshCw size={14} /> Refresh</button>
                </div>

                <div className="px-5 py-4 border-b border-slate-100 relative z-20">
                    <div className="flex flex-col gap-3">
                        <div className="flex flex-col sm:flex-row gap-2 sm:items-stretch">
                            <div className="relative flex-1 min-w-0">
                                <Search size={16} className="absolute left-3.5 top-1/2 -translate-y-1/2 pointer-events-none text-slate-400" />
                                <input value={searchInput} onChange={(e) => setSearchInput(e.target.value)} onKeyDown={(e) => e.key === "Enter" && applySearch()} placeholder="Search by filename…" className="w-full premium-input rounded-xl py-2.5 pl-10 pr-4 text-sm h-11" />
                            </div>
                            <button type="button" onClick={applySearch} className="btn-gradient rounded-xl px-5 text-sm font-medium h-11 shrink-0 sm:w-auto w-full">Search</button>
                            <button type="button" onClick={() => setFiltersOpen((v) => !v)}
                                className={`rounded-xl px-4 text-sm font-medium h-11 shrink-0 inline-flex items-center justify-center gap-2 border transition-colors ${filtersOpen || hasActiveFilters ? "bg-[rgba(56,182,255,0.1)] border-[rgba(56,182,255,0.28)] text-(--vb-blue-dark)" : "btn-secondary"}`}
                                aria-expanded={filtersOpen}>
                                <Filter size={15} /> Filters
                                {hasActiveFilters && <span className="h-5 min-w-5 px-1 rounded-full bg-(--vb-blue) text-white text-[10px] font-bold flex items-center justify-center">{[scoreFilter, agentFilter, scopeFilter, typeFilter, sortPreset !== "newest"].filter(Boolean).length}</span>}
                            </button>
                        </div>
                        {filtersOpen && (
                            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2 pt-1 animate-fade-in-up">
                                <FilterSelect label="Scope" value={scopeFilter} onChange={(v) => { setScopeFilter(v); setPage(1); }} options={[{ value: "", label: "All scopes" }, { value: "department", label: "Department" }, { value: "personal", label: "Personal" }]} minWidth="w-full" />
                                <FilterSelect label="Doc type" value={typeFilter} onChange={(v) => { setTypeFilter(v); setPage(1); }} options={typeFilterOptions} minWidth="w-full" />
                                <FilterSelect label="Score" value={scoreFilter} onChange={(v) => { setScoreFilter(v); setPage(1); }} options={SCORE_FILTER_OPTIONS} minWidth="w-full" />
                                <FilterSelect label="Sort" value={sortPreset} onChange={(v) => { setSortPreset(v); setPage(1); }} options={SORT_PRESETS.map((s) => ({ value: s.value, label: s.label }))} minWidth="w-full" />
                                <FilterSelect label="Agent" value={agentFilter} onChange={(v) => { setAgentFilter(v); setPage(1); }} options={agentFilterOptions} minWidth="w-full" />
                            </div>
                        )}
                    </div>
                    {(q || scoreFilter || agentFilter || scopeFilter || typeFilter || sortPreset !== "newest") && (
                        <div className="flex flex-wrap items-center gap-2 mt-3">
                            {q && <span className="inline-flex items-center gap-1.5 rounded-full border border-slate-200 bg-slate-50 px-2.5 py-1 text-[11px] text-slate-600">&quot;{q}&quot;<button type="button" onClick={() => { setSearchInput(""); setQ(""); setPage(1); }} className="hover:text-rose-500"><X size={11} /></button></span>}
                            {scoreFilter && <span className="inline-flex items-center gap-1.5 rounded-full border border-emerald-200 bg-emerald-50 px-2.5 py-1 text-[11px] text-emerald-700">{SCORE_FILTER_OPTIONS.find((o) => o.value === scoreFilter)?.label}<button type="button" onClick={() => { setScoreFilter(""); setPage(1); }} className="hover:text-rose-500"><X size={11} /></button></span>}
                            {agentFilter && <span className="inline-flex items-center gap-1.5 rounded-full border border-[rgba(56,182,255,0.28)] bg-[rgba(56,182,255,0.1)] px-2.5 py-1 text-[11px] text-(--vb-blue-dark)">{agentLabel(agentFilter)}<button type="button" onClick={() => { setAgentFilter(""); setPage(1); }} className="hover:text-rose-500"><X size={11} /></button></span>}
                            <button type="button" onClick={clearFilters} className="text-[11px] text-slate-400 hover:text-(--vb-blue-dark) underline-offset-2 hover:underline">Clear filters</button>
                        </div>
                    )}
                </div>

                {error && <div className="mx-5 mt-4 rounded-xl border border-rose-200 bg-rose-50 text-rose-700 px-4 py-3 text-sm">{error}</div>}

                {loadingDocs ? (
                    <div className="p-8 text-sm text-slate-500 text-center">Loading documents…</div>
                ) : filteredDocs.length === 0 ? (
                    <EmptyState icon={<FileText size={22} />} title="No documents found" description="Adjust filters or upload files to this department." />
                ) : (
                    <ul className="divide-y divide-slate-100">
                        {filteredDocs.map((doc) => {
                            const { label: displayStatus, isProcessing, isComplete } = getDisplayStatus(doc);
                            return (
                                <li key={doc.documentId} className={`px-4 sm:px-5 py-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3 hover:bg-slate-50/50 ${!isComplete ? "border-l-4 border-l-rose-300" : ""}`}>
                                    <div className="min-w-0 flex-1">
                                        <div className="flex items-center gap-2 flex-wrap">
                                            <p className="font-medium truncate text-sm text-slate-800">{doc.originalFilename}</p>
                                            <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold uppercase border ${statusBadge(displayStatus)}`}>
                                                {isProcessing && <Loader2 size={10} className="animate-spin" />}{displayStatus}
                                            </span>
                                            {doc.metadata?.cvScore != null && (
                                                <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold border ${
                                                    doc.metadata.cvScore >= 70 ? "bg-emerald-50 text-emerald-700 border-emerald-200" :
                                                    doc.metadata.cvScore >= 40 ? "bg-amber-50 text-amber-700 border-amber-200" :
                                                    "bg-rose-50 text-rose-700 border-rose-200"
                                                }`}>
                                                    {doc.metadata.cvScore >= 70 ? "✓" : doc.metadata.cvScore >= 40 ? "—" : "✗"} {doc.metadata.cvScore}
                                                </span>
                                            )}
                                            {doc.isDuplicate && <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold uppercase bg-amber-50 text-amber-700 border border-amber-200">Duplicate</span>}
                                        </div>
                                        <p className="text-xs mt-1 text-slate-500">
                                            <span className="inline-block px-1.5 py-0.5 rounded text-[10px] font-semibold uppercase mr-2 bg-[rgba(56,182,255,0.1)] text-(--vb-blue-dark) border border-[rgba(56,182,255,0.28)]">{getFileTypeLabel(doc.mimeType, doc.originalFilename)}</span>
                                            {formatBytes(doc.sizeBytes)} · {new Date(doc.createdAt).toLocaleString()}
                                            {doc.classification && ` · ${doc.classification}`}
                                            {doc.metadata?.phase3Agent && ` · ${agentLabel(doc.metadata.phase3Agent)}`}
                                        </p>
                                        {doc.aiErrorMessage && <p className="text-xs text-rose-600 mt-1">{doc.aiErrorMessage}</p>}
                                    </div>
                                    <div className="flex gap-2 flex-wrap w-full sm:w-auto">
                                        <ChatWithDocumentLink
                                            documentId={doc.documentId}
                                            ready={!!doc.pythonDocumentId}
                                            hidden={!shouldShowChatWithDocument(doc)}
                                        />
                                        <Link href={isGeneratedArtifactDoc(doc) ? `/documents/${doc.documentId}` : `/documents/details?doc=${doc.documentId}`} className="btn-secondary rounded-lg px-3 py-2 text-sm flex items-center justify-center gap-1.5 flex-1 sm:flex-initial min-h-10"><Info size={14} /> {isGeneratedArtifactDoc(doc) ? "Open PDF" : "Details"}</Link>
                                        <Link href={`/documents/${doc.documentId}`} className="btn-secondary rounded-lg px-3 py-2 text-sm flex items-center justify-center gap-1.5 flex-1 sm:flex-initial min-h-10"><Eye size={14} /> Preview</Link>
                                        {canDeleteDocs() && <button type="button" onClick={() => removeDocument(doc.documentId, doc.originalFilename)} className="btn-ghost rounded-lg px-3 py-2 text-sm flex items-center justify-center gap-1.5 text-rose-500 min-h-10"><Trash2 size={14} /> Delete</button>}
                                        {(canShareDocs() || me?.orgRole?.isLeader) && <button type="button" onClick={() => setSharingDoc({ documentId: doc.documentId, filename: doc.originalFilename })} className="btn-secondary rounded-lg px-3 py-2 text-sm flex items-center justify-center gap-1.5 min-h-10"><Share2 size={14} /> Share</button>}
                                    </div>
                                </li>
                            );
                        })}
                    </ul>
                )}

                <LibraryPagination page={pagination.page} limit={pagination.limit} total={pagination.total} totalPages={pagination.totalPages} onPageChange={setPage} onLimitChange={(l) => { setPageLimit(l); setPage(1); }} borderClass="border-slate-200" textMutedClass="text-slate-500" />
            </motion.div>

            {sharingDoc && <ShareModal documentId={sharingDoc.documentId} filename={sharingDoc.filename} currentDepartmentId={departmentId} open={true} onClose={() => setSharingDoc(null)} onShared={() => { loadDocs(); loadOverview(); }} />}
        </div>
    );
}

export default function DepartmentPage() {
    return (
        <DepartmentContent />
    );
}
