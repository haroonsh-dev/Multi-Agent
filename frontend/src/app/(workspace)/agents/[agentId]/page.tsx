"use client";

import React, { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useParams, useSearchParams } from "next/navigation";
import AgentWorkspaceShell from "@/components/AgentWorkspaceShell";
import { type AnalyticsPanelView } from "@/components/ChatAnalyticsSidePanel";
import { useAgentAnalytics } from "@/hooks/useAgentAnalytics";
import { useAgentIntegrations } from "@/hooks/useAgentIntegrations";
import { usePlanAgents } from "@/hooks/usePlanAgents";
import { isAnalyticsAgentId, type AnalyticsAgentId } from "@/lib/documentAgents";
import { getAgentWorkspaceMeta } from "@/lib/agentWorkspace";
import { apiRequest } from "@/lib/apiClient";

export default function AgentWorkspacePage() {
    const params = useParams();
    const searchParams = useSearchParams();
    const agentId = String(params?.agentId || "");
    const tabParam = searchParams.get("tab");
    const initialTab =
        tabParam === "reports" ||
        tabParam === "charts" ||
        tabParam === "files" ||
        tabParam === "fix" ||
        tabParam === "ask"
            ? tabParam
            : "home";
    const meta = getAgentWorkspaceMeta(agentId);
    const { isAgentAllowed, loading: agentsLoading, agentOptions } = usePlanAgents();
    const { visuals, loading, documentCount, scopeMode, coverage, summary, lastUpdated, live, setLive, load } =
        useAgentAnalytics({ poll: true });
    const [view, setView] = useState<AnalyticsPanelView>("overview");
    const validAgentId = isAnalyticsAgentId(agentId) ? (agentId as AnalyticsAgentId) : null;
    const valid = Boolean(validAgentId) && isAgentAllowed(agentId);
    const {
        connections: integrations,
        loading: integrationsLoading,
        refresh: refreshIntegrations,
    } = useAgentIntegrations(validAgentId, valid);

    useEffect(() => {
        if (!valid || !validAgentId) return;
        void load(validAgentId, view);
    }, [valid, validAgentId, view, load]);

    const refresh = useCallback(() => {
        if (!validAgentId) return;
        void load(validAgentId, view);
        void refreshIntegrations();
    }, [validAgentId, view, load, refreshIntegrations]);

    const syncIntegration = useCallback(async (connectionId: string) => {
        const res = await apiRequest(`/docs/integrations/${connectionId}/sync`, { method: "POST" });
        await refreshIntegrations();
        return typeof res?.message === "string" ? res.message : "Sync complete";
    }, [refreshIntegrations]);

    if (agentsLoading) {
        return (
            <div className="flex items-center justify-center min-h-[50vh] text-sm text-foreground-muted">
                Loading workspace…
            </div>
        );
    }

    if (!valid || !meta || !validAgentId) {
        return (
            <div className="p-8 max-w-md mx-auto text-center space-y-4">
                <h1 className="text-lg font-semibold">Workspace unavailable</h1>
                <p className="text-sm text-foreground-muted">
                    This agent is not on your plan or the link is invalid.
                </p>
                <Link href="/agents" className="btn-gradient inline-flex rounded-xl px-4 py-2 text-sm">
                    All workspaces
                </Link>
            </div>
        );
    }

    return (
        <div className="h-full min-h-0 flex flex-col">
            <AgentWorkspaceShell
                agentId={validAgentId}
                meta={meta}
                agentOptions={agentOptions.filter((a) => a.value && isAnalyticsAgentId(a.value))}
                visuals={visuals}
                loading={loading}
                documentCount={documentCount}
                summary={summary}
                scopeMode={scopeMode}
                coverage={coverage}
                integrations={integrations}
                integrationsLoading={integrationsLoading}
                view={view}
                onViewChange={setView}
                onRefresh={refresh}
                onSyncIntegration={syncIntegration}
                lastUpdated={lastUpdated}
                live={live}
                onLiveChange={setLive}
                initialTab={initialTab}
            />
        </div>
    );
}
