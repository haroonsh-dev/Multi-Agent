"use client";

import React from "react";
import Link from "next/link";
import { CheckCircle2, Circle, Plug, Upload } from "lucide-react";
import type { WorkspaceMetrics } from "@/lib/agentWorkspaceInsights";

type Props = {
    metrics: WorkspaceMetrics;
    integrationCount: number;
    chartCount: number;
    accent: string;
};

export default function AgentOnboardingChecklist({ metrics, integrationCount, chartCount, accent }: Props) {
    if (metrics.totalDocs > 0 && chartCount > 0) return null;

    const steps = [
        {
            done: metrics.totalDocs > 0,
            label: "Upload agent documents",
            href: "/documents",
            icon: Upload,
        },
        {
            done: integrationCount > 0,
            label: "Connect SAP, ClickUp, or webhook",
            href: "/admin/integrations",
            icon: Plug,
        },
        {
            done: chartCount > 0,
            label: "Ask for a chart to verify extractions",
            href: undefined,
            icon: CheckCircle2,
        },
    ];

    const doneCount = steps.filter((s) => s.done).length;

    return (
        <section
            className="rounded-2xl border p-5"
            style={{ borderColor: `${accent}40`, backgroundColor: `${accent}08` }}
        >
            <div className="flex items-center justify-between mb-4">
                <div>
                    <p className="text-sm font-bold text-foreground">Get started</p>
                    <p className="text-xs text-foreground-muted mt-0.5">
                        {doneCount}/{steps.length} setup steps complete
                    </p>
                </div>
                <div className="h-10 w-10 rounded-full border-2 flex items-center justify-center text-xs font-bold tabular-nums" style={{ borderColor: accent, color: accent }}>
                    {Math.round((doneCount / steps.length) * 100)}%
                </div>
            </div>
            <ol className="space-y-3">
                {steps.map((step, i) => {
                    const Icon = step.icon;
                    const inner = (
                        <div className="flex items-center gap-3">
                            {step.done ? (
                                <CheckCircle2 size={18} className="text-emerald-500 shrink-0" />
                            ) : (
                                <Circle size={18} className="text-foreground-muted shrink-0" />
                            )}
                            <Icon size={14} className="text-foreground-muted shrink-0" />
                            <span className={`text-sm ${step.done ? "text-foreground-muted line-through" : "text-foreground font-medium"}`}>
                                {step.label}
                            </span>
                        </div>
                    );
                    return (
                        <li key={i}>
                            {step.href && !step.done ? (
                                <Link href={step.href} className="block hover:opacity-80 transition-opacity">
                                    {inner}
                                </Link>
                            ) : (
                                inner
                            )}
                        </li>
                    );
                })}
            </ol>
        </section>
    );
}
