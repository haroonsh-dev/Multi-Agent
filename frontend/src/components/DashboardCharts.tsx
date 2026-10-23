"use client";

import React, { useState, useMemo, useCallback, useRef, useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Download, SlidersHorizontal, X, Check, ChevronDown } from "lucide-react";
import {
    AreaChart, Area, XAxis, YAxis, CartesianGrid,
    BarChart, Bar, Cell, ResponsiveContainer, Tooltip,
} from "recharts";
import { downloadDashboardReport } from "@/lib/dashboardExport";

const COLORS = {
    blue: "#38b6ff", blueBright: "#7ee0ff", blueDeep: "#3f74ff",
    emerald: "#10b981", amber: "#f59e0b", rose: "#f43f5e", violet: "#8b5cf6",
};
const DEPT_COLORS = [
    COLORS.blue, COLORS.blueDeep, COLORS.emerald, COLORS.violet,
    COLORS.amber, COLORS.rose, COLORS.blueBright, COLORS.violet,
];

type UploadTrendData = { date: string; uploads: number }[];
type DepartmentData = { name: string; count: number }[];
type StatusData = { name: string; count: number }[];

type DashboardChartsProps = {
    trendData?: UploadTrendData;
    departmentData?: DepartmentData;
    loading?: boolean;
    allDocs?: any[];
    departmentNames?: Record<string, string>;
    statusData?: StatusData;
    isAdminView?: boolean;
};

const PRESETS = [
    { label: "All Time", days: 0 },
    { label: "Last 7 Days", days: 7 },
    { label: "Last Week", days: 14 },
    { label: "Last Month", days: 30 },
    { label: "Last 3 Months", days: 90 },
];

function getPresetRange(days: number): { from: string; to: string } {
    const to = new Date();
    const from = new Date();
    if (days > 0) from.setDate(from.getDate() - days);
    else from.setFullYear(2020);
    return { from: from.toISOString().slice(0, 10), to: to.toISOString().slice(0, 10) };
}

const CustomTooltip = ({ active, payload, label }: any) => {
    if (!active || !payload?.length) return null;
    return (
        <div className="bg-white/95 backdrop-blur-md px-4 py-3 shadow-xl rounded-2xl border border-slate-100">
            {label && <p className="text-xs text-slate-400 mb-1.5 font-medium">{label}</p>}
            {payload.map((entry: any, i: number) => (
                <p key={i} className="text-sm font-bold text-slate-800 flex items-center gap-2">
                    <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ backgroundColor: entry.color || entry.fill }} />
                    <span className="text-slate-500 font-medium">{entry.name}:</span>
                    {entry.value}
                </p>
            ))}
        </div>
    );
};

function LoadingSkeleton() {
    return (
        <div className="h-64 flex flex-col items-center justify-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-slate-100 animate-pulse" />
            <div className="w-20 h-3 rounded-full bg-slate-100 animate-pulse" />
        </div>
    );
}

function EmptyChart({ emoji, title, desc }: { emoji: string; title: string; desc: string }) {
    return (
        <div className="h-64 flex flex-col items-center justify-center text-center">
            <div className="w-16 h-16 rounded-2xl bg-slate-50 flex items-center justify-center mb-3"><span className="text-2xl">{emoji}</span></div>
            <p className="text-sm font-medium text-slate-500">{title}</p>
            <p className="text-xs text-slate-400 mt-1">{desc}</p>
        </div>
    );
}

function FilterDropdown({
    dateFrom, dateTo, onDateFromChange, onDateToChange, onExport, label,
}: {
    dateFrom: string; dateTo: string;
    onDateFromChange: (v: string) => void; onDateToChange: (v: string) => void;
    onExport: () => void; label: string;
}) {
    const [open, setOpen] = useState(false);
    const [custom, setCustom] = useState(false);
    const [tmpFrom, setTmpFrom] = useState(dateFrom);
    const [tmpTo, setTmpTo] = useState(dateTo);
    const ref = useRef<HTMLDivElement>(null);

    useEffect(() => {
        const handler = (e: MouseEvent) => {
            if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
        };
        document.addEventListener("mousedown", handler);
        return () => document.removeEventListener("mousedown", handler);
    }, []);

    useEffect(() => { setTmpFrom(dateFrom); setTmpTo(dateTo); }, [dateFrom, dateTo]);

    const activeLabel = useMemo(() => {
        if (!dateFrom && !dateTo) return null;
        if (dateFrom && dateTo) return `${dateFrom} → ${dateTo}`;
        if (dateFrom) return `From ${dateFrom}`;
        return `Until ${dateTo}`;
    }, [dateFrom, dateTo]);

    const applyPreset = (days: number) => {
        if (days === 0) { onDateFromChange(""); onDateToChange(""); }
        else { const r = getPresetRange(days); onDateFromChange(r.from); onDateToChange(r.to); }
        setCustom(false); setOpen(false);
    };

    const applyCustom = () => {
        onDateFromChange(tmpFrom); onDateToChange(tmpTo);
        setOpen(false);
    };

    const clearFilter = (e: React.MouseEvent) => {
        e.stopPropagation();
        onDateFromChange(""); onDateToChange("");
        setCustom(false); setTmpFrom(""); setTmpTo("");
    };

    return (
        <div ref={ref} className="relative">
            <button type="button" onClick={() => setOpen(!open)}
                className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-[11px] font-semibold rounded-lg border transition-all ${
                    activeLabel
                        ? "bg-[rgba(56,182,255,0.1)] border-[rgba(56,182,255,0.4)] text-(--vb-blue-dark) hover:bg-[rgba(56,182,255,0.14)]"
                        : "bg-white border-slate-200 text-slate-500 hover:border-[rgba(56,182,255,0.4)] hover:text-(--vb-blue-dark)"
                }`}>
                <SlidersHorizontal size={12} />
                {activeLabel || "Filter"}
                <ChevronDown size={11} className={`transition-transform ${open ? "rotate-180" : ""}`} />
            </button>

            {activeLabel && !open && (
                <button type="button" onClick={clearFilter}
                    className="absolute -right-1 -top-1 w-4 h-4 rounded-full bg-rose-400 text-white flex items-center justify-center hover:bg-rose-500 transition-colors z-10">
                    <X size={8} />
                </button>
            )}

            <AnimatePresence>
                {open && (
                    <motion.div initial={{ opacity: 0, y: -8, scale: 0.95 }} animate={{ opacity: 1, y: 0, scale: 1 }}
                        exit={{ opacity: 0, y: -8, scale: 0.95 }} transition={{ duration: 0.15 }}
                        className="absolute right-0 top-full mt-2 w-56 bg-white rounded-2xl shadow-2xl border border-slate-100 z-50 overflow-hidden">

                        {!custom ? (
                            <div className="py-1.5">
                                <p className="px-3.5 pt-1.5 pb-1 text-[9px] font-bold text-slate-400 uppercase tracking-widest">{label}</p>
                                {PRESETS.map((p, i) => (
                                    <button key={i} type="button" onClick={() => applyPreset(p.days)}
                                        className="w-full px-3.5 py-2.5 text-[12px] font-medium text-slate-600 hover:bg-[rgba(56,182,255,0.1)] hover:text-(--vb-blue-dark) flex items-center justify-between transition-colors">
                                        {p.label}
                                        {(!dateFrom && !dateTo && p.days === 0) || (dateFrom === getPresetRange(p.days).from && dateTo === getPresetRange(p.days).to) ? (
                                            <Check size={13} className="text-(--vb-blue)" />
                                        ) : null}
                                    </button>
                                ))}
                                <div className="mx-3 my-1 border-t border-slate-100" />
                                <button type="button" onClick={() => setCustom(true)}
                                    className="w-full px-3.5 py-2.5 text-[12px] font-medium text-slate-600 hover:bg-[rgba(56,182,255,0.1)] hover:text-(--vb-blue-dark) flex items-center gap-2 transition-colors">
                                    <SlidersHorizontal size={12} /> Custom Range
                                </button>
                            </div>
                        ) : (
                            <div className="p-3.5">
                                <div className="flex items-center justify-between mb-3">
                                    <p className="text-[11px] font-bold text-slate-600">Custom Range</p>
                                    <button type="button" onClick={() => setCustom(false)}
                                        className="text-slate-400 hover:text-slate-600 transition-colors">
                                        <ChevronDown size={14} className="rotate-90" />
                                    </button>
                                </div>
                                <div className="space-y-2.5">
                                    <div className="flex flex-col gap-1">
                                        <label className="text-[9px] font-bold text-slate-400 uppercase tracking-wider">Start Date</label>
                                        <input type="date" value={tmpFrom} onChange={(e) => setTmpFrom(e.target.value)}
                                            className="premium-input rounded-lg py-2 px-3 text-xs" />
                                    </div>
                                    <div className="flex flex-col gap-1">
                                        <label className="text-[9px] font-bold text-slate-400 uppercase tracking-wider">End Date</label>
                                        <input type="date" value={tmpTo} onChange={(e) => setTmpTo(e.target.value)}
                                            className="premium-input rounded-lg py-2 px-3 text-xs" />
                                    </div>
                                </div>
                                <div className="flex gap-2 mt-4">
                                    <button type="button" onClick={() => { setCustom(false); setTmpFrom(dateFrom); setTmpTo(dateTo); }}
                                        className="flex-1 py-2 text-[11px] font-semibold rounded-lg border border-slate-200 text-slate-500 hover:bg-slate-50 transition-all">
                                        Cancel
                                    </button>
                                    <button type="button" onClick={applyCustom}
                                        className="flex-1 py-2 text-[11px] font-semibold rounded-lg btn-primary hover:shadow-md transition-all">
                                        Apply
                                    </button>
                                </div>
                            </div>
                        )}
                    </motion.div>
                )}
            </AnimatePresence>
        </div>
    );
}

export default function DashboardCharts({
    trendData = [],
    departmentData = [],
    loading = false,
    allDocs = [],
    departmentNames = {},
    statusData = [],
    isAdminView = false,
}: DashboardChartsProps) {
    const [trendFrom, setTrendFrom] = useState("");
    const [trendTo, setTrendTo] = useState("");
    const [deptFrom, setDeptFrom] = useState("");
    const [deptTo, setDeptTo] = useState("");

    const hasTrend = trendData.length > 0;
    const hasDept = departmentData.length > 0;
    const hasStatus = statusData.some((item) => item.count > 0);

    const filteredTrendData = useMemo(() => {
        if (!trendFrom && !trendTo) return trendData;
        return trendData.filter((d: any) => {
            const raw = d.rawDate || d.date;
            const date = new Date(raw);
            if (isNaN(date.getTime())) return true;
            if (trendFrom) { const f = new Date(trendFrom); f.setHours(0, 0, 0, 0); if (date < f) return false; }
            if (trendTo) { const t = new Date(trendTo); t.setHours(23, 59, 59, 999); if (date > t) return false; }
            return true;
        });
    }, [trendData, trendFrom, trendTo]);

    const filteredDeptData = useMemo(() => {
        if (!deptFrom && !deptTo) return departmentData;
        let filtered = allDocs;
        if (deptFrom) { const f = new Date(deptFrom); f.setHours(0, 0, 0, 0); filtered = filtered.filter((d: any) => new Date(d.createdAt) >= f); }
        if (deptTo) { const t = new Date(deptTo); t.setHours(23, 59, 59, 999); filtered = filtered.filter((d: any) => new Date(d.createdAt) <= t); }
        const deptCounts: Record<string, number> = {};
        filtered.forEach((d: any) => {
            const id = d.departmentId || "Unassigned";
            const label = id === "Unassigned" ? id : departmentNames[id] || id;
            deptCounts[label] = (deptCounts[label] || 0) + 1;
        });
        return Object.entries(deptCounts)
            .map(([name, count]) => ({ name: name.length > 18 ? `${name.slice(0, 16)}…` : name, count }))
            .sort((a, b) => b.count - a.count).slice(0, 8);
    }, [departmentData, deptFrom, deptTo, allDocs, departmentNames]);

    const exportTrendReport = useCallback(() => {
        if (!allDocs.length && !filteredTrendData.length) return;
        downloadDashboardReport(allDocs, {
            title: "Visibility Docs — Uploads Report",
            dateFrom: trendFrom || undefined,
            dateTo: trendTo || undefined,
            departmentNames,
            filename: `uploads-report_${trendFrom || "all"}_${trendTo || "all"}.xls`,
        });
    }, [allDocs, filteredTrendData.length, trendFrom, trendTo, departmentNames]);

    const exportDeptReport = useCallback(() => {
        if (!allDocs.length && !filteredDeptData.length) return;
        downloadDashboardReport(allDocs, {
            title: "Visibility Docs — Department Report",
            dateFrom: deptFrom || undefined,
            dateTo: deptTo || undefined,
            departmentNames,
            filename: `department-report_${deptFrom || "all"}_${deptTo || "all"}.xls`,
        });
    }, [allDocs, filteredDeptData.length, deptFrom, deptTo, departmentNames]);

    return (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
            {/* Uploads Over Time */}
            <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.15, duration: 0.5, ease: [0.22, 1, 0.36, 1] }}
                className="chart-card overflow-hidden">
                <div className="chart-card-header flex items-center justify-between">
                    <div>
                        <h3 className="text-sm font-bold text-slate-800">Uploads Over Time</h3>
                        <p className="text-[11px] text-slate-400 mt-0.5">Document upload activity</p>
                    </div>
                    <div className="flex items-center gap-2">
                        <FilterDropdown
                            dateFrom={trendFrom} dateTo={trendTo}
                            onDateFromChange={setTrendFrom} onDateToChange={setTrendTo}
                            onExport={exportTrendReport} label="Uploads Filter"
                        />
                        <button type="button" onClick={exportTrendReport}
                            className="p-2 rounded-lg btn-primary shadow-sm hover:shadow-md transition-all"
                            title="Export full report (Excel)">
                            <Download size={13} />
                        </button>
                    </div>
                </div>
                <div className="chart-card-body">
                    {loading ? <LoadingSkeleton /> : !hasTrend ? <EmptyChart emoji="📈" title="No upload data" desc="Upload documents to see trends" /> : (
                        <ResponsiveContainer width="100%" height={280}>
                            <AreaChart data={filteredTrendData}>
                                <defs>
                                    <linearGradient id="uploadGrad" x1="0" y1="0" x2="0" y2="1">
                                        <stop offset="0%" stopColor={COLORS.blue} stopOpacity={0.2} />
                                        <stop offset="95%" stopColor={COLORS.blue} stopOpacity={0} />
                                    </linearGradient>
                                </defs>
                                <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
                                <XAxis dataKey="date" tick={{ fontSize: 11, fill: "#94a3b8" }} tickLine={false} axisLine={false} />
                                <YAxis tick={{ fontSize: 11, fill: "#94a3b8" }} tickLine={false} axisLine={false} allowDecimals={false} />
                                <Tooltip content={<CustomTooltip />} />
                                <Area type="monotone" dataKey="uploads" name="Uploads" stroke={COLORS.blue} strokeWidth={2.5} fill="url(#uploadGrad)" animationDuration={1000} />
                            </AreaChart>
                        </ResponsiveContainer>
                    )}
                </div>
            </motion.div>

            {/* Role-aware distribution: departments for admins, personal status for employees */}
            <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.25, duration: 0.5, ease: [0.22, 1, 0.36, 1] }}
                className="chart-card overflow-hidden">
                <div className="chart-card-header flex items-center justify-between">
                    <div>
                        <h3 className="text-sm font-bold text-slate-800">
                            {isAdminView ? "Documents by Department" : "My Documents by Status"}
                        </h3>
                        <p className="text-[11px] text-slate-400 mt-0.5">
                            {isAdminView
                                ? "Distribution across departments"
                                : "Current state of documents you uploaded"}
                        </p>
                    </div>
                    {isAdminView && (
                        <div className="flex items-center gap-2">
                            <FilterDropdown
                                dateFrom={deptFrom} dateTo={deptTo}
                                onDateFromChange={setDeptFrom} onDateToChange={setDeptTo}
                                onExport={exportDeptReport} label="Department Filter"
                            />
                            <button type="button" onClick={exportDeptReport}
                                className="p-2 rounded-lg btn-primary shadow-sm hover:shadow-md transition-all"
                                title="Export full report (Excel)">
                                <Download size={13} />
                            </button>
                        </div>
                    )}
                </div>
                <div className="chart-card-body">
                    {loading ? <LoadingSkeleton /> : isAdminView && !hasDept ? (
                        <EmptyChart emoji="🏢" title="No department data" desc="Documents will appear by department" />
                    ) : !isAdminView && !hasStatus ? (
                        <EmptyChart emoji="📄" title="No document status data" desc="Upload a document to see its progress" />
                    ) : (
                        <ResponsiveContainer width="100%" height={280}>
                            <BarChart data={isAdminView ? filteredDeptData : statusData} layout="vertical">
                                <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" horizontal={false} />
                                <XAxis type="number" tick={{ fontSize: 11, fill: "#94a3b8" }} tickLine={false} axisLine={false} allowDecimals={false} />
                                <YAxis dataKey="name" type="category" tick={{ fontSize: 11, fill: "#94a3b8" }} tickLine={false} axisLine={false} width={80} />
                                <Tooltip content={<CustomTooltip />} />
                                <Bar dataKey="count" name="Documents" radius={[0, 6, 6, 0]} barSize={18} animationDuration={800}>
                                    {(isAdminView ? filteredDeptData : statusData).map((_, index) => (
                                        <Cell key={`cell-${index}`} fill={DEPT_COLORS[index % DEPT_COLORS.length]} />
                                    ))}
                                </Bar>
                            </BarChart>
                        </ResponsiveContainer>
                    )}
                </div>
            </motion.div>
        </div>
    );
}
