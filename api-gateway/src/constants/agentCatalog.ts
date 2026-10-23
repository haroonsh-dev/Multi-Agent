/** Keep in sync with frontend documentAgents.ts ANALYTICS_AGENT_IDS + DOC_TYPE_TO_AGENT */
export const ANALYTICS_AGENT_IDS = [
    'finance_agent',
    'hr_agent',
    'compliance_agent',
    'procurement_agent',
    'legal_agent',
    'other_agent',
] as const;

export type AnalyticsAgentId = (typeof ANALYTICS_AGENT_IDS)[number];

export const DOC_TYPE_TO_AGENT: Record<string, AnalyticsAgentId | 'other_agent'> = {
    invoice: 'finance_agent',
    financial_statement: 'finance_agent',
    expense_report: 'finance_agent',
    payment_receipt: 'finance_agent',
    tax_document: 'finance_agent',
    bank_statement: 'finance_agent',
    budget: 'finance_agent',
    finance_report: 'finance_agent',
    employee_record: 'hr_agent',
    hr_document: 'hr_agent',
    offer_letter: 'hr_agent',
    experience_letter: 'hr_agent',
    employment_contract: 'hr_agent',
    leave_application: 'hr_agent',
    payroll: 'hr_agent',
    attendance: 'hr_agent',
    performance_review: 'hr_agent',
    training_certificate: 'hr_agent',
    resume: 'hr_agent',
    transcript: 'hr_agent',
    hr_report: 'hr_agent',
    hr_shortlist: 'hr_agent',
    contract: 'legal_agent',
    agreement: 'legal_agent',
    nda: 'legal_agent',
    service_agreement: 'legal_agent',
    lease_agreement: 'legal_agent',
    vendor_contract: 'legal_agent',
    purchase_order: 'procurement_agent',
    po: 'procurement_agent',
    quotation: 'procurement_agent',
    supplier_agreement: 'procurement_agent',
    vendor_list: 'procurement_agent',
    rfq: 'procurement_agent',
    delivery_note: 'procurement_agent',
    procurement_request: 'procurement_agent',
    sop: 'compliance_agent',
    audit_report: 'compliance_agent',
    quality_report: 'compliance_agent',
    certificate: 'compliance_agent',
    maintenance_report: 'compliance_agent',
    inspection_report: 'compliance_agent',
    safety_manual: 'compliance_agent',
    iso_document: 'compliance_agent',
    compliance_form: 'compliance_agent',
    regulatory_document: 'compliance_agent',
    compliance_report: 'compliance_agent',
    ncr_letter: 'compliance_agent',
    capa_letter: 'compliance_agent',
    certificate_of_compliance: 'compliance_agent',
    other: 'other_agent',
};

export function agentForDocType(classification: string | null | undefined): AnalyticsAgentId | 'other_agent' {
    const key = String(classification || 'other').toLowerCase();
    return (DOC_TYPE_TO_AGENT[key] as AnalyticsAgentId | 'other_agent') || 'other_agent';
}

export function docTypesForAgent(agentId: string): string[] {
    return Object.entries(DOC_TYPE_TO_AGENT)
        .filter(([, agent]) => agent === agentId)
        .map(([docType]) => docType);
}
