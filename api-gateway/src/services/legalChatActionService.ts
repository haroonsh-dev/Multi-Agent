import { AuthUser } from './accessScope';
import {
    executeLegalAnalytics,
    loadLegalSnapshots,
    LEGAL_AGENT,
    LegalDocSnapshot,
} from './legalAnalyticsService';
import type { ChatVisualSpec } from '../types/chatVisuals';
import {
    extractDocumentNameTokens,
    matchDocumentIdsByNameTokens,
} from './financeAnalyticsService';
import { wantsAgentAnalyticsVisual, wantsAgentTextOnlyExplain } from './agentAnalyticsPolicy';
import {
    cleanAgentMarkdown,
    formatAgentDivider,
    formatAgentFooter,
    formatAgentHeading,
    formatDate,
    formatLabeledBullets,
    formatRiskLabel,
    formatSection,
    formatStatusLabel,
} from './agentResponseFormat';

export function wantsLegalChartQuestion(question: string): boolean {
    return wantsAgentAnalyticsVisual(question, LEGAL_AGENT);
}

export function detectLegalMissingDataAsk(question: string, phase3Agent?: string): boolean {
    if (phase3Agent && phase3Agent !== LEGAL_AGENT) return false;
    const q = question.toLowerCase().trim();
    if (/\b(missing data|data gaps?|what(?:'s| is) missing|all missing data|incomplete extraction)\b/.test(q)) {
        return true;
    }
    if (
        /\b(missing|gap|gaps|incomplete|not extracted|no extraction|empty field|blank field)\b/.test(q) &&
        /\b(data|field|fields|information|info|extraction|extracted|details?)\b/.test(q)
    ) {
        return true;
    }
    return /\ball missing\b/.test(q) && /\b(data|field|chart|show)\b/.test(q);
}

export function detectLegalDocumentExplain(question: string, phase3Agent?: string): boolean {
    if (phase3Agent && phase3Agent !== LEGAL_AGENT) return false;
    if (wantsLegalChartQuestion(question)) return false;
    if (detectLegalMissingDataAsk(question, phase3Agent)) return false;

    const q = question.toLowerCase().trim();
    return (
        /\b(explain|summarize|summary|describe|tell me about|what is|what are|what does|break down|overview of)\b/.test(
            q
        ) &&
        /\b(contract|agreement|nda|legal|clause|document|file|pdf)\b/.test(q)
    );
}

export function detectLegalDocumentQa(question: string, phase3Agent?: string): boolean {
    if (phase3Agent && phase3Agent !== LEGAL_AGENT) return false;
    const q = question.toLowerCase().trim();
    return (
        /\b(what\s+does\s+(this|the)\s+(document|file|pdf|contract|agreement)\s+say|summarize\s+(this|the)\s+(document|file|contract)|explain\s+(this|the)\s+(clause|section|term)|quote\s+from|who\s+is\s+(the\s+)?(party|vendor|client))\b/i.test(
            q
        ) || detectLegalDocumentExplain(question, phase3Agent)
    );
}

function formatLegalSnapshotExplain(snap: LegalDocSnapshot): string {
    const parties = snap.counterparties.length ? snap.counterparties.join(', ') : 'Not specified in extraction';
    const effDate = formatDate(snap.effectiveDate);
    const expDate = snap.expiryDate ? formatDate(snap.expiryDate) : 'Not specified / open-ended';
    const riskBadge = formatRiskLabel(snap.riskLevel);

    let md = `${formatAgentHeading(snap.filename, 3)}\n\n`;
    md += `This **${formatStatusLabel(snap.classification)}** is **${formatStatusLabel(snap.contractStatus)}** with a **${riskBadge.toLowerCase()}** risk rating based on extracted fields.\n\n`;

    md += formatLabeledBullets([
        { label: 'Parties', value: parties },
        {
            label: 'Key dates',
            value:
                snap.daysUntilExpiry != null && snap.contractStatus !== 'EXPIRED'
                    ? `Effective ${effDate}; expiry ${expDate} (${snap.daysUntilExpiry} day(s) remaining)`
                    : `Effective ${effDate}; expiry ${expDate}`,
        },
        { label: 'Governing law', value: snap.governingLaw },
        { label: 'Liability cap', value: snap.liabilityCap },
        { label: 'Indemnification', value: snap.indemnification },
        {
            label: 'Termination notice',
            value:
                snap.terminationNoticeDays != null
                    ? `${snap.terminationNoticeDays} days`
                    : 'Not specified',
        },
    ]);

    if (snap.keyRisks.length) {
        md += `\n\n${formatSection('Notable risk factors', snap.keyRisks.map((r) => `- ${r}`).join('\n'))}`;
    }

    md += formatAgentFooter(
        'Ask for clause details, obligations, or a risk audit for a deeper review.'
    );
    return cleanAgentMarkdown(md);
}

export async function tryLegalDocumentExplainCommand(opts: {
    user: AuthUser;
    question: string;
    phase3Agent?: string;
    documentIds?: string[];
}): Promise<LegalActionHandlerResult> {
    if (!detectLegalDocumentExplain(opts.question, opts.phase3Agent)) {
        return { handled: false };
    }

    const snapshots = await loadLegalSnapshots(opts.user, { documentIds: opts.documentIds });
    if (!snapshots.length) {
        return {
            handled: true,
            answer:
                'No legal contracts or agreements found in your scope. Select legal documents in Document scope, then ask again.',
            citations: [],
        };
    }

    const nameTokens = extractDocumentNameTokens(opts.question);
    let targets = snapshots;
    if (nameTokens.length) {
        const matchedIds = matchDocumentIdsByNameTokens(
            snapshots.map((s) => ({
                documentId: s.documentId,
                originalFilename: s.filename,
            })),
            opts.question
        );
        if (matchedIds.length) {
            const idSet = new Set(matchedIds);
            targets = snapshots.filter((s) => idSet.has(s.documentId));
        }
    }

    if (targets.length > 1 && nameTokens.length === 0) {
        return {
            handled: true,
            answer:
                `You have **${targets.length}** legal documents in scope. Name the agreement (e.g. “explain Master Legal Agency”) or narrow Document scope to one file.`,
            citations: targets.map((s) => ({
                documentId: s.documentId,
                filename: s.filename,
                documentType: s.classification,
                phase3Agent: LEGAL_AGENT,
            })),
        };
    }

    if (targets.length > 1) {
        targets = [targets[0]];
    }

    const snap = targets[0];
    return {
        handled: true,
        answer: cleanAgentMarkdown(
            [
                formatAgentHeading('Legal overview', 2),
                '',
                'Here is an overview of the agreement in your scope:',
                formatAgentDivider(),
                formatLegalSnapshotExplain(snap),
            ].join('\n\n')
        ),
        citations: [
            {
                documentId: snap.documentId,
                filename: snap.filename,
                documentType: snap.classification,
                phase3Agent: LEGAL_AGENT,
            },
        ],
    };
}

export type LegalActionHandlerResult = {
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
};

export function detectLegalRiskAudit(question: string, phase3Agent?: string): boolean {
    if (phase3Agent && phase3Agent !== LEGAL_AGENT) return false;
    const q = question.toLowerCase().trim();
    return (
        q.includes('risk audit') ||
        q.includes('audit risk') ||
        q.includes('risk matrix') ||
        q.includes('legal risk report') ||
        q.includes('audit contract') ||
        q.includes('contract audit') ||
        q.includes('audit legal') ||
        q === 'risk' ||
        q === 'audit'
    );
}

export function detectLegalExpiryAsk(question: string, phase3Agent?: string): boolean {
    if (phase3Agent && phase3Agent !== LEGAL_AGENT) return false;
    const q = question.toLowerCase().trim();
    return (
        q.includes('expiring contracts') ||
        q.includes('expiration schedule') ||
        q.includes('contracts due to expire') ||
        q.includes('show expiring') ||
        q.includes('renewal schedule') ||
        q.includes('renewal timeline') ||
        q === 'expiring' ||
        q === 'expiries'
    );
}

export function detectLegalObligationsAsk(question: string, phase3Agent?: string): boolean {
    if (phase3Agent && phase3Agent !== LEGAL_AGENT) return false;
    const q = question.toLowerCase().trim();
    return (
        q.includes('obligations matrix') ||
        q.includes('party obligations') ||
        q.includes('obligation matrix') ||
        q.includes('show obligations') ||
        q === 'obligations'
    );
}

export function detectLegalReportCommand(question: string, phase3Agent?: string): boolean {
    if (phase3Agent && phase3Agent !== LEGAL_AGENT) return false;
    const q = question.toLowerCase().trim();
    return (
        q.includes('legal report') ||
        q.includes('contract report') ||
        q.includes('legal pack') ||
        q.includes('contract summary pack') ||
        q.includes('generate legal') ||
        q.includes('generate contract report') ||
        q.includes('full report') ||
        q.includes('fully report') ||
        q.includes('executive summary pack') ||
        q === 'report' ||
        q === 'i say report' ||
        q === 'analyze it' ||
        q === 'analyze this'
    );
}

export async function tryLegalRiskAuditCommand(opts: {
    user: AuthUser;
    question: string;
    phase3Agent?: string;
    documentIds?: string[];
}): Promise<LegalActionHandlerResult> {
    if (!detectLegalRiskAudit(opts.question, opts.phase3Agent)) {
        return { handled: false };
    }

    const analytics = await executeLegalAnalytics(opts.user, { documentIds: opts.documentIds });
    if (!analytics.snapshots.length) {
        return {
            handled: true,
            answer: 'No legal documents or contracts found in your library to audit.',
            citations: [],
            visuals: [],
        };
    }

    let markdown = `${formatAgentHeading('Legal risk audit', 2)}\n\n`;
    markdown += `Audited **${analytics.totalContracts}** legal document(s):\n\n`;
    markdown += `- **Active contracts:** ${analytics.activeCount}\n`;
    markdown += `- **Expiring soon:** ${analytics.expiringSoonCount}\n`;
    markdown += `- **Expired contracts:** ${analytics.expiredCount}\n`;
    markdown += `- **High risk flagged:** ${analytics.highRiskCount}\n\n`;

    markdown += `**Contract risk register**\n\n`;
    markdown += `| Contract | Type | Expiry | Status | Risk | Risk factors |\n`;
    markdown += `| --- | --- | --- | --- | --- | --- |\n`;

    for (const snap of analytics.snapshots) {
        const expStr = formatDate(snap.expiryDate);
        const riskBadge = formatRiskLabel(snap.riskLevel);
        markdown += `| **${snap.filename}** | ${formatStatusLabel(snap.classification)} | ${expStr} | ${formatStatusLabel(snap.contractStatus)} | ${riskBadge} | ${snap.keyRisks.join(', ') || '—'} |\n`;
    }

    markdown += `\n_High risk flags may indicate missing liability limits, expired status, or tight termination notice windows._\n`;

    return {
        handled: true,
        answer: markdown,
        citations: analytics.citations,
        visuals: analytics.visuals,
    };
}

export async function tryLegalExpiryAlertCommand(opts: {
    user: AuthUser;
    question: string;
    phase3Agent?: string;
    documentIds?: string[];
}): Promise<LegalActionHandlerResult> {
    if (!detectLegalExpiryAsk(opts.question, opts.phase3Agent)) {
        return { handled: false };
    }

    const snapshots = await loadLegalSnapshots(opts.user, { documentIds: opts.documentIds });
    if (!snapshots.length) {
        return {
            handled: true,
            answer: 'No legal documents or contracts found to analyze expiry timelines.',
            citations: [],
        };
    }

    const expired = snapshots.filter((s) => s.contractStatus === 'EXPIRED');
    const expiringSoon = snapshots.filter((s) => s.contractStatus === 'EXPIRING_SOON');
    const active = snapshots.filter((s) => s.contractStatus === 'ACTIVE');

    let markdown = `${formatAgentHeading('Contract expiry schedule', 2)}\n\n`;
    markdown += `Reviewed **${snapshots.length}** legal agreement(s):\n\n`;

    if (expired.length) {
        markdown += `**Expired contracts (${expired.length})**\n\n`;
        for (const s of expired) {
            markdown += `- **${s.filename}** — expired on ${formatDate(s.expiryDate)}\n`;
        }
        markdown += `\n`;
    }

    if (expiringSoon.length) {
        markdown += `**Expiring soon — within 60 days (${expiringSoon.length})**\n\n`;
        for (const s of expiringSoon) {
            markdown += `- **${s.filename}** — ${s.daysUntilExpiry} day(s) remaining, expires ${formatDate(s.expiryDate)} · notice period ${s.terminationNoticeDays || 30} days\n`;
        }
        markdown += `\n`;
    }

    if (active.length) {
        markdown += `**Active contracts (${active.length})**\n\n`;
        for (const s of active) {
            const dateStr = s.expiryDate ? formatDate(s.expiryDate) : 'No fixed end date';
            markdown += `- **${s.filename}** — valid until ${dateStr}\n`;
        }
        markdown += `\n`;
    }

    const citations = snapshots.map((s) => ({
        documentId: s.documentId,
        filename: s.filename,
        documentType: s.classification,
        phase3Agent: LEGAL_AGENT,
    }));

    return {
        handled: true,
        answer: markdown,
        citations,
    };
}

export async function tryLegalObligationMatrixCommand(opts: {
    user: AuthUser;
    question: string;
    phase3Agent?: string;
    documentIds?: string[];
}): Promise<LegalActionHandlerResult> {
    if (!detectLegalObligationsAsk(opts.question, opts.phase3Agent)) {
        return { handled: false };
    }

    const snapshots = await loadLegalSnapshots(opts.user, { documentIds: opts.documentIds });
    if (!snapshots.length) {
        return {
            handled: true,
            answer: 'No legal agreements found to extract obligations.',
            citations: [],
        };
    }

    let markdown = `${formatAgentHeading('Contract obligations matrix', 2)}\n\n`;
    markdown += `| Document | Counterparties | Governing law | Liability cap | Indemnification | Termination notice |\n`;
    markdown += `| --- | --- | --- | --- | --- | --- |\n`;

    for (const s of snapshots) {
        const parties = s.counterparties.length ? s.counterparties.join(', ') : 'Not Extracted';
        const notice = s.terminationNoticeDays ? `${s.terminationNoticeDays} days` : 'Standard';
        markdown += `| **${s.filename}** | ${parties} | ${s.governingLaw} | ${s.liabilityCap} | ${s.indemnification} | ${notice} |\n`;
    }

    const citations = snapshots.map((s) => ({
        documentId: s.documentId,
        filename: s.filename,
        documentType: s.classification,
        phase3Agent: LEGAL_AGENT,
    }));

    return {
        handled: true,
        answer: markdown,
        citations,
    };
}

export async function tryLegalReportCommand(opts: {
    user: AuthUser;
    question: string;
    phase3Agent?: string;
    documentIds?: string[];
}): Promise<LegalActionHandlerResult> {
    if (!detectLegalReportCommand(opts.question, opts.phase3Agent)) {
        return { handled: false };
    }

    const snapshots = await loadLegalSnapshots(opts.user, { documentIds: opts.documentIds });
    if (!snapshots.length) {
        return {
            handled: true,
            answer: 'No legal agreements or contract documents found in scope to generate a report.',
            citations: [],
        };
    }

    let markdown = `${formatAgentHeading('Legal document report', 2)}\n\n`;
    markdown += `Analyzed **${snapshots.length}** legal document(s) in scope:\n\n`;

    for (const snap of snapshots) {
        markdown += `${formatLegalSnapshotExplain(snap)}\n\n${formatAgentDivider()}\n\n`;
    }

    markdown = markdown.replace(new RegExp(`${formatAgentDivider()}\\s*$`), '').trim();
    markdown += `\n\n_Review risk drivers and notice periods before renewal or modification._\n`;

    const citations = snapshots.map((s) => ({
        documentId: s.documentId,
        filename: s.filename,
        documentType: s.classification,
        phase3Agent: LEGAL_AGENT,
    }));

    return {
        handled: true,
        answer: markdown,
        citations,
    };
}
