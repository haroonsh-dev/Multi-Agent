"use client";

import { useCallback, useEffect, useState } from "react";
import { apiRequest } from "@/lib/apiClient";
import type { AnalyticsAgentId } from "@/lib/documentAgents";
import type { WorkspaceIntegration } from "@/lib/integrationConnections";

export function useAgentIntegrations(agentId: AnalyticsAgentId | null, enabled = true) {
    const [connections, setConnections] = useState<WorkspaceIntegration[]>([]);
    const [allConnections, setAllConnections] = useState<WorkspaceIntegration[]>([]);
    const [loading, setLoading] = useState(false);

    const load = useCallback(async () => {
        if (!enabled) return;
        setLoading(true);
        try {
            const res = await apiRequest("/docs/integrations");
            const raw = (res?.data?.connections || []) as Array<Record<string, unknown>>;
            const rows: WorkspaceIntegration[] = raw.map((r) => ({
                connectionId: String(r.connectionId || ""),
                providerId: String(r.providerId || ""),
                label: String(r.label || "Connection"),
                useCase: r.useCase != null ? String(r.useCase) : null,
                defaultPhase3Agent:
                    r.defaultPhase3Agent != null
                        ? String(r.defaultPhase3Agent)
                        : r.config && typeof r.config === "object" && (r.config as { phase3Agent?: string }).phase3Agent
                          ? String((r.config as { phase3Agent?: string }).phase3Agent)
                          : null,
                lastSyncAt: r.lastSyncAt != null ? String(r.lastSyncAt) : null,
                lastStatus: r.lastStatus != null ? String(r.lastStatus) : null,
                lastSyncSummary: r.lastSyncSummary != null ? String(r.lastSyncSummary) : null,
                isActive: r.isActive !== false,
                syncMode: r.syncMode != null ? String(r.syncMode) : undefined,
                hasOutboundWebhook: Boolean(r.hasOutboundWebhook),
            }));
            setAllConnections(rows);
            if (agentId) {
                setConnections(rows.filter((c) => c.defaultPhase3Agent === agentId));
            } else {
                setConnections(rows);
            }
        } catch {
            setConnections([]);
            setAllConnections([]);
        } finally {
            setLoading(false);
        }
    }, [agentId, enabled]);

    useEffect(() => {
        void load();
    }, [load]);

    return { connections, allConnections, loading, refresh: load };
}
