/** Detect meta/help asks — must run before doc-hint chitchat exclusions ("document" in the question). */

const CAPABILITY_PATTERNS: RegExp[] = [
    /\bwhat can you do\b/i,
    /\bwhat you can do\b/i,
    /\bwhat (?:are you|can you) able to\b/i,
    /\bwhat tasks can you\b/i,
    /\bwhat you can accomplish\b/i,
    /\byour capabilities\b/i,
    /\bhow (?:can|do) i proceed\b/i,
    /\bhow to proceed\b/i,
    /\bwhat do you support\b/i,
    /\blist (?:your )?(?:capabilities|features|tasks)\b/i,
    /\bwhat(?:'s| is) possible\b/i,
    /\bhelp me understand what you\b/i,
    /\bstructured breakdown\b/i,
];

const INTEGRATION_HINT =
    ' **Integrations:** ask for **synced records**, **process open tasks until done** (then **yes**), or **assign / create task**.';

const FINANCE_CAPABILITY_REPLY =
    'I analyze finance files in scope as **AP (vendors)** and **AR (clients)** — spend, aging, trends, and line items. ' +
    'Try: **grand total**, **chart vendor spend**, **overdue invoices**, or **generate a finance report**. ' +
    'Name a file to focus on one invoice.' +
    ' Synced data: **show synced invoices**, **list expenses**, or **process open tasks until done**.';

const AGENT_CAPABILITY_REPLIES: Record<string, string> = {
    finance_agent: FINANCE_CAPABILITY_REPLY,
    hr_agent:
        'I handle HR work from your scoped documents — CVs, leave, certificates, payroll, attendance, and letters. ' +
        'Ask in plain language, e.g. **top candidates**, **generate offer letter**, or **summarize this resume**. ' +
        'Synced hiring board: **show synced candidates**, **show synced tasks**, **assign task to …**, or **process open tasks until done**.',
    legal_agent:
        'I answer from scoped contracts — parties, dates, risk flags, clause types, and values when extracted. ' +
        'Try: **expiring contracts**, **chart risk flags**, or **summarize this agreement**. ' +
        'Synced legal records: **list contracts**, **show NDAs**, or **process open tasks until done**.' +
        INTEGRATION_HINT,
    compliance_agent:
        'I work on compliance docs — expiry, findings, status, missing items, and reports. ' +
        'Try: **overdue certificates**, **compliance report**, or **list open findings**. ' +
        'Synced records: **how many certificates synced**, **show audits**, or **process open tasks until done**.',
    procurement_agent:
        'I analyze POs, quotations, and RFQs in scope — supplier amounts and PO vs invoice when fields exist. ' +
        'Try: **chart supplier spend**, **compare PO to invoice**, or **3-way match**. ' +
        'Synced procurement: **show purchase orders**, **list suppliers**, or **process open tasks until done**.',
    other_agent:
        'I work across mixed documents — summaries, comparisons, and type mix. ' +
        'Try: **summarize these documents** or **show document type mix**. ' +
        'Synced integrations: **show synced records**, **show synced tasks**, or **process open tasks until done**.',
};

export function isCapabilityQuestion(message: string): boolean {
    const q = (message || '').trim();
    if (!q || q.length > 260) return false;
    return CAPABILITY_PATTERNS.some((p) => p.test(q));
}

export function getCapabilityReply(agentId?: string): string {
    const agent = (agentId || '').trim();
    return (
        AGENT_CAPABILITY_REPLIES[agent] ||
        'I answer questions from your uploaded documents — summaries, fields, totals, and comparisons. ' +
            'Ask something specific about a file or topic in your library.' +
            INTEGRATION_HINT
    );
}

export { FINANCE_CAPABILITY_REPLY };
