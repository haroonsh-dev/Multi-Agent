import type { ChatVisualSpec, AgentChatVisualResult, FinanceAnalyticsCoverage, AgentAnalyticsCoverage } from '../types/chatVisuals';
import { AuthUser } from './accessScope';
import { requireAllowedAgent } from './planService';
import { listTopResumesForUser } from './hrChatActionService';
import { HR_AGENT } from './offerLetterGenerationService';
import {
    detectHrVisualIntent,
    executeHrPortfolioAnalytics,
    mapHrPanelView,
    type HrVisualIntent as HrPortfolioIntent,
} from './hrAnalyticsService';
import {
    type FinanceVisualIntent,
    tryFinanceChatVisual,
    wantsVisualization,
} from './financeChatVisualService';
import { FINANCE_AGENT } from './financeAnalyticsService';
import { COMPLIANCE_AGENT } from './complianceAnalyticsService';
import {
    type ComplianceVisualIntent,
    tryComplianceChatVisual,
} from './complianceChatVisualService';
import {
    filterDocumentIdsForAgent,
    loadAgentScopedDocuments,
    runDynamicAnalytics,
    runDynamicDashboard,
} from './dynamicAnalyticsEngine';
import { applyAgentVisualPolicy, wantsAgentAnalyticsVisual } from './agentAnalyticsPolicy';

export type HrVisualIntent = 'ranking' | 'distribution' | HrPortfolioIntent;

function detectHrVisualIntentLegacy(question: string, phase3Agent?: string): HrVisualIntent | null {
    return detectHrVisualIntent(question, phase3Agent);
}

export async function executeHrAnalytics(
    user: AuthUser,
    limit = 10,
    documentIds?: string[],
    intent: 'ranking' | 'distribution' = 'ranking'
): Promise<{
    visuals: ChatVisualSpec[];
    citations: NonNullable<AgentChatVisualResult['citations']>;
    answer: string;
    documentCount: number;
}> {
    const fetchLimit = intent === 'distribution' ? 100 : limit;
    const pool = await listTopResumesForUser(user, fetchLimit, documentIds);
    const top = intent === 'distribution' ? pool : pool.slice(0, limit);

    if (!top.length) {
        return {
            visuals: [],
            citations: [],
            documentCount: 0,
            answer:
                'No resumes in scope yet. Select CVs in Document scope, wait until they’re ready, then ask again.',
        };
    }

    const citations = top.map((r) => ({
        documentId: r.documentId,
        filename: r.originalFilename,
        documentType: 'resume',
        phase3Agent: HR_AGENT,
    }));

    if (intent === 'distribution') {
        const buckets = [
            { label: '0–39', min: 0, max: 39 },
            { label: '40–59', min: 40, max: 59 },
            { label: '60–79', min: 60, max: 79 },
            { label: '80–100', min: 80, max: 100 },
        ];
        const counts = buckets.map((b) => ({
            bucket: b.label,
            count: top.filter((r) => {
                if (!Number.isFinite(r.cvScore)) return false;
                return r.cvScore >= b.min && r.cvScore <= b.max;
            }).length,
        }));
        return {
            visuals: [
                {
                    id: `hr_dist_${Date.now()}`,
                    agentId: HR_AGENT,
                    kind: 'bar',
                    title: 'CV score distribution',
                    subtitle: `Across ${top.length} resume(s) in scope`,
                    categoryKey: 'bucket',
                    series: [{ key: 'count', label: 'Candidates', color: '#a855f7' }],
                    data: counts,
                    footer: 'From CV scores on scoped resumes.',
                },
            ],
            documentCount: top.length,
            citations,
            answer: `Here’s the CV score distribution across ${top.length} resume(s) in your scope.`,
        };
    }

    const data = top
        .map((r) => ({
            candidate:
                r.originalFilename.length > 24
                    ? `${r.originalFilename.slice(0, 22)}…`
                    : r.originalFilename,
            score: Number.isFinite(r.cvScore) ? r.cvScore : null,
            _documentIds: r.documentId,
        }))
        .filter((row) => row.score != null) as Array<{
        candidate: string;
        score: number;
        _documentIds: string;
    }>;

    if (!data.length) {
        return {
            visuals: [],
            documentCount: top.length,
            citations,
            answer:
                'Those CVs don’t have scores yet. Open each resume until processing finishes, then ask again.',
        };
    }

    const rankingLines = data.map(
        (row, i) => `${i + 1}. **${row.candidate}** — **${row.score}/100**`
    );
    const lead = `Here’s how your scoped candidates **rank by CV score** (${data.length} with scores):`;

    return {
        visuals: [
            {
                id: `hr_cv_${Date.now()}`,
                agentId: HR_AGENT,
                kind: 'bar',
                title: 'Candidate CV scores',
                subtitle: `Top ${data.length} by score`,
                categoryKey: 'candidate',
                series: [{ key: 'score', label: 'CV score (0–100)', color: '#7c3aed' }],
                data,
                footer: 'Scores from your HR processing pipeline.',
            },
        ],
        documentCount: top.length,
        citations,
        answer: [lead, '', ...rankingLines, '', 'See the bar chart in the **Analytics** panel.'].join('\n'),
    };
}

async function tryHrChatVisual(params: {
    user: AuthUser;
    question: string;
    phase3Agent?: string;
    documentIds?: string[];
}): Promise<AgentChatVisualResult> {
    if (params.phase3Agent && params.phase3Agent !== HR_AGENT) {
        return { handled: false };
    }

    if (!wantsAgentAnalyticsVisual(params.question, params.phase3Agent || HR_AGENT)) {
        return { handled: false };
    }

    const intent = detectHrVisualIntentLegacy(params.question, params.phase3Agent);
    if (!intent) return { handled: false };

    if (params.user.role !== 'superAdmin') {
        const check = await requireAllowedAgent(params.user, HR_AGENT);
        if (!check.ok) {
            return { handled: true, answer: check.message, agentId: HR_AGENT };
        }
    }

    const m = params.question.toLowerCase().match(/top\s+(\d{1,2})/);
    const limit = m ? Math.max(1, Math.min(20, Number(m[1]))) : 10;

    if (intent === 'ranking' || intent === 'distribution') {
        const result = await executeHrAnalytics(params.user, limit, params.documentIds, intent);
        return applyAgentVisualPolicy(
            {
                handled: true,
                agentId: HR_AGENT,
                visuals: result.visuals,
                citations: result.citations,
                answer: result.answer,
            },
            params.question,
            HR_AGENT
        );
    }

    const result = await executeHrPortfolioAnalytics(
        params.user,
        intent,
        params.documentIds,
        limit
    );
    if (!result.visuals.length && !result.answer) {
        return { handled: true, agentId: HR_AGENT, answer: result.answer };
    }
    return applyAgentVisualPolicy(
        {
            handled: true,
            agentId: HR_AGENT,
            visuals: result.visuals,
            citations: result.citations,
            answer: result.answer,
        },
        params.question,
        HR_AGENT
    );
}

function mapHrView(view?: string): HrVisualIntent {
    return mapHrPanelView(view);
}

export async function getAgentAnalyticsDashboard(params: {
    user: AuthUser;
    agentId: string;
    view?: string;
    limit?: number;
    documentIds?: string[];
    dashboardMode?: boolean;
}): Promise<{
    agentId: string;
    visuals: ChatVisualSpec[];
    citations: AgentChatVisualResult['citations'];
    summary: string;
    documentCount: number;
    coverage?: FinanceAnalyticsCoverage | import('../types/chatVisuals').ComplianceAnalyticsCoverage | AgentAnalyticsCoverage;
    scopeMode?: 'all' | 'selected';
}> {
    const { user, agentId } = params;

    if (user.role !== 'superAdmin') {
        const check = await requireAllowedAgent(user, agentId);
        if (!check.ok) {
            return {
                agentId,
                visuals: [],
                citations: [],
                summary: check.message,
                documentCount: 0,
            };
        }
    }

    let scopedDocIds = params.documentIds;
    if (scopedDocIds?.length) {
        scopedDocIds = await filterDocumentIdsForAgent(user, scopedDocIds, agentId);
    } else if (params.dashboardMode) {
        const scoped = await loadAgentScopedDocuments(user, agentId);
        scopedDocIds = scoped.map((d) => d.documentId);
    }
    const scopeMode: 'all' | 'selected' = params.documentIds?.length
        ? 'selected'
        : params.dashboardMode
          ? 'all'
          : 'selected';

    if (scopedDocIds?.length) {
        const dyn = await runDynamicDashboard({
            user,
            agentId,
            view: params.view,
            documentIds: scopedDocIds,
        });
        return {
            agentId,
            visuals: dyn.visuals || [],
            citations: dyn.citations || [],
            summary: dyn.answer || '',
            documentCount: dyn.documentCount || scopedDocIds.length,
            coverage: dyn.coverage,
            scopeMode: params.dashboardMode ? 'all' : 'selected',
        };
    }

    if (params.dashboardMode) {
        return {
            agentId,
            visuals: [],
            citations: [],
            summary: `No processed ${agentId.replace('_agent', '')} documents yet. Upload files or connect an integration, then refresh.`,
            documentCount: 0,
            scopeMode: 'all',
        };
    }

    if (agentId === FINANCE_AGENT) {
        return {
            agentId: FINANCE_AGENT,
            visuals: [],
            citations: [],
            summary:
                'Select invoice or finance files in chat scope, then refresh — charts follow those documents only.',
            documentCount: 0,
            coverage: {
                documentsInScope: 0,
                documentsWithAmount: 0,
                documentsWithClient: 0,
                documentsWithVendor: 0,
                files: [],
            },
            scopeMode: 'selected',
        };
    }

    if (agentId === HR_AGENT) {
        const limit = params.limit ? Math.max(1, Math.min(20, params.limit)) : 10;
        const intent = mapHrView(params.view);
        if (intent === 'ranking' || intent === 'distribution') {
            const result = await executeHrAnalytics(user, limit, params.documentIds, intent);
            return {
                agentId: HR_AGENT,
                visuals: result.visuals,
                citations: result.citations,
                summary: result.answer,
                documentCount: result.documentCount,
                coverage: {
                    documentsInScope: result.documentCount,
                    documentsCharted: result.visuals?.length ? result.documentCount : 0,
                },
                scopeMode,
            };
        }
        const result = await executeHrPortfolioAnalytics(user, intent, params.documentIds, limit);
        return {
            agentId: HR_AGENT,
            visuals: result.visuals,
            citations: result.citations,
            summary: result.answer,
            documentCount: result.documentCount,
            coverage: {
                documentsInScope: result.documentCount,
                documentsCharted: result.visuals?.length ? result.documentCount : 0,
            },
            scopeMode,
        };
    }

    if (agentId === COMPLIANCE_AGENT) {
        return {
            agentId: COMPLIANCE_AGENT,
            visuals: [],
            citations: [],
            summary:
                'Select compliance documents in chat scope (certificates, audits, SOPs), then ask for a chart or refresh analytics.',
            documentCount: 0,
            coverage: {
                documentsInScope: 0,
                documentsWithExpiry: 0,
                documentsWithFindings: 0,
                files: [],
            },
            scopeMode: 'selected',
        };
    }

    return {
        agentId,
        visuals: [],
        citations: [],
        summary:
            'Select documents in chat scope, then ask for a chart. Analytics are built from those files’ extractions.',
        documentCount: 0,
        scopeMode,
    };
}

export async function tryAgentChatVisual(params: {
    user: AuthUser;
    question: string;
    phase3Agent?: string;
    documentIds?: string[];
    focusDocumentIds?: string[];
    sessionId?: string;
}): Promise<AgentChatVisualResult> {
    const wantsViz =
        wantsVisualization(params.question) ||
        wantsAgentAnalyticsVisual(params.question, params.phase3Agent);
    if (!wantsViz) {
        return { handled: false };
    }

    // Charts only when the question is analytics-related — not explain/overview asks
    if (wantsAgentAnalyticsVisual(params.question, params.phase3Agent)) {
        const dyn = await runDynamicAnalytics({
            ...params,
            sessionId: params.sessionId,
        });
        if (dyn.handled) {
            return {
                handled: true,
                agentId: params.phase3Agent || dyn.agentId,
                answer: dyn.answer,
                visuals: dyn.visuals,
                citations: dyn.citations,
                coverage: dyn.coverage,
                analyticsView: dyn.analyticsView,
            };
        }
    }

    // Legacy fallbacks only when dynamic engine declines — never cross agents
    if (!params.phase3Agent || params.phase3Agent === FINANCE_AGENT) {
        const finance = await tryFinanceChatVisual({ ...params, sessionId: params.sessionId });
        if (finance.handled) {
            return applyAgentVisualPolicy(finance, params.question, params.phase3Agent || finance.agentId);
        }
    }

    if (!params.phase3Agent || params.phase3Agent === COMPLIANCE_AGENT) {
        const compliance = await tryComplianceChatVisual(params);
        if (compliance.handled) {
            return applyAgentVisualPolicy(
                compliance,
                params.question,
                params.phase3Agent || compliance.agentId
            );
        }
    }

    if (!params.phase3Agent || params.phase3Agent === HR_AGENT) {
        const hr = await tryHrChatVisual(params);
        if (hr.handled) {
            return applyAgentVisualPolicy(hr, params.question, params.phase3Agent || hr.agentId);
        }
    }

    if (wantsAgentAnalyticsVisual(params.question, params.phase3Agent)) {
        return {
            handled: true,
            agentId: params.phase3Agent || 'other_agent',
            answer:
                'Select the documents you want charted in Document scope, then ask again — for example vendor totals, CV scores, certificate expiry, or PO amounts. Charts follow whatever is in scope.',
        };
    }

    return { handled: false };
}

// Keep unused type exports for view mapping callers
export type { FinanceVisualIntent, ComplianceVisualIntent };
