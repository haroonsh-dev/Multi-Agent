/**
 * Dynamic HR work router — classify natural HR asks → tools/skills.
 * Prefer this over hard-coded magic phrases when phase3Agent is hr_agent.
 */
import { AuthUser } from './accessScope';
import { requireAllowedAgent } from './planService';
import type { ChatVisualSpec } from '../types/chatVisuals';
import { HR_AGENT } from './offerLetterGenerationService';
import {
    detectHrVisualIntent,
    executeHrPortfolioAnalytics,
    type HrVisualIntent,
} from './hrAnalyticsService';
import {
    applyAgentVisualPolicy,
} from './agentAnalyticsPolicy';
import {
    tryHrChatCommand,
    detectHrCvTableAsk,
    detectHrCvOverviewAsk,
    tryHrCvComparisonTable,
    tryHrCvOverviewCommand,
    wantsHrCandidateDeepDive,
    wantsHrAnalyticsVisual,
    wantsHrTextOnlyExplain,
} from './hrChatActionService';
import {
    tryHrReportCommand,
    tryHrShortlistExport,
    tryHrDirectoryCommand,
    tryHrExtraLetterCommand,
    tryHrSectionPdfCommand,
    tryHrRescoreCvsCommand,
    detectHrExtraLetter,
    detectHrReportCommand,
    detectHrShortlistExport,
    detectHrSectionPdf,
    detectHrRescoreCvs,
} from './hrChatReportService';
import {
    detectHrCandidateEmail,
    tryHrCandidateEmailCommand,
} from './hrCandidateEmailService';
import type { Request } from 'express';

export type HrWorkTool =
    | 'report'
    | 'shortlist'
    | 'directory'
    | 'certs'
    | 'onboarding'
    | 'leave'
    | 'payroll'
    | 'attendance'
    | 'performance'
    | 'transcript'
    | 'ranking'
    | 'distribution'
    | 'overview'
    | 'offer_letter'
    | 'experience_letter'
    | 'promotion_letter'
    | 'warning_letter'
    | 'relieving_letter'
    | 'joining_letter'
    | 'internship_letter'
    | 'training_certificate'
    | 'list_candidates'
    | 'cv_table'
    | 'cv_overview'
    | 'section_pdf'
    | 'rescore_cvs'
    | 'candidate_email'
    | 'qa';

export type HrWorkClassification = {
    tool: HrWorkTool;
    confidence: number;
    reason: string;
};

export type HrDynamicResult = {
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
    tool?: HrWorkTool;
};

const ANALYTICS_TOOLS = new Set<HrWorkTool>([
    'directory',
    'certs',
    'onboarding',
    'leave',
    'payroll',
    'attendance',
    'performance',
    'transcript',
    'ranking',
    'distribution',
    'overview',
]);

/**
 * Classify an HR work ask. When on HR agent, soft-match natural language
 * (leave / certs / performance / letters) without requiring "chart" / "generate".
 */
export function classifyHrWorkIntent(
    question: string,
    phase3Agent?: string
): HrWorkClassification | null {
    const q = question.toLowerCase().trim();
    if (!q) return null;

    const onHr =
        phase3Agent === HR_AGENT ||
        /\bhr\s+agent\b/i.test(question) ||
        /\b(human\s+resources|people\s+ops)\b/i.test(q);

    // Explicit document Q&A → leave to RAG (who said X in this file, summarize page…)
    if (
        /\b(what\s+does\s+(this|the)\s+(document|file|pdf)\s+say|summarize\s+(this|the)\s+(document|file)|explain\s+(this|the)\s+(clause|section)|quote\s+from)\b/i.test(
            q
        )
    ) {
        return { tool: 'qa', confidence: 0.9, reason: 'document_qa' };
    }

    if (wantsHrCandidateDeepDive(question)) {
        return { tool: 'cv_overview', confidence: 0.92, reason: 'candidate_deep_dive' };
    }

    if (detectHrCvTableAsk(question, onHr ? HR_AGENT : phase3Agent)) {
        return { tool: 'cv_table', confidence: 0.9, reason: 'cv_table' };
    }

    if (detectHrCvOverviewAsk(question, onHr ? HR_AGENT : phase3Agent)) {
        return { tool: 'cv_overview', confidence: 0.88, reason: 'cv_overview' };
    }

    // Letters first (actionable drafts) — before leave/certs analytics
    const extra = detectHrExtraLetter(question, onHr ? HR_AGENT : phase3Agent);
    if (extra === 'joining') {
        return { tool: 'joining_letter', confidence: 0.95, reason: 'joining_letter' };
    }
    if (extra === 'internship') {
        return { tool: 'internship_letter', confidence: 0.95, reason: 'internship_letter' };
    }
    if (extra === 'training_certificate') {
        return { tool: 'training_certificate', confidence: 0.95, reason: 'training_certificate' };
    }
    if (extra === 'promotion') {
        return { tool: 'promotion_letter', confidence: 0.95, reason: 'promotion_letter' };
    }
    if (extra === 'warning') {
        return { tool: 'warning_letter', confidence: 0.95, reason: 'warning_letter' };
    }
    if (extra === 'relieving') {
        return { tool: 'relieving_letter', confidence: 0.95, reason: 'relieving_letter' };
    }

    if (
        /\b(offer\s*letter|job\s+offer)\b/.test(q) ||
        (onHr && /\boffer\b/.test(q) && /\bfor\b/.test(q) && !/\bexperience\b/.test(q))
    ) {
        return { tool: 'offer_letter', confidence: 0.9, reason: 'offer_letter' };
    }
    if (
        /\b(experience\s*letter|employment\s+certificate)\b/.test(q) ||
        (onHr && /\bexperience\b/.test(q) && /\b(letter|for)\b/.test(q))
    ) {
        return { tool: 'experience_letter', confidence: 0.9, reason: 'experience_letter' };
    }

    if (detectHrReportCommand(question, onHr ? HR_AGENT : phase3Agent) || (onHr && /\b(hr|workforce|people)\s+(report|summary)\b/.test(q))) {
        return { tool: 'report', confidence: 0.95, reason: 'hr_report' };
    }
    if (detectHrRescoreCvs(question, onHr ? HR_AGENT : phase3Agent)) {
        return { tool: 'rescore_cvs', confidence: 0.95, reason: 'rescore_cvs' };
    }
    if (detectHrSectionPdf(question, onHr ? HR_AGENT : phase3Agent)) {
        return { tool: 'section_pdf', confidence: 0.9, reason: 'section_pdf' };
    }
    if (
        detectHrCandidateEmail(question, onHr ? HR_AGENT : phase3Agent) ||
        (onHr && /\b(send|email|mail)\b/.test(q) && /\b(candidate|candidates|shortlist|interview\s+invite)\b/.test(q))
    ) {
        return { tool: 'candidate_email', confidence: 0.92, reason: 'candidate_email' };
    }
    if (
        detectHrShortlistExport(question, onHr ? HR_AGENT : phase3Agent) ||
        (onHr && /\bshortlist\b/.test(q) && /\b(export|download|pdf|generate|create|give)\b/.test(q))
    ) {
        return { tool: 'shortlist', confidence: 0.9, reason: 'shortlist' };
    }

    // Portfolio analytics via soft visual detector
    const viz = detectHrVisualIntent(question, onHr ? HR_AGENT : phase3Agent);
    if (viz && ANALYTICS_TOOLS.has(viz as HrWorkTool)) {
        return { tool: viz as HrWorkTool, confidence: 0.85, reason: `analytics:${viz}` };
    }

    // Extra soft maps when already on HR agent
    if (onHr) {
        if (
            /\b(who.?s\s+on\s+leave|leave\s+requests?|time[\s-]?off)\b/.test(q) &&
            !/\b(letter|certificate|hire|joining|internship)\b/.test(q)
        ) {
            return { tool: 'leave', confidence: 0.8, reason: 'soft_leave' };
        }
        if (
            /\b(expir|renew).{0,20}\b(cert|training)\b|\b(cert|training).{0,20}\b(expir|renew)\b/.test(q) &&
            !/\b(generate|create|draft|issue|make)\b/.test(q)
        ) {
            return { tool: 'certs', confidence: 0.8, reason: 'soft_certs' };
        }
        if (/\b(missing\s+onboarding|onboarding\s+gap|new\s+hire\s+docs)\b/.test(q)) {
            return { tool: 'onboarding', confidence: 0.8, reason: 'soft_onboarding' };
        }
        if (/\b(headcount|who\s+do\s+we\s+have|staff\s+list|employees?\s+list)\b/.test(q)) {
            return { tool: 'directory', confidence: 0.8, reason: 'soft_directory' };
        }
        if (/\b(payslips?|salary\s+cost|payroll\s+total)\b/.test(q)) {
            return { tool: 'payroll', confidence: 0.75, reason: 'soft_payroll' };
        }
        if (/\b(absent|present\s*%|attendance\s+rate)\b/.test(q)) {
            return { tool: 'attendance', confidence: 0.75, reason: 'soft_attendance' };
        }
        if (/\b(appraisal|performance|review\s+cycle)\b/.test(q)) {
            return { tool: 'performance', confidence: 0.8, reason: 'soft_performance' };
        }
        if (/\b(transcripts?|marksheets?|gpa|cgpa)\b/.test(q)) {
            return { tool: 'transcript', confidence: 0.8, reason: 'soft_transcript' };
        }
        if (/\b(candidates?|hiring|resumes?|cvs?)\b/.test(q)) {
            if (detectHrCvOverviewAsk(question, HR_AGENT)) {
                return { tool: 'cv_overview', confidence: 0.85, reason: 'soft_cv_overview' };
            }
            if (detectHrCvTableAsk(question, HR_AGENT)) {
                return { tool: 'cv_table', confidence: 0.85, reason: 'soft_cv_table' };
            }
            if (/\b(list|show all)\b/.test(q) && !wantsHrTextOnlyExplain(question)) {
                return { tool: 'list_candidates', confidence: 0.75, reason: 'soft_candidates' };
            }
            if (wantsHrAnalyticsVisual(question)) {
                if (/\b(distribution|histogram|spread)\b/.test(q)) {
                    return { tool: 'distribution', confidence: 0.85, reason: 'soft_distribution' };
                }
                return { tool: 'ranking', confidence: 0.85, reason: 'soft_ranking' };
            }
            return { tool: 'cv_overview', confidence: 0.65, reason: 'cv_default_overview' };
        }
    }

    // Outside HR agent: only clear HR work phrases
    if (!onHr) return null;

    if (wantsHrAnalyticsVisual(question)) {
        return { tool: 'overview', confidence: 0.55, reason: 'hr_analytics_overview' };
    }

    return { tool: 'qa', confidence: 0.4, reason: 'fallthrough_qa' };
}

async function runAnalyticsTool(
    user: AuthUser,
    tool: HrWorkTool,
    documentIds?: string[],
    question?: string
): Promise<HrDynamicResult> {
    if (tool === 'ranking' || tool === 'distribution') {
        const { executeHrAnalytics } = await import('./agentChatVisualService');
        const result = await executeHrAnalytics(
            user,
            10,
            documentIds,
            tool === 'distribution' ? 'distribution' : 'ranking'
        );
        return applyAgentVisualPolicy(
            {
                handled: true,
                tool,
                answer: result.answer,
                citations: result.citations,
                visuals: result.visuals,
            },
            question || '',
            HR_AGENT
        );
    }

    const intent = tool as HrVisualIntent;
    const result = await executeHrPortfolioAnalytics(user, intent, documentIds, 10);
    return applyAgentVisualPolicy(
        {
            handled: true,
            tool,
            answer: result.answer,
            citations: result.citations,
            visuals: result.visuals,
        },
        question || '',
        HR_AGENT
    );
}

/**
 * Single entry for HR Agent chat — routes natural HR work to the right skill/tool.
 * Returns handled:false only for pure document Q&A (RAG path).
 */
export async function tryHrDynamicAgent(params: {
    user: AuthUser;
    question: string;
    phase3Agent?: string;
    documentIds?: string[];
    req?: Request;
}): Promise<HrDynamicResult> {
    if (params.phase3Agent && params.phase3Agent !== HR_AGENT) {
        return { handled: false };
    }

    const classified = classifyHrWorkIntent(params.question, params.phase3Agent);
    if (!classified || classified.tool === 'qa') {
        return { handled: false };
    }

    if (params.user.role !== 'superAdmin') {
        const check = await requireAllowedAgent(params.user, HR_AGENT);
        if (!check.ok) {
            return { handled: true, answer: check.message, tool: classified.tool };
        }
    }

    const tool = classified.tool;

    if (tool === 'report') {
        const r = await tryHrReportCommand({ ...params, phase3Agent: HR_AGENT });
        if (r.handled) return { ...r, tool };
    }
    if (tool === 'section_pdf') {
        const r = await tryHrSectionPdfCommand({ ...params, phase3Agent: HR_AGENT });
        if (r.handled) return { ...r, tool };
    }
    if (tool === 'rescore_cvs') {
        const r = await tryHrRescoreCvsCommand({ ...params, phase3Agent: HR_AGENT });
        if (r.handled) return { ...r, tool };
    }
    if (tool === 'shortlist') {
        const r = await tryHrShortlistExport({ ...params, phase3Agent: HR_AGENT });
        if (r.handled) return { ...r, tool };
    }
    if (tool === 'candidate_email') {
        const r = await tryHrCandidateEmailCommand({ ...params, phase3Agent: HR_AGENT, req: params.req });
        if (r.handled) return { ...r, tool };
    }
    if (tool === 'cv_table') {
        const r = await tryHrCvComparisonTable({ ...params, phase3Agent: HR_AGENT });
        if (r.handled) return { ...r, tool, visuals: [] };
    }
    if (tool === 'cv_overview') {
        const r = await tryHrCvOverviewCommand({ ...params, phase3Agent: HR_AGENT });
        if (r.handled) return { ...r, tool, visuals: [] };
    }
    if (tool === 'directory') {
        // Prefer analytics (table + optional charts) when available
        const analytics = await runAnalyticsTool(
            params.user,
            'directory',
            params.documentIds,
            params.question
        );
        if (analytics.answer && !/no employee records/i.test(analytics.answer)) {
            return analytics;
        }
        const r = await tryHrDirectoryCommand({ ...params, phase3Agent: HR_AGENT });
        if (r.handled) return { ...r, tool };
    }
    if (
        tool === 'joining_letter' ||
        tool === 'internship_letter' ||
        tool === 'training_certificate' ||
        tool === 'promotion_letter' ||
        tool === 'warning_letter' ||
        tool === 'relieving_letter'
    ) {
        const r = await tryHrExtraLetterCommand({ ...params, phase3Agent: HR_AGENT });
        if (r.handled) return { ...r, tool };
    }
    if (tool === 'offer_letter' || tool === 'experience_letter' || tool === 'list_candidates') {
        const r = await tryHrChatCommand({ ...params, phase3Agent: HR_AGENT });
        if (r.handled) return { ...r, tool };
        // Soft nudge if detector inside chat command missed
        if (tool === 'offer_letter') {
            return {
                handled: true,
                tool,
                answer: [
                    'I can draft an **offer letter** from a resume in scope.',
                    '',
                    'Example: `Generate offer letter for Ahmed Khan. Company Visibility Bots, title AI Engineer, salary PKR 80000 monthly, joining 2026-09-01`',
                ].join('\n'),
            };
        }
        if (tool === 'experience_letter') {
            return {
                handled: true,
                tool,
                answer: [
                    'I can draft an **experience letter** from a resume in scope.',
                    '',
                    'Example: `Generate experience letter for Sara Ali. Company Visibility Bots, title Software Engineer, from 2024-01-01 to 2026-08-01`',
                ].join('\n'),
            };
        }
    }

    if (ANALYTICS_TOOLS.has(tool)) {
        return runAnalyticsTool(params.user, tool, params.documentIds, params.question);
    }

    return { handled: false };
}
