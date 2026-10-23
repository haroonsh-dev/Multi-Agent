import { getIntegrationById } from "@/lib/integrationCatalog";
import { agentLabel, type AnalyticsAgentId } from "@/lib/documentAgents";
import { getProviderCapabilities } from "@/lib/integrationCapabilities";

export type WorkspaceIntegration = {
    connectionId: string;
    providerId: string;
    label: string;
    useCase?: string | null;
    defaultPhase3Agent?: string | null;
    lastSyncAt?: string | null;
    lastStatus?: string | null;
    lastSyncSummary?: string | null;
    isActive?: boolean;
    syncMode?: string;
    hasOutboundWebhook?: boolean;
};

const USE_CASE_LABELS: Record<string, string> = {
    ap: "Finance — AP",
    ar: "Finance — AR",
    gl: "Finance — GL",
    payroll: "HR — Payroll",
    hiring: "HR — Hiring",
    contracts: "Legal — Contracts",
    po: "Procurement — PO",
    qc: "Compliance — QC",
    capa: "Compliance — CAPA",
    maintenance: "Maintenance",
};

export function providerDisplayName(providerId: string): string {
    return getIntegrationById(providerId)?.name || providerId.replace(/_/g, " ");
}

export function useCaseLabel(useCase?: string | null): string | null {
    const key = String(useCase || "").trim();
    if (!key) return null;
    return USE_CASE_LABELS[key] || key.replace(/_/g, " ");
}

export function connectionMode(providerId: string): {
    id: "live_sync" | "push" | "middleware";
    label: string;
    hint: string;
} {
    const caps = getProviderCapabilities(providerId);
    if (caps.pullSchedule || caps.pullManual) {
        return {
            id: "live_sync",
            label: "Live sync",
            hint: caps.middlewarePush
                ? "Visibility can pull on schedule; ERP files usually arrive via middleware push to your ingest URL"
                : "Visibility pulls or receives files on a schedule or webhook",
        };
    }
    if (caps.pushIngest && !caps.middlewarePush) {
        return {
            id: "push",
            label: "HTTP push",
            hint: "External system POSTs files to your unique ingest URL",
        };
    }
    return {
        id: "middleware",
        label: "Via middleware",
        hint: "Store ERP credentials here for Test + routing. POST files to your push URL from CPI, Power Automate, or ETL",
    };
}

export function syncStatusTone(lastStatus?: string | null): "ok" | "warn" | "muted" {
    const s = String(lastStatus || "").toLowerCase();
    if (!s) return "muted";
    if (s.includes("ok") || s.includes("success")) return "ok";
    if (s.includes("fail") || s.includes("error")) return "warn";
    return "muted";
}

export function formatLastSync(iso?: string | null): string {
    if (!iso) return "Never synced";
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return "Never synced";
    const mins = Math.floor((Date.now() - d.getTime()) / 60000);
    if (mins < 1) return "Synced just now";
    if (mins < 60) return `Synced ${mins}m ago`;
    if (mins < 1440) return `Synced ${Math.floor(mins / 60)}h ago`;
    return `Synced ${d.toLocaleDateString()}`;
}

export function agentForConnection(row: WorkspaceIntegration): string | null {
    return row.defaultPhase3Agent || null;
}

export function connectionSummaryLine(rows: WorkspaceIntegration[]): string {
    if (!rows.length) return "manual uploads only";
    if (rows.length === 1) {
        const r = rows[0];
        return `${providerDisplayName(r.providerId)} · ${r.label}`;
    }
    const names = rows.slice(0, 2).map((r) => r.label);
    const extra = rows.length > 2 ? ` +${rows.length - 2}` : "";
    return `${names.join(", ")}${extra}`;
}

export function filterIntegrationsForAgent(
    rows: WorkspaceIntegration[],
    agentId: AnalyticsAgentId
): WorkspaceIntegration[] {
    return rows.filter((c) => c.defaultPhase3Agent === agentId);
}

export function supportsManualSync(providerId: string): boolean {
    return getProviderCapabilities(providerId).pullManual;
}

export function feedsAgentLabel(agentId?: string | null): string {
    if (!agentId) return "Auto-detect agent";
    try {
        return agentLabel(agentId);
    } catch {
        return agentId.replace(/_/g, " ");
    }
}
