import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

export interface PromptMessage {
    role: 'user' | 'assistant';
    content: {
        type: 'text';
        text: string;
    };
}

export interface PromptResult {
    description: string;
    messages: PromptMessage[];
    [key: string]: unknown;
}

export const CANONICAL_PROMPT_NAMES = [
    'financial_audit_review',
    'compliance_expiry_audit',
    'hr_talent_shortlist',
] as const;

/**
 * Builds structured prompt instructions targeting finance_agent for deep invoice, tax, and PO matching.
 */
export function getFinancialAuditReviewPrompt(args: {
    invoice_id?: string;
    invoice_number?: string;
    audit_depth?: string;
}): PromptResult {
    const invoiceId = args.invoice_id || args.invoice_number || 'N/A';
    const auditDepth = args.audit_depth || 'standard';

    return {
        description:
            'Deep financial audit instructions for invoice, tax, and purchase order matching targeting finance_agent',
        messages: [
            {
                role: 'user',
                content: {
                    type: 'text',
                    text: `You are the finance_agent domain expert. Perform a comprehensive financial audit on invoice document "${invoiceId}" with audit depth "${auditDepth}".

Instructions:
1. Extract and verify invoice metadata including Invoice Number, Vendor Name, Total Amount, Currency, Tax/VAT breakdowns, and Invoice Date.
2. Cross-reference vendor details and check for duplicate invoice submissions across the organization.
3. Perform Purchase Order (PO) matching: verify line items, quantities, unit prices, and overall PO authorization limits.
4. Flag any anomalies: price variances, missing PO references, tax calculation discrepancies, or duplicate submissions.
5. If the total amount exceeds $1,000, mark as requiring manager authorization; otherwise evaluate auto-approval eligibility.
6. Provide a structured audit summary with findings, risk score (0-100), and recommended workflow action (approve, reject, or flag).`,
                },
            },
        ],
    };
}

/**
 * Builds structured prompt instructions targeting compliance_agent for expiring ISO certificates and regulatory filings.
 */
export function getComplianceExpiryAuditPrompt(args?: {
    days_threshold?: number;
    department?: string;
}): PromptResult {
    const threshold = args?.days_threshold ?? 30;
    const deptClause = args?.department ? ` within department "${args.department}"` : '';

    return {
        description:
            'Regulatory compliance certificate expiration and filing audit prompt targeting compliance_agent',
        messages: [
            {
                role: 'user',
                content: {
                    type: 'text',
                    text: `You are the compliance_agent domain expert. Conduct an expiry and regulatory compliance audit for certificates and filings expiring within ${threshold} days${deptClause}.

Instructions:
1. Inspect all organization compliance documents (ISO 9001, ISO 27001, OSHA certificates, regulatory permits, and vendor licenses).
2. Calculate days remaining until expiration for each certificate against the ${threshold}-day warning window.
3. Categorize items into:
   - CRITICAL (expired or expiring in <= 15 days)
   - WARNING (expiring in 16-${threshold} days)
   - COMPLIANT (valid beyond ${threshold} days)
4. Verify certification authority, scope of certification, and any outstanding Non-Conformance Reports (NCR) or Corrective and Preventive Actions (CAPA).
5. Generate an actionable remediation checklist including vendor outreach, renewal application requirements, and re-audit timelines.
6. Produce a structured compliance risk verdict and flag documents requiring immediate supervisory intervention.`,
                },
            },
        ],
    };
}

/**
 * Builds structured prompt instructions targeting hr_agent for candidate resumes and CV scoring.
 */
export function getHrTalentShortlistPrompt(args: {
    role_title: string;
    min_cv_score?: number;
}): PromptResult {
    const roleTitle = args.role_title;
    const minScore = args.min_cv_score ?? 75;

    return {
        description:
            'HR candidate resume evaluation and talent shortlisting prompt targeting hr_agent',
        messages: [
            {
                role: 'user',
                content: {
                    type: 'text',
                    text: `You are the hr_agent domain expert. Evaluate candidate resumes and generate a qualified talent shortlist for the role: "${roleTitle}".

Instructions:
1. Analyze candidate resumes and CVs submitted for the role "${roleTitle}".
2. Evaluate candidates against core qualifications: required technical skills, years of relevant experience, domain expertise, and education credentials.
3. Compute or verify the candidate CV match score (0-100) against the role benchmark.
4. Shortlist candidates whose score meets or exceeds the minimum threshold of ${minScore}/100.
5. For each candidate, provide:
   - Candidate Name and Contact Details
   - Overall CV Match Score
   - Key Strengths and Alignment Highlights
   - Potential Skill Gaps or Areas for Interview Follow-Up
   - Recommendation: "Shortlist for Interview" (score >= ${minScore}) or "Reject / Hold" (score < ${minScore})
6. Compile the final ranked candidate shortlist ready for hiring manager review.`,
                },
            },
        ],
    };
}

/**
 * Registers all MCP pre-configured prompt templates on the provided McpServer instance:
 * 1. financial_audit_review - Invoice, tax, and PO matching targeting finance_agent
 * 2. compliance_expiry_audit - Certificate expiration and CAPA action audit targeting compliance_agent
 * 3. hr_talent_shortlist - Resume qualification assessment and CV scoring targeting hr_agent
 */
export function registerMcpPrompts(server: McpServer): void {
    // 1. Financial Audit Review Prompt
    server.prompt(
        'financial_audit_review',
        {
            invoice_id: z
                .string()
                .describe('Invoice document ID to audit (e.g. doc_alpha_inv_001, INV-2026-001)'),
            audit_depth: z
                .string()
                .optional()
                .describe('Depth of audit analysis: standard, deep, or forensic (default: standard)'),
        },
        async (args) => {
            return getFinancialAuditReviewPrompt(args);
        }
    );

    // 2. Compliance Expiry Audit Prompt
    server.prompt(
        'compliance_expiry_audit',
        {
            days_threshold: z.coerce
                .number()
                .optional()
                .describe('Number of days threshold for certificate expiration warning (default: 30)'),
            department: z
                .string()
                .optional()
                .describe('Target department for compliance audit (e.g., Operations, Logistics)'),
        },
        async (args) => {
            return getComplianceExpiryAuditPrompt(args);
        }
    );

    // 3. HR Talent Shortlist Prompt
    server.prompt(
        'hr_talent_shortlist',
        {
            role_title: z
                .string()
                .describe('Target job role title for talent shortlisting (e.g., Senior Backend Engineer)'),
            min_cv_score: z.coerce
                .number()
                .optional()
                .describe('Minimum candidate CV match score threshold (0-100, default: 75)'),
        },
        async (args) => {
            return getHrTalentShortlistPrompt(args);
        }
    );
}
