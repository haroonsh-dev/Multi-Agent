"use client";

import { useCallback, useEffect, useState } from "react";
import { apiRequest } from "@/lib/apiClient";

export type WorkspaceActivityItem = {
    logId: string;
    action: string;
    category: string;
    message?: string;
    actorName?: string;
    createdAt: string;
    outcome: string;
};

type ActivityLogRow = WorkspaceActivityItem & {
    metadata?: { phase3Agent?: string; agentId?: string };
};

function matchesAgent(log: ActivityLogRow, agentId: string): boolean {
    const metaAgent = String(log.metadata?.phase3Agent || log.metadata?.agentId || "");
    if (metaAgent === agentId) return true;
    const slug = agentId.replace("_agent", "");
    const hay = `${log.message || ""} ${log.action}`.toLowerCase();
    return hay.includes(slug) || hay.includes(agentId);
}

export function useWorkspaceActivity(limit = 6, agentId?: string | null) {
    const [items, setItems] = useState<WorkspaceActivityItem[]>([]);
    const [loading, setLoading] = useState(true);

    const load = useCallback(async () => {
        setLoading(true);
        try {
            const fetchLimit = agentId ? Math.max(limit * 4, 24) : limit;
            const data = await apiRequest(`/docs/activity?page=1&limit=${fetchLimit}`);
            const logs = (data?.data?.logs || []) as ActivityLogRow[];
            let filtered = logs.filter((l) => l.category === "chat" || l.category === "document");
            if (agentId) {
                filtered = filtered.filter((l) => matchesAgent(l, agentId));
            }
            setItems(filtered.slice(0, limit));
        } catch {
            setItems([]);
        } finally {
            setLoading(false);
        }
    }, [limit, agentId]);

    useEffect(() => {
        void load();
    }, [load]);

    return { items, loading, refresh: load };
}
