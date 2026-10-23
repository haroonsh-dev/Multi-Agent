"use client";

import React from "react";
import { cn } from "@/lib/utils";

type Props = {
    score: number;
    label: string;
    accent: string;
    size?: "sm" | "md" | "lg";
    className?: string;
};

const SIZES = {
    sm: { box: "h-14 w-14", text: "text-[11px]", stroke: 3.5, r: 24 },
    md: { box: "h-20 w-20", text: "text-sm", stroke: 4, r: 32 },
    lg: { box: "h-28 w-28", text: "text-lg", stroke: 5, r: 44 },
};

export default function AgentReadinessRing({ score, label, accent, size = "md", className }: Props) {
    const cfg = SIZES[size];
    const c = 2 * Math.PI * cfg.r;
    const offset = c - (Math.min(100, Math.max(0, score)) / 100) * c;
    const view = cfg.r * 2 + cfg.stroke * 2;

    return (
        <div className={cn("flex flex-col items-center gap-2", className)}>
            <div className={cn("relative shrink-0", cfg.box)}>
                <svg className={cn("h-full w-full -rotate-90")} viewBox={`0 0 ${view} ${view}`}>
                    <circle
                        cx={view / 2}
                        cy={view / 2}
                        r={cfg.r}
                        fill="none"
                        stroke="var(--border)"
                        strokeWidth={cfg.stroke}
                    />
                    <circle
                        cx={view / 2}
                        cy={view / 2}
                        r={cfg.r}
                        fill="none"
                        stroke={accent}
                        strokeWidth={cfg.stroke}
                        strokeLinecap="round"
                        strokeDasharray={c}
                        strokeDashoffset={offset}
                        className="transition-[stroke-dashoffset] duration-700 ease-out"
                    />
                </svg>
                <span
                    className={cn(
                        "absolute inset-0 flex items-center justify-center font-bold tabular-nums",
                        cfg.text
                    )}
                >
                    {score}%
                </span>
            </div>
            <p className="text-[10px] font-semibold uppercase tracking-wider text-foreground-muted text-center">
                {label}
            </p>
        </div>
    );
}
