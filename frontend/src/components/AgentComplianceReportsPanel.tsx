"use client";

import React from "react";
import {
    AlertTriangle,
    FileBarChart,
    FolderArchive,
    Mail,
    Scale,
    Shield,
    Sparkles,
} from "lucide-react";
import type { ChatVisualSpec } from "@/types/chatVisuals";
import type { ComplianceSnapshot } from "@/lib/agentWorkspaceCompliance";
import { extractRenewalQueue } from "@/lib/agentWorkspaceCompliance";
import AgentComplianceRegisterTable from "@/components/AgentComplianceRegisterTable";

const LETTER_ACTIONS = [
    {
        id: "ncr",
        label: "NCR letter",
        description: "Non-conformance notice to vendor or team",
        prompt: "Generate NCR letter for top critical finding. Company Visibility Bots, standard ISO 9001",
        icon: AlertTriangle,
    },
    {
        id: "capa",
        label: "CAPA letter",
        description: "Corrective and preventive action request",
        prompt: "Generate CAPA letter for critical audit finding. standard ISO 14001, due 2026-09-15",
        icon: Mail,
    },
    {
        id: "coc",
        label: "Certificate of compliance",
        description: "Issue compliance confirmation letter",
        prompt: "Generate certificate of compliance letter for Acme Vendor. Company Visibility Bots, standard ISO 9001",
        icon: Shield,
    },
];

const REPORT_ACTIONS = [
    {
        id: "report",
        label: "Full compliance report",
        description: "PDF posture, expiry, findings, register",
        prompt: "Generate compliance report",
        icon: FileBarChart,
    },
    {
        id: "evidence",
        label: "Audit evidence pack",
        description: "Bundle docs before external audit",
        prompt: "Generate audit evidence pack for all compliance documents in scope",
        icon: FolderArchive,
    },
    {
        id: "gaps",
        label: "Framework gap scan",
        description: "Missing required document types",
        prompt: "What compliance documents are missing?",
        icon: Scale,
    },
    {
        id: "dept",
        label: "Department gap analysis",
        description: "Coverage by team or site",
        prompt: "Run department compliance gap analysis",
        icon: Sparkles,
    },
];

type Props = {
    snapshot: ComplianceSnapshot;
    accent: string;
    visuals: ChatVisualSpec[];
    onRunInChat: (prompt: string) => void;
};

export default function AgentComplianceReportsPanel({
    snapshot,
    accent,
    visuals,
    onRunInChat,
}: Props) {
    const renewalQueue = extractRenewalQueue(visuals, 6);

    return (
        <section className="rounded-2xl border border-border overflow-hidden bg-surface/50">
            <div
                className="px-4 py-4 border-b border-border bg-surface/40"
                style={{ boxShadow: `inset 3px 0 0 ${accent}` }}
            >
                <p className="text-sm font-bold text-foreground flex items-center gap-2">
                    <Shield size={16} style={{ color: accent }} />
                    Reports & letters
                </p>
                <p className="text-xs text-foreground-muted mt-1 max-w-xl">
                    Audit-ready outputs — full reports, evidence packs, NCR/CAPA letters, and gap analysis.
                </p>
            </div>

            <div className="px-4 py-3 border-b border-border bg-surface-2/20 flex flex-wrap gap-4 text-xs">
                <span>
                    <strong className="text-foreground">{snapshot.stats.certsTracked}</strong>{" "}
                    <span className="text-foreground-muted">certs tracked</span>
                </span>
                <span>
                    <strong className="text-foreground">{snapshot.stats.expiringSoon}</strong>{" "}
                    <span className="text-foreground-muted">expiring</span>
                </span>
                <span>
                    <strong className="text-foreground">{snapshot.stats.findingsCount}</strong>{" "}
                    <span className="text-foreground-muted">findings</span>
                </span>
            </div>

            <div className="p-4 space-y-5">
                <div>
                    <p className="text-[10px] font-semibold uppercase tracking-wider text-foreground-muted mb-2">
                        Reports & packs
                    </p>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                        {REPORT_ACTIONS.map((action) => {
                            const Icon = action.icon;
                            return (
                                <button
                                    key={action.id}
                                    type="button"
                                    onClick={() => onRunInChat(action.prompt)}
                                    className="text-left rounded-xl border border-border bg-surface/40 px-3 py-3 hover:bg-surface-2/60 transition-colors"
                                >
                                    <Icon size={16} style={{ color: accent }} className="mb-2" />
                                    <p className="text-xs font-bold text-foreground">{action.label}</p>
                                    <p className="text-[10px] text-foreground-muted mt-0.5">{action.description}</p>
                                </button>
                            );
                        })}
                    </div>
                </div>

                <div>
                    <p className="text-[10px] font-semibold uppercase tracking-wider text-foreground-muted mb-2">
                        Corrective letters
                    </p>
                    <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                        {LETTER_ACTIONS.map((action) => {
                            const Icon = action.icon;
                            return (
                                <button
                                    key={action.id}
                                    type="button"
                                    onClick={() => onRunInChat(action.prompt)}
                                    className="text-left rounded-xl border border-border bg-surface/40 px-3 py-3 hover:bg-surface-2/60 transition-colors"
                                >
                                    <Icon size={16} style={{ color: accent }} className="mb-2" />
                                    <p className="text-xs font-bold text-foreground">{action.label}</p>
                                    <p className="text-[10px] text-foreground-muted mt-0.5">{action.description}</p>
                                </button>
                            );
                        })}
                    </div>
                </div>

                {renewalQueue.length > 0 && (
                    <AgentComplianceRegisterTable
                        rows={renewalQueue}
                        accent={accent}
                        maxRows={6}
                        onAsk={onRunInChat}
                        title="Renewal queue — expiring & expired"
                    />
                )}
            </div>
        </section>
    );
}
