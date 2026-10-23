"use client";

import React, { useMemo } from "react";
import { motion } from "framer-motion";
import {
    BarChart, Bar, AreaChart, Area, PieChart, Pie, Cell,
    XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer
} from "recharts";
import { BarChart3, TrendingUp, PieChart as PieIcon } from "lucide-react";

export type ChartDataItem = {
    label: string;
    value: number;
    color?: string;
    documentId?: string;
    [key: string]: any;
};

export type ChartDataPayload = {
    chart_type?: "bar" | "line" | "area" | "pie";
    chartType?: "bar" | "line" | "area" | "pie";
    title?: string;
    xAxisLabel?: string;
    yAxisLabel?: string;
    data: ChartDataItem[];
};

const PALETTE = [
    "#38b6ff", "#3f74ff", "#10b981", "#8b5cf6",
    "#f59e0b", "#f43f5e", "#06b6d4", "#a855f7"
];

const CustomTooltip = ({ active, payload, label, yAxisLabel }: any) => {
    if (!active || !payload?.length) return null;
    return (
        <div className="bg-slate-900/95 backdrop-blur-md border border-white/10 text-white p-3 rounded-xl shadow-2xl text-xs font-sans">
            <p className="font-semibold text-slate-300 mb-1">{label || payload[0]?.name}</p>
            {payload.map((entry: any, index: number) => (
                <div key={index} className="flex items-center gap-2 font-bold text-sm">
                    <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ backgroundColor: entry.color || entry.fill }} />
                    <span className="text-slate-400 font-normal">{entry.name || yAxisLabel || "Value"}:</span>
                    <span>{typeof entry.value === "number" ? entry.value.toLocaleString() : entry.value}</span>
                </div>
            ))}
        </div>
    );
};

export default function ChatGraphRenderer({ chartData }: { chartData: ChartDataPayload }) {
    const hasData = !!(chartData && Array.isArray(chartData.data) && chartData.data.length > 0);

    // All hooks must run unconditionally (rules-of-hooks) — compute first, bail out later.
    const formattedData = useMemo(() => {
        if (!hasData) return [];
        return chartData.data.map((item, idx) => ({
            name: item.label || `Item ${idx + 1}`,
            value: Number(item.value) || 0,
            fill: item.color || PALETTE[idx % PALETTE.length],
            documentId: item.documentId
        }));
    }, [chartData, hasData]);

    if (!hasData) {
        return null;
    }

    const type = (chartData.chart_type || chartData.chartType || "bar").toLowerCase();
    const title = chartData.title || "Financial Visual Summary";

    const Icon = type === "pie" ? PieIcon : type === "area" || type === "line" ? TrendingUp : BarChart3;

    return (
        <motion.div
            initial={{ opacity: 0, y: 10, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            transition={{ duration: 0.4 }}
            className="my-3 overflow-hidden rounded-2xl border border-[rgba(56,182,255,0.25)] bg-linear-to-b from-slate-900/90 via-slate-900/80 to-slate-950/90 text-slate-100 shadow-xl backdrop-blur-md"
        >
            {/* Header */}
            <div className="flex items-center justify-between px-4 py-3 border-b border-white/10 bg-white/5">
                <div className="flex items-center gap-2.5">
                    <div className="w-7 h-7 rounded-lg bg-[rgba(56,182,255,0.2)] text-(--vb-blue-bright) flex items-center justify-center border border-[rgba(56,182,255,0.3)]">
                        <Icon size={14} />
                    </div>
                    <span className="text-xs font-bold tracking-wide text-white">{title}</span>
                </div>
                <span className="text-[10px] font-semibold uppercase tracking-wider text-(--vb-blue-bright) bg-[rgba(56,182,255,0.15)] px-2 py-0.5 rounded-full border border-[rgba(56,182,255,0.25)]">
                    {type === "pie" ? "Share Breakdown" : type === "area" || type === "line" ? "Trend Graph" : "Bar Graph"}
                </span>
            </div>

            {/* Body Chart */}
            <div className="p-4">
                <div className="h-64 w-full">
                    <ResponsiveContainer width="100%" height="100%">
                        {type === "pie" ? (
                            <PieChart>
                                <Pie
                                    data={formattedData}
                                    dataKey="value"
                                    nameKey="name"
                                    cx="50%"
                                    cy="50%"
                                    outerRadius={80}
                                    innerRadius={45}
                                    paddingAngle={3}
                                >
                                    {formattedData.map((entry, index) => (
                                        <Cell key={`cell-${index}`} fill={entry.fill} stroke="rgba(0,0,0,0.3)" />
                                    ))}
                                </Pie>
                                <Tooltip content={<CustomTooltip yAxisLabel={chartData.yAxisLabel} />} />
                            </PieChart>
                        ) : type === "area" || type === "line" ? (
                            <AreaChart data={formattedData}>
                                <defs>
                                    <linearGradient id="financeChartGrad" x1="0" y1="0" x2="0" y2="1">
                                        <stop offset="5%" stopColor="#38b6ff" stopOpacity={0.35} />
                                        <stop offset="95%" stopColor="#38b6ff" stopOpacity={0} />
                                    </linearGradient>
                                </defs>
                                <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.08)" />
                                <XAxis dataKey="name" tick={{ fontSize: 10, fill: "#94a3b8" }} tickLine={false} axisLine={false} />
                                <YAxis tick={{ fontSize: 10, fill: "#94a3b8" }} tickLine={false} axisLine={false} allowDecimals={false} />
                                <Tooltip content={<CustomTooltip yAxisLabel={chartData.yAxisLabel} />} />
                                <Area type="monotone" dataKey="value" stroke="#38b6ff" strokeWidth={2.5} fill="url(#financeChartGrad)" />
                            </AreaChart>
                        ) : (
                            <BarChart data={formattedData}>
                                <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.08)" vertical={false} />
                                <XAxis dataKey="name" tick={{ fontSize: 10, fill: "#94a3b8" }} tickLine={false} axisLine={false} />
                                <YAxis tick={{ fontSize: 10, fill: "#94a3b8" }} tickLine={false} axisLine={false} allowDecimals={false} />
                                <Tooltip content={<CustomTooltip yAxisLabel={chartData.yAxisLabel} />} />
                                <Bar dataKey="value" radius={[6, 6, 0, 0]} barSize={24}>
                                    {formattedData.map((entry, index) => (
                                        <Cell key={`cell-${index}`} fill={entry.fill} />
                                    ))}
                                </Bar>
                            </BarChart>
                        )}
                    </ResponsiveContainer>
                </div>
            </div>
        </motion.div>
    );
}
