import { AuthUser } from './accessScope';
import { requireAllowedAgent } from './planService';
import type { AgentChatVisualResult, ComplianceAnalyticsCoverage } from '../types/chatVisuals';
import { wantsVisualization } from './financeChatVisualService';
import { applyAgentVisualPolicy, wantsAgentAnalyticsVisual, wantsAgentTextOnlyExplain } from './agentAnalyticsPolicy';
import {
    COMPLIANCE_AGENT,
    buildCertStatusVisual,
    buildComplianceRegisterVisual,
    buildComplianceStatusVisual,
    buildExpiryTimelineVisual,
    buildFindingsSeverityVisual,
    buildComplianceFileCoverage,
    computeComplianceCoverage,
    loadComplianceDocsForAnalytics,
    loadComplianceSnapshots,
    type LoadComplianceOptions,
} from './complianceAnalyticsService';

export type ComplianceVisualIntent = 'overview' | 'expiry' | 'findings' | 'cert_status' | 'status_mix';

function hasComplianceContext(question: string, phase3Agent?: string): boolean {
    if (phase3Agent === COMPLIANCE_AGENT) return true;
    return /\b(compliance|audit|certificate|certificates|iso|sop|inspection|expir|finding|non[- ]?conformance|regulatory)\b/i.test(
        question
    );
}

export function detectComplianceVisualIntent(
    question: string,
    phase3Agent?: string,
    options?: { hasScopedComplianceDocuments?: boolean }
): ComplianceVisualIntent | null {
    const q = question.toLowerCase();
    const scoped = Boolean(options?.hasScopedComplianceDocuments);
    const onCompliance = phase3Agent === COMPLIANCE_AGENT;
    const inContext = hasComplianceContext(question, phase3Agent) || scoped;

    if (!inContext && !wantsVisualization(question)) return null;
    if (!inContext && wantsVisualization(question)) {
        if (phase3Agent && phase3Agent !== COMPLIANCE_AGENT && !scoped) return null;
    }

    // Soft mode on Compliance Agent — natural language without "chart"
    if (onCompliance || scoped) {
        if (/\b(expir|expiry|renewal|validity|days until)\b/.test(q)) return 'expiry';
        if (/\b(finding|findings|severity|non[- ]?conformance|ncr|major|minor|critical)\b/.test(q)) {
            return 'findings';
        }
        if (/\b(certificate|cert status|valid|expired)\b/.test(q)) return 'cert_status';
        if (/\b(pass|fail|compliance status|overall|compliant)\b/.test(q)) return 'status_mix';
        if (/\b(overview|dashboard|summary|what can you do|start)\b/.test(q)) return 'overview';
    }

    if (/\b(expir|expiry|renewal|validity|days until)\b/.test(q)) return 'expiry';
    if (/\b(finding|findings|severity|non[- ]?conformance|ncr|major|minor|critical)\b/.test(q)) {
        return 'findings';
    }
    if (/\b(certificate|cert status|valid|expired)\b/.test(q) && wantsVisualization(question)) {
        return 'cert_status';
    }
    if (wantsVisualization(question) && inContext) return 'overview';
    if (/\b(pass|fail|compliance status|overall)\b/.test(q)) return 'status_mix';
    return null;
}

export async function executeComplianceAnalytics(
    user: AuthUser,
    intent: ComplianceVisualIntent,
    loadOpts: LoadComplianceOptions = {}
): Promise<{
    visuals: import('../types/chatVisuals').ChatVisualSpec[];
    citations: AgentChatVisualResult['citations'];
    answer: string;
    documentCount: number;
    coverage?: ComplianceAnalyticsCoverage;
}> {
    const docs = await loadComplianceDocsForAnalytics(user, loadOpts);
    const snapshots = await loadComplianceSnapshots(user, loadOpts);
    const scopedNote = loadOpts.documentIds?.length
        ? ` (scoped to **${loadOpts.documentIds.length}** file(s))`
        : '';

    const citations = docs.slice(0, 10).map((d) => ({
        documentId: d.documentId,
        filename: d.originalFilename,
        documentType: d.classification || 'compliance',
        phase3Agent: COMPLIANCE_AGENT,
    }));

    const fileReport = await buildComplianceFileCoverage(user, snapshots, loadOpts);
    const coverage = {
        ...computeComplianceCoverage(snapshots, docs.length),
        files: fileReport,
    };

    if (!docs.length) {
        return {
            visuals: [],
            citations: [],
            documentCount: 0,
            coverage,
            answer:
                'No ready **compliance** documents in scope. Upload audits, certificates, or SOPs, wait until status is **ready**, then select them in chat scope.',
        };
    }

    const visuals = [];
    if (intent === 'expiry' || intent === 'cert_status' || intent === 'overview') {
        visuals.push(buildCertStatusVisual(snapshots));
        const expiry = buildExpiryTimelineVisual(snapshots);
        if (expiry.data.length) visuals.push(expiry);
        const register = buildComplianceRegisterVisual(snapshots);
        if (register.data.length) visuals.push(register);
    }
    if (intent === 'findings' || intent === 'overview') {
        const findings = buildFindingsSeverityVisual(snapshots);
        if (findings.data.length) visuals.push(findings);
    }
    if (intent === 'status_mix' || intent === 'overview') {
        visuals.push(buildComplianceStatusVisual(snapshots));
    }

    const uniqueVisuals = visuals.filter((v, i, arr) => arr.findIndex((x) => x.title === v.title) === i);

    const expiring = snapshots.filter((s) => s.certStatus === 'EXPIRING_SOON' || s.certStatus === 'EXPIRED');
    const findingCount = snapshots.reduce((n, s) => n + s.findings.length, 0);

    const answerParts = [
        `**Compliance analytics** — **${docs.length}** document(s)${scopedNote}.`,
        '',
        `- **Certificates with expiry/status:** ${coverage.documentsWithExpiry}`,
        `- **Documents with findings:** ${coverage.documentsWithFindings} (**${findingCount}** finding rows)`,
    ];

    if (expiring.length) {
        answerParts.push('', '**Attention — expiring or expired:**');
        for (const s of expiring.slice(0, 8)) {
            const days =
                s.daysUntilExpiry != null
                    ? s.daysUntilExpiry < 0
                        ? `${Math.abs(s.daysUntilExpiry)}d ago`
                        : `${s.daysUntilExpiry}d left`
                    : '—';
            answerParts.push(`- **${s.filename}** — ${s.certStatus.replace(/_/g, ' ')} (${days})`);
        }
    }

    if (findingCount > 0) {
        answerParts.push('', 'See **findings by severity** in the analytics panel.');
    }

    if (!uniqueVisuals.length || (!coverage.documentsWithExpiry && !coverage.documentsWithFindings)) {
        answerParts.push(
            '',
            'Limited structured fields in scope. Reprocess documents with **Compliance Agent** so `expiry_date`, `audit_findings`, or `status` are extracted.'
        );
    } else {
        answerParts.push('', 'Charts use document extractions only (not LLM estimates).');
        if (docs.length === 1) {
            answerParts.push(`Scoped to **${docs[0].originalFilename || 'this file'}** only.`);
        }
    }

    return {
        visuals: uniqueVisuals,
        citations,
        documentCount: docs.length,
        coverage,
        answer: answerParts.join('\n'),
    };
}

export async function tryComplianceChatVisual(params: {
    user: AuthUser;
    question: string;
    phase3Agent?: string;
    documentIds?: string[];
}): Promise<AgentChatVisualResult> {
    if (params.phase3Agent && params.phase3Agent !== COMPLIANCE_AGENT) {
        return { handled: false };
    }

    if (wantsAgentTextOnlyExplain(params.question, params.phase3Agent || COMPLIANCE_AGENT)) {
        return { handled: false };
    }
    if (!wantsAgentAnalyticsVisual(params.question, params.phase3Agent || COMPLIANCE_AGENT)) {
        return { handled: false };
    }

    let resolvedIds = params.documentIds?.length ? params.documentIds : undefined;

    if (!resolvedIds?.length && params.phase3Agent === COMPLIANCE_AGENT && wantsVisualization(params.question)) {
        const docs = await loadComplianceDocsForAnalytics(params.user, { maxDocs: 25 });
        if (docs.length) resolvedIds = docs.map((d) => d.documentId);
    }

    let scopedCount = 0;
    if (resolvedIds?.length) {
        const scoped = await loadComplianceDocsForAnalytics(params.user, { documentIds: resolvedIds });
        scopedCount = scoped.length;
        if (!scopedCount) resolvedIds = undefined;
    }

    const intent = detectComplianceVisualIntent(params.question, params.phase3Agent, {
        hasScopedComplianceDocuments: scopedCount > 0,
    });
    if (!intent) return { handled: false };

    if (params.user.role !== 'superAdmin') {
        const check = await requireAllowedAgent(params.user, COMPLIANCE_AGENT);
        if (!check.ok) {
            return { handled: true, answer: check.message, agentId: COMPLIANCE_AGENT };
        }
    }

    const result = await executeComplianceAnalytics(params.user, intent, {
        documentIds: resolvedIds,
    });

    return applyAgentVisualPolicy(
        {
            handled: true,
            agentId: COMPLIANCE_AGENT,
            visuals: result.visuals,
            citations: result.citations,
            answer: result.answer,
        },
        params.question,
        COMPLIANCE_AGENT
    );
}
