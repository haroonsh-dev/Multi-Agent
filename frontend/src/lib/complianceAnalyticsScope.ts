import { resolveDocAgent } from "@/lib/documentAgents";

const COMPLIANCE_TYPES = new Set([
    "sop",
    "audit_report",
    "quality_report",
    "certificate",
    "maintenance_report",
    "engineering_drawing",
    "inspection_report",
    "safety_manual",
    "iso_document",
    "compliance_form",
    "regulatory_document",
]);

type ScopeDoc = {
    documentId: string;
    originalFilename?: string;
    classification?: string | null;
    metadata?: { phase3Agent?: string } | null;
};

export function isComplianceAnalyticsDoc(doc: ScopeDoc): boolean {
    const c = String(doc.classification || "").toLowerCase();
    // Generated reports are library artifacts, not chart sources.
    if (c === "compliance_report") return false;
    const agent = resolveDocAgent(doc as Parameters<typeof resolveDocAgent>[0]);
    if (agent === "compliance_agent") return true;
    return COMPLIANCE_TYPES.has(c);
}

export function filterComplianceAnalyticsDocIds(docs: ScopeDoc[], ids: string[]): string[] {
    const set = new Set(ids);
    return docs.filter((d) => set.has(d.documentId) && isComplianceAnalyticsDoc(d)).map((d) => d.documentId);
}
