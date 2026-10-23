import { resolveDocAgent, inferDocTypeFromFilename } from "@/lib/documentAgents";
import { isFinanceAnalyticsDoc } from "@/lib/financeAnalyticsScope";
import { isComplianceAnalyticsDoc } from "@/lib/complianceAnalyticsScope";

/** Any library doc that can drive dynamic / agent analytics charts. */
type ScopeDoc = {
    documentId: string;
    originalFilename?: string;
    classification?: string | null;
    mimeType?: string | null;
    metadata?: { phase3Agent?: string } | null;
};

const EXCLUDED = new Set(["offer_letter", "experience_letter"]);

export function isAnalyticsScopeDoc(doc: ScopeDoc): boolean {
    const c = String(doc.classification || "").toLowerCase();
    if (EXCLUDED.has(c)) return false;
    const agent = resolveDocAgent(doc as Parameters<typeof resolveDocAgent>[0]);
    if (
        agent === "finance_agent" ||
        agent === "hr_agent" ||
        agent === "compliance_agent" ||
        agent === "procurement_agent" ||
        agent === "legal_agent" ||
        agent === "other_agent"
    ) {
        return true;
    }
    const inferred = inferDocTypeFromFilename(doc.originalFilename || "");
    if (inferred && !EXCLUDED.has(inferred)) return true;
    const name = (doc.originalFilename || "").toLowerCase();
    if (/\b(cv|resume|invoice|certificate|audit|quotation|contract|nda|po)\b/i.test(name)) return true;
    return false;
}

export function filterAnalyticsScopeDocIds(docs: ScopeDoc[], ids: string[]): string[] {
    const set = new Set(ids);
    return docs.filter((d) => set.has(d.documentId) && isAnalyticsScopeDoc(d)).map((d) => d.documentId);
}

/** Restrict analytics/chat scope to the agent the user selected. */
export function filterDocIdsForAgent(docs: ScopeDoc[], ids: string[], agentId: string): string[] {
    const set = new Set(ids);
    return docs
        .filter((d) => {
            if (!set.has(d.documentId) || !isAnalyticsScopeDoc(d)) return false;
            if (resolveDocAgent(d as Parameters<typeof resolveDocAgent>[0]) !== agentId) return false;
            if (agentId === "finance_agent" && !isFinanceAnalyticsDoc(d)) return false;
            if (agentId === "compliance_agent" && !isComplianceAnalyticsDoc(d)) return false;
            return true;
        })
        .map((d) => d.documentId);
}
