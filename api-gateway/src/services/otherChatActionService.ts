import Document from '../models/Document';
import { AuthUser } from './accessScope';
import {
    executeOtherAnalytics,
    loadOtherSnapshots,
    OTHER_AGENT,
    OtherDocSnapshot,
} from './otherAnalyticsService';
import type { ChatVisualSpec } from '../types/chatVisuals';
import {
    extractDocumentNameTokens,
    matchDocumentIdsByNameTokens,
} from './financeAnalyticsService';
import { getDocumentExtractions, resolveDocumentAiOrgId } from './aiServiceClient';
import { wantsAgentAnalyticsVisual, wantsAgentTextOnlyExplain } from './agentAnalyticsPolicy';
import {
    cleanAgentMarkdown,
    formatAgentDivider,
    formatAgentFooter,
    formatAgentHeading,
    formatAgentIntro,
    formatDate,
    formatLabeledBullets,
    formatSection,
    formatStatusLabel,
} from './agentResponseFormat';

export type OtherActionHandlerResult = {
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

function formatBytes(bytes: number): string {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

export function detectOtherDocumentExplain(question: string, phase3Agent?: string): boolean {
    if (phase3Agent && phase3Agent !== OTHER_AGENT) return false;
    if (wantsAgentAnalyticsVisual(question, OTHER_AGENT)) return false;
    return wantsAgentTextOnlyExplain(question, OTHER_AGENT);
}

export function detectOtherSummarize(question: string, phase3Agent?: string): boolean {
    if (phase3Agent && phase3Agent !== OTHER_AGENT) return false;
    if (wantsAgentTextOnlyExplain(question, OTHER_AGENT)) return false;
    const q = question.toLowerCase();
    return (
        q.includes('executive summary') ||
        q.includes('key takeaways') ||
        (q.includes('summarize') && /\b(document|file|pdf)\b/.test(q))
    );
}

export function detectOtherMetadata(question: string, phase3Agent?: string): boolean {
    if (phase3Agent && phase3Agent !== OTHER_AGENT) return false;
    if (wantsAgentTextOnlyExplain(question, OTHER_AGENT)) return false;
    const q = question.toLowerCase();
    return (
        q.includes('metadata') ||
        q.includes('file specs') ||
        q.includes('technical details') ||
        q.includes('file info') ||
        q.includes('document details')
    );
}

export function detectOtherCompare(question: string, phase3Agent?: string): boolean {
    if (phase3Agent && phase3Agent !== OTHER_AGENT) return false;
    if (wantsAgentTextOnlyExplain(question, OTHER_AGENT)) return false;
    const q = question.toLowerCase();
    return (
        q.includes('compare') ||
        q.includes('difference between') ||
        q.includes('diff files') ||
        q.includes('file comparison')
    );
}

async function loadExtractedSummary(
    user: AuthUser,
    documentId: string
): Promise<string> {
    const doc = await Document.findOne({ documentId }).lean();
    if (!doc?.pythonDocumentId) return '';
    const orgId = resolveDocumentAiOrgId(doc, user);
    let extractions = await getDocumentExtractions(doc.pythonDocumentId, orgId);
    if (!extractions?.length) extractions = await getDocumentExtractions(doc.pythonDocumentId, '');
    for (const ext of extractions || []) {
        const data = (ext.extracted_data || {}) as Record<string, unknown>;
        for (const key of ['summary', 'evaluation_summary', 'document_summary', 'abstract']) {
            if (typeof data[key] === 'string' && data[key].trim()) {
                return String(data[key]).trim();
            }
        }
    }
    return '';
}

function formatOtherSnapshotExplain(snap: OtherDocSnapshot, extractedSummary?: string): string {
    const meta = formatLabeledBullets([
        { label: 'File', value: snap.filename },
        { label: 'Type', value: formatStatusLabel(snap.classification) },
        { label: 'Pages', value: `${snap.pageCount}` },
        { label: 'Size', value: formatBytes(snap.sizeBytes) },
        { label: 'Format', value: snap.mimeType },
        { label: 'Uploaded', value: formatDate(snap.createdAt) },
        { label: 'Status', value: formatStatusLabel(snap.status) },
    ]);

    let md = `${formatAgentHeading(snap.filename, 3)}\n\n${meta}`;
    if (extractedSummary) {
        md += `\n\n${formatSection('Summary', extractedSummary)}`;
    }
    return md;
}

export async function tryOtherDocumentExplainCommand(opts: {
    user: AuthUser;
    question: string;
    phase3Agent?: string;
    documentIds?: string[];
}): Promise<OtherActionHandlerResult> {
    if (!detectOtherDocumentExplain(opts.question, opts.phase3Agent)) {
        return { handled: false };
    }

    const snapshots = await loadOtherSnapshots(opts.user, { documentIds: opts.documentIds });
    if (!snapshots.length) {
        return { handled: false };
    }

    let targets = snapshots;
    const nameTokens = extractDocumentNameTokens(opts.question);
    if (nameTokens.length) {
        const matchedIds = matchDocumentIdsByNameTokens(
            snapshots.map((s) => ({ documentId: s.documentId, originalFilename: s.filename })),
            opts.question
        );
        if (matchedIds.length) {
            const idSet = new Set(matchedIds);
            targets = snapshots.filter((s) => idSet.has(s.documentId));
        }
    }

    const comparing =
        targets.length >= 2 &&
        /\b(compare|comparison|versus|\bvs\.?\b|difference)\b/i.test(opts.question);

    if (targets.length > 1 && nameTokens.length === 0 && !comparing) {
        const preview = targets.slice(0, 5).map((s, i) => {
            return `${i + 1}. **${s.filename}** — ${formatStatusLabel(s.classification)} · ${s.pageCount} page(s)`;
        });
        return {
            handled: true,
            answer: cleanAgentMarkdown(
                [
                    formatAgentHeading('Document overview', 2),
                    '',
                    `You have **${targets.length}** document(s) in scope. Name a file to focus on one document.`,
                    '',
                    ...preview,
                    formatAgentFooter('Example: “explain report.pdf” or “compare these two files”.'),
                ].join('\n')
            ),
            citations: targets.slice(0, 5).map((s) => ({
                documentId: s.documentId,
                filename: s.filename,
                documentType: s.classification,
                phase3Agent: OTHER_AGENT,
            })),
        };
    }

    const chosen = comparing ? targets.slice(0, 4) : targets.slice(0, 1);
    let md = formatAgentIntro([
        formatAgentHeading(comparing ? 'Document comparison' : 'Document overview', 2),
        comparing
            ? `Side-by-side overview of **${chosen.length}** document(s) in your scope:`
            : 'Here is an overview of the document in your scope:',
        formatAgentDivider(),
    ]);

    for (let i = 0; i < chosen.length; i++) {
        const snap = chosen[i];
        const summary = await loadExtractedSummary(opts.user, snap.documentId);
        md += `\n\n${formatOtherSnapshotExplain(snap, summary)}`;
        if (i < chosen.length - 1) md += `\n\n${formatAgentDivider()}`;
    }

    if (!comparing && chosen.length === 1 && !(await loadExtractedSummary(opts.user, chosen[0].documentId))) {
        md += `\n\n${formatSection(
            'Next step',
            'Ask a specific question about sections or paragraphs in this file for content-level answers.'
        )}`;
    }

    md += formatAgentFooter(
        'Ask for file metadata table, document comparison matrix, or a specific content question.'
    );

    return {
        handled: true,
        answer: cleanAgentMarkdown(md),
        citations: chosen.map((s) => ({
            documentId: s.documentId,
            filename: s.filename,
            documentType: s.classification,
            phase3Agent: OTHER_AGENT,
        })),
    };
}

export async function tryOtherSummarizeCommand(opts: {
    user: AuthUser;
    question: string;
    phase3Agent?: string;
    documentIds?: string[];
}): Promise<OtherActionHandlerResult> {
    if (!detectOtherSummarize(opts.question, opts.phase3Agent)) {
        return { handled: false };
    }

    const snapshots = await loadOtherSnapshots(opts.user, { documentIds: opts.documentIds });
    if (!snapshots.length) {
        return {
            handled: true,
            answer: 'No general documents found in your library to summarize.',
            citations: [],
        };
    }

    let md = `${formatAgentHeading('Document summary', 2)}\n\n`;
    md += `Summarized **${snapshots.length}** document(s) in scope:\n\n`;

    for (const snap of snapshots.slice(0, 5)) {
        const summary = await loadExtractedSummary(opts.user, snap.documentId);
        md += `${formatAgentHeading(snap.filename, 3)}\n\n`;
        md += formatLabeledBullets([
            { label: 'Type', value: formatStatusLabel(snap.classification) },
            { label: 'Pages', value: `${snap.pageCount}` },
            { label: 'Size', value: formatBytes(snap.sizeBytes) },
        ]);
        if (summary) {
            md += `\n\n${formatSection('Summary', summary)}`;
        } else {
            md += `\n\n${formatSection(
                'Summary',
                'No extracted summary yet — ask a specific question about content in this file.'
            )}`;
        }
        md += '\n\n';
    }

    const citations = snapshots.map((s) => ({
        documentId: s.documentId,
        filename: s.filename,
        documentType: s.classification,
        phase3Agent: OTHER_AGENT,
    }));

    return {
        handled: true,
        answer: cleanAgentMarkdown(md),
        citations,
    };
}

export async function tryOtherMetadataCommand(opts: {
    user: AuthUser;
    question: string;
    phase3Agent?: string;
    documentIds?: string[];
}): Promise<OtherActionHandlerResult> {
    if (!detectOtherMetadata(opts.question, opts.phase3Agent)) {
        return { handled: false };
    }

    const snapshots = await loadOtherSnapshots(opts.user, { documentIds: opts.documentIds });
    if (!snapshots.length) {
        return {
            handled: true,
            answer: 'No documents found to inspect metadata.',
            citations: [],
        };
    }

    let markdown = `${formatAgentHeading('Document metadata', 2)}\n\n`;
    markdown += `| Document | Classification | MIME type | Size | Pages | Status |\n`;
    markdown += `| --- | --- | --- | --- | ---: | --- |\n`;

    for (const s of snapshots) {
        markdown += `| **${s.filename}** | ${s.classification} | \`${s.mimeType}\` | ${formatBytes(s.sizeBytes)} | ${s.pageCount} | ${formatStatusLabel(s.status)} |\n`;
    }

    const citations = snapshots.map((s) => ({
        documentId: s.documentId,
        filename: s.filename,
        documentType: s.classification,
        phase3Agent: OTHER_AGENT,
    }));

    return {
        handled: true,
        answer: markdown,
        citations,
    };
}

export async function tryOtherCompareCommand(opts: {
    user: AuthUser;
    question: string;
    phase3Agent?: string;
    documentIds?: string[];
}): Promise<OtherActionHandlerResult> {
    if (!detectOtherCompare(opts.question, opts.phase3Agent)) {
        return { handled: false };
    }

    const snapshots = await loadOtherSnapshots(opts.user, { documentIds: opts.documentIds });
    if (!snapshots.length) {
        return {
            handled: true,
            answer: 'Select at least two documents to compare.',
            citations: [],
        };
    }

    let markdown = `${formatAgentHeading('Document comparison', 2)}\n\n`;
    markdown += `Comparing **${snapshots.length}** document(s):\n\n`;

    markdown += `| Document | Classification | Size | Pages | Notes |\n`;
    markdown += `| --- | --- | --- | ---: | --- |\n`;

    for (const s of snapshots) {
        markdown += `| **${s.filename}** | ${s.classification} | ${formatBytes(s.sizeBytes)} | ${s.pageCount} | Ready for cross-file query |\n`;
    }

    const citations = snapshots.map((s) => ({
        documentId: s.documentId,
        filename: s.filename,
        documentType: s.classification,
        phase3Agent: OTHER_AGENT,
    }));

    return {
        handled: true,
        answer: markdown,
        citations,
    };
}
