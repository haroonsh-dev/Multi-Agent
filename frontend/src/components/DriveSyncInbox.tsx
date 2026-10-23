"use client";

import React, { useCallback, useEffect, useState } from "react";
import { Check, FileText, HardDrive, Loader2, Upload, X, Zap } from "lucide-react";
import { apiRequest } from "@/lib/apiClient";
import { useToast } from "@/components/Toast";
import { usePermissions } from "@/context/PermissionsContext";

type PendingFile = { id: string; name: string; mimeType?: string; size?: number };

type SyncPrompt = {
    connectionId: string;
    label: string;
    syncMode?: string;
    intervalMinutes?: number;
    intervalAutoUpload?: boolean;
    pendingSyncPrompt: {
        discoveredAt: string;
        files: PendingFile[];
        count: number;
    };
};

type SyncAlert = {
    connectionId: string;
    label: string;
    alert: { type: "error" | "info"; message: string; at: string };
};

/**
 * Polls backend for:
 * - Interval mode: confirm modal when new Drive files were found
 * - Daily/auto failures: toast when user is online / after login
 */
export default function DriveSyncInbox() {
    const { ready, role } = usePermissions();
    const { showToast } = useToast();
    const [prompt, setPrompt] = useState<SyncPrompt | null>(null);
    const [enableAuto, setEnableAuto] = useState(false);
    const [busy, setBusy] = useState(false);
    const shownAlertsRef = React.useRef<Set<string>>(new Set());
    const promptIdRef = React.useRef<string | null>(null);

    useEffect(() => {
        promptIdRef.current = prompt?.connectionId || null;
    }, [prompt]);

    const poll = useCallback(async () => {
        if (role !== "admin") return;
        try {
            const res = await apiRequest("/docs/integrations/sync-inbox");
            const prompts: SyncPrompt[] = res?.data?.prompts || [];
            const alerts: SyncAlert[] = res?.data?.alerts || [];

            for (const a of alerts) {
                const key = `${a.connectionId}:${a.alert?.at}:${a.alert?.message}`;
                if (shownAlertsRef.current.has(key)) continue;
                shownAlertsRef.current.add(key);
                showToast(a.alert.message, a.alert.type === "error" ? "error" : "info");
                try {
                    await apiRequest(`/docs/integrations/${a.connectionId}/sync-alert/ack`, {
                        method: "POST",
                    });
                } catch {
                    /* keep alert for next poll if ack fails */
                }
            }

            const openId = promptIdRef.current;
            if (!openId && prompts.length > 0) {
                setPrompt(prompts[0]);
                setEnableAuto(false);
            } else if (openId && !prompts.some((p) => p.connectionId === openId)) {
                setPrompt(null);
            }
        } catch {
            /* plan inactive / not admin — ignore */
        }
    }, [role, showToast]);

    useEffect(() => {
        if (!ready || role !== "admin") return;
        poll();
        const t = setInterval(poll, 45_000);
        return () => clearInterval(t);
    }, [ready, role, poll]);

    const dismiss = async () => {
        if (!prompt) return;
        setBusy(true);
        try {
            await apiRequest(`/docs/integrations/${prompt.connectionId}/sync-prompt/dismiss`, {
                method: "POST",
            });
            setPrompt(null);
            showToast("Skipped — files were not uploaded", "info");
        } catch (e: any) {
            showToast(e?.message || "Could not dismiss", "error");
        } finally {
            setBusy(false);
        }
    };

    const confirm = async () => {
        if (!prompt) return;
        setBusy(true);
        try {
            const res = await apiRequest(
                `/docs/integrations/${prompt.connectionId}/sync-prompt/confirm`,
                {
                    method: "POST",
                    body: JSON.stringify({ enableAutoUpload: enableAuto }),
                }
            );
            setPrompt(null);
            showToast(res?.message || "Upload complete", "success");
        } catch (e: any) {
            showToast(e?.message || "Upload failed", "error");
        } finally {
            setBusy(false);
        }
    };

    if (!prompt) return null;

    const files = prompt.pendingSyncPrompt?.files || [];
    const count = prompt.pendingSyncPrompt?.count || files.length;
    const shown = files.slice(0, 8);
    const extra = Math.max(0, count - shown.length);

    const formatSize = (n?: number) => {
        if (n == null || !Number.isFinite(n) || n <= 0) return null;
        if (n < 1024) return `${n} B`;
        if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
        return `${(n / (1024 * 1024)).toFixed(1)} MB`;
    };

    return (
        <div
            className="fixed inset-0 z-80 flex items-center justify-center bg-black/55 backdrop-blur-sm p-4"
            onClick={() => !busy && dismiss()}
        >
            <div
                role="dialog"
                aria-modal="true"
                aria-labelledby="drive-sync-title"
                className="w-full max-w-105 surface-card border border-border shadow-2xl flex flex-col max-h-[85vh] overflow-hidden"
                onClick={(e) => e.stopPropagation()}
            >
                {/* Header */}
                <div className="flex items-center gap-3 px-5 py-4 border-b border-border bg-linear-to-r from-accent-muted to-transparent">
                    <div className="h-10 w-10 rounded-xl bg-(--vb-blue) text-(--vb-color-primary-btn-fg) flex items-center justify-center shrink-0 shadow-(--vb-glow)">
                        <HardDrive size={18} />
                    </div>
                    <div className="min-w-0 flex-1">
                        <h2
                            id="drive-sync-title"
                            className="text-[15px] font-bold tracking-tight text-foreground"
                        >
                            New Drive files ready
                        </h2>
                        <p className="text-xs text-foreground-muted mt-0.5 truncate">
                            {prompt.label || "Google Drive"} · {count} new file
                            {count === 1 ? "" : "s"}
                        </p>
                    </div>
                    <button
                        type="button"
                        onClick={() => !busy && dismiss()}
                        className="btn-ghost rounded-lg p-2 text-foreground-muted hover:text-foreground shrink-0"
                        aria-label="Close"
                        disabled={busy}
                    >
                        <X size={16} />
                    </button>
                </div>

                {/* Body */}
                <div className="px-5 py-4 space-y-4 overflow-y-auto">
                    <p className="text-sm text-foreground-muted leading-relaxed">
                        Interval check found files that are not in your library yet. Upload them
                        now, or skip for this round.
                    </p>

                    <ul className="rounded-xl border border-border bg-surface-2 overflow-hidden divide-y divide-border max-h-48 overflow-y-auto">
                        {shown.map((f) => {
                            const sizeLabel = formatSize(f.size);
                            return (
                                <li
                                    key={f.id}
                                    className="flex items-center gap-3 px-3.5 py-2.5 min-w-0"
                                    title={f.name}
                                >
                                    <div className="h-8 w-8 rounded-lg bg-white dark:bg-surface border border-border flex items-center justify-center shrink-0 text-accent">
                                        <FileText size={15} />
                                    </div>
                                    <div className="min-w-0 flex-1">
                                        <p className="text-[13px] font-medium text-foreground truncate leading-snug">
                                            {f.name}
                                        </p>
                                        {sizeLabel && (
                                            <p className="text-[11px] text-foreground-muted mt-0.5">
                                                {sizeLabel}
                                            </p>
                                        )}
                                    </div>
                                </li>
                            );
                        })}
                        {extra > 0 && (
                            <li className="px-3.5 py-2 text-xs font-medium text-foreground-muted">
                                +{extra} more file{extra === 1 ? "" : "s"}
                            </li>
                        )}
                    </ul>

                    <button
                        type="button"
                        onClick={() => !busy && setEnableAuto((v) => !v)}
                        disabled={busy}
                        className={`w-full text-left rounded-xl border px-3.5 py-3 transition-colors ${
                            enableAuto
                                ? "border-accent bg-accent-muted"
                                : "border-border bg-surface hover:bg-surface-2"
                        }`}
                    >
                        <div className="flex items-start gap-3">
                            <span
                                className={`mt-0.5 h-4 w-4 rounded border flex items-center justify-center shrink-0 ${
                                    enableAuto
                                        ? "border-accent bg-accent text-white"
                                        : "border-border-strong bg-white dark:bg-surface"
                                }`}
                                aria-hidden
                            >
                                {enableAuto ? <Check size={11} strokeWidth={3} /> : null}
                            </span>
                            <span className="min-w-0">
                                <span className="flex items-center gap-1.5 text-sm font-semibold text-foreground">
                                    <Zap size={14} className="text-accent shrink-0" />
                                    Auto-upload next intervals
                                </span>
                                <span className="block text-[11px] leading-relaxed text-foreground-muted mt-1">
                                    Skip this dialog later — new files upload automatically. Change
                                    anytime in Integrations.
                                </span>
                            </span>
                        </div>
                    </button>
                </div>

                {/* Footer */}
                <div className="flex items-center gap-2.5 px-5 py-4 border-t border-border bg-surface-2/70">
                    <button
                        type="button"
                        onClick={dismiss}
                        disabled={busy}
                        className="flex-1 rounded-xl border border-border bg-surface px-3 py-2.5 text-sm font-semibold text-foreground hover:bg-surface-3 disabled:opacity-50 transition-colors"
                    >
                        Not now
                    </button>
                    <button
                        type="button"
                        onClick={confirm}
                        disabled={busy}
                        className="flex-[1.2] btn-gradient rounded-xl px-3 py-2.5 text-sm font-semibold inline-flex items-center justify-center gap-2 disabled:opacity-50"
                    >
                        {busy ? <Loader2 size={16} className="animate-spin" /> : <Upload size={16} />}
                        Upload {count > 0 ? `(${count})` : ""}
                    </button>
                </div>
            </div>
        </div>
    );
}
