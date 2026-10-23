"use client";

import React from "react";
import { FileText, Folder, Trash2 } from "lucide-react";
import { agentLabel, docTypeLabel, resolveDocAgent } from "@/lib/documentAgents";
import ChatWithDocumentLink from "@/components/ChatWithDocumentLink";
import { shouldShowChatWithDocument } from "@/lib/generatedDocuments";

export type FolderTreeDoc = {
    documentId: string;
    originalFilename: string;
    status: string;
    classification?: string | null;
    pythonDocumentId?: string | null;
    metadata?: { phase3Agent?: string; cvScore?: number; generatedVia?: string; source?: string } | null;
};

type DocumentFolderTreeProps = {
    docs: FolderTreeDoc[];
    onSelectDoc: (documentId: string) => void;
    selectedDocId?: string;
    agentFilter?: string;
    search?: string;
    onDelete?: (documentId: string, filename: string) => void;
};

function statusBadgeClass(status: string) {
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

function statusLabel(status: string) {
    if (status === "ready") return "processed";
    if (status === "uploaded") return "processing";
    return status;
}

function scoreBadgeClass(score: number) {
    if (score >= 70) return "bg-emerald-50 text-emerald-700 border-emerald-200";
    if (score >= 40) return "bg-amber-50 text-amber-700 border-amber-200";
    return "bg-rose-50 text-rose-700 border-rose-200";
}

const AGENT_ORDER = [
    "finance_agent",
    "procurement_agent",
    "hr_agent",
    "legal_agent",
    "compliance_agent",
    "other_agent",
];

export default function DocumentFolderTree({
    docs,
    onSelectDoc,
    selectedDocId,
    agentFilter,
    search = "",
    onDelete,
}: DocumentFolderTreeProps) {
    const q = search.trim().toLowerCase();
    const tree: Record<string, Record<string, FolderTreeDoc[]>> = {};

    for (const d of docs) {
        if (q && !d.originalFilename.toLowerCase().includes(q)) continue;
        const agent = resolveDocAgent(d);
        if (agentFilter && agent !== agentFilter) continue;
        const type = d.classification || "unclassified";
        (tree[agent] ||= {})[type] ||= [];
        tree[agent][type].push(d);
    }

    const visibleAgents = AGENT_ORDER.filter((a) => tree[a] && Object.keys(tree[a]).length > 0);
    for (const a of Object.keys(tree)) {
        if (!visibleAgents.includes(a)) visibleAgents.push(a);
    }

    if (visibleAgents.length === 0) {
        return (
            <p className="text-center text-xs text-slate-400 py-10">No documents in this view</p>
        );
    }

    return (
        <div className="p-3 space-y-1.5">
            {visibleAgents.map((agent) => {
                const types = Object.keys(tree[agent]).sort((a, b) => {
                    if (a === "unclassified") return 1;
                    if (b === "unclassified") return -1;
                    return a.localeCompare(b);
                });
                const total = types.reduce((s, t) => s + tree[agent][t].length, 0);
                return (
                    <details key={agent} className="rounded-xl border border-slate-200 overflow-hidden bg-white" open>
                        <summary className="px-3 py-2.5 cursor-pointer hover:bg-slate-50 transition-colors flex items-center gap-2 text-sm font-semibold text-slate-800 list-none">
                            <Folder size={14} className="text-(--vb-blue-dark) shrink-0" />
                            <span className="flex-1 truncate">{agentLabel(agent)}</span>
                            <span className="inline-flex px-1.5 py-0.5 rounded-full text-[10px] font-semibold bg-slate-100 text-slate-500 border border-slate-200">
                                {total}
                            </span>
                        </summary>
                        <div className="px-2 pb-2 space-y-1">
                            {types.map((type) => {
                                const typeDocs = tree[agent][type]
                                    .slice()
                                    .sort((a, b) => {
                                        const isResume =
                                            type === "resume" || type === "cv" || a.classification === "resume";
                                        if (isResume) {
                                            const sa = a.metadata?.cvScore ?? -1;
                                            const sb = b.metadata?.cvScore ?? -1;
                                            if (sa !== sb) return sb - sa;
                                        }
                                        return a.originalFilename.localeCompare(b.originalFilename);
                                    });
                                return (
                                    <details
                                        key={type}
                                        className="rounded-lg bg-slate-50/80 border border-slate-100 overflow-hidden"
                                        open
                                    >
                                        <summary className="px-2.5 py-1.5 cursor-pointer hover:bg-slate-100 transition-colors flex items-center gap-2 text-xs font-medium text-slate-700 list-none">
                                            <span className="flex-1 truncate">{docTypeLabel(type)}</span>
                                            <span className="inline-flex px-1.5 py-0.5 rounded-full text-[10px] font-semibold bg-white text-slate-500 border border-slate-200">
                                                {typeDocs.length}
                                            </span>
                                        </summary>
                                        <div className="px-1.5 pb-1.5 space-y-0.5">
                                            {typeDocs.map((d) => {
                                                const selected = selectedDocId === d.documentId;
                                                const cv = d.metadata?.cvScore;
                                                return (
                                                    <div key={d.documentId} className="flex items-center gap-1 group">
                                                        <button
                                                            type="button"
                                                            onClick={() => onSelectDoc(d.documentId)}
                                                            className={`flex-1 flex items-center justify-between gap-2 px-2.5 py-1.5 rounded-lg border text-left transition-all ${
                                                                selected
                                                                    ? "border-[rgba(56,182,255,0.4)] bg-[rgba(56,182,255,0.08)]"
                                                                    : "border-transparent hover:bg-white hover:border-slate-200"
                                                            }`}
                                                        >
                                                            <span className="flex items-center gap-1.5 min-w-0">
                                                                <FileText
                                                                    size={12}
                                                                    className={`shrink-0 ${selected ? "text-(--vb-blue-dark)" : "text-slate-400"}`}
                                                                />
                                                                <span className="text-xs text-slate-700 truncate">
                                                                    {d.originalFilename}
                                                                </span>
                                                            </span>
                                                            <span className="flex items-center gap-1 shrink-0">
                                                                {cv != null && (
                                                                    <span
                                                                        className={`inline-flex px-1.5 py-0.5 rounded-full text-[9px] font-bold border ${scoreBadgeClass(cv)}`}
                                                                    >
                                                                        {cv}
                                                                    </span>
                                                                )}
                                                                <span
                                                                    className={`inline-flex px-1.5 py-0.5 rounded-full text-[9px] font-semibold uppercase border ${statusBadgeClass(d.status)}`}
                                                                >
                                                                    {statusLabel(d.status)}
                                                                </span>
                                                            </span>
                                                        </button>
                                                        <ChatWithDocumentLink
                                                            documentId={d.documentId}
                                                            ready={!!d.pythonDocumentId}
                                                            hidden={!shouldShowChatWithDocument(d)}
                                                            compact
                                                            className="p-1.5 min-h-0 opacity-0 group-hover:opacity-100"
                                                        />
                                                        {onDelete && (
                                                            <button
                                                                type="button"
                                                                onClick={() => onDelete(d.documentId, d.originalFilename)}
                                                                className="p-1.5 rounded-md text-slate-300 hover:text-rose-500 hover:bg-rose-50 transition-all opacity-0 group-hover:opacity-100"
                                                                title="Delete document"
                                                            >
                                                                <Trash2 size={13} />
                                                            </button>
                                                        )}
                                                    </div>
                                                );
                                            })}
                                        </div>
                                    </details>
                                );
                            })}
                        </div>
                    </details>
                );
            })}
        </div>
    );
}
