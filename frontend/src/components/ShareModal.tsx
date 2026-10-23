"use client";

import React, { useCallback, useEffect, useState } from "react";
import { X, Users, Building2, Globe, Search, Loader2, Share2, Trash2, Shield, UserCheck } from "lucide-react";
import { apiRequest } from "@/lib/apiClient";
import { getStoredUser } from "@/lib/authSession";

type Department = {
    departmentId: string;
    name: string;
    memberCount?: number;
};

type Member = {
    userId: string;
    user?: { fullName?: string; email?: string } | null;
    role?: { name: string; isLeader: boolean } | null;
};

type Share = {
    shareId: string;
    scope: "user" | "department" | "all";
    targetUserIds: string[];
    departmentId?: string | null;
    departmentName?: string | null;
    targetUserNames?: string[];
    visibility?: "leader_only" | "all_members";
    sharedBy: string;
    createdAt: string;
};

type Props = {
    documentId: string;
    filename: string;
    currentDepartmentId?: string;
    open: boolean;
    onClose: () => void;
    onShared: () => void;
};

type ShareMode = "own_dept" | "specific_users" | "other_dept" | "everyone";

export default function ShareModal({ documentId, filename, currentDepartmentId, open, onClose, onShared }: Props) {
    const me = getStoredUser<{ userId?: string; role?: string; orgRole?: { isLeader?: boolean } }>();
    const isAdmin = me?.role === "admin" || me?.role === "superAdmin";
    const isLeader = me?.orgRole?.isLeader || false;
    const isTeam = me?.role === "team";

    const [mode, setMode] = useState<ShareMode | null>(null);
    const [departments, setDepartments] = useState<Department[]>([]);
    const [members, setMembers] = useState<Member[]>([]);
    const [existingShares, setExistingShares] = useState<Share[]>([]);
    const [loading, setLoading] = useState(false);
    const [submitting, setSubmitting] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [success, setSuccess] = useState<string | null>(null);

    // Selection state
    const [selectedDeptId, setSelectedDeptId] = useState<string>("");
    const [selectedUserIds, setSelectedUserIds] = useState<string[]>([]);
    const [userSearch, setUserSearch] = useState("");
    const [visibility, setVisibility] = useState<"leader_only" | "all_members">("all_members");

    const reset = useCallback(() => {
        setMode(null);
        setSelectedDeptId("");
        setSelectedUserIds([]);
        setUserSearch("");
        setVisibility("all_members");
        setError(null);
        setSuccess(null);
    }, []);

    const loadDepartments = useCallback(async () => {
        try {
            const res = await apiRequest("/docs/departments");
            setDepartments(res?.data?.departments || []);
        } catch {
            /* ignore */
        }
    }, []);

    const loadMembers = useCallback(async () => {
        if (!currentDepartmentId) return;
        try {
            const res = await apiRequest(`/docs/departments/${currentDepartmentId}/overview`);
            setMembers(res?.data?.members || []);
        } catch {
            /* ignore */
        }
    }, [currentDepartmentId]);

    const loadShares = useCallback(async () => {
        try {
            const res = await apiRequest(`/docs/documents/${documentId}/shares`);
            setExistingShares(res?.data?.shares || []);
        } catch {
            /* ignore */
        }
    }, [documentId]);

    useEffect(() => {
        if (open) {
            reset();
            loadDepartments();
            loadMembers();
            loadShares();
        }
    }, [open, reset, loadDepartments, loadMembers, loadShares]);

    useEffect(() => {
        if (!open) return;
        const onKeyDown = (e: KeyboardEvent) => {
            if (e.key === "Escape") onClose();
        };
        window.addEventListener("keydown", onKeyDown);
        return () => window.removeEventListener("keydown", onKeyDown);
    }, [open, onClose]);

    const share = async (payload: Record<string, unknown>) => {
        setSubmitting(true);
        setError(null);
        setSuccess(null);
        try {
            await apiRequest(`/docs/documents/${documentId}/share`, {
                method: "POST",
                body: JSON.stringify(payload),
            });
            setSuccess("Document shared successfully!");
            await loadShares();
            onShared();
        } catch (e: any) {
            setError(e.message || "Share failed");
        } finally {
            setSubmitting(false);
        }
    };

    const unshare = async (scope: string, departmentId?: string, targetUserId?: string) => {
        setSubmitting(true);
        setError(null);
        setSuccess(null);
        try {
            const params = new URLSearchParams({ scope });
            if (departmentId) params.set("departmentId", departmentId);
            if (targetUserId) params.set("targetUserId", targetUserId);
            await apiRequest(`/docs/documents/${documentId}/share?${params}`, { method: "DELETE" });
            setSuccess("Share removed!");
            await loadShares();
            onShared();
        } catch (e: any) {
            setError(e.message || "Unshare failed");
        } finally {
            setSubmitting(false);
        }
    };

    const handleShareOwnDept = async () => {
        await share({
            scope: "department",
            departmentId: currentDepartmentId,
            visibility: "all_members",
        });
    };

    const handleShareSpecificUsers = async () => {
        if (selectedUserIds.length === 0) {
            setError("Select at least one person");
            return;
        }
        await share({
            scope: "user",
            targetUserIds: selectedUserIds,
        });
    };

    const handleShareOtherDept = async () => {
        if (!selectedDeptId) {
            setError("Select a department");
            return;
        }
        await share({
            scope: "department",
            departmentId: selectedDeptId,
            visibility,
        });
    };

    const handleShareEveryone = async () => {
        await share({ scope: "all" });
    };

    if (!open) return null;

    const filteredMembers = members.filter((m) => {
        if (!userSearch) return true;
        const name = m.user?.fullName || m.userId;
        const email = m.user?.email || "";
        const q = userSearch.toLowerCase();
        return name.toLowerCase().includes(q) || email.toLowerCase().includes(q);
    });

    const availableDepts = departments.filter((d) => d.departmentId !== currentDepartmentId);

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4" onClick={onClose}>
            <div
                className="w-full max-w-lg surface-card border border-border shadow-2xl flex flex-col max-h-[85vh]"
                onClick={(e) => e.stopPropagation()}
                role="dialog"
                aria-modal="true"
                aria-labelledby="share-modal-title"
            >
                {/* Header */}
                <div className="flex items-center justify-between px-5 py-4 border-b border-border">
                    <div className="flex items-center gap-3 min-w-0">
                        <div className="h-9 w-9 rounded-lg bg-accent-muted text-accent flex items-center justify-center shrink-0">
                            <Share2 size={16} />
                        </div>
                        <div className="min-w-0">
                            <h2 id="share-modal-title" className="text-sm font-bold text-foreground">Share Document</h2>
                            <p className="text-xs text-foreground-muted truncate">{filename}</p>
                        </div>
                    </div>
                    <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-surface-3 transition-colors" aria-label="Close">
                        <X size={16} className="text-foreground-muted" />
                    </button>
                </div>

                {/* Content */}
                <div className="flex-1 overflow-y-auto px-5 py-4 space-y-4">
                    {/* Mode selection (when not in a sub-view) */}
                    {!mode && (
                        <div className="space-y-2">
                            <p className="text-xs font-semibold text-foreground-muted uppercase tracking-wider mb-3">
                                Share with
                            </p>

                            {/* Own department */}
                            {currentDepartmentId && (
                                <button
                                    type="button"
                                    onClick={() => setMode("own_dept")}
                                    className="w-full flex items-center gap-3 p-3 rounded-xl border border-border hover:border-accent hover:bg-accent-muted/30 transition-all text-left group"
                                >
                                    <div className="h-10 w-10 rounded-lg bg-accent-muted text-accent flex items-center justify-center shrink-0 group-hover:scale-105 transition-transform">
                                        <Users size={18} />
                                    </div>
                                    <div>
                                        <p className="text-sm font-semibold text-foreground">My Department</p>
                                        <p className="text-xs text-foreground-muted">Share with all members of your department</p>
                                    </div>
                                </button>
                            )}

                            {/* Specific users */}
                            {currentDepartmentId && (
                                <button
                                    type="button"
                                    onClick={() => setMode("specific_users")}
                                    className="w-full flex items-center gap-3 p-3 rounded-xl border border-border hover:border-accent hover:bg-accent-muted/30 transition-all text-left group"
                                >
                                    <div className="h-10 w-10 rounded-lg bg-blue-500/15 text-blue-300 flex items-center justify-center shrink-0 group-hover:scale-105 transition-transform">
                                        <UserCheck size={18} />
                                    </div>
                                    <div>
                                        <p className="text-sm font-semibold text-foreground">Specific People</p>
                                        <p className="text-xs text-foreground-muted">Choose people in your department</p>
                                    </div>
                                </button>
                            )}

                            {/* Other department */}
                            {(isAdmin || isLeader) && (
                                <button
                                    type="button"
                                    onClick={() => setMode("other_dept")}
                                    className="w-full flex items-center gap-3 p-3 rounded-xl border border-border hover:border-accent hover:bg-accent-muted/30 transition-all text-left group"
                                >
                                    <div className="h-10 w-10 rounded-lg bg-purple-500/15 text-purple-300 flex items-center justify-center shrink-0 group-hover:scale-105 transition-transform">
                                        <Building2 size={18} />
                                    </div>
                                    <div>
                                        <p className="text-sm font-semibold text-foreground">Another Department</p>
                                        <p className="text-xs text-foreground-muted">Share with a different department (leader only by default)</p>
                                    </div>
                                </button>
                            )}

                            {/* Everyone */}
                            {(isAdmin || isLeader) && (
                                <button
                                    type="button"
                                    onClick={() => setMode("everyone")}
                                    className="w-full flex items-center gap-3 p-3 rounded-xl border border-border hover:border-accent hover:bg-accent-muted/30 transition-all text-left group"
                                >
                                    <div className="h-10 w-10 rounded-lg bg-amber-500/15 text-amber-300 flex items-center justify-center shrink-0 group-hover:scale-105 transition-transform">
                                        <Globe size={18} />
                                    </div>
                                    <div>
                                        <p className="text-sm font-semibold text-foreground">Everyone</p>
                                        <p className="text-xs text-foreground-muted">Share with all departments in the organization</p>
                                    </div>
                                </button>
                            )}
                        </div>
                    )}

                    {/* ── Own Department sub-view ── */}
                    {mode === "own_dept" && (
                        <div className="space-y-3">
                            <button onClick={reset} className="text-xs text-accent hover:underline">&larr; Back</button>
                            <div className="rounded-xl border border-border bg-surface-2/60 p-4">
                                <p className="text-sm text-foreground">
                                    This will share the document with <strong>all members</strong> of your department.
                                </p>
                                <p className="text-xs text-foreground-muted mt-1">
                                    Everyone in your department will be able to see this document.
                                </p>
                            </div>
                            <button
                                type="button"
                                onClick={handleShareOwnDept}
                                disabled={submitting}
                                className="w-full btn-gradient rounded-xl py-2.5 text-sm font-semibold flex items-center justify-center gap-2"
                            >
                                {submitting ? <Loader2 size={14} className="animate-spin" /> : <Users size={14} />}
                                Share with My Department
                            </button>
                        </div>
                    )}

                    {/* ── Specific Users sub-view ── */}
                    {mode === "specific_users" && (
                        <div className="space-y-3">
                            <button onClick={reset} className="text-xs text-accent hover:underline">&larr; Back</button>

                            <div className="relative">
                                <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-foreground-muted" />
                                <input
                                    type="text"
                                    value={userSearch}
                                    onChange={(e) => setUserSearch(e.target.value)}
                                    placeholder="Search by name or email..."
                                    className="w-full premium-input rounded-xl pl-9 pr-4 py-2 text-sm"
                                />
                            </div>

                            <div className="max-h-48 overflow-y-auto rounded-xl border border-border divide-y divide-border">
                                {filteredMembers.length === 0 && (
                                    <p className="p-3 text-xs text-foreground-muted">No members found</p>
                                )}
                                {filteredMembers.map((m) => {
                                    const selected = selectedUserIds.includes(m.userId);
                                    return (
                                        <button
                                            key={m.userId}
                                            type="button"
                                            onClick={() => {
                                                setSelectedUserIds((prev) =>
                                                    selected ? prev.filter((id) => id !== m.userId) : [...prev, m.userId]
                                                );
                                            }}
                                            className={`w-full flex items-center gap-3 px-3 py-2.5 text-left transition-colors ${
                                                selected ? "bg-accent-muted/30" : "hover:bg-surface-3"
                                            }`}
                                        >
                                            <div
                                                className={`h-4 w-4 rounded border-2 flex items-center justify-center shrink-0 transition-colors ${
                                                    selected ? "bg-accent border-accent" : "border-border"
                                                }`}
                                            >
                                                {selected && (
                                                    <svg width="10" height="8" viewBox="0 0 10 8" fill="none">
                                                        <path d="M1 4L3.5 6.5L9 1" stroke="#03111d" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                                                    </svg>
                                                )}
                                            </div>
                                            <div className="min-w-0">
                                                <p className="text-sm font-medium text-foreground truncate">{m.user?.fullName || m.userId}</p>
                                                {m.user?.email && <p className="text-xs text-foreground-muted truncate">{m.user.email}</p>}
                                            </div>
                                            {m.role?.isLeader && (
                                                <Shield size={12} className="text-amber-400 shrink-0 ml-auto" />
                                            )}
                                        </button>
                                    );
                                })}
                            </div>

                            {selectedUserIds.length > 0 && (
                                <p className="text-xs text-accent font-medium">{selectedUserIds.length} person(s) selected</p>
                            )}

                            <button
                                type="button"
                                onClick={handleShareSpecificUsers}
                                disabled={submitting || selectedUserIds.length === 0}
                                className="w-full btn-gradient rounded-xl py-2.5 text-sm font-semibold flex items-center justify-center gap-2"
                            >
                                {submitting ? <Loader2 size={14} className="animate-spin" /> : <UserCheck size={14} />}
                                Share with {selectedUserIds.length} Person(s)
                            </button>
                        </div>
                    )}

                    {/* ── Other Department sub-view ── */}
                    {mode === "other_dept" && (
                        <div className="space-y-3">
                            <button onClick={reset} className="text-xs text-accent hover:underline">&larr; Back</button>

                            <div>
                                <label className="text-xs font-semibold text-foreground-muted uppercase tracking-wider block mb-2">
                                    Select Department
                                </label>
                                <select
                                    value={selectedDeptId}
                                    onChange={(e) => setSelectedDeptId(e.target.value)}
                                    className="w-full premium-input rounded-xl px-4 py-2.5 text-sm"
                                >
                                    <option value="">Choose a department...</option>
                                    {availableDepts.map((d) => (
                                        <option key={d.departmentId} value={d.departmentId}>
                                            {d.name} {d.memberCount ? `(${d.memberCount} members)` : ""}
                                        </option>
                                    ))}
                                </select>
                            </div>

                            <div className="rounded-xl border border-border bg-surface-2/60 p-4 space-y-2">
                                <p className="text-xs font-semibold text-foreground-muted uppercase tracking-wider">Visibility</p>
                                <div className="flex gap-2">
                                    <button
                                        type="button"
                                        onClick={() => setVisibility("leader_only")}
                                        className={`flex-1 rounded-xl px-3 py-2 text-xs font-medium border transition-all ${
                                            visibility === "leader_only"
                                                ? "bg-accent-muted border-accent text-accent"
                                                : "border-border text-foreground-muted hover:border-accent"
                                        }`}
                                    >
                                        <div className="flex items-center justify-center gap-1.5">
                                            <Shield size={12} />
                                            Leader Only
                                        </div>
                                    </button>
                                    <button
                                        type="button"
                                        onClick={() => setVisibility("all_members")}
                                        className={`flex-1 rounded-xl px-3 py-2 text-xs font-medium border transition-all ${
                                            visibility === "all_members"
                                                ? "bg-accent-muted border-accent text-accent"
                                                : "border-border text-foreground-muted hover:border-accent"
                                        }`}
                                    >
                                        <div className="flex items-center justify-center gap-1.5">
                                            <Users size={12} />
                                            All Members
                                        </div>
                                    </button>
                                </div>
                                <p className="text-[11px] text-foreground-muted">
                                    {visibility === "leader_only"
                                        ? "Only the department leader can see this. They can re-share with their team."
                                        : "All members of the department will see this document."}
                                </p>
                            </div>

                            <button
                                type="button"
                                onClick={handleShareOtherDept}
                                disabled={submitting || !selectedDeptId}
                                className="w-full btn-gradient rounded-xl py-2.5 text-sm font-semibold flex items-center justify-center gap-2"
                            >
                                {submitting ? <Loader2 size={14} className="animate-spin" /> : <Building2 size={14} />}
                                Share with Department
                            </button>
                        </div>
                    )}

                    {/* ── Everyone sub-view ── */}
                    {mode === "everyone" && (
                        <div className="space-y-3">
                            <button onClick={reset} className="text-xs text-accent hover:underline">&larr; Back</button>
                            <div className="rounded-xl border border-border bg-surface-2/60 p-4">
                                <p className="text-sm text-foreground">
                                    This will share the document with <strong>all departments</strong> in the organization.
                                </p>
                                <p className="text-xs text-foreground-muted mt-1">
                                    Every department leader and member will be able to see this document.
                                </p>
                            </div>
                            <button
                                type="button"
                                onClick={handleShareEveryone}
                                disabled={submitting}
                                className="w-full btn-gradient rounded-xl py-2.5 text-sm font-semibold flex items-center justify-center gap-2"
                            >
                                {submitting ? <Loader2 size={14} className="animate-spin" /> : <Globe size={14} />}
                                Share with Everyone
                            </button>
                        </div>
                    )}

                    {/* Messages */}
                    {error && (
                        <div className="rounded-xl border border-red-500/30 bg-red-500/10 text-red-300 px-4 py-2.5 text-sm">{error}</div>
                    )}
                    {success && (
                        <div className="rounded-xl border border-emerald-500/30 bg-emerald-500/10 text-emerald-300 px-4 py-2.5 text-sm">{success}</div>
                    )}

                    {/* Existing Shares */}
                    {existingShares.length > 0 && !mode && (
                        <div className="space-y-2 pt-2 border-t border-border">
                            <p className="text-xs font-semibold text-foreground-muted uppercase tracking-wider">
                                Current Shares ({existingShares.length})
                            </p>
                            <div className="space-y-2">
                                {existingShares.map((s) => (
                                    <div key={s.shareId} className="flex items-center gap-3 p-2.5 rounded-xl border border-border bg-surface-2/40">
                                        <div className="shrink-0">
                                            {s.scope === "user" && <UserCheck size={14} className="text-blue-400" />}
                                            {s.scope === "department" && <Building2 size={14} className="text-purple-400" />}
                                            {s.scope === "all" && <Globe size={14} className="text-amber-400" />}
                                        </div>
                                        <div className="flex-1 min-w-0">
                                            {s.scope === "user" && (
                                                <p className="text-xs text-foreground truncate">
                                                    {s.targetUserNames?.join(", ") || s.targetUserIds.join(", ")}
                                                </p>
                                            )}
                                            {s.scope === "department" && (
                                                <p className="text-xs text-foreground">
                                                    {s.departmentName || s.departmentId}
                                                    {s.visibility === "leader_only" && (
                                                        <span className="ml-1.5 text-[10px] text-amber-400 font-medium">(Leader Only)</span>
                                                    )}
                                                </p>
                                            )}
                                            {s.scope === "all" && (
                                                <p className="text-xs text-foreground">Everyone in organization</p>
                                            )}
                                        </div>
                                        {(s.sharedBy === me?.userId || isAdmin) && (
                                            <button
                                                type="button"
                                                onClick={() => unshare(s.scope, s.departmentId || undefined, s.targetUserIds?.[0])}
                                                disabled={submitting}
                                                className="p-1.5 rounded-lg hover:bg-red-500/15 text-foreground-muted hover:text-red-400 transition-colors shrink-0"
                                                title="Remove share"
                                            >
                                                <Trash2 size={13} />
                                            </button>
                                        )}
                                    </div>
                                ))}
                            </div>
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
}
