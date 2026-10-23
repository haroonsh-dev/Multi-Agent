"use client";

import React from "react";
import Link from "next/link";
import {
    ArrowRight,
    ClipboardList,
    FileCheck,
    Scale,
    ScrollText,
    Shield,
    Upload,
} from "lucide-react";
import {
    extractCertRegister,
    type CompPillar,
    type CompPriority,
    type ComplianceSnapshot,
} from "@/lib/agentWorkspaceCompliance";
import type { AttentionItem } from "@/lib/agentWorkspaceInsights";
import type { ChatVisualSpec } from "@/types/chatVisuals";
import AgentChartPreviews from "@/components/AgentChartPreviews";
import AgentComplianceRegisterTable from "@/components/AgentComplianceRegisterTable";
import { cn } from "@/lib/utils";

const PILLAR_ICONS = {
    certs: Shield,
    audits: Scale,
    policies: ScrollText,
    regulatory: FileCheck,
} as const;

type Props = {
    snapshot: ComplianceSnapshot;
    accent: string;
    visuals: ChatVisualSpec[];
    attention: AttentionItem[];
    onOpenChart: (view: string) => void;
    onAsk: (prompt: string) => void;
    onOpenReports: () => void;
    onOpenFix: () => void;
    onNavigate?: (href: string) => void;
};

function PillarCard({
    pillar,
    accent,
    onOpenChart,
    onAsk,
}: {
    pillar: CompPillar;
    accent: string;
    onOpenChart: (view: string) => void;
    onAsk: (prompt: string) => void;
}) {
    const Icon = PILLAR_ICONS[pillar.id];
    return (
        <button
            type="button"
            onClick={() => {
                if (pillar.count > 0 && pillar.chartView) onOpenChart(pillar.chartView);
                else onAsk(pillar.askPrompt);
            }}
            className="group text-left rounded-2xl border border-border bg-surface/40 p-4 hover:bg-surface/70 transition-all"
        >
            <div className="flex items-start justify-between gap-2">
                <div
                    className="h-9 w-9 rounded-xl flex items-center justify-center shrink-0"
                    style={{ backgroundColor: `${accent}18` }}
                >
                    <Icon size={18} style={{ color: accent }} />
                </div>
                <span
                    className={cn(
                        "text-[9px] font-bold uppercase tracking-wider rounded-full px-2 py-0.5",
                        pillar.status === "ready"
                            ? "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400"
                            : pillar.status === "partial"
                              ? "bg-amber-500/10 text-amber-700 dark:text-amber-400"
                              : "bg-surface-2 text-foreground-muted"
                    )}
                >
                    {pillar.count > 0 ? `${pillar.count} files` : "Empty"}
                </span>
            </div>
            <p className="text-sm font-bold text-foreground mt-3">{pillar.label}</p>
            <p className="text-[11px] text-foreground-muted mt-1 leading-snug">{pillar.subtitle}</p>
            <span className="inline-flex items-center gap-1 text-[11px] font-semibold mt-3 text-foreground-muted group-hover:text-foreground">
                {pillar.count > 0 ? "Open view" : "Get started"}
                <ArrowRight size={12} className="opacity-0 group-hover:opacity-100 transition-opacity" />
            </span>
        </button>
    );
}

export default function AgentComplianceCommandPanel({
    snapshot,
    accent,
    visuals,
    attention,
    onOpenChart,
    onAsk,
    onOpenReports,
    onOpenFix,
    onNavigate,
}: Props) {
    const isEmpty = snapshot.stats.totalFiles === 0;
    const register = extractCertRegister(visuals, 8);

    return (
        <div className="space-y-5">
            <div
                className="rounded-2xl border border-border bg-surface/50 px-5 py-5 relative overflow-hidden"
                style={{ boxShadow: `inset 3px 0 0 ${accent}` }}
            >
                <p className="text-[10px] font-bold uppercase tracking-[0.16em] text-foreground-muted">
                    Compliance posture
                </p>
                <p className="text-xl sm:text-2xl font-bold text-foreground mt-1 tracking-tight">{snapshot.headline}</p>
                <p className="text-sm text-foreground-muted mt-2 max-w-2xl">{snapshot.subline}</p>

                {!isEmpty && (
                    <div className="flex flex-wrap gap-4 mt-4 pt-4 border-t border-border/50">
                        {[
                            { label: "Certs tracked", value: snapshot.stats.certsTracked || "—" },
                            { label: "Expiring", value: snapshot.stats.expiringSoon || "—" },
                            { label: "Expired", value: snapshot.stats.expired || "—" },
                            { label: "Findings", value: snapshot.stats.findingsCount || "—" },
                        ].map((s) => (
                            <div key={s.label}>
                                <p className="text-[10px] font-medium uppercase tracking-wider text-foreground-muted">
                                    {s.label}
                                </p>
                                <p className="text-lg font-bold tabular-nums text-foreground">{s.value}</p>
                            </div>
                        ))}
                    </div>
                )}

                {isEmpty && (
                    <Link
                        href="/documents"
                        className="inline-flex items-center gap-2 mt-4 rounded-xl px-4 py-2.5 text-sm font-semibold text-white hover:opacity-90 transition-opacity"
                        style={{ backgroundColor: accent }}
                    >
                        <Upload size={15} /> Upload compliance documents
                    </Link>
                )}
            </div>

            <section>
                <p className="text-[10px] font-semibold uppercase tracking-wider text-foreground-muted mb-3">
                    Compliance workstreams
                </p>
                <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-3">
                    {snapshot.pillars.map((pillar) => (
                        <PillarCard
                            key={pillar.id}
                            pillar={pillar}
                            accent={accent}
                            onOpenChart={onOpenChart}
                            onAsk={onAsk}
                        />
                    ))}
                </div>
            </section>

            <section className="rounded-2xl border border-border bg-surface/30 p-4">
                <div className="flex items-center justify-between gap-2 mb-3">
                    <p className="text-[10px] font-semibold uppercase tracking-wider text-foreground-muted flex items-center gap-1.5">
                        <ClipboardList size={12} /> Action queue
                    </p>
                    <button
                        type="button"
                        onClick={onOpenReports}
                        className="text-[10px] font-semibold text-foreground-muted hover:text-foreground"
                    >
                        Reports & letters →
                    </button>
                </div>
                <div className="space-y-2">
                    {snapshot.priorities.map((item) => (
                        <PriorityRow
                            key={item.id}
                            item={item}
                            onOpenChart={onOpenChart}
                            onAsk={onAsk}
                            onOpenFix={onOpenFix}
                        />
                    ))}
                </div>
            </section>

            {register.length > 0 && (
                <AgentComplianceRegisterTable rows={register} accent={accent} onAsk={onAsk} />
            )}

            {snapshot.docMix.length > 0 && (
                <section>
                    <p className="text-[10px] font-semibold uppercase tracking-wider text-foreground-muted mb-2">
                        Portfolio mix
                    </p>
                    <div className="flex flex-wrap gap-2">
                        {snapshot.docMix.map((d) => (
                            <span
                                key={d.type}
                                className="rounded-full border border-border bg-background/60 px-3 py-1 text-[11px] font-medium text-foreground-muted"
                            >
                                {d.label}{" "}
                                <span className="text-foreground font-semibold tabular-nums">{d.count}</span>
                            </span>
                        ))}
                    </div>
                </section>
            )}

            {visuals.length > 0 && (
                <AgentChartPreviews visuals={visuals} maxCharts={2} onOpenCharts={() => onOpenChart("overview")} />
            )}

            {attention.length > 0 && (
                <section className="rounded-2xl border border-border bg-surface/40 p-4">
                    <p className="text-[10px] font-semibold uppercase tracking-wider text-foreground-muted mb-3">
                        Files needing review
                    </p>
                    <div className="space-y-2">
                        {attention.slice(0, 3).map((item) => (
                            <button
                                key={item.id}
                                type="button"
                                onClick={() => {
                                    if (item.href && onNavigate) onNavigate(item.href);
                                    else if (item.prompt) onAsk(item.prompt);
                                    else onOpenFix();
                                }}
                                className="w-full text-left rounded-xl border border-border px-3 py-2.5 text-xs hover:bg-surface-2"
                            >
                                <p className="font-semibold truncate">{item.title}</p>
                                {item.detail && (
                                    <p className="text-[10px] text-foreground-muted mt-0.5 line-clamp-2">{item.detail}</p>
                                )}
                            </button>
                        ))}
                    </div>
                </section>
            )}
        </div>
    );
}

function PriorityRow({
    item,
    onOpenChart,
    onAsk,
    onOpenFix,
}: {
    item: CompPriority;
    onOpenChart: (view: string) => void;
    onAsk: (prompt: string) => void;
    onOpenFix: () => void;
}) {
    return (
        <button
            type="button"
            onClick={() => {
                if (item.id === "fix") onOpenFix();
                else if (item.chartView) onOpenChart(item.chartView);
                else if (item.prompt) onAsk(item.prompt);
            }}
            className={cn(
                "w-full text-left rounded-xl border px-3 py-2.5 flex items-start gap-3 transition-colors hover:bg-surface-2/80",
                item.tone === "warn" ? "border-amber-500/20 bg-amber-500/5" : "border-border bg-background/40"
            )}
        >
            <span
                className={cn(
                    "mt-1 h-2 w-2 rounded-full shrink-0",
                    item.tone === "warn" ? "bg-amber-500" : "bg-emerald-500"
                )}
            />
            <div className="min-w-0 flex-1">
                <p className="text-xs font-semibold text-foreground">{item.title}</p>
                <p className="text-[10px] text-foreground-muted mt-0.5">{item.detail}</p>
            </div>
            <ArrowRight size={14} className="text-foreground-muted shrink-0 mt-0.5" />
        </button>
    );
}
