import { AuthUser } from './accessScope';
import { requireAllowedAgent } from './planService';
import type { ChatVisualSpec } from '../types/chatVisuals';
import { OTHER_AGENT, executeOtherAnalytics } from './otherAnalyticsService';
import {
    tryOtherSummarizeCommand,
    tryOtherMetadataCommand,
    tryOtherCompareCommand,
    tryOtherDocumentExplainCommand,
    detectOtherSummarize,
    detectOtherMetadata,
    detectOtherCompare,
} from './otherChatActionService';
import { applyAgentVisualPolicy, wantsAgentAnalyticsVisual, wantsAgentTextOnlyExplain } from './agentAnalyticsPolicy';
import { formatAgentHeading } from './agentResponseFormat';

export type OtherWorkTool =
    | 'summarize'
    | 'metadata'
    | 'compare'
    | 'overview';

export type OtherDynamicResult = {
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
    tool?: OtherWorkTool;
};

export async function tryOtherDynamicAgent(opts: {
    user: AuthUser;
    question: string;
    phase3Agent?: string;
    documentIds?: string[];
}): Promise<OtherDynamicResult> {
    const { user, question, phase3Agent, documentIds } = opts;

    if (phase3Agent !== OTHER_AGENT) {
        return { handled: false };
    }

    if (user.role !== 'superAdmin') {
        const check = await requireAllowedAgent(user, OTHER_AGENT);
        if (!check.ok && phase3Agent === OTHER_AGENT) {
            return {
                handled: true,
                answer: `The General Document Agent is not enabled for your account or department. Allowed agents: ${check.entitlement.agentIds.join(', ') || 'none'}.`,
                citations: [],
                visuals: [],
            };
        }
    }

    if (wantsAgentTextOnlyExplain(question, OTHER_AGENT)) {
        const explainRes = await tryOtherDocumentExplainCommand({
            user,
            question,
            phase3Agent,
            documentIds,
        });
        if (explainRes.handled) return { ...explainRes, tool: 'summarize' };
    }

    // 1. Executive Summarizer
    if (detectOtherSummarize(question, phase3Agent)) {
        const res = await tryOtherSummarizeCommand({ user, question, phase3Agent, documentIds });
        if (res.handled) return { ...res, tool: 'summarize' };
    }

    // 2. Technical Metadata Inspection
    if (detectOtherMetadata(question, phase3Agent)) {
        const res = await tryOtherMetadataCommand({ user, question, phase3Agent, documentIds });
        if (res.handled) return { ...res, tool: 'metadata' };
    }

    // 3. Cross-Document Comparison
    if (detectOtherCompare(question, phase3Agent)) {
        const res = await tryOtherCompareCommand({ user, question, phase3Agent, documentIds });
        if (res.handled) return { ...res, tool: 'compare' };
    }

    // If explicit other_agent was selected and question is an explicit overview request
    if (phase3Agent === OTHER_AGENT) {
        const q = question.toLowerCase().trim();
        const overviewAsk =
            q.includes('overview') ||
            q.includes('dashboard') ||
            q.includes('files status') ||
            q.includes('list files') ||
            q.includes('all files') ||
            q === 'status' ||
            q === 'overview' ||
            q === 'dashboard';

        if (overviewAsk) {
            const analytics = await executeOtherAnalytics(user, { documentIds });
            if (analytics.snapshots.length) {
                let text = `${formatAgentHeading('Document overview', 2)}\n\n`;
                text += `Currently indexing **${analytics.totalDocuments}** general document(s) (${analytics.totalPages} total pages).\n\n`;
                text += `_Ask to summarize a document, show file metadata, or compare documents — or ask a specific question about your files._`;

                return {
                    ...applyAgentVisualPolicy(
                        {
                            handled: true,
                            answer: text,
                            citations: analytics.citations,
                            visuals: wantsAgentAnalyticsVisual(question, OTHER_AGENT)
                                ? analytics.visuals
                                : [],
                        },
                        question,
                        OTHER_AGENT
                    ),
                    tool: 'overview' as const,
                };
            }
        }
    }

    return { handled: false };
}
