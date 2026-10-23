"use client";

import React from "react";
import { FileText, Mail, UserCheck } from "lucide-react";

type Props = {
    accent: string;
    onAsk: (prompt: string) => void;
    onOpenOutreach: () => void;
    onOpenShortlist: () => void;
    onOpenReports: () => void;
    hasShortlist: boolean;
};

export default function AgentHrQuickActions({
    accent,
    onAsk,
    onOpenOutreach,
    onOpenShortlist,
    onOpenReports,
    hasShortlist,
}: Props) {
    const actions = [
        {
            id: "shortlist",
            label: "CV shortlist",
            icon: UserCheck,
            onClick: onOpenShortlist,
            disabled: false,
        },
        {
            id: "offers",
            label: "Generate offers",
            icon: FileText,
            onClick: onOpenReports,
            disabled: !hasShortlist,
        },
        {
            id: "outreach",
            label: "Email candidates",
            icon: Mail,
            onClick: onOpenOutreach,
            disabled: !hasShortlist,
        },
    ];

    return (
        <section
            className="rounded-2xl border border-border overflow-hidden"
            style={{ boxShadow: `inset 3px 0 0 ${accent}` }}
        >
            <div className="px-4 py-3 bg-surface/40 border-b border-border">
                <p className="text-xs font-bold text-foreground">HR automation</p>
                <p className="text-[10px] text-foreground-muted mt-0.5">
                    Shortlist, offer letters, and candidate outreach — one click
                </p>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-3 divide-y sm:divide-y-0 sm:divide-x divide-border">
                {actions.map((a) => {
                    const Icon = a.icon;
                    return (
                        <button
                            key={a.id}
                            type="button"
                            disabled={a.disabled}
                            onClick={a.onClick}
                            className="flex items-center gap-3 px-4 py-3.5 text-left hover:bg-surface-2/50 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                        >
                            <div
                                className="h-9 w-9 rounded-xl flex items-center justify-center shrink-0"
                                style={{ backgroundColor: `${accent}18` }}
                            >
                                <Icon size={16} style={{ color: accent }} />
                            </div>
                            <span className="text-xs font-semibold text-foreground">{a.label}</span>
                        </button>
                    );
                })}
            </div>
        </section>
    );
}
