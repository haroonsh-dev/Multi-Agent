"use client";

import React, { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { motion } from "framer-motion";
import {
    Activity,
    ArrowLeft,
    Eye,
    FileText,
    Info,
    Loader2,
    RefreshCw,
    Search,
    Shield,
    Trash2,
    Share2,
    Users,
} from "lucide-react";
import FilterSelect from "@/components/FilterSelect";
import LibraryPagination from "@/components/LibraryPagination";
import ShareModal from "@/components/ShareModal";
import ChatWithDocumentLink from "@/components/ChatWithDocumentLink";
import { isGeneratedArtifactDoc, shouldShowChatWithDocument } from "@/lib/generatedDocuments";
import { PageHeader, EmptyState, Badge } from "@/components/ui";
import { usePermissions } from "@/context/PermissionsContext";
import { apiRequest } from "@/lib/apiClient";
import { getStoredUser } from "@/lib/authSession";
import { getFileTypeLabel } from "@/lib/fileValidation";

type MemberDetail = {
    department: { departmentId: string; name: string; description?: string };
    member: {
        userId: string;
        fullName: string;
        email: string;
        status: string;
        lastLogin?: string | null;
        createdAt?: string;
        joinedAt?: string;
        permissions: Record<string, boolean>;
        role: {
            roleId: string;
            name: string;
            description?: string;
            isLeader: boolean;
            rank: number;
            permissions?: Record<string, boolean>;
        } | null;
    };
    aggregates: {
        documents: { total: number; ready: number; processing: number; failed: number };
        activityTotal: number;
    };
    recentActivity: ActivityItem[];
    supervision: { viewerRank: number; targetRank: number };
};

type ActivityItem = {
    logId: string;
    actorUserId: string;
    actorRole: string;
    actorEmail?: string;
    actorName?: string;
    action: string;
    category: string;
    outcome: "success" | "failure";
    message?: string;
    createdAt: string;
};

type DocItem = {
    documentId: string;
    originalFilename: string;
    mimeType: string;
    sizeBytes: number;
    status: string;
    classification?: string | null;
    visibilityScope?: "personal" | "department" | null;
    createdAt: string;
    aiProcessingStatus?: string | null;
    aiErrorMessage?: string | null;
    pythonDocumentId?: string | null;
    metadata?: { cvScore?: number; phase3Agent?: string } | null;
};

type Pagination = { page: number; limit: number; total: number; totalPages: number };

const PERM_LABELS: Record<string, string> = {
    "document.upload": "Upload documents",
    "document.view": "View documents",
    "document.delete": "Delete documents",
    "document.share": "Share documents",
    "chat.use": "AI Chat",
    "org.documents.view": "View all org documents",
    "page.dashboard": "Dashboard",
    "page.documents": "Document Vault",
    "page.chat": "AI Assistant",
    "page.activity": "System Activity",
    "page.departments": "Department pages",
    "page.plans": "Subscriptions & Billing",
    "page.email_reports": "Automated Reports",
    "page.integrations": "Integrations",
    "page.settings": "AI Engine Config",
};

function formatBytes(n: number) {
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function statusBadge(status: string) {
    const s = status.toLowerCase();
    if (["ready", "processed", "completed", "complete", "done"].includes(s)) {
        return "bg-emerald-50 text-emerald-700 border-emerald-200";
    }
    if (["processing", "uploaded", "queued", "uploading"].includes(s)) {
        return "bg-amber-50 text-amber-700 border-amber-200";
    }
    if (s === "failed" || s.includes("fail") || s.includes("error")) {
        return "bg-rose-50 text-rose-700 border-rose-200";
    }
    return "bg-slate-50 text-slate-500 border-slate-200";
}

function StatCard({
    label,
    value,
    accent,
}: {
    label: string;
    value: string | number;
    accent: string;
}) {
    return (
        <div className={`stat-card ${accent} p-4`}>
            <p className="text-[10px] text-slate-400 font-semibold uppercase tracking-wider">{label}</p>
            <p className="text-xl font-bold text-slate-800 mt-1">{value}</p>
        </div>
    );
}

function MemberDetailContent() {
    const params = useParams();
    const departmentId = String(params?.id || "");
    const userId = String(params?.userId || "");
    const { canDeleteDocs, canShareDocs, canViewDocs } = usePermissions();
    const me = getStoredUser<{ userId?: string; orgRole?: { isLeader?: boolean } }>();

    const [detail, setDetail] = useState<MemberDetail | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [tab, setTab] = useState<"overview" | "activity" | "documents" | "access">("overview");

    const [activity, setActivity] = useState<ActivityItem[]>([]);
    const [activityTotal, setActivityTotal] = useState(0);
    const [activityPage, setActivityPage] = useState(1);
    const [activityCategory, setActivityCategory] = useState("");
    const [activityLoading, setActivityLoading] = useState(false);

    const [docs, setDocs] = useState<DocItem[]>([]);
    const [docPagination, setDocPagination] = useState<Pagination>({
        page: 1,
        limit: 10,
        total: 0,
        totalPages: 0,
    });
    const [docPage, setDocPage] = useState(1);
    const [docLimit, setDocLimit] = useState(10);
    const [docQ, setDocQ] = useState("");
    const [docSearchInput, setDocSearchInput] = useState("");
    const [docsLoading, setDocsLoading] = useState(false);
    const [sharingDoc, setSharingDoc] = useState<{ documentId: string; filename: string } | null>(null);

    const loadDetail = useCallback(async () => {
        if (!departmentId || !userId) return;
        setLoading(true);
        setError(null);
        try {
            const res = await apiRequest(`/docs/departments/${departmentId}/members/${userId}`);
            setDetail(res?.data || null);
        } catch (e: any) {
            setError(e.message || "Failed to load employee");
            setDetail(null);
        } finally {
            setLoading(false);
        }
    }, [departmentId, userId]);

    const loadActivity = useCallback(async () => {
        if (!userId) return;
        setActivityLoading(true);
        try {
            const params = new URLSearchParams({
                page: String(activityPage),
                limit: "20",
                actorUserId: userId,
            });
            if (activityCategory) params.set("category", activityCategory);
            const res = await apiRequest(`/docs/activity?${params}`);
            setActivity(res?.data?.logs || []);
            setActivityTotal(res?.data?.total || 0);
        } catch (e: any) {
            setActivity([]);
            setActivityTotal(0);
            setError(e.message || "Failed to load activity");
        } finally {
            setActivityLoading(false);
        }
    }, [userId, activityPage, activityCategory]);

    const loadDocs = useCallback(async () => {
        if (!userId || !canViewDocs()) return;
        setDocsLoading(true);
        try {
            const params = new URLSearchParams({
                page: String(docPage),
                limit: String(docLimit),
                uploadedBy: userId,
                departmentId,
                sortBy: "createdAt",
                sortOrder: "desc",
            });
            if (docQ) params.set("q", docQ);
            const res = await apiRequest(`/docs/documents?${params}`);
            setDocs(res?.data?.documents || []);
            setDocPagination(
                res?.data?.pagination || { page: 1, limit: docLimit, total: 0, totalPages: 0 }
            );
        } catch (e: any) {
            setDocs([]);
            setError(e.message || "Failed to load documents");
        } finally {
            setDocsLoading(false);
        }
    }, [userId, departmentId, docPage, docLimit, docQ, canViewDocs]);

    useEffect(() => {
        loadDetail();
    }, [loadDetail]);

    useEffect(() => {
        if (tab === "activity" || tab === "overview") loadActivity();
    }, [tab, loadActivity]);

    useEffect(() => {
        if (tab === "documents" || tab === "overview") loadDocs();
    }, [tab, loadDocs]);

    const initials = useMemo(() => {
        const name = detail?.member.fullName || "?";
        const parts = name.trim().split(/\s+/);
        if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
        return (parts[0]?.[0] || "?").toUpperCase();
    }, [detail]);

    const enabledPerms = useMemo(() => {
        const perms = detail?.member.permissions || {};
        return Object.entries(PERM_LABELS)
            .filter(([key]) => perms[key] === true)
            .map(([key, label]) => ({ key, label }));
    }, [detail]);

    const removeDocument = async (id: string, name: string) => {
        if (!confirm(`Delete "${name}" permanently?`)) return;
        try {
            await apiRequest(`/docs/documents/${id}`, { method: "DELETE" });
            await Promise.all([loadDocs(), loadDetail()]);
        } catch (e: any) {
            setError(e.message || "Delete failed");
        }
    };

    if (loading) {
        return (
            <div className="flex flex-col items-center justify-center py-24 gap-4">
                <div className="w-12 h-12 rounded-2xl bg-[rgba(56,182,255,0.1)] flex items-center justify-center">
                    <Loader2 className="h-6 w-6 animate-spin text-(--vb-blue-dark)" />
                </div>
                <p className="text-sm text-slate-500 font-medium">Loading employee details...</p>
            </div>
        );
    }

    if (!detail) {
        return (
            <div className="p-8 max-w-3xl mx-auto text-center space-y-4">
                <EmptyState
                    icon={<Users size={24} className="text-(--vb-blue-dark)" />}
                    title="Employee not available"
                    description={error || "You may not have permission to view this person."}
                />
                <Link href={`/departments/${departmentId}`} className="btn-secondary rounded-xl px-4 py-2.5 text-sm inline-flex items-center gap-2">
                    <ArrowLeft size={14} /> Back to department
                </Link>
            </div>
        );
    }

    const { member, aggregates, department } = detail;
    const tabs = [
        { id: "overview" as const, label: "Overview" },
        { id: "activity" as const, label: "Activity" },
        { id: "documents" as const, label: "Documents" },
        { id: "access" as const, label: "Access" },
    ];

    return (
        <div className="p-4 sm:p-6 lg:p-8 max-w-7xl mx-auto space-y-6">
            <motion.div initial={{ opacity: 0, y: -10 }} animate={{ opacity: 1, y: 0 }}>
                <div className="mb-4">
                    <Link
                        href={`/departments/${departmentId}`}
                        className="inline-flex items-center gap-1.5 text-xs font-medium text-slate-500 hover:text-(--vb-blue-dark)"
                    >
                        <ArrowLeft size={13} /> {department.name}
                    </Link>
                </div>
                <PageHeader
                    title={member.fullName}
                    subtitle={`${member.email} · ${department.name}`}
                    actions={
                        <button
                            type="button"
                            onClick={() => {
                                loadDetail();
                                loadActivity();
                                loadDocs();
                            }}
                            className="btn-secondary rounded-xl px-4 py-2.5 text-sm inline-flex items-center gap-2"
                        >
                            <RefreshCw size={14} /> Refresh
                        </button>
                    }
                />
            </motion.div>

            <motion.div
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                className="surface-card p-5 flex flex-col sm:flex-row sm:items-center gap-4"
            >
                <div className="h-14 w-14 rounded-2xl bg-(--vb-blue) text-(--vb-color-primary-btn-fg) flex items-center justify-center text-lg font-bold shadow-(--vb-glow)">
                    {initials}
                </div>
                <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                        <h2 className="text-base font-bold text-slate-800 truncate">{member.fullName}</h2>
                        <Badge variant={member.status === "blocked" ? "error" : "success"}>
                            {member.status || "active"}
                        </Badge>
                        {member.role && (
                            <Badge variant="accent">
                                {member.role.name} · Rank {member.role.rank}
                            </Badge>
                        )}
                        {member.role?.isLeader && <Badge variant="warning">Leader flag</Badge>}
                    </div>
                    <p className="text-xs text-slate-500 mt-1">
                        Joined{" "}
                        {member.joinedAt ? new Date(member.joinedAt).toLocaleDateString() : "—"}
                        {member.lastLogin
                            ? ` · Last login ${new Date(member.lastLogin).toLocaleString()}`
                            : " · No login yet"}
                    </p>
                </div>
            </motion.div>

            <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
                <StatCard label="Documents" value={aggregates.documents.total} accent="blue" />
                <StatCard label="Ready" value={aggregates.documents.ready} accent="emerald" />
                <StatCard label="Processing / failed" value={`${aggregates.documents.processing} / ${aggregates.documents.failed}`} accent="amber" />
                <StatCard label="Activity events" value={aggregates.activityTotal} accent="violet" />
            </div>

            {error && (
                <div className="rounded-xl border border-rose-200 bg-rose-50 text-rose-700 px-4 py-3 text-sm">
                    {error}
                </div>
            )}

            <div className="flex flex-wrap gap-2 border-b border-slate-200 pb-2">
                {tabs.map((t) => (
                    <button
                        key={t.id}
                        type="button"
                        onClick={() => setTab(t.id)}
                        className={`px-3.5 py-2 rounded-xl text-sm font-medium transition-colors ${
                            tab === t.id
                                ? "bg-[rgba(56,182,255,0.1)] text-(--vb-blue-dark) border border-[rgba(56,182,255,0.28)]"
                                : "text-slate-500 hover:bg-slate-50 border border-transparent"
                        }`}
                    >
                        {t.label}
                    </button>
                ))}
            </div>

            {tab === "overview" && (
                <div className="grid lg:grid-cols-2 gap-4">
                    <div className="surface-card overflow-hidden">
                        <div className="px-5 py-4 border-b border-slate-100 flex items-center gap-2">
                            <Activity size={15} className="text-violet-600" />
                            <h3 className="text-sm font-bold text-slate-800">Recent activity</h3>
                        </div>
                        {activityLoading ? (
                            <div className="p-6 text-sm text-slate-500">Loading…</div>
                        ) : activity.length === 0 ? (
                            <EmptyState
                                icon={<Activity size={20} />}
                                title="No activity yet"
                                description="Actions by this employee will appear here."
                            />
                        ) : (
                            <ul className="divide-y divide-slate-100">
                                {activity.slice(0, 6).map((log) => (
                                    <li key={log.logId} className="px-5 py-3">
                                        <p className="text-sm text-slate-800 font-medium">
                                            {log.message || log.action}
                                        </p>
                                        <p className="text-[11px] text-slate-400 mt-0.5">
                                            {log.category} · {new Date(log.createdAt).toLocaleString()}
                                            {log.outcome === "failure" ? " · failed" : ""}
                                        </p>
                                    </li>
                                ))}
                            </ul>
                        )}
                    </div>
                    <div className="surface-card overflow-hidden">
                        <div className="px-5 py-4 border-b border-slate-100 flex items-center gap-2">
                            <FileText size={15} className="text-(--vb-blue-dark)" />
                            <h3 className="text-sm font-bold text-slate-800">Recent documents</h3>
                        </div>
                        {docsLoading ? (
                            <div className="p-6 text-sm text-slate-500">Loading…</div>
                        ) : docs.length === 0 ? (
                            <EmptyState
                                icon={<FileText size={20} />}
                                title="No documents"
                                description="Uploads by this employee will appear here."
                            />
                        ) : (
                            <ul className="divide-y divide-slate-100">
                                {docs.slice(0, 6).map((doc) => (
                                    <li key={doc.documentId} className="px-5 py-3 flex items-center justify-between gap-3">
                                        <div className="min-w-0">
                                            <p className="text-sm font-medium text-slate-800 truncate">
                                                {doc.originalFilename}
                                            </p>
                                            <p className="text-[11px] text-slate-400 mt-0.5">
                                                {doc.status} · {new Date(doc.createdAt).toLocaleString()}
                                            </p>
                                        </div>
                                        <Link
                                            href={`/documents/details?doc=${doc.documentId}`}
                                            className="text-xs font-medium text-(--vb-blue-dark) shrink-0"
                                        >
                                            Details
                                        </Link>
                                    </li>
                                ))}
                            </ul>
                        )}
                    </div>
                </div>
            )}

            {tab === "activity" && (
                <div className="surface-card overflow-hidden">
                    <div className="px-5 py-4 border-b border-slate-100 flex flex-wrap items-center gap-3 justify-between">
                        <h3 className="text-sm font-bold text-slate-800">Activity timeline</h3>
                        <FilterSelect
                            label="Category"
                            value={activityCategory}
                            onChange={(v) => {
                                setActivityCategory(v);
                                setActivityPage(1);
                            }}
                            options={[
                                { value: "", label: "All categories" },
                                { value: "auth", label: "Auth" },
                                { value: "document", label: "Documents" },
                                { value: "chat", label: "Chat" },
                                { value: "team", label: "Team" },
                                { value: "department", label: "Department" },
                            ]}
                            minWidth="w-44"
                        />
                    </div>
                    {activityLoading ? (
                        <div className="p-8 text-center text-sm text-slate-500">Loading activity…</div>
                    ) : activity.length === 0 ? (
                        <EmptyState
                            icon={<Activity size={22} />}
                            title="No matching activity"
                            description="Try another category or check back later."
                        />
                    ) : (
                        <ul className="divide-y divide-slate-100">
                            {activity.map((log) => (
                                <li key={log.logId} className="px-5 py-4">
                                    <div className="flex items-start justify-between gap-3">
                                        <div className="min-w-0">
                                            <p className="text-sm font-medium text-slate-800">
                                                {log.message || log.action}
                                            </p>
                                            <p className="text-[11px] text-slate-400 mt-1">
                                                {log.action} · {log.category} ·{" "}
                                                {new Date(log.createdAt).toLocaleString()}
                                            </p>
                                        </div>
                                        <span
                                            className={`text-[10px] font-semibold uppercase px-2 py-0.5 rounded-full border shrink-0 ${
                                                log.outcome === "failure"
                                                    ? "bg-rose-50 text-rose-700 border-rose-200"
                                                    : "bg-emerald-50 text-emerald-700 border-emerald-200"
                                            }`}
                                        >
                                            {log.outcome}
                                        </span>
                                    </div>
                                </li>
                            ))}
                        </ul>
                    )}
                    <LibraryPagination
                        page={activityPage}
                        limit={20}
                        total={activityTotal}
                        totalPages={Math.max(1, Math.ceil(activityTotal / 20))}
                        onPageChange={setActivityPage}
                        onLimitChange={() => undefined}
                        borderClass="border-slate-200"
                        textMutedClass="text-slate-500"
                    />
                </div>
            )}

            {tab === "documents" && (
                <div className="surface-card overflow-hidden">
                    <div className="px-5 py-4 border-b border-slate-100 space-y-3">
                        <h3 className="text-sm font-bold text-slate-800">Uploaded & managed documents</h3>
                        <div className="flex flex-col sm:flex-row gap-2">
                            <div className="relative flex-1">
                                <Search
                                    size={15}
                                    className="absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-400"
                                />
                                <input
                                    value={docSearchInput}
                                    onChange={(e) => setDocSearchInput(e.target.value)}
                                    onKeyDown={(e) => {
                                        if (e.key === "Enter") {
                                            setDocQ(docSearchInput.trim());
                                            setDocPage(1);
                                        }
                                    }}
                                    placeholder="Search by filename…"
                                    className="w-full premium-input rounded-xl py-2.5 pl-10 pr-4 text-sm h-11"
                                />
                            </div>
                            <button
                                type="button"
                                onClick={() => {
                                    setDocQ(docSearchInput.trim());
                                    setDocPage(1);
                                }}
                                className="btn-gradient rounded-xl px-5 text-sm h-11"
                            >
                                Search
                            </button>
                        </div>
                    </div>
                    {docsLoading ? (
                        <div className="p-8 text-center text-sm text-slate-500">Loading documents…</div>
                    ) : docs.length === 0 ? (
                        <EmptyState
                            icon={<FileText size={22} />}
                            title="No documents found"
                            description="This employee has not uploaded matching files."
                        />
                    ) : (
                        <ul className="divide-y divide-slate-100">
                            {docs.map((doc) => (
                                <li
                                    key={doc.documentId}
                                    className="px-4 sm:px-5 py-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3"
                                >
                                    <div className="min-w-0">
                                        <div className="flex items-center gap-2 flex-wrap">
                                            <p className="text-sm font-medium text-slate-800 truncate">
                                                {doc.originalFilename}
                                            </p>
                                            <span
                                                className={`inline-flex px-2 py-0.5 rounded-full text-[10px] font-semibold uppercase border ${statusBadge(
                                                    doc.status
                                                )}`}
                                            >
                                                {doc.status}
                                            </span>
                                            {doc.metadata?.cvScore != null && (
                                                <span className="text-[10px] font-bold text-slate-600">
                                                    Score {doc.metadata.cvScore}
                                                </span>
                                            )}
                                        </div>
                                        <p className="text-xs text-slate-500 mt-1">
                                            {getFileTypeLabel(doc.mimeType, doc.originalFilename)} ·{" "}
                                            {formatBytes(doc.sizeBytes)} ·{" "}
                                            {new Date(doc.createdAt).toLocaleString()}
                                            {doc.classification ? ` · ${doc.classification}` : ""}
                                            {doc.visibilityScope ? ` · ${doc.visibilityScope}` : ""}
                                        </p>
                                    </div>
                                    <div className="flex gap-2 flex-wrap">
                                        <ChatWithDocumentLink
                                            documentId={doc.documentId}
                                            ready={!!doc.pythonDocumentId}
                                            hidden={!shouldShowChatWithDocument(doc)}
                                        />
                                        <Link
                                            href={
                                                isGeneratedArtifactDoc(doc)
                                                    ? `/documents/${doc.documentId}`
                                                    : `/documents/details?doc=${doc.documentId}`
                                            }
                                            className="btn-secondary rounded-lg px-3 py-2 text-sm inline-flex items-center gap-1.5"
                                        >
                                            <Info size={14} /> {isGeneratedArtifactDoc(doc) ? "Open PDF" : "Details"}
                                        </Link>
                                        <Link
                                            href={`/documents/${doc.documentId}`}
                                            className="btn-secondary rounded-lg px-3 py-2 text-sm inline-flex items-center gap-1.5"
                                        >
                                            <Eye size={14} /> Preview
                                        </Link>
                                        {canDeleteDocs() && (
                                            <button
                                                type="button"
                                                onClick={() =>
                                                    removeDocument(doc.documentId, doc.originalFilename)
                                                }
                                                className="btn-ghost rounded-lg px-3 py-2 text-sm text-rose-500 inline-flex items-center gap-1.5"
                                            >
                                                <Trash2 size={14} /> Delete
                                            </button>
                                        )}
                                        {(canShareDocs() || me?.orgRole?.isLeader) && (
                                            <button
                                                type="button"
                                                onClick={() =>
                                                    setSharingDoc({
                                                        documentId: doc.documentId,
                                                        filename: doc.originalFilename,
                                                    })
                                                }
                                                className="btn-secondary rounded-lg px-3 py-2 text-sm inline-flex items-center gap-1.5"
                                            >
                                                <Share2 size={14} /> Share
                                            </button>
                                        )}
                                    </div>
                                </li>
                            ))}
                        </ul>
                    )}
                    <LibraryPagination
                        page={docPagination.page}
                        limit={docPagination.limit}
                        total={docPagination.total}
                        totalPages={docPagination.totalPages}
                        onPageChange={setDocPage}
                        onLimitChange={(l) => {
                            setDocLimit(l);
                            setDocPage(1);
                        }}
                        borderClass="border-slate-200"
                        textMutedClass="text-slate-500"
                    />
                </div>
            )}

            {tab === "access" && (
                <div className="surface-card p-5 space-y-4">
                    <div className="flex items-center gap-2">
                        <Shield size={16} className="text-(--vb-blue-dark)" />
                        <h3 className="text-sm font-bold text-slate-800">Effective access</h3>
                    </div>
                    <div className="grid sm:grid-cols-2 gap-3 text-sm">
                        <div className="rounded-xl border border-slate-200 bg-slate-50/60 p-4">
                            <p className="text-[11px] uppercase tracking-wider text-slate-400 font-semibold">
                                Role
                            </p>
                            <p className="font-semibold text-slate-800 mt-1">
                                {member.role?.name || "Unassigned"}
                            </p>
                            <p className="text-xs text-slate-500 mt-1">
                                Rank {member.role?.rank ?? "—"}
                                {member.role?.isLeader ? " · Leader privacy enabled" : ""}
                            </p>
                            {member.role?.description && (
                                <p className="text-xs text-slate-500 mt-2">{member.role.description}</p>
                            )}
                        </div>
                        <div className="rounded-xl border border-slate-200 bg-slate-50/60 p-4">
                            <p className="text-[11px] uppercase tracking-wider text-slate-400 font-semibold">
                                Supervision
                            </p>
                            <p className="font-semibold text-slate-800 mt-1">
                                Your rank {detail.supervision.viewerRank} → their rank{" "}
                                {detail.supervision.targetRank}
                            </p>
                            <p className="text-xs text-slate-500 mt-1">
                                Read-only view of permissions. Manage actions still follow your own
                                document permissions.
                            </p>
                        </div>
                    </div>
                    <div>
                        <p className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-2">
                            Enabled permissions
                        </p>
                        <div className="flex flex-wrap gap-2">
                            {enabledPerms.length ? (
                                enabledPerms.map((p) => (
                                    <Badge key={p.key} variant="default">
                                        {p.label}
                                    </Badge>
                                ))
                            ) : (
                                <p className="text-sm text-slate-500">No permissions enabled.</p>
                            )}
                        </div>
                    </div>
                </div>
            )}

            {sharingDoc && (
                <ShareModal
                    documentId={sharingDoc.documentId}
                    filename={sharingDoc.filename}
                    currentDepartmentId={departmentId}
                    open={true}
                    onClose={() => setSharingDoc(null)}
                    onShared={() => {
                        loadDocs();
                        loadDetail();
                    }}
                />
            )}
        </div>
    );
}

export default function DepartmentMemberPage() {
    return <MemberDetailContent />;
}
