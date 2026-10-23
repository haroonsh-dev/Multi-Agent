/**
 * Shared question → agent domain so every specialty router stays on-topic.
 * Detected domain wins over the current workspace (e.g. an indemnity clause
 * in Finance workspace still goes to Legal, not vendor totals).
 */
export type ChatAgentId =
    | 'hr_agent'
    | 'legal_agent'
    | 'finance_agent'
    | 'compliance_agent'
    | 'procurement_agent'
    | 'other_agent';

const LEGAL_RE =
    /\b(indemnif(?:y|ies|ied|ication)|indemnit(?:y|ies)|unlimited\s+(financial\s+)?liability|limitation of liability|uncapped\s+liability|no\s+(liability\s+)?cap|without\s+(any\s+)?(monetary|financial)\s+limitation|no\s+monetary\s+limitation|all\s+losses|\bnda\b|non-disclosure|clause|contract|agreement)\b/i;

const LEGAL_STRONG_RE =
    /\b(indemnif(?:y|ies|ied|ication)|indemnit(?:y|ies)|unlimited\s+(financial\s+)?liability|limitation of liability|uncapped\s+liability|without\s+(any\s+)?(monetary|financial)\s+limitation|all\s+losses)\b/i;

const HR_RE =
    /\b(cv|resume|candidate|candidates|hiring|shortlist|offer letter|joining letter|experience letter|payroll|leave|attendance|onboarding)\b/i;

const COMPLIANCE_RE =
    /\b(compliance|certificate|iso|audit|ncr|capa|sop|inspection|finding|non[-\s]?conform)\b/i;

const PROCUREMENT_RE =
    /\b(purchase order|\bpos?\b|rfq|quotation|quote comparison|3[-\s]?way match|procurement)\b/i;

const FINANCE_RE =
    /\b(invoice|invoices|payable|receivable|\bap\b|\bar\b|vendor spend|aging|overdue|bank statement|line[-\s]?items?)\b/i;

function looksLikePersonExplain(question: string): boolean {
    const q = question.toLowerCase();
    if (LEGAL_STRONG_RE.test(q) || FINANCE_RE.test(q) || COMPLIANCE_RE.test(q)) return false;
    return (
        /\b(explain|tell me about|who is|describe|what about)\b/.test(q) &&
        /[A-Za-z]{2,}\s+[A-Za-z]{2,}/.test(question)
    );
}

/** Strongest matching specialty domain, or null if the question is generic. */
export function detectQuestionDomain(question: string): ChatAgentId | null {
    const q = (question || '').toLowerCase();
    if (!q.trim()) return null;

    if (LEGAL_STRONG_RE.test(q)) return 'legal_agent';
    if (HR_RE.test(q) || looksLikePersonExplain(question)) return 'hr_agent';
    if (COMPLIANCE_RE.test(q)) return 'compliance_agent';
    if (PROCUREMENT_RE.test(q) && !FINANCE_RE.test(q)) return 'procurement_agent';
    if (FINANCE_RE.test(q)) return 'finance_agent';
    if (LEGAL_RE.test(q) && /\b(show|find|list|where|which|explain|summar|liability|party|expiry)\b/.test(q)) {
        return 'legal_agent';
    }
    return null;
}

export function isLegalSemanticQuestion(question: string): boolean {
    return detectQuestionDomain(question) === 'legal_agent' || LEGAL_STRONG_RE.test(question);
}

export function isHrSemanticQuestion(question: string): boolean {
    return detectQuestionDomain(question) === 'hr_agent';
}

export function isFinanceSemanticQuestion(question: string): boolean {
    return detectQuestionDomain(question) === 'finance_agent';
}

export function isComplianceSemanticQuestion(question: string): boolean {
    return detectQuestionDomain(question) === 'compliance_agent';
}

export function isProcurementSemanticQuestion(question: string): boolean {
    return detectQuestionDomain(question) === 'procurement_agent';
}

/**
 * Whether this specialty agent should handle the turn.
 * Clear domain → only that agent. Otherwise → only the selected workspace agent.
 */
export function shouldRunAgent(
    agentId: ChatAgentId,
    question: string,
    phase3Agent?: string
): boolean {
    const detected = detectQuestionDomain(question);
    if (detected) return detected === agentId;
    if (phase3Agent) return phase3Agent === agentId;
    return false;
}
