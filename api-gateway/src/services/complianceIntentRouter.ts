/**
 * Dynamic Compliance work router — classify natural compliance asks → tools.
 */
import { AuthUser } from './accessScope';
import { requireAllowedAgent } from './planService';
import type { ChatVisualSpec } from '../types/chatVisuals';
import {
    COMPLIANCE_AGENT,
} from './complianceAnalyticsService';
import {
    detectComplianceVisualIntent,
    executeComplianceAnalytics,
    type ComplianceVisualIntent,
} from './complianceChatVisualService';
import {
    detectComplianceReportCommand,
    detectComplianceSectionPdf,
    detectComplianceLetter,
    detectComplianceExpiryAsk,
    detectComplianceMissingDocsAsk,
    detectComplianceAuditEvidencePack,
    detectComplianceDeptGapAnalysis,
    tryComplianceReportCommand,
    tryComplianceSectionPdfCommand,
    tryComplianceLetterCommand,
    tryComplianceExpiryAlertCommand,
    tryComplianceMissingDocsCommand,
    tryComplianceAuditEvidencePackCommand,
    tryComplianceDeptGapAnalysisCommand,
    tryComplianceDocumentExplainCommand,
} from './complianceChatActionService';
import { applyAgentVisualPolicy, wantsAgentAnalyticsVisual, wantsAgentTextOnlyExplain } from './agentAnalyticsPolicy';

export type ComplianceWorkTool =
    | 'report'
    | 'section_pdf'
    | 'expiry'
    | 'findings'
    | 'cert_status'
    | 'status_mix'
    | 'overview'
    | 'missing_docs'
    | 'audit_evidence_pack'
    | 'dept_gap'
    | 'ncr_letter'
    | 'capa_letter'
    | 'certificate_of_compliance'
    | 'document_explain'
    | 'qa';

export type ComplianceWorkClassification = {
    tool: ComplianceWorkTool;
    confidence: number;
    reason: string;
};

export type ComplianceDynamicResult = {
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
    tool?: ComplianceWorkTool;
};

const ANALYTICS_TOOLS = new Set<ComplianceWorkTool>([
    'expiry',
    'findings',
    'cert_status',
    'status_mix',
    'overview',
]);

export function classifyComplianceWorkIntent(
    question: string,
    phase3Agent?: string
): ComplianceWorkClassification | null {
    const q = question.toLowerCase().trim();
    if (!q) return null;

    const onCompliance =
        phase3Agent === COMPLIANCE_AGENT ||
        /\bcompliance\s+agent\b/i.test(question) ||
        /\b(compliance|audit|certificate|iso|sop|inspection)\b/i.test(q);

    if (
        /\b(what\s+does\s+(this|the)\s+(document|file|pdf)\s+say|summarize\s+(this|the)\s+(document|file)|explain\s+(this|the)\s+(clause|section)|quote\s+from)\b/i.test(
            q
        )
    ) {
        return { tool: 'qa', confidence: 0.9, reason: 'document_qa' };
    }

    if (wantsAgentTextOnlyExplain(question, onCompliance ? COMPLIANCE_AGENT : phase3Agent)) {
        return { tool: 'document_explain', confidence: 0.88, reason: 'text_explain' };
    }

    const letter = detectComplianceLetter(question, onCompliance ? COMPLIANCE_AGENT : phase3Agent);
    if (letter === 'ncr') {
        return { tool: 'ncr_letter', confidence: 0.95, reason: 'ncr_letter' };
    }
    if (letter === 'capa') {
        return { tool: 'capa_letter', confidence: 0.95, reason: 'capa_letter' };
    }
    if (letter === 'certificate_of_compliance') {
        return {
            tool: 'certificate_of_compliance',
            confidence: 0.95,
            reason: 'certificate_of_compliance',
        };
    }

    if (detectComplianceAuditEvidencePack(question, onCompliance ? COMPLIANCE_AGENT : phase3Agent)) {
        return { tool: 'audit_evidence_pack', confidence: 0.95, reason: 'audit_evidence_pack' };
    }
    if (detectComplianceDeptGapAnalysis(question, onCompliance ? COMPLIANCE_AGENT : phase3Agent)) {
        return { tool: 'dept_gap', confidence: 0.95, reason: 'dept_gap' };
    }
    if (detectComplianceReportCommand(question, onCompliance ? COMPLIANCE_AGENT : phase3Agent)) {
        return { tool: 'report', confidence: 0.95, reason: 'compliance_report' };
    }
    if (detectComplianceSectionPdf(question, onCompliance ? COMPLIANCE_AGENT : phase3Agent)) {
        return { tool: 'section_pdf', confidence: 0.9, reason: 'section_pdf' };
    }
    if (detectComplianceMissingDocsAsk(question, onCompliance ? COMPLIANCE_AGENT : phase3Agent)) {
        return { tool: 'missing_docs', confidence: 0.9, reason: 'missing_docs' };
    }
    if (detectComplianceExpiryAsk(question, onCompliance ? COMPLIANCE_AGENT : phase3Agent)) {
        return { tool: 'expiry', confidence: 0.9, reason: 'expiry_alert' };
    }

    const viz = detectComplianceVisualIntent(question, onCompliance ? COMPLIANCE_AGENT : phase3Agent);
    if (viz && ANALYTICS_TOOLS.has(viz as ComplianceWorkTool) && wantsAgentAnalyticsVisual(question, COMPLIANCE_AGENT)) {
        return { tool: viz as ComplianceWorkTool, confidence: 0.85, reason: `analytics:${viz}` };
    }

    if (onCompliance) {
        if (/\b(finding|findings|severity|ncr|non[- ]?conformance)\b/.test(q)) {
            if (wantsAgentAnalyticsVisual(question, COMPLIANCE_AGENT)) {
                return { tool: 'findings', confidence: 0.8, reason: 'soft_findings' };
            }
        }
        if (/\b(expir|renewal|validity)\b/.test(q)) {
            if (wantsAgentAnalyticsVisual(question, COMPLIANCE_AGENT)) {
                return { tool: 'expiry', confidence: 0.8, reason: 'soft_expiry' };
            }
            return { tool: 'qa', confidence: 0.75, reason: 'expiry_text' };
        }
        if (/\b(certificate|cert\s+status|valid|expired)\b/.test(q)) {
            if (wantsAgentAnalyticsVisual(question, COMPLIANCE_AGENT)) {
                return { tool: 'cert_status', confidence: 0.75, reason: 'soft_certs' };
            }
        }
        if (/\b(status|pass|fail|compliant)\b/.test(q)) {
            if (wantsAgentAnalyticsVisual(question, COMPLIANCE_AGENT)) {
                return { tool: 'status_mix', confidence: 0.75, reason: 'soft_status' };
            }
        }
        if (/\b(overview|dashboard|summary|what can you do)\b/.test(q)) {
            if (wantsAgentAnalyticsVisual(question, COMPLIANCE_AGENT)) {
                return { tool: 'overview', confidence: 0.7, reason: 'soft_overview' };
            }
            return { tool: 'qa', confidence: 0.65, reason: 'overview_text' };
        }
    }

    if (!onCompliance) return null;

    if (
        wantsAgentAnalyticsVisual(question, COMPLIANCE_AGENT) &&
        /\b(compliance|audit|certificate|sop|inspection|iso|finding|regulatory)\b/.test(q)
    ) {
        return { tool: 'overview', confidence: 0.55, reason: 'compliance_fallback_overview' };
    }

    return { tool: 'qa', confidence: 0.4, reason: 'fallthrough_qa' };
}

async function runAnalyticsTool(
    user: AuthUser,
    tool: ComplianceWorkTool,
    documentIds?: string[],
    question?: string
): Promise<ComplianceDynamicResult> {
    const intent = (tool === 'overview' ? 'overview' : tool) as ComplianceVisualIntent;
    const result = await executeComplianceAnalytics(user, intent, {
        documentIds: documentIds?.length ? documentIds : undefined,
    });
    return applyAgentVisualPolicy(
        {
            handled: true,
            tool,
            answer: result.answer,
            citations: result.citations,
            visuals: result.visuals,
        },
        question || '',
        COMPLIANCE_AGENT
    );
}

/**
 * Single entry for Compliance Agent chat — routes natural work to the right skill/tool.
 */
export async function tryComplianceDynamicAgent(params: {
    user: AuthUser;
    question: string;
    phase3Agent?: string;
    documentIds?: string[];
}): Promise<ComplianceDynamicResult> {
    if (params.phase3Agent && params.phase3Agent !== COMPLIANCE_AGENT) {
        return { handled: false };
    }

    const classified = classifyComplianceWorkIntent(params.question, params.phase3Agent);

    if (!classified || classified.tool === 'qa') {
        return { handled: false };
    }

    if (params.user.role !== 'superAdmin') {
        const check = await requireAllowedAgent(params.user, COMPLIANCE_AGENT);
        if (!check.ok) {
            return { handled: true, answer: check.message, tool: classified.tool };
        }
    }

    const tool = classified.tool;

    if (tool === 'document_explain') {
        const r = await tryComplianceDocumentExplainCommand({ ...params, phase3Agent: COMPLIANCE_AGENT });
        if (r.handled) return { ...r, tool, visuals: [] };
    }
    if (tool === 'report') {
        const r = await tryComplianceReportCommand({ ...params, phase3Agent: COMPLIANCE_AGENT });
        if (r.handled) return { ...r, tool };
    }
    if (tool === 'section_pdf') {
        const r = await tryComplianceSectionPdfCommand({
            ...params,
            phase3Agent: COMPLIANCE_AGENT,
        });
        if (r.handled) return { ...r, tool };
    }
    if (tool === 'ncr_letter' || tool === 'capa_letter' || tool === 'certificate_of_compliance') {
        const r = await tryComplianceLetterCommand({ ...params, phase3Agent: COMPLIANCE_AGENT });
        if (r.handled) return { ...r, tool };
    }
    if (tool === 'audit_evidence_pack') {
        const r = await tryComplianceAuditEvidencePackCommand({
            ...params,
            phase3Agent: COMPLIANCE_AGENT,
        });
        if (r.handled) return { ...r, tool };
    }
    if (tool === 'dept_gap') {
        const r = await tryComplianceDeptGapAnalysisCommand({
            ...params,
            phase3Agent: COMPLIANCE_AGENT,
        });
        if (r.handled) return { ...r, tool };
    }
    if (tool === 'missing_docs') {
        const r = await tryComplianceMissingDocsCommand({
            ...params,
            phase3Agent: COMPLIANCE_AGENT,
        });
        if (r.handled) return { ...r, tool };
    }
    if (tool === 'expiry' && classified.reason === 'expiry_alert') {
        const r = await tryComplianceExpiryAlertCommand({
            ...params,
            phase3Agent: COMPLIANCE_AGENT,
        });
        if (r.handled) return { ...r, tool };
        // fall through to chart analytics if text alert somehow missed
    }

    if (ANALYTICS_TOOLS.has(tool)) {
        // Prefer textual expiry alert when soft-expiry without chart keywords
        if (tool === 'expiry' && detectComplianceExpiryAsk(params.question, COMPLIANCE_AGENT)) {
            const r = await tryComplianceExpiryAlertCommand({
                ...params,
                phase3Agent: COMPLIANCE_AGENT,
            });
            if (r.handled) return { ...r, tool };
        }
        return runAnalyticsTool(params.user, tool, params.documentIds, params.question);
    }

    return { handled: false };
}
