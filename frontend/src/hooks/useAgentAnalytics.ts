"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { apiRequest } from "@/lib/apiClient";
import type { AnalyticsPanelView } from "@/components/ChatAnalyticsSidePanel";
import type {
    AgentAnalyticsCoverage,
    ChatVisualSpec,
    ComplianceAnalyticsCoverage,
    FinanceAnalyticsCoverage,
} from "@/types/chatVisuals";
import { isAnalyticsAgentId } from "@/lib/documentAgents";

const POLL_MS = 45_000;

export function useAgentAnalytics(options?: { poll?: boolean }) {
    const [visuals, setVisuals] = useState<ChatVisualSpec[]>([]);
    const [loading, setLoading] = useState(false);
    const [documentCount, setDocumentCount] = useState<number | undefined>();
    const [scopeMode, setScopeMode] = useState<"all" | "selected">("all");
    const [coverage, setCoverage] = useState<
        FinanceAnalyticsCoverage | ComplianceAnalyticsCoverage | AgentAnalyticsCoverage | null
    >(null);
    const [summary, setSummary] = useState("");
    const [lastUpdated, setLastUpdated] = useState<string | null>(null);
    const [live, setLive] = useState(options?.poll !== false);
    const agentRef = useRef<string>("");
    const viewRef = useRef<AnalyticsPanelView>("overview");

    const load = useCallback(async (agentId: string, view: AnalyticsPanelView = "overview", silent = false) => {
        if (!isAnalyticsAgentId(agentId)) return;
        agentRef.current = agentId;
        viewRef.current = view;
        if (!silent) setLoading(true);
        try {
            const params = new URLSearchParams({
                agent: agentId,
                mode: "dashboard",
            });
            if (view !== "overview") params.set("view", view);
            const data = await apiRequest(`/docs/chat/analytics?${params.toString()}`);
            setVisuals(Array.isArray(data?.data?.visuals) ? (data.data.visuals as ChatVisualSpec[]) : []);
            const count = data?.data?.documentCount;
            setDocumentCount(typeof count === "number" ? count : undefined);
            setSummary(typeof data?.data?.summary === "string" ? data.data.summary : "");
            const cov = data?.data?.coverage;
            setCoverage(cov && typeof cov === "object" ? cov : null);
            setScopeMode(data?.data?.scopeMode === "selected" ? "selected" : "all");
            setLastUpdated(new Date().toISOString());
        } catch {
            if (!silent) {
                setVisuals([]);
                setDocumentCount(undefined);
                setSummary("");
                setCoverage(null);
            }
        } finally {
            if (!silent) setLoading(false);
        }
    }, []);

    useEffect(() => {
        if (!live) return;
        const id = setInterval(() => {
            if (agentRef.current) void load(agentRef.current, viewRef.current, true);
        }, POLL_MS);
        return () => clearInterval(id);
    }, [live, load]);

    return { visuals, loading, documentCount, scopeMode, coverage, summary, lastUpdated, live, setLive, load };
}
