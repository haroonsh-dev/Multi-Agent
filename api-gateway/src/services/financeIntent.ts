import type { FinanceAnalyticsCoverage } from '../types/chatVisuals';
import { questionRefersToSpecificDocument } from './financeAnalyticsService';
import { normalizeFinanceUserQuestion, wantsFinanceListAllScope, wantsFinanceMultiDocCharts } from './financeQuestionNormalize';

export type FinanceRouterIntent =
    | 'vendor_spend'
    | 'client_spend'
    | 'monthly_trend'
    | 'aging'
    | 'doc_mix'
    | 'line_items'
    | 'overview';

const MONTHLY_TREND_RE =
    /\b(trend|monthly|by month|per month|over time|timeline|history)\b/i;

export function wantsMonthlyTrendQuestion(question: string): boolean {
    return MONTHLY_TREND_RE.test(question);
}

/** User wants charts across every file in scope — not one named invoice or session focus. */
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
        (/\b(vendor|supplier)\b/.test(q) && /\b(client|customer)s?\b/.test(q) && /\b(spend|amount|total|data)\b/.test(q))
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

/** Single priority table for dynamic router + tests (no DB). */
export function parseFinanceIntent(
    question: string,
    opts?: { singleDoc?: boolean }
): FinanceRouterIntent {
    const q = question.toLowerCase();
    if (/\b(line[\s-]?items?|items?\s+list|list\s+(of\s+)?items?)\b/.test(q)) return 'line_items';
    if (/\b(aging|overdue)\b/.test(q)) return 'aging';
    if (wantsMonthlyTrendQuestion(question)) return 'monthly_trend';
    if (/\b(all|both|overview|everything)\b/.test(q) || (/\b(vendor|supplier)\b/.test(q) && /\b(client|customer)s?\b/.test(q))) {
        return 'overview';
    }
    if (wantsPortfolioFinanceScope(question)) return 'overview';
    if (/\b(vendor|supplier)\b/.test(q) && !/\bpurchase|po|quotation|rfq\b/.test(q)) {
        return 'vendor_spend';
    }
    if (/\b(clients?|customers?)\b/.test(q)) return 'client_spend';
    if (/\b(mix|types)\b/.test(q)) return 'doc_mix';
    if (
        opts?.singleDoc &&
        (questionRefersToSpecificDocument(question) || /\b(chart|graph|visual|plot)\b/.test(q))
    ) {
        return 'line_items';
    }
    return 'overview';
}

export function mapFinanceIntentToPanelView(intent: string): string {
    switch (intent) {
        case 'vendor_spend':
            return 'vendors';
        case 'client_spend':
            return 'clients';
        case 'monthly_trend':
            return 'trend';
        case 'aging':
            return 'aging';
        case 'doc_mix':
            return 'mix';
        case 'line_items':
            return 'overview';
        default:
            return 'overview';
    }
}

export function formatFinanceCoverageNotes(coverage?: FinanceAnalyticsCoverage): string {
    // Keep internal file coverage metadata in JSON object payload, but do not append raw debug file lists to user chat text.
    return '';
}
