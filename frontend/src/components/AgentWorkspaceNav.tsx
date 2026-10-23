"use client";

import React from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { AGENT_WORKSPACE_META, agentWorkspacePath } from "@/lib/agentWorkspace";
import type { AnalyticsAgentId } from "@/lib/documentAgents";
import type { PlanAgentOption } from "@/hooks/usePlanAgents";
import { cn } from "@/lib/utils";

type Props = {
    agents: PlanAgentOption[];
    currentAgentId: string;
};

export default function AgentWorkspaceNav({ agents, currentAgentId }: Props) {
    const pathname = usePathname();

    return (
        <nav
            className="flex gap-1.5 overflow-x-auto pb-1 scrollbar-thin snap-x snap-mandatory"
            aria-label="Switch AI agent workspace"
        >
            {agents.map((ag) => {
                const meta = AGENT_WORKSPACE_META[ag.value as AnalyticsAgentId];
                if (!meta) return null;
                const href = agentWorkspacePath(ag.value);
                const active = pathname === href || ag.value === currentAgentId;
                const Icon = meta.icon;
                return (
                    <Link
                        key={ag.value}
                        href={href}
                        className={cn(
                            "snap-start shrink-0 inline-flex items-center gap-2 rounded-xl border px-3 py-2 text-xs font-semibold transition-all",
                            active
                                ? "border-transparent text-white shadow-md"
                                : "border-border bg-surface/80 text-foreground-muted hover:text-foreground hover:bg-surface-2"
                        )}
                        style={
                            active
                                ? {
                                      background: `linear-gradient(135deg, ${meta.accent} 0%, color-mix(in srgb, ${meta.accent} 70%, #0f172a) 100%)`,
                                  }
                                : undefined
                        }
                    >
                        <Icon size={14} className={active ? "opacity-95" : "opacity-70"} />
                        {meta.shortName}
                    </Link>
                );
            })}
        </nav>
    );
}
