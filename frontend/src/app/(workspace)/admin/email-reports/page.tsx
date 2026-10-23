"use client";

import React, { useCallback, useEffect, useState } from "react";
import {
    Mail, Loader2, Save, Send, Check, AlertTriangle, Clock,
} from "lucide-react";
import { PageHeader } from "@/components/ui";
import { useTheme } from "@/context/ColorContext";
import { usePermissions } from "@/context/PermissionsContext";
import { apiRequest } from "@/lib/apiClient";
import { useToast } from "@/components/Toast";
import { AGENT_FILTER_OPTIONS } from "@/lib/documentAgents";

type Sections = {
    overview: boolean;
    byStatus: boolean;
    byDepartment: boolean;
    byUploader: boolean;
    latestFiles: boolean;
    storage: boolean;
};

type Config = {
    organizationId: string;
    enabled: boolean;
    frequency: "daily" | "weekly";
    reportType: "library" | "extraction";
    phase3Agent: string;
    weekday: number;
    time: string;
    recipients: string[];
    sections: Sections;
    latestFilesLimit: number;
    lastSentAt?: string | null;
    nextSendAt?: string | null;
    lastStatus?: string | null;
    lastError?: string | null;
    emailConfigured?: boolean;
};

const WEEKDAYS = [
    { value: 0, label: "Sunday" },
    { value: 1, label: "Monday" },
    { value: 2, label: "Tuesday" },
    { value: 3, label: "Wednesday" },
    { value: 4, label: "Thursday" },
    { value: 5, label: "Friday" },
    { value: 6, label: "Saturday" },
];

const SECTION_LABELS: { key: keyof Sections; label: string; help: string }[] = [
    { key: "overview", label: "Overview", help: "Totals, processed / failed, last 24h & 7d uploads" },
    { key: "byStatus", label: "By status", help: "Breakdown by document status" },
    { key: "byDepartment", label: "By department", help: "File counts per department" },
    { key: "byUploader", label: "By team member", help: "Who uploaded how many files" },
    { key: "latestFiles", label: "Latest files", help: "Recent uploads with member & department" },
    { key: "storage", label: "Storage", help: "Total and average size used" },
];

const DEFAULT_SECTIONS: Sections = {
    overview: true,
    byStatus: true,
    byDepartment: true,
    byUploader: true,
    latestFiles: true,
    storage: true,
};

type ConfigCache = { config: Config | null; adminEmail: string | null; at: number };
let configCache: ConfigCache | null = null;
const CONFIG_CACHE_MS = 60_000;

function EmailReportsContent() {
    const { theme } = useTheme();
    const colors = theme.colors;
    const { ready, canAccessPage } = usePermissions();
    const { showToast } = useToast();

    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);
    const [sending, setSending] = useState(false);
    const [config, setConfig] = useState<Config | null>(null);
    const [recipientsText, setRecipientsText] = useState("");
    const [adminEmail, setAdminEmail] = useState<string | null>(null);

    const load = useCallback(async (opts?: { silent?: boolean }) => {
        const fresh = configCache && Date.now() - configCache.at < CONFIG_CACHE_MS;
        if (!opts?.silent) setLoading(!fresh);
        if (fresh && configCache) {
            setConfig(configCache.config);
            setAdminEmail(configCache.adminEmail);
            const list = configCache.config?.recipients?.length
                ? configCache.config.recipients
                : configCache.adminEmail
                  ? [configCache.adminEmail]
                  : [];
            setRecipientsText(list.join("\n"));
            return;
        }
        try {
            const res = await apiRequest("/docs/email-reports");
            const cfg: Config = res?.data?.config;
            setConfig(cfg);
            setAdminEmail(res?.data?.adminEmail || null);
            configCache = { config: cfg ?? null, adminEmail: res?.data?.adminEmail || null, at: Date.now() };
            const list = cfg?.recipients?.length
                ? cfg.recipients
                : res?.data?.adminEmail
                  ? [res.data.adminEmail]
                  : [];
            setRecipientsText(list.join("\n"));
            if (cfg && !cfg.recipients?.length && res?.data?.adminEmail) {
                setConfig({ ...cfg, recipients: [res.data.adminEmail] });
            }
        } catch (e: any) {
            showToast(e?.message || "Failed to load email report settings", "error");
        } finally {
            setLoading(false);
        }
    }, [showToast]);

    useEffect(() => {
        if (!ready || !canAccessPage("email_reports")) return;
        load();
    }, [ready, canAccessPage, load]);

    const patch = <K extends keyof Config>(key: K, value: Config[K]) => {
        setConfig((prev) => (prev ? { ...prev, [key]: value } : prev));
    };

    const toggleSection = (key: keyof Sections) => {
        setConfig((prev) => {
            if (!prev) return prev;
            return {
                ...prev,
                sections: { ...prev.sections, [key]: !prev.sections[key] },
            };
        });
    };

    const save = async () => {
        if (!config) return;
        setSaving(true);
        try {
            const res = await apiRequest("/docs/email-reports", {
                method: "PUT",
                body: JSON.stringify({
                    enabled: config.enabled,
                    frequency: config.frequency,
                    reportType: config.reportType || "library",
                    phase3Agent: config.phase3Agent || "",
                    weekday: config.weekday,
                    time: config.time,
                    recipients: recipientsText,
                    sections: config.sections,
                    latestFilesLimit: config.latestFilesLimit,
                }),
            });
            const cfg = res?.data?.config as Config;
            setConfig(cfg);
            configCache = null; // invalidate so the next visit refetches
            setRecipientsText((cfg.recipients || []).join("\n"));
            showToast(res?.message || "Saved", "success");
        } catch (e: any) {
            showToast(e?.message || "Save failed", "error");
        } finally {
            setSaving(false);
        }
    };

    const sendNow = async () => {
        setSending(true);
        try {
            // Persist current form first so Send now uses latest sections/recipients
            await apiRequest("/docs/email-reports", {
                method: "PUT",
                body: JSON.stringify({
                    enabled: config?.enabled ?? false,
                    frequency: config?.frequency || "daily",
                    reportType: config?.reportType || "library",
                    phase3Agent: config?.phase3Agent || "",
                    weekday: config?.weekday ?? 1,
                    time: config?.time || "09:00",
                    recipients: recipientsText,
                    sections: config?.sections || DEFAULT_SECTIONS,
                    latestFilesLimit: config?.latestFilesLimit || 10,
                }),
            });
            const res = await apiRequest("/docs/email-reports/send-now", {
                method: "POST",
                body: JSON.stringify({}),
            });
            showToast(res?.message || "Report sent", "success");
            await load();
        } catch (e: any) {
            showToast(e?.message || "Send failed", "error");
        } finally {
            setSending(false);
        }
    };

    if (!ready) {
        return (
            <div className="flex justify-center py-20">
                <Loader2 className="animate-spin text-accent" size={22} />
            </div>
        );
    }

    if (!canAccessPage("email_reports")) {
        return (
            <div className="p-6 max-w-lg mx-auto">
                <div className="surface-card p-6 text-center space-y-2">
                    <AlertTriangle className="mx-auto text-amber-400" size={28} />
                    <p className={`text-lg font-semibold ${colors.textPrimary}`}>Admin only</p>
                    <p className={`text-sm ${colors.textMuted}`}>
                        Your assigned role does not include access to email reports.
                    </p>
                </div>
            </div>
        );
    }

    return (
        <div className="h-full min-h-0 overflow-y-auto">
            <div className="max-w-3xl mx-auto px-4 sm:px-6 py-6 space-y-6">
                <PageHeader
                    title="Email reports"
                    subtitle="Schedule system summary emails with file counts, latest uploads, members, and departments."
                />

                {loading || !config ? (
                    <div className="flex justify-center py-16">
                        <Loader2 className="animate-spin text-accent" size={22} />
                    </div>
                ) : (
                    <>
                        {config.emailConfigured === false && (
                            <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 text-amber-800 dark:text-amber-200 px-4 py-3 text-sm">
                                SMTP is not configured on the API. Set{" "}
                                <code className="text-xs">EMAIL_USERNAME</code> and{" "}
                                <code className="text-xs">EMAIL_PASSWORD</code> (optional{" "}
                                <code className="text-xs">EMAIL_HOST</code>,{" "}
                                <code className="text-xs">EMAIL_PORT</code>,{" "}
                                <code className="text-xs">EMAIL_FROM</code>) then restart api-gateway.
                            </div>
                        )}

                        <div className="surface-card border border-border rounded-2xl p-4 sm:p-5 space-y-4">
                            <div className="flex flex-wrap items-center justify-between gap-3">
                                <div>
                                    <h3 className={`text-sm font-semibold ${colors.textPrimary}`}>
                                        Schedule
                                    </h3>
                                    <p className={`text-xs mt-0.5 ${colors.textMuted}`}>
                                        Server local time. Tick runs about every minute.
                                    </p>
                                </div>
                                <label className="inline-flex items-center gap-2 text-sm cursor-pointer">
                                    <input
                                        type="checkbox"
                                        checked={config.enabled}
                                        onChange={(e) => patch("enabled", e.target.checked)}
                                        className="rounded border-border"
                                    />
                                    Enabled
                                </label>
                            </div>

                            <div className="grid sm:grid-cols-3 gap-3">
                                <label className="block space-y-1.5">
                                    <span className={`text-xs font-semibold ${colors.textMuted}`}>
                                        Frequency
                                    </span>
                                    <select
                                        value={config.frequency}
                                        onChange={(e) =>
                                            patch(
                                                "frequency",
                                                e.target.value === "weekly" ? "weekly" : "daily"
                                            )
                                        }
                                        className="w-full rounded-xl border border-border bg-surface px-3 py-2.5 text-sm"
                                    >
                                        <option value="daily">Daily</option>
                                        <option value="weekly">Weekly</option>
                                    </select>
                                </label>

                                {config.frequency === "weekly" && (
                                    <label className="block space-y-1.5">
                                        <span className={`text-xs font-semibold ${colors.textMuted}`}>
                                            Weekday
                                        </span>
                                        <select
                                            value={config.weekday}
                                            onChange={(e) =>
                                                patch("weekday", Number(e.target.value))
                                            }
                                            className="w-full rounded-xl border border-border bg-surface px-3 py-2.5 text-sm"
                                        >
                                            {WEEKDAYS.map((d) => (
                                                <option key={d.value} value={d.value}>
                                                    {d.label}
                                                </option>
                                            ))}
                                        </select>
                                    </label>
                                )}

                                <label className="block space-y-1.5">
                                    <span className={`text-xs font-semibold ${colors.textMuted}`}>
                                        Time (HH:MM)
                                    </span>
                                    <input
                                        type="time"
                                        value={config.time || "09:00"}
                                        onChange={(e) => patch("time", e.target.value || "09:00")}
                                        className="w-full rounded-xl border border-border bg-surface px-3 py-2.5 text-sm"
                                    />
                                </label>
                            </div>

                            <div className="grid sm:grid-cols-2 gap-3">
                                <label className="block space-y-1.5">
                                    <span className={`text-xs font-semibold ${colors.textMuted}`}>
                                        Report type
                                    </span>
                                    <select
                                        value={config.reportType || "library"}
                                        onChange={(e) =>
                                            patch(
                                                "reportType",
                                                e.target.value === "extraction" ? "extraction" : "library"
                                            )
                                        }
                                        className="w-full rounded-xl border border-border bg-surface px-3 py-2.5 text-sm"
                                    >
                                        <option value="library">Library summary (counts & latest files)</option>
                                        <option value="extraction">
                                            AI extraction detail (per-document fields)
                                        </option>
                                    </select>
                                </label>
                                {config.reportType === "extraction" && (
                                    <label className="block space-y-1.5">
                                        <span className={`text-xs font-semibold ${colors.textMuted}`}>
                                            Agent filter
                                        </span>
                                        <select
                                            value={config.phase3Agent || ""}
                                            onChange={(e) => patch("phase3Agent", e.target.value)}
                                            className="w-full rounded-xl border border-border bg-surface px-3 py-2.5 text-sm"
                                        >
                                            {AGENT_FILTER_OPTIONS.map((o) => (
                                                <option key={o.value || "all"} value={o.value}>
                                                    {o.label}
                                                </option>
                                            ))}
                                        </select>
                                        <p className={`text-[11px] ${colors.textMuted}`}>
                                            Use HR Agent for hiring packs (resumes, offers, payroll).
                                        </p>
                                    </label>
                                )}
                            </div>
                        </div>

                        <div className="surface-card border border-border rounded-2xl p-4 sm:p-5 space-y-3">
                            <div>
                                <h3 className={`text-sm font-semibold ${colors.textPrimary}`}>
                                    Recipients
                                </h3>
                                <p className={`text-xs mt-0.5 ${colors.textMuted}`}>
                                    One email per line (or comma-separated).
                                    {adminEmail ? ` Your login: ${adminEmail}` : ""}
                                </p>
                            </div>
                            <textarea
                                value={recipientsText}
                                onChange={(e) => setRecipientsText(e.target.value)}
                                rows={3}
                                placeholder="admin@company.com"
                                className="w-full rounded-xl border border-border bg-surface px-3 py-2.5 text-sm font-mono"
                            />
                        </div>

                        <div className="surface-card border border-border rounded-2xl p-4 sm:p-5 space-y-3">
                            <div className="flex flex-wrap items-end justify-between gap-3">
                                <div>
                                    <h3 className={`text-sm font-semibold ${colors.textPrimary}`}>
                                        What to include
                                    </h3>
                                    <p className={`text-xs mt-0.5 ${colors.textMuted}`}>
                                        {config.reportType === "extraction"
                                            ? "Section toggles apply only to library summary reports."
                                            : "Choose sections for the HTML summary email."}
                                    </p>
                                </div>
                                <label className="block space-y-1">
                                    <span className={`text-xs font-semibold ${colors.textMuted}`}>
                                        Latest files limit
                                    </span>
                                    <input
                                        type="number"
                                        min={1}
                                        max={50}
                                        value={config.latestFilesLimit}
                                        onChange={(e) =>
                                            patch(
                                                "latestFilesLimit",
                                                Math.max(1, Math.min(50, Number(e.target.value) || 10))
                                            )
                                        }
                                        className="w-24 rounded-xl border border-border bg-surface px-3 py-2 text-sm"
                                    />
                                </label>
                            </div>
                            <div className="grid sm:grid-cols-2 gap-2">
                                {SECTION_LABELS.map((row) => (
                                    <button
                                        key={row.key}
                                        type="button"
                                        onClick={() => toggleSection(row.key)}
                                        className={`flex items-start gap-3 rounded-xl border px-3 py-2.5 text-left transition-colors ${
                                            config.reportType === "extraction"
                                                ? "opacity-50 cursor-not-allowed border-border"
                                                : config.sections[row.key]
                                                  ? "border-accent bg-accent-muted"
                                                  : "border-border hover:bg-surface-2"
                                        }`}
                                        disabled={config.reportType === "extraction"}
                                    >
                                        <span
                                            className={`mt-0.5 h-4 w-4 rounded border flex items-center justify-center shrink-0 ${
                                                config.sections[row.key]
                                                    ? "bg-accent border-accent text-white"
                                                    : "border-border"
                                            }`}
                                        >
                                            {config.sections[row.key] ? <Check size={10} /> : null}
                                        </span>
                                        <span>
                                            <span className="text-sm font-semibold block">
                                                {row.label}
                                            </span>
                                            <span className={`text-[11px] ${colors.textMuted}`}>
                                                {row.help}
                                            </span>
                                        </span>
                                    </button>
                                ))}
                            </div>
                        </div>

                        <div className="surface-card border border-border rounded-2xl p-4 sm:p-5 space-y-2">
                            <h3
                                className={`text-sm font-semibold inline-flex items-center gap-2 ${colors.textPrimary}`}
                            >
                                <Clock size={14} /> Status
                            </h3>
                            <dl className="grid sm:grid-cols-2 gap-x-4 gap-y-2 text-sm">
                                <div className="flex justify-between gap-2">
                                    <dt className={colors.textMuted}>Last sent</dt>
                                    <dd className={colors.textPrimary}>
                                        {config.lastSentAt
                                            ? new Date(config.lastSentAt).toLocaleString()
                                            : "—"}
                                    </dd>
                                </div>
                                <div className="flex justify-between gap-2">
                                    <dt className={colors.textMuted}>Next send</dt>
                                    <dd className={colors.textPrimary}>
                                        {config.enabled && config.nextSendAt
                                            ? new Date(config.nextSendAt).toLocaleString()
                                            : "—"}
                                    </dd>
                                </div>
                                <div className="flex justify-between gap-2 sm:col-span-2">
                                    <dt className={colors.textMuted}>Last status</dt>
                                    <dd className={`${colors.textPrimary} text-right break-all`}>
                                        {config.lastStatus || "—"}
                                    </dd>
                                </div>
                                {config.lastError && (
                                    <div className="sm:col-span-2 text-sm text-rose-400">
                                        {config.lastError}
                                    </div>
                                )}
                            </dl>
                        </div>

                        <div className="flex flex-col sm:flex-row gap-2 pb-8">
                            <button
                                type="button"
                                onClick={save}
                                disabled={saving || sending}
                                className="flex-1 btn-secondary rounded-xl px-4 py-2.5 text-sm inline-flex items-center justify-center gap-2 disabled:opacity-50"
                            >
                                {saving ? (
                                    <Loader2 size={14} className="animate-spin" />
                                ) : (
                                    <Save size={14} />
                                )}
                                Save
                            </button>
                            <button
                                type="button"
                                onClick={sendNow}
                                disabled={saving || sending}
                                className="flex-1 btn-gradient rounded-xl px-4 py-2.5 text-sm inline-flex items-center justify-center gap-2 disabled:opacity-50"
                            >
                                {sending ? (
                                    <Loader2 size={14} className="animate-spin" />
                                ) : (
                                    <Send size={14} />
                                )}
                                Send now
                            </button>
                        </div>
                    </>
                )}
            </div>
        </div>
    );
}

export default function EmailReportsPage() {
    return <EmailReportsContent />;
}
