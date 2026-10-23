"use client";

import React, { useCallback, useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { CheckCircle2, FileUp, HardDrive, Link2, Loader2, Send, X } from "lucide-react";
import { apiRequest } from "@/lib/apiClient";
import { useToast } from "@/components/Toast";

type ConnectionRow = {
    connectionId: string;
    providerId: string;
    label: string;
    isActive: boolean;
    hasOutboundWebhook?: boolean;
    outboundWebhookUrl?: string | null;
    supportsFolderSend?: boolean;
};

type LibraryDoc = {
    documentId: string;
    originalFilename: string;
    status?: string;
};

type Props = {
    open: boolean;
    onClose: () => void;
    /** Pre-selected document ids (document details). If empty, modal loads a library picker. */
    documentIds?: string[];
    /** Optional filename hint for single-doc mode */
    filename?: string;
    /** Pre-select a connection (Integrations Status) */
    connectionId?: string;
    onSent?: (message: string) => void;
};

export default function SendToIntegrationModal({
    open,
    onClose,
    documentIds: initialDocIds,
    filename,
    connectionId: initialConnectionId,
    onSent,
}: Props) {
    const { showToast } = useToast();
    const [connections, setConnections] = useState<ConnectionRow[]>([]);
    const [connectionId, setConnectionId] = useState("");
    const [library, setLibrary] = useState<LibraryDoc[]>([]);
    const [selectedDocs, setSelectedDocs] = useState<string[]>([]);
    const [destFolder, setDestFolder] = useState(true);
    const [destWebhook, setDestWebhook] = useState(false);
    const [loading, setLoading] = useState(false);
    const [sending, setSending] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [success, setSuccess] = useState<string | null>(null);
    const [docSearch, setDocSearch] = useState("");

    const fixedDocs = (initialDocIds || []).filter(Boolean);
    const needsDocPicker = fixedDocs.length === 0;

    const activeConn = useMemo(
        () => connections.find((c) => c.connectionId === connectionId),
        [connections, connectionId]
    );

    const load = useCallback(async () => {
        setLoading(true);
        setError(null);
        try {
            const [connRes, docsRes] = await Promise.all([
                apiRequest("/docs/integrations"),
                needsDocPicker
                    ? apiRequest("/docs/documents?limit=50&sort=-createdAt")
                    : Promise.resolve(null),
            ]);
            const list: ConnectionRow[] = (connRes?.data?.connections || []).filter(
                (c: ConnectionRow) => c.isActive
            );
            setConnections(list);
            const preferred =
                initialConnectionId && list.some((c) => c.connectionId === initialConnectionId)
                    ? initialConnectionId
                    : list.find((c) => c.providerId === "google_drive")?.connectionId ||
                      list[0]?.connectionId ||
                      "";
            setConnectionId(preferred);

            if (needsDocPicker) {
                const docs: LibraryDoc[] = (docsRes?.data?.documents || docsRes?.data?.items || []).map(
                    (d: any) => ({
                        documentId: d.documentId,
                        originalFilename: d.originalFilename || d.filename || d.documentId,
                        status: d.status,
                    })
                );
                setLibrary(docs);
            }
        } catch (e: any) {
            const msg = e?.message || "Failed to load integrations";
            setError(msg);
            showToast(msg, "error");
        } finally {
            setLoading(false);
        }
    }, [initialConnectionId, needsDocPicker, showToast]);

    useEffect(() => {
        if (!open) return;
        setSuccess(null);
        setError(null);
        setSelectedDocs(fixedDocs);
        load();
    }, [open, load, fixedDocs.join("|")]);

    useEffect(() => {
        if (!activeConn) return;
        setDestFolder(!!activeConn.supportsFolderSend);
        setDestWebhook(!!activeConn.hasOutboundWebhook);
        if (!activeConn.supportsFolderSend && activeConn.hasOutboundWebhook) {
            setDestWebhook(true);
            setDestFolder(false);
        }
    }, [activeConn?.connectionId]);

    useEffect(() => {
        if (!open) return;
        const previousOverflow = document.body.style.overflow;
        document.body.style.overflow = "hidden";
        const onKeyDown = (event: KeyboardEvent) => {
            if (event.key === "Escape" && !sending) onClose();
        };
        window.addEventListener("keydown", onKeyDown);
        return () => {
            document.body.style.overflow = previousOverflow;
            window.removeEventListener("keydown", onKeyDown);
        };
    }, [open, sending, onClose]);

    const filteredLibrary = useMemo(() => {
        const q = docSearch.trim().toLowerCase();
        if (!q) return library;
        return library.filter(
            (d) =>
                d.originalFilename.toLowerCase().includes(q) ||
                d.documentId.toLowerCase().includes(q)
        );
    }, [library, docSearch]);

    const toggleDoc = (id: string) => {
        setSelectedDocs((prev) =>
            prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]
        );
    };

    const send = async () => {
        setError(null);
        setSuccess(null);
        if (!connectionId) {
            const msg = "Select a connection";
            setError(msg);
            showToast(msg, "error");
            return;
        }
        const ids = needsDocPicker ? selectedDocs : fixedDocs;
        if (!ids.length) {
            const msg = "Select at least one document";
            setError(msg);
            showToast(msg, "error");
            return;
        }
        if (!destFolder && !destWebhook) {
            const msg = "Select at least one destination (folder or webhook)";
            setError(msg);
            showToast(msg, "error");
            return;
        }
        if (destFolder && !activeConn?.supportsFolderSend) {
            const msg = "Folder send is only available for Google Drive right now";
            setError(msg);
            showToast(msg, "error");
            return;
        }
        if (destWebhook && !activeConn?.hasOutboundWebhook) {
            const msg = "Set Outbound webhook URL in Integrations → Edit first";
            setError(msg);
            showToast(msg, "error");
            return;
        }

        setSending(true);
        try {
            const res = await apiRequest(`/docs/integrations/${connectionId}/send`, {
                method: "POST",
                body: JSON.stringify({
                    documentIds: ids,
                    include: {
                        file: true,
                        summary: false,
                        extracted: false,
                    },
                    destinations: {
                        folder: destFolder,
                        webhook: destWebhook,
                    },
                }),
            });

            const resultErrors = (res?.data?.results || [])
                .flatMap((r: any) => r?.errors || [])
                .filter(Boolean);
            const msg =
                res?.message ||
                (res?.success === false
                    ? resultErrors[0] || "Send failed"
                    : "Sent successfully");

            if (res?.success === false) {
                setError(msg);
                showToast(msg, "error");
                return;
            }

            setSuccess(msg);
            showToast(msg, "success");
            onSent?.(msg);
        } catch (e: any) {
            const nested =
                Array.isArray(e?.data?.data?.results)
                    ? e.data.data.results.flatMap((r: any) => r.errors || []).filter(Boolean)[0]
                    : null;
            const msg = e?.data?.message || e?.message || nested || "Send failed";
            setError(String(msg));
            showToast(String(msg), "error");
        } finally {
            setSending(false);
        }
    };

    if (!open || typeof document === "undefined") return null;

    const fileSummary = filename
        ? filename
        : fixedDocs.length
          ? `${fixedDocs.length} selected file${fixedDocs.length === 1 ? "" : "s"}`
          : `${selectedDocs.length} selected file${selectedDocs.length === 1 ? "" : "s"}`;

    return createPortal(
        <div
            className="fixed inset-0 z-[1000] flex items-center justify-center bg-slate-950/70 backdrop-blur-md p-3 sm:p-6"
            onMouseDown={() => !sending && onClose()}
        >
            <div
                role="dialog"
                aria-modal="true"
                aria-labelledby="send-integration-title"
                className="w-full max-w-[580px] max-h-[calc(100vh-1.5rem)] sm:max-h-[88vh] overflow-hidden rounded-2xl border border-border-strong text-foreground shadow-[0_28px_90px_rgba(2,6,23,0.45)] flex flex-col"
                style={{ backgroundColor: "var(--surface)" }}
                onMouseDown={(event) => event.stopPropagation()}
            >
                <header className="relative px-5 sm:px-6 py-5 border-b border-border bg-linear-to-r from-accent-muted via-surface to-surface">
                    <div className="flex items-start gap-3.5 pr-10">
                        <div className="h-11 w-11 rounded-2xl bg-(--vb-blue) text-(--vb-color-primary-btn-fg) flex items-center justify-center shrink-0 shadow-(--vb-glow)">
                            <Send size={18} />
                        </div>
                        <div className="min-w-0 pt-0.5">
                            <h2
                                id="send-integration-title"
                                className="text-base font-bold text-foreground"
                            >
                                Send to integration
                            </h2>
                            <p className="text-xs text-foreground-secondary truncate mt-1">
                                {fileSummary}
                            </p>
                        </div>
                    </div>
                    <button
                        type="button"
                        onClick={() => !sending && onClose()}
                        disabled={sending}
                        className="absolute right-4 top-4 h-9 w-9 rounded-xl border border-border bg-surface text-foreground-secondary hover:text-foreground hover:bg-surface-2 flex items-center justify-center transition-colors disabled:opacity-50"
                        aria-label="Close"
                    >
                        <X size={16} />
                    </button>
                </header>

                <div className="px-5 sm:px-6 py-5 space-y-5 overflow-y-auto flex-1">
                    {loading ? (
                        <div className="py-16 flex flex-col items-center gap-3">
                            <Loader2 className="animate-spin text-accent" size={26} />
                            <p className="text-sm text-foreground-secondary">
                                Loading connections…
                            </p>
                        </div>
                    ) : connections.length === 0 ? (
                        <div className="rounded-2xl border border-amber-300/50 bg-amber-50 p-4 text-sm text-amber-900">
                            No active integration found. Connect Google Drive or configure an
                            outbound webhook under Integrations first.
                        </div>
                    ) : (
                        <>
                            <section className="space-y-2">
                                <label
                                    htmlFor="send-integration-connection"
                                    className="block text-xs font-bold uppercase tracking-[0.08em] text-foreground-secondary"
                                >
                                    Connection
                                </label>
                                <select
                                    id="send-integration-connection"
                                    value={connectionId}
                                    onChange={(event) => setConnectionId(event.target.value)}
                                    className="premium-input w-full h-12 px-4 text-sm font-medium"
                                >
                                    {connections.map((connection) => (
                                        <option
                                            key={connection.connectionId}
                                            value={connection.connectionId}
                                        >
                                            {connection.label || connection.providerId}
                                            {connection.supportsFolderSend ? " · Drive folder" : ""}
                                            {connection.hasOutboundWebhook ? " · Webhook" : ""}
                                        </option>
                                    ))}
                                </select>
                            </section>

                            {needsDocPicker ? (
                                <section className="space-y-2">
                                    <div className="flex items-center justify-between gap-3">
                                        <label
                                            htmlFor="send-integration-search"
                                            className="text-xs font-bold uppercase tracking-[0.08em] text-foreground-secondary"
                                        >
                                            Documents
                                        </label>
                                        <span className="text-xs font-semibold text-accent">
                                            {selectedDocs.length} selected
                                        </span>
                                    </div>
                                    <input
                                        id="send-integration-search"
                                        value={docSearch}
                                        onChange={(event) => setDocSearch(event.target.value)}
                                        placeholder="Search your document library…"
                                        className="premium-input w-full h-11 px-4 text-sm"
                                    />
                                    <ul className="max-h-48 overflow-y-auto rounded-xl border border-border-strong divide-y divide-border bg-surface">
                                        {filteredLibrary.length === 0 ? (
                                            <li className="px-4 py-6 text-center text-sm text-foreground-muted">
                                                No documents found
                                            </li>
                                        ) : (
                                            filteredLibrary.map((doc) => {
                                                const selected = selectedDocs.includes(doc.documentId);
                                                return (
                                                    <li key={doc.documentId}>
                                                        <button
                                                            type="button"
                                                            onClick={() => toggleDoc(doc.documentId)}
                                                            className={`w-full flex items-center gap-3 px-4 py-3 text-left transition-colors ${
                                                                selected
                                                                    ? "bg-accent-muted"
                                                                    : "hover:bg-surface-2"
                                                            }`}
                                                        >
                                                            <span
                                                                className={`h-5 w-5 rounded-md border flex items-center justify-center shrink-0 ${
                                                                    selected
                                                                        ? "border-accent bg-accent text-white"
                                                                        : "border-border-strong"
                                                                }`}
                                                            >
                                                                {selected && <CheckCircle2 size={14} />}
                                                            </span>
                                                            <FileUp
                                                                size={16}
                                                                className="text-foreground-muted shrink-0"
                                                            />
                                                            <span className="truncate flex-1 text-sm font-medium">
                                                                {doc.originalFilename}
                                                            </span>
                                                        </button>
                                                    </li>
                                                );
                                            })
                                        )}
                                    </ul>
                                </section>
                            ) : (
                                <section className="rounded-xl border border-border bg-surface-2 p-3.5 flex items-center gap-3">
                                    <div className="h-9 w-9 rounded-xl bg-accent-muted text-accent flex items-center justify-center shrink-0">
                                        <FileUp size={16} />
                                    </div>
                                    <div className="min-w-0">
                                        <p className="text-xs font-semibold text-foreground-secondary">
                                            Original file
                                        </p>
                                        <p className="text-sm font-medium truncate mt-0.5">
                                            {fileSummary}
                                        </p>
                                    </div>
                                </section>
                            )}

                            <section className="space-y-2.5">
                                <div>
                                    <p className="text-xs font-bold uppercase tracking-[0.08em] text-foreground-secondary">
                                        Destination
                                    </p>
                                    <p className="text-xs text-foreground-muted mt-1">
                                        Select where the original file should be delivered.
                                    </p>
                                </div>
                                <div className="grid sm:grid-cols-2 gap-3">
                                    <button
                                        type="button"
                                        disabled={!activeConn?.supportsFolderSend}
                                        onClick={() =>
                                            activeConn?.supportsFolderSend &&
                                            setDestFolder((current) => !current)
                                        }
                                        className={`relative min-h-[112px] rounded-2xl border p-4 text-left transition-all disabled:cursor-not-allowed ${
                                            destFolder && activeConn?.supportsFolderSend
                                                ? "border-accent bg-accent-muted shadow-[0_0_0_3px_var(--accent-ring)]"
                                                : activeConn?.supportsFolderSend
                                                  ? "border-border-strong hover:border-accent bg-surface"
                                                  : "border-border bg-surface-2 opacity-55"
                                        }`}
                                    >
                                        <div className="flex items-start justify-between gap-3">
                                            <div className="h-9 w-9 rounded-xl bg-surface border border-border text-accent flex items-center justify-center">
                                                <HardDrive size={17} />
                                            </div>
                                            {destFolder && activeConn?.supportsFolderSend && (
                                                <CheckCircle2
                                                    size={18}
                                                    className="text-accent"
                                                />
                                            )}
                                        </div>
                                        <p className="text-sm font-bold mt-3">Connected Drive folder</p>
                                        <p className="text-[11px] leading-4 text-foreground-secondary mt-1">
                                            {activeConn?.supportsFolderSend
                                                ? "Upload to the folder linked with this connection."
                                                : "Available with Google Drive."}
                                        </p>
                                    </button>

                                    <button
                                        type="button"
                                        disabled={!activeConn?.hasOutboundWebhook}
                                        onClick={() =>
                                            activeConn?.hasOutboundWebhook &&
                                            setDestWebhook((current) => !current)
                                        }
                                        className={`relative min-h-[112px] rounded-2xl border p-4 text-left transition-all disabled:cursor-not-allowed ${
                                            destWebhook && activeConn?.hasOutboundWebhook
                                                ? "border-accent bg-accent-muted shadow-[0_0_0_3px_var(--accent-ring)]"
                                                : activeConn?.hasOutboundWebhook
                                                  ? "border-border-strong hover:border-accent bg-surface"
                                                  : "border-border bg-surface-2 opacity-55"
                                        }`}
                                    >
                                        <div className="flex items-start justify-between gap-3">
                                            <div className="h-9 w-9 rounded-xl bg-surface border border-border text-accent flex items-center justify-center">
                                                <Link2 size={17} />
                                            </div>
                                            {destWebhook && activeConn?.hasOutboundWebhook && (
                                                <CheckCircle2
                                                    size={18}
                                                    className="text-accent"
                                                />
                                            )}
                                        </div>
                                        <p className="text-sm font-bold mt-3">Outbound webhook</p>
                                        <p className="text-[11px] leading-4 text-foreground-secondary mt-1">
                                            {activeConn?.hasOutboundWebhook
                                                ? "POST the file and metadata to your URL."
                                                : "Configure a URL in Integrations → Edit."}
                                        </p>
                                    </button>
                                </div>
                            </section>
                        </>
                    )}

                    {error && (
                        <div className="rounded-xl border border-red-300/60 bg-red-50 text-red-700 px-4 py-3 text-sm font-medium">
                            {error}
                        </div>
                    )}
                    {success && (
                        <div className="rounded-xl border border-emerald-300/60 bg-emerald-50 text-emerald-700 px-4 py-3 text-sm font-medium flex items-center gap-2">
                            <CheckCircle2 size={16} className="shrink-0" />
                            {success}
                        </div>
                    )}
                </div>

                <footer
                    className="px-5 sm:px-6 py-4 border-t border-border flex flex-col-reverse sm:flex-row gap-2.5"
                    style={{ backgroundColor: "var(--surface-2)" }}
                >
                    <button
                        type="button"
                        onClick={onClose}
                        disabled={sending}
                        className="sm:w-36 h-11 rounded-xl border border-border-strong bg-surface text-foreground-secondary hover:text-foreground hover:bg-surface-3 text-sm font-semibold transition-colors disabled:opacity-50"
                    >
                        Cancel
                    </button>
                    <button
                        type="button"
                        onClick={send}
                        disabled={
                            sending ||
                            loading ||
                            connections.length === 0 ||
                            (!destFolder && !destWebhook) ||
                            (needsDocPicker && selectedDocs.length === 0)
                        }
                        className="flex-1 h-11 btn-gradient rounded-xl text-sm font-semibold inline-flex items-center justify-center gap-2 disabled:opacity-50"
                    >
                        {sending ? (
                            <>
                                <Loader2 size={16} className="animate-spin" />
                                Sending…
                            </>
                        ) : (
                            <>
                                <Send size={16} />
                                Send original file
                            </>
                        )}
                    </button>
                </footer>
            </div>
        </div>,
        document.body
    );
}
