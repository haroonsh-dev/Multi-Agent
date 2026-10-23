"use client";

import React, { useCallback, useEffect, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { AlertTriangle, Loader2, Plus, RefreshCw, UserCheck, UserX, Shield, Trash2, Users } from "lucide-react";
import { useToast } from "@/components/Toast";
import { PageHeader } from "@/components/ui";
import { useTheme } from "@/context/ColorContext";
import { apiRequest } from "@/lib/apiClient";
import { enrichUserFromToken } from "@/lib/auth";
import { getAuthValue, getStoredUser } from "@/lib/authSession";
import { DEFAULT_TEAM_PERMS, TEAM_PERM_LABELS } from "@/lib/permissions";

type Member = {
    userId: string;
    fullName: string;
    email: string;
    status: string;
    permissions?: Record<string, boolean>;
};

function TeamContent() {
    const { theme } = useTheme();
    const colors = theme.colors;
    const { showToast } = useToast();
    const [members, setMembers] = useState<Member[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [success, setSuccess] = useState<string | null>(null);
    const [showForm, setShowForm] = useState(false);
    const [creating, setCreating] = useState(false);
    const [form, setForm] = useState({ fullName: "", email: "", password: "" });
    const [editingPerms, setEditingPerms] = useState<string | null>(null);
    const [permDraft, setPermDraft] = useState<Record<string, boolean> | null>(null);
    const [savingPerms, setSavingPerms] = useState(false);
    const [hasOrganization, setHasOrganization] = useState(true);

    const load = useCallback(async () => {
        setLoading(true);
        try {
            const data = await apiRequest("/docs/team/members");
            setMembers(data?.data?.members || []);
            setError(null);
        } catch (e: any) {
            setError(e.message);
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        const token = getAuthValue("accessToken") || getAuthValue("token");
        const stored = getStoredUser<any>();
        const user = enrichUserFromToken(stored, token);
        setHasOrganization(!!user?.organizationId);

        (async () => {
            try {
                const me = await apiRequest("/auth/me");
                const orgId = me?.data?.user?.organizationId;
                if (orgId !== undefined) setHasOrganization(!!orgId);
            } catch {
                // keep stored-user fallback
            }
        })();
    }, []);

    useEffect(() => { load(); }, [load]);

    const createMember = async (e: React.FormEvent) => {
        e.preventDefault();
        setCreating(true);
        setError(null);
        setSuccess(null);
        try {
            const data = await apiRequest("/docs/team/members", { method: "POST", body: JSON.stringify(form) });
            setForm({ fullName: "", email: "", password: "" });
            setShowForm(false);
            const msg = data?.message
                || (data?.data?.openRemoteSynced
                    ? "Member created in OpenRemote and database"
                    : "Member created in database only (OpenRemote unavailable)");
            setSuccess(msg);
            showToast(msg, "success");
            await load();
        } catch (e: any) {
            const msg = e.message || "Failed to create team member";
            setError(msg);
            showToast(msg, "error");
        } finally {
            setCreating(false);
        }
    };

    const toggleStatus = async (userId: string, status: string) => {
        const next = status === "active" ? "blocked" : "active";
        await apiRequest(`/docs/team/members/${userId}/status`, { method: "PATCH", body: JSON.stringify({ status: next }) });
        await load();
    };

    const openPermissions = (m: Member) => {
        if (editingPerms === m.userId) {
            setEditingPerms(null);
            setPermDraft(null);
            return;
        }
        const draft: Record<string, boolean> = {};
        for (const { key } of TEAM_PERM_LABELS) {
            draft[key] =
                typeof m.permissions?.[key] === "boolean"
                    ? m.permissions[key]
                    : (DEFAULT_TEAM_PERMS[key] ?? true);
        }
        setPermDraft(draft);
        setEditingPerms(m.userId);
    };

    const savePermissions = async (userId: string) => {
        if (!permDraft) return;
        setSavingPerms(true);
        setError(null);
        try {
            const data = await apiRequest(`/docs/team/members/${userId}/permissions`, {
                method: "PATCH",
                body: JSON.stringify({ permissions: permDraft }),
            });
            const updated = data?.data?.member;
            if (updated) {
                setMembers((prev) =>
                    prev.map((m) => (m.userId === userId ? { ...m, permissions: updated.permissions } : m))
                );
            }
            setSuccess("Permissions saved.");
            showToast("Permissions saved", "success");
            setEditingPerms(null);
            setPermDraft(null);
        } catch (e: any) {
            const msg = e.message || "Failed to save permissions";
            setError(msg);
            showToast(msg, "error");
        } finally {
            setSavingPerms(false);
        }
    };

    const removeMember = async (userId: string) => {
        if (!confirm("Remove this team member?")) return;
        await apiRequest(`/docs/team/members/${userId}`, { method: "DELETE" });
        await load();
    };

    return (
        <div className="p-4 sm:p-6 lg:p-8 max-w-5xl mx-auto space-y-6">
            <motion.div initial={{ opacity: 0, y: -10 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.4 }}>
                <PageHeader
                    title="Team"
                    subtitle="Add members and set permissions"
                    actions={
                        <div className="flex gap-2">
                            <button type="button" onClick={load} className="btn-secondary rounded-xl px-4 py-2.5 text-sm inline-flex items-center gap-2">
                                <RefreshCw size={14} /> Refresh
                            </button>
                            <button type="button" onClick={() => setShowForm(!showForm)} className="btn-gradient rounded-xl px-4 py-2.5 text-sm inline-flex items-center gap-2 disabled:opacity-50" disabled={!hasOrganization}>
                                <Plus size={14} /> Add member
                            </button>
                        </div>
                    }
                />
            </motion.div>

            {!hasOrganization && (
                <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }}
                    className="rounded-2xl border border-amber-200 bg-linear-to-r from-amber-50 to-orange-50 text-amber-700 px-5 py-4 text-sm flex items-start gap-3">
                    <div className="w-8 h-8 rounded-lg bg-amber-100 flex items-center justify-center shrink-0"><AlertTriangle size={16} className="text-amber-600" /></div>
                    <div>
                        <p className="font-medium">No organization linked to this admin account</p>
                        <p className="text-amber-600/80 mt-1">Team members cannot be created until an organization is assigned. Run the seed script or contact a super admin.</p>
                    </div>
                </motion.div>
            )}

            {error && (
                <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }}
                    className="rounded-2xl border border-rose-200 bg-linear-to-r from-rose-50 to-red-50 text-rose-700 px-5 py-4 text-sm flex items-center gap-3">
                    <div className="w-8 h-8 rounded-lg bg-rose-100 flex items-center justify-center shrink-0"><AlertTriangle size={16} className="text-rose-600" /></div>
                    {error}
                </motion.div>
            )}
            {success && (
                <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }}
                    className="rounded-2xl border border-emerald-200 bg-linear-to-r from-emerald-50 to-green-50 text-emerald-700 px-5 py-4 text-sm flex items-center gap-3">
                    <div className="w-8 h-8 rounded-lg bg-emerald-100 flex items-center justify-center shrink-0"><span className="text-emerald-600 text-lg">✓</span></div>
                    {success}
                </motion.div>
            )}

            {/* Create Member Form */}
            <AnimatePresence>
                {showForm && hasOrganization && (
                    <motion.div
                        initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }}
                        exit={{ opacity: 0, height: 0 }} className="overflow-hidden"
                    >
                        <form onSubmit={createMember} className="surface-card p-6 space-y-4">
                            <div className="flex items-center gap-3 mb-2">
                                <div className="w-10 h-10 rounded-xl bg-(--vb-blue) text-(--vb-color-primary-btn-fg) flex items-center justify-center shadow-(--vb-glow)">
                                    <Plus size={18} />
                                </div>
                                <div>
                                    <h3 className="text-sm font-bold text-slate-800">New Team Member</h3>
                                    <p className="text-[11px] text-slate-400">Create a new account for your team</p>
                                </div>
                            </div>
                            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                                <div className="flex flex-col gap-1.5">
                                    <span className="text-[10px] font-semibold uppercase tracking-wider text-slate-400 ml-0.5">Full Name</span>
                                    <input className="premium-input rounded-xl px-4 py-3 text-sm h-11" placeholder="Jane Doe" value={form.fullName} onChange={(e) => setForm({ ...form, fullName: e.target.value })} autoComplete="name" required />
                                </div>
                                <div className="flex flex-col gap-1.5">
                                    <span className="text-[10px] font-semibold uppercase tracking-wider text-slate-400 ml-0.5">Email</span>
                                    <input className="premium-input rounded-xl px-4 py-3 text-sm h-11" placeholder="member@company.com" type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} autoComplete="off" required />
                                </div>
                                <div className="flex flex-col gap-1.5">
                                    <span className="text-[10px] font-semibold uppercase tracking-wider text-slate-400 ml-0.5">Password</span>
                                    <input className="premium-input rounded-xl px-4 py-3 text-sm h-11" placeholder="Temporary password" type="password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} autoComplete="new-password" required />
                                </div>
                            </div>
                            <div className="flex justify-end gap-2 pt-1">
                                <button type="button" onClick={() => setShowForm(false)} className="btn-secondary rounded-xl px-4 py-2.5 text-sm">Cancel</button>
                                <button type="submit" disabled={creating} className="btn-gradient rounded-xl px-5 py-2.5 text-sm inline-flex items-center gap-2 disabled:opacity-50">
                                    {creating && <Loader2 size={14} className="animate-spin" />}
                                    {creating ? "Creating..." : "Create Member"}
                                </button>
                            </div>
                        </form>
                    </motion.div>
                )}
            </AnimatePresence>

            {/* Members List */}
            <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.1 }}
                className="surface-card overflow-hidden">
                <div className="px-5 py-4 border-b border-slate-100 bg-linear-to-r from-slate-50/50 to-transparent">
                    <div className="flex items-center gap-3">
                        <div className="w-9 h-9 rounded-xl bg-linear-to-br from-violet-500 to-purple-500 flex items-center justify-center shadow-lg shadow-violet-500/20">
                            <Users size={16} className="text-white" />
                        </div>
                        <div>
                            <h3 className="text-sm font-bold text-slate-800">Team Members</h3>
                            <p className="text-[11px] text-slate-400">{members.length} member{members.length !== 1 ? "s" : ""}</p>
                        </div>
                    </div>
                </div>

                {loading ? (
                    <div className="p-8 text-sm text-slate-500 text-center">Loading team members...</div>
                ) : members.length === 0 ? (
                    <div className="p-12 text-center">
                        <div className="w-16 h-16 rounded-2xl bg-slate-50 flex items-center justify-center mx-auto mb-3">
                            <Users size={28} className="text-slate-300" />
                        </div>
                        <p className="text-sm font-medium text-slate-500">No team members yet</p>
                        <p className="text-xs text-slate-400 mt-1">Click &quot;Add member&quot; to get started</p>
                    </div>
                ) : (
                    <ul className="divide-y divide-slate-100">
                        {members.map((m, i) => (
                            <motion.li
                                key={m.userId}
                                initial={{ opacity: 0, y: 5 }}
                                animate={{ opacity: 1, y: 0 }}
                                transition={{ delay: 0.05 + i * 0.03 }}
                                className="p-5 hover:bg-slate-50/50 transition-colors"
                            >
                                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                                    <div className="flex items-center gap-3 min-w-0">
                                        <div className={`w-10 h-10 rounded-xl flex items-center justify-center shrink-0 text-sm font-bold ${
                                            m.status === "active"
                                                ? "bg-linear-to-br from-[rgba(56,182,255,0.08)] to-[rgba(63,116,255,0.06)] text-(--vb-blue-dark) border border-[rgba(56,182,255,0.28)]"
                                                : "bg-linear-to-br from-slate-50 to-slate-100 text-slate-400 border border-slate-200"
                                        }`}>
                                            {(m.fullName || m.email || "U").split(" ").map((w) => w[0]).join("").slice(0, 2).toUpperCase()}
                                        </div>
                                        <div className="min-w-0">
                                            <p className="font-semibold text-slate-800 truncate">{m.fullName}</p>
                                            <p className="text-sm text-slate-500 truncate">{m.email}</p>
                                        </div>
                                    </div>
                                    <div className="flex items-center gap-2 flex-wrap">
                                        <span className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-[10px] font-semibold uppercase border ${
                                            m.status === "active"
                                                ? "bg-emerald-50 text-emerald-700 border-emerald-200"
                                                : "bg-rose-50 text-rose-700 border-rose-200"
                                        }`}>
                                            {m.status === "active" ? "Active" : "Blocked"}
                                        </span>
                                        <button type="button" onClick={() => toggleStatus(m.userId, m.status)}
                                            className="btn-secondary rounded-lg px-3 py-2 text-sm min-h-10 inline-flex items-center gap-1.5">
                                            {m.status === "active" ? <><UserX size={13} /> Block</> : <><UserCheck size={13} /> Activate</>}
                                        </button>
                                        <button type="button" onClick={() => openPermissions(m)}
                                            className="btn-secondary rounded-lg px-3 py-2 text-sm min-h-10 inline-flex items-center gap-1.5">
                                            <Shield size={13} /> Permissions
                                        </button>
                                        <button type="button" onClick={() => removeMember(m.userId)}
                                            className="btn-ghost rounded-lg px-3 py-2 text-sm min-h-10 text-rose-500 inline-flex items-center gap-1.5 hover:bg-rose-50">
                                            <Trash2 size={13} /> Remove
                                        </button>
                                    </div>
                                </div>

                                <AnimatePresence>
                                    {editingPerms === m.userId && permDraft && (
                                        <motion.div
                                            initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }}
                                            exit={{ opacity: 0, height: 0 }} className="overflow-hidden"
                                        >
                                            <div className="rounded-2xl border border-slate-200 bg-slate-50/50 p-5 mt-4 space-y-4">
                                                <p className="text-xs text-slate-500">
                                                    Toggle permissions below, then click Save. Unchecked features are hidden for that team member.
                                                </p>
                                                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                                                    {TEAM_PERM_LABELS.map(({ key, label, hint }) => (
                                                        <label
                                                            key={key}
                                                            className="flex items-start gap-2.5 rounded-xl px-3.5 py-3 border border-slate-200 bg-white cursor-pointer hover:border-[rgba(56,182,255,0.4)] hover:bg-[rgba(56,182,255,0.03)] transition-all"
                                                        >
                                                            <input
                                                                type="checkbox"
                                                                className="mt-0.5 accent-[var(--vb-blue)]"
                                                                checked={permDraft[key] ?? false}
                                                                onChange={(e) =>
                                                                    setPermDraft((prev) =>
                                                                        prev ? { ...prev, [key]: e.target.checked } : prev
                                                                    )
                                                                }
                                                            />
                                                            <span>
                                                                <span className="block text-sm font-medium text-slate-800">{label}</span>
                                                                {hint && <span className="block text-[11px] text-slate-400 mt-0.5">{hint}</span>}
                                                            </span>
                                                        </label>
                                                    ))}
                                                </div>
                                                <div className="flex gap-2 pt-1">
                                                    <button
                                                        type="button"
                                                        disabled={savingPerms}
                                                        onClick={() => savePermissions(m.userId)}
                                                        className="btn-gradient rounded-xl px-5 py-2.5 text-sm inline-flex items-center gap-2 disabled:opacity-50"
                                                    >
                                                        {savingPerms && <Loader2 size={14} className="animate-spin" />}
                                                        {savingPerms ? "Saving..." : "Save Permissions"}
                                                    </button>
                                                    <button
                                                        type="button"
                                                        disabled={savingPerms}
                                                        onClick={() => { setEditingPerms(null); setPermDraft(null); }}
                                                        className="btn-secondary rounded-xl px-4 py-2.5 text-sm"
                                                    >
                                                        Cancel
                                                    </button>
                                                </div>
                                            </div>
                                        </motion.div>
                                    )}
                                </AnimatePresence>
                            </motion.li>
                        ))}
                    </ul>
                )}
            </motion.div>
        </div>
    );
}

export default function TeamPage() {
    return <TeamContent />;
}
