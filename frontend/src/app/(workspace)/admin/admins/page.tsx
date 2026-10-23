"use client";

import React, { useCallback, useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import {
    Bot,
    Briefcase,
    Check,
    ChevronDown,
    ChevronRight,
    Clock,
    Building2,
    FileQuestion,
    KeyRound,
    Loader2,
    Pencil,
    Plus,
    RefreshCw,
    Scale,
    Search,
    Shield,
    ShieldCheck,
    Trash2,
    UserCheck,
    UserX,
    Users,
    Wallet,
    Zap,
    X,
} from "lucide-react";
import { PageHeader, EmptyState } from "@/components/ui";
import { Badge } from "@/components/ui/Badge";
import { useTheme } from "@/context/ColorContext";
import { apiRequest } from "@/lib/apiClient";

const AVAILABLE_AGENTS = [
    {
        id: "finance_agent",
        label: "Finance Agent",
        description: "Invoices, cash flow, financial analysis, budgets",
        icon: Wallet,
        color: "text-emerald-400 bg-emerald-500/10 border-emerald-500/30",
    },
    {
        id: "hr_agent",
        label: "HR Agent",
        description: "Talent acquisition, policies, payroll, employee ops",
        icon: Users,
        color: "text-blue-400 bg-blue-500/10 border-blue-500/30",
    },
    {
        id: "legal_agent",
        label: "Legal Agent",
        description: "Contracts, NDAs, regulatory compliance, risk review",
        icon: Scale,
        color: "text-purple-400 bg-purple-500/10 border-purple-500/30",
    },
    {
        id: "procurement_agent",
        label: "Procurement Agent",
        description: "Vendor agreements, POs, supply chain, purchasing",
        icon: Briefcase,
        color: "text-amber-400 bg-amber-500/10 border-amber-500/30",
    },
    {
        id: "compliance_agent",
        label: "Compliance Agent",
        description: "Audit trails, regulatory adherence, standards check",
        icon: ShieldCheck,
        color: "text-teal-400 bg-teal-500/10 border-teal-500/30",
    },
    {
        id: "other_agent",
        label: "General / Other Agent",
        description: "General corporate workspace tasks, document analysis",
        icon: FileQuestion,
        color: "text-gray-400 bg-gray-500/10 border-gray-500/30",
    },
] as const;

const ALL_AGENT_IDS = AVAILABLE_AGENTS.map((a) => a.id);

type TeamMember = {
    userId: string;
    fullName: string;
    email: string;
    username?: string;
    contactNumber?: string;
    status: string;
    permissions?: Record<string, boolean>;
    createdAt?: string;
    lastLogin?: string;
    createdBy?: string;
};

type AIProvider = "groq" | "openai" | "gemini" | "anthropic" | "custom";

const AI_PROVIDERS: { id: AIProvider; label: string; placeholder: string; prefixHint?: string }[] = [
    { id: "openai", label: "OpenAI", placeholder: "sk-proj-...", prefixHint: "sk-..." },
    { id: "groq", label: "Groq", placeholder: "gsk_...", prefixHint: "gsk_..." },
    { id: "gemini", label: "Gemini", placeholder: "AIzaSy...", prefixHint: "AIza..." },
    { id: "anthropic", label: "Claude", placeholder: "sk-ant-...", prefixHint: "sk-ant-..." },
    { id: "custom", label: "Custom", placeholder: "Enter API key..." },
];

const PROVIDER_LABELS: Record<string, string> = {
    openai: "OpenAI",
    groq: "Groq",
    gemini: "Gemini",
    anthropic: "Claude",
    custom: "Custom",
};

const DEFAULT_PROVIDER_MODELS: Record<AIProvider, string> = {
    openai: "gpt-4o",
    groq: "llama-3.3-70b-versatile",
    gemini: "gemini-2.0-flash",
    anthropic: "claude-3-5-sonnet-20241022",
    custom: "",
};

type OrganizationInfo = {
    organizationId: string;
    organizationName: string;
    status?: string;
    subscriptionPlan?: string;
    contactEmail?: string;
    hasAiApiKey?: boolean;
    aiProvider?: string | null;
    aiProviderLabel?: string | null;
    aiBaseUrl?: string | null;
    aiModel?: string | null;
    aiKeyMasked?: string | null;
    configuredProviders?: string[];
    hasGroqApiKey?: boolean;
    groqApiKeyMasked?: string | null;
    agentIds?: string[];
};

type Admin = {
    userId: string;
    fullName: string;
    email: string;
    username?: string;
    contactNumber?: string;
    status: string;
    accountType?: string;
    organizationId?: string | null;
    organization?: OrganizationInfo | null;
    agentIds?: string[];
    teamMembers?: TeamMember[];
    teamMemberCount?: number;
    createdAt?: string;
    lastLogin?: string;
    emailVerified?: boolean;
};

type AdminFormState = {
    fullName: string;
    email: string;
    password: string;
    contactNumber: string;
    organizationName: string;
    status: "active" | "blocked";
    aiProvider: AIProvider;
    apiKey: string;
    providerName?: string;
    baseUrl?: string;
    model?: string;
    agentIds: string[];
};

const EMPTY_CREATE_FORM: AdminFormState = {
    fullName: "",
    email: "",
    password: "",
    contactNumber: "",
    organizationName: "",
    status: "active",
    aiProvider: "openai",
    apiKey: "",
    providerName: "",
    baseUrl: "",
    model: "gpt-4o",
    agentIds: [...ALL_AGENT_IDS],
};

const AVATAR_COLORS = [
    "bg-rose-500/20 text-rose-400",
    "bg-blue-500/20 text-blue-400",
    "bg-emerald-500/20 text-emerald-400",
    "bg-amber-500/20 text-amber-400",
    "bg-violet-500/20 text-violet-400",
    "bg-blue-500/20 text-(--vb-blue-bright)",
    "bg-pink-500/20 text-pink-400",
    "bg-lime-500/20 text-lime-400",
];

const fieldClass =
    "w-full h-11 px-3.5 rounded-xl text-sm bg-surface-2 border border-border text-foreground placeholder:text-foreground-muted outline-none focus:border-accent focus:ring-2 focus:ring-[rgba(56,182,255,0.18)] transition-all";

const labelClass = "text-[11px] font-semibold uppercase tracking-wide text-foreground-muted";

function getAvatarColor(name: string) {
    let hash = 0;
    for (let i = 0; i < name.length; i++) hash = name.charCodeAt(i) + ((hash << 5) - hash);
    return AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length];
}

function getInitials(name: string) {
    const parts = name.trim().split(/\s+/);
    if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
    return (parts[0]?.[0] || "?").toUpperCase();
}

function timeAgo(value?: string) {
    if (!value) return null;
    try {
        const diff = Date.now() - new Date(value).getTime();
        const mins = Math.floor(diff / 60000);
        if (mins < 1) return "just now";
        if (mins < 60) return `${mins}m ago`;
        const hrs = Math.floor(mins / 60);
        if (hrs < 24) return `${hrs}h ago`;
        const days = Math.floor(hrs / 24);
        if (days < 30) return `${days}d ago`;
        const months = Math.floor(days / 30);
        return `${months}mo ago`;
    } catch {
        return null;
    }
}

function formatDate(value?: string) {
    if (!value) return "—";
    try {
        return new Date(value).toLocaleDateString("en-US", {
            month: "short",
            day: "numeric",
            year: "numeric",
            hour: "2-digit",
            minute: "2-digit",
        });
    } catch {
        return "—";
    }
}

function permCount(permissions?: Record<string, boolean>) {
    if (!permissions) return 0;
    return Object.values(permissions).filter(Boolean).length;
}

function AdminsContent() {
    const { theme } = useTheme();
    const colors = theme.colors;
    const [admins, setAdmins] = useState<Admin[]>([]);
    const [error, setError] = useState<string | null>(null);
    const [loading, setLoading] = useState(true);
    const [expanded, setExpanded] = useState<Record<string, boolean>>({});
    const [searchQuery, setSearchQuery] = useState("");

    const [showCreate, setShowCreate] = useState(false);
    const [createForm, setCreateForm] = useState<AdminFormState>(EMPTY_CREATE_FORM);
    const [createError, setCreateError] = useState<string | null>(null);
    const [creating, setCreating] = useState(false);

    const [editingAdmin, setEditingAdmin] = useState<Admin | null>(null);
    const [editForm, setEditForm] = useState<AdminFormState>(EMPTY_CREATE_FORM);
    const [editError, setEditError] = useState<string | null>(null);
    const [saving, setSaving] = useState(false);

    const [deletingId, setDeletingId] = useState<string | null>(null);
    const [statusBusyId, setStatusBusyId] = useState<string | null>(null);

    // AI Key Modal state
    const [aiKeyModalOrg, setAiKeyModalOrg] = useState<{
        orgId: string;
        orgName: string;
        currentKeyMasked?: string | null;
        currentProvider?: string | null;
        currentProviderLabel?: string | null;
        currentBaseUrl?: string | null;
        currentModel?: string | null;
    } | null>(null);
    const [aiProviderInput, setAiProviderInput] = useState<AIProvider>("openai");
    const [aiApiKeyInput, setAiApiKeyInput] = useState("");
    const [aiProviderNameInput, setAiProviderNameInput] = useState("");
    const [aiBaseUrlInput, setAiBaseUrlInput] = useState("");
    const [aiModelInput, setAiModelInput] = useState("");
    const [aiKeyError, setAiKeyError] = useState<string | null>(null);
    const [aiKeySuccess, setAiKeySuccess] = useState<string | null>(null);
    const [aiKeySaving, setAiKeySaving] = useState(false);
    const [aiKeyDeleting, setAiKeyDeleting] = useState(false);

    const load = useCallback(async () => {
        setLoading(true);
        try {
            const data = await apiRequest("/docs/super-admin/admins");
            setAdmins(data?.data?.admins || []);
            setError(null);
        } catch (e: any) {
            setError(e.message);
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        load();
    }, [load]);

    const openCreate = () => {
        setCreateForm({
            ...EMPTY_CREATE_FORM,
            agentIds: [...ALL_AGENT_IDS],
        });
        setCreateError(null);
        setShowCreate(true);
    };

    const closeCreate = () => {
        if (creating) return;
        setShowCreate(false);
        setCreateError(null);
    };

    const openEdit = (admin: Admin) => {
        setEditingAdmin(admin);
        const effectiveAgents = (admin.agentIds && admin.agentIds.length > 0)
            ? admin.agentIds
            : (admin.organization?.agentIds && admin.organization.agentIds.length > 0)
            ? admin.organization.agentIds
            : ALL_AGENT_IDS;
        const effectiveProvider = (admin.organization?.aiProvider as AIProvider) || "openai";
        const effectiveKey = admin.organization?.aiKeyMasked || admin.organization?.groqApiKeyMasked || "";
        setEditForm({
            fullName: admin.fullName || "",
            email: admin.email || "",
            password: "",
            contactNumber: admin.contactNumber || "",
            organizationName: admin.organization?.organizationName || "",
            status: admin.status === "blocked" ? "blocked" : "active",
            aiProvider: effectiveProvider,
            apiKey: effectiveKey,
            providerName: admin.organization?.aiProviderLabel || "",
            baseUrl: admin.organization?.aiBaseUrl || "",
            model: admin.organization?.aiModel || DEFAULT_PROVIDER_MODELS[effectiveProvider] || "",
            agentIds: [...effectiveAgents],
        });
        setEditError(null);
    };

    const closeEdit = () => {
        if (saving) return;
        setEditingAdmin(null);
        setEditError(null);
    };

    const toggleAgentInForm = (formType: "create" | "edit", agentId: string) => {
        if (formType === "create") {
            setCreateForm((prev) => {
                const exists = prev.agentIds.includes(agentId);
                return {
                    ...prev,
                    agentIds: exists
                        ? prev.agentIds.filter((id) => id !== agentId)
                        : [...prev.agentIds, agentId],
                };
            });
        } else {
            setEditForm((prev) => {
                const exists = prev.agentIds.includes(agentId);
                return {
                    ...prev,
                    agentIds: exists
                        ? prev.agentIds.filter((id) => id !== agentId)
                        : [...prev.agentIds, agentId],
                };
            });
        }
    };

    const selectAllAgents = (formType: "create" | "edit") => {
        if (formType === "create") {
            setCreateForm((prev) => ({ ...prev, agentIds: [...ALL_AGENT_IDS] }));
        } else {
            setEditForm((prev) => ({ ...prev, agentIds: [...ALL_AGENT_IDS] }));
        }
    };

    const clearAllAgents = (formType: "create" | "edit") => {
        if (formType === "create") {
            setCreateForm((prev) => ({ ...prev, agentIds: [] }));
        } else {
            setEditForm((prev) => ({ ...prev, agentIds: [] }));
        }
    };

    const openAiKeyModal = (
        orgId: string,
        orgName: string,
        currentKeyMasked?: string | null,
        currentProvider?: string | null,
        currentProviderLabel?: string | null,
        currentBaseUrl?: string | null,
        currentModel?: string | null
    ) => {
        const prov = (currentProvider as AIProvider) || "openai";
        setAiKeyModalOrg({
            orgId,
            orgName,
            currentKeyMasked,
            currentProvider,
            currentProviderLabel,
            currentBaseUrl,
            currentModel,
        });
        setAiProviderInput(prov);
        setAiApiKeyInput("");
        setAiProviderNameInput(currentProviderLabel || "");
        setAiBaseUrlInput(currentBaseUrl || "");
        setAiModelInput(currentModel || DEFAULT_PROVIDER_MODELS[prov] || "");
        setAiKeyError(null);
        setAiKeySuccess(null);
    };

    const closeAiKeyModal = () => {
        if (aiKeySaving || aiKeyDeleting) return;
        setAiKeyModalOrg(null);
        setAiApiKeyInput("");
        setAiProviderNameInput("");
        setAiBaseUrlInput("");
        setAiModelInput("");
        setAiKeyError(null);
        setAiKeySuccess(null);
    };

    const saveAiKey = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!aiKeyModalOrg) return;
        const key = aiApiKeyInput.trim();
        if (!key) {
            setAiKeyError("Please enter an API key");
            return;
        }
        if (key.length < 6) {
            setAiKeyError("API key must be at least 6 characters long");
            return;
        }
        setAiKeySaving(true);
        setAiKeyError(null);
        setAiKeySuccess(null);
        try {
            const body: Record<string, any> = { provider: aiProviderInput, apiKey: key };
            if (aiModelInput.trim()) {
                body.model = aiModelInput.trim();
            } else if (DEFAULT_PROVIDER_MODELS[aiProviderInput]) {
                body.model = DEFAULT_PROVIDER_MODELS[aiProviderInput];
            }
            if (aiProviderInput === "custom") {
                if (aiProviderNameInput.trim()) body.providerName = aiProviderNameInput.trim();
                if (aiBaseUrlInput.trim()) body.baseUrl = aiBaseUrlInput.trim();
            }
            await apiRequest(`/docs/super-admin/organizations/${aiKeyModalOrg.orgId}/ai-key`, {
                method: "POST",
                body: JSON.stringify(body),
            });
            const providerDisplay = (aiProviderInput === "custom" && aiProviderNameInput.trim())
                ? aiProviderNameInput.trim()
                : (PROVIDER_LABELS[aiProviderInput] || aiProviderInput);
            setAiKeySuccess(`${providerDisplay} API key saved successfully!`);
            setAiApiKeyInput("");
            await load();
            setTimeout(() => {
                setAiKeyModalOrg(null);
                setAiKeySuccess(null);
            }, 1200);
        } catch (err: any) {
            setAiKeyError(err.message || "Failed to update AI API key");
        } finally {
            setAiKeySaving(false);
        }
    };

    const deleteAiKey = async () => {
        if (!aiKeyModalOrg) return;
        if (!confirm(`Delete AI API key for organization "${aiKeyModalOrg.orgName}"?`)) return;
        setAiKeyDeleting(true);
        setAiKeyError(null);
        setAiKeySuccess(null);
        try {
            await apiRequest(`/docs/super-admin/organizations/${aiKeyModalOrg.orgId}/ai-key`, {
                method: "DELETE",
            });
            setAiKeySuccess("AI API key deleted!");
            await load();
            setTimeout(() => {
                setAiKeyModalOrg(null);
                setAiKeySuccess(null);
            }, 1200);
        } catch (err: any) {
            setAiKeyError(err.message || "Failed to delete AI API key");
        } finally {
            setAiKeyDeleting(false);
        }
    };

    const createAdmin = async (e: React.FormEvent) => {
        e.preventDefault();
        setCreating(true);
        setCreateError(null);
        try {
            const body: Record<string, any> = {
                fullName: createForm.fullName.trim(),
                email: createForm.email.trim(),
                password: createForm.password,
                organizationName: createForm.organizationName.trim(),
                status: createForm.status,
                agentIds: createForm.agentIds,
            };
            if (createForm.contactNumber.trim()) {
                body.contactNumber = createForm.contactNumber.trim();
            }
            if (createForm.apiKey.trim()) {
                body.apiKey = createForm.apiKey.trim();
                body.aiProvider = createForm.aiProvider;
                if (createForm.model?.trim()) {
                    body.model = createForm.model.trim();
                } else if (DEFAULT_PROVIDER_MODELS[createForm.aiProvider]) {
                    body.model = DEFAULT_PROVIDER_MODELS[createForm.aiProvider];
                }
                if (createForm.aiProvider === "custom") {
                    if (createForm.providerName?.trim()) body.providerName = createForm.providerName.trim();
                    if (createForm.baseUrl?.trim()) body.baseUrl = createForm.baseUrl.trim();
                }
                if (createForm.aiProvider === "groq") {
                    body.groqApiKey = createForm.apiKey.trim();
                }
            }
            await apiRequest("/docs/super-admin/admins", {
                method: "POST",
                body: JSON.stringify(body),
            });
            setShowCreate(false);
            setCreateForm({ ...EMPTY_CREATE_FORM, agentIds: [...ALL_AGENT_IDS] });
            await load();
        } catch (err: any) {
            setCreateError(err.message || "Failed to create admin");
        } finally {
            setCreating(false);
        }
    };

    const saveAdmin = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!editingAdmin) return;
        setSaving(true);
        setEditError(null);
        try {
            const body: Record<string, any> = {
                fullName: editForm.fullName.trim(),
                email: editForm.email.trim(),
                contactNumber: editForm.contactNumber.trim(),
                organizationName: editForm.organizationName.trim(),
                status: editForm.status,
                agentIds: editForm.agentIds,
            };
            if (editForm.password.trim()) {
                body.password = editForm.password;
            }
            const trimmedKey = editForm.apiKey.trim();
            if (trimmedKey && !trimmedKey.includes("•")) {
                body.apiKey = trimmedKey;
                body.aiProvider = editForm.aiProvider;
                if (editForm.model?.trim()) {
                    body.model = editForm.model.trim();
                } else if (DEFAULT_PROVIDER_MODELS[editForm.aiProvider]) {
                    body.model = DEFAULT_PROVIDER_MODELS[editForm.aiProvider];
                }
                if (editForm.aiProvider === "custom") {
                    if (editForm.providerName?.trim()) body.providerName = editForm.providerName.trim();
                    if (editForm.baseUrl?.trim()) body.baseUrl = editForm.baseUrl.trim();
                }
                if (editForm.aiProvider === "groq") {
                    body.groqApiKey = trimmedKey;
                }
            } else if (editForm.aiProvider) {
                body.aiProvider = editForm.aiProvider;
                if (editForm.model?.trim()) {
                    body.model = editForm.model.trim();
                } else if (DEFAULT_PROVIDER_MODELS[editForm.aiProvider]) {
                    body.model = DEFAULT_PROVIDER_MODELS[editForm.aiProvider];
                }
                if (editForm.aiProvider === "custom") {
                    if (editForm.providerName?.trim()) body.providerName = editForm.providerName.trim();
                    if (editForm.baseUrl?.trim()) body.baseUrl = editForm.baseUrl.trim();
                }
            }
            await apiRequest(`/docs/super-admin/admins/${editingAdmin.userId}`, {
                method: "PUT",
                body: JSON.stringify(body),
            });
            setEditingAdmin(null);
            await load();
        } catch (err: any) {
            setEditError(err.message || "Failed to update admin");
        } finally {
            setSaving(false);
        }
    };

    const toggleStatus = async (userId: string, status: string) => {
        const next = status === "active" ? "blocked" : "active";
        setStatusBusyId(userId);
        setError(null);
        try {
            await apiRequest(`/docs/super-admin/admins/${userId}/status`, {
                method: "PATCH",
                body: JSON.stringify({ status: next }),
            });
            await load();
        } catch (err: any) {
            setError(err.message || "Failed to update status");
        } finally {
            setStatusBusyId(null);
        }
    };

    const removeAdmin = async (admin: Admin) => {
        const name = admin.fullName || admin.email;
        if (!confirm(`Delete admin "${name}"? This cannot be undone.`)) return;
        setDeletingId(admin.userId);
        setError(null);
        try {
            await apiRequest(`/docs/super-admin/admins/${admin.userId}`, { method: "DELETE" });
            await load();
        } catch (err: any) {
            setError(err.message || "Failed to delete admin");
        } finally {
            setDeletingId(null);
        }
    };

    const toggleExpand = (userId: string) => {
        setExpanded((prev) => ({ ...prev, [userId]: !prev[userId] }));
    };

    const filtered = useMemo(() => {
        if (!searchQuery.trim()) return admins;
        const q = searchQuery.toLowerCase();
        return admins.filter(
            (a) =>
                a.fullName.toLowerCase().includes(q) ||
                a.email.toLowerCase().includes(q) ||
                (a.organization?.organizationName || "").toLowerCase().includes(q)
        );
    }, [admins, searchQuery]);

    const stats = useMemo(() => {
        const totalAdmins = admins.length;
        const activeAdmins = admins.filter((a) => a.status === "active").length;
        const inactiveAdmins = admins.filter((a) => a.status !== "active").length;
        const totalMembers = admins.reduce((acc, a) => acc + (a.teamMemberCount ?? a.teamMembers?.length ?? 0), 0);
        return { totalAdmins, activeAdmins, inactiveAdmins, totalMembers };
    }, [admins]);

    return (
        <div className="p-4 sm:p-6 lg:p-8 max-w-6xl mx-auto space-y-6 animate-fade-in-up">
            <PageHeader
                title="Super Admin Panel"
                subtitle="Manage all admin accounts, their organizations, and team members"
                actions={
                    <div className="flex items-center gap-2">
                        <button
                            type="button"
                            onClick={load}
                            className="btn-secondary rounded-xl px-4 py-2 text-sm inline-flex items-center gap-2 min-h-10"
                        >
                            <RefreshCw size={14} /> Refresh
                        </button>
                        <button
                            type="button"
                            onClick={openCreate}
                            className="btn-primary rounded-xl px-4 py-2 text-sm inline-flex items-center gap-2 min-h-10"
                        >
                            <Plus size={14} /> Create Admin
                        </button>
                    </div>
                }
            />

            {error && (
                <div className="flex items-center gap-2 px-4 py-3 rounded-xl bg-error-muted border border-[rgba(248,113,113,0.25)] text-sm text-error">
                    <X size={14} />
                    {error}
                </div>
            )}

            {/* Stats Cards */}
            {!loading && admins.length > 0 && (
                <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
                    {[
                        {
                            label: "Total Admins",
                            value: stats.totalAdmins,
                            icon: Shield,
                            color: "text-accent",
                            bg: "bg-accent-muted",
                        },
                        {
                            label: "Active",
                            value: stats.activeAdmins,
                            icon: UserCheck,
                            color: "text-emerald-400",
                            bg: "bg-emerald-500/10",
                        },
                        {
                            label: "Inactive",
                            value: stats.inactiveAdmins,
                            icon: UserX,
                            color: "text-rose-400",
                            bg: "bg-rose-500/10",
                        },
                        {
                            label: "Team Members",
                            value: stats.totalMembers,
                            icon: Users,
                            color: "text-amber-400",
                            bg: "bg-amber-500/10",
                        },
                    ].map((s) => (
                        <div key={s.label} className="surface-card p-4 flex items-center gap-3">
                            <span className={`h-10 w-10 rounded-xl ${s.bg} ${s.color} flex items-center justify-center shrink-0`}>
                                <s.icon className="h-5 w-5" />
                            </span>
                            <div>
                                <p className="text-2xl font-bold tracking-tight text-foreground tabular-nums font-mono">
                                    {s.value}
                                </p>
                                <p className="text-[11px] text-foreground-muted uppercase tracking-wide font-medium">
                                    {s.label}
                                </p>
                            </div>
                        </div>
                    ))}
                </div>
            )}

            {/* Search Bar */}
            {!loading && admins.length > 0 && (
                <div className="relative">
                    <Search size={16} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-foreground-muted" />
                    <input
                        type="text"
                        placeholder="Search admins by name, email, or organization..."
                        value={searchQuery}
                        onChange={(e) => setSearchQuery(e.target.value)}
                        className="w-full h-11 pl-10 pr-10 rounded-xl text-sm bg-surface border border-border text-foreground placeholder:text-foreground-muted outline-none focus:border-accent focus:ring-2 focus:ring-[rgba(56,182,255,0.15)] transition-shadow"
                    />
                    {searchQuery && (
                        <button
                            type="button"
                            onClick={() => setSearchQuery("")}
                            className="absolute right-3 top-1/2 -translate-y-1/2 text-foreground-muted hover:text-foreground"
                        >
                            <X size={14} />
                        </button>
                    )}
                </div>
            )}

            {/* Admin List */}
            <div className="surface-card overflow-hidden">
                {loading ? (
                    <div className={`p-8 text-sm ${colors.textMuted}`}>Loading admins…</div>
                ) : filtered.length === 0 ? (
                    <div className="p-8">
                        <EmptyState
                            icon={<Shield size={28} className="text-accent" />}
                            title={searchQuery ? "No matching admins" : "No admins yet"}
                            description={
                                searchQuery
                                    ? `No admins match "${searchQuery}". Try a different search.`
                                    : "Create Admin to add a company admin account with an organization."
                            }
                        />
                        {!searchQuery && (
                            <div className="flex justify-center mt-4">
                                <button
                                    type="button"
                                    onClick={openCreate}
                                    className="btn-primary rounded-xl px-4 py-2 text-sm inline-flex items-center gap-2 min-h-10"
                                >
                                    <Plus size={14} /> Create Admin
                                </button>
                            </div>
                        )}
                    </div>
                ) : (
                    <ul className="divide-y divide-border">
                        {filtered.map((a) => {
                            const open = !!expanded[a.userId];
                            const members = a.teamMembers || [];
                            const memberCount = a.teamMemberCount ?? members.length;
                            const loginAgo = timeAgo(a.lastLogin);
                            const statusBusy = statusBusyId === a.userId;
                            const deleteBusy = deletingId === a.userId;

                            return (
                                <li key={a.userId} className={`${colors.bgHover} transition-colors`}>
                                    <div className="px-4 sm:px-5 py-4">
                                        <div className="flex flex-col sm:flex-row sm:items-start gap-3">
                                            {/* Left: Avatar + Info */}
                                            <button
                                                type="button"
                                                onClick={() => toggleExpand(a.userId)}
                                                className="flex items-start gap-3 text-left min-w-0 flex-1"
                                            >
                                                <div
                                                    className={`h-11 w-11 rounded-xl ${getAvatarColor(a.fullName)} flex items-center justify-center shrink-0 font-semibold text-sm`}
                                                >
                                                    {getInitials(a.fullName)}
                                                </div>

                                                <div className="min-w-0 flex-1">
                                                    <div className="flex items-center gap-2 flex-wrap">
                                                        <p className={`font-semibold text-[15px] ${colors.textPrimary}`}>
                                                            {a.fullName}
                                                        </p>
                                                        <Badge variant={a.status === "active" ? "success" : "error"}>
                                                            {a.status}
                                                        </Badge>
                                                        <Badge variant="accent">Admin</Badge>
                                                        {((a.agentIds && a.agentIds.length > 0) || (a.organization?.agentIds && a.organization.agentIds.length > 0)) && (
                                                            <Badge variant="accent" className="gap-1">
                                                                <Bot size={11} /> {(a.agentIds || a.organization?.agentIds || []).length} Agents
                                                            </Badge>
                                                        )}
                                                        {a.emailVerified && <Badge variant="success">Verified</Badge>}
                                                        {(a.organization?.hasAiApiKey || a.organization?.hasGroqApiKey) ? (
                                                            <Badge variant="success" className="gap-1">
                                                                <KeyRound size={11} />
                                                                {a.organization?.aiProviderLabel || PROVIDER_LABELS[a.organization?.aiProvider || ""] || "AI"} Key Set
                                                            </Badge>
                                                        ) : (
                                                            <Badge variant="muted" className="gap-1">
                                                                <KeyRound size={11} opacity={0.6} /> No AI Key
                                                            </Badge>
                                                        )}
                                                    </div>
                                                    <p className={`text-sm ${colors.textMuted} mt-1 break-words`}>
                                                        {a.email}
                                                        {a.contactNumber ? ` · ${a.contactNumber}` : ""}
                                                    </p>
                                                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 mt-1.5">
                                                        <span className={`inline-flex items-center gap-1 text-xs ${colors.textMuted}`}>
                                                            <Building2 size={12} />
                                                            {a.organization?.organizationName || "No organization"}
                                                        </span>
                                                        <span className={`inline-flex items-center gap-1 text-xs ${colors.textMuted}`}>
                                                            <Users size={12} />
                                                            {memberCount} member{memberCount === 1 ? "" : "s"}
                                                        </span>
                                                        {loginAgo && (
                                                            <span className={`inline-flex items-center gap-1 text-xs ${colors.textMuted}`}>
                                                                <Clock size={12} />
                                                                Active {loginAgo}
                                                            </span>
                                                        )}
                                                    </div>
                                                </div>
                                            </button>

                                            {/* Right: Actions */}
                                            <div className="flex items-center gap-2 shrink-0 flex-wrap">
                                                <span className="text-foreground-muted">
                                                    {open ? <ChevronDown size={18} /> : <ChevronRight size={18} />}
                                                </span>
                                                {a.organization && (
                                                    <button
                                                        type="button"
                                                        onClick={() =>
                                                            openAiKeyModal(
                                                                a.organization!.organizationId,
                                                                a.organization!.organizationName,
                                                                a.organization!.aiKeyMasked || a.organization!.groqApiKeyMasked,
                                                                a.organization!.aiProvider,
                                                                a.organization!.aiProviderLabel,
                                                                a.organization!.aiBaseUrl,
                                                                a.organization!.aiModel
                                                            )
                                                        }
                                                        className="btn-secondary rounded-lg px-3 py-2 text-sm min-h-10 inline-flex items-center gap-1.5 hover:border-[rgba(56,182,255,0.5)] hover:text-(--vb-blue-bright)"
                                                    >
                                                        <KeyRound size={14} className="text-(--vb-blue-bright)" /> AI Key
                                                    </button>
                                                )}
                                                <button
                                                    type="button"
                                                    onClick={() => openEdit(a)}
                                                    className="btn-secondary rounded-lg px-3 py-2 text-sm min-h-10 inline-flex items-center gap-1.5"
                                                >
                                                    <Pencil size={14} /> Edit
                                                </button>
                                                <button
                                                    type="button"
                                                    onClick={() => toggleStatus(a.userId, a.status)}
                                                    disabled={statusBusy}
                                                    className="btn-secondary rounded-lg px-3 py-2 text-sm min-h-10 inline-flex items-center gap-1.5 disabled:opacity-50"
                                                >
                                                    {statusBusy ? (
                                                        <Loader2 size={14} className="animate-spin" />
                                                    ) : a.status === "active" ? (
                                                        <UserX size={14} />
                                                    ) : (
                                                        <UserCheck size={14} />
                                                    )}
                                                    {a.status === "active" ? "Block" : "Activate"}
                                                </button>
                                                <button
                                                    type="button"
                                                    onClick={() => removeAdmin(a)}
                                                    disabled={deleteBusy}
                                                    className="btn-secondary rounded-lg px-3 py-2 text-sm min-h-10 inline-flex items-center gap-1.5 text-error hover:bg-error-muted disabled:opacity-50"
                                                >
                                                    {deleteBusy ? (
                                                        <Loader2 size={14} className="animate-spin" />
                                                    ) : (
                                                        <Trash2 size={14} />
                                                    )}
                                                    Delete
                                                </button>
                                            </div>
                                        </div>

                                        {/* Expanded Details */}
                                        {open && (
                                            <div className="mt-4 ml-0 sm:ml-14 space-y-4">
                                                <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-2">
                                                    {[
                                                        { label: "Username", value: a.username || "—" },
                                                        { label: "Account", value: a.accountType || "—" },
                                                        { label: "Created", value: formatDate(a.createdAt) },
                                                        { label: "Last Login", value: formatDate(a.lastLogin) },
                                                        { label: "Org Plan", value: a.organization?.subscriptionPlan || "—" },
                                                        { label: "Org Status", value: a.organization?.status || "—" },
                                                        { label: "Org Contact", value: a.organization?.contactEmail || "—" },
                                                        {
                                                            label: "AI Provider",
                                                            value: a.organization?.aiProviderLabel
                                                                ? a.organization.aiProviderLabel
                                                                : a.organization?.aiProvider
                                                                ? (PROVIDER_LABELS[a.organization.aiProvider] || a.organization.aiProvider)
                                                                : (a.organization?.hasGroqApiKey ? "Groq" : "—"),
                                                        },
                                                        {
                                                            label: "AI API Key",
                                                            value: a.organization?.aiKeyMasked || a.organization?.groqApiKeyMasked || "Not configured",
                                                            mono: true,
                                                        },
                                                        ...(a.organization?.aiBaseUrl
                                                            ? [{ label: "AI Base URL", value: a.organization.aiBaseUrl, mono: true }]
                                                            : []),
                                                        ...(a.organization?.aiModel
                                                            ? [{ label: "AI Model", value: a.organization.aiModel }]
                                                            : []),
                                                        { label: "User ID", value: a.userId, mono: true },
                                                    ].map((d) => (
                                                        <div
                                                            key={d.label}
                                                            className="rounded-xl border border-border px-3 py-2.5 bg-surface-2/60"
                                                        >
                                                            <p className="text-[10px] uppercase tracking-wider font-semibold text-foreground-muted">
                                                                {d.label}
                                                            </p>
                                                            <p
                                                                className={`text-sm mt-0.5 break-all ${colors.textPrimary} ${d.mono ? "font-mono text-xs" : ""}`}
                                                            >
                                                                {d.value}
                                                            </p>
                                                        </div>
                                                    ))}
                                                </div>

                                                {/* Assigned AI Agents */}
                                                <div className="rounded-xl border border-border overflow-hidden">
                                                    <div className="px-4 py-3 border-b border-border bg-surface-2/30 flex items-center justify-between">
                                                        <div className="flex items-center gap-2">
                                                            <Bot size={14} className="text-accent" />
                                                            <p className={`text-sm font-semibold ${colors.textPrimary}`}>
                                                                Assigned AI Agents ({ (a.agentIds || a.organization?.agentIds || []).length })
                                                            </p>
                                                        </div>
                                                        <button
                                                            type="button"
                                                            onClick={() => openEdit(a)}
                                                            className="text-xs text-accent hover:underline inline-flex items-center gap-1 cursor-pointer"
                                                        >
                                                            <Pencil size={11} /> Edit Agents
                                                        </button>
                                                    </div>
                                                    <div className="p-3 grid grid-cols-2 sm:grid-cols-3 gap-2 bg-surface-2/10">
                                                        {AVAILABLE_AGENTS.map((agent) => {
                                                            const isAssigned = (a.agentIds || a.organization?.agentIds || []).includes(agent.id);
                                                            const IconComp = agent.icon;
                                                            return (
                                                                <div
                                                                    key={agent.id}
                                                                    className={`flex items-center gap-2 p-2 rounded-lg border text-xs transition-colors ${
                                                                        isAssigned
                                                                            ? "border-accent/40 bg-accent/5 text-foreground font-medium"
                                                                            : "border-border/40 bg-surface/30 text-foreground-muted opacity-40"
                                                                    }`}
                                                                >
                                                                    <div className={`p-1 rounded-md ${agent.color} shrink-0`}>
                                                                        <IconComp size={12} />
                                                                    </div>
                                                                    <span className="truncate flex-1">{agent.label}</span>
                                                                    {isAssigned && (
                                                                        <Check size={12} className="text-accent shrink-0" />
                                                                    )}
                                                                </div>
                                                            );
                                                        })}
                                                    </div>
                                                </div>

                                                <div className="rounded-xl border border-border overflow-hidden">
                                                    <div className="px-4 py-3 border-b border-border bg-surface-2/30 flex items-center gap-2">
                                                        <Users size={14} className="text-accent" />
                                                        <p className={`text-sm font-semibold ${colors.textPrimary}`}>
                                                            Team Members ({members.length})
                                                        </p>
                                                    </div>
                                                    {members.length === 0 ? (
                                                        <div className="px-4 py-8 text-center">
                                                            <Users size={24} className="mx-auto mb-2 text-foreground-muted opacity-40" />
                                                            <p className={`text-sm ${colors.textMuted}`}>
                                                                No team members in this organization yet.
                                                            </p>
                                                        </div>
                                                    ) : (
                                                        <ul className="divide-y divide-border">
                                                            {members.map((m) => (
                                                                <li
                                                                    key={m.userId}
                                                                    className="px-4 py-3 flex items-start gap-3 hover:bg-surface-2/30 transition-colors"
                                                                >
                                                                    <div
                                                                        className={`h-9 w-9 rounded-lg ${getAvatarColor(m.fullName)} flex items-center justify-center shrink-0 font-medium text-xs`}
                                                                    >
                                                                        {getInitials(m.fullName)}
                                                                    </div>
                                                                    <div className="min-w-0 flex-1">
                                                                        <div className="flex items-center gap-2 flex-wrap">
                                                                            <p className={`text-sm font-medium ${colors.textPrimary}`}>
                                                                                {m.fullName}
                                                                            </p>
                                                                            <Badge variant={m.status === "active" ? "success" : "error"}>
                                                                                {m.status}
                                                                            </Badge>
                                                                            <Badge variant="muted">Team</Badge>
                                                                            {permCount(m.permissions) > 0 && (
                                                                                <Badge variant="default">
                                                                                    <Zap size={10} />
                                                                                    {permCount(m.permissions)} perms
                                                                                </Badge>
                                                                            )}
                                                                        </div>
                                                                        <p className={`text-xs ${colors.textMuted} mt-1 break-words`}>
                                                                            {m.email}
                                                                            {m.username ? ` · @${m.username}` : ""}
                                                                            {m.contactNumber ? ` · ${m.contactNumber}` : ""}
                                                                        </p>
                                                                        <div className={`flex flex-wrap gap-x-3 gap-y-0.5 mt-1 text-[11px] ${colors.textMuted}`}>
                                                                            <span>Created {formatDate(m.createdAt)}</span>
                                                                            <span>
                                                                                Last login{" "}
                                                                                {m.lastLogin ? timeAgo(m.lastLogin) || formatDate(m.lastLogin) : "Never"}
                                                                            </span>
                                                                        </div>
                                                                    </div>
                                                                </li>
                                                            ))}
                                                        </ul>
                                                    )}
                                                </div>
                                            </div>
                                        )}
                                    </div>
                                </li>
                            );
                        })}
                    </ul>
                )}
            </div>

            {/* Create Admin Modal — portaled to body so it centers on the full screen */}
            {showCreate &&
                typeof document !== "undefined" &&
                createPortal(
                    <div
                        className="fixed inset-0 z-[200] flex items-center justify-center p-4 sm:p-6"
                        role="dialog"
                        aria-modal="true"
                        aria-labelledby="create-admin-title"
                    >
                        <button
                            type="button"
                            className="absolute inset-0 bg-slate-950/55 backdrop-blur-[6px]"
                            aria-label="Close dialog"
                            onClick={closeCreate}
                        />
                        <div
                            className="relative z-[1] w-full max-w-2xl max-h-[90vh] flex flex-col rounded-2xl border border-border bg-surface shadow-[0_24px_80px_rgba(15,23,42,0.35)] overflow-hidden animate-scale-in"
                            onClick={(e) => e.stopPropagation()}
                        >
                            <div className="relative px-6 pt-5 pb-4 border-b border-border bg-linear-to-r from-[rgba(56,182,255,0.08)] via-[rgba(56,182,255,0.04)] to-transparent">
                                <div className="flex items-start justify-between gap-3">
                                    <div className="flex items-center gap-3 min-w-0">
                                        <div className="h-11 w-11 rounded-xl bg-linear-to-br from-[rgba(56,182,255,0.2)] to-blue-600/10 text-(--vb-blue-dark) border border-[rgba(56,182,255,0.2)] flex items-center justify-center shrink-0">
                                            <Shield size={18} />
                                        </div>
                                        <div className="min-w-0">
                                            <h2 id="create-admin-title" className="text-base font-bold text-foreground tracking-tight">
                                                Create Admin
                                            </h2>
                                            <p className="text-xs text-foreground-muted mt-0.5">
                                                New company admin account with organization
                                            </p>
                                        </div>
                                    </div>
                                    <button
                                        type="button"
                                        onClick={closeCreate}
                                        disabled={creating}
                                        className="p-2 rounded-xl hover:bg-surface-3 transition-colors disabled:opacity-50"
                                        aria-label="Close"
                                    >
                                        <X size={16} className="text-foreground-muted" />
                                    </button>
                                </div>
                            </div>

                            <form onSubmit={createAdmin} className="px-6 py-5 space-y-5 overflow-y-auto flex-1 min-h-0">
                                {createError && (
                                    <div className="flex items-center gap-2 px-3.5 py-2.5 rounded-xl bg-error-muted border border-[rgba(248,113,113,0.25)] text-sm text-error">
                                        <X size={14} className="shrink-0" />
                                        {createError}
                                    </div>
                                )}

                                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                                    <div className="space-y-1.5">
                                        <label className={labelClass}>Full name</label>
                                        <input
                                            required
                                            value={createForm.fullName}
                                            onChange={(e) => setCreateForm({ ...createForm, fullName: e.target.value })}
                                            className={fieldClass}
                                            placeholder="Jane Doe"
                                            autoComplete="name"
                                        />
                                    </div>
                                    <div className="space-y-1.5">
                                        <label className={labelClass}>Email</label>
                                        <input
                                            required
                                            type="email"
                                            value={createForm.email}
                                            onChange={(e) => setCreateForm({ ...createForm, email: e.target.value })}
                                            className={fieldClass}
                                            placeholder="admin@company.com"
                                            autoComplete="off"
                                        />
                                    </div>
                                    <div className="space-y-1.5">
                                        <label className={labelClass}>Password</label>
                                        <input
                                            required
                                            type="password"
                                            minLength={8}
                                            value={createForm.password}
                                            onChange={(e) => setCreateForm({ ...createForm, password: e.target.value })}
                                            className={fieldClass}
                                            placeholder="Min 8 characters"
                                            autoComplete="new-password"
                                        />
                                    </div>
                                    <div className="space-y-1.5">
                                        <label className={labelClass}>
                                            Contact <span className="normal-case font-normal opacity-70">(optional)</span>
                                        </label>
                                        <input
                                            type="tel"
                                            value={createForm.contactNumber}
                                            onChange={(e) => setCreateForm({ ...createForm, contactNumber: e.target.value })}
                                            className={fieldClass}
                                            placeholder="+1 555 000 0000"
                                        />
                                    </div>
                                    <div className="space-y-1.5">
                                        <label className={labelClass}>Organization</label>
                                        <input
                                            required
                                            value={createForm.organizationName}
                                            onChange={(e) => setCreateForm({ ...createForm, organizationName: e.target.value })}
                                            className={fieldClass}
                                            placeholder="Acme Corp"
                                        />
                                    </div>
                                    <div className="space-y-1.5">
                                        <label className={labelClass}>Status</label>
                                        <select
                                            value={createForm.status}
                                            onChange={(e) =>
                                                setCreateForm({
                                                    ...createForm,
                                                    status: e.target.value as "active" | "blocked",
                                                })
                                            }
                                            className={fieldClass}
                                        >
                                            <option value="active">Active</option>
                                            <option value="blocked">Blocked</option>
                                        </select>
                                    </div>
                                    <div className="space-y-2.5 sm:col-span-2">
                                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                                            <div className="space-y-1.5">
                                                <label className={labelClass}>
                                                    AI Provider <span className="normal-case font-normal opacity-70">(optional)</span>
                                                </label>
                                                <select
                                                    value={createForm.aiProvider}
                                                    onChange={(e) => {
                                                        const nextProvider = e.target.value as AIProvider;
                                                        setCreateForm({
                                                            ...createForm,
                                                            aiProvider: nextProvider,
                                                            model: DEFAULT_PROVIDER_MODELS[nextProvider] || "",
                                                        });
                                                    }}
                                                    className={fieldClass}
                                                >
                                                    {AI_PROVIDERS.map((p) => (
                                                        <option key={p.id} value={p.id}>
                                                            {p.label}
                                                        </option>
                                                    ))}
                                                </select>
                                            </div>
                                            <div className="space-y-1.5">
                                                <label className={labelClass}>Model Name</label>
                                                <input
                                                    type="text"
                                                    value={createForm.model || ""}
                                                    onChange={(e) => setCreateForm({ ...createForm, model: e.target.value })}
                                                    className={fieldClass}
                                                    placeholder={DEFAULT_PROVIDER_MODELS[createForm.aiProvider] ? `e.g. ${DEFAULT_PROVIDER_MODELS[createForm.aiProvider]}` : "e.g. deepseek-chat"}
                                                />
                                            </div>
                                        </div>

                                        {createForm.aiProvider === "custom" && (
                                            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                                                <div className="space-y-1.5">
                                                    <label className={labelClass}>Custom Provider Name</label>
                                                    <input
                                                        type="text"
                                                        value={createForm.providerName || ""}
                                                        onChange={(e) => setCreateForm({ ...createForm, providerName: e.target.value })}
                                                        className={fieldClass}
                                                        placeholder="e.g. DeepSeek, Ollama"
                                                    />
                                                </div>
                                                <div className="space-y-1.5">
                                                    <label className={labelClass}>Base URL / Endpoint</label>
                                                    <input
                                                        type="text"
                                                        value={createForm.baseUrl || ""}
                                                        onChange={(e) => setCreateForm({ ...createForm, baseUrl: e.target.value })}
                                                        className={fieldClass}
                                                        placeholder="https://api.deepseek.com/v1"
                                                    />
                                                </div>
                                            </div>
                                        )}

                                        <div className="space-y-1.5">
                                            <label className={labelClass}>API Key</label>
                                            <input
                                                type="password"
                                                value={createForm.apiKey}
                                                onChange={(e) => setCreateForm({ ...createForm, apiKey: e.target.value })}
                                                className={fieldClass}
                                                placeholder={
                                                    AI_PROVIDERS.find((p) => p.id === createForm.aiProvider)?.placeholder ||
                                                    "Enter API key..."
                                                }
                                                autoComplete="off"
                                            />
                                            <p className="text-[11px] text-foreground-muted">
                                                Select the AI provider, model, and supply the API key. Can also be configured later.
                                            </p>
                                        </div>
                                    </div>
                                </div>

                                {/* Assigned AI Agents */}
                                <div className="space-y-3 pt-2 border-t border-border">
                                    <div className="flex items-center justify-between">
                                        <div>
                                            <label className="text-xs font-semibold text-foreground flex items-center gap-1.5">
                                                <Bot size={14} className="text-accent" />
                                                Assigned AI Agents
                                                <span className="text-xs text-foreground-muted font-normal">
                                                    ({createForm.agentIds.length} of {AVAILABLE_AGENTS.length} active)
                                                </span>
                                            </label>
                                            <p className="text-[11px] text-foreground-muted mt-0.5">
                                                Choose which AI department agents are accessible to this admin and company
                                            </p>
                                        </div>
                                        <div className="flex items-center gap-2">
                                            <button
                                                type="button"
                                                onClick={() => selectAllAgents("create")}
                                                className="text-xs text-accent hover:underline font-medium"
                                            >
                                                Select all
                                            </button>
                                            <span className="text-xs text-foreground-muted">•</span>
                                            <button
                                                type="button"
                                                onClick={() => clearAllAgents("create")}
                                                className="text-xs text-foreground-muted hover:text-foreground font-medium"
                                            >
                                                Clear all
                                            </button>
                                        </div>
                                    </div>

                                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                                        {AVAILABLE_AGENTS.map((agent) => {
                                            const selected = createForm.agentIds.includes(agent.id);
                                            const IconComp = agent.icon;
                                            return (
                                                <button
                                                    key={agent.id}
                                                    type="button"
                                                    onClick={() => toggleAgentInForm("create", agent.id)}
                                                    className={`flex items-start gap-3 p-3 rounded-xl border text-left transition-all cursor-pointer ${
                                                        selected
                                                            ? "border-accent bg-surface-2 ring-1 ring-accent/30 shadow-xs"
                                                            : "border-border bg-surface-2/40 hover:bg-surface-2/80 hover:border-border/80 opacity-70 hover:opacity-100"
                                                    }`}
                                                >
                                                    <div
                                                        className={`h-9 w-9 rounded-lg flex items-center justify-center shrink-0 border ${agent.color}`}
                                                    >
                                                        <IconComp size={16} />
                                                    </div>
                                                    <div className="min-w-0 flex-1">
                                                        <div className="flex items-center justify-between gap-1">
                                                            <span className="text-xs font-semibold text-foreground">
                                                                {agent.label}
                                                            </span>
                                                            <div
                                                                className={`h-4 w-4 rounded flex items-center justify-center border transition-colors ${
                                                                    selected
                                                                        ? "bg-accent border-accent text-white"
                                                                        : "border-border bg-surface"
                                                                }`}
                                                            >
                                                                {selected && <Check size={11} strokeWidth={3} />}
                                                            </div>
                                                        </div>
                                                        <p className="text-[11px] text-foreground-muted mt-0.5 line-clamp-1">
                                                            {agent.description}
                                                        </p>
                                                    </div>
                                                </button>
                                            );
                                        })}
                                    </div>
                                </div>

                                <div className="flex justify-end gap-2 pt-4 border-t border-border shrink-0">
                                    <button
                                        type="button"
                                        onClick={closeCreate}
                                        disabled={creating}
                                        className="btn-secondary rounded-xl px-4 py-2.5 text-sm min-h-10 disabled:opacity-50"
                                    >
                                        Cancel
                                    </button>
                                    <button
                                        type="submit"
                                        disabled={creating}
                                        className="btn-primary rounded-xl px-5 py-2.5 text-sm inline-flex items-center gap-2 min-h-10 disabled:opacity-50"
                                    >
                                        {creating && <Loader2 size={14} className="animate-spin" />}
                                        {creating ? "Creating…" : "Create Admin"}
                                    </button>
                                </div>
                            </form>
                        </div>
                    </div>,
                    document.body
                )}

            {/* Edit Admin Modal — portaled to body so it centers on the full screen */}
            {editingAdmin &&
                typeof document !== "undefined" &&
                createPortal(
                    <div
                        className="fixed inset-0 z-[200] flex items-center justify-center p-4 sm:p-6"
                        role="dialog"
                        aria-modal="true"
                        aria-labelledby="edit-admin-title"
                    >
                        <button
                            type="button"
                            className="absolute inset-0 bg-slate-950/55 backdrop-blur-[6px]"
                            aria-label="Close dialog"
                            onClick={closeEdit}
                        />
                        <div
                            className="relative z-[1] w-full max-w-2xl max-h-[90vh] flex flex-col rounded-2xl border border-border bg-surface shadow-[0_24px_80px_rgba(15,23,42,0.35)] overflow-hidden animate-scale-in"
                            onClick={(e) => e.stopPropagation()}
                        >
                            <div className="relative px-6 pt-5 pb-4 border-b border-border bg-linear-to-r from-[rgba(56,182,255,0.08)] via-[rgba(56,182,255,0.04)] to-transparent">
                                <div className="flex items-start justify-between gap-3">
                                    <div className="flex items-center gap-3 min-w-0">
                                        <div className="h-11 w-11 rounded-xl bg-linear-to-br from-[rgba(56,182,255,0.2)] to-blue-600/10 text-(--vb-blue-dark) border border-[rgba(56,182,255,0.2)] flex items-center justify-center shrink-0">
                                            <Pencil size={18} />
                                        </div>
                                        <div className="min-w-0">
                                            <h2 id="edit-admin-title" className="text-base font-bold text-foreground tracking-tight">
                                                Edit Admin
                                            </h2>
                                            <p className="text-xs text-foreground-muted mt-0.5 truncate">
                                                {editingAdmin.email}
                                            </p>
                                        </div>
                                    </div>
                                    <button
                                        type="button"
                                        onClick={closeEdit}
                                        disabled={saving}
                                        className="p-2 rounded-xl hover:bg-surface-3 transition-colors disabled:opacity-50"
                                        aria-label="Close"
                                    >
                                        <X size={16} className="text-foreground-muted" />
                                    </button>
                                </div>
                            </div>

                            <form onSubmit={saveAdmin} className="px-6 py-5 space-y-5 overflow-y-auto flex-1 min-h-0">
                                {editError && (
                                    <div className="flex items-center gap-2 px-3.5 py-2.5 rounded-xl bg-error-muted border border-[rgba(248,113,113,0.25)] text-sm text-error">
                                        <X size={14} className="shrink-0" />
                                        {editError}
                                    </div>
                                )}

                                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                                    <div className="space-y-1.5">
                                        <label className={labelClass}>Full name</label>
                                        <input
                                            required
                                            value={editForm.fullName}
                                            onChange={(e) => setEditForm({ ...editForm, fullName: e.target.value })}
                                            className={fieldClass}
                                            placeholder="Jane Doe"
                                            autoComplete="name"
                                        />
                                    </div>
                                    <div className="space-y-1.5">
                                        <label className={labelClass}>Email</label>
                                        <input
                                            required
                                            type="email"
                                            value={editForm.email}
                                            onChange={(e) => setEditForm({ ...editForm, email: e.target.value })}
                                            className={fieldClass}
                                            placeholder="admin@company.com"
                                            autoComplete="off"
                                        />
                                    </div>
                                    <div className="space-y-1.5">
                                        <label className={labelClass}>Contact</label>
                                        <input
                                            type="tel"
                                            value={editForm.contactNumber}
                                            onChange={(e) => setEditForm({ ...editForm, contactNumber: e.target.value })}
                                            className={fieldClass}
                                            placeholder="+1 555 000 0000"
                                        />
                                    </div>
                                    <div className="space-y-1.5">
                                        <label className={labelClass}>Organization</label>
                                        <input
                                            required
                                            value={editForm.organizationName}
                                            onChange={(e) => setEditForm({ ...editForm, organizationName: e.target.value })}
                                            className={fieldClass}
                                            placeholder="Acme Corp"
                                        />
                                    </div>
                                    <div className="space-y-1.5">
                                        <label className={labelClass}>
                                            New password <span className="normal-case font-normal opacity-70">(optional)</span>
                                        </label>
                                        <input
                                            type="password"
                                            minLength={8}
                                            value={editForm.password}
                                            onChange={(e) => setEditForm({ ...editForm, password: e.target.value })}
                                            className={fieldClass}
                                            placeholder="Leave blank to keep"
                                            autoComplete="new-password"
                                        />
                                    </div>
                                    <div className="space-y-1.5">
                                        <label className={labelClass}>Status</label>
                                        <select
                                            value={editForm.status}
                                            onChange={(e) =>
                                                setEditForm({
                                                    ...editForm,
                                                    status: e.target.value as "active" | "blocked",
                                                })
                                            }
                                            className={fieldClass}
                                        >
                                            <option value="active">Active</option>
                                            <option value="blocked">Blocked</option>
                                        </select>
                                    </div>
                                    <div className="space-y-2.5 sm:col-span-2">
                                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                                            <div className="space-y-1.5">
                                                <label className={labelClass}>
                                                    AI Provider <span className="normal-case font-normal opacity-70">(leave blank to keep unchanged)</span>
                                                </label>
                                                <select
                                                    value={editForm.aiProvider}
                                                    onChange={(e) => {
                                                        const nextProvider = e.target.value as AIProvider;
                                                        setEditForm({
                                                            ...editForm,
                                                            aiProvider: nextProvider,
                                                            model: DEFAULT_PROVIDER_MODELS[nextProvider] || "",
                                                        });
                                                    }}
                                                    className={fieldClass}
                                                >
                                                    {AI_PROVIDERS.map((p) => (
                                                        <option key={p.id} value={p.id}>
                                                            {p.label}
                                                        </option>
                                                    ))}
                                                </select>
                                            </div>
                                            <div className="space-y-1.5">
                                                <label className={labelClass}>Model Name</label>
                                                <input
                                                    type="text"
                                                    value={editForm.model || ""}
                                                    onChange={(e) => setEditForm({ ...editForm, model: e.target.value })}
                                                    className={fieldClass}
                                                    placeholder={DEFAULT_PROVIDER_MODELS[editForm.aiProvider] ? `e.g. ${DEFAULT_PROVIDER_MODELS[editForm.aiProvider]}` : "e.g. deepseek-chat"}
                                                />
                                            </div>
                                        </div>

                                        {editForm.aiProvider === "custom" && (
                                            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                                                <div className="space-y-1.5">
                                                    <label className={labelClass}>Custom Provider Name</label>
                                                    <input
                                                        type="text"
                                                        value={editForm.providerName || ""}
                                                        onChange={(e) => setEditForm({ ...editForm, providerName: e.target.value })}
                                                        className={fieldClass}
                                                        placeholder="e.g. DeepSeek, Ollama"
                                                    />
                                                </div>
                                                <div className="space-y-1.5">
                                                    <label className={labelClass}>Base URL / Endpoint</label>
                                                    <input
                                                        type="text"
                                                        value={editForm.baseUrl || ""}
                                                        onChange={(e) => setEditForm({ ...editForm, baseUrl: e.target.value })}
                                                        className={fieldClass}
                                                        placeholder="https://api.deepseek.com/v1"
                                                    />
                                                </div>
                                            </div>
                                        )}

                                        <div className="space-y-1.5">
                                            <label className={labelClass}>API Key</label>
                                            <input
                                                type="password"
                                                value={editForm.apiKey}
                                                onChange={(e) => setEditForm({ ...editForm, apiKey: e.target.value })}
                                                className={fieldClass}
                                                placeholder={
                                                    editingAdmin.organization?.aiKeyMasked ||
                                                    editingAdmin.organization?.groqApiKeyMasked ||
                                                    AI_PROVIDERS.find((p) => p.id === editForm.aiProvider)?.placeholder ||
                                                    "Enter new API key..."
                                                }
                                                autoComplete="off"
                                            />
                                            <p className="text-[11px] text-foreground-muted">
                                                Update AI provider, model, or enter a new API key. Leave existing masked key to keep current key.
                                            </p>
                                        </div>
                                    </div>
                                </div>

                                {/* Assigned AI Agents */}
                                <div className="space-y-3 pt-2 border-t border-border">
                                    <div className="flex items-center justify-between">
                                        <div>
                                            <label className="text-xs font-semibold text-foreground flex items-center gap-1.5">
                                                <Bot size={14} className="text-accent" />
                                                Assigned AI Agents
                                                <span className="text-xs text-foreground-muted font-normal">
                                                    ({editForm.agentIds.length} of {AVAILABLE_AGENTS.length} active)
                                                </span>
                                            </label>
                                            <p className="text-[11px] text-foreground-muted mt-0.5">
                                                Choose which AI department agents are accessible to this admin and company
                                            </p>
                                        </div>
                                        <div className="flex items-center gap-2">
                                            <button
                                                type="button"
                                                onClick={() => selectAllAgents("edit")}
                                                className="text-xs text-accent hover:underline font-medium"
                                            >
                                                Select all
                                            </button>
                                            <span className="text-xs text-foreground-muted">•</span>
                                            <button
                                                type="button"
                                                onClick={() => clearAllAgents("edit")}
                                                className="text-xs text-foreground-muted hover:text-foreground font-medium"
                                            >
                                                Clear all
                                            </button>
                                        </div>
                                    </div>

                                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                                        {AVAILABLE_AGENTS.map((agent) => {
                                            const selected = editForm.agentIds.includes(agent.id);
                                            const IconComp = agent.icon;
                                            return (
                                                <button
                                                    key={agent.id}
                                                    type="button"
                                                    onClick={() => toggleAgentInForm("edit", agent.id)}
                                                    className={`flex items-start gap-3 p-3 rounded-xl border text-left transition-all cursor-pointer ${
                                                        selected
                                                            ? "border-accent bg-surface-2 ring-1 ring-accent/30 shadow-xs"
                                                            : "border-border bg-surface-2/40 hover:bg-surface-2/80 hover:border-border/80 opacity-70 hover:opacity-100"
                                                    }`}
                                                >
                                                    <div
                                                        className={`h-9 w-9 rounded-lg flex items-center justify-center shrink-0 border ${agent.color}`}
                                                    >
                                                        <IconComp size={16} />
                                                    </div>
                                                    <div className="min-w-0 flex-1">
                                                        <div className="flex items-center justify-between gap-1">
                                                            <span className="text-xs font-semibold text-foreground">
                                                                {agent.label}
                                                            </span>
                                                            <div
                                                                className={`h-4 w-4 rounded flex items-center justify-center border transition-colors ${
                                                                    selected
                                                                        ? "bg-accent border-accent text-white"
                                                                        : "border-border bg-surface"
                                                                }`}
                                                            >
                                                                {selected && <Check size={11} strokeWidth={3} />}
                                                            </div>
                                                        </div>
                                                        <p className="text-[11px] text-foreground-muted mt-0.5 line-clamp-1">
                                                            {agent.description}
                                                        </p>
                                                    </div>
                                                </button>
                                            );
                                        })}
                                    </div>
                                </div>

                                <div className="flex justify-end gap-2 pt-4 border-t border-border shrink-0">
                                    <button
                                        type="button"
                                        onClick={closeEdit}
                                        disabled={saving}
                                        className="btn-secondary rounded-xl px-4 py-2.5 text-sm min-h-10 disabled:opacity-50"
                                    >
                                        Cancel
                                    </button>
                                    <button
                                        type="submit"
                                        disabled={saving}
                                        className="btn-primary rounded-xl px-5 py-2.5 text-sm inline-flex items-center gap-2 min-h-10 disabled:opacity-50"
                                    >
                                        {saving && <Loader2 size={14} className="animate-spin" />}
                                        {saving ? "Saving…" : "Save changes"}
                                    </button>
                                </div>
                            </form>
                        </div>
                    </div>,
                    document.body
                )}

            {/* AI API Key Modal — portaled to body so it centers on full screen */}
            {aiKeyModalOrg &&
                typeof document !== "undefined" &&
                createPortal(
                    <div
                        className="fixed inset-0 z-[200] flex items-center justify-center p-4 sm:p-6"
                        role="dialog"
                        aria-modal="true"
                        aria-labelledby="ai-key-modal-title"
                    >
                        <button
                            type="button"
                            className="absolute inset-0 bg-slate-950/55 backdrop-blur-[6px]"
                            aria-label="Close dialog"
                            onClick={closeAiKeyModal}
                        />
                        <div
                            className="relative z-[1] w-full max-w-lg rounded-2xl border border-border bg-surface shadow-[0_24px_80px_rgba(15,23,42,0.35)] overflow-hidden animate-scale-in"
                            onClick={(e) => e.stopPropagation()}
                        >
                            <div className="relative px-6 pt-5 pb-4 border-b border-border bg-linear-to-r from-[rgba(56,182,255,0.1)] via-[rgba(56,182,255,0.05)] to-transparent">
                                <div className="flex items-start justify-between gap-3">
                                    <div className="flex items-center gap-3 min-w-0">
                                        <div className="h-11 w-11 rounded-xl bg-linear-to-br from-[rgba(56,182,255,0.2)] to-blue-600/10 text-(--vb-blue) border border-[rgba(56,182,255,0.2)] flex items-center justify-center shrink-0">
                                            <KeyRound size={20} />
                                        </div>
                                        <div className="min-w-0">
                                            <h2 id="ai-key-modal-title" className="text-base font-bold text-foreground tracking-tight">
                                                AI Provider & API Key
                                            </h2>
                                            <p className="text-xs text-foreground-muted mt-0.5 truncate">
                                                {aiKeyModalOrg.orgName}
                                            </p>
                                        </div>
                                    </div>
                                    <button
                                        type="button"
                                        onClick={closeAiKeyModal}
                                        disabled={aiKeySaving || aiKeyDeleting}
                                        className="p-2 rounded-xl hover:bg-surface-3 transition-colors disabled:opacity-50"
                                        aria-label="Close"
                                    >
                                        <X size={16} className="text-foreground-muted" />
                                    </button>
                                </div>
                            </div>

                            <form onSubmit={saveAiKey} className="px-6 py-5 space-y-4">
                                {aiKeyError && (
                                    <div className="flex items-center gap-2 px-3.5 py-2.5 rounded-xl bg-error-muted border border-[rgba(248,113,113,0.25)] text-sm text-error">
                                        <X size={14} className="shrink-0" />
                                        {aiKeyError}
                                    </div>
                                )}
                                {aiKeySuccess && (
                                    <div className="flex items-center gap-2 px-3.5 py-2.5 rounded-xl bg-emerald-500/10 border border-emerald-500/20 text-sm text-emerald-400">
                                        <KeyRound size={14} className="shrink-0" />
                                        {aiKeySuccess}
                                    </div>
                                )}


                                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                                    <div className="space-y-1.5">
                                        <label className={labelClass}>AI Provider</label>
                                        <select
                                            value={aiProviderInput}
                                            onChange={(e) => {
                                                const nextProvider = e.target.value as AIProvider;
                                                setAiProviderInput(nextProvider);
                                                setAiModelInput(DEFAULT_PROVIDER_MODELS[nextProvider] || "");
                                            }}
                                            className={fieldClass}
                                        >
                                            {AI_PROVIDERS.map((p) => (
                                                <option key={p.id} value={p.id}>
                                                    {p.label}
                                                </option>
                                            ))}
                                        </select>
                                    </div>
                                    <div className="space-y-1.5">
                                        <label className={labelClass}>Model Name</label>
                                        <input
                                            type="text"
                                            value={aiModelInput}
                                            onChange={(e) => setAiModelInput(e.target.value)}
                                            className={fieldClass}
                                            placeholder={DEFAULT_PROVIDER_MODELS[aiProviderInput] ? `e.g. ${DEFAULT_PROVIDER_MODELS[aiProviderInput]}` : "e.g. deepseek-chat"}
                                        />
                                    </div>
                                </div>

                                {aiProviderInput === "custom" && (
                                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                                        <div className="space-y-1.5">
                                            <label className={labelClass}>Custom Provider Name</label>
                                            <input
                                                type="text"
                                                value={aiProviderNameInput}
                                                onChange={(e) => setAiProviderNameInput(e.target.value)}
                                                className={fieldClass}
                                                placeholder="e.g. DeepSeek, Ollama"
                                            />
                                        </div>
                                        <div className="space-y-1.5">
                                            <label className={labelClass}>Base URL / Endpoint</label>
                                            <input
                                                type="text"
                                                value={aiBaseUrlInput}
                                                onChange={(e) => setAiBaseUrlInput(e.target.value)}
                                                className={fieldClass}
                                                placeholder="https://api.deepseek.com/v1"
                                            />
                                        </div>
                                    </div>
                                )}

                                <div className="space-y-1.5">
                                    <label className={labelClass}>
                                        New API Key
                                        {AI_PROVIDERS.find((p) => p.id === aiProviderInput)?.prefixHint && (
                                            <span className="normal-case font-normal opacity-70 ml-1">
                                                (e.g. {AI_PROVIDERS.find((p) => p.id === aiProviderInput)?.prefixHint})
                                            </span>
                                        )}
                                    </label>
                                    <input
                                        type="password"
                                        required
                                        value={aiApiKeyInput}
                                        onChange={(e) => setAiApiKeyInput(e.target.value)}
                                        className={fieldClass}
                                        placeholder={
                                            AI_PROVIDERS.find((p) => p.id === aiProviderInput)?.placeholder ||
                                            "Enter API key..."
                                        }
                                        autoComplete="off"
                                    />
                                    <p className="text-[11px] text-foreground-muted">
                                        Supports OpenAI, Groq, Gemini, Claude, or Custom endpoints.
                                    </p>
                                </div>

                                <div className="flex items-center justify-between gap-3 pt-4 border-t border-border">
                                    {aiKeyModalOrg.currentKeyMasked ? (
                                        <button
                                            type="button"
                                            onClick={deleteAiKey}
                                            disabled={aiKeySaving || aiKeyDeleting}
                                            className="btn-secondary rounded-xl px-4 py-2.5 text-sm min-h-10 text-error hover:bg-error-muted disabled:opacity-50 inline-flex items-center gap-1.5"
                                        >
                                            {aiKeyDeleting ? (
                                                <Loader2 size={14} className="animate-spin" />
                                            ) : (
                                                <Trash2 size={14} />
                                            )}
                                            Delete Key
                                        </button>
                                    ) : (
                                        <div />
                                    )}

                                    <div className="flex items-center gap-2">
                                        <button
                                            type="button"
                                            onClick={closeAiKeyModal}
                                            disabled={aiKeySaving || aiKeyDeleting}
                                            className="btn-secondary rounded-xl px-4 py-2.5 text-sm min-h-10 disabled:opacity-50"
                                        >
                                            Cancel
                                        </button>
                                        <button
                                            type="submit"
                                            disabled={aiKeySaving || aiKeyDeleting}
                                            className="btn-primary rounded-xl px-5 py-2.5 text-sm inline-flex items-center gap-2 min-h-10 disabled:opacity-50"
                                        >
                                            {aiKeySaving && <Loader2 size={14} className="animate-spin" />}
                                            {aiKeySaving ? "Saving…" : "Save Key"}
                                        </button>
                                    </div>
                                </div>
                            </form>
                        </div>
                    </div>,
                    document.body
                )}
        </div>
    );
}

export default function AdminsPage() {
    return <AdminsContent />;
}
