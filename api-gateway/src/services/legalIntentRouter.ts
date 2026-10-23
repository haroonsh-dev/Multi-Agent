import { AuthUser } from './accessScope';
import { requireAllowedAgent } from './planService';
import type { ChatVisualSpec } from '../types/chatVisuals';
import { LEGAL_AGENT, executeLegalAnalytics, executeLegalMissingDataAnalytics } from './legalAnalyticsService';
import {
    tryLegalRiskAuditCommand,
    tryLegalExpiryAlertCommand,
    tryLegalObligationMatrixCommand,
    tryLegalReportCommand,
    tryLegalDocumentExplainCommand,
    detectLegalRiskAudit,
    detectLegalExpiryAsk,
    detectLegalObligationsAsk,
    detectLegalReportCommand,
    detectLegalDocumentExplain,
    detectLegalMissingDataAsk,
} from './legalChatActionService';
import { applyAgentVisualPolicy, wantsAgentAnalyticsVisual } from './agentAnalyticsPolicy';
import { formatAgentHeading } from './agentResponseFormat';

export type LegalWorkTool =
    | 'risk_audit'
    | 'expiry'
    | 'obligations'
    | 'report'
    | 'overview'
    | 'explain'
    | 'qa';

export type LegalDynamicResult = {
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
    tool?: LegalWorkTool;
};

export async function tryLegalDynamicAgent(opts: {
    user: AuthUser;
    question: string;
    phase3Agent?: string;
    documentIds?: string[];
}): Promise<LegalDynamicResult> {
    const { user, question, phase3Agent, documentIds } = opts;

    if (phase3Agent && phase3Agent !== LEGAL_AGENT) {
        return { handled: false };
    }

    if (user.role !== 'superAdmin') {
        const check = await requireAllowedAgent(user, LEGAL_AGENT);
        if (!check.ok && phase3Agent === LEGAL_AGENT) {
            return {
                handled: true,
                answer: `The Legal Agent is not enabled for your account or department. Allowed agents: ${check.entitlement.agentIds.join(', ') || 'none'}.`,
                citations: [],
                visuals: [],
            };
        }
    }

    // Document explain / summarize — before chart-like overview handling
    if (detectLegalDocumentExplain(question, phase3Agent)) {
        const res = await tryLegalDocumentExplainCommand({ user, question, phase3Agent, documentIds });
        if (res.handled) return { ...res, tool: 'explain' };
    }

    // Try discrete tool commands
    if (detectLegalReportCommand(question, phase3Agent)) {
        const res = await tryLegalReportCommand({ user, question, phase3Agent, documentIds });
        if (res.handled) return { ...res, tool: 'report' };
    }

    if (detectLegalRiskAudit(question, phase3Agent)) {
        const res = await tryLegalRiskAuditCommand({ user, question, phase3Agent, documentIds });
        if (res.handled) return { ...res, tool: 'risk_audit' };
    }

    if (detectLegalExpiryAsk(question, phase3Agent)) {
        const res = await tryLegalExpiryAlertCommand({ user, question, phase3Agent, documentIds });
        if (res.handled) return { ...res, tool: 'expiry' };
    }

    if (detectLegalObligationsAsk(question, phase3Agent)) {
        const res = await tryLegalObligationMatrixCommand({ user, question, phase3Agent, documentIds });
        if (res.handled) return { ...res, tool: 'obligations' };
    }

    if (detectLegalMissingDataAsk(question, phase3Agent)) {
        const missing = await executeLegalMissingDataAnalytics(user, { documentIds });
        return {
            ...applyAgentVisualPolicy(
                {
                    handled: true,
                    answer: missing.answer,
                    citations: missing.citations,
                    visuals: wantsAgentAnalyticsVisual(question, LEGAL_AGENT)
                        ? missing.visuals
                        : [],
                },
                question,
                LEGAL_AGENT
            ),
            tool: 'overview' as const,
        };
    }

    // If explicit legal_agent was selected and question is an explicit overview request
    if (phase3Agent === LEGAL_AGENT) {
        const q = question.toLowerCase().trim();
        const overviewAsk =
            q.includes('overview') ||
            q.includes('dashboard') ||
            q.includes('contracts status') ||
            q.includes('contract status') ||
            q.includes('list contracts') ||
            q.includes('all contracts') ||
            q === 'status' ||
            q === 'overview' ||
            q === 'dashboard';

        if (overviewAsk) {
            const analytics = await executeLegalAnalytics(user, { documentIds });
            if (analytics.snapshots.length) {
                let text = `${formatAgentHeading('Legal overview', 2)}\n\n`;
                text += `Currently managing **${analytics.totalContracts}** legal document(s):\n\n`;
                text += `- **Active:** ${analytics.activeCount}\n`;
                text += `- **Expiring soon (within 60 days):** ${analytics.expiringSoonCount}\n`;
                text += `- **Expired:** ${analytics.expiredCount}\n`;
                text += `- **High risk flagged:** ${analytics.highRiskCount}\n\n`;
                text += `_Ask for contract risk audit, expiring contracts, or party obligations for deeper analysis._`;

                return {
                    ...applyAgentVisualPolicy(
                        {
                            handled: true,
                            answer: text,
                            citations: analytics.citations,
                            visuals: wantsAgentAnalyticsVisual(question, LEGAL_AGENT)
                                ? analytics.visuals
                                : [],
                        },
                        question,
                        LEGAL_AGENT
                    ),
                    tool: 'overview' as const,
                };
            }
        }
    }

    return { handled: false };
}
