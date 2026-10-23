"use client";

import React from "react";
import ChatAgentVisuals from "@/components/ChatAgentVisuals";
import type { ChatVisualSpec } from "@/types/chatVisuals";

type Props = {
    visuals: ChatVisualSpec[];
    maxCharts?: number;
    onOpenCharts?: () => void;
    hideHeader?: boolean;
};

export default function AgentChartPreviews({ visuals, maxCharts = 2, onOpenCharts, hideHeader }: Props) {
    const preview = visuals.slice(0, maxCharts);
    if (!preview.length) return null;

    return (
        <section className={hideHeader ? "" : "space-y-3"}>
            {!hideHeader && (
            <div className="flex items-center justify-between gap-2">
                <p className="text-[10px] font-semibold uppercase tracking-wider text-foreground-muted">
                    Live chart preview
                </p>
                {onOpenCharts && (
                    <button
                        type="button"
                        onClick={onOpenCharts}
                        className="text-[10px] font-medium text-accent hover:underline"
                    >
                        {visuals.length > maxCharts
                            ? `Open all ${visuals.length} charts →`
                            : "Open analytics →"}
                    </button>
                )}
            </div>
            )}
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
                {preview.map((spec) => (
                    <div
                        key={spec.id}
                        role={onOpenCharts ? "button" : undefined}
                        tabIndex={onOpenCharts ? 0 : undefined}
                        onClick={onOpenCharts}
                        onKeyDown={
                            onOpenCharts
                                ? (e) => {
                                      if (e.key === "Enter" || e.key === " ") {
                                          e.preventDefault();
                                          onOpenCharts();
                                      }
                                  }
                                : undefined
                        }
                        className={
                            onOpenCharts
                                ? "text-left rounded-2xl border border-border bg-surface/50 overflow-hidden hover:border-accent/40 hover:shadow-md transition-all cursor-pointer"
                                : "rounded-2xl border border-border bg-surface/50 overflow-hidden"
                        }
                    >
                        <ChatAgentVisuals visuals={[spec]} embedded />
                    </div>
                ))}
            </div>
        </section>
    );
}
