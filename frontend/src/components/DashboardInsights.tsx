"use client";

import Link from "next/link";
import { motion } from "framer-motion";
import {
    Activity,
    ArrowRight,
    CheckCircle2,
    FileText,
    FolderOpen,
    Gauge,
} from "lucide-react";
import { EmptyState, StatusBadge } from "@/components/ui";
import ChatWithDocumentLink from "@/components/ChatWithDocumentLink";
import { shouldShowChatWithDocument } from "@/lib/generatedDocuments";

type DashboardDocument = {
    documentId: string;
    originalFilename?: string;
    status?: string;
    classification?: string | null;
    mimeType?: string;
    sizeBytes?: number;
    createdAt?: string;
    pythonDocumentId?: string | null;
};

type DashboardActivity = {
    logId: string;
    action?: string;
    category?: string;
    message?: string;
    outcome?: string;
    actorName?: string;
    createdAt?: string;
};

type Props = {
    documents: DashboardDocument[];
    activity: DashboardActivity[];
    loading?: boolean;
    isAdminView?: boolean;
};

function formatBytes(value: number) {
    if (value < 1024) return `${value} B`;
    if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
    if (value < 1024 * 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(1)} MB`;
    return `${(value / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

function documentType(doc: DashboardDocument) {
    if (doc.classification) return doc.classification;
    const filename = doc.originalFilename || "";
    const extension = filename.includes(".") ? filename.split(".").pop() : "";
    if (extension) return extension.toUpperCase();
    const subtype = (doc.mimeType || "").split("/").pop();
    return subtype ? subtype.toUpperCase() : "Other";
}

function LoadingRows() {
    return (
        <div className="p-5 space-y-3">
            {[0, 1, 2].map((item) => (
                <div key={item} className="h-12 rounded-xl bg-slate-100 animate-pulse" />
            ))}
        </div>
    );
}

export default function DashboardInsights({
    documents,
    activity,
    loading = false,
    isAdminView = false,
}: Props) {
    const recentDocuments = documents.slice(0, 5);
    const recentActivity = activity.slice(0, 5);
    const totalBytes = documents.reduce((sum, doc) => sum + Number(doc.sizeBytes || 0), 0);
    const completed = documents.filter((doc) =>
        ["ready", "processed", "completed", "done"].includes((doc.status || "").toLowerCase())
    ).length;
    const completionRate = documents.length ? Math.round((completed / documents.length) * 100) : 0;

    const typeCounts: Record<string, number> = {};
    documents.forEach((doc) => {
        const type = documentType(doc);
        typeCounts[type] = (typeCounts[type] || 0) + 1;
    });
    const fileTypes = Object.entries(typeCounts)
        .map(([name, count]) => ({ name, count }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 5);
    const maxTypeCount = Math.max(1, ...fileTypes.map((item) => item.count));

    return (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
            <motion.section
                initial={{ opacity: 0, y: 16 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.25 }}
                className="surface-card overflow-hidden"
            >
                <div className="px-5 py-4 border-b border-slate-100 flex items-center justify-between">
                    <div className="flex items-center gap-3">
                        <div className="icon-box blue">
                            <Gauge size={17} />
                        </div>
                        <div>
                            <h3 className="text-sm font-bold text-slate-800">
                                {isAdminView ? "Workspace Health" : "My Workspace Health"}
                            </h3>
                            <p className="text-[11px] text-slate-400 mt-0.5">
                                Processing completion and storage footprint
                            </p>
                        </div>
                    </div>
                </div>
                {loading ? (
                    <LoadingRows />
                ) : (
                    <div className="p-5 flex flex-col sm:flex-row items-center gap-6">
                        <div
                            className="relative h-28 w-28 rounded-full flex items-center justify-center shrink-0"
                            style={{
                                background: `conic-gradient(#38b6ff ${completionRate * 3.6}deg, #e2e8f0 0deg)`,
                            }}
                        >
                            <div className="h-20 w-20 rounded-full bg-white flex flex-col items-center justify-center shadow-inner">
                                <span className="text-2xl font-bold text-slate-800">
                                    {completionRate}%
                                </span>
                                <span className="text-[9px] font-semibold uppercase tracking-wider text-slate-400">
                                    complete
                                </span>
                            </div>
                        </div>
                        <div className="grid grid-cols-2 gap-3 w-full">
                            <div className="rounded-xl border border-slate-100 bg-slate-50 p-3">
                                <p className="text-[10px] uppercase tracking-wider font-semibold text-slate-400">
                                    Completed
                                </p>
                                <p className="text-xl font-bold text-slate-800 mt-1">{completed}</p>
                            </div>
                            <div className="rounded-xl border border-slate-100 bg-slate-50 p-3">
                                <p className="text-[10px] uppercase tracking-wider font-semibold text-slate-400">
                                    Total storage
                                </p>
                                <p className="text-xl font-bold text-slate-800 mt-1">
                                    {formatBytes(totalBytes)}
                                </p>
                            </div>
                            <div className="col-span-2 rounded-xl border border-emerald-100 bg-emerald-50/60 p-3 flex items-center gap-2">
                                <CheckCircle2 size={15} className="text-emerald-600 shrink-0" />
                                <p className="text-xs font-medium text-emerald-800">
                                    {documents.length
                                        ? `${completed} of ${documents.length} documents are ready to use`
                                        : "Upload documents to start building your workspace"}
                                </p>
                            </div>
                        </div>
                    </div>
                )}
            </motion.section>

            <motion.section
                initial={{ opacity: 0, y: 16 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.3 }}
                className="surface-card overflow-hidden"
            >
                <div className="px-5 py-4 border-b border-slate-100 flex items-center justify-between">
                    <div className="flex items-center gap-3">
                        <div className="icon-box cyan">
                            <FolderOpen size={17} />
                        </div>
                        <div>
                            <h3 className="text-sm font-bold text-slate-800">File Type Mix</h3>
                            <p className="text-[11px] text-slate-400 mt-0.5">
                                Most common document categories
                            </p>
                        </div>
                    </div>
                </div>
                {loading ? (
                    <LoadingRows />
                ) : fileTypes.length === 0 ? (
                    <EmptyState
                        icon={<FolderOpen size={22} />}
                        title="No file types yet"
                        description="Your document mix will appear after uploads."
                    />
                ) : (
                    <div className="p-5 space-y-4">
                        {fileTypes.map((item, index) => (
                            <div key={item.name}>
                                <div className="flex items-center justify-between text-xs mb-1.5">
                                    <span className="font-semibold text-slate-600 capitalize">
                                        {item.name}
                                    </span>
                                    <span className="font-bold text-slate-800">{item.count}</span>
                                </div>
                                <div className="h-2 rounded-full bg-slate-100 overflow-hidden">
                                    <motion.div
                                        initial={{ width: 0 }}
                                        animate={{ width: `${(item.count / maxTypeCount) * 100}%` }}
                                        transition={{ delay: 0.35 + index * 0.06, duration: 0.55 }}
                                        className={`h-full rounded-full ${
                                            [
                                                "bg-[rgba(56,182,255,0.1)]",
                                                "bg-blue-500",
                                                "bg-violet-500",
                                                "bg-amber-500",
                                                "bg-rose-500",
                                            ][index]
                                        }`}
                                    />
                                </div>
                            </div>
                        ))}
                    </div>
                )}
            </motion.section>

            <motion.section
                initial={{ opacity: 0, y: 16 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.35 }}
                className="surface-card overflow-hidden"
            >
                <div className="px-5 py-4 border-b border-slate-100 flex items-center justify-between">
                    <div className="flex items-center gap-3">
                        <div className="icon-box emerald">
                            <FileText size={17} />
                        </div>
                        <div>
                            <h3 className="text-sm font-bold text-slate-800">Recent Documents</h3>
                            <p className="text-[11px] text-slate-400 mt-0.5">
                                {isAdminView ? "Latest organization uploads" : "Your latest uploads"}
                            </p>
                        </div>
                    </div>
                    <Link
                        href="/documents"
                        className="text-xs font-semibold text-(--vb-blue-dark) hover:text-(--vb-blue-dark) inline-flex items-center gap-1"
                    >
                        View all <ArrowRight size={12} />
                    </Link>
                </div>
                {loading ? (
                    <LoadingRows />
                ) : recentDocuments.length === 0 ? (
                    <EmptyState
                        icon={<FileText size={22} />}
                        title="No recent documents"
                        description="New uploads will appear here."
                    />
                ) : (
                    <ul className="divide-y divide-slate-100">
                        {recentDocuments.map((doc) => (
                            <li
                                key={doc.documentId}
                                className="px-5 py-3.5 flex items-center gap-2 hover:bg-slate-50/70 transition-colors"
                            >
                                <Link
                                    href={`/documents/details?doc=${doc.documentId}`}
                                    className="flex items-center gap-3 min-w-0 flex-1"
                                >
                                    <div className="h-9 w-9 rounded-xl bg-[rgba(56,182,255,0.1)] text-(--vb-blue-dark) flex items-center justify-center shrink-0">
                                        <FileText size={15} />
                                    </div>
                                    <div className="min-w-0 flex-1">
                                        <p className="text-sm font-semibold text-slate-700 truncate">
                                            {doc.originalFilename || doc.documentId}
                                        </p>
                                        <p className="text-[11px] text-slate-400 mt-0.5">
                                            {doc.createdAt
                                                ? new Date(doc.createdAt).toLocaleString()
                                                : "Recently uploaded"}
                                        </p>
                                    </div>
                                    <StatusBadge status={doc.status || "uploaded"} />
                                </Link>
                                <ChatWithDocumentLink
                                    documentId={doc.documentId}
                                    ready={!!doc.pythonDocumentId}
                                    hidden={!shouldShowChatWithDocument(doc)}
                                    compact
                                    className="shrink-0 px-2.5"
                                />
                            </li>
                        ))}
                    </ul>
                )}
            </motion.section>

            <motion.section
                initial={{ opacity: 0, y: 16 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.4 }}
                className="surface-card overflow-hidden"
            >
                <div className="px-5 py-4 border-b border-slate-100 flex items-center justify-between">
                    <div className="flex items-center gap-3">
                        <div className="icon-box violet">
                            <Activity size={17} />
                        </div>
                        <div>
                            <h3 className="text-sm font-bold text-slate-800">Recent Activity</h3>
                            <p className="text-[11px] text-slate-400 mt-0.5">
                                {isAdminView ? "Latest workspace events" : "Your latest actions"}
                            </p>
                        </div>
                    </div>
                    <Link
                        href="/activity"
                        className="text-xs font-semibold text-violet-600 hover:text-violet-700 inline-flex items-center gap-1"
                    >
                        Timeline <ArrowRight size={12} />
                    </Link>
                </div>
                {loading ? (
                    <LoadingRows />
                ) : recentActivity.length === 0 ? (
                    <EmptyState
                        icon={<Activity size={22} />}
                        title="No recent activity"
                        description="Your latest actions will appear here."
                    />
                ) : (
                    <ul className="divide-y divide-slate-100">
                        {recentActivity.map((item) => (
                            <li key={item.logId} className="px-5 py-3.5 flex items-start gap-3">
                                <div
                                    className={`mt-1.5 h-2.5 w-2.5 rounded-full shrink-0 ${
                                        item.outcome === "failure" ? "bg-rose-500" : "bg-violet-500"
                                    }`}
                                />
                                <div className="min-w-0 flex-1">
                                    <p className="text-sm font-medium text-slate-700 line-clamp-1">
                                        {item.message || item.action || "Workspace activity"}
                                    </p>
                                    <p className="text-[11px] text-slate-400 mt-1">
                                        {isAdminView && item.actorName ? `${item.actorName} · ` : ""}
                                        {item.category || "activity"}
                                        {item.createdAt
                                            ? ` · ${new Date(item.createdAt).toLocaleString()}`
                                            : ""}
                                    </p>
                                </div>
                            </li>
                        ))}
                    </ul>
                )}
            </motion.section>
        </div>
    );
}
