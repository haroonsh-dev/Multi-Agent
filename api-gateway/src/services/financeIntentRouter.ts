import { AuthUser } from './accessScope';
import { requireAllowedAgent } from './planService';
import type { ChatVisualSpec } from '../types/chatVisuals';
import { FINANCE_AGENT } from './financeAnalyticsService';
import {
    tryFinanceReportCommand,
    tryFinanceReconciliationCommand,
    tryFinanceCashOutflowCommand,
    tryFinanceDocumentExplainCommand,
    tryFinanceSpreadsheetTotalCommand,
    detectFinanceReconciliation,
    detectFinanceCashOutflow,
    detectFinanceSpreadsheetTotalAsk,
} from './financeChatActionService';
import { tryFinanceChatVisual } from './financeChatVisualService';
import { applyAgentVisualPolicy, wantsAgentAnalyticsVisual, wantsAgentTextOnlyExplain } from './agentAnalyticsPolicy';
import { FINANCE_CAPABILITY_REPLY, isCapabilityQuestion } from '../utils/chatCapability';

export type FinanceWorkTool =
    | 'reconciliation'
    | 'cash_outflow'
    | 'report'
    | 'visual'
    | 'overview';

export type FinanceDynamicResult = {
    handled: boolean;
    answer?: string;
    citations?: Array<{
        documentId: string;
        filename?: string;
        score?: number;
        documentType?: string;
        phase3Agent?: string;
    }>;
    visuals?: ChatVisualSpec[];
    tool?: FinanceWorkTool;
};

export function detectFinanceReportAsk(question: string, phase3Agent?: string): boolean {
    if (phase3Agent && phase3Agent !== FINANCE_AGENT) return false;
    const q = question.toLowerCase();
    return (
        q.includes('finance report') ||
        q.includes('generate finance') ||
        q.includes('finance pack') ||
        q.includes('ap report') ||
        q.includes('ar report') ||
        q.includes('settlement report')
    );
}

export function detectFinanceCapabilityAsk(question: string, phase3Agent?: string): boolean {
    if (phase3Agent && phase3Agent !== FINANCE_AGENT) return false;
    return isCapabilityQuestion(question);
}

export async function tryFinanceDynamicAgent(opts: {
    user: AuthUser;
    question: string;
    phase3Agent?: string;
    documentIds?: string[];
}): Promise<FinanceDynamicResult> {
    const { user, question, phase3Agent, documentIds } = opts;

    if (phase3Agent && phase3Agent !== FINANCE_AGENT) {
        return { handled: false };
    }

    if (user.role !== 'superAdmin') {
        const check = await requireAllowedAgent(user, FINANCE_AGENT);
        if (!check.ok && phase3Agent === FINANCE_AGENT) {
            return {
                handled: true,
                answer: `The Finance Agent is not enabled for your account or department. Allowed agents: ${check.entitlement.agentIds.join(', ') || 'none'}.`,
                citations: [],
                visuals: [],
            };
        }
    }

    if (detectFinanceCapabilityAsk(question, phase3Agent)) {
        return {
            handled: true,
            answer: FINANCE_CAPABILITY_REPLY,
            citations: [],
            visuals: [],
            tool: 'overview',
        };
    }

    // Computed spreadsheet / portfolio totals — never let the LLM guess sums
    if (detectFinanceSpreadsheetTotalAsk(question, phase3Agent)) {
        const totalRes = await tryFinanceSpreadsheetTotalCommand({
            user,
            question,
            phase3Agent,
            documentIds,
        });
        if (totalRes.handled) return { ...totalRes, tool: 'overview' };
    }

    // Text-only finance explain (invoice / vendor overview)
    if (wantsAgentTextOnlyExplain(question, FINANCE_AGENT)) {
        const explainRes = await tryFinanceDocumentExplainCommand({
            user,
            question,
            phase3Agent,
            documentIds,
        });
        if (explainRes.handled) return { ...explainRes, tool: 'overview' };
    }

    // 1. Reconciliation Audit
    if (detectFinanceReconciliation(question, phase3Agent)) {
        const res = await tryFinanceReconciliationCommand({ user, question, phase3Agent, documentIds });
        if (res.handled) return { ...res, tool: 'reconciliation' };
    }

    // 2. Cash Outflow & Payable Forecast
    if (detectFinanceCashOutflow(question, phase3Agent)) {
        const res = await tryFinanceCashOutflowCommand({ user, question, phase3Agent, documentIds });
        if (res.handled) return { ...res, tool: 'cash_outflow' };
    }

    // 3. Finance Report Pack PDF
    if (detectFinanceReportAsk(question, phase3Agent)) {
        const res = await tryFinanceReportCommand({ user, question, phase3Agent, documentIds });
        if (res.handled) return { ...res, tool: 'report' };
    }

    // 4. Financial Charts & Visualization (analytics asks only)
    if (wantsAgentAnalyticsVisual(question, FINANCE_AGENT)) {
        const visualRes = await tryFinanceChatVisual({ user, question, phase3Agent, documentIds });
        if (visualRes.handled && visualRes.answer) {
            return {
                ...applyAgentVisualPolicy(
                    {
                        handled: true,
                        answer: visualRes.answer,
                        citations: visualRes.citations || [],
                        visuals: visualRes.visuals || [],
                    },
                    question,
                    FINANCE_AGENT
                ),
                tool: 'visual' as const,
            };
        }
    }

    return { handled: false };
}
