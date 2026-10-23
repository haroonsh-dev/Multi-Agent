"use client";

import { useCallback, useEffect, useState } from "react";
import { apiRequest } from "@/lib/apiClient";
import type { AnalyticsAgentId } from "@/lib/documentAgents";
import { resolveDocAgent } from "@/lib/documentAgents";

export type AgentVaultDoc = {
    documentId: string;
    originalFilename: string;
    classification?: string | null;
    status?: string | null;
    createdAt?: string | null;
    metadata?: {
        phase3Agent?: string;
        cvScore?: number;
        shortlistApproved?: boolean;
        pipelineStatus?: string;
    } | null;
};

export function useAgentPortfolio(agentId: AnalyticsAgentId | null, enabled = true) {
    const [docs, setDocs] = useState<AgentVaultDoc[]>([]);
    const [loading, setLoading] = useState(false);

    const load = useCallback(async () => {
        if (!agentId || !enabled) return;
        setLoading(true);
        try {
            const data = await apiRequest("/docs/documents?limit=200&sort=-createdAt");
            const rows = (data?.data?.documents || []) as AgentVaultDoc[];
            setDocs(rows.filter((d) => resolveDocAgent(d) === agentId));
        } catch {
            setDocs([]);
        } finally {
            setLoading(false);
        }
    }, [agentId, enabled]);

    useEffect(() => {
        void load();
    }, [load]);

    return { docs, loading, refresh: load };
}
