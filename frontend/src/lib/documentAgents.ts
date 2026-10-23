/**
 * CANONICAL SOURCE: the ai-backend agent registry
 * (ai-backend/app/services/agent_registry.py — AGENT_CATALOG + DOCUMENT_TO_PHASE3_AGENT).
 *
 * Keep this file in sync with the registry. A new agent or doc_type added upstream
 * must be reflected here or it will be missing from the UI. Run the drift check to
 * verify (from api-gateway/):
 *
 *   npm run test:catalog-drift
 *
 * Frontend-only doc_types below (e.g. *_letter, *_report, "po") are UI aliases the
 * classifier doesn't emit; the drift check reports them as non-blocking warnings.
 */
export const DOC_TYPE_TO_AGENT: Record<string, string> = {
    // Finance
    invoice: "finance_agent",
    financial_statement: "finance_agent",
    expense_report: "finance_agent",
    payment_receipt: "finance_agent",
    tax_document: "finance_agent",
    bank_statement: "finance_agent",
    budget: "finance_agent",
    // HR
    employee_record: "hr_agent",
    hr_document: "hr_agent",
    offer_letter: "hr_agent",
    experience_letter: "hr_agent",
    employment_contract: "hr_agent",
    leave_application: "hr_agent",
    payroll: "hr_agent",
    attendance: "hr_agent",
    performance_review: "hr_agent",
    training_certificate: "hr_agent",
    resume: "hr_agent",
    transcript: "hr_agent",
    hr_report: "hr_agent",
    hr_shortlist: "hr_agent",
    promotion_letter: "hr_agent",
    warning_letter: "hr_agent",
    relieving_letter: "hr_agent",
    joining_letter: "hr_agent",
    internship_letter: "hr_agent",
    // Legal
    contract: "legal_agent",
    agreement: "legal_agent",
    nda: "legal_agent",
    service_agreement: "legal_agent",
    lease_agreement: "legal_agent",
    vendor_contract: "legal_agent",
    // Procurement
    purchase_order: "procurement_agent",
    po: "procurement_agent",
    quotation: "procurement_agent",
    supplier_agreement: "procurement_agent",
    vendor_list: "procurement_agent",
    rfq: "procurement_agent",
    delivery_note: "procurement_agent",
    procurement_request: "procurement_agent",
    // Compliance
    sop: "compliance_agent",
    audit_report: "compliance_agent",
    quality_report: "compliance_agent",
    certificate: "compliance_agent",
    maintenance_report: "compliance_agent",
    engineering_drawing: "compliance_agent",
    inspection_report: "compliance_agent",
    safety_manual: "compliance_agent",
    iso_document: "compliance_agent",
    compliance_form: "compliance_agent",
    regulatory_document: "compliance_agent",
    compliance_report: "compliance_agent",
    finance_report: "finance_agent",
    ncr_letter: "compliance_agent",
    capa_letter: "compliance_agent",
    certificate_of_compliance: "compliance_agent",
    other: "other_agent",
};

export const AGENT_OPTIONS = [
    { value: "", label: "Auto (from document type)" },
    { value: "finance_agent", label: "Finance Agent" },
    { value: "procurement_agent", label: "Procurement Agent" },
    { value: "hr_agent", label: "HR Agent" },
    { value: "legal_agent", label: "Legal Agent" },
    { value: "compliance_agent", label: "Compliance Agent" },
    { value: "other_agent", label: "Other Agent" },
];

/** Agents with analytics dashboard + chat charts */
export const ANALYTICS_AGENT_IDS = [
    "finance_agent",
    "hr_agent",
    "compliance_agent",
    "procurement_agent",
    "legal_agent",
    "other_agent",
] as const;

export type AnalyticsAgentId = (typeof ANALYTICS_AGENT_IDS)[number];

export function isAnalyticsAgentId(id: string | null | undefined): id is AnalyticsAgentId {
    return !!id && (ANALYTICS_AGENT_IDS as readonly string[]).includes(id);
}

export function agentDashboardPath(agentId: string): string {
    return `/agents/${encodeURIComponent(agentId)}`;
}

export function agentChatPath(agentId: string): string {
    return `/chat?agent=${encodeURIComponent(agentId)}&new=1`;
}

export const AGENT_FILTER_OPTIONS = [
    { value: "", label: "All agents" },
    ...AGENT_OPTIONS.filter((o) => o.value),
];

/** Skills that actually have chat charts / actions today (honest capability list). */
export const AGENT_CHART_CAPABILITIES: Record<string, string[]> = {
    finance_agent: [
        "AP vendor / AR client charts",
        "Invoice line-item charts",
        "AP aging & monthly trend",
        "Portfolio + named-file targeting",
        "Data-quality + reprocess hints",
        "Finance report PDF generation",
        "Synced invoices / expenses (integrations)",
        "Open-task playbook (process until done)",
    ],
    hr_agent: [
        "CV score ranking chart",
        "Score distribution",
        "Certificate expiry chart",
        "Onboarding completeness",
        "Employee directory",
        "Leave / payroll / attendance charts",
        "Performance reviews + transcripts",
        "Offer + experience letters",
        "Joining / internship / training certificates",
        "Promotion / warning / relieving letters",
        "HR report + shortlist PDF",
        "Dynamic HR intent routing (plain-language asks)",
        "Synced candidates / tasks (integrations)",
        "Open-task playbook (process until done)",
    ],
    compliance_agent: [
        "Certificate expiry timeline + validity",
        "Findings by severity (audits / inspections)",
        "Overall compliance status mix",
        "Missing-document / packet completeness",
        "Expiry attention (plain language)",
        "Full compliance report PDF",
        "Section PDFs (certs / findings / register)",
        "NCR / CAPA / certificate-of-compliance letters",
        "Dynamic compliance intent routing",
        "Synced certificates / audits (integrations)",
        "Open-task playbook (process until done)",
    ],
    procurement_agent: [
        "Supplier spend bars",
        "PO vs invoice amounts",
        "Amounts by document",
        "Synced purchase orders / suppliers (integrations)",
        "Open-task playbook (process until done)",
    ],
    legal_agent: [
        "Risk flags by document",
        "Clause type mix",
        "Contract value by party",
        "Synced contracts / NDAs (integrations)",
        "Open-task playbook (process until done)",
    ],
    other_agent: [
        "Document type mix for scoped files",
        "Synced integration records",
        "Open-task playbook (process until done)",
    ],
};

/** Skills that actually have chat charts / actions today (honest capability list). */
export const AGENT_SKILLS: Record<string, string[]> = {
    finance_agent: AGENT_CHART_CAPABILITIES.finance_agent,
    hr_agent: AGENT_CHART_CAPABILITIES.hr_agent,
    legal_agent: AGENT_CHART_CAPABILITIES.legal_agent,
    procurement_agent: AGENT_CHART_CAPABILITIES.procurement_agent,
    compliance_agent: AGENT_CHART_CAPABILITIES.compliance_agent,
    other_agent: AGENT_CHART_CAPABILITIES.other_agent,
};

/** Document types covered by the given agents. */
export function docTypesForAgents(agentIds: string[]): string[] {
    const allowed = new Set(agentIds);
    return Object.entries(DOC_TYPE_TO_AGENT)
        .filter(([, agent]) => allowed.has(agent))
        .map(([docType]) => docType);
}

export function filterAgentOptions(agentIds: string[] | null | undefined) {
    if (!agentIds) return AGENT_OPTIONS.filter((o) => o.value);
    const set = new Set(agentIds);
    return AGENT_OPTIONS.filter((o) => o.value && set.has(o.value));
}

export function filterAgentFilterOptions(agentIds: string[] | null | undefined) {
    return [{ value: "", label: "All agents" }, ...filterAgentOptions(agentIds)];
}

export function filterDocTypeFilterOptions(agentIds: string[] | null | undefined) {
    const types = new Set(docTypesForAgents(agentIds || Object.keys(DOC_TYPE_TO_AGENT)));
    return [
        { value: "", label: "All types" },
        ...Object.entries(DOC_TYPE_LABELS)
            .filter(([k]) => k !== "unclassified" && types.has(k))
            .map(([value, label]) => ({ value, label })),
    ];
}

export function skillsForAgents(agentIds: string[]): { agentId: string; label: string; skills: string[] }[] {
    return filterAgentOptions(agentIds).map((a) => ({
        agentId: a.value,
        label: a.label,
        skills: AGENT_SKILLS[a.value] || [],
    }));
}

export const DOC_TYPE_LABELS: Record<string, string> = {
    invoice: "Invoice",
    financial_statement: "Financial statement",
    expense_report: "Expense report",
    payment_receipt: "Payment receipt",
    tax_document: "Tax document",
    bank_statement: "Bank statement",
    budget: "Budget",
    employee_record: "Employee record",
    hr_document: "HR document",
    offer_letter: "Offer letter",
    experience_letter: "Experience letter",
    employment_contract: "Employment contract",
    leave_application: "Leave application",
    payroll: "Payroll",
    attendance: "Attendance",
    performance_review: "Performance review",
    training_certificate: "Training certificate",
    resume: "Resume / CV",
    transcript: "Transcript",
    hr_report: "HR report",
    hr_shortlist: "HR shortlist",
    promotion_letter: "Promotion letter",
    warning_letter: "Warning letter",
    relieving_letter: "Relieving letter",
    joining_letter: "Joining letter",
    internship_letter: "Internship letter",
    contract: "Contract",
    agreement: "Agreement",
    nda: "NDA",
    service_agreement: "Service agreement",
    lease_agreement: "Lease agreement",
    vendor_contract: "Vendor contract",
    purchase_order: "Purchase order",
    quotation: "Quotation",
    supplier_agreement: "Supplier agreement",
    vendor_list: "Vendor list",
    rfq: "RFQ",
    delivery_note: "Delivery note",
    procurement_request: "Procurement request",
    sop: "SOP",
    audit_report: "Audit report",
    quality_report: "Quality report",
    certificate: "Certificate",
    maintenance_report: "Maintenance report",
    engineering_drawing: "Engineering drawing",
    inspection_report: "Inspection report",
    safety_manual: "Safety manual",
    iso_document: "ISO document",
    compliance_form: "Compliance form",
    regulatory_document: "Regulatory document",
    compliance_report: "Compliance report",
    finance_report: "Finance report",
    ncr_letter: "NCR letter",
    capa_letter: "CAPA letter",
    certificate_of_compliance: "Certificate of compliance",
    unclassified: "Unclassified",
    other: "Other",
    integration_record: "Integration record",
};

/** Options for search / filter dropdowns */
export const DOC_TYPE_FILTER_OPTIONS = [
    { value: "", label: "All types" },
    ...Object.entries(DOC_TYPE_LABELS)
        .filter(([k]) => k !== "unclassified")
        .map(([value, label]) => ({ value, label })),
];

export function docTypeLabel(type: string): string {
    return DOC_TYPE_LABELS[type] || type.replace(/_/g, " ");
}

export function agentLabel(agent: string): string {
    const found = AGENT_OPTIONS.find((o) => o.value === agent);
    return found?.label || agent.replace(/_/g, " ");
}

export function resolveDocAgent(doc: {
    originalFilename?: string | null;
    phase3_agent?: string | null;
    document_type?: string | null;
    classification?: string | null;
    metadata?: { phase3Agent?: string; naturalAgent?: string } | null;
}): string {
    // 1. Explicit assigned or clamped agent on metadata
    if (doc.metadata?.phase3Agent) return doc.metadata.phase3Agent;
    if (doc.phase3_agent) return doc.phase3_agent;

    // 2. Concrete document classification from AI processing
    const docType = String(doc.document_type || doc.classification || "")
        .trim()
        .toLowerCase()
        .replace(/[\s-]+/g, "_");
    const cls = docType === "cv" || docType === "curriculum_vitae" ? "resume" : docType;
    if (cls && cls !== "other" && cls !== "unclassified" && DOC_TYPE_TO_AGENT[cls]) {
        return DOC_TYPE_TO_AGENT[cls];
    }

    // 3. Filename inference for pre-classification / unclassified uploads
    const fromName = inferDocTypeFromFilename(doc.originalFilename || "");
    if (fromName && DOC_TYPE_TO_AGENT[fromName] && DOC_TYPE_TO_AGENT[fromName] !== "other_agent") {
        return DOC_TYPE_TO_AGENT[fromName];
    }

    if (doc.metadata?.naturalAgent) return doc.metadata.naturalAgent;
    if (/\.(xlsx?|csv|tsv|ods)$/i.test(doc.originalFilename || "")) return "finance_agent";
    return "other_agent";
}

export function inferDocTypeFromFilename(filename: string): string | null {
    const name = filename.toLowerCase().replace(/\.[^.]+$/, "");

    // Technical / academic materials -> other
    if (
        name.includes("database") ||
        name.includes("adbms") ||
        name.includes("lab") ||
        name.includes("assignment") ||
        name.includes("outline") ||
        name.includes("syllabus") ||
        name.includes("fluency")
    ) {
        return "other";
    }

    // Specific HR / finance cues before broad "contract" / "certificate" matches
    if (/(^|[^a-z0-9])(cv|resume|curriculum)([^a-z0-9]|$)/.test(name) || /[_-]cv$/.test(name)) {
        return "resume";
    }
    if (name.includes("payroll")) return "payroll";
    if (name.includes("offer") && (name.includes("letter") || name.includes("job"))) return "offer_letter";
    if (name.includes("experience") && (name.includes("letter") || name.includes("certificate"))) return "experience_letter";
    if (name.includes("employment") && name.includes("contract")) return "employment_contract";
    if (name.includes("leave")) return "leave_application";
    if (name.includes("joining") && name.includes("letter")) return "joining_letter";
    if (name.includes("internship") && name.includes("letter")) return "internship_letter";
    if (name.includes("training") && name.includes("certificate")) return "training_certificate";
    if (name.includes("transcript")) return "transcript";
    if (name.includes("finance") && (name.includes("position") || name.includes("report"))) return "financial_statement";
    if (name.includes("financial") && name.includes("statement")) return "financial_statement";
    if (name.includes("invoice")) return "invoice";
    if (name.includes("bank") && name.includes("statement")) return "bank_statement";
    if (name.includes("expense")) return "expense_report";
    if (name.includes("receipt")) return "payment_receipt";
    if (name.includes("tax")) return "tax_document";
    if (name.includes("budget")) return "budget";
    if (name.includes("audit") && name.includes("report")) return "audit_report";
    if (name.includes("compliance") && name.includes("report")) return "audit_report";
    if (name.includes("quality") && name.includes("report")) return "quality_report";
    if (name.includes("inspection") || (name.includes("safety") && name.includes("validation"))) return "inspection_report";
    if (name.includes("maintenance") || name.includes("repair")) return "maintenance_report";
    if (name.includes("drawing") || name.includes("schematic") || name.includes("blueprint")) return "engineering_drawing";
    if (name.includes("nda") || name.includes("non-disclosure") || name.includes("non_disclosure")) {
        return "nda";
    }
    if (name.includes("service") && name.includes("agreement")) return "service_agreement";
    if (name.includes("lease") && name.includes("agreement")) return "lease_agreement";
    if (name.includes("vendor") && name.includes("contract")) return "vendor_contract";
    if (name.includes("contract") || name.includes("agreement")) return "contract";
    if (name.includes("quotation") || /(^|[^a-z0-9])quote([^a-z0-9]|$)/.test(name)) return "quotation";
    if (name.includes("purchase") || /(^|[^a-z0-9])po([^a-z0-9]|$)/.test(name)) return "purchase_order";
    if (name.includes("delivery") && name.includes("note")) return "delivery_note";
    if (name.includes("rfq")) return "rfq";
    if (name.includes("certificate")) return "certificate";
    if (/(^|[^a-z0-9])sop([^a-z0-9]|$)/.test(name)) return "sop";
    if (name.includes("bank")) return "bank_statement";
    return null;
}
