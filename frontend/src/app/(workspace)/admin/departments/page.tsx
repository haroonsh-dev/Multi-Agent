"use client";

import React, { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
    Building2,
    Check,
    Eye,
    Loader2,
    Pencil,
    Plus,
    RefreshCw,
    Shield,
    Trash2,
    UserCheck,
    UserX,
    Users,
    FileType,
    Bot,
    ChevronRight,
    X,
} from "lucide-react";
import { useToast } from "@/components/Toast";
import { Badge, Button, EmptyState, PageHeader } from "@/components/ui";
import { apiRequest } from "@/lib/apiClient";
import { agentLabel, docTypeLabel, docTypesForAgents, skillsForAgents } from "@/lib/documentAgents";
import { usePlanAgents } from "@/hooks/usePlanAgents";
import { cn } from "@/lib/utils";

type Department = {
    departmentId: string;
    name: string;
    slug: string;
    description?: string;
    allowedDocumentTypes: string[];
    allowedAgents?: string[];
    memberCount?: number;
};

type OrgRole = {
    roleId: string;
    name: string;
    description?: string;
    isLeader: boolean;
    rank?: number;
    isSystem?: boolean;
    permissions: Record<string, boolean>;
};

type Member = {
    userId: string;
    fullName: string;
    email: string;
    primaryDepartmentId?: string | null;
    orgRoleId?: string | null;
    status?: string;
};

const ROLE_PAGE_LABELS: { key: string; label: string; hint: string }[] = [
    { key: "page.dashboard", label: "Dashboard", hint: "Home overview page" },
    { key: "page.documents", label: "Document Vault", hint: "Document library page" },
    { key: "page.chat", label: "AI Assistant", hint: "Chat page (also needs Chat permission)" },
    { key: "page.activity", label: "System Activity", hint: "Activity log page" },
    { key: "page.departments", label: "Department pages", hint: "Department overview under Documents" },
    { key: "page.plans", label: "Subscriptions & Billing", hint: "Subscription and plans page" },
    { key: "page.email_reports", label: "Automated Reports", hint: "Scheduled email report settings" },
    { key: "page.integrations", label: "Integrations", hint: "Third-party integrations page" },
    { key: "page.settings", label: "AI Engine Config", hint: "AI configuration and settings page" },
];

const ROLE_FEATURE_LABELS: { key: string; label: string; hint: string }[] = [
    { key: "document.upload", label: "Upload documents", hint: "Add files to the library" },
    { key: "document.view", label: "View documents", hint: "Browse and open files" },
    { key: "document.delete", label: "Delete documents", hint: "Remove files" },
    { key: "document.share", label: "Share documents", hint: "Allow others to see private leader files" },
    { key: "chat.use", label: "Use AI Chat", hint: "Ask questions about documents" },
    { key: "org.documents.view", label: "View all org documents", hint: "See every document in the organization" },
];

const ROLE_PERM_LABELS = [...ROLE_PAGE_LABELS, ...ROLE_FEATURE_LABELS];

const RANK_OPTIONS = [
    { value: 1, label: "1 — Employee" },
    { value: 2, label: "2 — Leader" },
    { value: 3, label: "3 — Manager" },
    { value: 4, label: "4 — Custom" },
];

function rankBadgeLabel(rank?: number, isLeader?: boolean) {
    if (rank === 3) return "Manager";
    if (rank === 2 || isLeader) return "Leader";
    if (rank === 1) return "Employee";
    if (rank && rank > 3) return `Rank ${rank}`;
    return null;
}

function typeLabel(t: string) {
    return docTypeLabel(t);
}

function defaultPerms(): Record<string, boolean> {
    const off = new Set([
        "document.share",
        "org.documents.view",
        "page.activity",
        "page.departments",
        "page.plans",
        "page.email_reports",
        "page.integrations",
        "page.settings",
    ]);
    return Object.fromEntries(ROLE_PERM_LABELS.map((p) => [p.key, !off.has(p.key)]));
}

function permsFromRole(r: OrgRole): Record<string, boolean> {
    const base = defaultPerms();
    for (const p of ROLE_PERM_LABELS) {
        if (typeof r.permissions?.[p.key] === "boolean") base[p.key] = !!r.permissions[p.key];
    }
    return base;
}

function fieldClass() {
    return "w-full h-11 px-3.5 rounded-md text-sm bg-surface-2 border border-border text-foreground placeholder:text-foreground-muted outline-none focus:border-accent focus:ring-2 focus:ring-[rgba(56,182,255,0.2)] transition-shadow";
}

function DocTypePicker({
    knownTypes,
    selected,
    onToggle,
}: {
    knownTypes: string[];
    selected: string[];
    onToggle: (t: string) => void;
}) {
    return (
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 max-h-56 overflow-y-auto pr-1">
            {knownTypes.map((t) => {
                const on = selected.includes(t);
                return (
                    <button
                        key={t}
                        type="button"
                        onClick={() => onToggle(t)}
                        className={cn(
                            "flex items-center gap-2 text-left px-3 py-2.5 rounded-md border text-xs font-medium transition-colors",
                            on
                                ? "border-[rgba(56,182,255,0.4)] bg-accent-muted text-accent"
                                : "border-border bg-surface-2 text-foreground-secondary hover:border-border-strong"
                        )}
                    >
                        <span
                            className={cn(
                                "h-4 w-4 rounded shrink-0 flex items-center justify-center border",
                                on ? "bg-accent border-accent text-[#03111d]" : "border-border-strong"
                            )}
                        >
                            {on && <Check className="h-3 w-3" strokeWidth={3} />}
                        </span>
                        <span className="truncate">{typeLabel(t)}</span>
                    </button>
                );
            })}
        </div>
    );
}

function AgentPicker({
    orgAgentIds,
    selected,
    onToggle,
}: {
    orgAgentIds: string[];
    selected: string[];
    onToggle: (id: string) => void;
}) {
    const planSkills = skillsForAgents(orgAgentIds);
    if (!planSkills.length) {
        return (
            <p className="text-xs text-foreground-muted">
                No agents on your organization plan yet.{" "}
                <Link href="/plans" className="text-accent font-semibold underline-offset-2 hover:underline">
                    Request a plan
                </Link>{" "}
                (e.g. Finance) and have super admin approve it — then assign that agent to this department&apos;s
                team.
            </p>
        );
    }
    return (
        <div className="space-y-2 max-h-72 overflow-y-auto pr-1">
            {planSkills.map((a) => {
                const on = selected.includes(a.agentId);
                return (
                    <button
                        key={a.agentId}
                        type="button"
                        onClick={() => onToggle(a.agentId)}
                        className={cn(
                            "w-full text-left px-3 py-2.5 rounded-md border transition-colors",
                            on
                                ? "border-[rgba(56,182,255,0.4)] bg-accent-muted"
                                : "border-border bg-surface-2 hover:border-border-strong"
                        )}
                    >
                        <div className="flex items-center gap-2">
                            <span
                                className={cn(
                                    "h-4 w-4 rounded shrink-0 flex items-center justify-center border",
                                    on ? "bg-accent border-accent text-[#03111d]" : "border-border-strong"
                                )}
                            >
                                {on && <Check className="h-3 w-3" strokeWidth={3} />}
                            </span>
                            <span className={cn("text-xs font-semibold", on ? "text-accent" : "text-foreground")}>
                                {a.label}
                            </span>
                        </div>
                        {!!a.skills.length && (
                            <p className="mt-1.5 pl-6 text-[10px] text-foreground-muted leading-relaxed">
                                Skills: {a.skills.slice(0, 4).join(" · ")}
                                {a.skills.length > 4 ? ` · +${a.skills.length - 4} more` : ""}
                            </p>
                        )}
                    </button>
                );
            })}
        </div>
    );
}

function PlanAgentsSkillsPanel({ orgAgentIds }: { orgAgentIds: string[] }) {
    const planSkills = skillsForAgents(orgAgentIds);
    const typeCount = docTypesForAgents(orgAgentIds).length;

    return (
        <div className="surface-card p-5 space-y-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                    <h3 className="text-sm font-semibold text-foreground flex items-center gap-2">
                        <Bot className="h-4 w-4 text-accent" />
                        Your organization plan
                    </h3>
                    <p className="text-xs text-foreground-muted mt-1">
                        Departments can only use these agents and skills. Document types below are limited to this
                        plan.
                    </p>
                </div>
                <div className="flex items-center gap-2">
                    <Badge variant="accent">{planSkills.length} agents</Badge>
                    <Badge variant="muted">{typeCount} doc types</Badge>
                    <Link
                        href="/plans"
                        className="text-[11px] font-semibold text-accent hover:underline underline-offset-2"
                    >
                        Manage plan →
                    </Link>
                </div>
            </div>

            {!planSkills.length ? (
                <p className="text-xs text-foreground-muted">
                    No agents on your plan yet. Request agents from Subscriptions &amp; Billing — once super admin
                    approves, they appear here for department assignment.
                </p>
            ) : (
                <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-3">
                    {planSkills.map((a) => (
                        <div
                            key={a.agentId}
                            className="rounded-md border border-border bg-surface-2 p-3 space-y-2"
                        >
                            <p className="text-xs font-semibold text-foreground">{a.label}</p>
                            <ul className="space-y-1">
                                {a.skills.map((s) => (
                                    <li
                                        key={s}
                                        className="text-[10px] text-foreground-muted flex items-start gap-1.5"
                                    >
                                        <Check className="h-3 w-3 text-accent shrink-0 mt-0.5" />
                                        <span>{s}</span>
                                    </li>
                                ))}
                            </ul>
                        </div>
                    ))}
                </div>
            )}
        </div>
    );
}

function PermPicker({
    labels,
    permissions,
    onChange,
}: {
    labels: { key: string; label: string; hint: string }[];
    permissions: Record<string, boolean>;
    onChange: (next: Record<string, boolean>) => void;
}) {
    return (
        <div className="grid sm:grid-cols-2 gap-2">
            {labels.map((p) => (
                <label
                    key={p.key}
                    className={cn(
                        "flex items-start gap-3 p-3 rounded-md border cursor-pointer transition-colors",
                        permissions[p.key]
                            ? "border-[rgba(56,182,255,0.35)] bg-accent-muted"
                            : "border-border bg-surface-2 hover:border-border-strong"
                    )}
                >
                    <input
                        type="checkbox"
                        className="mt-0.5 accent-accent"
                        checked={!!permissions[p.key]}
                        onChange={(e) =>
                            onChange({
                                ...permissions,
                                [p.key]: e.target.checked,
                                ...(p.key === "document.view" ? { "document.preview": e.target.checked } : {}),
                                ...(p.key === "page.departments" ? { "department.view": e.target.checked } : {}),
                            })
                        }
                    />
                    <span>
                        <span className="block text-xs font-semibold text-foreground">{p.label}</span>
                        <span className="block text-[10px] text-foreground-muted mt-0.5">{p.hint}</span>
                    </span>
                </label>
            ))}
        </div>
    );
}

function DepartmentsAdminContent() {
    const { showToast } = useToast();
    const { orgAgentOptions, orgAllowedIds } = usePlanAgents();
    const orgPlanAgentIds = orgAllowedIds || orgAgentOptions.map((o) => o.value);
    const [tab, setTab] = useState<"departments" | "roles" | "members">("departments");
    const [departments, setDepartments] = useState<Department[]>([]);
    const [roles, setRoles] = useState<OrgRole[]>([]);
    const [teamMembers, setTeamMembers] = useState<Member[]>([]);
    const [knownTypes, setKnownTypes] = useState<string[]>([]);
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);

    const planScopedTypes = useMemo(() => {
        const fromPlan = docTypesForAgents(orgPlanAgentIds);
        if (!knownTypes.length) return fromPlan;
        const planSet = new Set(fromPlan);
        return knownTypes.filter((t) => planSet.has(t));
    }, [knownTypes, orgPlanAgentIds]);

    const [editingDeptId, setEditingDeptId] = useState<string | null>(null);
    const [editingRoleId, setEditingRoleId] = useState<string | null>(null);
    const [editingMemberId, setEditingMemberId] = useState<string | null>(null);

    const [deptForm, setDeptForm] = useState({
        name: "",
        description: "",
        types: [] as string[],
        agents: [] as string[],
    });
    const [roleForm, setRoleForm] = useState({
        name: "",
        description: "",
        isLeader: false,
        rank: 1,
        permissions: defaultPerms(),
    });
    const [memberForm, setMemberForm] = useState({
        fullName: "",
        email: "",
        password: "",
        departmentId: "",
        orgRoleId: "",
    });

    const load = useCallback(async () => {
        setLoading(true);
        try {
            const [deptRes, roleRes, teamRes] = await Promise.all([
                apiRequest("/docs/departments"),
                apiRequest("/docs/departments/roles"),
                apiRequest("/docs/team/members").catch(() => ({ data: { members: [] } })),
            ]);
            setDepartments(deptRes?.data?.departments || []);
            const apiTypes: string[] = deptRes?.data?.knownDocumentTypes || [];
            const apiAgents: string[] | undefined = deptRes?.data?.orgAgentIds;
            // Prefer API plan-scoped types; fall back to client filter from subscription
            setKnownTypes(
                apiTypes.length
                    ? apiTypes
                    : docTypesForAgents(apiAgents?.length ? apiAgents : orgPlanAgentIds)
            );
            setRoles(roleRes?.data?.roles || []);
            setTeamMembers(teamRes?.data?.members || []);
        } catch (e: any) {
            showToast(e.message || "Failed to load", "error");
        } finally {
            setLoading(false);
        }
    }, [showToast, orgPlanAgentIds]);

    useEffect(() => {
        load();
    }, [load]);

    const deptNameById = useMemo(
        () => Object.fromEntries(departments.map((d) => [d.departmentId, d.name])),
        [departments]
    );
    const roleNameById = useMemo(
        () => Object.fromEntries(roles.map((r) => [r.roleId, r.name])),
        [roles]
    );

    const resetDeptForm = () => {
        setEditingDeptId(null);
        setDeptForm({ name: "", description: "", types: [], agents: [] });
    };
    const resetRoleForm = () => {
        setEditingRoleId(null);
        setRoleForm({ name: "", description: "", isLeader: false, rank: 1, permissions: defaultPerms() });
    };
    const resetMemberForm = () => {
        setEditingMemberId(null);
        setMemberForm({ fullName: "", email: "", password: "", departmentId: "", orgRoleId: "" });
    };

    const startEditDept = (d: Department) => {
        setEditingDeptId(d.departmentId);
        setDeptForm({
            name: d.name,
            description: d.description || "",
            types: [...(d.allowedDocumentTypes || [])],
            agents: [...(d.allowedAgents || [])],
        });
        setTab("departments");
        window.scrollTo({ top: 0, behavior: "smooth" });
    };

    const startEditRole = (r: OrgRole) => {
        setEditingRoleId(r.roleId);
        setRoleForm({
            name: r.name,
            description: r.description || "",
            isLeader: !!r.isLeader,
            rank: typeof r.rank === "number" && r.rank >= 1 ? r.rank : r.isLeader ? 2 : 1,
            permissions: permsFromRole(r),
        });
        setTab("roles");
        window.scrollTo({ top: 0, behavior: "smooth" });
    };

    const startEditMember = (m: Member) => {
        setEditingMemberId(m.userId);
        setMemberForm({
            fullName: m.fullName,
            email: m.email,
            password: "",
            departmentId: m.primaryDepartmentId || "",
            orgRoleId: m.orgRoleId || "",
        });
        setTab("members");
        window.scrollTo({ top: 0, behavior: "smooth" });
    };

    const saveDepartment = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!deptForm.types.length) {
            showToast("Select at least one document type this department manages", "error");
            return;
        }
        setSaving(true);
        try {
            const body = {
                name: deptForm.name,
                description: deptForm.description,
                allowedDocumentTypes: deptForm.types,
                allowedAgents: deptForm.agents,
            };
            if (editingDeptId) {
                await apiRequest(`/docs/departments/${editingDeptId}`, {
                    method: "PATCH",
                    body: JSON.stringify(body),
                });
                showToast("Department updated", "success");
            } else {
                await apiRequest("/docs/departments", {
                    method: "POST",
                    body: JSON.stringify(body),
                });
                showToast("Department created", "success");
            }
            resetDeptForm();
            await load();
        } catch (err: any) {
            showToast(err.message || "Failed", "error");
        } finally {
            setSaving(false);
        }
    };

    const deleteDepartment = async (id: string) => {
        if (!confirm("Delete this department and unassign its members?")) return;
        try {
            await apiRequest(`/docs/departments/${id}`, { method: "DELETE" });
            if (editingDeptId === id) resetDeptForm();
            showToast("Department deleted", "success");
            await load();
        } catch (err: any) {
            showToast(err.message || "Failed", "error");
        }
    };

    const saveRole = async (e: React.FormEvent) => {
        e.preventDefault();
        setSaving(true);
        try {
            const permissions = { ...roleForm.permissions };
            permissions["document.preview"] = permissions["document.view"] === true;
            permissions["department.view"] = permissions["page.departments"] === true;
            permissions["department.manage"] = false;
            const body = {
                name: roleForm.name,
                description: roleForm.description,
                isLeader: roleForm.isLeader,
                rank: roleForm.rank,
                permissions,
            };
            if (editingRoleId) {
                await apiRequest(`/docs/departments/roles/${editingRoleId}`, {
                    method: "PATCH",
                    body: JSON.stringify(body),
                });
                showToast("Role updated — permissions synced to members", "success");
            } else {
                await apiRequest("/docs/departments/roles", {
                    method: "POST",
                    body: JSON.stringify(body),
                });
                showToast("Role created", "success");
            }
            resetRoleForm();
            await load();
        } catch (err: any) {
            showToast(err.message || "Failed", "error");
        } finally {
            setSaving(false);
        }
    };

    const deleteRole = async (id: string) => {
        if (!confirm("Delete this role? Members using it must be reassigned first.")) return;
        try {
            await apiRequest(`/docs/departments/roles/${id}`, { method: "DELETE" });
            if (editingRoleId === id) resetRoleForm();
            showToast("Role deleted", "success");
            await load();
        } catch (err: any) {
            showToast(err.message || "Failed", "error");
        }
    };

    const saveMember = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!memberForm.departmentId || !memberForm.orgRoleId) {
            showToast("Select department and role", "error");
            return;
        }
        setSaving(true);
        try {
            if (editingMemberId) {
                await apiRequest(`/docs/team/members/${editingMemberId}`, {
                    method: "PUT",
                    body: JSON.stringify({
                        fullName: memberForm.fullName,
                        email: memberForm.email,
                        ...(memberForm.password ? { password: memberForm.password } : {}),
                    }),
                });
                await apiRequest(`/docs/departments/${memberForm.departmentId}/members`, {
                    method: "POST",
                    body: JSON.stringify({
                        userId: editingMemberId,
                        orgRoleId: memberForm.orgRoleId,
                    }),
                });
                showToast("Member updated", "success");
            } else {
                if (!memberForm.password || memberForm.password.length < 6) {
                    showToast("Password must be at least 6 characters", "error");
                    setSaving(false);
                    return;
                }
                const created = await apiRequest("/docs/team/members", {
                    method: "POST",
                    body: JSON.stringify({
                        fullName: memberForm.fullName,
                        email: memberForm.email,
                        password: memberForm.password,
                    }),
                });
                const userId =
                    created?.data?.member?.userId ||
                    created?.data?.user?.userId ||
                    created?.data?.userId;
                if (!userId) throw new Error("Member created but userId missing");
                await apiRequest(`/docs/departments/${memberForm.departmentId}/members`, {
                    method: "POST",
                    body: JSON.stringify({
                        userId,
                        orgRoleId: memberForm.orgRoleId,
                    }),
                });
                showToast("Team member added", "success");
            }
            resetMemberForm();
            await load();
        } catch (err: any) {
            showToast(err.message || "Failed", "error");
        } finally {
            setSaving(false);
        }
    };

    const removeFromDepartment = async (m: Member) => {
        if (!m.primaryDepartmentId) return;
        if (!confirm(`Remove ${m.fullName} from ${deptNameById[m.primaryDepartmentId] || "department"}?`)) return;
        try {
            await apiRequest(`/docs/departments/${m.primaryDepartmentId}/members/${m.userId}`, {
                method: "DELETE",
            });
            if (editingMemberId === m.userId) resetMemberForm();
            showToast("Removed from department", "success");
            await load();
        } catch (err: any) {
            showToast(err.message || "Failed", "error");
        }
    };

    const toggleMemberStatus = async (m: Member) => {
        const next = m.status === "active" ? "blocked" : "active";
        try {
            await apiRequest(`/docs/team/members/${m.userId}/status`, {
                method: "PATCH",
                body: JSON.stringify({ status: next }),
            });
            showToast(next === "blocked" ? "Member blocked" : "Member activated", "success");
            await load();
        } catch (err: any) {
            showToast(err.message || "Failed", "error");
        }
    };

    const deleteMember = async (m: Member) => {
        if (!confirm(`Permanently delete ${m.fullName}? Their account will be removed.`)) return;
        try {
            if (m.primaryDepartmentId) {
                await apiRequest(`/docs/departments/${m.primaryDepartmentId}/members/${m.userId}`, {
                    method: "DELETE",
                }).catch(() => null);
            }
            await apiRequest(`/docs/team/members/${m.userId}`, { method: "DELETE" });
            if (editingMemberId === m.userId) resetMemberForm();
            showToast("Member deleted", "success");
            await load();
        } catch (err: any) {
            showToast(err.message || "Failed", "error");
        }
    };

    const toggleType = (t: string) => {
        setDeptForm((f) => ({
            ...f,
            types: f.types.includes(t) ? f.types.filter((x) => x !== t) : [...f.types, t],
        }));
    };

    const toggleAgent = (id: string) => {
        setDeptForm((f) => ({
            ...f,
            agents: f.agents.includes(id) ? f.agents.filter((x) => x !== id) : [...f.agents, id],
        }));
    };

    const tabs = [
        { id: "departments" as const, label: "Departments", icon: Building2, desc: "Units, types & AI agents" },
        { id: "roles" as const, label: "Roles", icon: Shield, desc: "Permissions" },
        { id: "members" as const, label: "Members", icon: Users, desc: "People & assignments" },
    ];

    return (
        <div className="p-4 sm:p-6 lg:p-8 max-w-6xl mx-auto">
            <PageHeader
                title="Departments"
                subtitle="Create departments, define roles with permissions, and manage team members — including edit, block, and remove."
                actions={
                    <Button variant="secondary" onClick={load} disabled={loading}>
                        <RefreshCw className={cn("h-4 w-4", loading && "animate-spin")} />
                        Refresh
                    </Button>
                }
            />

            <div className="mt-8 grid grid-cols-1 sm:grid-cols-3 gap-3">
                {tabs.map((t) => {
                    const active = tab === t.id;
                    return (
                        <button
                            key={t.id}
                            type="button"
                            onClick={() => setTab(t.id)}
                            className={cn(
                                "text-left rounded-xl border p-4 transition-all duration-200",
                                active
                                    ? "border-[rgba(56,182,255,0.45)] bg-accent-muted shadow-[0_0_0_1px_rgba(56,182,255,0.15)]"
                                    : "border-border bg-surface hover:border-border-strong"
                            )}
                        >
                            <div className="flex items-center gap-3">
                                <span
                                    className={cn(
                                        "h-10 w-10 rounded-md flex items-center justify-center",
                                        active
                                            ? "bg-accent text-[#03111d]"
                                            : "bg-surface-3 text-foreground-muted"
                                    )}
                                >
                                    <t.icon className="h-4 w-4" />
                                </span>
                                <div>
                                    <p className="text-sm font-semibold text-foreground">{t.label}</p>
                                    <p className="text-[11px] text-foreground-muted mt-0.5">{t.desc}</p>
                                </div>
                            </div>
                        </button>
                    );
                })}
            </div>

            {loading ? (
                <div className="flex justify-center py-24">
                    <Loader2 className="h-8 w-8 animate-spin text-accent" />
                </div>
            ) : (
                <div className="mt-8">
                    {tab === "departments" && (
                        <div className="space-y-6">
                            <PlanAgentsSkillsPanel orgAgentIds={orgPlanAgentIds} />
                            <div className="grid gap-6 lg:grid-cols-[1.1fr_0.9fr]">
                            <form onSubmit={saveDepartment} className="surface-card p-6 space-y-5">
                                <div className="flex items-start justify-between gap-3">
                                    <div>
                                        <h3 className="text-base font-semibold text-foreground">
                                            {editingDeptId ? "Update department" : "Create department"}
                                        </h3>
                                        <p className="text-xs text-foreground-muted mt-1">
                                            Document types control department vs personal vault. AI agents control which
                                            skills the team can use — they only get agents you assign here (subset of the
                                            org plan). Example: org buys Finance → assign Finance to this department →
                                            team uses Finance skills only.
                                        </p>
                                    </div>
                                    {editingDeptId && (
                                        <Button type="button" variant="ghost" size="sm" onClick={resetDeptForm}>
                                            <X className="h-4 w-4" />
                                            Cancel
                                        </Button>
                                    )}
                                </div>

                                <div className="space-y-1.5">
                                    <label className="text-xs font-medium text-foreground-secondary">Name</label>
                                    <input
                                        required
                                        placeholder="e.g. HR, Finance, Legal"
                                        value={deptForm.name}
                                        onChange={(e) => setDeptForm({ ...deptForm, name: e.target.value })}
                                        className={fieldClass()}
                                    />
                                </div>

                                <div className="space-y-1.5">
                                    <label className="text-xs font-medium text-foreground-secondary">Description</label>
                                    <textarea
                                        placeholder="Optional short description"
                                        value={deptForm.description}
                                        onChange={(e) => setDeptForm({ ...deptForm, description: e.target.value })}
                                        className={cn(fieldClass(), "h-24 py-3 resize-none")}
                                    />
                                </div>

                                <div className="space-y-2">
                                    <div className="flex items-center gap-2">
                                        <FileType className="h-3.5 w-3.5 text-accent" />
                                        <label className="text-xs font-medium text-foreground-secondary">
                                            Document types managed
                                        </label>
                                    </div>
                                    <DocTypePicker
                                        knownTypes={planScopedTypes}
                                        selected={deptForm.types}
                                        onToggle={toggleType}
                                    />
                                    <p className="text-[10px] text-foreground-muted">
                                        Only document types for agents on your plan are listed. Types decide where files
                                        live; agents decide which AI skills run.
                                    </p>
                                </div>

                                <div className="space-y-2">
                                    <div className="flex items-center gap-2">
                                        <Bot className="h-3.5 w-3.5 text-accent" />
                                        <label className="text-xs font-medium text-foreground-secondary">
                                            AI agents for this department&apos;s team
                                        </label>
                                    </div>
                                    <p className="text-[10px] text-foreground-muted">
                                        Only agents on your approved org plan are listed. Leave empty to give this team
                                        every plan agent. Team members cannot use other agents&apos; skills.
                                    </p>
                                    <AgentPicker
                                        orgAgentIds={orgPlanAgentIds}
                                        selected={deptForm.agents}
                                        onToggle={toggleAgent}
                                    />
                                </div>

                                <Button type="submit" disabled={saving} className="w-full sm:w-auto">
                                    {editingDeptId ? (
                                        <>
                                            <Check className="h-4 w-4" />
                                            Save changes
                                        </>
                                    ) : (
                                        <>
                                            <Plus className="h-4 w-4" />
                                            Create department
                                        </>
                                    )}
                                </Button>
                            </form>

                            <div className="space-y-3">
                                <h3 className="text-sm font-semibold text-foreground px-1">
                                    Your departments ({departments.length})
                                </h3>
                                {!departments.length ? (
                                    <EmptyState
                                        icon={<Building2 size={20} />}
                                        title="No departments yet"
                                        description="Create HR, Finance, or any unit and pick the document types it manages."
                                    />
                                ) : (
                                    departments.map((d) => (
                                        <div key={d.departmentId} className="surface-card p-4 flex gap-3 items-start group">
                                            <div className="h-10 w-10 rounded-md bg-accent-muted text-accent flex items-center justify-center shrink-0">
                                                <Building2 className="h-4 w-4" />
                                            </div>
                                            <div className="min-w-0 flex-1">
                                                <div className="flex items-start justify-between gap-2">
                                                    <div>
                                                        <Link
                                                            href={`/departments/${d.departmentId}`}
                                                            className="font-semibold text-foreground hover:text-accent inline-flex items-center gap-1"
                                                        >
                                                            {d.name}
                                                            <ChevronRight className="h-3.5 w-3.5 opacity-50" />
                                                        </Link>
                                                        <p className="text-[11px] text-foreground-muted mt-0.5">
                                                            {d.memberCount || 0} members
                                                            {editingDeptId === d.departmentId ? " · editing" : ""}
                                                        </p>
                                                    </div>
                                                    <div className="flex items-center gap-0.5 shrink-0">
                                                        <button
                                                            type="button"
                                                            onClick={() => startEditDept(d)}
                                                            className="p-2 rounded-lg text-foreground-muted hover:text-accent hover:bg-accent-muted"
                                                            aria-label="Edit department"
                                                        >
                                                            <Pencil className="h-4 w-4" />
                                                        </button>
                                                        <button
                                                            type="button"
                                                            onClick={() => deleteDepartment(d.departmentId)}
                                                            className="p-2 rounded-lg text-foreground-muted hover:text-error hover:bg-error-muted"
                                                            aria-label="Delete department"
                                                        >
                                                            <Trash2 className="h-4 w-4" />
                                                        </button>
                                                    </div>
                                                </div>
                                                <div className="flex flex-wrap gap-1.5 mt-3">
                                                    {(d.allowedDocumentTypes || []).length ? (
                                                        d.allowedDocumentTypes.map((t) => (
                                                            <Badge key={t} variant="accent">
                                                                {typeLabel(t)}
                                                            </Badge>
                                                        ))
                                                    ) : (
                                                        <Badge variant="muted">No types</Badge>
                                                    )}
                                                </div>
                                                <div className="flex flex-wrap gap-1.5 mt-2">
                                                    {(d.allowedAgents || []).length ? (
                                                        d.allowedAgents!.map((a) => (
                                                            <Badge key={a} variant="muted">
                                                                {agentLabel(a)}
                                                            </Badge>
                                                        ))
                                                    ) : (
                                                        <Badge variant="muted">All plan agents</Badge>
                                                    )}
                                                </div>
                                            </div>
                                        </div>
                                    ))
                                )}
                            </div>
                            </div>
                        </div>
                    )}

                    {tab === "roles" && (
                        <div className="grid gap-6 lg:grid-cols-[1.15fr_0.85fr]">
                            <form onSubmit={saveRole} className="surface-card p-6 space-y-5">
                                <div className="flex items-start justify-between gap-3">
                                    <div>
                                        <h3 className="text-base font-semibold text-foreground">
                                            {editingRoleId ? "Update role" : "Create role"}
                                        </h3>
                                        <p className="text-xs text-foreground-muted mt-1">
                                            Set permissions for this role. Updates sync to members already using it.
                                        </p>
                                    </div>
                                    {editingRoleId && (
                                        <Button type="button" variant="ghost" size="sm" onClick={resetRoleForm}>
                                            <X className="h-4 w-4" />
                                            Cancel
                                        </Button>
                                    )}
                                </div>

                                <div className="space-y-1.5">
                                    <label className="text-xs font-medium text-foreground-secondary">Role name</label>
                                    <input
                                        required
                                        placeholder="e.g. Team Lead, Recruiter"
                                        value={roleForm.name}
                                        onChange={(e) => setRoleForm({ ...roleForm, name: e.target.value })}
                                        className={fieldClass()}
                                    />
                                </div>
                                <div className="space-y-1.5">
                                    <label className="text-xs font-medium text-foreground-secondary">Description</label>
                                    <input
                                        placeholder="Optional"
                                        value={roleForm.description}
                                        onChange={(e) => setRoleForm({ ...roleForm, description: e.target.value })}
                                        className={fieldClass()}
                                    />
                                </div>

                                <div className="space-y-1.5">
                                    <label className="text-xs font-medium text-foreground-secondary">
                                        Hierarchy rank
                                    </label>
                                    <select
                                        value={roleForm.rank}
                                        onChange={(e) => {
                                            const rank = Number(e.target.value) || 1;
                                            setRoleForm({
                                                ...roleForm,
                                                rank,
                                                isLeader: rank === 2 ? true : rank === 1 ? false : roleForm.isLeader,
                                            });
                                        }}
                                        className={fieldClass()}
                                    >
                                        {RANK_OPTIONS.map((o) => (
                                            <option key={o.value} value={o.value}>
                                                {o.label}
                                            </option>
                                        ))}
                                    </select>
                                    <p className="text-[10px] text-foreground-muted">
                                        Employee (1) → Leader (2) → Manager (3). Higher ranks can get broader page access.
                                    </p>
                                </div>

                                <label className="flex items-start gap-3 p-3.5 rounded-md border border-border bg-surface-2 cursor-pointer">
                                    <input
                                        type="checkbox"
                                        className="mt-1 accent-accent"
                                        checked={roleForm.isLeader}
                                        onChange={(e) => setRoleForm({ ...roleForm, isLeader: e.target.checked })}
                                    />
                                    <span>
                                        <span className="block text-sm font-medium text-foreground">Leader role</span>
                                        <span className="block text-[11px] text-foreground-muted mt-0.5">
                                            Department files stay private to peers until the leader shares them.
                                        </span>
                                    </span>
                                </label>

                                <div>
                                    <p className="text-xs font-medium text-foreground-secondary mb-3">
                                        Pages this role can open
                                    </p>
                                    <PermPicker
                                        labels={ROLE_PAGE_LABELS}
                                        permissions={roleForm.permissions}
                                        onChange={(permissions) => setRoleForm({ ...roleForm, permissions })}
                                    />
                                </div>

                                <div>
                                    <p className="text-xs font-medium text-foreground-secondary mb-3">
                                        Feature permissions
                                    </p>
                                    <PermPicker
                                        labels={ROLE_FEATURE_LABELS}
                                        permissions={roleForm.permissions}
                                        onChange={(permissions) => setRoleForm({ ...roleForm, permissions })}
                                    />
                                </div>

                                <Button type="submit" disabled={saving}>
                                    {editingRoleId ? (
                                        <>
                                            <Check className="h-4 w-4" />
                                            Save role
                                        </>
                                    ) : (
                                        <>
                                            <Plus className="h-4 w-4" />
                                            Create role
                                        </>
                                    )}
                                </Button>
                            </form>

                            <div className="space-y-3">
                                <h3 className="text-sm font-semibold text-foreground px-1">
                                    Roles ({roles.length})
                                </h3>
                                {roles.map((r) => (
                                    <div key={r.roleId} className="surface-card p-4">
                                        <div className="flex items-start justify-between gap-2">
                                            <div>
                                                <div className="flex items-center gap-2 flex-wrap">
                                                    <span className="font-semibold text-foreground">{r.name}</span>
                                                    {rankBadgeLabel(r.rank, r.isLeader) && (
                                                        <Badge variant="accent">
                                                            {rankBadgeLabel(r.rank, r.isLeader)}
                                                        </Badge>
                                                    )}
                                                    {r.isLeader && r.rank !== 2 && (
                                                        <Badge variant="warning">Leader flag</Badge>
                                                    )}
                                                    {r.isSystem && <Badge variant="muted">Default</Badge>}
                                                    {editingRoleId === r.roleId && <Badge variant="warning">Editing</Badge>}
                                                </div>
                                                <p className="text-[11px] text-foreground-muted mt-1">
                                                    {r.description || "No description"}
                                                </p>
                                            </div>
                                            <div className="flex items-center gap-0.5 shrink-0">
                                                <button
                                                    type="button"
                                                    onClick={() => startEditRole(r)}
                                                    className="p-2 rounded-lg text-foreground-muted hover:text-accent hover:bg-accent-muted"
                                                    aria-label="Edit role"
                                                >
                                                    <Pencil className="h-4 w-4" />
                                                </button>
                                                {!r.isSystem && (
                                                    <button
                                                        type="button"
                                                        onClick={() => deleteRole(r.roleId)}
                                                        className="p-2 rounded-lg text-foreground-muted hover:text-error hover:bg-error-muted"
                                                        aria-label="Delete role"
                                                    >
                                                        <Trash2 className="h-4 w-4" />
                                                    </button>
                                                )}
                                            </div>
                                        </div>
                                        <div className="flex flex-wrap gap-1.5 mt-3">
                                            {ROLE_PERM_LABELS.filter((p) => r.permissions?.[p.key]).map((p) => (
                                                <Badge key={p.key} variant="default">
                                                    {p.label}
                                                </Badge>
                                            ))}
                                        </div>
                                    </div>
                                ))}
                            </div>
                        </div>
                    )}

                    {tab === "members" && (
                        <div className="grid gap-6 lg:grid-cols-2">
                            <form onSubmit={saveMember} className="surface-card p-6 space-y-5">
                                <div className="flex items-start justify-between gap-3">
                                    <div>
                                        <h3 className="text-base font-semibold text-foreground">
                                            {editingMemberId ? "Update member" : "Add team member"}
                                        </h3>
                                        <p className="text-xs text-foreground-muted mt-1">
                                            {editingMemberId
                                                ? "Change details, department, role, or password."
                                                : "Create a person and assign department + role."}
                                        </p>
                                    </div>
                                    {editingMemberId && (
                                        <Button type="button" variant="ghost" size="sm" onClick={resetMemberForm}>
                                            <X className="h-4 w-4" />
                                            Cancel
                                        </Button>
                                    )}
                                </div>

                                <div className="space-y-1.5">
                                    <label className="text-xs font-medium text-foreground-secondary">Full name</label>
                                    <input
                                        required
                                        value={memberForm.fullName}
                                        onChange={(e) => setMemberForm({ ...memberForm, fullName: e.target.value })}
                                        className={fieldClass()}
                                        placeholder="Full name"
                                    />
                                </div>
                                <div className="space-y-1.5">
                                    <label className="text-xs font-medium text-foreground-secondary">Email</label>
                                    <input
                                        required
                                        type="email"
                                        value={memberForm.email}
                                        onChange={(e) => setMemberForm({ ...memberForm, email: e.target.value })}
                                        className={fieldClass()}
                                        placeholder="name@company.com"
                                    />
                                </div>
                                <div className="space-y-1.5">
                                    <label className="text-xs font-medium text-foreground-secondary">
                                        {editingMemberId ? "New password (optional)" : "Password"}
                                    </label>
                                    <input
                                        type="password"
                                        minLength={editingMemberId ? undefined : 6}
                                        required={!editingMemberId}
                                        value={memberForm.password}
                                        onChange={(e) => setMemberForm({ ...memberForm, password: e.target.value })}
                                        className={fieldClass()}
                                        placeholder={editingMemberId ? "Leave blank to keep current" : "Min 6 characters"}
                                    />
                                </div>
                                <div className="grid sm:grid-cols-2 gap-3">
                                    <div className="space-y-1.5">
                                        <label className="text-xs font-medium text-foreground-secondary">Department</label>
                                        <select
                                            required
                                            value={memberForm.departmentId}
                                            onChange={(e) => setMemberForm({ ...memberForm, departmentId: e.target.value })}
                                            className={fieldClass()}
                                        >
                                            <option value="">Select…</option>
                                            {departments.map((d) => (
                                                <option key={d.departmentId} value={d.departmentId}>
                                                    {d.name}
                                                </option>
                                            ))}
                                        </select>
                                    </div>
                                    <div className="space-y-1.5">
                                        <label className="text-xs font-medium text-foreground-secondary">Role</label>
                                        <select
                                            required
                                            value={memberForm.orgRoleId}
                                            onChange={(e) => setMemberForm({ ...memberForm, orgRoleId: e.target.value })}
                                            className={fieldClass()}
                                        >
                                            <option value="">Select…</option>
                                            {roles.map((r) => (
                                                <option key={r.roleId} value={r.roleId}>
                                                    {r.name}
                                                    {r.isLeader ? " (Leader)" : ""}
                                                </option>
                                            ))}
                                        </select>
                                    </div>
                                </div>
                                <Button type="submit" disabled={saving || !departments.length || !roles.length}>
                                    {editingMemberId ? (
                                        <>
                                            <Check className="h-4 w-4" />
                                            Save member
                                        </>
                                    ) : (
                                        <>
                                            <Plus className="h-4 w-4" />
                                            Add member
                                        </>
                                    )}
                                </Button>
                                {(!departments.length || !roles.length) && (
                                    <p className="text-[11px] text-(--warning)">
                                        Create at least one department and role first.
                                    </p>
                                )}
                            </form>

                            <div>
                                <div className="flex items-center justify-between px-1 mb-3">
                                    <h3 className="text-sm font-semibold text-foreground">
                                        Current members ({teamMembers.length})
                                    </h3>
                                    {teamMembers.length > 0 && (
                                        <div className="flex items-center gap-2 text-[11px] text-foreground-muted">
                                            <span className="inline-flex items-center gap-1">
                                                <span className="w-2 h-2 rounded-full bg-emerald-400" />
                                                {teamMembers.filter((m) => m.status === "active").length} active
                                            </span>
                                            <span className="inline-flex items-center gap-1">
                                                <span className="w-2 h-2 rounded-full bg-rose-400" />
                                                {teamMembers.filter((m) => m.status === "blocked").length} blocked
                                            </span>
                                        </div>
                                    )}
                                </div>
                                <div className="space-y-2">
                                    {teamMembers.map((m) => {
                                        const avatarColors = [
                                            "bg-rose-500/20 text-rose-400",
                                            "bg-blue-500/20 text-blue-400",
                                            "bg-emerald-500/20 text-emerald-400",
                                            "bg-amber-500/20 text-amber-400",
                                            "bg-violet-500/20 text-violet-400",
                                            "bg-blue-500/20 text-(--vb-blue-bright)",
                                        ];
                                        let hash = 0;
                                        for (let i = 0; i < m.fullName.length; i++) hash = m.fullName.charCodeAt(i) + ((hash << 5) - hash);
                                        const colorClass = avatarColors[Math.abs(hash) % avatarColors.length];
                                        const initials = m.fullName.trim().split(/\s+/).length >= 2
                                            ? (m.fullName.trim().split(/\s+/)[0][0] + m.fullName.trim().split(/\s+/)[1][0]).toUpperCase()
                                            : (m.fullName.trim()[0] || "?").toUpperCase();

                                        return (
                                            <div key={m.userId} className="surface-card px-4 py-3 flex items-start gap-3 hover:border-border-strong transition-colors">
                                                <div className={`h-10 w-10 rounded-xl ${colorClass} flex items-center justify-center shrink-0 font-semibold text-sm`}>
                                                    {initials}
                                                </div>
                                                <div className="min-w-0 flex-1">
                                                    <div className="flex items-center gap-2 flex-wrap">
                                                        <p className="text-sm font-medium text-foreground truncate">
                                                            {m.fullName}
                                                        </p>
                                                        {m.status === "blocked" && <Badge variant="error">Blocked</Badge>}
                                                        {editingMemberId === m.userId && (
                                                            <Badge variant="warning">Editing</Badge>
                                                        )}
                                                    </div>
                                                    <p className="text-[11px] text-foreground-muted truncate">{m.email}</p>
                                                    <div className="flex flex-wrap gap-1.5 mt-2">
                                                        <Badge variant={m.primaryDepartmentId ? "accent" : "muted"}>
                                                            <Building2 size={10} />
                                                            {m.primaryDepartmentId
                                                                ? deptNameById[m.primaryDepartmentId] || "Assigned"
                                                                : "No department"}
                                                        </Badge>
                                                        {m.orgRoleId && (
                                                            <Badge variant={roles.find((r) => r.roleId === m.orgRoleId)?.isLeader ? "warning" : "default"}>
                                                                {roleNameById[m.orgRoleId] || "Role"}
                                                            </Badge>
                                                        )}
                                                    </div>
                                                </div>
                                                <div className="flex items-center gap-0.5 shrink-0">
                                                    {m.primaryDepartmentId && (
                                                        <Link
                                                            href={`/departments/${m.primaryDepartmentId}/members/${m.userId}`}
                                                            className="p-2 rounded-lg text-foreground-muted hover:text-accent hover:bg-accent-muted"
                                                            title="View employee details"
                                                        >
                                                            <Eye className="h-4 w-4" />
                                                        </Link>
                                                    )}
                                                    <button
                                                        type="button"
                                                        onClick={() => startEditMember(m)}
                                                        className="p-2 rounded-lg text-foreground-muted hover:text-accent hover:bg-accent-muted"
                                                        title="Edit"
                                                    >
                                                        <Pencil className="h-4 w-4" />
                                                    </button>
                                                    <button
                                                        type="button"
                                                        onClick={() => toggleMemberStatus(m)}
                                                        className="p-2 rounded-lg text-foreground-muted hover:text-(--warning) hover:bg-(--warning-muted)"
                                                        title={m.status === "blocked" ? "Activate" : "Block"}
                                                    >
                                                        {m.status === "blocked" ? (
                                                            <UserCheck className="h-4 w-4" />
                                                        ) : (
                                                            <UserX className="h-4 w-4" />
                                                        )}
                                                    </button>
                                                    {m.primaryDepartmentId && (
                                                        <button
                                                            type="button"
                                                            onClick={() => removeFromDepartment(m)}
                                                            className="p-2 rounded-lg text-foreground-muted hover:text-foreground hover:bg-surface-3"
                                                            title="Remove from department"
                                                        >
                                                            <Building2 className="h-4 w-4" />
                                                        </button>
                                                    )}
                                                    <button
                                                        type="button"
                                                        onClick={() => deleteMember(m)}
                                                        className="p-2 rounded-lg text-foreground-muted hover:text-error hover:bg-error-muted"
                                                        title="Delete member"
                                                    >
                                                        <Trash2 className="h-4 w-4" />
                                                    </button>
                                                </div>
                                            </div>
                                        );
                                    })}
                                    {!teamMembers.length && (
                                        <EmptyState
                                            icon={<Users size={24} className="text-accent" />}
                                            title="No members yet"
                                            description="Add team members above to populate this list."
                                        />
                                    )}
                                </div>
                            </div>
                        </div>
                    )}
                </div>
            )}
        </div>
    );
}

export default function DepartmentsAdminPage() {
    return (
        <DepartmentsAdminContent />
    );
}
