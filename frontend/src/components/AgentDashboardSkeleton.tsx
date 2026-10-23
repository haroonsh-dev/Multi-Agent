"use client";

import React from "react";

export default function AgentDashboardSkeleton() {
    return (
        <div className="space-y-5 animate-pulse">
            <div className="rounded-2xl border border-border h-28 bg-surface/40" />
            <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-3">
                {Array.from({ length: 6 }).map((_, i) => (
                    <div key={i} className="rounded-xl border border-border h-[88px] bg-surface/30" />
                ))}
            </div>
            <div className="rounded-2xl border border-border h-16 bg-surface/30" />
            <div className="grid grid-cols-1 xl:grid-cols-12 gap-4">
                <div className="xl:col-span-8 space-y-4">
                    <div className="rounded-2xl border border-border h-64 bg-surface/30" />
                    <div className="rounded-2xl border border-border h-48 bg-surface/30" />
                </div>
                <div className="xl:col-span-4 space-y-4">
                    <div className="rounded-2xl border border-border h-32 bg-surface/30" />
                    <div className="rounded-2xl border border-border h-40 bg-surface/30" />
                    <div className="rounded-2xl border border-border h-36 bg-surface/30" />
                </div>
            </div>
        </div>
    );
}
