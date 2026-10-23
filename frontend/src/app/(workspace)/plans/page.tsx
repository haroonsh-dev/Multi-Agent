"use client";

import React, { useCallback, useEffect, useMemo, useState } from "react";
import { Check, Loader2, RefreshCw, Send } from "lucide-react";
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
};

type Plan = {
    planId: string;
    name: string;
    description?: string;
    billingCycle: "monthly" | "yearly";
    agentIds: string[];
    storageGb: number;
    price: number;
};

type Entitlement = {
    agentIds: string[];
    storageGb: number;
    planLabel: string;
    isFreeTier: boolean;
    subscription?: {
        planId?: string | null;
        planName?: string | null;
        endsAt?: string;
        billingCycle?: string;
        price?: number;
        status?: string;
    } | null;
};

type PlanRequest = {
    requestId: string;
    planName?: string | null;
    status: string;
    quotedPrice: number;
    billingCycle: string;
    storageGb: number;
    agentIds: string[];
    requestType?: string;
    previousAgentIds?: string[];
    createdAt?: string;
};

const AGENT_CHOICES = AGENT_OPTIONS.filter((o) => o.value);

type PlansCache = {
    plans: Plan[];
    pricing: Pricing | null;
    entitlement: Entitlement | null;
    storageUsedBytes: number;
    requests: PlanRequest[];
    at: number;
};

let plansCache: PlansCache | null = null;
const PLANS_CACHE_MS = 60_000;

function agentLabel(id: string) {
    return AGENT_CHOICES.find((a) => a.value === id)?.label || id.replace(/_agent$/, "").replace(/_/g, " ");
}

function money(n: number, currency = "USD") {
    return `${currency} ${Number(n || 0).toFixed(0)}`;
}

function statusVariant(status: string): "warning" | "success" | "error" | "muted" {
    if (status === "pending") return "warning";
    if (status === "approved") return "success";
    if (status === "rejected" || status === "cancelled") return "error";
    return "muted";
}

export default function AdminPlansPage() {
    const [loading, setLoading] = useState(() => !plansCache);
    const [sending, setSending] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [toast, setToast] = useState<string | null>(null);

    const [plans, setPlans] = useState<Plan[]>(() => plansCache?.plans || []);
    const [pricing, setPricing] = useState<Pricing | null>(() => plansCache?.pricing || null);
    const [entitlement, setEntitlement] = useState<Entitlement | null>(() => plansCache?.entitlement || null);
    const [storageUsedBytes, setStorageUsedBytes] = useState(() => plansCache?.storageUsedBytes || 0);
    const [requests, setRequests] = useState<PlanRequest[]>(() => plansCache?.requests || []);

    const [cycle, setCycle] = useState<"monthly" | "yearly">("monthly");
    const [selectedAgents, setSelectedAgents] = useState<string[]>(["other_agent"]);
    const [changeAgents, setChangeAgents] = useState<string[]>(() => plansCache?.entitlement?.agentIds || []);
    const [storageGb, setStorageGb] = useState(5);
    const [message, setMessage] = useState("");

    const load = useCallback(async (opts?: { silent?: boolean }) => {
        const hasCache = Boolean(plansCache);
        const fresh = plansCache && Date.now() - plansCache.at < PLANS_CACHE_MS;
        const silent = opts?.silent ?? Boolean(fresh || hasCache);
        if (!silent) setLoading(true);
        setError(null);
        try {
            const [catalog, sub, mine] = await Promise.all([
                apiRequest("/docs/plans"),
                apiRequest("/docs/plans/subscription"),
                apiRequest("/docs/plans/requests/mine"),
            ]);
            const nextPlans = catalog?.data?.plans || [];
            const nextPricing = catalog?.data?.pricing || null;
            const nextEntitlement = sub?.data?.entitlement || null;
            const nextStorage = sub?.data?.storageUsedBytes || 0;
            const nextRequests = mine?.data?.requests || [];
            setPlans(nextPlans);
            setPricing(nextPricing);
            setEntitlement(nextEntitlement);
            setChangeAgents(nextEntitlement?.agentIds || []);
            setStorageUsedBytes(nextStorage);
            setRequests(nextRequests);
            plansCache = {
                plans: nextPlans,
                pricing: nextPricing,
                entitlement: nextEntitlement,
                storageUsedBytes: nextStorage,
                requests: nextRequests,
                at: Date.now(),
            };
        } catch (e: any) {
            setError(e.message || "Failed to load plans");
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        void load({ silent: Boolean(plansCache) });
    }, [load]);

    useEffect(() => {
        if (!toast) return;
        const t = setTimeout(() => setToast(null), 4000);
        return () => clearTimeout(t);
    }, [toast]);

    const estimate = useMemo(() => {
        if (!pricing) return 0;
        let total = 0;
        for (const id of selectedAgents) {
            const row = pricing.agents.find((a) => a.agentId === id);
            if (!row) continue;
            total += cycle === "yearly" ? row.yearlyPrice : row.monthlyPrice;
        }
        total +=
            storageGb * (cycle === "yearly" ? pricing.pricePerGbYearly : pricing.pricePerGbMonthly);
        return Math.round(total * 100) / 100;
    }, [pricing, selectedAgents, storageGb, cycle]);

    const changeCycle = (entitlement?.subscription?.billingCycle || "monthly") as
        | "monthly"
        | "yearly";
    const changeEstimate = useMemo(() => {
        if (!pricing) return 0;
        let total = 0;
        for (const id of changeAgents) {
            const row = pricing.agents.find((a) => a.agentId === id);
            if (!row) continue;
            total += changeCycle === "yearly" ? row.yearlyPrice : row.monthlyPrice;
        }
        total +=
            (entitlement?.storageGb ?? 0) *
            (changeCycle === "yearly" ? pricing.pricePerGbYearly : pricing.pricePerGbMonthly);
        return Math.round(total * 100) / 100;
    }, [pricing, changeAgents, changeCycle, entitlement?.storageGb]);

    const requestChange = async () => {
        if (!changeAgents.length) {
            setError("Select at least one agent");
            return;
        }
        if (!confirm("Request to change the agent modules on your current plan? Super Admin will review."))
            return;
        setSending(true);
        setError(null);
        try {
            await apiRequest("/docs/plans/requests", {
                method: "POST",
                body: JSON.stringify({
                    requestType: "change",
                    agentIds: changeAgents,
                    message: message || "Agent module change request",
                }),
            });
            setToast("Change request sent");
            setMessage("");
            await load();
        } catch (e: any) {
            setError(e.message || "Request failed");
        } finally {
            setSending(false);
        }
    };

    const usedGb = storageUsedBytes / (1024 * 1024 * 1024);
    const limitGb = Math.max(entitlement?.storageGb ?? 1, 0.01);
    const storagePct = Math.min(100, Math.round((usedGb / limitGb) * 100));
    const pending = requests.find((r) => r.status === "pending");
    const currency = pricing?.currency || "USD";
    const currentPlanId = entitlement?.subscription?.planId || null;
    const currentPlanName = (
        entitlement?.subscription?.planName ||
        entitlement?.planLabel ||
        ""
    ).toLowerCase();
    const hasActiveSub =
        !!entitlement?.subscription &&
        String(entitlement.subscription.status || "active").toLowerCase() === "active";

    const isCurrentPlan = (p: Plan) => {
        if (!hasActiveSub) return false;
        if (currentPlanId && p.planId === currentPlanId) return true;
        return currentPlanName !== "" && currentPlanName === p.name.toLowerCase();
    };

    const requestNamedPlan = async (plan: Plan) => {
        if (!confirm(`Request “${plan.name}”? Super Admin will review and activate.`)) return;
        setSending(true);
        setError(null);
        try {
            await apiRequest("/docs/plans/requests", {
                method: "POST",
                body: JSON.stringify({
                    planId: plan.planId,
                    message: message || `Interested in ${plan.name}`,
                }),
            });
            setToast("Request sent");
            setMessage("");
            await load();
        } catch (e: any) {
            setError(e.message || "Request failed");
        } finally {
            setSending(false);
        }
    };

    const requestCustom = async () => {
        if (!selectedAgents.length) {
            setError("Select at least one agent");
            return;
        }
        if (!confirm(`Request custom package (~${money(estimate, currency)})?`)) return;
        setSending(true);
        setError(null);
        try {
            await apiRequest("/docs/plans/requests", {
                method: "POST",
                body: JSON.stringify({
                    agentIds: selectedAgents,
                    storageGb,
                    billingCycle: cycle,
                    message: message || "Custom plan request",
                }),
            });
            setToast("Custom request sent");
            setMessage("");
            await load();
        } catch (e: any) {
            setError(e.message || "Request failed");
        } finally {
            setSending(false);
        }
    };

    const agentRows = pricing?.agents?.length
        ? pricing.agents
        : AGENT_CHOICES.map((a) => ({
              agentId: a.value,
              monthlyPrice: 0,
              yearlyPrice: 0,
              enabled: true,
          }));

    return (
        <div className="p-4 sm:p-6 lg:p-8 max-w-5xl mx-auto space-y-8">
            <PageHeader
                title="Plans"
                subtitle="Browse packages or build your own. Super Admin activates after your request."
            />

            {toast && (
                <div className="rounded-xl bg-emerald-50 text-emerald-800 px-4 py-3 text-sm">{toast}</div>
            )}
            {error && (
                <div className="rounded-xl bg-rose-50 text-rose-700 px-4 py-3 text-sm">{error}</div>
            )}

            {loading && plans.length === 0 && !entitlement ? (
                <div className="py-16 flex justify-center text-slate-400 text-sm gap-2">
                    <Loader2 size={16} className="animate-spin" /> Loading…
                </div>
            ) : (
                <>
                    {loading && (
                        <div className="flex items-center gap-2 text-sm text-slate-400">
                            <Loader2 size={14} className="animate-spin" /> Refreshing…
                        </div>
                    )}
                    {/* Current plan */}
                    <section className="rounded-2xl border border-slate-200 bg-white p-6">
                        <p className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">
                            Current plan
                        </p>
                        <div className="mt-2 flex flex-wrap items-baseline gap-x-3 gap-y-1">
                            <h2 className="text-xl font-bold text-slate-900 capitalize">
                                {entitlement?.planLabel || "free"}
                            </h2>
                            {entitlement?.subscription?.billingCycle && (
                                <span className="text-sm text-slate-500">
                                    {entitlement.subscription.billingCycle}
                                </span>
                            )}
                        </div>

                        <div className="mt-5 grid sm:grid-cols-2 gap-6">
                            <div>
                                <div className="flex justify-between text-xs text-slate-500 mb-1.5">
                                    <span>Storage</span>
                                    <span>
                                        {usedGb.toFixed(2)} / {limitGb} GB
                                    </span>
                                </div>
                                <div className="h-1.5 rounded-full bg-slate-100 overflow-hidden">
                                    <div
                                        className="h-full rounded-full bg-[rgba(56,182,255,0.1)] transition-all"
                                        style={{ width: `${storagePct}%` }}
                                    />
                                </div>
                            </div>
                            <div>
                                <p className="text-xs text-slate-500 mb-1.5">Agents included</p>
                                <p className="text-sm text-slate-700 leading-relaxed">
                                    {(entitlement?.agentIds || []).map(agentLabel).join(" · ") || "—"}
                                </p>
                            </div>
                        </div>

                        {entitlement?.subscription?.endsAt && (
                            <p className="mt-4 text-xs text-slate-400">
                                Ends {new Date(entitlement.subscription.endsAt).toLocaleDateString()}
                            </p>
                        )}

                        {hasActiveSub && (
                            <div className="mt-6 pt-5 border-t border-slate-100">
                                <div className="flex items-center justify-between gap-2 flex-wrap">
                                    <div>
                                        <h3 className="text-sm font-bold text-slate-900">
                                            Change agent modules
                                        </h3>
                                        <p className="text-xs text-slate-500 mt-0.5">
                                            Swap which agents your plan includes — Super Admin
                                            reviews the change.
                                        </p>
                                    </div>
                                    <span className="text-xs font-semibold text-slate-700 tabular-nums">
                                        {money(changeEstimate, currency)}
                                        <span className="text-slate-400 font-normal text-[10px] ml-1 capitalize">
                                            / {changeCycle}
                                        </span>
                                    </span>
                                </div>
                                <div className="mt-3 flex flex-wrap gap-1.5">
                                    {AGENT_CHOICES.map((a) => {
                                        const on = changeAgents.includes(a.value);
                                        return (
                                            <button
                                                key={a.value}
                                                type="button"
                                                disabled={sending || !!pending}
                                                onClick={() =>
                                                    setChangeAgents((prev) =>
                                                        on
                                                            ? prev.filter((x) => x !== a.value)
                                                            : [...prev, a.value]
                                                    )
                                                }
                                                className={`rounded-lg border px-2.5 py-1 text-xs font-medium inline-flex items-center gap-1 transition-colors ${
                                                    on
                                                        ? "border-[rgba(56,182,255,0.4)] bg-[rgba(56,182,255,0.1)] text-(--vb-blue-dark)"
                                                        : "border-slate-200 bg-white text-slate-500 hover:border-slate-300"
                                                }`}
                                            >
                                                {on && <Check size={11} />}
                                                {a.label}
                                            </button>
                                        );
                                    })}
                                </div>
                                <div className="mt-3 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                                    <p className="text-xs text-slate-400">
                                        Storage stays at {entitlement?.storageGb ?? 0} GB ·{" "}
                                        {changeCycle}
                                        {entitlement?.agentIds?.length ? (
                                            <>
                                                {" "}
                                                · currently:{" "}
                                                {entitlement.agentIds.map(agentLabel).join(", ")}
                                            </>
                                        ) : null}
                                    </p>
                                    <button
                                        type="button"
                                        disabled={sending || !!pending}
                                        onClick={requestChange}
                                        className="rounded-lg px-3.5 py-2 text-xs font-semibold bg-slate-900 text-white inline-flex items-center gap-1.5 hover:bg-slate-800 disabled:opacity-40"
                                    >
                                        {sending ? (
                                            <Loader2 size={13} className="animate-spin" />
                                        ) : (
                                            <RefreshCw size={13} />
                                        )}
                                        Request change
                                    </button>
                                </div>
                            </div>
                        )}
                    </section>

                    {pending && (
                        <div className="rounded-2xl border border-amber-100 bg-amber-50/80 px-5 py-4 text-sm text-amber-900">
                            <span className="font-semibold">Pending:</span>{" "}
                            {pending.requestType === "change" ? "Agent change · " : ""}
                            {pending.planName || "Custom"}{" "}
                            · {money(pending.quotedPrice, currency)} / {pending.billingCycle}. Awaiting Super
                            Admin.
                        </div>
                    )}

                    {/* Named packages */}
                    <section className="space-y-4">
                        <div>
                            <h2 className="text-base font-bold text-slate-900">Packages</h2>
                            <p className="text-sm text-slate-500 mt-0.5">
                                Pick a ready-made plan and request activation.
                            </p>
                        </div>

                        {plans.length === 0 ? (
                            <EmptyState
                                icon={<Check size={20} />}
                                title="No packages yet"
                                description="You can still build a custom package below."
                            />
                        ) : (
                            <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
                                {plans.map((p) => {
                                    const isCurrent = isCurrentPlan(p);
                                    return (
                                    <div
                                        key={p.planId}
                                        className={`rounded-2xl border bg-white p-5 flex flex-col ${
                                            isCurrent
                                                ? "border-[rgba(56,182,255,0.4)] ring-1 ring-[rgba(56,182,255,0.2)]"
                                                : "border-slate-200"
                                        }`}
                                    >
                                        <div className="flex items-start justify-between gap-2">
                                            <h3 className="font-semibold text-slate-900">{p.name}</h3>
                                            <span className="text-[10px] uppercase tracking-wide text-slate-400 shrink-0">
                                                {p.billingCycle}
                                            </span>
                                        </div>
                                        <p className="mt-3 text-2xl font-bold text-slate-900 tracking-tight">
                                            {money(p.price, currency)}
                                            <span className="text-sm font-normal text-slate-400">
                                                /{p.billingCycle === "yearly" ? "yr" : "mo"}
                                            </span>
                                        </p>
                                        <p className="mt-3 text-sm text-slate-500 leading-relaxed">
                                            {p.storageGb} GB storage
                                        </p>
                                        <p className="mt-1 text-xs text-slate-400 leading-relaxed flex-1">
                                            {p.agentIds.map(agentLabel).join(" · ")}
                                        </p>
                                        {p.description && (
                                            <p className="mt-2 text-xs text-slate-400 line-clamp-2">
                                                {p.description}
                                            </p>
                                        )}
                                        {isCurrent ? (
                                            <p className="mt-5 w-full text-center py-2.5 text-sm font-medium text-(--vb-blue-dark)">
                                                Current plan
                                            </p>
                                        ) : (
                                            <button
                                                type="button"
                                                disabled={sending || !!pending}
                                                onClick={() => requestNamedPlan(p)}
                                                className="mt-5 w-full rounded-xl border border-slate-200 py-2.5 text-sm font-medium text-slate-700 hover:border-[rgba(56,182,255,0.4)] hover:text-(--vb-blue-dark) transition-colors disabled:opacity-40"
                                            >
                                                Request
                                            </button>
                                        )}
                                    </div>
                                    );
                                })}
                            </div>
                        )}
                    </section>

                    {/* Custom builder */}
                    <section className="rounded-2xl border border-slate-200 bg-white overflow-hidden">
                        <div className="px-6 py-5 border-b border-slate-100">
                            <h2 className="text-base font-bold text-slate-900">Build your own</h2>
                            <p className="text-sm text-slate-500 mt-0.5">
                                Select agents and storage. Estimated price updates live.
                            </p>
                        </div>

                        <div className="p-6 space-y-6">
                            <div className="inline-flex rounded-lg bg-slate-100 p-0.5">
                                {(["monthly", "yearly"] as const).map((c) => (
                                    <button
                                        key={c}
                                        type="button"
                                        onClick={() => setCycle(c)}
                                        className={`px-4 py-1.5 rounded-md text-xs font-semibold capitalize transition-colors ${
                                            cycle === c
                                                ? "bg-white text-slate-900 shadow-sm"
                                                : "text-slate-500"
                                        }`}
                                    >
                                        {c}
                                    </button>
                                ))}
                            </div>

                            <div>
                                <p className="text-xs font-semibold text-slate-500 mb-3">Agents</p>
                                <div className="grid sm:grid-cols-2 gap-2">
                                    {agentRows.map((row) => {
                                        const id = row.agentId;
                                        const on = selectedAgents.includes(id);
                                        const price =
                                            cycle === "yearly" ? row.yearlyPrice : row.monthlyPrice;
                                        return (
                                            <button
                                                key={id}
                                                type="button"
                                                onClick={() =>
                                                    setSelectedAgents((prev) =>
                                                        on
                                                            ? prev.filter((x) => x !== id)
                                                            : [...prev, id]
                                                    )
                                                }
                                                className={`flex items-center justify-between gap-3 rounded-xl border px-3.5 py-3 text-left transition-colors ${
                                                    on
                                                        ? "border-[rgba(56,182,255,0.4)] bg-[rgba(56,182,255,0.06)]"
                                                        : "border-slate-200 bg-white hover:border-slate-300"
                                                }`}
                                            >
                                                <span className="flex items-center gap-2 min-w-0">
                                                    <span
                                                        className={`h-4 w-4 rounded border flex items-center justify-center shrink-0 ${
                                                            on
                                                                ? "bg-(--vb-blue) border-(--vb-blue) text-(--vb-color-primary-btn-fg)"
                                                                : "border-slate-300"
                                                        }`}
                                                    >
                                                        {on && <Check size={10} strokeWidth={3} />}
                                                    </span>
                                                    <span className="text-sm font-medium text-slate-800 truncate">
                                                        {agentLabel(id)}
                                                    </span>
                                                </span>
                                                <span className="text-xs text-slate-400 shrink-0">
                                                    {money(price, currency)}
                                                </span>
                                            </button>
                                        );
                                    })}
                                </div>
                            </div>

                            <div className="grid sm:grid-cols-2 gap-4">
                                <label className="block">
                                    <span className="text-xs font-semibold text-slate-500">Storage (GB)</span>
                                    <input
                                        type="number"
                                        min={1}
                                        value={storageGb}
                                        onChange={(e) =>
                                            setStorageGb(Math.max(0, Number(e.target.value)))
                                        }
                                        className="mt-1.5 w-full premium-input rounded-xl px-3.5 py-2.5 text-sm"
                                    />
                                </label>
                                <label className="block">
                                    <span className="text-xs font-semibold text-slate-500">
                                        Note (optional)
                                    </span>
                                    <input
                                        type="text"
                                        value={message}
                                        onChange={(e) => setMessage(e.target.value)}
                                        placeholder="Message for Super Admin"
                                        className="mt-1.5 w-full premium-input rounded-xl px-3.5 py-2.5 text-sm"
                                    />
                                </label>
                            </div>

                            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pt-4 border-t border-slate-100">
                                <div>
                                    <p className="text-xs text-slate-400">Estimated total</p>
                                    <p className="text-2xl font-bold text-slate-900 tracking-tight">
                                        {money(estimate, currency)}
                                        <span className="text-sm font-normal text-slate-400 ml-1">
                                            / {cycle === "yearly" ? "year" : "month"}
                                        </span>
                                    </p>
                                </div>
                                <button
                                    type="button"
                                    disabled={sending || !!pending}
                                    onClick={requestCustom}
                                    className="btn-gradient rounded-xl px-5 py-2.5 text-sm inline-flex items-center justify-center gap-2 disabled:opacity-40"
                                >
                                    {sending ? (
                                        <Loader2 size={14} className="animate-spin" />
                                    ) : (
                                        <Send size={14} />
                                    )}
                                    Request custom package
                                </button>
                            </div>
                        </div>
                    </section>

                    {/* Request history */}
                    {requests.length > 0 && (
                        <section className="space-y-3">
                            <h2 className="text-base font-bold text-slate-900">Your requests</h2>
                            <div className="rounded-2xl border border-slate-200 bg-white divide-y divide-slate-100">
                                {requests.map((r) => (
                                    <div
                                        key={r.requestId}
                                        className="px-5 py-3.5 flex items-center justify-between gap-3"
                                    >
                                        <div className="min-w-0">
                                            <p className="text-sm font-medium text-slate-800 truncate">
                                                {r.requestType === "change" ? "Agent change · " : ""}
                                                {r.planName || "Custom"} ·{" "}
                                                {money(r.quotedPrice, currency)}
                                            </p>
                                            <p className="text-xs text-slate-400 mt-0.5 truncate">
                                                {r.requestType === "change" &&
                                                r.previousAgentIds?.length
                                                    ? `From: ${r.previousAgentIds
                                                          .map(agentLabel)
                                                          .join(", ")} → `
                                                    : ""}
                                                {r.storageGb} GB · {r.billingCycle}
                                                {r.createdAt
                                                    ? ` · ${new Date(r.createdAt).toLocaleDateString()}`
                                                    : ""}
                                            </p>
                                        </div>
                                        <Badge variant={statusVariant(r.status)}>{r.status}</Badge>
                                    </div>
                                ))}
                            </div>
                        </section>
                    )}
                </>
            )}
        </div>
    );
}
