"use client";

import { useCallback, useState } from "react";
import { apiRequest } from "@/lib/apiClient";

export type AgentFleetRow = {
    agentId: string;
    documentCount: number;
    readyCount: number;
    healthScore: number;
    healthLabel: "Ready" | "Partial" | "Empty" | "Needs work";
};

export function useAgentFleet() {
    const [agents, setAgents] = useState<AgentFleetRow[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);

    const load = useCallback(async () => {
        setLoading(true);
        setError(null);
        try {
            const res = await apiRequest("/docs/documents/agent-fleet");
            setAgents(Array.isArray(res?.data?.agents) ? res.data.agents : []);
        } catch (e: unknown) {
            setError(e instanceof Error ? e.message : "Failed to load agent fleet");
            setAgents([]);
        } finally {
            setLoading(false);
        }
    }, []);

    return { agents, loading, error, load };
}
