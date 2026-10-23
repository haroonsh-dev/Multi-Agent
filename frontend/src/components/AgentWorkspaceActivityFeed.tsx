"use client";

import React from "react";
import Link from "next/link";
import { Activity, ArrowRight } from "lucide-react";
import { useWorkspaceActivity } from "@/hooks/useWorkspaceActivity";

function timeAgo(iso: string): string {
    const mins = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
    if (mins < 1) return "just now";
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `${hrs}h ago`;
    return `${Math.floor(hrs / 24)}d ago`;
}

type Props = {
    agentId?: string;
};

export default function AgentWorkspaceActivityFeed({ agentId }: Props) {
    const { items, loading } = useWorkspaceActivity(6, agentId);

    if (loading) {
        return (
            <div className="rounded-2xl border border-border bg-surface/40 p-4 animate-pulse h-32" />
        );
    }

    if (!items.length) return null;

    return (
        <section className="rounded-2xl border border-border bg-surface/40 p-4">
            <div className="flex items-center justify-between mb-3">
                <p className="text-[10px] font-semibold uppercase tracking-wider text-foreground-muted flex items-center gap-1.5">
                    <Activity size={12} /> {agentId ? "Recent for this agent" : "Recent activity"}
                </p>
                <Link href="/activity" className="text-[10px] font-medium text-accent hover:underline flex items-center gap-0.5">
                    All <ArrowRight size={10} />
                </Link>
            </div>
            <div className="space-y-2">
                {items.map((log) => (
                    <div
                        key={log.logId}
                        className="flex gap-2 rounded-lg border border-border/60 bg-background/40 px-2.5 py-2"
                    >
                        <span
                            className={`mt-1.5 h-1.5 w-1.5 rounded-full shrink-0 ${
                                log.outcome === "failure" ? "bg-rose-500" : "bg-emerald-500"
                            }`}
                        />
                        <div className="min-w-0 flex-1">
                            <p className="text-[11px] font-medium text-foreground truncate">
                                {log.message || log.action.replace(/[._]/g, " ")}
                            </p>
                            <p className="text-[10px] text-foreground-muted">
                                {log.actorName || log.category} · {timeAgo(log.createdAt)}
                            </p>
                        </div>
                    </div>
                ))}
            </div>
        </section>
    );
}
