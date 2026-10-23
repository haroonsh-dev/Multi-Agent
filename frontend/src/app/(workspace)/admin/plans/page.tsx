"use client";

import React, { useCallback, useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import {
    Check,
    HardDrive,
    Loader2,
    Package,
    Pencil,
    Plus,
    RefreshCw,
    Trash2,
    X,
    XCircle,
} from "lucide-react";
import { PageHeader, EmptyState, Badge } from "@/components/ui";
import { apiRequest } from "@/lib/apiClient";
import { AGENT_OPTIONS } from "@/lib/documentAgents";

type AgentPrice = {
    agentId: string;
    monthlyPrice: number;
    yearlyPrice: number;
    enabled: boolean;
};

type Pricing = {
    currency: string;
    agents: AgentPrice[];
    pricePerGbMonthly: number;
    pricePerGbYearly: number;
    freeAgentIds: string[];
    freeStorageGb: number;
};

type Plan = {
    planId: string;
    name: string;
    description?: string;
    billingCycle: "monthly" | "yearly";
    agentIds: string[];
    storageGb: number;
    price: number;
    status: string;
};

type PlanRequest = {
    requestId: string;
    organizationId: string;
    planId?: string | null;
    planName?: string | null;
    agentIds: string[];
    storageGb: number;
    billingCycle: "monthly" | "yearly";
    quotedPrice: number;
    message?: string;
    status: string;
    requestType?: string;
    previousAgentIds?: string[];
    createdAt?: string;
    organization?: { organizationName?: string; contactEmail?: string } | null;
    requester?: { fullName?: string; email?: string } | null;
};

type Subscription = {
    subscriptionId: string;
    organizationId: string;
    planName?: string | null;
    agentIds: string[];
    storageGb: number;
    billingCycle: "monthly" | "yearly";
    price: number;
    status: string;
    startsAt?: string;
    endsAt?: string;
    organization?: { organizationName?: string } | null;
};

type OrgOption = { organizationId: string; organizationName: string };

const AGENT_CHOICES = AGENT_OPTIONS.filter((o) => o.value);
const TABS = ["pricing", "plans", "requests", "subscriptions"] as const;
type Tab = (typeof TABS)[number];

function agentLabel(id: string) {
    return AGENT_CHOICES.find((a) => a.value === id)?.label || id;
}

function money(n: number, currency = "USD") {
    return `${currency} ${Number(n || 0).toFixed(2)}`;
}

export default function SuperAdminPlansPage() {
    const [tab, setTab] = useState<Tab>("pricing");
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [toast, setToast] = useState<string | null>(null);

    const [pricing, setPricing] = useState<Pricing | null>(null);
    const [plans, setPlans] = useState<Plan[]>([]);
    const [requests, setRequests] = useState<PlanRequest[]>([]);
    const [requestForm, setRequestForm] = useState<
        Record<string, { agentIds: string[]; storageGb: number }>
    >({});
    const [subscriptions, setSubscriptions] = useState<Subscription[]>([]);
    const [orgs, setOrgs] = useState<OrgOption[]>([]);

    const [planModal, setPlanModal] = useState(false);
    const [editingPlan, setEditingPlan] = useState<Plan | null>(null);
    const [planForm, setPlanForm] = useState({
        name: "",
        description: "",
        billingCycle: "monthly" as "monthly" | "yearly",
        agentIds: [] as string[],
        storageGb: 10,
        price: 0,
    });

    const [activateOpen, setActivateOpen] = useState(false);
    const [activateForm, setActivateForm] = useState({
        organizationId: "",
        planId: "",
        billingCycle: "monthly" as "monthly" | "yearly",
        agentIds: [] as string[],
        storageGb: 10,
        price: 0,
        planName: "Custom",
    });

    const [manageOpen, setManageOpen] = useState(false);
    const [managing, setManaging] = useState<Subscription | null>(null);
    const [manageForm, setManageForm] = useState({
        planName: "",
        billingCycle: "monthly" as "monthly" | "yearly",
        agentIds: [] as string[],
        storageGb: 10,
        price: 0,
        endsAt: "",
        extendPeriods: 1,
    });
    const [subFilter, setSubFilter] = useState<"all" | "active" | "inactive" | "expired" | "cancelled">("all");

    const [mounted, setMounted] = useState(false);
    useEffect(() => setMounted(true), []);

    const load = useCallback(async () => {
        setLoading(true);
        setError(null);
        try {
            const [pricingRes, plansRes, reqRes, subRes, orgRes] = await Promise.all([
                apiRequest("/docs/super-admin/pricing"),
                apiRequest("/docs/super-admin/plans?includeArchived=true"),
                apiRequest("/docs/super-admin/plan-requests"),
                apiRequest("/docs/super-admin/subscriptions"),
                apiRequest("/docs/super-admin/organizations"),
            ]);
            setPricing(pricingRes?.data?.pricing || null);
            setPlans(plansRes?.data?.plans || []);
            const loadedRequests: PlanRequest[] = reqRes?.data?.requests || [];
            setRequests(loadedRequests);
            setRequestForm((prev) => {
                const next = { ...prev };
                for (const r of loadedRequests) {
                    if (r.status === "pending" && !next[r.requestId]) {
                        next[r.requestId] = {
                            agentIds: [...(r.agentIds || [])],
                            storageGb: r.storageGb ?? 10,
                        };
                    }
                }
                return next;
            });
            setSubscriptions(subRes?.data?.subscriptions || []);
            setOrgs(
                (orgRes?.data?.organizations || []).map((o: any) => ({
                    organizationId: o.organizationId,
                    organizationName: o.organizationName,
                }))
            );
        } catch (e: any) {
            setError(e.message || "Failed to load plans data");
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        load();
    }, [load]);

    useEffect(() => {
        if (!toast) return;
        const t = setTimeout(() => setToast(null), 4000);
        return () => clearTimeout(t);
    }, [toast]);

    const suggestedPlanPrice = useMemo(() => {
        if (!pricing) return 0;
        const cycle = planForm.billingCycle;
        let total = 0;
        for (const id of planForm.agentIds) {
            const row = pricing.agents.find((a) => a.agentId === id);
            if (!row) continue;
            total += cycle === "yearly" ? row.yearlyPrice : row.monthlyPrice;
        }
        total +=
            planForm.storageGb *
            (cycle === "yearly" ? pricing.pricePerGbYearly : pricing.pricePerGbMonthly);
        return Math.round(total * 100) / 100;
    }, [pricing, planForm]);

    const savePricing = async () => {
        if (!pricing) return;
        setSaving(true);
        setError(null);
        try {
            await apiRequest("/docs/super-admin/pricing", {
                method: "PUT",
                body: JSON.stringify({
                    currency: pricing.currency,
                    agents: pricing.agents,
                    pricePerGbMonthly: pricing.pricePerGbMonthly,
                    pricePerGbYearly: pricing.pricePerGbYearly,
                    freeAgentIds: pricing.freeAgentIds,
                    freeStorageGb: pricing.freeStorageGb,
                }),
            });
            setToast("Pricing saved");
            await load();
        } catch (e: any) {
            setError(e.message || "Failed to save pricing");
        } finally {
            setSaving(false);
        }
    };

    const openCreatePlan = () => {
        setEditingPlan(null);
        setPlanForm({
            name: "",
            description: "",
            billingCycle: "monthly",
            agentIds: ["other_agent"],
            storageGb: 10,
            price: 0,
        });
        setPlanModal(true);
    };

    const openEditPlan = (p: Plan) => {
        setEditingPlan(p);
        setPlanForm({
            name: p.name,
            description: p.description || "",
            billingCycle: p.billingCycle,
            agentIds: [...p.agentIds],
            storageGb: p.storageGb,
            price: p.price,
        });
        setPlanModal(true);
    };

    const savePlan = async () => {
        if (!planForm.name.trim() || !planForm.agentIds.length) {
            setError("Plan name and at least one agent are required");
            return;
        }
        setSaving(true);
        setError(null);
        try {
            const body = {
                ...planForm,
                price: planForm.price || suggestedPlanPrice,
            };
            if (editingPlan) {
                await apiRequest(`/docs/super-admin/plans/${editingPlan.planId}`, {
                    method: "PUT",
                    body: JSON.stringify(body),
                });
                setToast("Plan updated");
            } else {
                await apiRequest("/docs/super-admin/plans", {
                    method: "POST",
                    body: JSON.stringify(body),
                });
                setToast("Plan created");
            }
            setPlanModal(false);
            await load();
        } catch (e: any) {
            setError(e.message || "Failed to save plan");
        } finally {
            setSaving(false);
        }
    };

    const archivePlan = async (planId: string) => {
        if (!confirm("Archive this plan?")) return;
        try {
            await apiRequest(`/docs/super-admin/plans/${planId}`, { method: "DELETE" });
            setToast("Plan archived");
            await load();
        } catch (e: any) {
            setError(e.message || "Archive failed");
        }
    };

    const quoteSelection = (
        agentIds: string[],
        storageGb: number,
        cycle: "monthly" | "yearly"
    ) => {
        if (!pricing) return 0;
        const set = new Set(agentIds);
        let total = 0;
        for (const a of pricing.agents) {
            if (set.has(a.agentId) && a.enabled) {
                total += cycle === "yearly" ? a.yearlyPrice : a.monthlyPrice;
            }
        }
        const perGb = cycle === "yearly" ? pricing.pricePerGbYearly : pricing.pricePerGbMonthly;
        total += Math.max(0, storageGb) * perGb;
        return Math.round(total * 100) / 100;
    };

    const updateRequestForm = (
        id: string,
        patch: Partial<{ agentIds: string[]; storageGb: number }>
    ) => {
        setRequestForm((prev) => ({
            ...prev,
            [id]: {
                ...(prev[id] || { agentIds: [], storageGb: 10 }),
                ...patch,
            },
        }));
    };

    const toggleRequestAgent = (id: string, agentId: string) => {
        setRequestForm((prev) => {
            const base = prev[id] || { agentIds: [], storageGb: 10 };
            const on = base.agentIds.includes(agentId);
            return {
                ...prev,
                [id]: {
                    ...base,
                    agentIds: on
                        ? base.agentIds.filter((x) => x !== agentId)
                        : [...base.agentIds, agentId],
                },
            };
        });
    };

    const approveRequest = async (id: string) => {
        const form = requestForm[id];
        if (!form || !form.agentIds.length) {
            setError("Select at least one agent module to grant");
            return;
        }
        if (!confirm("Approve and activate with the selected agent modules?")) return;
        setSaving(true);
        try {
            await apiRequest(`/docs/super-admin/plan-requests/${id}/approve`, {
                method: "POST",
                body: JSON.stringify({
                    agentIds: form.agentIds,
                    storageGb: form.storageGb,
                }),
            });
            setToast("Request approved — subscription activated");
            await load();
        } catch (e: any) {
            setError(e.message || "Approve failed");
        } finally {
            setSaving(false);
        }
    };

    const rejectRequest = async (id: string) => {
        const note = prompt("Rejection note (optional)") || "";
        setSaving(true);
        try {
            await apiRequest(`/docs/super-admin/plan-requests/${id}/reject`, {
                method: "POST",
                body: JSON.stringify({ note }),
            });
            setToast("Request rejected");
            await load();
        } catch (e: any) {
            setError(e.message || "Reject failed");
        } finally {
            setSaving(false);
        }
    };

    const patchSub = async (
        id: string,
        action: "cancel" | "extend" | "deactivate" | "activate" | "update",
        extra?: Record<string, unknown>
    ) => {
        const labels: Record<string, string> = {
            cancel: "Cancel this subscription permanently?",
            extend: `Extend by ${extra?.periods || 1} billing period(s)?`,
            deactivate: "Deactivate (pause) this subscription?",
            activate: "Activate this subscription?",
            update: "Save subscription changes?",
        };
        if (!confirm(labels[action] || "Continue?")) return;
        setSaving(true);
        try {
            await apiRequest(`/docs/super-admin/subscriptions/${id}`, {
                method: "PATCH",
                body: JSON.stringify({ action, ...extra }),
            });
            setToast(
                action === "cancel"
                    ? "Subscription cancelled"
                    : action === "extend"
                      ? "Subscription extended"
                      : action === "deactivate"
                        ? "Subscription deactivated"
                        : action === "activate"
                          ? "Subscription activated"
                          : "Subscription updated"
            );
            setManageOpen(false);
            setManaging(null);
            await load();
        } catch (e: any) {
            setError(e.message || "Update failed");
        } finally {
            setSaving(false);
        }
    };

    const openManage = (s: Subscription) => {
        setManaging(s);
        setManageForm({
            planName: s.planName || "Custom",
            billingCycle: s.billingCycle,
            agentIds: [...(s.agentIds || [])],
            storageGb: s.storageGb,
            price: s.price,
            endsAt: s.endsAt ? new Date(s.endsAt).toISOString().slice(0, 10) : "",
            extendPeriods: 1,
        });
        setManageOpen(true);
    };

    const saveManageUpdate = async () => {
        if (!managing) return;
        await patchSub(managing.subscriptionId, "update", {
            planName: manageForm.planName,
            billingCycle: manageForm.billingCycle,
            agentIds: manageForm.agentIds,
            storageGb: manageForm.storageGb,
            price: manageForm.price,
            endsAt: manageForm.endsAt || undefined,
        });
    };

    const filteredSubs =
        subFilter === "all" ? subscriptions : subscriptions.filter((s) => s.status === subFilter);

    const activateDirect = async () => {
        if (!activateForm.organizationId) {
            setError("Select an organization");
            return;
        }
        setSaving(true);
        try {
            const body: Record<string, unknown> = {
                organizationId: activateForm.organizationId,
            };
            if (activateForm.planId) {
                body.planId = activateForm.planId;
                if (activateForm.price) body.price = activateForm.price;
            } else {
                body.agentIds = activateForm.agentIds;
                body.storageGb = activateForm.storageGb;
                body.billingCycle = activateForm.billingCycle;
                body.price = activateForm.price;
                body.planName = activateForm.planName || "Custom";
            }
            await apiRequest("/docs/super-admin/subscriptions", {
                method: "POST",
                body: JSON.stringify(body),
            });
            setToast("Subscription activated");
            setActivateOpen(false);
            await load();
        } catch (e: any) {
            setError(e.message || "Activation failed");
        } finally {
            setSaving(false);
        }
    };

    const pendingCount = requests.filter((r) => r.status === "pending").length;
    const activePlans = plans.filter((p) => p.status === "active");

    const TAB_META: Record<Tab, string> = {
        pricing: "Pricing",
        plans: "Plans",
        requests: "Requests",
        subscriptions: "Subscriptions",
    };

    return (
        <div className="p-4 sm:p-6 lg:p-8 max-w-5xl mx-auto space-y-6">
            <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-4">
                <PageHeader
                    title="Plans & Pricing"
                    subtitle="Catalog rates, packages, requests, and org subscriptions."
                />
                <div className="flex flex-wrap gap-2 shrink-0">
                    {tab === "subscriptions" && (
                        <button
                            type="button"
                            onClick={() => {
                                setActivateForm({
                                    organizationId: "",
                                    planId: "",
                                    billingCycle: "monthly",
                                    agentIds: ["other_agent"],
                                    storageGb: 10,
                                    price: 0,
                                    planName: "Custom",
                                });
                                setActivateOpen(true);
                            }}
                            className="btn-gradient rounded-xl px-4 py-2 text-sm inline-flex items-center gap-2"
                        >
                            <Plus size={14} /> Assign plan
                        </button>
                    )}
                    {tab === "plans" && (
                        <button
                            type="button"
                            onClick={openCreatePlan}
                            className="btn-gradient rounded-xl px-4 py-2 text-sm inline-flex items-center gap-2"
                        >
                            <Plus size={14} /> New plan
                        </button>
                    )}
                    <button
                        type="button"
                        onClick={load}
                        className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-600 hover:bg-slate-50 inline-flex items-center gap-2"
                    >
                        <RefreshCw size={14} className={loading ? "animate-spin" : ""} />
                    </button>
                </div>
            </div>

            {toast && (
                <div className="rounded-xl bg-emerald-50 text-emerald-800 px-4 py-3 text-sm">{toast}</div>
            )}
            {error && (
                <div className="rounded-xl bg-rose-50 text-rose-700 px-4 py-3 text-sm flex justify-between gap-3">
                    <span>{error}</span>
                    <button type="button" onClick={() => setError(null)}>
                        <X size={14} />
                    </button>
                </div>
            )}

            <nav className="flex gap-1 border-b border-slate-200 overflow-x-auto">
                {TABS.map((t) => (
                    <button
                        key={t}
                        type="button"
                        onClick={() => setTab(t)}
                        className={`relative px-4 py-2.5 text-sm font-medium whitespace-nowrap transition-colors ${
                            tab === t ? "text-(--vb-blue-dark)" : "text-slate-500 hover:text-slate-700"
                        }`}
                    >
                        {TAB_META[t]}
                        {t === "requests" && pendingCount > 0 && (
                            <span className="ml-1.5 text-[10px] font-bold text-rose-600">{pendingCount}</span>
                        )}
                        {tab === t && (
                            <span className="absolute left-4 right-4 -bottom-px h-0.5 bg-(--vb-blue) rounded-full" />
                        )}
                    </button>
                ))}
            </nav>

            {loading ? (
                <div className="py-16 flex justify-center text-slate-400 text-sm gap-2">
                    <Loader2 size={16} className="animate-spin" /> Loading…
                </div>
            ) : tab === "pricing" && pricing ? (
                <div className="rounded-2xl border border-slate-200 bg-white overflow-hidden">
                    <div className="px-6 py-5 border-b border-slate-100">
                        <h2 className="text-base font-bold text-slate-900">Unit pricing</h2>
                        <p className="text-sm text-slate-500 mt-0.5">
                            Per-agent and per-GB rates ({pricing.currency})
                        </p>
                    </div>
                    <div className="p-6 space-y-6">
                        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                            <label className="block text-xs">
                                <span className="text-slate-500 font-semibold">Currency</span>
                                <input
                                    value={pricing.currency}
                                    onChange={(e) => setPricing({ ...pricing, currency: e.target.value })}
                                    className="mt-1.5 w-full premium-input rounded-xl px-3 py-2.5 text-sm"
                                />
                            </label>
                            <label className="block text-xs">
                                <span className="text-slate-500 font-semibold">Storage / GB · monthly</span>
                                <input
                                    type="number"
                                    min={0}
                                    step={0.01}
                                    value={pricing.pricePerGbMonthly}
                                    onChange={(e) =>
                                        setPricing({ ...pricing, pricePerGbMonthly: Number(e.target.value) })
                                    }
                                    className="mt-1.5 w-full premium-input rounded-xl px-3 py-2.5 text-sm"
                                />
                            </label>
                            <label className="block text-xs">
                                <span className="text-slate-500 font-semibold">Storage / GB · yearly</span>
                                <input
                                    type="number"
                                    min={0}
                                    step={0.01}
                                    value={pricing.pricePerGbYearly}
                                    onChange={(e) =>
                                        setPricing({ ...pricing, pricePerGbYearly: Number(e.target.value) })
                                    }
                                    className="mt-1.5 w-full premium-input rounded-xl px-3 py-2.5 text-sm"
                                />
                            </label>
                        </div>

                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-6 pt-2 border-t border-slate-100">
                            <label className="block text-xs">
                                <span className="text-slate-500 font-semibold">Free-tier storage (GB)</span>
                                <input
                                    type="number"
                                    min={0}
                                    value={pricing.freeStorageGb}
                                    onChange={(e) =>
                                        setPricing({ ...pricing, freeStorageGb: Number(e.target.value) })
                                    }
                                    className="mt-1.5 w-full premium-input rounded-xl px-3 py-2.5 text-sm"
                                />
                            </label>
                            <div className="text-xs">
                                <span className="text-slate-500 font-semibold">Free-tier agents</span>
                                <div className="mt-2 flex flex-wrap gap-1.5">
                                    {AGENT_CHOICES.map((a) => {
                                        const on = pricing.freeAgentIds.includes(a.value);
                                        return (
                                            <button
                                                key={a.value}
                                                type="button"
                                                onClick={() => {
                                                    const next = on
                                                        ? pricing.freeAgentIds.filter((x) => x !== a.value)
                                                        : [...pricing.freeAgentIds, a.value];
                                                    setPricing({
                                                        ...pricing,
                                                        freeAgentIds: next.length ? next : ["other_agent"],
                                                    });
                                                }}
                                                className={`px-2.5 py-1 rounded-lg text-[11px] border transition-colors ${
                                                    on
                                                        ? "bg-[rgba(56,182,255,0.1)] border-[rgba(56,182,255,0.28)] text-(--vb-blue-dark)"
                                                        : "bg-white border-slate-200 text-slate-500 hover:border-slate-300"
                                                }`}
                                            >
                                                {a.label}
                                            </button>
                                        );
                                    })}
                                </div>
                            </div>
                        </div>

                        <div className="overflow-x-auto rounded-xl border border-slate-100">
                            <table className="w-full text-sm">
                                <thead>
                                    <tr className="text-left text-[11px] font-semibold uppercase tracking-wide text-slate-400 border-b border-slate-100">
                                        <th className="px-4 py-3">Agent</th>
                                        <th className="px-4 py-3">Monthly</th>
                                        <th className="px-4 py-3">Yearly</th>
                                        <th className="px-4 py-3 w-20">On</th>
                                    </tr>
                                </thead>
                                <tbody className="divide-y divide-slate-50">
                                    {pricing.agents.map((row, idx) => (
                                        <tr key={row.agentId} className="hover:bg-slate-50/60">
                                            <td className="px-4 py-3 font-medium text-slate-800">
                                                {agentLabel(row.agentId)}
                                            </td>
                                            <td className="px-4 py-3">
                                                <input
                                                    type="number"
                                                    min={0}
                                                    step={0.01}
                                                    value={row.monthlyPrice}
                                                    onChange={(e) => {
                                                        const agents = [...pricing.agents];
                                                        agents[idx] = {
                                                            ...row,
                                                            monthlyPrice: Number(e.target.value),
                                                        };
                                                        setPricing({ ...pricing, agents });
                                                    }}
                                                    className="w-24 premium-input rounded-lg px-2 py-1.5 text-sm"
                                                />
                                            </td>
                                            <td className="px-4 py-3">
                                                <input
                                                    type="number"
                                                    min={0}
                                                    step={0.01}
                                                    value={row.yearlyPrice}
                                                    onChange={(e) => {
                                                        const agents = [...pricing.agents];
                                                        agents[idx] = {
                                                            ...row,
                                                            yearlyPrice: Number(e.target.value),
                                                        };
                                                        setPricing({ ...pricing, agents });
                                                    }}
                                                    className="w-24 premium-input rounded-lg px-2 py-1.5 text-sm"
                                                />
                                            </td>
                                            <td className="px-4 py-3">
                                                <input
                                                    type="checkbox"
                                                    checked={row.enabled}
                                                    onChange={(e) => {
                                                        const agents = [...pricing.agents];
                                                        agents[idx] = { ...row, enabled: e.target.checked };
                                                        setPricing({ ...pricing, agents });
                                                    }}
                                                    className="rounded border-slate-300"
                                                />
                                            </td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>

                        <div className="flex justify-end pt-1">
                            <button
                                type="button"
                                disabled={saving}
                                onClick={savePricing}
                                className="btn-gradient rounded-xl px-5 py-2.5 text-sm inline-flex items-center gap-2"
                            >
                                {saving ? <Loader2 size={14} className="animate-spin" /> : null}
                                Save pricing
                            </button>
                        </div>
                    </div>
                </div>
            ) : tab === "plans" ? (
                <div className="rounded-2xl border border-slate-200 bg-white overflow-hidden divide-y divide-slate-100">
                    {plans.length === 0 ? (
                        <div className="p-8">
                            <EmptyState
                                icon={<Package size={22} />}
                                title="No plans yet"
                                description="Create a named package with agents, storage, and price."
                            />
                        </div>
                    ) : (
                        plans.map((p) => (
                            <div
                                key={p.planId}
                                className="px-5 py-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3 hover:bg-slate-50/50"
                            >
                                <div className="min-w-0">
                                    <div className="flex items-center gap-2.5 flex-wrap">
                                        <h3 className="font-semibold text-slate-900 text-sm">{p.name}</h3>
                                        <span
                                            className={`text-[10px] font-semibold uppercase tracking-wide ${
                                                p.status === "active" ? "text-emerald-600" : "text-slate-400"
                                            }`}
                                        >
                                            {p.status}
                                        </span>
                                        <span className="text-[11px] text-slate-400 capitalize">
                                            {p.billingCycle}
                                        </span>
                                    </div>
                                    <p className="text-sm text-slate-600 mt-1">
                                        {money(p.price, pricing?.currency)}
                                        <span className="text-slate-300 mx-1.5">·</span>
                                        {p.storageGb} GB
                                        <span className="text-slate-300 mx-1.5">·</span>
                                        <span className="text-slate-500 text-xs">
                                            {p.agentIds.map(agentLabel).join(", ")}
                                        </span>
                                    </p>
                                    {p.description && (
                                        <p className="text-xs text-slate-400 mt-1 line-clamp-1">{p.description}</p>
                                    )}
                                </div>
                                {p.status === "active" && (
                                    <div className="flex gap-2 shrink-0">
                                        <button
                                            type="button"
                                            onClick={() => openEditPlan(p)}
                                            className="rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs text-slate-600 hover:bg-slate-50"
                                        >
                                            Edit
                                        </button>
                                        <button
                                            type="button"
                                            onClick={() => archivePlan(p.planId)}
                                            className="rounded-lg p-1.5 text-slate-400 hover:text-rose-500 hover:bg-rose-50"
                                            title="Archive"
                                        >
                                            <Trash2 size={14} />
                                        </button>
                                    </div>
                                )}
                            </div>
                        ))
                    )}
                </div>
            ) : tab === "requests" ? (
                <div className="rounded-2xl border border-slate-200 bg-white overflow-hidden divide-y divide-slate-100">
                    {requests.length === 0 ? (
                        <div className="p-8">
                            <EmptyState
                                icon={<Package size={22} />}
                                title="No plan requests"
                                description="When admins request a plan, they appear here for approval."
                            />
                        </div>
                    ) : (
                        requests.map((r) => (
                            <div key={r.requestId} className="px-5 py-4 space-y-2.5 hover:bg-slate-50/40">
                                <div className="flex flex-wrap items-center justify-between gap-2">
                                    <div className="flex items-center gap-2.5 min-w-0">
                                        <h3 className="font-semibold text-slate-900 text-sm truncate">
                                            {r.organization?.organizationName || r.organizationId}
                                        </h3>
                                        {r.requestType === "change" && (
                                            <span className="rounded bg-blue-50 text-blue-600 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide shrink-0">
                                                Change
                                            </span>
                                        )}
                                        <Badge
                                            variant={
                                                r.status === "pending"
                                                    ? "warning"
                                                    : r.status === "approved"
                                                      ? "success"
                                                      : "error"
                                            }
                                        >
                                            {r.status}
                                        </Badge>
                                    </div>
                                    <span className="text-sm font-medium text-slate-700 tabular-nums">
                                        {money(r.quotedPrice, pricing?.currency)}
                                        <span className="text-slate-400 font-normal text-xs ml-1 capitalize">
                                            / {r.billingCycle}
                                        </span>
                                    </span>
                                </div>
                                <p className="text-xs text-slate-500">
                                    {r.planName || "Custom"}
                                    <span className="text-slate-300 mx-1.5">·</span>
                                    {r.storageGb} GB
                                    <span className="text-slate-300 mx-1.5">·</span>
                                    {r.agentIds.map(agentLabel).join(", ")}
                                    {r.requestType === "change" && r.previousAgentIds?.length && (
                                        <span className="text-slate-400">
                                            {" "}
                                            (from: {r.previousAgentIds.map(agentLabel).join(", ")})
                                        </span>
                                    )}
                                </p>
                                {r.message && (
                                    <p className="text-xs text-slate-500 italic border-l-2 border-slate-200 pl-2">
                                        {r.message}
                                    </p>
                                )}
                                <p className="text-[11px] text-slate-400">
                                    {r.requester?.fullName || r.requester?.email || "admin"}
                                    {r.createdAt ? ` · ${new Date(r.createdAt).toLocaleString()}` : ""}
                                </p>
                                {r.status === "pending" && (
                                    <div className="space-y-2.5 pt-1">
                                        <div className="rounded-xl border border-slate-200 bg-slate-50/60 p-3 space-y-2">
                                            <div className="flex items-center justify-between gap-2 flex-wrap">
                                                <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">
                                                    Agent modules to grant
                                                </p>
                                                <span className="text-xs font-semibold text-slate-700 tabular-nums">
                                                    {money(
                                                        quoteSelection(
                                                            requestForm[r.requestId]?.agentIds ||
                                                                r.agentIds ||
                                                                [],
                                                            requestForm[r.requestId]?.storageGb ??
                                                                r.storageGb ??
                                                                10,
                                                            r.billingCycle
                                                        ),
                                                        pricing?.currency
                                                    )}
                                                    <span className="text-slate-400 font-normal text-[10px] ml-1 capitalize">
                                                        / {r.billingCycle}
                                                    </span>
                                                </span>
                                            </div>
                                            <div className="flex flex-wrap gap-1.5">
                                                {AGENT_CHOICES.map((a) => {
                                                    const on = (
                                                        requestForm[r.requestId]?.agentIds ||
                                                        r.agentIds ||
                                                        []
                                                    ).includes(a.value);
                                                    return (
                                                        <button
                                                            key={a.value}
                                                            type="button"
                                                            disabled={saving}
                                                            onClick={() =>
                                                                toggleRequestAgent(r.requestId, a.value)
                                                            }
                                                            className={`rounded-lg border px-2.5 py-1 text-xs font-medium inline-flex items-center gap-1 transition-colors ${
                                                                on
                                                                    ? "border-emerald-300 bg-emerald-50 text-emerald-700"
                                                                    : "border-slate-200 bg-white text-slate-500 hover:border-slate-300"
                                                            }`}
                                                        >
                                                            {on && <Check size={11} />}
                                                            {a.label}
                                                        </button>
                                                    );
                                                })}
                                            </div>
                                            <div className="flex items-center gap-2">
                                                <label className="text-[11px] font-medium text-slate-500">
                                                    Storage
                                                </label>
                                                <input
                                                    type="number"
                                                    min={0}
                                                    disabled={saving}
                                                    value={
                                                        requestForm[r.requestId]?.storageGb ??
                                                        r.storageGb ??
                                                        10
                                                    }
                                                    onChange={(e) =>
                                                        updateRequestForm(r.requestId, {
                                                            storageGb: Number(e.target.value) || 0,
                                                        })
                                                    }
                                                    className="w-24 rounded-lg border border-slate-200 bg-white px-2 py-1 text-xs text-slate-700"
                                                />
                                                <span className="text-[11px] text-slate-400">GB</span>
                                            </div>
                                        </div>
                                        <div className="flex gap-2">
                                            <button
                                                type="button"
                                                disabled={saving}
                                                onClick={() => approveRequest(r.requestId)}
                                                className="rounded-lg px-3 py-1.5 text-xs font-medium bg-emerald-600 text-white inline-flex items-center gap-1 hover:bg-emerald-700"
                                            >
                                                <Check size={13} /> Approve
                                            </button>
                                            <button
                                                type="button"
                                                disabled={saving}
                                                onClick={() => rejectRequest(r.requestId)}
                                                className="rounded-lg px-3 py-1.5 text-xs font-medium text-rose-600 hover:bg-rose-50 inline-flex items-center gap-1"
                                            >
                                                <XCircle size={13} /> Reject
                                            </button>
                                        </div>
                                    </div>
                                )}
                            </div>
                        ))
                    )}
                </div>
            ) : (
                <div className="space-y-4">
                    <div className="flex gap-1 border-b border-slate-200 overflow-x-auto">
                        {(["all", "active", "inactive", "expired", "cancelled"] as const).map((f) => {
                            const count =
                                f === "all"
                                    ? subscriptions.length
                                    : subscriptions.filter((s) => s.status === f).length;
                            return (
                                <button
                                    key={f}
                                    type="button"
                                    onClick={() => setSubFilter(f)}
                                    className={`relative px-3 py-2 text-xs font-medium capitalize whitespace-nowrap ${
                                        subFilter === f ? "text-(--vb-blue-dark)" : "text-slate-500 hover:text-slate-700"
                                    }`}
                                >
                                    {f}
                                    <span className="ml-1 text-slate-400">{count}</span>
                                    {subFilter === f && (
                                        <span className="absolute left-3 right-3 -bottom-px h-0.5 bg-(--vb-blue) rounded-full" />
                                    )}
                                </button>
                            );
                        })}
                    </div>
                    <div className="rounded-2xl border border-slate-200 bg-white overflow-hidden divide-y divide-slate-100">
                        {filteredSubs.length === 0 ? (
                            <div className="p-8">
                                <EmptyState
                                    icon={<HardDrive size={22} />}
                                    title="No subscriptions"
                                    description="Assign a plan to an organization, or approve a pending request."
                                />
                            </div>
                        ) : (
                            filteredSubs.map((s) => (
                                <div
                                    key={s.subscriptionId}
                                    className="px-5 py-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3 hover:bg-slate-50/40"
                                >
                                    <div className="min-w-0">
                                        <div className="flex flex-wrap items-center gap-2.5">
                                            <h3 className="font-semibold text-slate-900 text-sm">
                                                {s.organization?.organizationName || s.organizationId}
                                            </h3>
                                            <Badge
                                                variant={
                                                    s.status === "active"
                                                        ? "success"
                                                        : s.status === "cancelled"
                                                          ? "error"
                                                          : s.status === "inactive"
                                                            ? "warning"
                                                            : "muted"
                                                }
                                            >
                                                {s.status}
                                            </Badge>
                                        </div>
                                        <p className="text-sm text-slate-600 mt-1">
                                            {s.planName || "Custom"}
                                            <span className="text-slate-300 mx-1.5">·</span>
                                            {money(s.price, pricing?.currency)}
                                            <span className="text-slate-400 text-xs ml-1 capitalize">
                                                / {s.billingCycle}
                                            </span>
                                            <span className="text-slate-300 mx-1.5">·</span>
                                            {s.storageGb} GB
                                        </p>
                                        <p className="text-[11px] text-slate-400 mt-0.5 truncate">
                                            {s.agentIds.map(agentLabel).join(", ")}
                                            {s.endsAt
                                                ? ` · ends ${new Date(s.endsAt).toLocaleDateString()}`
                                                : ""}
                                        </p>
                                    </div>
                                    <div className="flex flex-wrap gap-1.5 shrink-0">
                                        <button
                                            type="button"
                                            onClick={() => openManage(s)}
                                            className="rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs text-slate-600 hover:bg-slate-50 inline-flex items-center gap-1"
                                        >
                                            <Pencil size={12} /> Manage
                                        </button>
                                        {String(s.status).toLowerCase() === "active" && (
                                            <>
                                                <button
                                                    type="button"
                                                    onClick={() =>
                                                        patchSub(s.subscriptionId, "extend", { periods: 1 })
                                                    }
                                                    className="rounded-lg px-3 py-1.5 text-xs text-slate-600 hover:bg-slate-100"
                                                >
                                                    Extend
                                                </button>
                                                <button
                                                    type="button"
                                                    onClick={() => patchSub(s.subscriptionId, "deactivate")}
                                                    className="rounded-lg px-3 py-1.5 text-xs text-amber-700 hover:bg-amber-50"
                                                >
                                                    Pause
                                                </button>
                                            </>
                                        )}
                                        {["inactive", "expired"].includes(String(s.status).toLowerCase()) && (
                                            <button
                                                type="button"
                                                onClick={() => patchSub(s.subscriptionId, "activate")}
                                                className="rounded-lg px-3 py-1.5 text-xs bg-emerald-600 text-white hover:bg-emerald-700"
                                            >
                                                Activate
                                            </button>
                                        )}
                                        {String(s.status).toLowerCase() !== "cancelled" && (
                                            <button
                                                type="button"
                                                onClick={() => patchSub(s.subscriptionId, "cancel")}
                                                className="rounded-lg px-3 py-1.5 text-xs text-rose-600 hover:bg-rose-50"
                                            >
                                                Cancel
                                            </button>
                                        )}
                                    </div>
                                </div>
                            ))
                        )}
                    </div>
                </div>
            )}

            {mounted &&
                planModal &&
                createPortal(
                    <div className="fixed inset-0 z-[100] flex items-center justify-center p-4">
                        <button
                            type="button"
                            className="absolute inset-0 bg-slate-900/40"
                            aria-label="Close"
                            onClick={() => !saving && setPlanModal(false)}
                        />
                        <div className="relative w-full max-w-lg rounded-2xl bg-white border border-slate-200 shadow-2xl overflow-hidden">
                            <div className="px-5 py-4 border-b border-slate-100 flex justify-between items-center">
                                <h3 className="font-bold text-slate-800">
                                    {editingPlan ? "Edit plan" : "Create plan"}
                                </h3>
                                <button type="button" onClick={() => setPlanModal(false)}>
                                    <X size={16} className="text-slate-400" />
                                </button>
                            </div>
                            <div className="px-5 py-4 space-y-3 max-h-[70vh] overflow-y-auto">
                                <label className="block text-xs">
                                    <span className="font-semibold text-slate-500">Name</span>
                                    <input
                                        value={planForm.name}
                                        onChange={(e) => setPlanForm({ ...planForm, name: e.target.value })}
                                        className="mt-1 w-full premium-input rounded-xl px-3 py-2.5 text-sm"
                                    />
                                </label>
                                <label className="block text-xs">
                                    <span className="font-semibold text-slate-500">Description</span>
                                    <textarea
                                        value={planForm.description}
                                        onChange={(e) =>
                                            setPlanForm({ ...planForm, description: e.target.value })
                                        }
                                        rows={2}
                                        className="mt-1 w-full premium-input rounded-xl px-3 py-2.5 text-sm"
                                    />
                                </label>
                                <label className="block text-xs">
                                    <span className="font-semibold text-slate-500">Billing cycle</span>
                                    <select
                                        value={planForm.billingCycle}
                                        onChange={(e) =>
                                            setPlanForm({
                                                ...planForm,
                                                billingCycle: e.target.value as "monthly" | "yearly",
                                            })
                                        }
                                        className="mt-1 w-full premium-input rounded-xl px-3 py-2.5 text-sm"
                                    >
                                        <option value="monthly">Monthly</option>
                                        <option value="yearly">Yearly</option>
                                    </select>
                                </label>
                                <div className="text-xs">
                                    <span className="font-semibold text-slate-500">Agents</span>
                                    <div className="mt-2 flex flex-wrap gap-2">
                                        {AGENT_CHOICES.map((a) => {
                                            const on = planForm.agentIds.includes(a.value);
                                            return (
                                                <button
                                                    key={a.value}
                                                    type="button"
                                                    onClick={() => {
                                                        const next = on
                                                            ? planForm.agentIds.filter((x) => x !== a.value)
                                                            : [...planForm.agentIds, a.value];
                                                        setPlanForm({ ...planForm, agentIds: next });
                                                    }}
                                                    className={`px-2.5 py-1 rounded-full text-[11px] border ${
                                                        on
                                                            ? "bg-[rgba(56,182,255,0.1)] border-[rgba(56,182,255,0.28)] text-(--vb-blue-dark)"
                                                            : "bg-white border-slate-200 text-slate-500"
                                                    }`}
                                                >
                                                    {a.label}
                                                </button>
                                            );
                                        })}
                                    </div>
                                </div>
                                <div className="grid grid-cols-2 gap-3">
                                    <label className="block text-xs">
                                        <span className="font-semibold text-slate-500">Storage (GB)</span>
                                        <input
                                            type="number"
                                            min={0}
                                            value={planForm.storageGb}
                                            onChange={(e) =>
                                                setPlanForm({
                                                    ...planForm,
                                                    storageGb: Number(e.target.value),
                                                })
                                            }
                                            className="mt-1 w-full premium-input rounded-xl px-3 py-2.5 text-sm"
                                        />
                                    </label>
                                    <label className="block text-xs">
                                        <span className="font-semibold text-slate-500">
                                            Price ({pricing?.currency || "USD"})
                                        </span>
                                        <input
                                            type="number"
                                            min={0}
                                            step={0.01}
                                            value={planForm.price}
                                            onChange={(e) =>
                                                setPlanForm({ ...planForm, price: Number(e.target.value) })
                                            }
                                            placeholder={String(suggestedPlanPrice)}
                                            className="mt-1 w-full premium-input rounded-xl px-3 py-2.5 text-sm"
                                        />
                                        <span className="text-[10px] text-slate-400 mt-1 block">
                                            Catalog suggest: {money(suggestedPlanPrice, pricing?.currency)}
                                        </span>
                                    </label>
                                </div>
                            </div>
                            <div className="px-5 py-4 border-t border-slate-100 flex justify-end gap-2 bg-slate-50">
                                <button
                                    type="button"
                                    onClick={() => setPlanModal(false)}
                                    className="btn-secondary rounded-xl px-4 py-2 text-sm"
                                >
                                    Cancel
                                </button>
                                <button
                                    type="button"
                                    disabled={saving}
                                    onClick={savePlan}
                                    className="btn-gradient rounded-xl px-4 py-2 text-sm"
                                >
                                    {saving ? "Saving…" : "Save plan"}
                                </button>
                            </div>
                        </div>
                    </div>,
                    document.body
                )}

            {mounted &&
                activateOpen &&
                createPortal(
                    <div className="fixed inset-0 z-[100] flex items-center justify-center p-4">
                        <button
                            type="button"
                            className="absolute inset-0 bg-slate-900/40"
                            aria-label="Close"
                            onClick={() => !saving && setActivateOpen(false)}
                        />
                        <div className="relative w-full max-w-lg rounded-2xl bg-white border border-slate-200 shadow-2xl overflow-hidden">
                            <div className="px-5 py-4 border-b border-slate-100 flex justify-between">
                                <h3 className="font-bold text-slate-800">Activate subscription</h3>
                                <button type="button" onClick={() => setActivateOpen(false)}>
                                    <X size={16} className="text-slate-400" />
                                </button>
                            </div>
                            <div className="px-5 py-4 space-y-3">
                                <label className="block text-xs">
                                    <span className="font-semibold text-slate-500">Organization</span>
                                    <select
                                        value={activateForm.organizationId}
                                        onChange={(e) =>
                                            setActivateForm({
                                                ...activateForm,
                                                organizationId: e.target.value,
                                            })
                                        }
                                        className="mt-1 w-full premium-input rounded-xl px-3 py-2.5 text-sm"
                                    >
                                        <option value="">Select…</option>
                                        {orgs.map((o) => (
                                            <option key={o.organizationId} value={o.organizationId}>
                                                {o.organizationName}
                                            </option>
                                        ))}
                                    </select>
                                </label>
                                <label className="block text-xs">
                                    <span className="font-semibold text-slate-500">Named plan (optional)</span>
                                    <select
                                        value={activateForm.planId}
                                        onChange={(e) =>
                                            setActivateForm({ ...activateForm, planId: e.target.value })
                                        }
                                        className="mt-1 w-full premium-input rounded-xl px-3 py-2.5 text-sm"
                                    >
                                        <option value="">Custom selection</option>
                                        {activePlans.map((p) => (
                                            <option key={p.planId} value={p.planId}>
                                                {p.name} ({p.billingCycle}) — {money(p.price)}
                                            </option>
                                        ))}
                                    </select>
                                </label>
                                {!activateForm.planId && (
                                    <>
                                        <div className="text-xs">
                                            <span className="font-semibold text-slate-500">Agents</span>
                                            <div className="mt-2 flex flex-wrap gap-2">
                                                {AGENT_CHOICES.map((a) => {
                                                    const on = activateForm.agentIds.includes(a.value);
                                                    return (
                                                        <button
                                                            key={a.value}
                                                            type="button"
                                                            onClick={() => {
                                                                const next = on
                                                                    ? activateForm.agentIds.filter(
                                                                          (x) => x !== a.value
                                                                      )
                                                                    : [...activateForm.agentIds, a.value];
                                                                setActivateForm({
                                                                    ...activateForm,
                                                                    agentIds: next,
                                                                });
                                                            }}
                                                            className={`px-2.5 py-1 rounded-full text-[11px] border ${
                                                                on
                                                                    ? "bg-[rgba(56,182,255,0.1)] border-[rgba(56,182,255,0.28)] text-(--vb-blue-dark)"
                                                                    : "bg-white border-slate-200 text-slate-500"
                                                            }`}
                                                        >
                                                            {a.label}
                                                        </button>
                                                    );
                                                })}
                                            </div>
                                        </div>
                                        <div className="grid grid-cols-2 gap-3">
                                            <label className="block text-xs">
                                                <span className="font-semibold text-slate-500">Storage GB</span>
                                                <input
                                                    type="number"
                                                    value={activateForm.storageGb}
                                                    onChange={(e) =>
                                                        setActivateForm({
                                                            ...activateForm,
                                                            storageGb: Number(e.target.value),
                                                        })
                                                    }
                                                    className="mt-1 w-full premium-input rounded-xl px-3 py-2.5 text-sm"
                                                />
                                            </label>
                                            <label className="block text-xs">
                                                <span className="font-semibold text-slate-500">Cycle</span>
                                                <select
                                                    value={activateForm.billingCycle}
                                                    onChange={(e) =>
                                                        setActivateForm({
                                                            ...activateForm,
                                                            billingCycle: e.target.value as
                                                                | "monthly"
                                                                | "yearly",
                                                        })
                                                    }
                                                    className="mt-1 w-full premium-input rounded-xl px-3 py-2.5 text-sm"
                                                >
                                                    <option value="monthly">Monthly</option>
                                                    <option value="yearly">Yearly</option>
                                                </select>
                                            </label>
                                        </div>
                                    </>
                                )}
                                <label className="block text-xs">
                                    <span className="font-semibold text-slate-500">Price override (optional)</span>
                                    <input
                                        type="number"
                                        value={activateForm.price}
                                        onChange={(e) =>
                                            setActivateForm({
                                                ...activateForm,
                                                price: Number(e.target.value),
                                            })
                                        }
                                        className="mt-1 w-full premium-input rounded-xl px-3 py-2.5 text-sm"
                                    />
                                </label>
                            </div>
                            <div className="px-5 py-4 border-t border-slate-100 flex justify-end gap-2 bg-slate-50">
                                <button
                                    type="button"
                                    onClick={() => setActivateOpen(false)}
                                    className="btn-secondary rounded-xl px-4 py-2 text-sm"
                                >
                                    Cancel
                                </button>
                                <button
                                    type="button"
                                    disabled={saving}
                                    onClick={activateDirect}
                                    className="btn-gradient rounded-xl px-4 py-2 text-sm"
                                >
                                    Activate
                                </button>
                            </div>
                        </div>
                    </div>,
                    document.body
                )}

            {mounted &&
                manageOpen &&
                managing &&
                createPortal(
                    <div className="fixed inset-0 z-[100] flex items-center justify-center p-4">
                        <button
                            type="button"
                            className="absolute inset-0 bg-slate-900/40"
                            aria-label="Close"
                            onClick={() => !saving && setManageOpen(false)}
                        />
                        <div className="relative w-full max-w-lg rounded-2xl bg-white border border-slate-200 shadow-2xl overflow-hidden">
                            <div className="px-5 py-4 border-b border-slate-100 flex justify-between items-start gap-3">
                                <div>
                                    <h3 className="font-bold text-slate-800">Manage subscription</h3>
                                    <p className="text-xs text-slate-500 mt-0.5">
                                        {managing.organization?.organizationName || managing.organizationId} ·{" "}
                                        <span className="capitalize">{managing.status}</span>
                                    </p>
                                </div>
                                <button type="button" onClick={() => setManageOpen(false)}>
                                    <X size={16} className="text-slate-400" />
                                </button>
                            </div>
                            <div className="px-5 py-4 space-y-3 max-h-[70vh] overflow-y-auto">
                                <label className="block text-xs">
                                    <span className="font-semibold text-slate-500">Plan name</span>
                                    <input
                                        value={manageForm.planName}
                                        onChange={(e) =>
                                            setManageForm({ ...manageForm, planName: e.target.value })
                                        }
                                        className="mt-1 w-full premium-input rounded-xl px-3 py-2.5 text-sm"
                                    />
                                </label>
                                <label className="block text-xs">
                                    <span className="font-semibold text-slate-500">Billing cycle</span>
                                    <select
                                        value={manageForm.billingCycle}
                                        onChange={(e) =>
                                            setManageForm({
                                                ...manageForm,
                                                billingCycle: e.target.value as "monthly" | "yearly",
                                            })
                                        }
                                        className="mt-1 w-full premium-input rounded-xl px-3 py-2.5 text-sm"
                                    >
                                        <option value="monthly">Monthly</option>
                                        <option value="yearly">Yearly</option>
                                    </select>
                                </label>
                                <div className="text-xs">
                                    <span className="font-semibold text-slate-500">Agents</span>
                                    <div className="mt-2 flex flex-wrap gap-2">
                                        {AGENT_CHOICES.map((a) => {
                                            const on = manageForm.agentIds.includes(a.value);
                                            return (
                                                <button
                                                    key={a.value}
                                                    type="button"
                                                    onClick={() => {
                                                        const next = on
                                                            ? manageForm.agentIds.filter((x) => x !== a.value)
                                                            : [...manageForm.agentIds, a.value];
                                                        setManageForm({ ...manageForm, agentIds: next });
                                                    }}
                                                    className={`px-2.5 py-1 rounded-full text-[11px] border ${
                                                        on
                                                            ? "bg-[rgba(56,182,255,0.1)] border-[rgba(56,182,255,0.28)] text-(--vb-blue-dark)"
                                                            : "bg-white border-slate-200 text-slate-500"
                                                    }`}
                                                >
                                                    {a.label}
                                                </button>
                                            );
                                        })}
                                    </div>
                                </div>
                                <div className="grid grid-cols-2 gap-3">
                                    <label className="block text-xs">
                                        <span className="font-semibold text-slate-500">Storage (GB)</span>
                                        <input
                                            type="number"
                                            min={0}
                                            value={manageForm.storageGb}
                                            onChange={(e) =>
                                                setManageForm({
                                                    ...manageForm,
                                                    storageGb: Number(e.target.value),
                                                })
                                            }
                                            className="mt-1 w-full premium-input rounded-xl px-3 py-2.5 text-sm"
                                        />
                                    </label>
                                    <label className="block text-xs">
                                        <span className="font-semibold text-slate-500">Price</span>
                                        <input
                                            type="number"
                                            min={0}
                                            step={0.01}
                                            value={manageForm.price}
                                            onChange={(e) =>
                                                setManageForm({
                                                    ...manageForm,
                                                    price: Number(e.target.value),
                                                })
                                            }
                                            className="mt-1 w-full premium-input rounded-xl px-3 py-2.5 text-sm"
                                        />
                                    </label>
                                </div>
                                <label className="block text-xs">
                                    <span className="font-semibold text-slate-500">End date</span>
                                    <input
                                        type="date"
                                        value={manageForm.endsAt}
                                        onChange={(e) =>
                                            setManageForm({ ...manageForm, endsAt: e.target.value })
                                        }
                                        className="mt-1 w-full premium-input rounded-xl px-3 py-2.5 text-sm"
                                    />
                                </label>

                                <div className="rounded-xl border border-slate-200 bg-slate-50 p-3 space-y-2">
                                    <p className="text-[11px] font-semibold text-slate-600 uppercase tracking-wider">
                                        Quick actions
                                    </p>
                                    <div className="flex flex-wrap gap-2 items-center">
                                        <label className="text-xs text-slate-500 inline-flex items-center gap-1">
                                            Periods
                                            <input
                                                type="number"
                                                min={1}
                                                max={24}
                                                value={manageForm.extendPeriods}
                                                onChange={(e) =>
                                                    setManageForm({
                                                        ...manageForm,
                                                        extendPeriods: Math.max(1, Number(e.target.value) || 1),
                                                    })
                                                }
                                                className="w-14 premium-input rounded-lg px-2 py-1 text-sm"
                                            />
                                        </label>
                                        <button
                                            type="button"
                                            disabled={saving || managing.status === "cancelled"}
                                            onClick={() =>
                                                patchSub(managing.subscriptionId, "extend", {
                                                    periods: manageForm.extendPeriods,
                                                })
                                            }
                                            className="btn-secondary rounded-lg px-3 py-1.5 text-xs"
                                        >
                                            Extend
                                        </button>
                                        {String(managing.status).toLowerCase() === "active" ? (
                                            <button
                                                type="button"
                                                disabled={saving}
                                                onClick={() =>
                                                    patchSub(managing.subscriptionId, "deactivate")
                                                }
                                                className="rounded-lg px-3 py-1.5 text-xs border border-amber-200 text-amber-700"
                                            >
                                                Deactivate
                                            </button>
                                        ) : ["inactive", "expired"].includes(
                                              String(managing.status).toLowerCase()
                                          ) ? (
                                            <button
                                                type="button"
                                                disabled={saving}
                                                onClick={() =>
                                                    patchSub(managing.subscriptionId, "activate")
                                                }
                                                className="rounded-lg px-3 py-1.5 text-xs bg-emerald-600 text-white"
                                            >
                                                Activate
                                            </button>
                                        ) : null}
                                        {managing.status !== "cancelled" && (
                                            <button
                                                type="button"
                                                disabled={saving}
                                                onClick={() => patchSub(managing.subscriptionId, "cancel")}
                                                className="rounded-lg px-3 py-1.5 text-xs border border-rose-200 text-rose-600"
                                            >
                                                Cancel plan
                                            </button>
                                        )}
                                    </div>
                                </div>
                            </div>
                            <div className="px-5 py-4 border-t border-slate-100 flex justify-end gap-2 bg-slate-50">
                                <button
                                    type="button"
                                    onClick={() => setManageOpen(false)}
                                    className="btn-secondary rounded-xl px-4 py-2 text-sm"
                                >
                                    Close
                                </button>
                                <button
                                    type="button"
                                    disabled={saving || managing.status === "cancelled"}
                                    onClick={saveManageUpdate}
                                    className="btn-gradient rounded-xl px-4 py-2 text-sm"
                                >
                                    {saving ? "Saving…" : "Save changes"}
                                </button>
                            </div>
                        </div>
                    </div>,
                    document.body
                )}
        </div>
    );
}
