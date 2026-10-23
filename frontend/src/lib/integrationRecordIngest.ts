/** Universal structured record push — works for every integration connection push URL. */

export type StructuredRecordPayload = {
    recordType: string;
    data: Record<string, unknown>;
    externalId?: string;
    title?: string;
    phase3Agent?: string;
    externalRef?: Record<string, unknown>;
};

/** recordType → default agent workspace (override with phase3Agent or connection default). */
export const STRUCTURED_RECORD_AGENT_MAP: Record<string, string> = {
    candidate: "hr_agent",
    employee: "hr_agent",
    resume: "hr_agent",
    payroll: "hr_agent",
    leave: "hr_agent",
    attendance: "hr_agent",
    performance: "hr_agent",
    invoice: "finance_agent",
    expense: "finance_agent",
    payment: "finance_agent",
    tax: "finance_agent",
    bank_statement: "finance_agent",
    budget: "finance_agent",
    finance_report: "finance_agent",
    purchase_order: "procurement_agent",
    po: "procurement_agent",
    quotation: "procurement_agent",
    rfq: "procurement_agent",
    supplier: "procurement_agent",
    delivery_note: "procurement_agent",
    procurement_request: "procurement_agent",
    certificate: "compliance_agent",
    compliance: "compliance_agent",
    audit: "compliance_agent",
    inspection: "compliance_agent",
    capa: "compliance_agent",
    sop: "compliance_agent",
    iso: "compliance_agent",
    contract: "legal_agent",
    nda: "legal_agent",
    agreement: "legal_agent",
    lease: "legal_agent",
    vendor_contract: "legal_agent",
    task: "hr_agent",
    generic: "hr_agent",
};

export const STRUCTURED_RECORD_TYPES = Object.keys(STRUCTURED_RECORD_AGENT_MAP);

export const STRUCTURED_RECORD_EXAMPLES: Record<string, StructuredRecordPayload> = {
    hr_agent: {
        recordType: "candidate",
        externalId: "erp:candidate:9921",
        title: "John Smith",
        phase3Agent: "hr_agent",
        data: { name: "John Smith", email: "john@example.com", cvScore: 85, stage: "Interview" },
    },
    finance_agent: {
        recordType: "invoice",
        externalId: "sap:inv:44001",
        title: "Acme invoice 44001",
        phase3Agent: "finance_agent",
        data: { vendor: "Acme Ltd", amount: 1200, currency: "USD", po_number: "PO-9921" },
    },
    procurement_agent: {
        recordType: "purchase_order",
        externalId: "erp:po:7781",
        title: "PO-7781",
        phase3Agent: "procurement_agent",
        data: { supplier: "Global Parts", total: 5400, status: "Open", line_count: 12 },
    },
    compliance_agent: {
        recordType: "certificate",
        externalId: "qms:cert:iso9001",
        title: "ISO 9001 renewal",
        phase3Agent: "compliance_agent",
        data: { standard: "ISO 9001", expiry_date: "2027-06-30", site: "Plant A" },
    },
    legal_agent: {
        recordType: "contract",
        externalId: "clm:contract:881",
        title: "Vendor MSA",
        phase3Agent: "legal_agent",
        data: { counterparty: "Beta Corp", effective_date: "2026-01-01", risk_flags: ["auto-renewal"] },
    },
};

export const STRUCTURED_RECORD_EXAMPLE = STRUCTURED_RECORD_EXAMPLES.hr_agent;

export function structuredRecordPushBodyExample(agentId?: string): string {
    const key = agentId as keyof typeof STRUCTURED_RECORD_EXAMPLES;
    const ex =
        key && STRUCTURED_RECORD_EXAMPLES[key]
            ? STRUCTURED_RECORD_EXAMPLES[key]
            : STRUCTURED_RECORD_EXAMPLE;
    return JSON.stringify(ex, null, 2);
}

export function defaultAgentForRecordType(recordType: string): string | undefined {
    return STRUCTURED_RECORD_AGENT_MAP[recordType.trim().toLowerCase().replace(/[\s-]+/g, "_")];
}

export type IngestAuthMode = "integration_key" | "bearer_token" | "basic_auth" | "custom_header" | "query_key";

/**
 * One ready-to-run curl command for whoever configures the ERP/middleware side —
 * matches api-gateway/src/services/integrationIngestAuth.ts exactly (header names,
 * Bearer/Basic formats) so it's copy-paste-correct, not just illustrative.
 */
export function buildCurlExample(params: {
    pushUrl: string;
    authMode: string;
    authValue?: string; // bearer token, or custom header secret
    basicUsername?: string;
    basicPassword?: string;
    customHeaderName?: string;
    agentId?: string;
}): string {
    const { pushUrl, authMode, authValue, basicUsername, basicPassword, customHeaderName, agentId } = params;
    const url = pushUrl || "<push URL from Status tab>";
    const lines = [`curl -X POST '${url}' \\`, `  -H 'Content-Type: application/json' \\`];

    if (authMode === "bearer_token") {
        lines.push(`  -H 'Authorization: Bearer ${authValue || "<bearer token from Status tab>"}' \\`);
    } else if (authMode === "basic_auth") {
        lines.push(`  -u '${basicUsername || "<username>"}:${basicPassword || "<password>"}' \\`);
    } else if (authMode === "custom_header") {
        lines.push(`  -H '${customHeaderName || "X-Api-Key"}: ${authValue || "<secret from Status tab>"}' \\`);
    }
    // integration_key / query_key modes: the ?key= already in the URL is all that's needed.

    const body = structuredRecordPushBodyExample(agentId);
    lines.push(`  -d '${body.replace(/'/g, "'\\''")}'`);
    return lines.join("\n");
}
