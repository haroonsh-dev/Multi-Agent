import { AuthUser } from './accessScope';
import { requireAllowedAgent } from './planService';
import type { ChatVisualSpec } from '../types/chatVisuals';
import { PROCUREMENT_AGENT, executeProcurementAnalytics } from './procurementAnalyticsService';
import {
    tryProcurementPOMatchingCommand,
    tryProcurementQuoteComparisonCommand,
    tryProcurementSummaryCommand,
    tryProcurementDocumentExplainCommand,
    detectProcurementPOMatching,
    detectProcurementQuoteComparison,
    detectProcurementSummary,
} from './procurementChatActionService';
import { applyAgentVisualPolicy, wantsAgentAnalyticsVisual, wantsAgentTextOnlyExplain } from './agentAnalyticsPolicy';
import { formatAgentHeading } from './agentResponseFormat';

export type ProcurementWorkTool =
    | 'po_matching'
    | 'quote_comparison'
    | 'summary'
    | 'overview';

export type ProcurementDynamicResult = {
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
    tool?: ProcurementWorkTool;
};

export async function tryProcurementDynamicAgent(opts: {
    user: AuthUser;
    question: string;
    phase3Agent?: string;
    documentIds?: string[];
}): Promise<ProcurementDynamicResult> {
    const { user, question, phase3Agent, documentIds } = opts;

    if (phase3Agent && phase3Agent !== PROCUREMENT_AGENT) {
        return { handled: false };
    }

    if (user.role !== 'superAdmin') {
        const check = await requireAllowedAgent(user, PROCUREMENT_AGENT);
        if (!check.ok && phase3Agent === PROCUREMENT_AGENT) {
            return {
                handled: true,
                answer: `The Procurement Agent is not enabled for your account or department. Allowed agents: ${check.entitlement.agentIds.join(', ') || 'none'}.`,
                citations: [],
                visuals: [],
            };
        }
    }

    if (wantsAgentTextOnlyExplain(question, PROCUREMENT_AGENT)) {
        const explainRes = await tryProcurementDocumentExplainCommand({
            user,
            question,
            phase3Agent,
            documentIds,
        });
        if (explainRes.handled) return { ...explainRes, tool: 'summary' };
    }

    // 1. 3-Way PO Matching
    if (detectProcurementPOMatching(question, phase3Agent)) {
        const res = await tryProcurementPOMatchingCommand({ user, question, phase3Agent, documentIds });
        if (res.handled) return { ...res, tool: 'po_matching' };
    }

    // 2. Vendor Quote / RFQ Comparison
    if (detectProcurementQuoteComparison(question, phase3Agent)) {
        const res = await tryProcurementQuoteComparisonCommand({ user, question, phase3Agent, documentIds });
        if (res.handled) return { ...res, tool: 'quote_comparison' };
    }

    // 3. Procurement Summary
    if (detectProcurementSummary(question, phase3Agent)) {
        const res = await tryProcurementSummaryCommand({ user, question, phase3Agent, documentIds });
        if (res.handled) return { ...res, tool: 'summary' };
    }

    // If explicit procurement_agent was selected and question is an explicit overview request
    if (phase3Agent === PROCUREMENT_AGENT) {
        const q = question.toLowerCase().trim();
        const overviewAsk =
            q.includes('overview') ||
            q.includes('dashboard') ||
            q.includes('orders status') ||
            q.includes('order status') ||
            q.includes('list orders') ||
            q.includes('all orders') ||
            q === 'status' ||
            q === 'overview' ||
            q === 'dashboard';

        if (overviewAsk) {
            const analytics = await executeProcurementAnalytics(user, { documentIds });
            if (analytics.snapshots.length) {
                let text = `${formatAgentHeading('Procurement overview', 2)}\n\n`;
                text += `Managing **${analytics.totalOrders}** order(s) with total committed spend of **${analytics.currency} ${analytics.totalCommittedSpend.toLocaleString()}**:\n\n`;
                text += `- **Open / pending orders:** ${analytics.openCount}\n`;
                text += `- **Fulfilled deliveries:** ${analytics.fulfilledCount}\n`;
                text += `- **Items flagged for review:** ${analytics.discrepancyCount}\n\n`;
                text += `_Ask for PO matching, vendor quote comparison, or procurement summary for deeper analysis._`;

                return {
                    ...applyAgentVisualPolicy(
                        {
                            handled: true,
                            answer: text,
                            citations: analytics.citations,
                            visuals: wantsAgentAnalyticsVisual(question, PROCUREMENT_AGENT)
                                ? analytics.visuals
                                : [],
                        },
                        question,
                        PROCUREMENT_AGENT
                    ),
                    tool: 'overview' as const,
                };
            }
        }
    }

    return { handled: false };
}
