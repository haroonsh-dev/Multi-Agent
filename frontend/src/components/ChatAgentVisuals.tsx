"use client";

import React, { useMemo } from "react";
import {
    ResponsiveContainer,
    BarChart,
    Bar,
    LineChart,
    Line,
    AreaChart,
    Area,
    PieChart,
    Pie,
    Cell,
    XAxis,
    YAxis,
    CartesianGrid,
    Tooltip,
} from "recharts";
import type { ChatVisualSpec } from "@/types/chatVisuals";
import { agentLabel } from "@/lib/documentAgents";
import { parseRowDocumentIds } from "@/lib/analyticsExport";

export type VisualDataPointClick = {
    spec: ChatVisualSpec;
    label: string;
    documentIds: string[];
};

const PALETTE = ["#2563eb", "#0d9488", "#7c3aed", "#d97706", "#dc2626", "#0891b2", "#4f46e5", "#059669"];

function formatValue(value: number, currency?: string): string {
    if (!Number.isFinite(value)) return "—";
    const formatted =
        value >= 1000
            ? value.toLocaleString(undefined, { maximumFractionDigits: 0 })
            : value.toLocaleString(undefined, { maximumFractionDigits: 2 });
    return currency ? `${currency} ${formatted}` : String(formatted);
}

function ChartTooltip({
    active,
    payload,
    label,
    currency,
}: {
    active?: boolean;
    payload?: Array<{ name?: string; value?: number; color?: string }>;
    label?: string;
    currency?: string;
}) {
    if (!active || !payload?.length) return null;
    return (
        <div className="rounded-xl border border-slate-200 bg-white/95 px-3 py-2 shadow-lg text-xs">
            <p className="font-semibold text-slate-800 mb-1">{label}</p>
            {payload.map((p) => (
                <p key={p.name} className="text-slate-600" style={{ color: p.color }}>
                    {p.name}: <span className="font-mono font-medium">{formatValue(Number(p.value), currency)}</span>
                </p>
            ))}
        </div>
    );
}

function SingleVisual({
    spec,
    isDark,
    embedded,
    onDataPointClick,
    onVisualAction,
}: {
    spec: ChatVisualSpec;
    isDark: boolean;
    embedded?: boolean;
    onDataPointClick?: (payload: VisualDataPointClick) => void;
    onVisualAction?: (action: NonNullable<ChatVisualSpec["actions"]>[number]) => void;
}) {
    const categoryKey = spec.categoryKey;
    const gridStroke = isDark ? "rgba(255,255,255,0.08)" : "#e2e8f0";
    const axisFill = isDark ? "#94a3b8" : "#64748b";
    const primary = spec.series[0];
    const color = primary?.color || PALETTE[0];

    const emitPointClick = (row: Record<string, string | number> | undefined) => {
        if (!row || !onDataPointClick) return;
        const ids = parseRowDocumentIds(row);
        if (!ids.length) return;
        const label = String(row[categoryKey] ?? "Selection");
        onDataPointClick({ spec, label, documentIds: ids });
    };

    const barClickProps = onDataPointClick
        ? {
              cursor: "pointer" as const,
              onClick: (barData: { payload?: Record<string, string | number> }) => {
                  emitPointClick(barData?.payload);
              },
          }
        : {};

    const useHorizontalBar =
        embedded && spec.kind === "bar" && spec.data.length > 0 && spec.data.length <= 20;
    const isPie = spec.kind === "pie";
    const isEmpty =
        spec.data.length === 0 ||
        (spec.data.length === 1 &&
            spec.series.every((s) => !Number(spec.data[0]?.[s.key])) &&
            /^(no |none$|not extracted|unknown)/i.test(String(spec.data[0]?.[categoryKey] || "")));
    const emptyMessage = spec.emptyState || "No data extracted for this chart.";
    const chartHeight = isPie
        ? embedded
            ? 200
            : 220
        : embedded
          ? Math.max(280, Math.min(420, spec.data.length * (useHorizontalBar ? 36 : 48) + 80))
          : spec.kind === "table"
            ? Math.min(360, 48 + spec.data.length * 36)
            : 260;
    const pieOuterRadius = embedded ? 68 : 80;
    const pieInnerRadius = embedded ? 42 : 50;

    return (
        <div
            className={`rounded-2xl border overflow-hidden ${
                isDark ? "border-white/10 bg-slate-900/40" : "border-border bg-surface shadow-sm"
            }`}
        >
            <div className={`px-4 py-3 border-b ${isDark ? "border-white/10" : "border-border"}`}>
                <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                        <p className="text-sm font-bold text-inherit">{spec.title}</p>
                        {spec.subtitle ? (
                            <p className={`text-[11px] mt-0.5 ${isDark ? "text-slate-400" : "text-slate-500"}`}>
                                {spec.subtitle}
                            </p>
                        ) : null}
                    </div>
                    {spec.dataQuality && spec.dataQuality.level !== "high" ? (
                        <span
                            className={`shrink-0 rounded-md px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide ${
                                spec.dataQuality.level === "low"
                                    ? isDark
                                        ? "bg-rose-500/20 text-rose-300"
                                        : "bg-rose-50 text-rose-700"
                                    : isDark
                                      ? "bg-amber-500/20 text-amber-300"
                                      : "bg-amber-50 text-amber-800"
                            }`}
                            title={(spec.dataQuality.warnings || []).join(" · ")}
                        >
                            Data {spec.dataQuality.level}
                        </span>
                    ) : spec.sourceDocumentIds?.length === 1 ? (
                        <span
                            className={`shrink-0 rounded-md px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide ${
                                isDark ? "bg-sky-500/15 text-sky-300" : "bg-sky-50 text-sky-700"
                            }`}
                        >
                            1 file
                        </span>
                    ) : null}
                </div>
                {spec.dataQuality?.warnings?.length ? (
                    <p className={`text-[10px] mt-1.5 leading-snug ${isDark ? "text-amber-200/80" : "text-amber-800/80"}`}>
                        {spec.dataQuality.warnings[0]}
                    </p>
                ) : null}
            </div>
            {isEmpty ? (
                <div
                    className={`px-4 py-8 text-center text-sm leading-relaxed ${
                        isDark ? "text-slate-400" : "text-slate-600"
                    }`}
                >
                    {emptyMessage}
                </div>
            ) : spec.kind === "table" ? (
                <div className="px-3 py-3 overflow-x-auto max-h-80">
                    <table className="min-w-full text-[12px] border-collapse">
                        <thead>
                            <tr className={isDark ? "text-slate-400" : "text-slate-500"}>
                                <th className="text-left font-semibold px-2 py-1.5 border-b border-inherit">
                                    {spec.series.find((s) => s.key === categoryKey)?.label || "Item"}
                                </th>
                                {spec.series
                                    .filter((s) => s.key !== categoryKey)
                                    .map((s) => (
                                        <th key={s.key} className="text-left font-semibold px-2 py-1.5 border-b border-inherit">
                                            {s.label}
                                        </th>
                                    ))}
                            </tr>
                        </thead>
                        <tbody>
                            {spec.data.map((row, i) => (
                                <tr
                                    key={i}
                                    className={onDataPointClick ? "cursor-pointer hover:bg-black/5 dark:hover:bg-white/5" : ""}
                                    onClick={() => emitPointClick(row)}
                                >
                                    <td className="px-2 py-1.5 align-top font-medium">{String(row[categoryKey] ?? "—")}</td>
                                    {spec.series
                                        .filter((s) => s.key !== categoryKey)
                                        .map((s) => (
                                            <td key={s.key} className="px-2 py-1.5 align-top">
                                                {String(row[s.key] ?? "—")}
                                            </td>
                                        ))}
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            ) : (
            <>
            <div className="px-3 py-4" style={{ width: "100%", height: chartHeight }}>
                <ResponsiveContainer width="100%" height="100%">
                    {isPie ? (
                        <PieChart margin={{ top: 4, right: 4, bottom: 4, left: 4 }}>
                            <Pie
                                data={spec.data}
                                dataKey={primary?.key || "count"}
                                nameKey={categoryKey}
                                cx="50%"
                                cy="50%"
                                innerRadius={pieInnerRadius}
                                outerRadius={pieOuterRadius}
                                paddingAngle={2}
                                onClick={(_, index) => {
                                    const row = spec.data[index];
                                    emitPointClick(row);
                                }}
                                cursor={onDataPointClick ? "pointer" : undefined}
                            >
                                {spec.data.map((_, i) => (
                                    <Cell key={i} fill={PALETTE[i % PALETTE.length]} />
                                ))}
                            </Pie>
                            <Tooltip content={<ChartTooltip currency={spec.currency} />} />
                        </PieChart>
                    ) : spec.kind === "line" ? (
                        <LineChart data={spec.data} margin={{ top: 8, right: 16, left: 8, bottom: 8 }}>
                            <CartesianGrid strokeDasharray="3 3" stroke={gridStroke} vertical={false} />
                            <XAxis dataKey={categoryKey} tick={{ fill: axisFill, fontSize: 10 }} tickLine={false} axisLine={false} />
                            <YAxis tick={{ fill: axisFill, fontSize: 10 }} tickLine={false} axisLine={false} width={56} tickFormatter={(v) => formatValue(Number(v), spec.currency)} />
                            <Tooltip content={<ChartTooltip currency={spec.currency} />} />
                            {spec.series.map((s, i) => (
                                <Line
                                    key={s.key}
                                    type="monotone"
                                    dataKey={s.key}
                                    name={s.label}
                                    stroke={s.color || PALETTE[i]}
                                    strokeWidth={2}
                                    dot={{ r: 3 }}
                                />
                            ))}
                        </LineChart>
                    ) : spec.kind === "area" ? (
                        <AreaChart
                            data={spec.data}
                            margin={{ top: 8, right: 16, left: 8, bottom: 8 }}
                            onClick={(state) => {
                                const idx = state?.activeTooltipIndex;
                                if (typeof idx === "number" && spec.data[idx]) {
                                    emitPointClick(spec.data[idx]);
                                }
                            }}
                            style={{ cursor: onDataPointClick ? "pointer" : undefined }}
                        >
                            <defs>
                                <linearGradient id={`grad-${spec.id}`} x1="0" y1="0" x2="0" y2="1">
                                    <stop offset="0%" stopColor={color} stopOpacity={0.35} />
                                    <stop offset="100%" stopColor={color} stopOpacity={0.02} />
                                </linearGradient>
                            </defs>
                            <CartesianGrid strokeDasharray="3 3" stroke={gridStroke} vertical={false} />
                            <XAxis dataKey={categoryKey} tick={{ fill: axisFill, fontSize: 10 }} tickLine={false} axisLine={false} />
                            <YAxis tick={{ fill: axisFill, fontSize: 10 }} tickLine={false} axisLine={false} width={56} tickFormatter={(v) => formatValue(Number(v), spec.currency)} />
                            <Tooltip content={<ChartTooltip currency={spec.currency} />} />
                            <Area
                                type="monotone"
                                dataKey={primary?.key}
                                name={primary?.label}
                                stroke={color}
                                fill={`url(#grad-${spec.id})`}
                                strokeWidth={2}
                                activeDot={{ r: 6 }}
                            />
                        </AreaChart>
                    ) : useHorizontalBar ? (
                        <BarChart
                            layout="vertical"
                            data={spec.data}
                            margin={{ top: 8, right: 24, left: 8, bottom: 8 }}
                        >
                            <CartesianGrid strokeDasharray="3 3" stroke={gridStroke} horizontal={false} />
                            <XAxis
                                type="number"
                                tick={{ fill: axisFill, fontSize: 10 }}
                                tickLine={false}
                                axisLine={false}
                                tickFormatter={(v) => formatValue(Number(v), spec.currency)}
                            />
                            <YAxis
                                type="category"
                                dataKey={categoryKey}
                                width={100}
                                tick={{ fill: axisFill, fontSize: 10 }}
                                tickLine={false}
                                axisLine={false}
                            />
                            <Tooltip content={<ChartTooltip currency={spec.currency} />} />
                            {spec.series.map((s, i) => (
                                <Bar
                                    key={s.key}
                                    dataKey={s.key}
                                    name={s.label}
                                    fill={s.color || PALETTE[i]}
                                    radius={[0, 6, 6, 0]}
                                    maxBarSize={28}
                                    {...barClickProps}
                                />
                            ))}
                        </BarChart>
                    ) : (
                        <BarChart data={spec.data} margin={{ top: 8, right: 16, left: 8, bottom: 8 }}>
                            <CartesianGrid strokeDasharray="3 3" stroke={gridStroke} vertical={false} />
                            <XAxis dataKey={categoryKey} tick={{ fill: axisFill, fontSize: 10 }} tickLine={false} axisLine={false} />
                            <YAxis tick={{ fill: axisFill, fontSize: 10 }} tickLine={false} axisLine={false} width={56} tickFormatter={(v) => formatValue(Number(v), spec.currency)} />
                            <Tooltip content={<ChartTooltip currency={spec.currency} />} />
                            {spec.series.map((s, i) => (
                                <Bar
                                    key={s.key}
                                    dataKey={s.key}
                                    name={s.label}
                                    fill={s.color || PALETTE[i]}
                                    radius={[6, 6, 0, 0]}
                                    maxBarSize={embedded ? 56 : 42}
                                    {...barClickProps}
                                />
                            ))}
                        </BarChart>
                    )}
                </ResponsiveContainer>
            </div>
            {isPie && !isEmpty ? (
                <div className="flex flex-wrap justify-center gap-x-4 gap-y-2 px-4 pb-4 pt-0">
                    {spec.data.map((row, i) => (
                        <span
                            key={`${row[categoryKey]}-${i}`}
                            className={`inline-flex items-center gap-1.5 text-[11px] ${
                                isDark ? "text-slate-300" : "text-slate-600"
                            }`}
                        >
                            <span
                                className="h-2.5 w-2.5 rounded-full shrink-0"
                                style={{ backgroundColor: PALETTE[i % PALETTE.length] }}
                            />
                            <span className="capitalize">{String(row[categoryKey] ?? "—")}</span>
                            <span className="font-semibold tabular-nums">{String(row[primary?.key || "count"] ?? "")}</span>
                        </span>
                    ))}
                </div>
            ) : null}
            </>
            )}
            {spec.footer ? (
                <p className={`px-4 pb-2 text-[10px] leading-relaxed ${isDark ? "text-slate-500" : "text-slate-500"}`}>
                    {spec.footer}
                </p>
            ) : null}
            {spec.actions?.length ? (
                <div className={`px-4 pb-3 flex flex-wrap gap-2 ${spec.footer ? "" : "pt-1"}`}>
                    {spec.actions.map((action, i) => (
                        <button
                            key={`${action.kind}-${action.documentId || i}`}
                            type="button"
                            onClick={() => onVisualAction?.(action)}
                            className={`text-[10px] font-semibold rounded-lg px-2.5 py-1 border transition-colors ${
                                action.kind === "reprocess"
                                    ? isDark
                                        ? "border-amber-500/40 text-amber-200 hover:bg-amber-500/10"
                                        : "border-amber-300 text-amber-900 hover:bg-amber-50"
                                    : isDark
                                      ? "border-white/15 text-slate-300 hover:bg-white/5"
                                      : "border-slate-200 text-slate-700 hover:bg-slate-50"
                            }`}
                        >
                            {action.label}
                        </button>
                    ))}
                </div>
            ) : null}
        </div>
    );
}

type Props = {
    visuals: ChatVisualSpec[];
    isDark?: boolean;
    embedded?: boolean;
    onDataPointClick?: (payload: VisualDataPointClick) => void;
    onVisualAction?: (action: NonNullable<ChatVisualSpec["actions"]>[number]) => void;
};

export default function ChatAgentVisuals({
    visuals,
    isDark = false,
    embedded = false,
    onDataPointClick,
    onVisualAction,
}: Props) {
    const agentId = visuals[0]?.agentId;
    const label = useMemo(() => (agentId ? agentLabel(agentId) : "Analytics"), [agentId]);

    if (!visuals.length) return null;

    const grid = (
        <div className={embedded ? "space-y-5" : "grid gap-4 lg:grid-cols-2"}>
            {visuals.map((spec) => (
                <SingleVisual
                    key={spec.id}
                    spec={spec}
                    isDark={isDark}
                    embedded={embedded}
                    onDataPointClick={onDataPointClick}
                    onVisualAction={onVisualAction}
                />
            ))}
        </div>
    );

    if (embedded) {
        return grid;
    }

    return (
        <div className={`mt-5 pt-4 border-t space-y-4 ${isDark ? "border-white/10" : "border-slate-200"}`}>
            <div className="flex items-center justify-between gap-2">
                <p className={`text-[10px] font-semibold uppercase tracking-[0.14em] ${isDark ? "text-slate-400" : "text-slate-500"}`}>
                    {label}
                </p>
                <span className={`text-[10px] font-medium ${isDark ? "text-slate-500" : "text-slate-400"}`}>
                    Library data
                </span>
            </div>
            {grid}
        </div>
    );
}
