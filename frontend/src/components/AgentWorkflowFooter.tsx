"use client";

import React from "react";
import { ArrowRight } from "lucide-react";
import type { AnalyticsAgentId } from "@/lib/documentAgents";
import { AGENT_WORKFLOW_STEPS } from "@/lib/agentWorkspaceVerdict";

type Props = {
    agentId: AnalyticsAgentId;
    accent: string;
};

export default function AgentWorkflowFooter({ agentId, accent }: Props) {
    const steps = AGENT_WORKFLOW_STEPS[agentId] || AGENT_WORKFLOW_STEPS.other_agent;

    return (
        <section className="rounded-2xl border border-dashed border-border bg-surface/20 px-4 py-4">
            <p className="text-[10px] font-bold uppercase tracking-[0.14em] text-foreground-muted mb-3">
                How this agent works
            </p>
            <div className="flex flex-col sm:flex-row sm:items-start gap-2 sm:gap-0">
                {steps.map((step, i) => (
                    <React.Fragment key={step.label}>
                        <div className="flex-1 min-w-0 text-center sm:px-2">
                            <div
                                className="mx-auto h-7 w-7 rounded-full flex items-center justify-center text-[10px] font-bold text-white mb-1.5"
                                style={{ backgroundColor: accent }}
                            >
                                {i + 1}
                            </div>
                            <p className="text-[11px] font-bold text-foreground">{step.label}</p>
                            <p className="text-[10px] text-foreground-muted mt-0.5 leading-snug">{step.detail}</p>
                        </div>
                        {i < steps.length - 1 && (
                            <ArrowRight
                                size={14}
                                className="hidden sm:block text-foreground-muted/40 shrink-0 mt-2 mx-1"
                            />
                        )}
                    </React.Fragment>
                ))}
            </div>
        </section>
    );
}
