"use client";

import React, { useCallback, useEffect, useState } from "react";
import {
    Key, Shield, Zap, Brain, Sparkles, Globe, Save, Trash2, Loader2, Check, AlertTriangle,
    Eye, EyeOff, RotateCcw, Coins, Copy, Plug,
} from "lucide-react";
import { PageHeader } from "@/components/ui";
import { useTheme } from "@/context/ColorContext";
import { apiRequest } from "@/lib/apiClient";

type Provider = "groq" | "openai" | "gemini" | "anthropic" | "custom";

type ApiKeyRecord = {
    keyId: string;
    provider: Provider;
    apiKey: string;
    label: string;
    model?: string | null;
    baseUrl?: string | null;
    isActive: boolean;
    hasKey: boolean;
    createdAt: string;
};

type ProviderDefaults = Record<Provider, { label: string; model: string; baseUrl?: string }>;

type SettingsCache = {
    keys: ApiKeyRecord[];
    defaults: ProviderDefaults | null;
    at: number;
};

let settingsCache: SettingsCache | null = null;
const SETTINGS_CACHE_MS = 60_000;

function vendorAliasesToText(aliases?: Record<string, string> | null): string {
    if (!aliases) return "";
    return Object.entries(aliases)
        .map(([k, v]) => `${k}=${v}`)
        .join("\n");
}

function parseVendorAliasesText(text: string): Record<string, string> {
    const out: Record<string, string> = {};
    for (const line of text.split("\n")) {
        const t = line.trim();
        if (!t || t.startsWith("#")) continue;
        const eq = t.indexOf("=");
        if (eq < 1) continue;
        const key = t.slice(0, eq).trim().toLowerCase();
        const val = t.slice(eq + 1).trim();
        if (key && val) out[key] = val;
    }
    return out;
}

function fxRatesToText(rates?: Record<string, number> | null): string {
    if (!rates) return "";
    return Object.entries(rates)
        .map(([k, v]) => `${k}=${v}`)
        .join("\n");
}

function parseFxRatesText(text: string): Record<string, number> {
    const out: Record<string, number> = {};
    for (const line of text.split("\n")) {
        const t = line.trim();
        if (!t || t.startsWith("#")) continue;
        const eq = t.indexOf("=");
        if (eq < 1) continue;
        const key = t.slice(0, eq).trim().toUpperCase().slice(0, 3);
        const val = Number(t.slice(eq + 1).trim());
        if (key && Number.isFinite(val) && val > 0) out[key] = val;
    }
    return out;
}

const PROVIDER_CONFIG: Record<Provider, { icon: React.ReactNode; color: string; bgColor: string; borderColor: string; description: string }> = {
    gemini: {
        icon: <Sparkles size={20} />,
        color: "text-blue-300",
        bgColor: "bg-blue-500/15",
        borderColor: "border-blue-500/30",
        description: "Google Gemma (gemma-2-2b-it) open-weight model & Gemini API.",
    },
    groq: {
        icon: <Zap size={20} />,
        color: "text-amber-300",
        bgColor: "bg-amber-500/15",
        borderColor: "border-amber-500/30",
        description: "Fast inference with open-weight Gemma & LLaMA models.",
    },
    openai: {
        icon: <Brain size={20} />,
        color: "text-emerald-300",
        bgColor: "bg-emerald-500/15",
        borderColor: "border-emerald-500/30",
        description: "GPT-4o, GPT-4 Turbo models.",
    },
    anthropic: {
        icon: <Shield size={20} />,
        color: "text-orange-300",
        bgColor: "bg-orange-500/15",
        borderColor: "border-orange-500/30",
        description: "Claude 3.5 Sonnet & Opus. Best for analysis.",
    },
    custom: {
        icon: <Globe size={20} />,
        color: "text-purple-300",
        bgColor: "bg-purple-500/15",
        borderColor: "border-purple-500/30",
        description: "Any OpenAI-compatible API endpoint.",
    },
};

function SettingsContent() {
    const { theme } = useTheme();
    const colors = theme.colors;

    const [keys, setKeys] = useState<ApiKeyRecord[]>(() => settingsCache?.keys || []);
    const [defaults, setDefaults] = useState<ProviderDefaults | null>(() => settingsCache?.defaults || null);
    const [loading, setLoading] = useState(() => !settingsCache);
    const [error, setError] = useState<string | null>(null);

    // Form state per provider
    const [editingProvider, setEditingProvider] = useState<Provider | null>(null);
    const [formKey, setFormKey] = useState("");
    const [formModel, setFormModel] = useState("");
    const [formBaseUrl, setFormBaseUrl] = useState("");
    const [formLabel, setFormLabel] = useState("");
    const [saving, setSaving] = useState(false);
    const [saveSuccess, setSaveSuccess] = useState<string | null>(null);
    const [showKeys, setShowKeys] = useState<Record<string, boolean>>({});

    const [financeBaseCurrency, setFinanceBaseCurrency] = useState("");
    const [financeAliasesText, setFinanceAliasesText] = useState("");
    const [financeClientAliasesText, setFinanceClientAliasesText] = useState("");
    const [financeFxText, setFinanceFxText] = useState("");
    const [financeFyStartMonth, setFinanceFyStartMonth] = useState("");
    const [financeLoading, setFinanceLoading] = useState(true);
    const [financeSaving, setFinanceSaving] = useState(false);
    const [financeSaveSuccess, setFinanceSaveSuccess] = useState<string | null>(null);

    type AgentApiStatus = {
        hasToken: boolean;
        tokenMasked: string | null;
        label: string | null;
        isActive: boolean;
        lastUsedAt: string | null;
        allowedAgents: { id: string; label: string }[];
        askUrlTemplate: string;
        exampleAskUrl: string;
    };
    const [agentApi, setAgentApi] = useState<AgentApiStatus | null>(null);
    const [agentApiFreshToken, setAgentApiFreshToken] = useState<string | null>(null);
    const [agentApiCurl, setAgentApiCurl] = useState<string | null>(null);
    const [agentApiLoading, setAgentApiLoading] = useState(true);
    const [agentApiBusy, setAgentApiBusy] = useState(false);

    const loadKeys = useCallback(async (opts?: { silent?: boolean }) => {
        const useSilent = opts?.silent || Boolean(settingsCache && Date.now() - settingsCache.at < SETTINGS_CACHE_MS);
        if (!useSilent) setLoading(true);
        setError(null);
        try {
            const res = await apiRequest("/docs/settings/api-keys");
            const nextKeys = res?.data?.keys || [];
            const nextDefaults = res?.data?.providerDefaults || null;
            setKeys(nextKeys);
            setDefaults(nextDefaults);
            settingsCache = { keys: nextKeys, defaults: nextDefaults, at: Date.now() };
        } catch (e: any) {
            setError(e.message || "Failed to load API keys");
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        const fresh = settingsCache && Date.now() - settingsCache.at < SETTINGS_CACHE_MS;
        void loadKeys({ silent: Boolean(fresh || settingsCache) });
    }, [loadKeys]);

    type FinanceSettingsShape = {
        baseCurrency?: string;
        vendorAliases?: Record<string, string>;
        clientAliases?: Record<string, string>;
        fxRates?: Record<string, number>;
        fyStartMonth?: number;
    };

    const applyFinanceSettings = (fs?: FinanceSettingsShape) => {
        setFinanceBaseCurrency(fs?.baseCurrency || "");
        setFinanceAliasesText(vendorAliasesToText(fs?.vendorAliases));
        setFinanceClientAliasesText(vendorAliasesToText(fs?.clientAliases));
        setFinanceFxText(fxRatesToText(fs?.fxRates));
        setFinanceFyStartMonth(fs?.fyStartMonth ? String(fs.fyStartMonth) : "");
    };

    const loadFinanceSettings = useCallback(async () => {
        setFinanceLoading(true);
        try {
            const res = await apiRequest("/docs/settings/finance");
            applyFinanceSettings(res?.data?.financeSettings as FinanceSettingsShape | undefined);
        } catch (e: any) {
            setError(e.message || "Failed to load finance settings");
        } finally {
            setFinanceLoading(false);
        }
    }, []);

    useEffect(() => {
        void loadFinanceSettings();
    }, [loadFinanceSettings]);

    const loadAgentApi = useCallback(async () => {
        setAgentApiLoading(true);
        try {
            const res = await apiRequest("/docs/agent-api/token");
            setAgentApi((res?.data as AgentApiStatus) || null);
        } catch {
            setAgentApi(null);
        } finally {
            setAgentApiLoading(false);
        }
    }, []);

    useEffect(() => {
        void loadAgentApi();
    }, [loadAgentApi]);

    const rotateAgentApi = async () => {
        if (
            agentApi?.hasToken &&
            !confirm("Rotate Agent API token? Existing integrations using the old key will stop working.")
        ) {
            return;
        }
        setAgentApiBusy(true);
        setError(null);
        setSaveSuccess(null);
        try {
            const res = await apiRequest("/docs/agent-api/token/rotate", {
                method: "POST",
                body: JSON.stringify({ label: "Agent API" }),
            });
            setAgentApiFreshToken(res?.data?.token || null);
            setAgentApiCurl(res?.data?.curlExample || null);
            setSaveSuccess(res?.message || "Agent API token ready — copy it now");
            await loadAgentApi();
        } catch (e: any) {
            setError(e.message || "Failed to create Agent API token");
        } finally {
            setAgentApiBusy(false);
        }
    };

    const revokeAgentApi = async () => {
        if (!confirm("Revoke Agent API token? External apps will lose access immediately.")) return;
        setAgentApiBusy(true);
        setError(null);
        try {
            await apiRequest("/docs/agent-api/token", { method: "DELETE" });
            setAgentApiFreshToken(null);
            setAgentApiCurl(null);
            setSaveSuccess("Agent API token revoked");
            await loadAgentApi();
        } catch (e: any) {
            setError(e.message || "Failed to revoke token");
        } finally {
            setAgentApiBusy(false);
        }
    };

    const copyText = async (text: string) => {
        try {
            await navigator.clipboard.writeText(text);
            setSaveSuccess("Copied to clipboard");
        } catch {
            setError("Could not copy");
        }
    };

    const saveFinanceSettings = async () => {
        setFinanceSaving(true);
        setFinanceSaveSuccess(null);
        setError(null);
        try {
            const fy = Number(financeFyStartMonth);
            const res = await apiRequest("/docs/settings/finance", {
                method: "PATCH",
                body: JSON.stringify({
                    baseCurrency: financeBaseCurrency.trim() || "",
                    vendorAliases: parseVendorAliasesText(financeAliasesText),
                    clientAliases: parseVendorAliasesText(financeClientAliasesText),
                    fxRates: parseFxRatesText(financeFxText),
                    fyStartMonth: Number.isFinite(fy) && fy >= 1 && fy <= 12 ? fy : null,
                }),
            });
            applyFinanceSettings(res?.data?.financeSettings as FinanceSettingsShape | undefined);
            setFinanceSaveSuccess("Finance analytics settings saved.");
        } catch (e: any) {
            setError(e.message || "Failed to save finance settings");
        } finally {
            setFinanceSaving(false);
        }
    };

    const getKeyForProvider = (provider: Provider): ApiKeyRecord | undefined => {
        return keys.find((k) => k.provider === provider);
    };

    const startEdit = (provider: Provider) => {
        const existing = getKeyForProvider(provider);
        const def = defaults?.[provider];
        setEditingProvider(provider);
        setFormKey(""); // Never pre-fill the key for security
        setFormModel(existing?.model || def?.model || "");
        setFormBaseUrl(existing?.baseUrl || def?.baseUrl || "");
        setFormLabel(existing?.label || def?.label || provider);
        setSaveSuccess(null);
        setError(null);
    };

    const cancelEdit = () => {
        setEditingProvider(null);
        setFormKey("");
        setFormModel("");
        setFormBaseUrl("");
        setFormLabel("");
    };

    const saveKey = async () => {
        if (!editingProvider) return;
        if (!formKey && !getKeyForProvider(editingProvider)) {
            setError("API key is required");
            return;
        }

        setSaving(true);
        setError(null);
        setSaveSuccess(null);
        try {
            const existing = getKeyForProvider(editingProvider);
            const payload: Record<string, unknown> = {
                provider: editingProvider,
                label: formLabel,
                model: formModel,
                baseUrl: formBaseUrl,
            };
            if (formKey) {
                payload.apiKey = formKey;
            } else if (existing) {
                // Keep existing key
                payload.apiKey = existing.apiKey;
            } else {
                setError("API key is required");
                setSaving(false);
                return;
            }
            if (existing?.keyId) {
                payload.keyId = existing.keyId;
            }

            await apiRequest("/docs/settings/api-keys", {
                method: "POST",
                body: JSON.stringify(payload),
            });

            setSaveSuccess(`${formLabel || editingProvider} API key saved successfully!`);
            cancelEdit();
            await loadKeys();
        } catch (e: any) {
            setError(e.message || "Failed to save API key");
        } finally {
            setSaving(false);
        }
    };

    const deleteKey = async (keyId: string, label: string) => {
        if (!confirm(`Delete ${label} API key? This cannot be undone.`)) return;
        try {
            await apiRequest(`/docs/settings/api-keys/${keyId}`, { method: "DELETE" });
            await loadKeys();
        } catch (e: any) {
            setError(e.message || "Failed to delete API key");
        }
    };

    const toggleKey = async (keyId: string) => {
        try {
            await apiRequest(`/docs/settings/api-keys/${keyId}/toggle`, { method: "PATCH" });
            await loadKeys();
        } catch (e: any) {
            setError(e.message || "Failed to toggle API key");
        }
    };

    const toggleShowKey = (keyId: string) => {
        setShowKeys((prev) => ({ ...prev, [keyId]: !prev[keyId] }));
    };

    const [settingPrimary, setSettingPrimary] = useState(false);

    // Filter ONLY providers that have a configured key
    const configuredKeys = keys.filter((k) => k.hasKey);

    const handleSetPrimary = async (providerToSet: Provider) => {
        if (!providerToSet) return;
        setSettingPrimary(true);
        setError(null);
        setSaveSuccess(null);
        try {
            await apiRequest("/docs/settings/api-keys/primary", {
                method: "POST",
                body: JSON.stringify({ provider: providerToSet }),
            });
            setSaveSuccess(`Active AI Provider set to ${providerToSet.toUpperCase()}`);
            await loadKeys();
        } catch (e: any) {
            setError(e.message || "Failed to set active provider");
        } finally {
            setSettingPrimary(false);
        }
    };

    if (loading && keys.length === 0 && !defaults) {
        return (
            <div className="p-4 sm:p-6 lg:p-8 max-w-5xl mx-auto space-y-6">
                <PageHeader
                    title="AI Provider Settings"
                    subtitle="Manage API keys for AI providers. Keys are used for document processing, vision models, chat, and search."
                />
                <div className="flex justify-center py-16">
                    <Loader2 className="h-8 w-8 animate-spin" style={{ color: colors.primary }} />
                </div>
            </div>
        );
    }

    return (
        <div className="p-4 sm:p-6 lg:p-8 max-w-5xl mx-auto space-y-6">
            <PageHeader
                title="AI Provider Settings"
                subtitle="Manage API keys for AI providers. Keys are used for document processing, vision models, chat, and search."
            />
            {loading && (
                <div className="flex items-center gap-2 text-sm text-foreground-muted">
                    <Loader2 className="h-4 w-4 animate-spin" style={{ color: colors.primary }} />
                    Refreshing…
                </div>
            )}
            {error && (
                <div className="rounded-xl border border-red-500/30 bg-red-500/10 text-red-300 px-4 py-3 text-sm flex items-center gap-2">
                    <AlertTriangle size={16} />
                    {error}
                </div>
            )}
            {saveSuccess && (
                <div className="rounded-xl border border-emerald-500/30 bg-emerald-500/10 text-emerald-800 dark:text-emerald-300 px-4 py-3 text-sm flex items-center gap-2">
                    <Check size={16} />
                    {saveSuccess}
                </div>
            )}

            {/* Agent API — external apps */}
            <div className="rounded-2xl border border-border bg-white p-5 space-y-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                        <div className="flex items-center gap-2">
                            <Plug size={18} className="text-(--vb-blue-dark)" />
                            <h3 className="text-sm font-bold text-foreground">Agent API (for customer apps)</h3>
                        </div>
                        <p className="text-xs text-foreground-muted mt-1 leading-relaxed max-w-2xl">
                            Give partners a token + endpoint so their own application can call your agents
                            (Compliance, HR, Finance, …) without opening DocuGemma UI.
                        </p>
                    </div>
                    <div className="flex flex-wrap gap-2">
                        <button
                            type="button"
                            onClick={() => void rotateAgentApi()}
                            disabled={agentApiBusy}
                            className="btn-secondary rounded-xl px-3 py-2 text-xs inline-flex items-center gap-1.5 disabled:opacity-50"
                        >
                            {agentApiBusy ? <Loader2 size={12} className="animate-spin" /> : <RotateCcw size={12} />}
                            {agentApi?.hasToken ? "Rotate token" : "Create token"}
                        </button>
                        {agentApi?.hasToken && agentApi.isActive && (
                            <button
                                type="button"
                                onClick={() => void revokeAgentApi()}
                                disabled={agentApiBusy}
                                className="rounded-xl px-3 py-2 text-xs border border-rose-300 text-rose-800 hover:bg-rose-50 disabled:opacity-50"
                            >
                                Revoke
                            </button>
                        )}
                    </div>
                </div>

                {agentApiLoading ? (
                    <p className="text-xs text-foreground-muted inline-flex items-center gap-1.5">
                        <Loader2 size={12} className="animate-spin" /> Loading…
                    </p>
                ) : (
                    <div className="space-y-3">
                        <div className="space-y-1">
                            <p className="text-[11px] text-foreground-muted">Ask URL (all agents on your plan)</p>
                            <div className="flex gap-2 items-start">
                                <code className="flex-1 text-xs font-mono break-all rounded-lg border border-border bg-white px-2.5 py-2">
                                    {agentApi?.askUrlTemplate || "—"}
                                </code>
                                {agentApi?.askUrlTemplate && (
                                    <button
                                        type="button"
                                        className="btn-secondary shrink-0 rounded-lg px-3 py-2 text-xs inline-flex items-center gap-1"
                                        onClick={() => void copyText(agentApi.askUrlTemplate)}
                                    >
                                        <Copy size={12} /> Copy
                                    </button>
                                )}
                            </div>
                        </div>
                        <div className="space-y-1">
                            <p className="text-[11px] text-foreground-muted">API token</p>
                            <div className="flex gap-2 items-start">
                                <textarea
                                    readOnly
                                    rows={2}
                                    value={agentApiFreshToken || agentApi?.tokenMasked || "No token yet — click Create token"}
                                    className="flex-1 text-xs font-mono rounded-lg border border-border bg-white px-2.5 py-2 text-foreground resize-y min-h-11 select-all"
                                    onFocus={(e) => e.currentTarget.select()}
                                />
                                {agentApiFreshToken && (
                                    <button
                                        type="button"
                                        className="btn-secondary shrink-0 rounded-lg px-3 py-2 text-xs inline-flex items-center gap-1"
                                        onClick={() => void copyText(agentApiFreshToken)}
                                    >
                                        <Copy size={12} /> Copy
                                    </button>
                                )}
                            </div>
                            {agentApiFreshToken && (
                                <p className="text-[11px] text-amber-700">
                                    Copy the full token now — it won’t be shown again after you leave this page.
                                </p>
                            )}
                        </div>
                        {agentApi?.allowedAgents && agentApi.allowedAgents.length > 0 && (
                            <p className="text-[11px] text-foreground-muted">
                                Entitled agents:{" "}
                                <strong className="text-foreground">
                                    {agentApi.allowedAgents.map((a) => a.label).join(", ")}
                                </strong>
                            </p>
                        )}
                        {agentApiCurl && (
                            <div className="space-y-1">
                                <p className="text-[11px] text-foreground-muted">Example cURL</p>
                                <pre className="text-[10px] rounded-lg border border-border bg-white px-2.5 py-2 overflow-x-auto text-foreground-muted whitespace-pre-wrap">
                                    {agentApiCurl}
                                </pre>
                                <button
                                    type="button"
                                    className="text-[11px] text-accent hover:underline inline-flex items-center gap-1"
                                    onClick={() => void copyText(agentApiCurl)}
                                >
                                    <Copy size={11} /> Copy cURL
                                </button>
                            </div>
                        )}
                    </div>
                )}
            </div>

            {/* Active Provider Selector Card */}
            <div className="surface-card border border-border rounded-2xl p-5 space-y-3 bg-linear-to-r from-surface-2/60 to-surface">
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                    <div>
                        <div className="flex items-center gap-2">
                            <Brain size={18} className="text-amber-400" />
                            <h3 className="text-sm font-bold text-foreground">Active AI & Vision Provider</h3>
                        </div>
                        <p className="text-xs text-foreground-muted mt-1">
                            Select which uploaded API key to use for Vision, OCR, and AI processing. Only configured keys are shown below.
                        </p>
                    </div>

                    <div className="flex items-center gap-2 min-w-60">
                        <select
                            value={keys.find((k) => k.isActive)?.provider || ""}
                            onChange={(e) => handleSetPrimary(e.target.value as Provider)}
                            disabled={settingPrimary || configuredKeys.length === 0}
                            className="w-full premium-input rounded-xl px-4 py-2.5 text-sm font-medium border border-border bg-surface text-foreground focus:ring-2 focus:ring-accent cursor-pointer"
                        >
                            {configuredKeys.length === 0 ? (
                                <option value="">No Configured API Keys Found</option>
                            ) : (
                                configuredKeys.map((k) => (
                                    <option key={k.provider} value={k.provider}>
                                        {k.label || k.provider.toUpperCase()} ({k.provider})
                                    </option>
                                ))
                            )}
                        </select>
                        {settingPrimary && <Loader2 size={16} className="animate-spin text-accent shrink-0" />}
                    </div>
                </div>
            </div>

            {/* Provider Cards */}
            <div className="grid gap-4">
                {(Object.keys(PROVIDER_CONFIG) as Provider[]).map((provider) => {
                    const config = PROVIDER_CONFIG[provider];
                    const existing = getKeyForProvider(provider);
                    const isEditing = editingProvider === provider;
                    const hasKey = existing?.hasKey || false;

                    return (
                        <div
                            key={provider}
                            className={`surface-card border transition-all ${
                                isEditing ? "border-accent" : hasKey ? config.borderColor : "border-border"
                            }`}
                        >
                            {/* Header */}
                            <div className="px-5 py-4 flex items-center justify-between">
                                <div className="flex items-center gap-3">
                                    <div className={`h-11 w-11 rounded-xl ${config.bgColor} ${config.color} flex items-center justify-center`}>
                                        {config.icon}
                                    </div>
                                    <div>
                                        <div className="flex items-center gap-2">
                                            <h3 className="text-sm font-bold text-foreground">{existing?.label || config.description.split(".")[0]}</h3>
                                            {hasKey && existing?.isActive && (
                                                <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-semibold bg-emerald-500/15 text-emerald-300 border border-emerald-500/25">
                                                    Active
                                                </span>
                                            )}
                                            {hasKey && !existing?.isActive && (
                                                <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-semibold bg-amber-500/15 text-amber-300 border border-amber-500/25">
                                                    Disabled
                                                </span>
                                            )}
                                            {!hasKey && (
                                                <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-semibold bg-white/5 text-foreground-muted border border-border">
                                                    Not configured
                                                </span>
                                            )}
                                        </div>
                                        <p className="text-xs text-foreground-muted mt-0.5">{config.description}</p>
                                    </div>
                                </div>

                                <div className="flex items-center gap-2">
                                    {hasKey && existing?.model && (
                                        <span className="text-[11px] text-foreground-muted hidden sm:block">
                                            Model: {existing.model}
                                        </span>
                                    )}
                                    {hasKey && (
                                        <button
                                            type="button"
                                            onClick={() => toggleKey(existing!.keyId)}
                                            className={`p-1.5 rounded-lg transition-colors ${
                                                existing?.isActive
                                                    ? "text-emerald-400 hover:bg-emerald-500/15"
                                                    : "text-amber-400 hover:bg-amber-500/15"
                                            }`}
                                            title={existing?.isActive ? "Disable" : "Enable"}
                                        >
                                            {existing?.isActive ? <Check size={15} /> : <RotateCcw size={15} />}
                                        </button>
                                    )}
                                    <button
                                        type="button"
                                        onClick={() => isEditing ? cancelEdit() : startEdit(provider)}
                                        className={`btn-secondary rounded-lg px-3 py-2 text-xs font-medium ${
                                            isEditing ? "border-red-500/30 text-red-300" : ""
                                        }`}
                                    >
                                        {isEditing ? "Cancel" : hasKey ? "Update" : "Add Key"}
                                    </button>
                                </div>
                            </div>

                            {/* Existing Key Display */}
                            {hasKey && !isEditing && (
                                <div className="px-5 pb-4">
                                    <div className="flex items-center gap-2 rounded-xl bg-surface-2/60 border border-border px-4 py-2.5">
                                        <Key size={13} className="text-foreground-muted shrink-0" />
                                        <span className="text-xs font-mono text-foreground-muted flex-1 min-w-0 truncate">
                                            {showKeys[existing!.keyId] ? existing!.apiKey : "****" + existing!.apiKey.slice(-4)}
                                        </span>
                                        <button
                                            type="button"
                                            onClick={() => toggleShowKey(existing!.keyId)}
                                            className="text-foreground-muted hover:text-foreground transition-colors"
                                            aria-label={showKeys[existing!.keyId] ? "Hide API key" : "Show API key"}
                                            title={showKeys[existing!.keyId] ? "Hide API key" : "Show API key"}
                                        >
                                            {showKeys[existing!.keyId] ? <EyeOff size={13} /> : <Eye size={13} />}
                                        </button>
                                        <button
                                            type="button"
                                            onClick={() => deleteKey(existing!.keyId, existing!.label)}
                                            className="text-foreground-muted hover:text-red-400 transition-colors"
                                            aria-label={`Delete ${existing!.label} API key`}
                                            title={`Delete ${existing!.label} API key`}
                                        >
                                            <Trash2 size={13} />
                                        </button>
                                    </div>
                                </div>
                            )}

                            {/* Edit Form */}
                            {isEditing && (
                                <div className="px-5 pb-5 space-y-3 border-t border-border pt-4">
                                    <div>
                                        <label className="text-[10px] uppercase tracking-wider font-semibold text-foreground-muted block mb-1.5">
                                            API Key *
                                        </label>
                                        <input
                                            type="password"
                                            value={formKey}
                                            onChange={(e) => setFormKey(e.target.value)}
                                            placeholder={getKeyForProvider(provider) ? "Enter new key to replace..." : "Paste your API key..."}
                                            className="w-full premium-input rounded-xl px-4 py-2.5 text-sm font-mono"
                                            autoComplete="off"
                                        />
                                    </div>
                                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                                        <div>
                                            <label className="text-[10px] uppercase tracking-wider font-semibold text-foreground-muted block mb-1.5">
                                                Model
                                            </label>
                                            <input
                                                type="text"
                                                value={formModel}
                                                onChange={(e) => setFormModel(e.target.value)}
                                                placeholder={defaults?.[provider]?.model || "e.g., gpt-4o"}
                                                className="w-full premium-input rounded-xl px-4 py-2.5 text-sm"
                                            />
                                        </div>
                                        <div>
                                            <label className="text-[10px] uppercase tracking-wider font-semibold text-foreground-muted block mb-1.5">
                                                Label
                                            </label>
                                            <input
                                                type="text"
                                                value={formLabel}
                                                onChange={(e) => setFormLabel(e.target.value)}
                                                placeholder={defaults?.[provider]?.label || provider}
                                                className="w-full premium-input rounded-xl px-4 py-2.5 text-sm"
                                            />
                                        </div>
                                    </div>
                                    {provider === "custom" && (
                                        <div>
                                            <label className="text-[10px] uppercase tracking-wider font-semibold text-foreground-muted block mb-1.5">
                                                Base URL
                                            </label>
                                            <input
                                                type="text"
                                                value={formBaseUrl}
                                                onChange={(e) => setFormBaseUrl(e.target.value)}
                                                placeholder="https://your-api-endpoint.com/v1"
                                                className="w-full premium-input rounded-xl px-4 py-2.5 text-sm"
                                            />
                                        </div>
                                    )}
                                    <div className="flex gap-2 pt-1">
                                        <button
                                            type="button"
                                            onClick={saveKey}
                                            disabled={saving || (!formKey && !getKeyForProvider(provider))}
                                            className="btn-gradient rounded-xl px-5 py-2.5 text-sm font-semibold flex items-center gap-2"
                                        >
                                            {saving ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
                                            Save {formLabel || provider}
                                        </button>
                                        <button
                                            type="button"
                                            onClick={cancelEdit}
                                            className="btn-secondary rounded-xl px-5 py-2.5 text-sm"
                                        >
                                            Cancel
                                        </button>
                                    </div>
                                </div>
                            )}
                        </div>
                    );
                })}
            </div>

            <div className="rounded-xl border border-border bg-surface-2/40 overflow-hidden">
                <div className="px-5 py-4 border-b border-border flex items-center gap-3">
                    <div className="p-2 rounded-lg bg-emerald-500/15 text-emerald-300">
                        <Coins size={18} />
                    </div>
                    <div>
                        <h2 className="text-sm font-semibold text-foreground">Finance analytics</h2>
                        <p className="text-xs text-foreground-muted">
                            Vendor name aliases merge OCR typos in charts; base currency labels KPI totals when set.
                        </p>
                    </div>
                </div>
                <div className="px-5 py-5 space-y-4">
                    {financeLoading ? (
                        <div className="flex items-center gap-2 text-sm text-foreground-muted">
                            <Loader2 size={14} className="animate-spin" />
                            Loading finance settings…
                        </div>
                    ) : (
                        <>
                            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                                <div>
                                    <label className="text-[10px] uppercase tracking-wider font-semibold text-foreground-muted block mb-1.5">
                                        Base currency (ISO 4217)
                                    </label>
                                    <input
                                        type="text"
                                        value={financeBaseCurrency}
                                        onChange={(e) => setFinanceBaseCurrency(e.target.value.toUpperCase().slice(0, 3))}
                                        placeholder="PKR"
                                        className="w-full premium-input rounded-xl px-4 py-2.5 text-sm font-mono uppercase"
                                    />
                                </div>
                                <div>
                                    <label className="text-[10px] uppercase tracking-wider font-semibold text-foreground-muted block mb-1.5">
                                        FY start month (1–12; blank = Jan)
                                    </label>
                                    <input
                                        type="number"
                                        min={1}
                                        max={12}
                                        value={financeFyStartMonth}
                                        onChange={(e) => setFinanceFyStartMonth(e.target.value.replace(/[^0-9]/g, "").slice(0, 2))}
                                        placeholder="7 (July for PK FY)"
                                        className="w-full premium-input rounded-xl px-4 py-2.5 text-sm font-mono"
                                    />
                                </div>
                            </div>
                            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                                <div>
                                    <label className="text-[10px] uppercase tracking-wider font-semibold text-foreground-muted block mb-1.5">
                                        Vendor aliases (one per line: alias=Canonical)
                                    </label>
                                    <textarea
                                        value={financeAliasesText}
                                        onChange={(e) => setFinanceAliasesText(e.target.value)}
                                        rows={5}
                                        placeholder={"glectronic=Digilog\nm/s digilog pvt ltd=Digilog"}
                                        className="w-full premium-input rounded-xl px-4 py-3 text-sm font-mono"
                                    />
                                </div>
                                <div>
                                    <label className="text-[10px] uppercase tracking-wider font-semibold text-foreground-muted block mb-1.5">
                                        Client aliases (one per line: alias=Canonical)
                                    </label>
                                    <textarea
                                        value={financeClientAliasesText}
                                        onChange={(e) => setFinanceClientAliasesText(e.target.value)}
                                        rows={5}
                                        placeholder={"metro cash n carry=Metro Cash & Carry\nk-mart=K-Mart"}
                                        className="w-full premium-input rounded-xl px-4 py-3 text-sm font-mono"
                                    />
                                </div>
                            </div>
                            <div>
                                <label className="text-[10px] uppercase tracking-wider font-semibold text-foreground-muted block mb-1.5">
                                    FX rates (units of currency per 1 base — one per line: CODE=rate)
                                </label>
                                <textarea
                                    value={financeFxText}
                                    onChange={(e) => setFinanceFxText(e.target.value)}
                                    rows={4}
                                    placeholder={"USD=280\nEUR=305\nGBP=355"}
                                    className="w-full premium-input rounded-xl px-4 py-3 text-sm font-mono"
                                />
                                <p className="text-[10px] text-foreground-muted mt-1">
                                    Example: base=PKR, USD=280 means 1 USD → 280 PKR. Amounts without a rate stay in their original currency.
                                </p>
                            </div>
                            <div className="flex items-center gap-3">
                                <button
                                    type="button"
                                    onClick={() => void saveFinanceSettings()}
                                    disabled={financeSaving}
                                    className="btn-gradient rounded-xl px-5 py-2.5 text-sm font-semibold flex items-center gap-2"
                                >
                                    {financeSaving ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
                                    Save finance settings
                                </button>
                                {financeSaveSuccess && (
                                    <span className="text-xs text-emerald-400 flex items-center gap-1">
                                        <Check size={12} />
                                        {financeSaveSuccess}
                                    </span>
                                )}
                            </div>
                        </>
                    )}
                </div>
            </div>

            {/* Info box */}
            <div className="rounded-xl border border-border bg-surface-2/40 p-5 space-y-2">
                <h3 className="text-sm font-semibold text-foreground">How Provider Fallback Works</h3>
                <ul className="text-xs text-foreground-muted space-y-1 list-disc list-inside">
                    <li>The system uses the <strong>Groq</strong> provider by default.</li>
                    <li>If Groq hits a rate limit, it automatically falls back to the next configured provider.</li>
                    <li>Priority order: Groq → OpenAI → Gemini → Anthropic → Custom.</li>
                    <li>Configure at least one provider for AI features to work.</li>
                    <li>Keys are stored securely and never exposed in browser console.</li>
                </ul>
            </div>
        </div>
    );
}

export default function SettingsPage() {
    return (
        <SettingsContent />
    );
}
