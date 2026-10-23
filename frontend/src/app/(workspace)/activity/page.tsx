"use client";

import React, { useCallback, useEffect, useMemo, useState } from "react";
import { motion } from "framer-motion";
import { Activity, RefreshCw, Search, FileText, MessageSquare, Users, Shield, LogIn, AlertCircle, X } from "lucide-react";
import { PageHeader, EmptyState } from "@/components/ui";
import { useTheme } from "@/context/ColorContext";
import { usePermissions } from "@/context/PermissionsContext";
import { getStoredUser } from "@/lib/authSession";
import { apiRequest } from "@/lib/apiClient";

type ActivityItem = {
    logId: string; actorUserId: string; actorRole: string; actorEmail?: string; actorName?: string;
    organizationId?: string | null; action: string; category: string; resourceType?: string;
    resourceId?: string; outcome: "success" | "failure"; message?: string;
    metadata?: Record<string, unknown>; createdAt: string;
};

type ActorOption = { userId: string; fullName?: string; email?: string; role?: string };

const CATEGORIES = [
    { value: "auth", label: "Auth", accent: "blue", icon: LogIn },
    { value: "document", label: "Documents", accent: "cyan", icon: FileText },
    { value: "chat", label: "Chat", accent: "violet", icon: MessageSquare },
    { value: "team", label: "Team", accent: "amber", icon: Users },
];

type ActivityCache = { logs: ActivityItem[]; total: number; actors: ActorOption[]; at: number };
let activityCache: ActivityCache | null = null;
const ACTIVITY_CACHE_MS = 30_000;

function ActivityContent() {
    const { theme } = useTheme();
    const colors = theme.colors;
    const { role: permRole } = usePermissions();
    const stored = getStoredUser<{ role?: string; fullName?: string }>();
    const role = permRole || stored?.role || "team";

    const [logs, setLogs] = useState<ActivityItem[]>([]);
    const [total, setTotal] = useState(0);
    const [page, setPage] = useState(1);
    const [limit] = useState(30);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [category, setCategory] = useState("");
    const [actorUserId, setActorUserId] = useState("");
    const [q, setQ] = useState("");
    const [searchInput, setSearchInput] = useState("");
    const [actors, setActors] = useState<ActorOption[]>([]);

    const totalPages = Math.max(1, Math.ceil(total / limit));
    const canFilterActors = role === "admin" || role === "superAdmin" || actors.length > 1;

    const load = useCallback(async (opts?: { silent?: boolean; force?: boolean }) => {
        const isDefaultView = !category && !actorUserId && !q && page === 1;
        const fresh = !opts?.force && activityCache && Date.now() - activityCache.at < ACTIVITY_CACHE_MS;
        if (!opts?.silent) setLoading(!(isDefaultView && fresh));
        setError(null);
        if (isDefaultView && fresh && activityCache) {
            setLogs(activityCache.logs);
            setTotal(activityCache.total);
            setActors(activityCache.actors);
            return;
        }
        try {
            const params = new URLSearchParams({ page: String(page), limit: String(limit) });
            if (category) params.set("category", category);
            if (actorUserId) params.set("actorUserId", actorUserId);
            if (q) params.set("q", q);
            const data = await apiRequest(`/docs/activity?${params.toString()}`);
            setLogs(data?.data?.logs || []);
            setTotal(data?.data?.total || 0);
            if (isDefaultView) {
                activityCache = {
                    logs: data?.data?.logs || [],
                    total: data?.data?.total || 0,
                    actors: activityCache?.actors || [],
                    at: Date.now(),
                };
            }
        } catch (e: any) { setError(e.message || "Failed to load activity"); setLogs([]); }
        finally { setLoading(false); }
    }, [page, limit, category, actorUserId, q]);

    const loadActors = useCallback(async () => {
        try {
            const prev = activityCache;
            if (prev) {
                setActors(prev.actors);
                return;
            }
            const data = await apiRequest("/docs/activity/actors");
            setActors(data?.data?.actors || []);
            activityCache = { logs: [], total: 0, actors: data?.data?.actors || [], at: Date.now() };
        } catch { setActors([]); }
    }, []);

    useEffect(() => { load(); }, [load]);
    useEffect(() => { loadActors(); }, [loadActors]);
    const applySearch = () => { setPage(1); setQ(searchInput.trim()); };
    const subtitle = useMemo(() => {
        if (role === "superAdmin") return "Your activity, all admins, and their team members";
        if (role === "admin") return "Your activity and your team members";
        if (actors.length > 1) return "Your activity and lower-rank department members you supervise";
        return "Your own activity only";
    }, [role, actors.length]);
    const hasFilter = category || actorUserId || q;

    return (
        <div className="p-4 sm:p-6 lg:p-8 max-w-5xl mx-auto space-y-5">
            <motion.div initial={{ opacity: 0, y: -10 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.4 }}>
                <PageHeader title="Activity" subtitle={subtitle}
                    actions={<button type="button" onClick={() => load({ force: true })} className="btn-secondary rounded-xl px-4 py-2.5 text-sm inline-flex items-center gap-2"><RefreshCw size={14} className={loading ? "animate-spin" : ""} /> Refresh</button>}
                />
            </motion.div>

            {/* Category Cards */}
            <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.1 }}
                className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                {CATEGORIES.map((cat, i) => {
                    const count = logs.filter((l) => l.category === cat.value).length;
                    const active = category === cat.value;
                    return (
                        <motion.button
                            key={cat.value}
                            initial={{ opacity: 0, y: 10 }}
                            animate={{ opacity: 1, y: 0 }}
                            transition={{ delay: 0.1 + i * 0.04 }}
                            type="button" onClick={() => { setCategory(category === cat.value ? "" : cat.value); setPage(1); }}
                            className={`stat-card ${cat.accent} p-4 text-left ${active ? "ring-2 ring-(--vb-blue) ring-offset-2" : ""}`}
                        >
                            <div className="flex items-center gap-3 mb-2.5">
                                <div className={`icon-box ${cat.accent}`} style={{ width: '2.25rem', height: '2.25rem' }}>
                                    <cat.icon size={14} />
                                </div>
                                <span className="text-xs font-semibold text-slate-500 uppercase tracking-wider">{cat.label}</span>
                            </div>
                            <p className="text-2xl font-bold text-slate-800">{count}</p>
                        </motion.button>
                    );
                })}
            </motion.div>

            {/* Search & Filters */}
            <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.15 }}
                className="surface-card overflow-hidden">
                <div className="px-5 py-4 border-b border-slate-100 bg-linear-to-r from-slate-50/50 to-transparent">
                    <div className="flex flex-col sm:flex-row gap-3 items-stretch sm:items-center">
                        <div className="relative flex-1 min-w-0">
                            <Search size={16} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-400" />
                            <input
                                value={searchInput}
                                onChange={(e) => setSearchInput(e.target.value)}
                                onKeyDown={(e) => e.key === "Enter" && applySearch()}
                                placeholder="Search by message, email, action..."
                                className="w-full premium-input rounded-xl py-2.5 pl-10 pr-4 text-sm h-11"
                            />
                        </div>
                        {canFilterActors && (
                            <select value={actorUserId} onChange={(e) => { setActorUserId(e.target.value); setPage(1); }}
                                className="premium-input rounded-xl py-2.5 px-3 text-sm h-11 w-full sm:w-auto sm:min-w-45">
                                <option value="">Everyone</option>
                                {actors.map((a) => <option key={a.userId} value={a.userId}>{a.fullName || a.email} ({a.role})</option>)}
                            </select>
                        )}
                        <button type="button" onClick={applySearch} className="btn-gradient rounded-xl px-5 py-2.5 text-sm h-11 shrink-0 sm:w-auto w-full">
                            Search
                        </button>
                    </div>
                    {hasFilter && (
                        <div className="flex flex-wrap items-center gap-2 mt-3 pt-3 border-t border-slate-100">
                            {category && (
                                <span className="inline-flex items-center gap-1.5 rounded-full border border-[rgba(56,182,255,0.28)] bg-[rgba(56,182,255,0.1)] px-3 py-1 text-[11px] font-medium text-(--vb-blue-dark)">
                                    {CATEGORIES.find((c) => c.value === category)?.label}
                                    <button type="button" onClick={() => { setCategory(""); setPage(1); }} className="hover:text-(--vb-blue-dark)"><X size={11} /></button>
                                </span>
                            )}
                            {q && (
                                <span className="inline-flex items-center gap-1.5 rounded-full border border-slate-200 bg-slate-50 px-3 py-1 text-[11px] font-medium text-slate-600">
                                    &quot;{q}&quot;
                                    <button type="button" onClick={() => { setSearchInput(""); setQ(""); setPage(1); }} className="hover:text-slate-900"><X size={11} /></button>
                                </span>
                            )}
                            {actorUserId && (
                                <span className="inline-flex items-center gap-1.5 rounded-full border border-violet-200 bg-violet-50 px-3 py-1 text-[11px] font-medium text-violet-700">
                                    {actors.find((a) => a.userId === actorUserId)?.fullName || "User"}
                                    <button type="button" onClick={() => { setActorUserId(""); setPage(1); }} className="hover:text-violet-900"><X size={11} /></button>
                                </span>
                            )}
                            <button type="button" onClick={() => { setCategory(""); setActorUserId(""); setSearchInput(""); setQ(""); setPage(1); }}
                                className="text-[11px] text-slate-400 hover:text-(--vb-blue-dark) underline-offset-2 hover:underline ml-1">
                                Clear all
                            </button>
                        </div>
                    )}
                </div>

                {error && <div className="px-5 py-3 text-sm text-rose-600 flex items-center gap-2"><AlertCircle size={14} /> {error}</div>}

                {loading ? (
                    <div className="p-8 text-center">
                        <div className="w-10 h-10 rounded-xl bg-slate-100 animate-pulse mx-auto mb-3" />
                        <p className="text-sm text-slate-400">Loading activity...</p>
                    </div>
                ) : logs.length === 0 ? (
                    <div className="p-8"><EmptyState icon={<Activity size={28} className="text-(--vb-blue-dark)" />} title="No activity yet" description="Actions like login, uploads, chat, and team changes will appear here." /></div>
                ) : (
                    <ul className="divide-y divide-slate-100">
                        {logs.map((log) => {
                            const cat = CATEGORIES.find((c) => c.value === log.category) || CATEGORIES[0];
                            const failed = log.outcome === "failure";
                            return (
                                <li key={log.logId} className="px-5 py-4 flex items-start gap-3.5 hover:bg-slate-50/50 transition-colors">
                                    <div className={`w-10 h-10 rounded-xl flex items-center justify-center shrink-0 ${
                                        failed
                                            ? "bg-linear-to-br from-rose-50 to-red-50 text-rose-500"
                                            : `bg-linear-to-br from-${cat.accent}-50 to-${cat.accent}-50/50 text-${cat.accent}-600`
                                    }`}
                                    style={!failed ? {
                                        background: `linear-gradient(135deg, var(--tw-gradient-from, #f0fdfa), var(--tw-gradient-to, #ecfeff))`,
                                    } : undefined}
                                    >
                                        <cat.icon size={18} />
                                    </div>
                                    <div className="min-w-0 flex-1 space-y-1">
                                        <div className="flex flex-wrap items-center gap-2">
                                            <p className="text-sm font-semibold text-slate-800">{log.message || log.action}</p>
                                            {failed && (
                                                <span className="text-[9px] uppercase font-bold tracking-wider px-2 py-0.5 rounded-full bg-linear-to-r from-rose-500 to-red-500 text-white">
                                                    Failed
                                                </span>
                                            )}
                                        </div>
                                        <p className="text-xs text-slate-500 wrap-break-word">
                                            <span className="font-semibold text-slate-700">{log.actorName || log.actorEmail || log.actorUserId}</span>
                                            <span className="mx-1.5 text-slate-300">&middot;</span>
                                            <span className="uppercase tracking-wide font-medium text-slate-400">{log.actorRole}</span>
                                        </p>
                                        <p className="text-[11px] text-slate-400">
                                            {log.createdAt ? new Date(log.createdAt).toLocaleString() : ""}
                                        </p>
                                    </div>
                                </li>
                            );
                        })}
                    </ul>
                )}

                {total > limit && (
                    <div className="px-5 py-3.5 border-t border-slate-100 flex flex-wrap items-center justify-between gap-2 text-sm text-slate-500">
                        <span className="text-xs">Page {page} of {totalPages} &middot; {total} events</span>
                        <div className="flex gap-2">
                            <button type="button" disabled={page <= 1} onClick={() => setPage((p) => Math.max(1, p - 1))} className="btn-secondary rounded-lg px-3.5 py-2 text-xs disabled:opacity-40">Previous</button>
                            <button type="button" disabled={page >= totalPages} onClick={() => setPage((p) => Math.min(totalPages, p + 1))} className="btn-secondary rounded-lg px-3.5 py-2 text-xs disabled:opacity-40">Next</button>
                        </div>
                    </div>
                )}
            </motion.div>
        </div>
    );
}

export default function ActivityPage() {
    return (
        <ActivityContent />
    );
}
