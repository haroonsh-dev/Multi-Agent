"use client";

import { useCallback, useEffect, useState } from "react";
import { apiRequest } from "@/lib/apiClient";
import { AGENT_OPTIONS } from "@/lib/documentAgents";
import { usePermissions } from "@/context/PermissionsContext";

export type PlanAgentOption = { value: string; label: string };

const ALL_AGENTS: PlanAgentOption[] = AGENT_OPTIONS.filter((o) => o.value);

/**
 * Agents the current user may use:
 * - Super Admin: all
 * - Org admin: full org plan
 * - Team: org plan ∩ department.allowedAgents
 *
 * orgAllowedIds is always the org subscription (for department admin UI).
 */
export function usePlanAgents() {
    const { role } = usePermissions();
    const [allowedIds, setAllowedIds] = useState<string[] | null>(null);
    const [orgAllowedIds, setOrgAllowedIds] = useState<string[] | null>(null);
    const [loading, setLoading] = useState(true);

    const reload = useCallback(async () => {
        if (role === "superAdmin") {
            const all = ALL_AGENTS.map((a) => a.value);
            setAllowedIds(all);
            setOrgAllowedIds(all);
            setLoading(false);
            return;
        }
        setLoading(true);
        try {
            const data = await apiRequest("/docs/plans/subscription");
            const ent = data?.data?.entitlement;
            const effective: string[] = ent?.agentIds || [];
            const withOther = effective.includes("other_agent") ? effective : [...effective, "other_agent"];
            const org: string[] = ent?.orgAgentIds || effective;
            const orgWithOther = org.includes("other_agent") ? org : [...org, "other_agent"];
            setAllowedIds(withOther);
            setOrgAllowedIds(orgWithOther);
        } catch {
            setAllowedIds(["other_agent"]);
            setOrgAllowedIds(["other_agent"]);
        } finally {
            setLoading(false);
        }
    }, [role]);

    useEffect(() => {
        reload();
    }, [reload]);

    // Never flash the full catalog for org/team while entitlement is unknown
    const agentOptions: PlanAgentOption[] =
        role === "superAdmin"
            ? ALL_AGENTS
            : allowedIds
              ? ALL_AGENTS.filter((a) => allowedIds.includes(a.value))
              : [];

    const orgAgentOptions: PlanAgentOption[] =
        role === "superAdmin"
            ? ALL_AGENTS
            : orgAllowedIds
              ? ALL_AGENTS.filter((a) => orgAllowedIds.includes(a.value))
              : [];

    const isAgentAllowed = useCallback(
        (agentId: string) => {
            if (role === "superAdmin") return true;
            if (!agentId || agentId === "other_agent") return true;
            // Until entitlement loads, do not block uploads/classify
            if (loading || allowedIds === null) return true;
            return allowedIds.includes(agentId);
        },
        [role, loading, allowedIds]
    );

    return {
        agentOptions,
        orgAgentOptions,
        allowedIds,
        orgAllowedIds,
        loading,
        reload,
        isAgentAllowed,
    };
}
