"use client";

import React, { Suspense, useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { motion } from "framer-motion";
import {
    FileText, Upload, Trash2, RefreshCw, Eye, Search, FolderUp, Copy, X, Loader2, Info, Filter, Share2,
    CheckCircle, Clock, AlertTriangle, List, FolderTree, Brain, Sparkles,
} from "lucide-react";
import FilterSelect from "@/components/FilterSelect";
import ClassifyAgentPopup from "@/components/ClassifyAgentPopup";
import AgentAccessBlockedNotice, { type AgentBlockItem } from "@/components/AgentAccessBlockedNotice";
import DocumentFolderTree from "@/components/DocumentFolderTree";
import LibraryPagination from "@/components/LibraryPagination";
import ShareModal from "@/components/ShareModal";
import ChatWithDocumentLink from "@/components/ChatWithDocumentLink";
import { shouldShowChatWithDocument, isGeneratedArtifactDoc } from "@/lib/generatedDocuments";
import { PageHeader, EmptyState } from "@/components/ui";
import { useTheme } from "@/context/ColorContext";
import { apiRequest } from "@/lib/apiClient";
import { AGENT_OPTIONS, agentLabel, resolveDocAgent, DOC_TYPE_LABELS, DOC_TYPE_TO_AGENT, inferDocTypeFromFilename, filterDocTypeFilterOptions } from "@/lib/documentAgents";
import { ACCEPT_ATTR, filterAllowedFiles, getFileTypeLabel } from "@/lib/fileValidation";
import { usePermissions } from "@/context/PermissionsContext";
import { getStoredUser } from "@/lib/authSession";
import { usePlanAgents } from "@/hooks/usePlanAgents";
import { ClassifyPendingTracker } from "@/lib/classifyPendingTracker";

type DocItem = {
    documentId: string; originalFilename: string; mimeType: string; sizeBytes: number; status: string;
    classification?: string | null; visibilityScope?: "personal" | "department" | null;
    departmentId?: string | null; uploaderIsLeader?: boolean; uploadedBy?: string; createdAt: string;
    duplicateCount?: number; isDuplicate?: boolean; pythonDocumentId?: string | null;
    aiProcessingStatus?: string | null; aiErrorMessage?: string | null;
    metadata?: {
        phase3Agent?: string;
        naturalAgent?: string;
        agentClamped?: boolean;
        cvScore?: number;
        extractionConfidence?: number;
        generatedVia?: string;
        source?: string;
    } | null;
};

type Pagination = { page: number; limit: number; total: number; totalPages: number };
type PendingFile = { id: string; file: File };
type QueueItemStatus = "queued" | "uploading" | "processing" | "done" | "error" | "duplicate";
type QueueItem = { id: string; name: string; size: number; mimeType: string; status: QueueItemStatus; error?: string; documentId?: string };

const QUEUE_TERMINAL_STATUSES: QueueItemStatus[] = ["done", "error", "duplicate"];

function queueStatusText(item: QueueItem) {
    if (item.status === "duplicate") return "Duplicate — not added";
    return item.error ? `${item.status}: ${item.error}` : item.status;
}

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
    if (s === "duplicate") return "bg-slate-100 text-slate-600 border-slate-200";
    if (s === "failed" || s.includes("fail") || s.includes("error")) return "bg-rose-50 text-rose-700 border-rose-200";
    return "bg-slate-50 text-slate-500 border-slate-200";
}

const IN_PROGRESS_AI = ["queued", "running", "processing", "ocr", "classify", "extract", "embed", "uploaded", "pending"];

function getDisplayStatus(doc: DocItem) {
    if (doc.status === "failed" || (doc.aiErrorMessage && !doc.pythonDocumentId)) return { label: "Failed", isProcessing: false, isComplete: false };
    if (doc.status === "ready") return { label: "Complete", isProcessing: false, isComplete: true };
    const ai = (doc.aiProcessingStatus || "").toLowerCase();
    if (ai.includes("fail")) return { label: "Failed", isProcessing: false, subtitle: doc.aiProcessingStatus || undefined, isComplete: false };
    if (doc.status === "processing" || doc.status === "uploaded") {
        const inProgress = !ai || IN_PROGRESS_AI.some((s) => ai.includes(s));
        if (inProgress) return { label: "Processing", isProcessing: true, subtitle: doc.aiProcessingStatus && doc.aiProcessingStatus !== "processing" ? doc.aiProcessingStatus : undefined, isComplete: false };
    }
    if (doc.status === "uploaded") return { label: "Uploaded", isProcessing: false, isComplete: false };
    return { label: doc.status, isProcessing: doc.status === "processing", isComplete: false };
}

type ClassifyQueueItem = { documentId: string; originalFilename: string; document_type?: string; classification?: string | null };

function StatMini({ icon: Icon, label, value, accent, delay = 0 }: { icon: any; label: string; value: number; accent: string; delay?: number }) {
    return (
        <motion.div
            initial={{ opacity: 0, y: 10, scale: 0.95 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            transition={{ delay, duration: 0.4, ease: [0.22, 1, 0.36, 1] }}
            className={`stat-card ${accent} p-4 flex-1 min-w-35`}
        >
            <div className="flex items-center gap-3">
                <div className={`icon-box ${accent}`} style={{ width: '2.5rem', height: '2.5rem' }}>
                    <Icon size={16} />
                </div>
                <div>
                    <p className="text-[10px] text-slate-400 font-semibold uppercase tracking-wider">{label}</p>
                    <p className="text-xl font-bold text-slate-800 mt-0.5">{value}</p>
                </div>
            </div>
        </motion.div>
    );
}

function DocumentsContent() {
    const { theme } = useTheme();
    const colors = theme.colors;
    const router = useRouter();
    const containerRef = useRef<HTMLDivElement>(null);
    const { canUpload, canViewDocs, canDeleteDocs, canAccessPage, role } = usePermissions();
    const { agentOptions, isAgentAllowed, allowedIds, loading: agentsLoading } = usePlanAgents();
    const docTypeFilterOptions = filterDocTypeFilterOptions(allowedIds);
    const preferredAgentOptions = [
        { value: "", label: "Auto (from document type)" },
        ...agentOptions,
    ];

    const fileNeedsForbiddenAgent = useCallback(
        (filename: string): { blocked: true; agent: string; docType: string } | { blocked: false } => {
            if (role === "superAdmin") return { blocked: false };
            // Wait for entitlement — never block while agents are unknown
            if (agentsLoading || allowedIds === null) return { blocked: false };
            const docType = inferDocTypeFromFilename(filename);
            if (!docType) return { blocked: false };
            const agent = DOC_TYPE_TO_AGENT[docType] || "other_agent";
            // File maps to an agent you already have → always allow
            if (allowedIds.includes(agent) || isAgentAllowed(agent)) return { blocked: false };
            return { blocked: true, agent, docType };
        },
        [role, agentsLoading, allowedIds, isAgentAllowed]
    );
    const me = getStoredUser<{
        userId?: string;
        name?: string;
        email?: string;
        primaryDepartmentId?: string;
        orgRole?: { isLeader?: boolean };
    }>();
    const isLeader = !!me?.orgRole?.isLeader;
    const canPickUploader = role === "admin" || role === "superAdmin" || isLeader;
    const deleteScopeHint =
        role === "admin" || role === "superAdmin"
            ? "Admins can delete any documents in the organization."
            : isLeader
              ? "Leaders can delete their own uploads and their department members' uploads — not docs only shared with them."
              : "You can only delete documents you uploaded. Shared documents cannot be deleted.";

    const [docs, setDocs] = useState<DocItem[]>([]);
    const [pagination, setPagination] = useState<Pagination>({ page: 1, limit: 10, total: 0, totalPages: 0 });
    const [loading, setLoading] = useState(true);
    const [activeBatches, setActiveBatches] = useState(0);
    const uploading = activeBatches > 0;
    const [dragOver, setDragOver] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [agentBlock, setAgentBlock] = useState<AgentBlockItem[] | null>(null);
    const [pendingFiles, setPendingFiles] = useState<PendingFile[]>([]);
    const [queueItems, setQueueItems] = useState<QueueItem[]>([]);
    const [q, setQ] = useState("");
    const [searchInput, setSearchInput] = useState("");
    const [sortPreset, setSortPreset] = useState<string>("newest");
    const [scoreFilter, setScoreFilter] = useState("");
    const [scopeFilter, setScopeFilter] = useState("");
    const [typeFilter, setTypeFilter] = useState("");
    const [page, setPage] = useState(1);
    const [pageLimit, setPageLimit] = useState(10);
    const [agentFilter, setAgentFilter] = useState("");
    const [preferredAgent, setPreferredAgent] = useState("");
    const [classifyQueue, setClassifyQueue] = useState<ClassifyQueueItem[]>([]);
    const [toast, setToast] = useState<string | null>(null);
    const [filtersOpen, setFiltersOpen] = useState(false);
    const [sharingDoc, setSharingDoc] = useState<{ documentId: string; filename: string } | null>(null);
    const [viewMode, setViewMode] = useState<"list" | "tree">("list");
    const [bulkOpen, setBulkOpen] = useState(false);
    const [bulkType, setBulkType] = useState("");
    const [bulkDateFrom, setBulkDateFrom] = useState("");
    const [bulkDateTo, setBulkDateTo] = useState("");
    const [bulkUploader, setBulkUploader] = useState("");
    const [bulkPreview, setBulkPreview] = useState<{ count: number; sample: Array<{ documentId: string; originalFilename: string; classification?: string | null }> } | null>(null);
    const [bulkBusy, setBulkBusy] = useState(false);
    const [bulkError, setBulkError] = useState<string | null>(null);
    const [members, setMembers] = useState<Array<{ userId: string; name?: string; email?: string }>>([]);
    const [mounted, setMounted] = useState(false);

    // AI model chosen for the next upload batch — sent per upload, not saved globally.
    const [configuredProviders, setConfiguredProviders] = useState<Array<{ provider: string; label: string; isActive: boolean; hasKey: boolean }>>([]);
    const [selectedProvider, setSelectedProvider] = useState<string>("");

    const loadProviderKeys = useCallback(async () => {
        try {
            const res = await apiRequest("/docs/settings/api-keys");
            const keysList = res?.data?.keys || [];
            const active = keysList.filter((k: any) => k.hasKey);
            setConfiguredProviders(active);
            const currentActive = keysList.find((k: any) => k.isActive)?.provider || active[0]?.provider || "";
            setSelectedProvider(currentActive);
        } catch {
            /* ignore */
        }
    }, []);

    const searchParams = useSearchParams();
    const agentUrlParam = searchParams?.get("agent");

    useEffect(() => {
        if (agentUrlParam !== null && agentUrlParam !== undefined) {
            setAgentFilter(agentUrlParam);
            if (agentUrlParam) setViewMode("tree");
            setPage(1);
        }
    }, [agentUrlParam]);

    useEffect(() => {
        setMounted(true);
        if (canAccessPage("settings")) loadProviderKeys();
    }, [canAccessPage, loadProviderKeys]);

    const activeSort = SORT_PRESETS.find((s) => s.value === sortPreset) || SORT_PRESETS[0];
    const applySearch = () => { setQ(searchInput); setPage(1); };

    const load = useCallback(async (opts?: { silent?: boolean } | unknown) => {
        // Keep previous rows visible while refreshing — avoids blank flash on navigation.
        const isSilent = typeof opts === "object" && opts !== null && "silent" in opts && Boolean((opts as any).silent);
        if (!isSilent) setLoading(true);
        setError(null);
        try {
            const limit = viewMode === "tree" ? 200 : pageLimit;
            const params = new URLSearchParams({
                page: viewMode === "tree" ? "1" : String(page),
                limit: String(limit),
                sortBy: activeSort.sortBy,
                sortOrder: activeSort.sortOrder,
            });
            if (q) params.set("q", q);
            if (scoreFilter) params.set("scoreFilter", scoreFilter);
            if (scopeFilter) params.set("scope", scopeFilter);
            if (typeFilter) params.set("classification", typeFilter);
            // Integration JSON records stay backend-only — never list them in Documents UI.
            params.set("contentKind", "file");
            const data = await apiRequest(`/docs/documents?${params}`);
            setDocs(data?.data?.documents || []);
            setPagination(data?.data?.pagination || { page: 1, limit: 10, total: 0, totalPages: 0 });
        } catch (e: any) { setError(e.message || "Failed to load documents"); }
        finally {
            if (!isSilent) setLoading(false);
        }
    }, [page, pageLimit, q, activeSort.sortBy, activeSort.sortOrder, scoreFilter, scopeFilter, typeFilter, viewMode]);

    useEffect(() => { load(); }, [load]);
    useEffect(() => { if (!toast) return; const t = setTimeout(() => setToast(null), 4000); return () => clearTimeout(t); }, [toast]);

    const queueClassifyPopup = async (documentId: string) => {
        try {
            const data = await apiRequest(`/docs/documents/${documentId}/intelligence`);
            const doc = data?.data?.document; const ai = data?.data?.aiDocument;
            const docType = ai?.document_type || doc?.classification;
            if (!docType) return;
            setClassifyQueue((prev) => { if (prev.some((p) => p.documentId === documentId)) return prev; return [...prev, { documentId, originalFilename: doc?.originalFilename || "Document", document_type: String(docType), classification: doc?.classification }]; });
        } catch { /* ignore */ }
    };

    const handleAgentConfirm = async (documentId: string, documentType: string, phase3Agent: string) => {
        try {
            await apiRequest(`/docs/documents/${documentId}/ai-settings`, { method: "PATCH", body: JSON.stringify({ documentType, phase3Agent }) });
            setClassifyQueue((prev) => prev.filter((p) => p.documentId !== documentId));
            setToast(`Agent set to ${agentLabel(phase3Agent)}`);
            await load();
        } catch (e: any) { setError(e.message || "Failed to save agent"); }
    };

    const handleRejectUploadForAgent = useCallback(
        async (documentId: string, _reason: string) => {
            try {
                await apiRequest(`/docs/documents/${documentId}`, { method: "DELETE" });
                setClassifyQueue((prev) => prev.filter((p) => p.documentId !== documentId));
                setToast("Upload removed — that agent isn’t on your access");
                await load();
            } catch (e: any) {
                setClassifyQueue((prev) => prev.filter((p) => p.documentId !== documentId));
                setError(e.message || "Failed to remove blocked upload");
            }
        },
        [load]
    );

    const filteredDocs = agentFilter ? docs.filter((d) => resolveDocAgent(d) === agentFilter) : docs;
    const processingDocIds = docs.filter((d) => d.status === "processing" || d.status === "uploaded").map((d) => d.documentId);

    useEffect(() => {
        if (!processingDocIds.length) return;
        const interval = setInterval(async () => {
            let changed = false;
            const updates: Record<string, Partial<DocItem>> = {};
            let becameReady = false;
            await Promise.all(processingDocIds.map(async (id) => {
                try {
                    const data = await apiRequest(`/docs/documents/${id}/processing`);
                    const proc = data?.data;
                    if (!proc) return;
                    const next: Partial<DocItem> = {
                        status: proc.status,
                        aiProcessingStatus: proc.aiProcessingStatus,
                    };
                    if (proc.cvScore != null || proc.metadata?.cvScore != null) {
                        next.metadata = {
                            cvScore: Number(proc.cvScore ?? proc.metadata?.cvScore),
                        };
                    }
                    if (proc.classification) next.classification = proc.classification;
                    updates[id] = next;
                    changed = true;
                    if (proc.status === "ready" || proc.status === "failed") becameReady = true;
                    if (proc.status === "ready" || proc.status === "failed") {
                        if (pendingClassifyRef.current.resolve(id, proc.status)) queueClassifyPopup(id);
                    }
                    if (proc.status === "ready" || proc.status === "failed") {
                        // Resolve any staging-queue entry left showing "processing" from a
                        // pollUntilTerminal timeout so it doesn't sit there forever.
                        let resolved = false;
                        setQueueItems((prev) => prev.map((q) => {
                            if (q.documentId === id && q.status === "processing") { resolved = true; return { ...q, status: proc.status === "ready" ? "done" : "error" }; }
                            return q;
                        }));
                        if (resolved) setTimeout(() => setQueueItems((prev) => prev.filter((q) => q.documentId !== id)), 8000);
                    }
                } catch { /* ignore */ }
            }));
            if (!changed) return;
            if (becameReady) {
                load();
                return;
            }
            setDocs((prev) => prev.map((d) => {
                const u = updates[d.documentId];
                if (!u) return d;
                return {
                    ...d,
                    ...u,
                    metadata: u.metadata ? { ...(d.metadata || {}), ...u.metadata } : d.metadata,
                };
            }));
        }, 5000);
        return () => clearInterval(interval);
    }, [processingDocIds.join(","), load]);

    const pollUntilTerminal = async (documentId: string): Promise<"done" | "error" | "timeout"> => {
        for (let i = 0; i < 60; i++) {
            try {
                const data = await apiRequest(`/docs/documents/${documentId}/processing`);
                const status = data?.data?.status;
                if (status === "ready") { pendingClassifyRef.current.resolve(documentId, "ready"); return "done"; }
                if (status === "failed") { pendingClassifyRef.current.resolve(documentId, "failed"); return "error"; }
            } catch { /* retry */ }
            await new Promise((r) => setTimeout(r, 4000));
        }
        // Still processing after 4 minutes (large/slow docs) — not a failure. The background
        // poller keeps watching processingDocIds and will fire the classify popup once ready.
        return "timeout";
    };

    const addFilesToQueue = (fileList: FileList | File[]) => {
        const { allowed, rejected } = filterAllowedFiles(fileList);
        if (rejected.length) setError(`Rejected unsupported files: ${rejected.join(", ")}`);
        if (!allowed.length) return;

        const pass: File[] = [];
        const blockedItems: AgentBlockItem[] = [];
        for (const file of allowed) {
            const check = fileNeedsForbiddenAgent(file.name);
            if (check.blocked) {
                blockedItems.push({
                    filename: file.name,
                    typeLabel: DOC_TYPE_LABELS[check.docType] || check.docType.replace(/_/g, " "),
                    agentId: check.agent,
                });
            } else {
                pass.push(file);
            }
        }
        if (blockedItems.length) {
            setError(null);
            setAgentBlock(blockedItems);
        }
        if (!pass.length) return;
        setPendingFiles((prev) => [
            ...prev,
            ...pass.map((file) => ({
                id: `pf_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
                file,
            })),
        ]);
    };

    useEffect(() => {
        const onPaste = (e: ClipboardEvent) => { const files = e.clipboardData?.files; if (!files?.length) return; e.preventDefault(); addFilesToQueue(files); };
        const el = containerRef.current; el?.addEventListener("paste", onPaste as any); return () => el?.removeEventListener("paste", onPaste as any);
    });

    const inFlightIdsRef = useRef<Set<string>>(new Set());
    // Docs that still need the classify popup once they reach "ready" — populated at
    // upload time, consumed by whichever poller (fast or background) sees readiness first.
    // See lib/classifyPendingTracker.ts for the (unit-tested) state machine.
    const pendingClassifyRef = useRef(new ClassifyPendingTracker());

    const removeFromQueue = (id: string) => setPendingFiles((prev) => prev.filter((p) => p.id !== id));
    const clearQueue = () => setPendingFiles([]);

    const uploadQueue = async () => {
        const batch = pendingFiles.filter((p) => !inFlightIdsRef.current.has(p.id));
        if (!batch.length) return;
        const batchIds = new Set(batch.map((p) => p.id));
        batchIds.forEach((id) => inFlightIdsRef.current.add(id));
        const batchAgent = preferredAgent;
        const batchProvider = selectedProvider;
        setPendingFiles((prev) => prev.filter((p) => !batchIds.has(p.id)));
        setError(null);
        setActiveBatches((n) => n + 1);
        setQueueItems((prev) => [
            ...prev,
            ...batch.map((p) => ({ id: p.id, name: p.file.name, size: p.file.size, mimeType: p.file.type, status: "queued" as QueueItemStatus })),
        ]);

        const processingIds: string[] = [];
        try {
            for (const pf of batch) {
                setQueueItems((prev) => prev.map((q) => (q.id === pf.id ? { ...q, status: "uploading" } : q)));
                try {
                    const check = fileNeedsForbiddenAgent(pf.file.name);
                    if (check.blocked) {
                        const typeLabel =
                            DOC_TYPE_LABELS[check.docType] || check.docType.replace(/_/g, " ");
                        setAgentBlock((prev) => {
                            const next = {
                                filename: pf.file.name,
                                typeLabel,
                                agentId: check.agent,
                            };
                            if (!prev) return [next];
                            if (prev.some((p) => p.filename === next.filename && p.agentId === next.agentId)) {
                                return prev;
                            }
                            return [...prev, next];
                        });
                        setQueueItems((prev) =>
                            prev.map((q) =>
                                q.id === pf.id
                                    ? {
                                          ...q,
                                          status: "error",
                                          error: `Blocked — ${typeLabel} needs ${agentLabel(check.agent)}`,
                                      }
                                    : q
                            )
                        );
                        continue;
                    }
                    const form = new FormData(); form.append("file", pf.file);
                    if (batchAgent) form.append("phase3Agent", batchAgent);
                    if (batchProvider) form.append("aiProvider", batchProvider);
                    const data = await apiRequest("/docs/documents", { method: "POST", body: form, timeoutMs: 180_000 });
                    const doc = data?.data?.document;
                    const failed = doc?.status === "failed" || !!doc?.aiErrorMessage;
                    if (doc?.documentId && !failed) processingIds.push(doc.documentId);
                    setQueueItems((prev) => prev.map((q) => q.id === pf.id ? { ...q, status: failed ? "error" : "processing", documentId: doc?.documentId, error: doc?.aiErrorMessage || (failed ? "Upload to model failed" : undefined) } : q));
                } catch (e: any) {
                    const isDuplicate =
                        e?.status === 409 ||
                        e?.code === 'DUPLICATE_FILE' ||
                        e?.code === 'DUPLICATE_CONTENT';
                    setQueueItems((prev) => prev.map((q) => q.id === pf.id ? { ...q, status: isDuplicate ? "duplicate" : "error", error: isDuplicate ? undefined : e.message } : q));
                }
            }
        } finally {
            // Released as soon as the transfers finish so more files can be sent while these process.
            setActiveBatches((n) => Math.max(0, n - 1));
        }

        await load();

        if (processingIds.length) {
            processingIds.forEach((docId) => pendingClassifyRef.current.add(docId));
            await Promise.all(processingIds.map(async (docId) => {
                const result = await pollUntilTerminal(docId);
                if (result === "timeout") {
                    // Leave it as "processing" — the background poller (processingDocIds effect)
                    // keeps watching and will pop the classify popup once it actually finishes.
                    setQueueItems((prev) => prev.map((q) => q.documentId === docId ? { ...q, status: "processing" } : q));
                    return;
                }
                setQueueItems((prev) => prev.map((q) => q.documentId === docId ? { ...q, status: result === "done" ? "done" : "error" } : q));
                if (result === "done") await queueClassifyPopup(docId);
            }));
            await load();
        }

        batchIds.forEach((id) => inFlightIdsRef.current.delete(id));
        setTimeout(() => {
            setQueueItems((prev) => prev.filter((q) => !(batchIds.has(q.id) && QUEUE_TERMINAL_STATUSES.includes(q.status))));
        }, 8000);
    };

    const onDrop = (e: React.DragEvent) => {
        e.preventDefault();
        setDragOver(false);
        if (e.dataTransfer.files?.length) addFilesToQueue(e.dataTransfer.files);
    };

    const remove = async (id: string, name: string) => {
        if (!confirm(`Delete "${name}" and its folder permanently?`)) return;
        const prevDocs = docs;
        const prevPagination = pagination;
        // Instantly remove from table UI (0ms delay)
        setDocs((prev) => prev.filter((d) => d.documentId !== id));
        setPagination((prev) => ({ ...prev, total: Math.max(0, prev.total - 1) }));
        setToast(`Deleted "${name}"`);
        try {
            await apiRequest(`/docs/documents/${id}`, { method: "DELETE" });
            // Silently verify in background without showing full-page loading spinner
            await load({ silent: true });
        } catch (e: any) {
            setDocs(prevDocs);
            setPagination(prevPagination);
            setError(e.message || "Delete failed");
        }
    };

    const openBulkDelete = async () => {
        setBulkOpen(true);
        setBulkError(null);
        setBulkPreview(null);
        setBulkType(typeFilter || "");
        setBulkDateFrom("");
        setBulkDateTo("");
        setBulkUploader("");
        if (canPickUploader && members.length === 0) {
            try {
                if (role === "admin" || role === "superAdmin") {
                    const data = await apiRequest("/docs/team/members");
                    setMembers(
                        (data?.data?.members || []).map((m: any) => ({
                            userId: m.userId,
                            name: m.fullName || m.name,
                            email: m.email,
                        }))
                    );
                } else if (isLeader && me?.primaryDepartmentId) {
                    const data = await apiRequest(`/docs/departments/${me.primaryDepartmentId}/overview`);
                    setMembers(
                        (data?.data?.members || []).map((m: any) => ({
                            userId: m.userId,
                            name: m.user?.fullName || m.user?.name,
                            email: m.user?.email,
                        }))
                    );
                }
            } catch {
                setMembers([]);
            }
        }
    };

    const buildBulkBody = (dryRun: boolean) => ({
        dryRun,
        classification: bulkType || undefined,
        dateFrom: bulkDateFrom || undefined,
        dateTo: bulkDateTo || undefined,
        uploadedBy: canPickUploader ? (bulkUploader || undefined) : undefined,
    });

    const previewBulkDelete = async () => {
        setBulkBusy(true);
        setBulkError(null);
        try {
            const data = await apiRequest("/docs/documents/bulk-delete", {
                method: "POST",
                body: JSON.stringify(buildBulkBody(true)),
            });
            setBulkPreview({
                count: data?.data?.count ?? 0,
                sample: data?.data?.sample || [],
            });
        } catch (e: any) {
            setBulkError(e.message || "Preview failed");
            setBulkPreview(null);
        } finally {
            setBulkBusy(false);
        }
    };

    const confirmBulkDelete = async () => {
        setBulkBusy(true);
        setBulkError(null);
        try {
            let count = bulkPreview?.count ?? 0;
            if (!bulkPreview) {
                const preview = await apiRequest("/docs/documents/bulk-delete", {
                    method: "POST",
                    body: JSON.stringify(buildBulkBody(true)),
                });
                count = preview?.data?.count ?? 0;
                setBulkPreview({
                    count,
                    sample: preview?.data?.sample || [],
                });
            }
            if (!count) {
                setBulkError("No matching documents to delete with these filters.");
                setBulkBusy(false);
                return;
            }
            const dateNote =
                !bulkDateFrom && !bulkDateTo
                    ? " (no date filter — all matching docs in your scope)"
                    : "";
            setBulkBusy(false);
            if (!confirm(`Permanently delete ${count} document${count === 1 ? "" : "s"}${dateNote}? This cannot be undone.`)) {
                return;
            }
            setBulkBusy(true);
            const data = await apiRequest("/docs/documents/bulk-delete", {
                method: "POST",
                body: JSON.stringify(buildBulkBody(false)),
            });
            const deleted = data?.data?.deleted ?? 0;
            setToast(data?.message || `Deleted ${deleted} document(s)`);
            setBulkOpen(false);
            setBulkPreview(null);
            await load({ silent: true });
        } catch (e: any) {
            setBulkError(e.message || "Bulk delete failed");
        } finally {
            setBulkBusy(false);
        }
    };

    const allowUpload = canUpload();
    const allowView = canViewDocs();
    const allowDelete = canDeleteDocs();
    const showStaging = pendingFiles.length > 0 || queueItems.length > 0;
    // In-flight items stay listed while newly picked files are appended below them.
    const stagedRows: QueueItem[] = [
        ...queueItems,
        ...pendingFiles.map((p) => ({ id: p.id, name: p.file.name, size: p.file.size, mimeType: p.file.type, status: "queued" as QueueItemStatus })),
    ];
    const hasActiveFilters = Boolean(scoreFilter || agentFilter || scopeFilter || typeFilter || sortPreset !== "newest");

    const totalDocs = pagination.total;
    const readyCount = docs.filter((d) => ["ready", "processed", "completed", "done"].includes((d.status || "").toLowerCase())).length;
    const processingCount = docs.filter((d) => ["processing", "uploaded", "queued"].includes((d.status || "").toLowerCase())).length;
    const failedCount = docs.filter((d) => { const s = (d.status || "").toLowerCase(); return s === "failed" || s.includes("fail") || s.includes("error"); }).length;

    return (
        <div ref={containerRef} tabIndex={0} className="p-4 sm:p-6 lg:p-8 space-y-5 max-w-6xl mx-auto outline-none">
            <motion.div initial={{ opacity: 0, y: -10 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.4 }}>
                <PageHeader title="Documents" subtitle={allowUpload ? "Add files to queue, review, then upload. Files go to server then AI model automatically." : "Browse documents available to your account."} />
            </motion.div>

            {allowView && (
                <div className="flex flex-wrap items-center gap-4">
                    <StatMini icon={FileText} label="Total" value={totalDocs} accent="blue" delay={0.1} />
                    <StatMini icon={CheckCircle} label="Ready" value={readyCount} accent="emerald" delay={0.15} />
                    <StatMini icon={Clock} label="Processing" value={processingCount} accent="amber" delay={0.2} />
                    <StatMini icon={AlertTriangle} label="Failed" value={failedCount} accent="rose" delay={0.25} />
                </div>
            )}

            {!allowUpload && !allowView && (
                <div className="rounded-xl border border-amber-200 bg-amber-50 text-amber-700 px-4 py-3 text-sm">
                    You do not have permission to view or upload documents. Ask your admin to update your permissions.
                </div>
            )}

            {allowUpload && (
                <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.15 }}
                    onDragOver={(e) => { e.preventDefault(); setDragOver(true); }} onDragLeave={() => setDragOver(false)} onDrop={onDrop}
                    className={`relative overflow-hidden rounded-3xl border-2 border-dashed transition-all ${
                        dragOver
                            ? "border-(--vb-blue) bg-linear-to-br from-[rgba(56,182,255,0.08)] to-[rgba(63,116,255,0.06)] shadow-(--vb-glow)"
                            : "border-slate-200 bg-white hover:border-[rgba(56,182,255,0.4)] hover:bg-[rgba(56,182,255,0.03)]"
                    }`}
                >
                    <div className="absolute inset-0 opacity-[0.015]">
                        <div className="absolute -top-10 -right-10 w-40 h-40 rounded-full bg-[rgba(56,182,255,0.1)] blur-3xl" />
                        <div className="absolute -bottom-10 -left-10 w-32 h-32 rounded-full bg-blue-500 blur-3xl" />
                    </div>
                    <div className="relative p-8 sm:p-10 flex flex-col items-center text-center gap-4">
                        <div className={`w-16 h-16 rounded-2xl flex items-center justify-center transition-all ${
                            dragOver
                                ? "bg-[rgba(56,182,255,0.1)] text-white shadow-(--vb-glow) scale-110"
                                : "bg-linear-to-br from-[rgba(56,182,255,0.08)] to-[rgba(63,116,255,0.06)] text-(--vb-blue-dark) border border-[rgba(56,182,255,0.28)]"
                        }`}>
                            <Upload size={26} />
                        </div>
                        <div>
                            <p className="font-bold text-slate-800 text-base">{uploading ? "Uploading..." : "Drag & drop files or folder"}</p>
                            <p className="text-sm text-slate-400 mt-1">PDF, images, DOCX, XLSX, PPTX — max 50 MB each · paste with Ctrl+V</p>
                        </div>
                        <div className="flex flex-wrap gap-2.5 justify-center">
                            <label className="btn-gradient rounded-xl px-6 py-2.5 text-sm cursor-pointer inline-flex items-center gap-2 shadow-sm hover:shadow-md transition-shadow">
                                <Upload size={14} /> Browse files
                                <input type="file" className="hidden" accept={ACCEPT_ATTR} multiple onChange={(e) => { if (e.target.files?.length) addFilesToQueue(e.target.files); e.target.value = ""; }} />
                            </label>
                            <label className="btn-secondary rounded-xl px-6 py-2.5 text-sm cursor-pointer inline-flex items-center gap-2">
                                <FolderUp size={14} /> Upload folder
                                <input type="file" className="hidden" accept={ACCEPT_ATTR} multiple {...({ webkitdirectory: "", directory: "" } as any)} onChange={(e) => { if (e.target.files?.length) addFilesToQueue(e.target.files); e.target.value = ""; }} />
                            </label>
                        </div>
                    </div>
                </motion.div>
            )}

            {toast && <div className="rounded-xl border border-emerald-200 bg-emerald-50 text-emerald-700 px-4 py-3 text-sm">{toast}</div>}

            {allowUpload && classifyQueue.length > 0 && (
                <ClassifyAgentPopup
                    key={classifyQueue[0].documentId}
                    doc={classifyQueue[0]}
                    queueLen={classifyQueue.length}
                    defaultAgent={preferredAgent || undefined}
                    onConfirm={handleAgentConfirm}
                    onRejectUpload={handleRejectUploadForAgent}
                    onDismiss={() => setClassifyQueue((prev) => prev.slice(1))}
                />
            )}

            {allowUpload && showStaging && (
                <div className="surface-card overflow-visible">
                    <div className="px-5 py-4 border-b border-slate-200 flex flex-wrap items-center justify-between gap-3">
                        <div>
                            <h2 className="text-sm font-semibold text-slate-800">
                                {pendingFiles.length > 0 ? `Ready to upload (${pendingFiles.length})` : "Upload queue"}
                            </h2>
                            <p className="text-xs mt-0.5 text-slate-500">
                                {uploading
                                    ? "Uploading in the background — you can keep adding files and upload them right away."
                                    : "Review files, pick AI model and extraction agent, then click Upload"}
                            </p>
                        </div>
                        <div className="flex gap-2 items-center">
                            {pendingFiles.length > 0 && (
                                <button
                                    type="button"
                                    onClick={clearQueue}
                                    className="rounded-xl px-3 py-2 text-sm font-medium text-(--vb-blue-dark) hover:bg-[rgba(56,182,255,0.1)] transition-colors"
                                >
                                    Clear all
                                </button>
                            )}
                            <button
                                type="button"
                                onClick={uploadQueue}
                                disabled={pendingFiles.length === 0}
                                className="btn-primary rounded-xl px-5 py-2.5 text-sm inline-flex items-center gap-2 disabled:opacity-50"
                            >
                                {uploading ? <Loader2 size={14} className="animate-spin" /> : <Upload size={14} />}
                                Upload {pendingFiles.length} file(s)
                            </button>
                        </div>
                    </div>
                    {pendingFiles.length > 0 && (
                        <div className="px-5 py-4 border-b border-slate-100 bg-linear-to-r from-slate-50 via-white to-[rgba(56,182,255,0.08)]">
                            <div className={`grid gap-3 ${configuredProviders.length > 0 ? "sm:grid-cols-2" : ""}`}>
                                {configuredProviders.length > 0 && (
                                    <FilterSelect
                                        variant="card"
                                        label="AI model"
                                        icon={Brain}
                                        iconClassName="border-amber-200/80 bg-linear-to-br from-amber-50 to-orange-100/70 text-amber-500"
                                        value={selectedProvider}
                                        onChange={setSelectedProvider}
                                        options={configuredProviders.map((p) => ({ value: p.provider, label: p.label || p.provider.toUpperCase() }))}
                                    />
                                )}
                                <FilterSelect
                                    variant="card"
                                    label="Extraction agent"
                                    labelHint="optional"
                                    icon={Sparkles}
                                    iconClassName="border-[rgba(56,182,255,0.28)] bg-linear-to-br from-[rgba(56,182,255,0.08)] to-blue-100/70 text-(--vb-blue)"
                                    value={preferredAgent}
                                    onChange={setPreferredAgent}
                                    options={preferredAgentOptions}
                                />
                            </div>
                            {configuredProviders.length > 0 && (
                                <p className="mt-2.5 text-[11px] text-slate-400">Applies to this upload only — it does not change your workspace default.</p>
                            )}
                        </div>
                    )}
                    <ul className="divide-y divide-slate-100">
                        {stagedRows.map((item) => (
                            <li key={item.id} className="px-5 py-3 flex flex-wrap items-center justify-between gap-3 hover:bg-slate-50/50">
                                <div className="min-w-0 flex-1">
                                    <p className="font-medium truncate text-sm text-slate-800">{item.name}</p>
                                    <p className="text-xs mt-0.5 text-slate-500">{formatBytes(item.size)}{"mimeType" in item && item.mimeType && <span className="ml-2">{getFileTypeLabel(item.mimeType, item.name)}</span>}</p>
                                </div>
                                <div className="flex items-center gap-2">
                                    {item.status !== "queued" && <span className={`text-xs px-2 py-0.5 rounded-full border ${statusBadge(item.status)}`}>{queueStatusText(item)}</span>}
                                    {pendingFiles.some((p) => p.id === item.id) && <button type="button" onClick={() => removeFromQueue(item.id)} className="btn-ghost rounded-lg p-2 text-rose-400" aria-label="Remove from queue"><X size={14} /></button>}
                                </div>
                            </li>
                        ))}
                    </ul>
                </div>
            )}

            {agentBlock && agentBlock.length > 0 && role !== "superAdmin" && (
                <AgentAccessBlockedNotice
                    items={agentBlock}
                    coveredAgents={allowedIds || agentOptions.map((a) => a.value)}
                    role={role}
                    onDismiss={() => setAgentBlock(null)}
                />
            )}
            {error && <div className="rounded-xl border border-rose-200 bg-rose-50 text-rose-700 px-4 py-3 text-sm">{error}</div>}

            {allowView && (
                <div className="surface-card">
                    <div className="px-5 py-4 border-b border-slate-100 flex items-center justify-between gap-3 flex-wrap">
                        <div className="flex items-center gap-3">
                            <div className="w-9 h-9 rounded-xl bg-(--vb-blue) text-(--vb-color-primary-btn-fg) flex items-center justify-center shadow-(--vb-glow)">
                                <FileText size={16} />
                            </div>
                            <div>
                                <h2 className="text-sm font-bold text-slate-800">Library</h2>
                                <p className="text-[11px] text-slate-400">{pagination.total} document{pagination.total !== 1 ? "s" : ""}</p>
                            </div>
                        </div>
                        <div className="flex items-center gap-2 flex-wrap">
                            <div className="inline-flex rounded-xl border border-slate-200 bg-slate-50 p-0.5">
                                <button
                                    type="button"
                                    onClick={() => setViewMode("list")}
                                    className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium transition-colors ${
                                        viewMode === "list"
                                            ? "bg-white text-(--vb-blue-dark) shadow-sm border border-slate-200"
                                            : "text-slate-500 hover:text-slate-700"
                                    }`}
                                >
                                    <List size={13} /> List
                                </button>
                                <button
                                    type="button"
                                    onClick={() => setViewMode("tree")}
                                    className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium transition-colors ${
                                        viewMode === "tree"
                                            ? "bg-white text-(--vb-blue-dark) shadow-sm border border-slate-200"
                                            : "text-slate-500 hover:text-slate-700"
                                    }`}
                                >
                                    <FolderTree size={13} /> Tree
                                </button>
                            </div>
                            {allowDelete && (
                                <button
                                    type="button"
                                    onClick={openBulkDelete}
                                    className="rounded-xl px-4 py-2 text-sm inline-flex items-center gap-2 border border-rose-200 bg-rose-50 text-rose-700 hover:bg-rose-100 transition-colors"
                                >
                                    <Trash2 size={14} /> Delete…
                                </button>
                            )}
                            <button type="button" onClick={load} className="btn-secondary rounded-xl px-4 py-2 text-sm inline-flex items-center gap-2">
                                <RefreshCw size={14} className={loading ? "animate-spin" : ""} /> Refresh
                            </button>
                        </div>
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
                                    <FilterSelect label="Doc type" value={typeFilter} onChange={(v) => { setTypeFilter(v); setPage(1); }} options={docTypeFilterOptions} minWidth="w-full" />
                                    <FilterSelect label="Score" value={scoreFilter} onChange={(v) => { setScoreFilter(v); setPage(1); }} options={SCORE_FILTER_OPTIONS} minWidth="w-full" />
                                    <FilterSelect label="Sort" value={sortPreset} onChange={(v) => { setSortPreset(v); setPage(1); }} options={SORT_PRESETS.map((s) => ({ value: s.value, label: s.label }))} minWidth="w-full" />
                                    <FilterSelect label="Agent" value={agentFilter} onChange={(v) => { setAgentFilter(v); setPage(1); }} options={[{ value: "", label: "All agents" }, ...agentOptions]} minWidth="w-full" />
                                </div>
                            )}
                        </div>
                        {(scoreFilter || agentFilter || scopeFilter || typeFilter || sortPreset !== "newest" || q) && (
                            <div className="flex flex-wrap items-center gap-2 mt-3">
                                {q && <span className="inline-flex items-center gap-1.5 rounded-full border border-slate-200 bg-slate-50 px-2.5 py-1 text-[11px] text-slate-600">&quot;{q}&quot;<button type="button" onClick={() => { setSearchInput(""); setQ(""); setPage(1); }} className="hover:text-rose-500" aria-label="Clear search"><X size={11} /></button></span>}
                                {scoreFilter && <span className="inline-flex items-center gap-1.5 rounded-full border border-emerald-200 bg-emerald-50 px-2.5 py-1 text-[11px] text-emerald-700">{SCORE_FILTER_OPTIONS.find((o) => o.value === scoreFilter)?.label}<button type="button" onClick={() => { setScoreFilter(""); setPage(1); }} className="hover:text-rose-500" aria-label="Clear score"><X size={11} /></button></span>}
                                {agentFilter && <span className="inline-flex items-center gap-1.5 rounded-full border border-[rgba(56,182,255,0.28)] bg-[rgba(56,182,255,0.1)] px-2.5 py-1 text-[11px] text-(--vb-blue-dark)">{agentLabel(agentFilter)}<button type="button" onClick={() => { setAgentFilter(""); setPage(1); }} className="hover:text-rose-500" aria-label="Clear agent"><X size={11} /></button></span>}
                                <button type="button" onClick={() => { setSearchInput(""); setQ(""); setScoreFilter(""); setScopeFilter(""); setTypeFilter(""); setAgentFilter(""); setSortPreset("newest"); setPage(1); }} className="text-[11px] text-slate-400 hover:text-(--vb-blue-dark) underline-offset-2 hover:underline">Clear filters</button>
                            </div>
                        )}
                    </div>

                    <div className="rounded-b-2xl">
                    {loading ? (
                        <div className="p-8 text-sm text-slate-500">Loading…</div>
                    ) : filteredDocs.length === 0 ? (
                        <EmptyState icon={<FileText size={22} />} title="No documents found" description="Upload files above or adjust your filters to see documents here." />
                    ) : viewMode === "tree" ? (
                        <DocumentFolderTree
                            docs={filteredDocs}
                            search={q}
                            agentFilter={agentFilter}
                            onSelectDoc={(id) => router.push(`/documents/details?doc=${id}`)}
                            onDelete={allowDelete ? remove : undefined}
                        />
                    ) : (
                        <ul className="divide-y divide-slate-100">
                            {filteredDocs.map((doc) => {
                                const { label: displayStatus, isProcessing, isComplete } = getDisplayStatus(doc);
                                return (
                                <li key={doc.documentId} className={`px-5 py-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3 hover:bg-slate-50/50 transition-colors ${!isComplete ? "border-l-[3px] border-l-amber-400" : ""}`}>
                                    <div className="min-w-0 flex-1">
                                        <div className="flex items-center gap-2 flex-wrap">
                                            <p className="font-semibold truncate min-w-0 text-slate-800 text-sm">{doc.originalFilename}</p>
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
                                            {doc.metadata?.extractionConfidence != null && doc.metadata.extractionConfidence < 0.75 && (
                                                <span
                                                    title="AI-estimated confidence in the extracted field values was low — verify before relying on them."
                                                    className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold border ${
                                                        doc.metadata.extractionConfidence >= 0.5
                                                            ? "bg-amber-50 text-amber-700 border-amber-200"
                                                            : "bg-rose-50 text-rose-700 border-rose-200"
                                                    }`}
                                                >
                                                    <AlertTriangle size={10} /> {Math.round(doc.metadata.extractionConfidence * 100)}% confidence
                                                </span>
                                            )}
                                            {(doc.metadata?.agentClamped ||
                                                (doc.metadata?.naturalAgent &&
                                                    doc.metadata?.phase3Agent &&
                                                    doc.metadata.naturalAgent !== doc.metadata.phase3Agent)) && (
                                                <span
                                                    className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold border bg-amber-50 text-amber-800 border-amber-200"
                                                    title={
                                                        doc.metadata.naturalAgent
                                                            ? `Normally ${agentLabel(doc.metadata.naturalAgent)}; processed with ${agentLabel(doc.metadata.phase3Agent || "other_agent")} (not on your plan/department)`
                                                            : "Processed with a fallback agent — specialist skills from outside your access were not used"
                                                    }
                                                >
                                                    {agentLabel(doc.metadata.phase3Agent || "other_agent")}
                                                    {doc.metadata.naturalAgent
                                                        ? ` (${agentLabel(doc.metadata.naturalAgent)} not on access)`
                                                        : " (clamped)"}
                                                </span>
                                            )}
                                            {doc.isDuplicate && (
                                                <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold uppercase bg-amber-50 text-amber-700 border border-amber-200">
                                                    <Copy size={10} /> Dup
                                                </span>
                                            )}
                                            {doc.visibilityScope === "department" && (
                                                <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-semibold uppercase bg-[rgba(56,182,255,0.1)] text-(--vb-blue-dark) border border-[rgba(56,182,255,0.28)]">
                                                    Dept
                                                </span>
                                            )}
                                            {doc.visibilityScope === "personal" && (
                                                <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-semibold uppercase bg-slate-50 text-slate-500 border border-slate-200">
                                                    Personal
                                                </span>
                                            )}
                                        </div>
                                        <p className="text-xs text-slate-400 mt-1.5 flex items-center gap-2 flex-wrap">
                                            <span className="inline-block px-1.5 py-0.5 rounded text-[10px] font-semibold uppercase bg-slate-100 text-slate-500">
                                                {getFileTypeLabel(doc.mimeType, doc.originalFilename)}
                                            </span>
                                            <span>{formatBytes(doc.sizeBytes)}</span>
                                            <span className="text-slate-300">&middot;</span>
                                            <span>
                                                {new Date(doc.createdAt).toLocaleDateString("en-US", {
                                                    month: "short",
                                                    day: "numeric",
                                                    year: "numeric",
                                                })}
                                            </span>
                                            {doc.classification && (
                                                <>
                                                    <span className="text-slate-300">&middot;</span>
                                                    <span className="text-(--vb-blue-dark)">
                                                        {DOC_TYPE_LABELS[doc.classification] || doc.classification}
                                                    </span>
                                                </>
                                            )}
                                        </p>
                                        {doc.aiErrorMessage && <p className="text-xs text-rose-500 mt-1.5 flex items-center gap-1"><AlertTriangle size={11} /> {doc.aiErrorMessage}</p>}
                                    </div>
                                    <div className="flex gap-1.5 flex-wrap w-full sm:w-auto">
                                        <ChatWithDocumentLink
                                            documentId={doc.documentId}
                                            ready={!!doc.pythonDocumentId}
                                            hidden={!shouldShowChatWithDocument(doc)}
                                        />
                                        {allowView && (
                                            <Link
                                                href={
                                                    isGeneratedArtifactDoc(doc)
                                                        ? `/documents/${doc.documentId}`
                                                        : `/documents/details?doc=${doc.documentId}`
                                                }
                                                className="btn-secondary rounded-lg px-3 py-2 text-xs flex items-center justify-center gap-1.5 min-h-9"
                                            >
                                                <Info size={13} /> {isGeneratedArtifactDoc(doc) ? "Open PDF" : "Details"}
                                            </Link>
                                        )}
                                        {allowView && <Link href={`/documents/${doc.documentId}`} className="btn-secondary rounded-lg px-3 py-2 text-xs flex items-center justify-center gap-1.5 min-h-9"><Eye size={13} /> Preview</Link>}
                                        {allowDelete && <button type="button" onClick={() => remove(doc.documentId, doc.originalFilename)} className="btn-ghost rounded-lg px-3 py-2 text-xs flex items-center justify-center gap-1.5 text-rose-500 min-h-9 hover:bg-rose-50"><Trash2 size={13} /></button>}
                                        {allowView && doc.uploadedBy === me?.userId && <button type="button" onClick={() => setSharingDoc({ documentId: doc.documentId, filename: doc.originalFilename })} className="btn-secondary rounded-lg px-3 py-2 text-xs flex items-center justify-center gap-1.5 min-h-9"><Share2 size={13} /></button>}
                                    </div>
                                </li>
                            );})}
                        </ul>
                    )}
                    </div>
                    {viewMode === "list" && (
                        <LibraryPagination page={pagination.page} limit={pagination.limit} total={pagination.total} totalPages={pagination.totalPages} onPageChange={setPage} onLimitChange={(limit) => { setPageLimit(limit); setPage(1); }} borderClass="border-slate-200" textMutedClass="text-slate-500" />
                    )}
                </div>
            )}

            {sharingDoc && <ShareModal documentId={sharingDoc.documentId} filename={sharingDoc.filename} open={true} onClose={() => setSharingDoc(null)} onShared={() => load()} />}

            {mounted && bulkOpen && createPortal(
                <div className="fixed inset-0 z-100 flex items-center justify-center p-4">
                    <button type="button" className="absolute inset-0 bg-slate-900/40 backdrop-blur-[2px]" aria-label="Close" onClick={() => !bulkBusy && setBulkOpen(false)} />
                    <div className="relative w-full max-w-lg rounded-2xl bg-white shadow-2xl border border-slate-200 overflow-hidden">
                        <div className="px-5 py-4 border-b border-slate-100 flex items-start justify-between gap-3">
                            <div>
                                <h3 className="text-base font-bold text-slate-800">Delete documents</h3>
                                <p className="text-xs text-slate-500 mt-0.5">
                                    Filter by type{canPickUploader ? ", uploader," : ""} and optional date range. Leave dates empty to delete <span className="font-semibold text-slate-700">all</span> matching documents in your scope.
                                </p>
                                <p className="text-[11px] text-amber-700 mt-1.5 leading-relaxed">{deleteScopeHint}</p>
                            </div>
                            <button type="button" disabled={bulkBusy} onClick={() => setBulkOpen(false)} className="p-1.5 rounded-lg text-slate-400 hover:text-slate-700 hover:bg-slate-100">
                                <X size={16} />
                            </button>
                        </div>
                        <div className="px-5 py-4 space-y-3">
                            <FilterSelect
                                label="Document type"
                                value={bulkType}
                                onChange={(v) => { setBulkType(v); setBulkPreview(null); }}
                                options={docTypeFilterOptions}
                                minWidth="w-full"
                            />
                            <div className="grid grid-cols-2 gap-3">
                                <label className="block">
                                    <span className="text-[11px] font-semibold text-slate-500 uppercase tracking-wider">From date <span className="font-normal normal-case text-slate-400">(optional)</span></span>
                                    <input
                                        type="date"
                                        value={bulkDateFrom}
                                        onChange={(e) => { setBulkDateFrom(e.target.value); setBulkPreview(null); }}
                                        className="mt-1 w-full premium-input rounded-xl px-3 py-2.5 text-sm"
                                    />
                                </label>
                                <label className="block">
                                    <span className="text-[11px] font-semibold text-slate-500 uppercase tracking-wider">To date <span className="font-normal normal-case text-slate-400">(optional)</span></span>
                                    <input
                                        type="date"
                                        value={bulkDateTo}
                                        onChange={(e) => { setBulkDateTo(e.target.value); setBulkPreview(null); }}
                                        className="mt-1 w-full premium-input rounded-xl px-3 py-2.5 text-sm"
                                    />
                                </label>
                            </div>
                            {!bulkDateFrom && !bulkDateTo && (
                                <p className="text-[11px] text-slate-400 -mt-1">
                                    No date filter — every matching document in your delete scope will be included.
                                </p>
                            )}
                            {canPickUploader && (
                                <label className="block">
                                    <span className="text-[11px] font-semibold text-slate-500 uppercase tracking-wider">Uploaded by</span>
                                    <select
                                        value={bulkUploader}
                                        onChange={(e) => { setBulkUploader(e.target.value); setBulkPreview(null); }}
                                        className="mt-1 w-full premium-input rounded-xl px-3 py-2.5 text-sm"
                                    >
                                        <option value="">
                                            {isLeader && role !== "admin" && role !== "superAdmin"
                                                ? "Anyone in my department"
                                                : "Anyone (in your access)"}
                                        </option>
                                        {me?.userId && (
                                            <option value={me.userId}>Me ({me.name || me.email || "you"})</option>
                                        )}
                                        {members
                                            .filter((m) => m.userId !== me?.userId)
                                            .map((m) => (
                                                <option key={m.userId} value={m.userId}>
                                                    {m.name || m.email || m.userId}
                                                </option>
                                            ))}
                                    </select>
                                </label>
                            )}

                            {bulkError && (
                                <div className="rounded-xl border border-rose-200 bg-rose-50 text-rose-700 px-3 py-2 text-xs">{bulkError}</div>
                            )}

                            {bulkPreview && (
                                <div className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-3 space-y-2">
                                    <p className="text-sm font-semibold text-slate-800">
                                        {bulkPreview.count} document{bulkPreview.count === 1 ? "" : "s"} match
                                    </p>
                                    {bulkPreview.sample.length > 0 && (
                                        <ul className="text-xs text-slate-600 space-y-1 max-h-28 overflow-y-auto">
                                            {bulkPreview.sample.map((s) => (
                                                <li key={s.documentId} className="truncate">
                                                    {s.originalFilename}
                                                    {s.classification ? ` · ${s.classification}` : ""}
                                                </li>
                                            ))}
                                            {bulkPreview.count > bulkPreview.sample.length && (
                                                <li className="text-slate-400">…and {bulkPreview.count - bulkPreview.sample.length} more</li>
                                            )}
                                        </ul>
                                    )}
                                </div>
                            )}
                        </div>
                        <div className="px-5 py-4 border-t border-slate-100 flex flex-wrap items-center justify-end gap-2 bg-slate-50/80">
                            <button type="button" disabled={bulkBusy} onClick={() => setBulkOpen(false)} className="btn-secondary rounded-xl px-4 py-2 text-sm">
                                Cancel
                            </button>
                            <button
                                type="button"
                                disabled={bulkBusy}
                                onClick={previewBulkDelete}
                                className="btn-secondary rounded-xl px-4 py-2 text-sm inline-flex items-center gap-2"
                            >
                                {bulkBusy && !bulkPreview ? <Loader2 size={14} className="animate-spin" /> : null}
                                Preview count
                            </button>
                            <button
                                type="button"
                                disabled={bulkBusy}
                                onClick={confirmBulkDelete}
                                className="rounded-xl px-4 py-2 text-sm font-medium inline-flex items-center gap-2 bg-rose-600 text-white hover:bg-rose-700 disabled:opacity-50 disabled:pointer-events-none"
                            >
                                {bulkBusy ? <Loader2 size={14} className="animate-spin" /> : <Trash2 size={14} />}
                                Delete {bulkPreview?.count ? `(${bulkPreview.count})` : ""}
                            </button>
                        </div>
                    </div>
                </div>,
                document.body
            )}
        </div>
    );
}

export default function DocumentsPage() {
    return (
        <Suspense fallback={<div className="p-6 text-slate-400 font-medium">Loading documents...</div>}>
            <DocumentsContent />
        </Suspense>
    );
}
