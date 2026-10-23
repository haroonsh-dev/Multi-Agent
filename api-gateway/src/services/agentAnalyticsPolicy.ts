/**
 * Shared Gemini-style chat policy for all agents:
 * - Text explain/overview/compare → answer in chat, no forced Analytics panel
 * - Analytics/chart asks → narrative first, then visuals + Analytics panel
 */
import type { ChatVisualSpec } from '../types/chatVisuals';
import { insightFromVisuals } from './agentResponseFormat';

export type AgentVisualResult = {
    answer?: string;
    visuals?: ChatVisualSpec[];
};

const CHART_WORDS =
    /\b(chart|graph|graphs|visual|visuals|visuali[sz]e|plot|plots|analytics|dashboard|breakdown)\b/i;

export function wantsAgentTextOnlyExplain(question: string, agentId?: string): boolean {
    const q = question.toLowerCase().trim();
    if (CHART_WORDS.test(q)) return false;
    if (/\b(ranking chart|score chart|analytics panel)\b/.test(q)) return false;

    const genericExplain =
        /\b(explain|overview|summary|summarize|describe|profile|tell me about|what is|what are|break down)\b/.test(
            q
        );
    const compareText =
        /\b(comparison|compare|comparision|versus|\bvs\.?\b)\b/.test(q) && !/\btable\b/.test(q);
    const singleFocus =
        /\b(not others|full overview|don't show others|do not show others|single document overview)\b/.test(q);

    if (agentId === 'hr_agent' || /\b(cv|resume|candidate)\b/.test(q)) {
        if (
            (genericExplain || compareText || singleFocus) &&
            /\b(cv|resume|candidate|hiring)\b/.test(q)
        ) {
            return true;
        }
        if (
            /\b(best|top|find|pick)\b/.test(q) &&
            /\b(cv|resume|candidate)\b/.test(q) &&
            (genericExplain || singleFocus || /\b(for|role|data science|engineer)\b/.test(q))
        ) {
            return true;
        }
    }

    if (agentId === 'legal_agent' || /\b(contract|agreement|nda|legal|clause)\b/.test(q)) {
        if (genericExplain || compareText) return true;
    }

    if (agentId === 'finance_agent' || /\b(invoice|vendor|payable|receivable|expense|finance)\b/.test(q)) {
        if (
            (genericExplain || compareText) &&
            !/\b(aging chart|vendor chart|spend chart|trend chart)\b/.test(q)
        ) {
            return true;
        }
    }

    if (
        agentId === 'compliance_agent' ||
        /\b(compliance|certificate|audit|sop|iso|inspection|finding)\b/.test(q)
    ) {
        if (
            (genericExplain || compareText || /\b(status report|explain compliance)\b/.test(q)) &&
            !/\b(expiry chart|findings chart|severity chart)\b/.test(q)
        ) {
            return true;
        }
    }

    if (agentId === 'procurement_agent' || /\b(purchase order|\bpo\b|rfq|quotation|procurement|supplier)\b/.test(q)) {
        if (genericExplain || compareText) return true;
    }

    if (agentId === 'other_agent') {
        if (genericExplain || compareText || singleFocus) return true;
    }

    return false;
}

export function wantsAgentAnalyticsVisual(question: string, agentId?: string): boolean {
    if (wantsAgentTextOnlyExplain(question, agentId)) return false;
    const q = question.toLowerCase().trim();

    if (CHART_WORDS.test(q)) return true;
    if (/\b(show me|give me|show a)\b.*\b(chart|graph|visual|analytics|ranking|scores|breakdown)\b/.test(q)) {
        return true;
    }

    if (agentId === 'hr_agent' || /\b(cv|resume|candidate)\b/.test(q)) {
        if (/\b(rank|ranking|top \d+|score|scores|distribution|histogram)\b/.test(q)) return true;
    }

    if (agentId === 'finance_agent' || /\b(invoice|vendor|finance|payable|receivable)\b/.test(q)) {
        if (
            /\b(vendor spend|spend by|aging|overdue|monthly trend|line[\s-]?items?|client spend|ar chart|ap chart)\b/.test(
                q
            )
        ) {
            return true;
        }
        if (/\b(vendor|spend|aging|invoice|payable|receivable|trend)\b/.test(q) && CHART_WORDS.test(q)) {
            return true;
        }
    }

    if (agentId === 'compliance_agent' || /\b(compliance|certificate|audit|finding)\b/.test(q)) {
        if (/\b(expiry|findings|severity|cert status|status mix|certificate timeline)\b/.test(q)) {
            if (/\b(chart|graph|visual|timeline|mix|dashboard|analytics)\b/.test(q)) return true;
            if (/\b(show|list|top)\b/.test(q) && /\b(expir|finding|cert)\b/.test(q)) return true;
        }
    }

    if (agentId === 'legal_agent' || /\b(contract|agreement|legal|clause|risk)\b/.test(q)) {
        if (/\b(missing data|data gaps?|all missing|what(?:'s| is) missing)\b/.test(q)) return true;
        if (/\b(risk chart|clause mix|clause chart|contract value chart)\b/.test(q)) return true;
        if (/\b(risk|clause|party value)\b/.test(q) && CHART_WORDS.test(q)) return true;
    }

    if (agentId === 'procurement_agent' || /\b(purchase order|\bpo\b|supplier|procurement|rfq)\b/.test(q)) {
        if (/\b(supplier spend|po vs invoice|spend by supplier|quote comparison chart)\b/.test(q)) {
            return true;
        }
        if (/\b(supplier|spend|\bpo\b|quotation)\b/.test(q) && CHART_WORDS.test(q)) return true;
    }

    if (agentId === 'other_agent') {
        if (/\b(doc mix|document mix|type mix)\b/.test(q) && CHART_WORDS.test(q)) return true;
    }

    return false;
}

function stripAnalyticsPanelCTAs(text: string): string {
    return text
        .replace(/\n*(See the charts? in the \*\*Analytics\*\* panel\.?\s*)+/gi, '')
        .replace(/\n*(Charts are in the analytics panel\.?\s*)+/gi, '')
        .replace(/\n*(Open Analytics for the graph\.?\s*)+/gi, '')
        .trim();
}

function mentionsAnalyticsPanel(text: string): boolean {
    return /analytics\s*panel/i.test(text.replace(/\*\*/g, ''));
}

export function applyAgentVisualPolicy<T extends AgentVisualResult>(
    result: T,
    question: string,
    agentId?: string
): T {
    const answer = stripAnalyticsPanelCTAs((result.answer || '').trim());
    if (!result.visuals?.length) {
        return { ...result, answer };
    }

    if (!wantsAgentAnalyticsVisual(question, agentId)) {
        return {
            ...result,
            visuals: [],
            answer: stripAnalyticsPanelCTAs(
                answer
                    .replace(/\nCharts are in the analytics panel\.?/gi, '')
                    .replace(/Charts are in the analytics panel\.?/gi, '')
                    .replace(/Open Analytics for the graph\.?/gi, '')
                    .replace(/See the bar chart in the \*\*Analytics\*\* panel\.?/gi, '')
            ),
        };
    }

    const insight = insightFromVisuals(result.visuals || []);
    const thin =
        !answer ||
        /^(chart for |portfolio view across )/i.test(answer) ||
        /^analytics for /i.test(answer);
    const withInsight =
        insight && (thin || !answer.includes(insight.slice(0, 24)))
            ? thin
                ? `${insight}${answer && !/^(chart for |portfolio view|analytics for )/i.test(answer) ? `\n\n${answer}` : ''}`
                : `${insight}\n\n${answer}`
            : answer || insight;
    const body = stripAnalyticsPanelCTAs(withInsight);
    const chartNote = mentionsAnalyticsPanel(body)
        ? ''
        : '\n\nSee the chart in the **Analytics** panel.';
    return {
        ...result,
        answer: `${body}${chartNote}`.trim(),
    };
}
