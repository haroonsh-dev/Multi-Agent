"use client";

import React, { useState, useEffect } from "react";
import { X, Trash2 } from "lucide-react";
import { AGENT_OPTIONS, DOC_TYPE_TO_AGENT, DOC_TYPE_LABELS, agentLabel } from "@/lib/documentAgents";
import { usePlanAgents } from "@/hooks/usePlanAgents";
import { usePermissions } from "@/context/PermissionsContext";
import AgentAccessBlockedNotice from "@/components/AgentAccessBlockedNotice";

type ClassifyDoc = {
    documentId: string;
    pythonDocumentId?: string;
    originalFilename?: string;
    title?: string;
    document_type?: string;
    classification?: string | null;
};

type Props = {
    doc: ClassifyDoc;
    queueLen?: number;
    defaultAgent?: string;
    onConfirm: (documentId: string, documentType: string, phase3Agent: string) => void;
    /** Called when user explicitly chooses to remove this upload. */
    onRejectUpload: (documentId: string, reason: string) => void | Promise<void>;
    onDismiss: () => void;
};

export default function ClassifyAgentPopup({
    doc,
    queueLen = 1,
    defaultAgent,
    onConfirm,
    onRejectUpload,
    onDismiss,
}: Props) {
    const rawType = (doc.document_type || doc.classification || "other").toString().trim();
    const docType = rawType.toLowerCase().replace(/\s+/g, "_");
    const typeLabel = DOC_TYPE_LABELS[docType] || docType.replace(/_/g, " ");
    const naturalAgent = DOC_TYPE_TO_AGENT[docType] || "other_agent";
    const suggested = defaultAgent || naturalAgent;
    const { agentOptions, allowedIds, loading, isAgentAllowed } = usePlanAgents();
    const { role } = usePermissions();
    const superAdmin = role === "superAdmin";

    const baseAgents = agentOptions.length
        ? agentOptions
        : superAdmin
          ? AGENT_OPTIONS.filter((o) => o.value)
          : [];
    const agents = baseAgents.some((a) => a.value === "other_agent")
        ? baseAgents
        : [...baseAgents, { value: "other_agent", label: "Other Agent" }];

    // Check if the natural agent for this doc type is on plan
    const naturalOnPlan = superAdmin || (!loading && isAgentAllowed(naturalAgent));

    // Choose initial agent
    const [agent, setAgent] = useState<string>(() => {
        if (suggested && (superAdmin || isAgentAllowed(suggested))) return suggested;
        if (naturalAgent && (superAdmin || isAgentAllowed(naturalAgent))) return naturalAgent;
        return agents[0]?.value || naturalAgent;
    });

    const [removing, setRemoving] = useState(false);

    // Synchronize agent once plan finishes loading if initial state defaulted
    useEffect(() => {
        if (!loading) {
            if (suggested && (superAdmin || isAgentAllowed(suggested))) {
                setAgent(suggested);
            } else if (naturalAgent && (superAdmin || isAgentAllowed(naturalAgent))) {
                setAgent(naturalAgent);
            } else if (agents.length > 0 && !agents.some((a) => a.value === agent)) {
                setAgent(agents[0].value);
            }
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [loading, suggested, naturalAgent, superAdmin]);

    // Close on Escape key
    useEffect(() => {
        const handleKeyDown = (e: KeyboardEvent) => {
            if (e.key === "Escape") {
                onDismiss();
            }
        };
        window.addEventListener("keydown", handleKeyDown);
        return () => window.removeEventListener("keydown", handleKeyDown);
    }, [onDismiss]);

    // Can save whenever the currently selected agent is allowed for this user
    const canSave = superAdmin || (!loading && isAgentAllowed(agent));

    const planLabels = (allowedIds || agents.map((a) => a.value))
        .map((id) => agentLabel(id))
        .join(", ");

    return (
        <div
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm p-4 animate-in fade-in duration-150"
            onClick={onDismiss}
        >
            <div
                className="surface-card p-4 sm:p-6 space-y-4 border border-border w-full max-w-md shadow-2xl relative"
                onClick={(e) => e.stopPropagation()}
            >
                <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                            <h3 className="text-lg font-bold text-foreground">Classification result</h3>
                            {queueLen > 1 && (
                                <span className="text-xs px-2 py-0.5 rounded-full bg-[rgba(56,182,255,0.2)] text-(--vb-blue-bright) font-medium shrink-0">
                                    1 of {queueLen}
                                </span>
                            )}
                        </div>
                        <p className="text-sm text-foreground-muted mt-1 truncate" title={doc.originalFilename || doc.title || "Document"}>
                            {doc.originalFilename || doc.title || "Document"}
                        </p>
                    </div>
                    <button
                        type="button"
                        onClick={onDismiss}
                        className="p-1.5 rounded-lg text-foreground-muted hover:text-foreground hover:bg-surface-2 transition-colors cursor-pointer shrink-0"
                        aria-label="Close modal"
                        title="Close"
                    >
                        <X size={18} />
                    </button>
                </div>

                <div className="rounded-xl p-4 bg-[rgba(56,182,255,0.1)] border border-[rgba(56,182,255,0.2)]">
                    <p className="text-xs font-semibold text-(--vb-blue-bright) uppercase tracking-wider">Detected type</p>
                    <p className="text-lg font-bold text-foreground mt-1">{typeLabel}</p>
                    <p className="text-xs text-foreground-muted mt-1">
                        Suggested agent: {agentLabel(naturalAgent)}
                    </p>
                </div>

                <div className="rounded-xl p-3 border border-border bg-surface-2/60 space-y-1">
                    <p className="text-[10px] font-semibold uppercase tracking-wider text-foreground-muted">
                        Your agent access
                    </p>
                    <p className="text-xs text-foreground">
                        {loading ? "Loading…" : planLabels || "None"}
                    </p>
                </div>

                {!loading && !naturalOnPlan && role !== "superAdmin" && (
                    <AgentAccessBlockedNotice
                        compact
                        role={role}
                        items={[
                            {
                                filename: doc.originalFilename || doc.title,
                                typeLabel,
                                agentId: naturalAgent,
                            },
                        ]}
                        coveredAgents={allowedIds || agents.map((a) => a.value)}
                    />
                )}

                <div>
                    <label className="text-xs font-semibold text-foreground-muted uppercase tracking-wider block mb-2">
                        Extraction agent
                    </label>
                    <select
                        value={agent}
                        onChange={(e) => setAgent(e.target.value)}
                        className="w-full premium-input rounded-xl px-4 py-2.5 text-sm cursor-pointer"
                    >
                        {agents.map((t) => (
                            <option key={t.value} value={t.value}>
                                {t.label} {!isAgentAllowed(t.value) && !superAdmin ? "(not on your access)" : ""}
                            </option>
                        ))}
                    </select>
                </div>

                <div className="space-y-2 pt-2">
                    <div className="flex gap-3">
                        <button
                            type="button"
                            onClick={onDismiss}
                            className="btn-secondary flex-1 rounded-xl py-2.5 text-sm cursor-pointer font-medium"
                        >
                            Dismiss
                        </button>
                        <button
                            type="button"
                            disabled={!canSave || !agent || removing}
                            onClick={() => onConfirm(doc.documentId, docType, agent)}
                            className="btn-gradient flex-1 rounded-xl py-2.5 text-sm disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer font-medium"
                        >
                            Save agent
                        </button>
                    </div>

                    {(!naturalOnPlan || !canSave) && (
                        <div className="flex justify-center pt-1">
                            <button
                                type="button"
                                disabled={removing}
                                onClick={async () => {
                                    setRemoving(true);
                                    const reason = `${typeLabel} needs ${agentLabel(naturalAgent)}, which is not on your access`;
                                    await onRejectUpload(doc.documentId, reason);
                                }}
                                className="inline-flex items-center gap-1.5 text-xs text-rose-500 hover:text-rose-600 transition-colors py-1 px-2 cursor-pointer disabled:opacity-50"
                            >
                                <Trash2 size={13} />
                                {removing ? "Removing upload…" : "Remove this file from library"}
                            </button>
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
}
