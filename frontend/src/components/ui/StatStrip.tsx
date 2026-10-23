"use client";

import React, { useMemo } from "react";
import { PieChart, Pie, Cell, ResponsiveContainer, Tooltip } from "recharts";
import { cn } from "@/lib/utils";

export type StatSlice = {
    name: string;
    value: number;
    color: string;
};

const DEFAULT_COLORS = {
    Complete: "#34d399",
    Processing: "#fbbf24",
    Failed: "#f87171",
    Other: "#64748b",
};

export function StatStrip({
    items,
    className,
}: {
    items: { complete: number; processing: number; failed: number; other?: number };
    className?: string;
}) {
    const data: StatSlice[] = useMemo(() => {
        const rows: StatSlice[] = [
            { name: "Complete", value: items.complete, color: DEFAULT_COLORS.Complete },
            { name: "Processing", value: items.processing, color: DEFAULT_COLORS.Processing },
            { name: "Failed", value: items.failed, color: DEFAULT_COLORS.Failed },
        ];
        if ((items.other ?? 0) > 0) {
            rows.push({ name: "Other", value: items.other!, color: DEFAULT_COLORS.Other });
        }
        return rows.filter((r) => r.value > 0);
    }, [items]);

    const total = items.complete + items.processing + items.failed + (items.other ?? 0);

    if (total === 0) return null;

    return (
        <div
            className={cn(
                "surface-card flex flex-wrap items-center gap-6 px-5 py-4",
                className
            )}
        >
            <div className="w-[72px] h-[72px] shrink-0">
                <ResponsiveContainer width="100%" height="100%">
                    <PieChart>
                        <Pie
                            data={data.length ? data : [{ name: "Empty", value: 1, color: "#334155" }]}
                            dataKey="value"
                            nameKey="name"
                            innerRadius={22}
                            outerRadius={34}
                            strokeWidth={0}
                            paddingAngle={2}
                        >
                            {(data.length ? data : [{ color: "#334155" }]).map((entry, i) => (
                                <Cell key={i} fill={entry.color} />
                            ))}
                        </Pie>
                        <Tooltip
                            contentStyle={{
                                background: "var(--surface-2)",
                                border: "1px solid var(--border)",
                                borderRadius: 8,
                                fontSize: 12,
                                color: "var(--foreground)",
                            }}
                        />
                    </PieChart>
                </ResponsiveContainer>
            </div>

            <div className="flex flex-wrap gap-5 flex-1 min-w-0">
                {[
                    { label: "Complete", value: items.complete, color: DEFAULT_COLORS.Complete },
                    { label: "Processing", value: items.processing, color: DEFAULT_COLORS.Processing },
                    { label: "Failed", value: items.failed, color: DEFAULT_COLORS.Failed },
                ].map((s) => (
                    <div key={s.label} className="min-w-[72px]">
                        <div className="flex items-center gap-1.5 mb-0.5">
                            <span className="w-2 h-2 rounded-full" style={{ background: s.color }} />
                            <span className="text-[11px] font-medium text-foreground-muted uppercase tracking-wide">
                                {s.label}
                            </span>
                        </div>
                        <p className="text-xl font-bold tracking-tight text-foreground tabular-nums font-mono">
                            {s.value}
                        </p>
                    </div>
                ))}
                <div className="min-w-[72px] ml-auto text-right">
                    <p className="text-[11px] font-medium text-foreground-muted uppercase tracking-wide mb-0.5">
                        Total
                    </p>
                    <p className="text-xl font-bold tracking-tight text-accent tabular-nums font-mono">
                        {total}
                    </p>
                </div>
            </div>
        </div>
    );
}
