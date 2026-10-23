import { inferDocTypeFromFilename } from "@/lib/documentAgents";

/** Doc types that should appear in finance charts when tied to chat scope. */
const FINANCE_ANALYTICS_TYPES = new Set([
    "invoice",
    "financial_statement",
    "expense_report",
    "payment_receipt",
    "tax_document",
    "bank_statement",
    "budget",
    "purchase_order",
    "po",
    "receipt",
]);

const EXCLUDED_TYPES = new Set([
    "offer_letter",
    "resume",
    "transcript",
    "employment_contract",
    "leave_application",
    "finance_report",
    "compliance_report",
]);

type ScopeDoc = {
    documentId: string;
    originalFilename?: string;
    classification?: string | null;
    mimeType?: string | null;
};

export function isFinanceAnalyticsDoc(doc: ScopeDoc): boolean {
    const c = String(doc.classification || "").toLowerCase();
    const inferred = inferDocTypeFromFilename(doc.originalFilename || "");
    if (inferred && EXCLUDED_TYPES.has(inferred)) return false;
    if (EXCLUDED_TYPES.has(c)) return false;
    if (inferred && FINANCE_ANALYTICS_TYPES.has(inferred)) return true;
    if (FINANCE_ANALYTICS_TYPES.has(c)) return true;
    const name = (doc.originalFilename || "").toLowerCase();
    if (/\.(xlsx?|csv|tsv)$/i.test(doc.originalFilename || "")) {
        if (EXCLUDED_TYPES.has(c)) return false;
        return c !== "quotation";
    }
    if (/invoice|inv[_\-.]|bill|receipt|expense|statement/i.test(name)) return true;
    return false;
}

export function filterFinanceAnalyticsDocIds(docs: ScopeDoc[], ids: string[]): string[] {
    const set = new Set(ids);
    return docs.filter((d) => set.has(d.documentId) && isFinanceAnalyticsDoc(d)).map((d) => d.documentId);
}

type ReadyFinanceDoc = ScopeDoc & { status?: string; pythonDocumentId?: string | null };

/** All finance-ready docs in the library (for portfolio finance asks). */
export function listFinanceReadyDocIds(docs: ReadyFinanceDoc[]): string[] {
    return docs
        .filter(
            (d) =>
                d.status === "ready" &&
                Boolean(d.pythonDocumentId) &&
                isFinanceAnalyticsDoc(d)
        )
        .map((d) => d.documentId);
}

/** Match api-gateway financeIntent — full scope, not one prior file. */
export function normalizeFinanceUserQuestion(question: string): string {
    return question
        .toLowerCase()
        .replace(/\bclietns?\b/g, "clients")
        .replace(/\bcleints?\b/g, "clients");
}

export function wantsFinanceListAllScope(question: string): boolean {
    const q = normalizeFinanceUserQuestion(question);
    if (/\b(all|every|full|entire)\b/.test(q) && /\b(lists?|listings?)\b/.test(q)) {
        return true;
    }
    if (/\b(all|every|full)\s+(clients?|customers?|vendors?|suppliers?)\b/.test(q)) {
        return true;
    }
    if (/\b(clients?|customers?|vendors?)\s+(lists?|listings?)\b/.test(q)) {
        return true;
    }
    return false;
}

export function wantsFinanceMultiDocCharts(question: string): boolean {
    const q = normalizeFinanceUserQuestion(question);
    if (/\b(aging|overdue|outstanding)\b/.test(q)) return true;
    if (/\b(trend|monthly|by month|per month|over time|timeline|history)\b/.test(q)) {
        return /\b(chart|graph|visual|invoice|spend|volume|trend)\b/.test(q) || /\bby month\b/.test(q);
    }
    return false;
}

export function wantsPortfolioFinanceScope(question: string): boolean {
    const q = normalizeFinanceUserQuestion(question);
    if (wantsFinanceListAllScope(question)) {
        return true;
    }
    if (wantsFinanceMultiDocCharts(question)) {
        return true;
    }
    if (/\b(portfolio|across\s+(all|my|scoped)|all\s+(files|documents|invoices))\b/.test(q)) {
        return true;
    }
    if (/\b(all|every|each|entire|whole|full)\b/.test(q)) {
        if (/\b(vendor|client|customer|supplier|spend|amount|invoice|file|document|data|lists?)\b/.test(q)) {
            return true;
        }
    }
    if (
        /\b(all vendors?|all clients?|all customers?|every vendor|every client)\b/.test(q) ||
        (/\b(vendor|supplier)\b/.test(q) &&
            /\b(client|customer)s?\b/.test(q) &&
            /\b(spend|amount|total|data)\b/.test(q))
    ) {
        return true;
    }
    if (/\b(clients?|customers?)\b/.test(q) && /\b(vendors?|suppliers?)\b/.test(q) && /\b(list|show|give|data|spend|breakdown|report)\b/.test(q)) {
        return true;
    }
    if (
        /\b(give|show|get|send|pull)\s+(me\s+)?(the\s+)?(that\s+)?(full\s+)?(finance\s+)?(data|numbers|figures|report|breakdown|summary)\b/.test(
            q
        )
    ) {
        return true;
    }
    if (
        /\b(that|the)\s+(data|numbers|figures|report|summary|breakdown)\b/.test(q) &&
        !/\b(invoice|document|file|pdf)\b/.test(q)
    ) {
        return true;
    }
    return false;
}
