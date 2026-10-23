import { AuthUser } from './accessScope';
import {
    executeProcurementAnalytics,
    loadProcurementSnapshots,
    PROCUREMENT_AGENT,
    ProcurementDocSnapshot,
} from './procurementAnalyticsService';
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
    formatAgentIntro,
    formatDate,
    formatLabeledBullets,
    formatMoney,
    formatSection,
    formatStatusLabel,
} from './agentResponseFormat';

export type ProcurementActionHandlerResult = {
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

export function detectProcurementDocumentExplain(question: string, phase3Agent?: string): boolean {
    if (phase3Agent && phase3Agent !== PROCUREMENT_AGENT) return false;
    if (wantsAgentAnalyticsVisual(question, PROCUREMENT_AGENT)) return false;
    if (!wantsAgentTextOnlyExplain(question, PROCUREMENT_AGENT)) return false;
    return /\b(purchase order|\bpo\b|rfq|quotation|procurement|supplier|vendor|delivery)\b/i.test(
        question
    );
}

function formatProcurementSnapshotExplain(snap: ProcurementDocSnapshot): string {
    const meta = formatLabeledBullets([
        { label: 'PO / reference', value: snap.poNumber || 'Not specified' },
        { label: 'Vendor', value: snap.vendorName || 'Not specified' },
        { label: 'Amount', value: formatMoney(snap.totalAmount, snap.currency) },
        { label: 'Status', value: formatStatusLabel(snap.status) },
        { label: 'Line items', value: `${snap.lineItemsCount}` },
        { label: 'Payment terms', value: snap.paymentTerms || 'Not specified' },
        { label: 'Delivery date', value: formatDate(snap.deliveryDate) },
        { label: 'Document type', value: formatStatusLabel(snap.classification) },
    ]);

    let md = `${formatAgentHeading(snap.filename, 3)}\n\n${meta}`;
    if (snap.discrepancyFlag) {
        md += `\n\n${formatSection('Review note', snap.discrepancyFlag)}`;
    }
    return md;
}

export async function tryProcurementDocumentExplainCommand(opts: {
    user: AuthUser;
    question: string;
    phase3Agent?: string;
    documentIds?: string[];
}): Promise<ProcurementActionHandlerResult> {
    if (!detectProcurementDocumentExplain(opts.question, opts.phase3Agent)) {
        return { handled: false };
    }

    const snapshots = await loadProcurementSnapshots(opts.user, { documentIds: opts.documentIds });
    if (!snapshots.length) {
        return {
            handled: true,
            answer:
                'No procurement documents in scope. Select POs, quotes, or delivery notes in Document scope, then ask again.',
            citations: [],
        };
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

    if (targets.length > 1 && nameTokens.length === 0) {
        const preview = targets.slice(0, 5).map((s, i) => {
            return `${i + 1}. **${s.poNumber || s.filename}** — ${s.vendorName} · ${formatMoney(s.totalAmount, s.currency)} · ${formatStatusLabel(s.status)}`;
        });
        return {
            handled: true,
            answer: cleanAgentMarkdown(
                [
                    formatAgentHeading('Procurement overview', 2),
                    '',
                    `You have **${targets.length}** procurement record(s) in scope. Name a PO or vendor to focus on one order.`,
                    '',
                    ...preview,
                    formatAgentFooter('Example: “explain PO for Acme supplier” or “overview of open orders”.'),
                ].join('\n')
            ),
            citations: targets.slice(0, 5).map((s) => ({
                documentId: s.documentId,
                filename: s.filename,
                documentType: s.classification,
                phase3Agent: PROCUREMENT_AGENT,
            })),
        };
    }

    const chosen = targets.slice(0, 2);
    let md = formatAgentIntro([
        formatAgentHeading('Procurement overview', 2),
        chosen.length === 1
            ? 'Here is an overview of the procurement record in your scope:'
            : `Here is an overview of **${chosen.length}** procurement record(s):`,
        formatAgentDivider(),
    ]);
    chosen.forEach((snap, i) => {
        md += `\n\n${formatProcurementSnapshotExplain(snap)}`;
        if (i < chosen.length - 1) md += `\n\n${formatAgentDivider()}`;
    });
    md += formatAgentFooter(
        'Ask for “3-way PO match”, “compare vendor quotes”, or “procurement summary” for detailed analysis.'
    );

    return {
        handled: true,
        answer: cleanAgentMarkdown(md),
        citations: chosen.map((s) => ({
            documentId: s.documentId,
            filename: s.filename,
            documentType: s.classification,
            phase3Agent: PROCUREMENT_AGENT,
        })),
    };
}

export function detectProcurementPOMatching(question: string, phase3Agent?: string): boolean {
    if (phase3Agent && phase3Agent !== PROCUREMENT_AGENT) return false;
    if (wantsAgentTextOnlyExplain(question, PROCUREMENT_AGENT)) return false;
    const q = question.toLowerCase();
    return (
        q.includes('match po') ||
        q.includes('po match') ||
        q.includes('3-way match') ||
        q.includes('3 way match') ||
        q.includes('check po discrepancy') ||
        q.includes('po invoice match') ||
        q.includes('delivery note')
    );
}

export function detectProcurementQuoteComparison(question: string, phase3Agent?: string): boolean {
    if (phase3Agent && phase3Agent !== PROCUREMENT_AGENT) return false;
    if (wantsAgentTextOnlyExplain(question, PROCUREMENT_AGENT)) return false;
    const q = question.toLowerCase();
    return (
        q.includes('compare quote') ||
        q.includes('quote comparison') ||
        q.includes('rfq comparison') ||
        q.includes('vendor comparison') ||
        q.includes('compare supplier') ||
        q.includes('compare rfq')
    );
}

export function detectProcurementSummary(question: string, phase3Agent?: string): boolean {
    if (phase3Agent && phase3Agent !== PROCUREMENT_AGENT) return false;
    if (wantsAgentTextOnlyExplain(question, PROCUREMENT_AGENT)) return false;
    const q = question.toLowerCase();
    return (
        q.includes('procurement summary') ||
        q.includes('supplier register') ||
        q.includes('po summary') ||
        q.includes('procurement pack') ||
        q.includes('open orders')
    );
}

export async function tryProcurementPOMatchingCommand(opts: {
    user: AuthUser;
    question: string;
    phase3Agent?: string;
    documentIds?: string[];
}): Promise<ProcurementActionHandlerResult> {
    if (!detectProcurementPOMatching(opts.question, opts.phase3Agent)) {
        return { handled: false };
    }

    const snapshots = await loadProcurementSnapshots(opts.user, { documentIds: opts.documentIds });
    if (!snapshots.length) {
        return {
            handled: true,
            answer: 'No procurement documents (POs, delivery notes, quotes) found in your library for 3-way matching.',
            citations: [],
        };
    }

    const poDocs = snapshots.filter((s) => s.classification === 'purchase_order' || s.classification === 'po');
    const deliveryDocs = snapshots.filter((s) => s.classification === 'delivery_note');

    let markdown = `${formatAgentHeading('3-Way PO matching', 2)}\n\n`;
    markdown += `Scanned **${snapshots.length}** procurement file(s):\n\n`;
    markdown += `- **Purchase orders:** ${poDocs.length}\n`;
    markdown += `- **Delivery notes:** ${deliveryDocs.length}\n\n`;
    markdown += `**Line-item verification**\n\n`;
    markdown += `| PO # | Vendor | Amount | Line items | Status | Review note |\n`;
    markdown += `| --- | --- | --- | ---: | --- | --- |\n`;

    for (const snap of snapshots) {
        const amtStr = formatMoney(snap.totalAmount, snap.currency);
        const statusLabel = formatStatusLabel(snap.status);
        const auditNote =
            snap.discrepancyFlag ||
            (snap.status === 'DISCREPANCY'
                ? 'Review price or quantity variance'
                : snap.status === 'PENDING_DELIVERY'
                  ? 'Awaiting goods received note'
                  : 'Verified against PO terms');

        markdown += `| **${snap.poNumber}** | ${snap.vendorName} | ${amtStr} | ${snap.lineItemsCount} | ${statusLabel} | ${auditNote} |\n`;
    }

    markdown += `\n_3-way matching verifies PO rates against delivery notes and vendor invoices before payment release._\n`;

    const citations = snapshots.map((s) => ({
        documentId: s.documentId,
        filename: s.filename,
        documentType: s.classification,
        phase3Agent: PROCUREMENT_AGENT,
    }));

    return {
        handled: true,
        answer: markdown,
        citations,
    };
}

export async function tryProcurementQuoteComparisonCommand(opts: {
    user: AuthUser;
    question: string;
    phase3Agent?: string;
    documentIds?: string[];
}): Promise<ProcurementActionHandlerResult> {
    if (!detectProcurementQuoteComparison(opts.question, opts.phase3Agent)) {
        return { handled: false };
    }

    const snapshots = await loadProcurementSnapshots(opts.user, { documentIds: opts.documentIds });
    if (!snapshots.length) {
        return {
            handled: true,
            answer: 'No vendor quotation or RFQ documents found in your library for side-by-side comparison.',
            citations: [],
        };
    }

    let markdown = `${formatAgentHeading('Vendor quote comparison', 2)}\n\n`;
    markdown += `Evaluating **${snapshots.length}** supplier quotation(s):\n\n`;

    markdown += `| Supplier | Quote ref | Amount | Payment terms | Delivery | Recommendation |\n`;
    markdown += `| --- | --- | --- | --- | --- | --- |\n`;

    const sorted = [...snapshots].sort((a, b) => a.totalAmount - b.totalAmount);
    sorted.forEach((snap, idx) => {
        const amtStr = formatMoney(snap.totalAmount, snap.currency);
        const delStr = snap.deliveryDate ? formatDate(snap.deliveryDate) : 'Standard lead time';
        const recBadge = idx === 0 ? 'Lowest bid' : 'Secondary option';
        markdown += `| **${snap.vendorName}** | ${snap.poNumber} | ${amtStr} | ${snap.paymentTerms} | ${delStr} | ${recBadge} |\n`;
    });

    markdown += `\n_Quotations ranked by total cost. Select a vendor to issue a purchase order._\n`;

    const citations = snapshots.map((s) => ({
        documentId: s.documentId,
        filename: s.filename,
        documentType: s.classification,
        phase3Agent: PROCUREMENT_AGENT,
    }));

    return {
        handled: true,
        answer: markdown,
        citations,
    };
}

export async function tryProcurementSummaryCommand(opts: {
    user: AuthUser;
    question: string;
    phase3Agent?: string;
    documentIds?: string[];
}): Promise<ProcurementActionHandlerResult> {
    if (!detectProcurementSummary(opts.question, opts.phase3Agent)) {
        return { handled: false };
    }

    const analytics = await executeProcurementAnalytics(opts.user, { documentIds: opts.documentIds });
    if (!analytics.snapshots.length) {
        return {
            handled: true,
            answer: 'No procurement records found in your library to generate summary.',
            citations: [],
            visuals: [],
        };
    }

    let markdown = `${formatAgentHeading('Procurement summary', 2)}\n\n`;
    markdown += `Total committed spend: **${formatMoney(analytics.totalCommittedSpend, analytics.currency)}** across **${analytics.totalOrders}** order(s):\n\n`;
    markdown += `- **Open / pending orders:** ${analytics.openCount}\n`;
    markdown += `- **Fulfilled deliveries:** ${analytics.fulfilledCount}\n`;
    markdown += `- **Items flagged for review:** ${analytics.discrepancyCount}\n\n`;

    markdown += `**Supplier order register**\n\n`;
    markdown += `| PO # | Supplier | Amount | Status | Line items |\n`;
    markdown += `| --- | --- | --- | --- | ---: |\n`;

    for (const snap of analytics.snapshots) {
        markdown += `| **${snap.poNumber}** | ${snap.vendorName} | ${formatMoney(snap.totalAmount, snap.currency)} | ${formatStatusLabel(snap.status)} | ${snap.lineItemsCount} |\n`;
    }

    return {
        handled: true,
        answer: markdown,
        citations: analytics.citations,
        visuals: analytics.visuals,
    };
}
