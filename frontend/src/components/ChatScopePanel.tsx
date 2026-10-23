"use client";

import React, { useEffect, useRef } from "react";
import { CheckSquare, Square, Search, X, Folder, FileText } from "lucide-react";
import { cn } from "@/lib/utils";
import { agentLabel, docTypeLabel, resolveDocAgent } from "@/lib/documentAgents";

export type ChatScope = "all" | "selected";
export type DocStatusFilter = "" | "ready" | "processing" | "failed";

export type ScopeLibraryDoc = {
    documentId: string;
    originalFilename: string;
    status: string;
    pythonDocumentId?: string | null;
    classification?: string | null;
    mimeType?: string;
    metadata?: { phase3Agent?: string; cvScore?: number } | null;
};

type ChatScopePanelProps = {
    open: boolean;
    onClose: () => void;
    chatScope: ChatScope;
    onChatScopeChange: (scope: ChatScope) => void;
    filteredDocs: ScopeLibraryDoc[];
    selectedDocIds: string[];
    onToggleDoc: (id: string) => void;
    onToggleFolder?: (ids: string[]) => void;
    onSelectAll: () => void;
    onClearSelection: () => void;
    onFocusDoc?: (id: string) => void;
    docSearch: string;
    onDocSearchChange: (v: string) => void;
    docStatusFilter: DocStatusFilter;
    onDocStatusFilterChange: (v: DocStatusFilter) => void;
    unprocessedCount: number;
    libraryCount: number;
    selectableCount: number;
    offPlanCount?: number;
    textPrimary: string;
    textMuted: string;
    textSecondary: string;
    bgHover: string;
};

const AGENT_ORDER = [
    "finance_agent",
    "procurement_agent",
    "hr_agent",
    "legal_agent",
    "compliance_agent",
    "other_agent",
];

function FolderCheckbox({
    checked,
    indeterminate,
    onChange,
}: {
    checked: boolean;
    indeterminate: boolean;
    onChange: () => void;
}) {
    const ref = useRef<HTMLInputElement>(null);
    useEffect(() => {
        if (ref.current) ref.current.indeterminate = indeterminate;
    }, [indeterminate]);
    return (
        <input
            ref={ref}
            type="checkbox"
            checked={checked}
            onChange={onChange}
            onClick={(e) => e.stopPropagation()}
            className="accent-[var(--vb-blue)] shrink-0 w-3.5 h-3.5 rounded border-border"
        />
    );
}

function ScopeModeToggle({
    chatScope,
    libraryCount,
    selectedCount,
    selectableCount,
    onChange,
    textPrimary,
    textMuted,
}: {
    chatScope: ChatScope;
    libraryCount: number;
    selectedCount: number;
    selectableCount: number;
    onChange: (scope: ChatScope) => void;
    textPrimary: string;
    textMuted: string;
}) {
    return (
        <div className="rounded-xl border border-border bg-surface-2/80 p-1 flex gap-1">
            <button
                type="button"
                onClick={() => onChange("all")}
                className={cn(
                    "flex-1 rounded-lg px-2 py-2 text-left transition-colors",
                    chatScope === "all"
                        ? "bg-surface shadow-sm border border-border"
                        : "hover:bg-surface/60 border border-transparent"
                )}
            >
                <span className={`block text-xs font-semibold ${textPrimary}`}>All</span>
                <span className={`block text-[10px] mt-0.5 ${textMuted}`}>{libraryCount} files</span>
            </button>
            <button
                type="button"
                onClick={() => onChange("selected")}
                className={cn(
                    "flex-1 rounded-lg px-2 py-2 text-left transition-colors",
                    chatScope === "selected"
                        ? "bg-surface shadow-sm border border-border"
                        : "hover:bg-surface/60 border border-transparent"
                )}
            >
                <span className={`block text-xs font-semibold ${textPrimary}`}>Selected</span>
                <span className={`block text-[10px] mt-0.5 ${textMuted}`}>
                    {selectedCount} of {selectableCount}
                </span>
            </button>
        </div>
    );
}

export default function ChatScopePanel({
    open,
    onClose,
    chatScope,
    onChatScopeChange,
    filteredDocs,
    selectedDocIds,
    onToggleDoc,
    onToggleFolder,
    onSelectAll,
    onClearSelection,
    onFocusDoc,
    docSearch,
    onDocSearchChange,
    docStatusFilter,
    onDocStatusFilterChange,
    unprocessedCount,
    libraryCount,
    selectableCount,
    offPlanCount = 0,
    textPrimary,
    textMuted,
    textSecondary,
    bgHover,
}: ChatScopePanelProps) {
    const panelRef = useRef<HTMLDivElement>(null);
    const selectionMode = chatScope === "selected";

    useEffect(() => {
        if (!open) return;
        const onKey = (e: KeyboardEvent) => {
            if (e.key === "Escape") onClose();
        };
        document.addEventListener("keydown", onKey);
        return () => document.removeEventListener("keydown", onKey);
    }, [open, onClose]);

    if (!open) return null;

    const selectedSet = new Set(selectedDocIds);
    const scopeSummary =
        chatScope === "all"
            ? `All ${libraryCount} processed files`
            : selectedDocIds.length
              ? `${selectedDocIds.length} file${selectedDocIds.length === 1 ? "" : "s"} in scope`
              : "Pick files to narrow scope";

    const folderState = (arr: ScopeLibraryDoc[]) => {
        const c = arr.filter((d) => selectedSet.has(d.documentId)).length;
        return { checked: arr.length > 0 && c === arr.length, indeterminate: c > 0 && c < arr.length };
    };

    const toggleFolder = (docs: ScopeLibraryDoc[]) => {
        if (!selectionMode) {
            onChatScopeChange("selected");
        }
        const ids = docs.map((d) => d.documentId);
        if (onToggleFolder) {
            onToggleFolder(ids);
            return;
        }
        const allSelected = ids.every((id) => selectedSet.has(id));
        if (allSelected) {
            ids.forEach((id) => {
                if (selectedSet.has(id)) onToggleDoc(id);
            });
        } else {
            ids.forEach((id) => {
                if (!selectedSet.has(id)) onToggleDoc(id);
            });
        }
    };

    const focusDoc = (docId: string) => {
        if (onFocusDoc) {
            onFocusDoc(docId);
            return;
        }
        if (chatScope !== "selected") onChatScopeChange("selected");
        if (!selectedSet.has(docId)) onToggleDoc(docId);
    };

    const tree: Record<string, Record<string, ScopeLibraryDoc[]>> = {};
    for (const d of filteredDocs) {
        const agent = resolveDocAgent(d);
        const type = d.classification || "unclassified";
        (tree[agent] ||= {})[type] ||= [];
        tree[agent][type].push(d);
    }

    const visibleAgents = AGENT_ORDER.filter((a) => tree[a] && Object.keys(tree[a]).length > 0);
    for (const a of Object.keys(tree)) {
        if (!visibleAgents.includes(a)) visibleAgents.push(a);
    }

    return (
        <div
            ref={panelRef}
            role="region"
            aria-labelledby="chat-scope-title"
            className="h-full min-h-0 flex flex-col overflow-hidden bg-surface"
        >
            <div className="px-3 py-2.5 border-b border-border shrink-0 bg-linear-to-b from-surface to-surface-2/30">
                <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0 flex items-start gap-2.5">
                        <div className="h-8 w-8 rounded-lg bg-accent-muted border border-[rgba(56,182,255,0.2)] flex items-center justify-center shrink-0 text-accent">
                            <FileText size={15} />
                        </div>
                        <div className="min-w-0">
                            <h2 id="chat-scope-title" className={`text-sm font-semibold ${textPrimary}`}>
                                Documents
                            </h2>
                            <p className={`text-[11px] mt-0.5 truncate ${textMuted}`}>{scopeSummary}</p>
                        </div>
                    </div>
                    <button
                        type="button"
                        onClick={onClose}
                        className="btn-ghost rounded-lg p-1.5 shrink-0"
                        aria-label="Close documents panel"
                    >
                        <X size={14} />
                    </button>
                </div>
            </div>

            <div className="px-3 py-2.5 border-b border-border shrink-0">
                <ScopeModeToggle
                    chatScope={chatScope}
                    libraryCount={libraryCount}
                    selectedCount={selectedDocIds.length}
                    selectableCount={selectableCount}
                    onChange={onChatScopeChange}
                    textPrimary={textPrimary}
                    textMuted={textMuted}
                />
            </div>

            <div className="flex-1 min-h-0 flex flex-col overflow-hidden">
                <div className="px-3 py-2.5 border-b border-border shrink-0">
                    <div className="relative">
                        <Search size={14} className={`absolute left-3 top-1/2 -translate-y-1/2 ${textMuted}`} />
                        <input
                            value={docSearch}
                            onChange={(e) => onDocSearchChange(e.target.value)}
                            placeholder="Search filename…"
                            className="w-full premium-input rounded-xl py-2 pl-9 pr-3 text-sm"
                        />
                    </div>
                </div>

                {selectionMode && (
                    <div className="px-3 py-2 border-b border-border shrink-0 space-y-2">
                        <select
                            value={docStatusFilter}
                            onChange={(e) => onDocStatusFilterChange(e.target.value as DocStatusFilter)}
                            className="w-full premium-input rounded-xl py-2 px-3 text-sm"
                        >
                            <option value="">All statuses</option>
                            <option value="ready">Ready</option>
                            <option value="processing">Processing</option>
                            <option value="failed">Failed</option>
                        </select>
                        <div className="flex gap-2">
                            <button
                                type="button"
                                onClick={onSelectAll}
                                className="btn-secondary rounded-xl px-3 py-1.5 text-xs flex-1"
                            >
                                Select all ({filteredDocs.length})
                            </button>
                            <button
                                type="button"
                                onClick={onClearSelection}
                                className="btn-ghost rounded-xl px-3 py-1.5 text-xs flex-1"
                            >
                                Clear
                            </button>
                        </div>
                        <p className={`text-[11px] ${textMuted}`}>
                            {selectedDocIds.length} of {filteredDocs.length} shown selected
                        </p>
                    </div>
                )}

                <div className="flex-1 min-h-0 overflow-y-auto px-3 py-2 space-y-2">
                {filteredDocs.length === 0 ? (
                    <div className="rounded-xl border border-dashed border-border px-4 py-8 text-center">
                        <FileText size={22} className={`mx-auto mb-2 ${textMuted} opacity-60`} />
                        <p className={`text-sm ${textMuted}`}>No matching processed documents.</p>
                    </div>
                ) : (
                    <div className="space-y-1.5 pb-2">
                        {visibleAgents.map((agent) => {
                            const types = Object.keys(tree[agent]).sort((a, b) => {
                                if (a === "unclassified") return 1;
                                if (b === "unclassified") return -1;
                                return a.localeCompare(b);
                            });
                            const agentDocs = types.flatMap((t) => tree[agent][t]);
                            const ag = folderState(agentDocs);
                            return (
                                <details
                                    key={agent}
                                    className="rounded-xl border border-border overflow-hidden bg-surface"
                                    open
                                >
                                    <summary
                                        className={cn(
                                            "px-2.5 py-2 cursor-pointer transition-colors flex items-center gap-2 text-sm font-semibold list-none",
                                            textPrimary,
                                            bgHover
                                        )}
                                    >
                                        {selectionMode ? (
                                            <FolderCheckbox
                                                checked={ag.checked}
                                                indeterminate={ag.indeterminate}
                                                onChange={() => toggleFolder(agentDocs)}
                                            />
                                        ) : null}
                                        <Folder size={13} className="text-(--vb-blue-bright) shrink-0" />
                                        <span className="flex-1 truncate">{agentLabel(agent)}</span>
                                        <span className={`text-[10px] font-semibold ${textMuted}`}>
                                            {agentDocs.length}
                                        </span>
                                    </summary>
                                    <div className="px-2 pb-2 space-y-1">
                                        {types.map((type) => {
                                            const typeDocs = tree[agent][type]
                                                .slice()
                                                .sort((a, b) => {
                                                    const isResume =
                                                        type === "resume" ||
                                                        type === "cv" ||
                                                        a.classification === "resume";
                                                    if (isResume) {
                                                        const sa = a.metadata?.cvScore ?? -1;
                                                        const sb = b.metadata?.cvScore ?? -1;
                                                        if (sa !== sb) return sb - sa;
                                                    }
                                                    return a.originalFilename.localeCompare(b.originalFilename);
                                                });
                                            const ty = folderState(typeDocs);
                                            return (
                                                <details
                                                    key={type}
                                                    className="rounded-lg border border-border overflow-hidden bg-white/2"
                                                    open
                                                >
                                                    <summary
                                                        className={cn(
                                                            "px-2 py-1.5 cursor-pointer transition-colors flex items-center gap-2 text-xs font-medium list-none",
                                                            textSecondary,
                                                            bgHover
                                                        )}
                                                    >
                                                        {selectionMode ? (
                                                            <FolderCheckbox
                                                                checked={ty.checked}
                                                                indeterminate={ty.indeterminate}
                                                                onChange={() => toggleFolder(typeDocs)}
                                                            />
                                                        ) : null}
                                                        <span className="flex-1 truncate">{docTypeLabel(type)}</span>
                                                        <span className={`text-[10px] ${textMuted}`}>
                                                            {typeDocs.length}
                                                        </span>
                                                    </summary>
                                                    <div className="px-1.5 pb-1.5 space-y-0.5">
                                                        {typeDocs.map((doc) => {
                                                            const checked = selectedSet.has(doc.documentId);
                                                            return (
                                                                <button
                                                                    key={doc.documentId}
                                                                    type="button"
                                                                    onClick={() =>
                                                                        selectionMode
                                                                            ? onToggleDoc(doc.documentId)
                                                                            : focusDoc(doc.documentId)
                                                                    }
                                                                    className={cn(
                                                                        "w-full flex items-start gap-2 rounded-lg px-2.5 py-2 text-left text-sm border border-transparent",
                                                                        selectionMode && checked
                                                                            ? "bg-accent-muted border-[rgba(56,182,255,0.25)]"
                                                                            : !selectionMode
                                                                              ? "hover:bg-accent-muted/40"
                                                                              : bgHover
                                                                    )}
                                                                >
                                                                    {selectionMode ? (
                                                                        checked ? (
                                                                            <CheckSquare
                                                                                size={14}
                                                                                className="text-(--vb-blue-bright) shrink-0 mt-0.5"
                                                                            />
                                                                        ) : (
                                                                            <Square
                                                                                size={14}
                                                                                className={`${textMuted} shrink-0 mt-0.5`}
                                                                            />
                                                                        )
                                                                    ) : (
                                                                        <FileText
                                                                            size={14}
                                                                            className={`${textMuted} shrink-0 mt-0.5`}
                                                                        />
                                                                    )}
                                                                    <span
                                                                        className={`${textSecondary} line-clamp-2 flex-1 min-w-0`}
                                                                    >
                                                                        {doc.originalFilename}
                                                                        <span
                                                                            className={`block text-[11px] mt-0.5 ${textMuted}`}
                                                                        >
                                                                            {doc.status}
                                                                            {doc.metadata?.cvScore != null &&
                                                                                ` · ${doc.metadata.cvScore}`}
                                                                        </span>
                                                                    </span>
                                                                </button>
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
                )}

                {unprocessedCount > 0 && (
                    <p className={`text-[11px] ${textMuted} pt-1`}>
                        {unprocessedCount} document(s) not yet processed by AI are hidden.
                    </p>
                )}
                {offPlanCount > 0 && (
                    <p className={`text-[11px] ${textMuted} pt-1`}>
                        {offPlanCount} document(s) are hidden because their agent is not on your plan.
                    </p>
                )}
                </div>
            </div>
        </div>
    );
}
