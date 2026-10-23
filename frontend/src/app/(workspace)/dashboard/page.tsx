"use client";

import React, { useEffect, useState, useCallback, useMemo } from "react";
import Link from "next/link";
import { motion, AnimatePresence } from "framer-motion";
import {
    Activity,
    ArrowRight,
    Building2,
    Crown,
    Download,
    FileText,
    MessageSquare,
    RefreshCw,
    ShieldCheck,
    CreditCard,
    Users,
    X,
    Phone,
    Mail,
    Calendar,
    User,
    ExternalLink,
    Filter,
} from "lucide-react";
import DashboardStats from "@/components/DashboardStats";
import DashboardCharts from "@/components/DashboardCharts";
import DashboardInsights from "@/components/DashboardInsights";
import { Badge, PageHeader } from "@/components/ui";
import { apiRequest } from "@/lib/apiClient";
import { downloadDashboardReport } from "@/lib/dashboardExport";
import { usePermissions } from "@/context/PermissionsContext";

type DashboardData = {
    stats: { total: number; processed: number; processing: number; failed: number };
    trendData: { date: string; uploads: number }[];
    departmentData: { name: string; count: number }[];
    statusData: { name: string; count: number }[];
    allDocs: any[];
    recentActivity: any[];
    departmentNames: Record<string, string>;
};

type TeamIdentity = {
    fullName?: string;
    organization?: {
        organizationId?: string;
        organizationName?: string;
        status?: string;
    } | null;
    department?: {
        departmentId: string;
        name: string;
        slug?: string;
        allowedDocumentTypes?: string[];
    } | null;
    orgRole?: {
        roleId: string;
        name: string;
        isLeader?: boolean;
        rank?: number;
    } | null;
};

const stagger = {
    hidden: { opacity: 0 },
    show: { opacity: 1, transition: { staggerChildren: 0.1 } },
};
const fadeUp = {
    hidden: { opacity: 1, y: 0 },
    show: {
        opacity: 1,
        y: 0,
        transition: { duration: 0.5, ease: [0.22, 1, 0.36, 1] as [number, number, number, number] },
    },
};

function DashboardContent() {
    const { role, ready, canAccessPage, user: contextUser } = usePermissions();
    const isAdminView = role === "admin" || role === "superAdmin";
    const userId =
        typeof contextUser?.userId === "string" ? (contextUser.userId as string) : undefined;
    // Only personalize after PermissionsContext is ready (post-mount) to avoid SSR/client mismatch
    const displayName =
        ready && typeof contextUser?.fullName === "string"
            ? (contextUser.fullName as string)
            : undefined;
    const [data, setData] = useState<DashboardData>({
        stats: { total: 0, processed: 0, processing: 0, failed: 0 },
        trendData: [],
        departmentData: [],
        statusData: [],
        allDocs: [],
        recentActivity: [],
        departmentNames: {},
    });
    const [adminsData, setAdminsData] = useState<any[]>([]);
    const [selectedCompany, setSelectedCompany] = useState<any | null>(null);
    const [rawAllDocs, setRawAllDocs] = useState<any[]>([]);
    const [rawActivity, setRawActivity] = useState<any[]>([]);
    const [departmentNamesState, setDepartmentNamesState] = useState<Record<string, string>>({});
    const [showCompanyModal, setShowCompanyModal] = useState(false);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);

    // Identity comes from PermissionsContext (already cached + refreshed in background) —
    // no second /auth/me round trip on the dashboard critical path.
    const teamIdentity = useMemo<TeamIdentity | null>(() => {
        if (isAdminView) return null;
        if (!contextUser) return null;
        return {
            fullName: typeof contextUser.fullName === "string" ? contextUser.fullName : undefined,
            organization: (contextUser.organization as TeamIdentity["organization"]) || null,
            department: (contextUser.department as TeamIdentity["department"]) || null,
            orgRole: (contextUser.orgRole as TeamIdentity["orgRole"]) || null,
        };
    }, [isAdminView, contextUser]);

    const buildData = useCallback((
        docs: any[],
        departmentNames: Record<string, string>,
        recentActivity: any[]
    ) => {
        const total = docs.length;
        const processed = docs.filter((d: any) =>
            ["ready", "processed", "completed", "done"].includes((d.status || "").toLowerCase())
        ).length;
        const processing = docs.filter((d: any) =>
            ["processing", "uploaded", "queued"].includes((d.status || "").toLowerCase())
        ).length;
        const failed = docs.filter((d: any) => {
            const s = (d.status || "").toLowerCase();
            return s === "failed" || s.includes("fail") || s.includes("error");
        }).length;

        const uploadCounts: Record<string, number> = {};
        docs.forEach((d: any) => {
            if (d.createdAt) {
                const date = new Date(d.createdAt).toLocaleDateString("en-US", {
                    month: "short",
                    day: "numeric",
                });
                uploadCounts[date] = (uploadCounts[date] || 0) + 1;
            }
        });
        const trendData = Object.entries(uploadCounts)
            .map(([date, uploads]) => ({ date, uploads }))
            .slice(-14);

        const deptCounts: Record<string, number> = {};
        docs.forEach((d: any) => {
            const id = d.departmentId || "Unassigned";
            const label = id === "Unassigned" ? id : departmentNames[id] || id;
            deptCounts[label] = (deptCounts[label] || 0) + 1;
        });
        const departmentData = Object.entries(deptCounts)
            .map(([name, count]) => ({
                name: name.length > 18 ? `${name.slice(0, 16)}…` : name,
                count,
            }))
            .sort((a, b) => b.count - a.count)
            .slice(0, 8);

        const other = Math.max(0, total - processed - processing - failed);
        const statusData = [
            { name: "Ready", count: processed },
            { name: "Processing", count: processing },
            { name: "Failed", count: failed },
            { name: "Other", count: other },
        ];

        setData({
            stats: { total, processed, processing, failed },
            trendData,
            departmentData,
            statusData,
            allDocs: docs,
            recentActivity,
            departmentNames,
        });
    }, []);

    const loadDashboard = useCallback(async () => {
        if (!ready) return;
        setLoading(true);
        setError(null);
        try {
            const statsParams = new URLSearchParams();
            if (!isAdminView && userId) {
                statsParams.set("uploadedBy", userId);
            }
            if (selectedCompany) {
                const orgId = selectedCompany.organizationId || selectedCompany.organization?.organizationId;
                if (orgId) statsParams.set("organizationId", orgId);
            }

            const params = new URLSearchParams({
                page: "1",
                limit: "100",
                sortBy: "createdAt",
                sortOrder: "desc",
                withDuplicates: "false",
            });
            if (!isAdminView && userId) {
                params.set("uploadedBy", userId);
            }
            const activityParams = new URLSearchParams({ page: "1", limit: "8" });
            if (!isAdminView && userId) {
                activityParams.set("actorUserId", userId);
            }

            const isSuperAdmin = role === "superAdmin";

            const [statsRes, docsRes, deptRes, activityRes, superAdminRes] = await Promise.all([
                apiRequest(`/docs/stats?${statsParams}`).catch(() => null),
                apiRequest(`/docs/documents?${params}`).catch(() => null),
                isAdminView ? apiRequest(`/docs/departments`).catch(() => null) : Promise.resolve(null),
                apiRequest(`/docs/activity?${activityParams}`).catch(() => null),
                isSuperAdmin ? apiRequest("/docs/super-admin/admins").catch(() => null) : Promise.resolve(null),
            ]);

            const docs = docsRes?.data?.documents || [];
            const departments = deptRes?.data?.departments || deptRes?.data || [];
            const recentActivity = activityRes?.data?.logs || [];

            if (isSuperAdmin && superAdminRes?.data?.admins) {
                setAdminsData(superAdminRes.data.admins);
            }

            const departmentNames: Record<string, string> = {};
            if (Array.isArray(departments)) {
                for (const d of departments) {
                    const id = d.departmentId || d.id;
                    const name = d.name || d.departmentName;
                    if (id && name) departmentNames[id] = name;
                }
            }

            setRawAllDocs(docs);
            setRawActivity(recentActivity);
            setDepartmentNamesState(departmentNames);

            if (statsRes?.data?.stats) {
                const backendStats = statsRes.data.stats;
                const backendTrend = (statsRes.data.trendData || []).map((t: any) => ({
                    date: t.date || t.rawDate,
                    uploads: t.uploads
                }));
                const backendDept = (statsRes.data.departmentData || []).map((d: any) => {
                    const label = d.name === "Unassigned" ? "Unassigned" : departmentNames[d.departmentId || d.name] || d.name || d.departmentId;
                    return {
                        name: label.length > 18 ? `${label.slice(0, 16)}…` : label,
                        count: d.count
                    };
                });
                const backendStatus = (statsRes.data.statusData || []).map((s: any) => ({
                    name: s.name,
                    count: s.count
                }));

                setData({
                    stats: backendStats,
                    trendData: backendTrend,
                    departmentData: backendDept,
                    statusData: backendStatus,
                    allDocs: docs,
                    recentActivity,
                    departmentNames,
                });
            } else {
                buildData(docs, departmentNames, recentActivity);
            }
        } catch (e: any) {
            setError(e.message || "Failed to load dashboard");
        } finally {
            setLoading(false);
        }
    }, [ready, isAdminView, role, userId, selectedCompany, buildData]);

    useEffect(() => {
        loadDashboard();
    }, [loadDashboard]);

    const exportFullReport = () => {
        if (!data.allDocs.length) return;
        downloadDashboardReport(data.allDocs, {
            title: "DocuGemma AI — Full Dashboard Report",
            departmentNames: data.departmentNames,
            filename: `docugemma-dashboard-full_${new Date().toISOString().slice(0, 10)}.xls`,
        });
    };

    return (
        <div className="p-4 sm:p-6 lg:p-8 space-y-6 max-w-7xl mx-auto">
            <motion.div
                initial={{ opacity: 0, y: -10 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.4 }}
            >
                <PageHeader
                    title="Dashboard"
                    subtitle={
                        isAdminView
                            ? "Organization overview — documents, uploads, team activity, and analytics."
                            : `Your documents, processing status, and activity${displayName ? ` — ${displayName}` : ""}.`
                    }
                    actions={
                        <div className="flex flex-wrap gap-2">
                            <button
                                type="button"
                                onClick={exportFullReport}
                                disabled={!data.allDocs.length}
                                className="btn-gradient rounded-xl px-4 py-2.5 text-sm inline-flex items-center gap-2 disabled:opacity-40"
                                title="Export full Excel report with file list and stats"
                            >
                                <Download size={14} /> Export report
                            </button>
                            <button
                                type="button"
                                onClick={loadDashboard}
                                className="btn-secondary rounded-xl px-4 py-2.5 text-sm inline-flex items-center gap-2"
                            >
                                <RefreshCw size={14} className={loading ? "animate-spin" : ""} />{" "}
                                Refresh
                            </button>
                        </div>
                    }
                />
                {!isAdminView && teamIdentity?.organization?.organizationName && (
                    <div className="mt-3 inline-flex items-center gap-1.5 rounded-full border border-[rgba(56,182,255,0.28)] bg-[rgba(56,182,255,0.08)] px-3 py-1 text-xs font-medium text-(--vb-blue-dark)">
                        <Building2 size={13} />
                        {teamIdentity.organization.organizationName}
                    </div>
                )}
            </motion.div>

            {error && (
                <motion.div
                    initial={{ opacity: 0, y: -10 }}
                    animate={{ opacity: 1, y: 0 }}
                    className="rounded-2xl border border-rose-200 bg-linear-to-r from-rose-50 to-red-50 text-rose-700 px-5 py-4 text-sm flex items-center gap-3"
                >
                    <div className="w-8 h-8 rounded-lg bg-rose-100 flex items-center justify-center shrink-0">
                        <span className="text-rose-600 text-lg">⚠</span>
                    </div>
                    {error}
                </motion.div>
            )}

            {role === "superAdmin" && ready && !loading && (
                <motion.section
                    initial={{ opacity: 0, y: 12 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ delay: 0.05, duration: 0.4 }}
                    className="surface-card overflow-hidden border border-[rgba(56,182,255,0.2)] shadow-xl"
                >
                    <div className="p-5 sm:p-6 border-b border-white/8 bg-linear-to-r from-[rgba(56,182,255,0.1)] via-[rgba(56,182,255,0.05)] to-transparent flex flex-wrap items-center justify-between gap-4">
                        <div className="flex items-center gap-3">
                            <div className="h-11 w-11 rounded-xl bg-(--vb-blue) text-(--vb-color-primary-btn-fg) flex items-center justify-center shadow-md">
                                <Building2 size={22} />
                            </div>
                            <div>
                                <div className="flex items-center gap-2">
                                    <h2 className="text-lg font-bold text-slate-900 dark:text-white">
                                        Tenant & Company Directory
                                    </h2>
                                    <span className="px-2.5 py-0.5 rounded-full text-xs font-bold bg-[rgba(56,182,255,0.15)] text-(--vb-blue-dark) dark:text-(--vb-blue-bright) border border-[rgba(56,182,255,0.2)]">
                                        {adminsData.length} {adminsData.length === 1 ? "Company" : "Companies"}
                                    </span>
                                </div>
                                <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
                                    Real-time overview of tenant organizations, active plans, uploaded documents, and admin management.
                                </p>
                            </div>
                        </div>
                        <Link
                            href="/admin/admins"
                            className="btn-secondary rounded-xl px-3.5 py-2 text-xs font-semibold inline-flex items-center gap-1.5"
                        >
                            Manage Admins <ArrowRight size={13} />
                        </Link>
                    </div>

                    <div className="overflow-x-auto">
                        <table className="w-full text-left text-xs">
                            <thead className="bg-slate-500/5 text-slate-500 dark:text-slate-400 uppercase text-[10px] tracking-wider font-semibold border-b border-slate-200/50 dark:border-white/5">
                                <tr>
                                    <th className="py-3 px-4">Company / Org</th>
                                    <th className="py-3 px-4">Admin Contact</th>
                                    <th className="py-3 px-4">Subscription Plan</th>
                                    <th className="py-3 px-4">Uploaded Docs</th>
                                    <th className="py-3 px-4">Team Size</th>
                                    <th className="py-3 px-4">Status</th>
                                </tr>
                            </thead>
                            <tbody className="divide-y divide-slate-200/50 dark:divide-white/5 text-slate-700 dark:text-slate-300 font-medium">
                                {adminsData.length === 0 ? (
                                    <tr>
                                        <td colSpan={6} className="py-8 text-center text-slate-400">
                                            No tenant organizations registered yet.
                                        </td>
                                    </tr>
                                ) : (
                                    adminsData.map((admin: any) => {
                                        const orgName = admin.organization?.organizationName || "No Org Name";
                                        const rawPlan = admin.organization?.subscriptionPlan || "free";
                                        const plan = rawPlan.toUpperCase();
                                        const docCount = admin.documentCount || 0;
                                        const memberCount = admin.teamMemberCount || 0;
                                        const status = admin.status || "active";
                                        const isSelected = selectedCompany?._id === admin._id || selectedCompany?.userId === admin.userId;

                                        return (
                                            <tr
                                                key={admin._id || admin.userId}
                                                onClick={() => setSelectedCompany(admin)}
                                                className={`cursor-pointer transition-all ${
                                                    isSelected
                                                        ? "bg-[rgba(56,182,255,0.15)] dark:bg-[rgba(56,182,255,0.2)] font-semibold"
                                                        : "hover:bg-[rgba(56,182,255,0.06)]"
                                                }`}
                                                title="Click to view company details"
                                            >
                                                <td className="py-3.5 px-4 font-semibold text-slate-900 dark:text-white">
                                                    <div className="flex items-center gap-2.5">
                                                        <div className="w-8 h-8 rounded-lg bg-[rgba(56,182,255,0.1)] text-(--vb-blue-dark) dark:text-(--vb-blue-bright) flex items-center justify-center shrink-0 border border-[rgba(56,182,255,0.2)]">
                                                            <Building2 size={15} />
                                                        </div>
                                                        <div>
                                                            <p className="truncate text-xs font-bold text-(--vb-blue-dark) dark:text-(--vb-blue-bright) hover:underline">
                                                                {orgName}
                                                            </p>
                                                            <p className="text-[10px] text-slate-400 font-normal">ID: {admin.organizationId || "N/A"}</p>
                                                        </div>
                                                    </div>
                                                </td>
                                                <td className="py-3.5 px-4">
                                                    <div>
                                                        <p className="font-semibold text-slate-800 dark:text-slate-200">{admin.fullName || "Admin"}</p>
                                                        <p className="text-[10px] text-slate-400 truncate">{admin.email}</p>
                                                    </div>
                                                </td>
                                                <td className="py-3.5 px-4">
                                                    <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-[11px] font-bold uppercase tracking-wider border ${
                                                        plan.includes("PRO") || plan.includes("ENTERPRISE")
                                                            ? "bg-purple-500/10 text-purple-600 dark:text-purple-400 border-purple-500/20"
                                                            : "bg-[rgba(56,182,255,0.1)] text-(--vb-blue-dark) dark:text-(--vb-blue-bright) border-[rgba(56,182,255,0.2)]"
                                                    }`}>
                                                        <CreditCard size={12} />
                                                        {plan}
                                                    </span>
                                                </td>
                                                <td className="py-3.5 px-4">
                                                    <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-[11px] font-bold bg-blue-500/10 text-(--vb-blue-dark) dark:text-(--vb-blue-bright) border border-[rgba(56,182,255,0.2)]">
                                                        <FileText size={12} />
                                                        {docCount} {docCount === 1 ? "doc" : "docs"}
                                                    </span>
                                                </td>
                                                <td className="py-3.5 px-4">
                                                    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-semibold text-slate-600 dark:text-slate-300">
                                                        <Users size={12} className="text-slate-400" />
                                                        {memberCount} members
                                                    </span>
                                                </td>
                                                <td className="py-3.5 px-4">
                                                    <Badge variant={status === "active" ? "success" : "error"}>
                                                        {status}
                                                    </Badge>
                                                </td>
                                            </tr>
                                        );
                                    })
                                )}
                            </tbody>
                        </table>
                    </div>
                </motion.section>
            )}

            {/* Company Details Modal */}
            <AnimatePresence>
                {showCompanyModal && selectedCompany && (
                    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-md">
                        <motion.div
                            initial={{ opacity: 0, scale: 0.95, y: 10 }}
                            animate={{ opacity: 1, scale: 1, y: 0 }}
                            exit={{ opacity: 0, scale: 0.95, y: 10 }}
                            className="bg-slate-900 border border-[rgba(56,182,255,0.3)] text-slate-100 rounded-2xl shadow-2xl max-w-2xl w-full max-h-[90vh] flex flex-col overflow-hidden relative"
                        >
                            {/* Modal Header */}
                            <div className="p-5 border-b border-white/10 bg-linear-to-r from-[rgba(56,182,255,0.1)] via-[rgba(56,182,255,0.05)] to-transparent flex items-center justify-between">
                                <div className="flex items-center gap-3">
                                    <div className="w-12 h-12 rounded-xl bg-(--vb-blue) text-(--vb-color-primary-btn-fg) flex items-center justify-center shadow-lg font-bold">
                                        <Building2 size={24} />
                                    </div>
                                    <div>
                                        <div className="flex items-center gap-2">
                                            <h3 className="text-lg font-bold text-white">
                                                {selectedCompany.organization?.organizationName || "Company Details"}
                                            </h3>
                                            <Badge variant={selectedCompany.status === "active" ? "success" : "error"}>
                                                {selectedCompany.status || "active"}
                                            </Badge>
                                        </div>
                                        <p className="text-xs text-slate-400 font-mono">
                                            Org ID: {selectedCompany.organizationId || selectedCompany.organization?.organizationId || "N/A"}
                                        </p>
                                    </div>
                                </div>
                                <button
                                    type="button"
                                    onClick={() => setShowCompanyModal(false)}
                                    className="p-2 rounded-xl text-slate-400 hover:text-white hover:bg-white/10 transition-colors"
                                >
                                    <X size={18} />
                                </button>
                            </div>

                            {/* Modal Body */}
                            <div className="p-6 space-y-6 overflow-y-auto">
                                {/* Grid Info Cards */}
                                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                                    <div className="p-3.5 rounded-xl bg-white/5 border border-white/10">
                                        <p className="text-[10px] uppercase font-bold text-slate-400 flex items-center gap-1.5">
                                            <CreditCard size={12} className="text-(--vb-blue-bright)" /> Subscription Plan
                                        </p>
                                        <p className="text-sm font-extrabold text-(--vb-blue-bright) mt-1 uppercase">
                                            {selectedCompany.organization?.subscriptionPlan || "FREE"}
                                        </p>
                                    </div>
                                    <div className="p-3.5 rounded-xl bg-white/5 border border-white/10">
                                        <p className="text-[10px] uppercase font-bold text-slate-400 flex items-center gap-1.5">
                                            <FileText size={12} className="text-(--vb-blue-bright)" /> Uploaded Documents
                                        </p>
                                        <p className="text-sm font-extrabold text-(--vb-blue-bright) mt-1">
                                            {selectedCompany.documentCount || 0} Files
                                        </p>
                                    </div>
                                    <div className="p-3.5 rounded-xl bg-white/5 border border-white/10">
                                        <p className="text-[10px] uppercase font-bold text-slate-400 flex items-center gap-1.5">
                                            <Users size={12} className="text-purple-400" /> Team Members
                                        </p>
                                        <p className="text-sm font-extrabold text-purple-300 mt-1">
                                            {selectedCompany.teamMemberCount || 0} Members
                                        </p>
                                    </div>
                                </div>

                                {/* Admin Details */}
                                <div className="p-4 rounded-xl bg-slate-800/60 border border-white/5 space-y-3">
                                    <h4 className="text-xs font-bold uppercase tracking-wider text-(--vb-blue-bright) flex items-center gap-1.5">
                                        <User size={14} /> Organization Admin Contact
                                    </h4>
                                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs">
                                        <div>
                                            <span className="text-slate-400 block text-[10px]">Full Name</span>
                                            <span className="font-semibold text-slate-200">{selectedCompany.fullName || "N/A"}</span>
                                        </div>
                                        <div>
                                            <span className="text-slate-400 block text-[10px]">Email Address</span>
                                            <span className="font-semibold text-slate-200">{selectedCompany.email || "N/A"}</span>
                                        </div>
                                        {selectedCompany.contactNumber && (
                                            <div>
                                                <span className="text-slate-400 block text-[10px]">Contact Phone</span>
                                                <span className="font-semibold text-slate-200">{selectedCompany.contactNumber}</span>
                                            </div>
                                        )}
                                        {selectedCompany.createdAt && (
                                            <div>
                                                <span className="text-slate-400 block text-[10px]">Registered On</span>
                                                <span className="font-semibold text-slate-200">
                                                    {new Date(selectedCompany.createdAt).toLocaleDateString("en-US", {
                                                        year: "numeric",
                                                        month: "short",
                                                        day: "numeric",
                                                    })}
                                                </span>
                                            </div>
                                        )}
                                    </div>
                                </div>

                                {/* Team Members List */}
                                <div className="space-y-2">
                                    <h4 className="text-xs font-bold uppercase tracking-wider text-slate-400 flex items-center gap-1.5">
                                        <Users size={14} /> Registered Team Members ({selectedCompany.teamMembers?.length || 0})
                                    </h4>
                                    {selectedCompany.teamMembers && selectedCompany.teamMembers.length > 0 ? (
                                        <div className="border border-white/10 rounded-xl overflow-hidden divide-y divide-white/5 bg-slate-800/40 max-h-44 overflow-y-auto">
                                            {selectedCompany.teamMembers.map((member: any) => (
                                                <div key={member._id || member.userId} className="p-2.5 flex items-center justify-between text-xs">
                                                    <div>
                                                        <p className="font-semibold text-slate-200">{member.fullName || member.username}</p>
                                                        <p className="text-[10px] text-slate-400">{member.email}</p>
                                                    </div>
                                                    <span className="px-2 py-0.5 rounded text-[10px] font-bold uppercase bg-white/5 text-slate-300">
                                                        {member.role || "team"}
                                                    </span>
                                                </div>
                                            ))}
                                        </div>
                                    ) : (
                                        <div className="p-3 text-center text-slate-400 text-xs bg-slate-800/30 rounded-xl border border-white/5">
                                            No separate team members registered for this company yet.
                                        </div>
                                    )}
                                </div>
                            </div>

                            {/* Modal Footer Actions */}
                            <div className="p-4 border-t border-white/10 bg-slate-900/90 flex flex-wrap items-center justify-between gap-3">
                                <div className="flex items-center gap-2">
                                    <Link
                                        href={`/admin/documents?organizationId=${selectedCompany.organizationId || selectedCompany.organization?.organizationId || ""}`}
                                        className="btn-gradient rounded-xl px-3.5 py-2 text-xs font-semibold inline-flex items-center gap-1.5"
                                    >
                                        <FileText size={13} /> View Documents <ExternalLink size={12} />
                                    </Link>
                                    <Link
                                        href="/admin/admins"
                                        className="btn-secondary rounded-xl px-3.5 py-2 text-xs font-semibold inline-flex items-center gap-1.5"
                                    >
                                        Manage Admin <ArrowRight size={13} />
                                    </Link>
                                </div>
                                <button
                                    type="button"
                                    onClick={() => setShowCompanyModal(false)}
                                    className="px-4 py-2 rounded-xl text-xs font-semibold bg-white/10 hover:bg-white/20 text-slate-300 transition-colors"
                                >
                                    Close
                                </button>
                            </div>
                        </motion.div>
                    </div>
                )}
            </AnimatePresence>

            {!isAdminView && ready && !loading && (
                <motion.section
                    initial={{ opacity: 0, y: 12 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ delay: 0.05, duration: 0.4 }}
                    className={`surface-card overflow-hidden ${
                        teamIdentity?.department ? "" : "border-amber-200"
                    }`}
                >
                    {teamIdentity?.department ? (
                        <div className="relative p-5 sm:p-6">
                            <div className="absolute inset-y-0 left-0 w-1.5 bg-(--vb-blue)" />
                            <div className="flex flex-col sm:flex-row sm:items-center gap-4 sm:gap-5">
                                <div className="h-14 w-14 rounded-2xl bg-(--vb-blue) text-(--vb-color-primary-btn-fg) flex items-center justify-center shrink-0 shadow-(--vb-glow)">
                                    <Building2 size={24} />
                                </div>
                                <div className="min-w-0 flex-1">
                                    <div className="flex flex-wrap items-center gap-2 mb-1">
                                        <p className="text-[10px] font-bold uppercase tracking-[0.12em] text-(--vb-blue-dark)">
                                            Your department
                                        </p>
                                        {teamIdentity.orgRole?.isLeader && (
                                            <Badge variant="warning">
                                                <Crown size={10} /> Department leader
                                            </Badge>
                                        )}
                                    </div>
                                    <h2 className="text-xl font-bold text-slate-800 truncate">
                                        {teamIdentity.department.name}
                                    </h2>
                                    <div className="flex flex-wrap items-center gap-2 mt-2">
                                        <Badge variant="accent">
                                            <ShieldCheck size={10} />
                                            {teamIdentity.orgRole?.name || "Team member"}
                                        </Badge>
                                        {typeof teamIdentity.orgRole?.rank === "number" && (
                                            <Badge variant="default">
                                                Rank {teamIdentity.orgRole.rank}
                                            </Badge>
                                        )}
                                        {!!teamIdentity.department.allowedDocumentTypes?.length && (
                                            <span className="text-[11px] text-slate-500">
                                                {teamIdentity.department.allowedDocumentTypes.length} allowed
                                                document type
                                                {teamIdentity.department.allowedDocumentTypes.length === 1
                                                    ? ""
                                                    : "s"}
                                            </span>
                                        )}
                                    </div>
                                    <p className="text-xs text-slate-500 mt-2">
                                        This dashboard shows your own uploads and activity within the{" "}
                                        {teamIdentity.department.name} department.
                                    </p>
                                </div>
                                {canAccessPage("departments") && (
                                    <Link
                                        href={`/departments/${teamIdentity.department.departmentId}`}
                                        className="btn-secondary rounded-xl px-4 py-2.5 text-sm font-semibold inline-flex items-center justify-center gap-2 shrink-0"
                                    >
                                        Open department <ArrowRight size={14} />
                                    </Link>
                                )}
                            </div>
                        </div>
                    ) : (
                        <div className="p-5 sm:p-6 flex flex-col sm:flex-row sm:items-center gap-4 bg-amber-50/70">
                            <div className="h-12 w-12 rounded-2xl bg-amber-100 text-amber-700 flex items-center justify-center shrink-0">
                                <Building2 size={21} />
                            </div>
                            <div className="min-w-0 flex-1">
                                <h2 className="text-base font-bold text-amber-900">
                                    No department assigned
                                </h2>
                                <p className="text-xs text-amber-700 mt-1">
                                    Ask your organization admin to assign your department and role.
                                    Your personal document dashboard is still available below.
                                </p>
                            </div>
                        </div>
                    )}
                </motion.section>
            )}

            {selectedCompany && (
                <motion.div
                    initial={{ opacity: 0, y: -6 }}
                    animate={{ opacity: 1, y: 0 }}
                    className="p-4 rounded-2xl bg-linear-to-r from-[rgba(56,182,255,0.15)] via-[rgba(56,182,255,0.1)] to-[rgba(56,182,255,0.05)] border border-[rgba(56,182,255,0.3)] flex flex-wrap items-center justify-between gap-3 shadow-md"
                >
                    <div className="flex items-center gap-3">
                        <div className="w-10 h-10 rounded-xl bg-[rgba(56,182,255,0.2)] text-(--vb-blue-dark) dark:text-(--vb-blue-bright) flex items-center justify-center shrink-0 border border-[rgba(56,182,255,0.3)]">
                            <Building2 size={20} />
                        </div>
                        <div>
                            <div className="flex items-center gap-2">
                                <span className="text-[10px] uppercase font-bold text-(--vb-blue-dark) dark:text-(--vb-blue-bright) tracking-wider">Filtered View Active</span>
                                <span className="text-xs text-slate-400 font-mono">({selectedCompany.organizationId || selectedCompany.organization?.organizationId || "N/A"})</span>
                            </div>
                            <p className="text-sm font-extrabold text-slate-900 dark:text-white">
                                Showing cards & graphs for <span className="text-(--vb-blue-dark) dark:text-(--vb-blue-bright) underline">{selectedCompany.organization?.organizationName || selectedCompany.fullName}</span>
                            </p>
                        </div>
                    </div>
                    <div className="flex items-center gap-2">
                        <button
                            type="button"
                            onClick={() => setShowCompanyModal(true)}
                            className="btn-secondary rounded-xl px-3.5 py-1.5 text-xs font-semibold inline-flex items-center gap-1.5"
                        >
                            <User size={13} /> Full Details
                        </button>
                        <button
                            type="button"
                            onClick={() => setSelectedCompany(null)}
                            className="rounded-xl px-3.5 py-1.5 text-xs font-bold inline-flex items-center gap-1.5 bg-rose-500/10 text-rose-600 dark:text-rose-400 border border-rose-500/20 hover:bg-rose-500/20 transition-colors"
                        >
                            <X size={14} /> Clear Filter (Show All)
                        </button>
                    </div>
                </motion.div>
            )}

            <DashboardStats stats={data.stats} />

            <DashboardCharts
                trendData={data.trendData}
                departmentData={data.departmentData}
                statusData={data.statusData}
                loading={loading}
                allDocs={data.allDocs}
                departmentNames={data.departmentNames}
                isAdminView={isAdminView}
            />

            <DashboardInsights
                documents={data.allDocs}
                activity={data.recentActivity}
                loading={loading}
                isAdminView={isAdminView}
            />

            <motion.div variants={stagger} initial="hidden" animate="show">
                <h3 className="text-sm font-bold text-slate-800 mb-4">Quick Actions</h3>
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                    {[
                        {
                            href: "/documents",
                            icon: FileText,
                            title: "Documents",
                            desc: "Upload, manage, and search files",
                            gradient: "from-[rgba(56,182,255,0.08)] to-blue-600",
                            shadow: "shadow-(--vb-glow)",
                            allow: true,
                        },
                        {
                            href: "/chat",
                            icon: MessageSquare,
                            title: "AI Workspaces",
                            desc: "Insights and chat per Finance, HR, Legal, and more",
                            gradient: "from-blue-500 to-[rgba(63,116,255,0.06)]",
                            shadow: "shadow-(--vb-glow)",
                            allow: canAccessPage("chat"),
                        },
                        {
                            href: "/activity",
                            icon: Activity,
                            title: "Activity",
                            desc: "View recent actions and logs",
                            gradient: "from-violet-500 to-purple-500",
                            shadow: "shadow-violet-500/20",
                            allow: canAccessPage("activity"),
                        },
                    ].filter((item) => item.allow).map((item) => (
                        <motion.div key={item.href} variants={fadeUp}>
                            <Link href={item.href} className="action-card group block h-full">
                                <div
                                    className={`w-12 h-12 rounded-xl bg-linear-to-br ${item.gradient} flex items-center justify-center shrink-0 shadow-lg ${item.shadow} group-hover:scale-110 transition-transform duration-300`}
                                >
                                    <item.icon size={22} className="text-white" />
                                </div>
                                <div className="flex-1 min-w-0">
                                    <p className="text-sm font-bold text-slate-800 group-hover:text-(--vb-blue-dark) transition-colors">
                                        {item.title}
                                    </p>
                                    <p className="text-xs text-slate-500 mt-0.5">{item.desc}</p>
                                </div>
                                <ArrowRight
                                    size={16}
                                    className="text-slate-300 group-hover:text-(--vb-blue) group-hover:translate-x-1 transition-all shrink-0"
                                />
                            </Link>
                        </motion.div>
                    ))}
                </div>
            </motion.div>
        </div>
    );
}

export default function DashboardPage() {
    return <DashboardContent />;
}
