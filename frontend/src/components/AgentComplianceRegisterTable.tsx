"use client";

import React from "react";
import Link from "next/link";
import { cn } from "@/lib/utils";
import type { CertRegisterRow } from "@/lib/agentWorkspaceCompliance";

type Props = {
    rows: CertRegisterRow[];
    accent: string;
    maxRows?: number;
    onAsk?: (prompt: string) => void;
    compact?: boolean;
    title?: string;
};

function statusClass(tone: CertRegisterRow["statusTone"]): string {
    if (tone === "valid") return "text-emerald-600 dark:text-emerald-400 bg-emerald-500/10";
    if (tone === "expiring") return "text-amber-700 dark:text-amber-400 bg-amber-500/10";
    if (tone === "expired") return "text-red-600 dark:text-red-400 bg-red-500/10";
    return "text-foreground-muted bg-surface-2";
}

export default function AgentComplianceRegisterTable({
    rows,
    accent,
    maxRows = 8,
    onAsk,
    compact,
    title = "Certificate register",
}: Props) {
    const shown = rows.slice(0, maxRows);
    if (!shown.length) return null;

    return (
        <section
            className={cn(
                "rounded-2xl border border-border overflow-hidden",
                compact ? "bg-surface/30" : "bg-surface/50"
            )}
        >
            <div className="flex items-center justify-between gap-2 px-4 py-3 border-b border-border bg-surface-2/30">
                <div>
                    <p className="text-xs font-bold text-foreground">{title}</p>
                    {!compact && (
                        <p className="text-[10px] text-foreground-muted mt-0.5">Sorted by soonest expiry</p>
                    )}
                </div>
                {onAsk && (
                    <button
                        type="button"
                        onClick={() => onAsk("Any certificates expiring in the next 90 days?")}
                        className="text-[10px] font-semibold hover:underline"
                        style={{ color: accent }}
                    >
                        Expiry scan →
                    </button>
                )}
            </div>
            <div className="overflow-x-auto">
                <table className="w-full text-left text-xs">
                    <thead>
                        <tr className="text-[10px] uppercase tracking-wider text-foreground-muted border-b border-border">
                            <th className="px-4 py-2 font-semibold w-10">#</th>
                            <th className="px-4 py-2 font-semibold">Certificate</th>
                            <th className="px-4 py-2 font-semibold">Standard</th>
                            <th className="px-4 py-2 font-semibold text-right w-24">Days</th>
                            <th className="px-4 py-2 font-semibold text-right w-28">Status</th>
                            <th className="px-4 py-2 font-semibold text-right w-28">Agent action</th>
                        </tr>
                    </thead>
                    <tbody>
                        {shown.map((row) => (
                            <tr
                                key={`${row.rank}-${row.name}`}
                                className="border-b border-border/50 last:border-0 hover:bg-surface-2/50"
                            >
                                <td className="px-4 py-2.5 tabular-nums text-foreground-muted font-medium">{row.rank}</td>
                                <td className="px-4 py-2.5 font-medium text-foreground max-w-[160px] truncate">
                                    {row.documentId ? (
                                        <Link href={`/documents/${row.documentId}/details`} className="hover:underline">
                                            {row.name}
                                        </Link>
                                    ) : (
                                        row.name
                                    )}
                                </td>
                                <td className="px-4 py-2.5 text-foreground-muted truncate max-w-[100px]">{row.standard}</td>
                                <td className="px-4 py-2.5 text-right tabular-nums text-foreground-muted">{row.daysLeft}</td>
                                <td className="px-4 py-2.5 text-right">
                                    <span
                                        className={cn(
                                            "inline-flex rounded-md px-2 py-0.5 font-bold text-[10px] uppercase",
                                            statusClass(row.statusTone)
                                        )}
                                    >
                                        {row.status}
                                    </span>
                                </td>
                                <td className="px-4 py-2.5 text-right">
                                    {onAsk ? (
                                        <button
                                            type="button"
                                            onClick={() =>
                                                onAsk(
                                                    row.agentAction === "Renew"
                                                        ? `Renewal plan for certificate ${row.name}`
                                                        : `Review certificate ${row.name}`
                                                )
                                            }
                                            className="text-[10px] font-semibold hover:underline"
                                            style={{ color: accent }}
                                        >
                                            {row.agentAction}
                                        </button>
                                    ) : (
                                        <span className="text-[10px] font-semibold text-foreground-muted">
                                            {row.agentAction}
                                        </span>
                                    )}
                                </td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>
        </section>
    );
}
