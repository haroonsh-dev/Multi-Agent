"use client";

import Link from "next/link";
import { X } from "lucide-react";
import { agentLabel } from "@/lib/documentAgents";

export type AgentBlockItem = {
    filename?: string;
    typeLabel: string;
    agentId: string;
};

type Role = string | null | undefined;

type Props = {
    items: AgentBlockItem[];
    coveredAgents: string[];
    role?: Role;
    onDismiss?: () => void;
    /** Compact variant for classify popup */
    compact?: boolean;
};

function isOrganizationAdmin(role: Role) {
    return role === "admin";
}

export default function AgentAccessBlockedNotice({
    items,
    coveredAgents,
    role,
    onDismiss,
    compact = false,
}: Props) {
    if (role === "superAdmin") return null;
    const covered =
        coveredAgents.map((id) => agentLabel(id)).filter(Boolean).join(", ") || "none";
    const primary = items[0];
    const title =
        items.length === 1
            ? `Upload blocked — ${primary.typeLabel} needs ${agentLabel(primary.agentId)}`
            : `Upload blocked — ${items.length} files need agents not on your access`;

    return (
        <div
            className={
                compact
                    ? "rounded-xl p-3 border border-rose-500/30 bg-rose-500/10 space-y-2.5"
                    : "rounded-xl border border-rose-200 bg-rose-50 text-rose-900 px-4 py-3.5 text-sm space-y-2.5 relative"
            }
        >
            {onDismiss && !compact && (
                <button
                    type="button"
                    onClick={onDismiss}
                    className="absolute top-2.5 right-2.5 p-1 rounded-lg text-rose-400 hover:text-rose-700 hover:bg-rose-100"
                    aria-label="Dismiss"
                >
                    <X size={14} />
                </button>
            )}

            <div className={compact ? "pr-0" : "pr-6"}>
                <p
                    className={
                        compact
                            ? "text-xs font-semibold text-rose-200"
                            : "font-semibold text-rose-800"
                    }
                >
                    {title}
                </p>
                {items.length > 1 && (
                    <ul
                        className={
                            compact
                                ? "mt-1.5 space-y-0.5 text-[11px] text-foreground-muted"
                                : "mt-1.5 space-y-0.5 text-xs text-rose-700/90"
                        }
                    >
                        {items.map((it, i) => (
                            <li key={`${it.filename || it.typeLabel}-${i}`}>
                                {it.filename ? `${it.filename} — ` : ""}
                                {it.typeLabel} → {agentLabel(it.agentId)}
                            </li>
                        ))}
                    </ul>
                )}
            </div>

            <div>
                <p
                    className={
                        compact
                            ? "text-[10px] font-semibold uppercase tracking-wider text-rose-300/90 mb-1.5"
                            : "text-[10px] font-semibold uppercase tracking-wider text-rose-600/80 mb-1.5"
                    }
                >
                    Choose what to do
                </p>
                <ol
                    className={
                        compact
                            ? "space-y-1.5 text-[11px] text-foreground-muted list-decimal list-inside"
                            : "space-y-1.5 text-xs text-rose-800/90 list-decimal list-inside"
                    }
                >
                    {isOrganizationAdmin(role) ? (
                        <li>
                            <Link
                                href="/plans"
                                className={
                                    compact
                                        ? "font-semibold text-(--vb-blue-bright) hover:text-(--vb-blue-bright) underline-offset-2 hover:underline"
                                        : "font-semibold text-(--vb-blue-dark) hover:text-(--vb-blue-dark) underline-offset-2 hover:underline"
                                }
                            >
                                Upgrade / change plan
                            </Link>
                            <span> (add {agentLabel(primary.agentId)})</span>
                        </li>
                    ) : (
                        <li>
                            Ask your admin for department access to{" "}
                            <span className={compact ? "text-foreground font-medium" : "font-medium"}>
                                {agentLabel(primary.agentId)}
                            </span>
                            {items.length > 1 ? " (and other missing agents)" : ""}
                        </li>
                    )}
                    <li>
                        Upload a different file that&apos;s covered by:{" "}
                        <span className={compact ? "text-foreground font-medium" : "font-medium"}>
                            {covered}
                        </span>
                    </li>
                </ol>
            </div>
        </div>
    );
}
