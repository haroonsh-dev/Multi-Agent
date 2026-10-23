"use client";

import React from "react";
import type { WorkspaceHero } from "@/lib/agentWorkspaceHero";
import { cn } from "@/lib/utils";

type Props = {
    hero: WorkspaceHero;
    accent: string;
    accentMuted: string;
};

export default function AgentWorkspaceHeroBanner({ hero, accent, accentMuted }: Props) {
    const isEmpty = hero.variant === "empty";
    const isMetric = hero.variant === "metric";

    return (
        <div
            className={cn(
                "relative overflow-hidden rounded-2xl border px-5 py-5 sm:px-6 sm:py-6",
                isEmpty && "border-dashed"
            )}
            style={{
                borderColor: `${accent}${isEmpty ? "55" : "44"}`,
                background: isEmpty
                    ? `linear-gradient(135deg, ${accentMuted} 0%, transparent 80%)`
                    : `linear-gradient(135deg, ${accentMuted} 0%, transparent 65%)`,
            }}
        >
            <div
                className="absolute top-0 right-0 w-40 h-40 rounded-full blur-3xl opacity-30 pointer-events-none"
                style={{ backgroundColor: accent }}
            />
            <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-foreground-muted relative">
                {hero.title}
            </p>
            <p
                className={cn(
                    "font-bold tabular-nums tracking-tight mt-1 relative",
                    isEmpty ? "text-xl sm:text-2xl text-foreground" : "text-2xl sm:text-3xl"
                )}
                style={{ color: isEmpty ? undefined : accent }}
            >
                {hero.value}
            </p>
            {hero.subtitle && (
                <p className="text-xs text-foreground-muted mt-2 relative max-w-xl leading-relaxed">
                    {hero.subtitle}
                </p>
            )}
            {isMetric && (
                <div
                    className="mt-4 h-1.5 max-w-xs rounded-full overflow-hidden bg-border/60 relative"
                    aria-hidden
                >
                    <div
                        className="h-full rounded-full transition-all duration-700"
                        style={{
                            width: hero.value,
                            backgroundColor: accent,
                        }}
                    />
                </div>
            )}
        </div>
    );
}
