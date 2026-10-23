import { AuthUser } from './accessScope';
import { requireAllowedAgent } from './planService';
import type { AgentChatVisualResult, FinanceAnalyticsCoverage, ChatVisualSpec } from '../types/chatVisuals';
import { applyAgentVisualPolicy, wantsAgentAnalyticsVisual, wantsAgentTextOnlyExplain } from './agentAnalyticsPolicy';
import {
    buildAgingVisual,
    buildClientSpendVisual,
    buildDocTypeMixVisual,
    buildMonthlyTrendVisual,
    buildVendorSpendVisual,
    FINANCE_AGENT,
    loadFinanceRecords,
    sumTotalsByCurrency,
    buildFinanceFileCoverage,
    computeFinanceCoverage,
    countFinanceDocumentsInScope,
    executeLineItemAnalytics,
    resolveFinanceDocumentIdsFromQuestion,
    loadFinanceDocsForAnalytics,
    formatVendorSpendTable,
    formatClientSpendTable,
    detectCurrencyPreference,
    createFinanceExtractionCache,
    type LoadFinanceOptions,
    narrowFinanceDocumentIds,
    questionRefersToSpecificDocument,
    extractDocumentNameTokens,
    findDuplicateInvoiceWarnings,
    dedupeFinanceRecords,
    pairPurchaseOrdersWithInvoices,
    formatPoPairingTable,
    type FinanceRecord,
    resolveFinancePortfolioDocumentIds,
    applyPaymentsToInvoices,
    convertFinanceRecordsToCurrency,
    DEFAULT_FX_RATES_TO_USD,
} from './financeAnalyticsService';
import Document from '../models/Document';
import { buildDocumentFilter } from './accessScope';
import { mapFinanceIntentToPanelView, wantsMonthlyTrendQuestion, formatFinanceCoverageNotes, wantsPortfolioFinanceScope } from './financeIntent';
import { getOrgFinanceSettings } from './orgFinanceSettingsService';

export type FinanceVisualIntent =
    | 'vendor_spend'
    | 'client_spend'
    | 'monthly_trend'
    | 'aging'
    | 'doc_mix'
    | 'line_items'
    | 'overview';

function attachChartExplainActions(visuals: ChatVisualSpec[]): ChatVisualSpec[] {
    return visuals.map((v) => {
        if (v.actions?.some((a) => a.kind === 'ask')) return v;
        return {
            ...v,
            actions: [
                ...(v.actions || []),
                {
                    label: 'Explain this chart',
                    kind: 'ask' as const,
                    prompt: `Explain how "${v.title}" was calculated from my scoped invoices. Use extraction fields and filenames only — no guesses.`,
                },
            ],
        };
    });
}

function hasFinanceContext(question: string, phase3Agent?: string): boolean {
    if (phase3Agent === FINANCE_AGENT) return true;
    return /\b(invoice|invoices|vendor|spend|ap|payable|expense|finance|financial|budget|bank statement)\b/i.test(
        question
    );
}

export function wantsVisualization(question: string): boolean {
    const q = question.toLowerCase();
    return (
        /\b(chart|graph|graphs|visuali[sz]e|visual|plot|dashboard|breakdown|analytics)\b/.test(q) ||
        /\b(show me|give me)\b.*\b(numbers|stats|summary|graph|chart|visual)\b/.test(q)
    );
}

export type FinanceVisualDetectOptions = {
    /** At least one scoped document is finance-classified (invoice, etc.). */
    hasScopedFinanceDocuments?: boolean;
    scopedFinanceDocCount?: number;
};

function wantsLineItemBreakdown(question: string): boolean {
    const q = question.toLowerCase();
    return (
        /\b(line[\s-]?items?|items?\s+list|list\s+(of\s+)?items?|each item|item\s+wise|item-wise)\b/.test(q) ||
        (/\b(show|list|give)\b/.test(q) && /\bitems?\b/.test(q)) ||
        (/\b(quantity|quantities|unit price|unit_price|subtotal)\b/.test(q) &&
            /\b(item|items|invoice|bill)\b/.test(q))
    );
}

function wantsVendorRollup(question: string): boolean {
    const q = question.toLowerCase();
    return (
        (/\b(vendor|supplier)\b/.test(q) &&
            /\b(total|totals|sum|spend|amount|breakdown|grand|verify|correct|compare|per vendor)\b/.test(q)) ||
        /\bspend by\b/.test(q) ||
        (/\b(vendor|supplier)\b/.test(q) && /\b(chart|graph|visual)\b/.test(q))
    );
}

export function detectFinanceVisualIntent(
    question: string,
    phase3Agent?: string,
    options?: FinanceVisualDetectOptions
): FinanceVisualIntent | null {
    const q = question.toLowerCase();
    const financeScoped = Boolean(options?.hasScopedFinanceDocuments);
    const scopedCount = options?.scopedFinanceDocCount ?? 0;

    if (
        wantsLineItemBreakdown(question) &&
        (wantsVisualization(question) ||
            /\b(give|show|list|get)\b/.test(q) ||
            phase3Agent === FINANCE_AGENT ||
            hasFinanceContext(question, phase3Agent) ||
            financeScoped)
    ) {
        return 'line_items';
    }

    const financeContext =
        hasFinanceContext(question, phase3Agent) || financeScoped || phase3Agent === FINANCE_AGENT;

    if (!financeContext && !wantsVisualization(question)) return null;
    if (!financeContext && wantsVisualization(question)) {
        if (phase3Agent && phase3Agent !== FINANCE_AGENT && !financeScoped) return null;
    }

    if (wantsVisualization(question) && financeContext) {
        if (wantsLineItemBreakdown(question)) return 'line_items';
        if (wantsVendorRollup(question)) return 'vendor_spend';
        if (phase3Agent === FINANCE_AGENT && /\b(graph|chart|visual|plot)\b/.test(q)) {
            if (/\b(vendor|supplier|spend)\b/.test(q)) return 'vendor_spend';
            if (wantsMonthlyTrendQuestion(question)) return 'monthly_trend';
            if (/\b(client|customer)\b/.test(q)) return 'client_spend';
            if (/\b(aging|overdue)\b/.test(q)) return 'aging';
            if (scopedCount > 0 && scopedCount <= 12) return 'line_items';
            return 'overview';
        }
    }

    if (!wantsVisualization(question)) {
        if (wantsLineItemBreakdown(question)) return 'line_items';
        if (/\b(client|customer|bill to)\b/.test(q) && /\b(spend|total|amount|breakdown|revenue)\b/.test(q)) {
            return 'client_spend';
        }
        if (wantsVendorRollup(question)) {
            return 'vendor_spend';
        }
        if (/\b(aging|overdue|outstanding|past due)\b/.test(q)) return 'aging';
        if (wantsMonthlyTrendQuestion(question)) return 'monthly_trend';
        return null;
    }

    if (/\b(client|customer)\b/.test(q) && /\b(chart|graph|visual|breakdown)\b/.test(q)) return 'client_spend';
    if (/\b(aging|overdue|outstanding|past due|due date)\b/.test(q)) return 'aging';
    if (/\b(client|customer|bill to)\b/.test(q) && /\b(spend|total|amount|breakdown|revenue)\b/.test(q)) {
        return 'client_spend';
    }
    if (wantsLineItemBreakdown(question)) return 'line_items';
    if (wantsVendorRollup(question) || (/\b(vendor|supplier)\b/.test(q) && /\b(chart|graph)\b/.test(q))) {
        return 'vendor_spend';
    }
    if (/\b(vendor|supplier)\b/.test(q) || /\bspend by\b/.test(q)) return 'vendor_spend';
    if (wantsMonthlyTrendQuestion(question)) return 'monthly_trend';
    if (/\b(mix|types|breakdown)\b/.test(q) && /\b(document|doc)\b/.test(q)) return 'doc_mix';
    if (financeContext) return 'overview';
    return null;
}

export async function tryFinanceChatVisual(params: {
    user: AuthUser;
    question: string;
    phase3Agent?: string;
    documentIds?: string[];
    focusDocumentIds?: string[];
    sessionId?: string;
}): Promise<AgentChatVisualResult> {
    if (params.phase3Agent && params.phase3Agent !== FINANCE_AGENT) {
        return { handled: false };
    }

    if (wantsAgentTextOnlyExplain(params.question, params.phase3Agent || FINANCE_AGENT)) {
        return { handled: false };
    }

    if (params.user.role !== 'superAdmin') {
        const check = await requireAllowedAgent(params.user, FINANCE_AGENT);
        if (!check.ok) {
            if (!detectFinanceVisualIntent(params.question, params.phase3Agent)) {
                return { handled: false };
            }
            return { handled: true, answer: check.message, agentId: FINANCE_AGENT };
        }
    }

    const financeAgentSelected =
        !params.phase3Agent || params.phase3Agent === FINANCE_AGENT;
    const chartAsk = wantsAgentAnalyticsVisual(params.question, FINANCE_AGENT);
    if (
        financeAgentSelected &&
        chartAsk &&
        (params.documentIds?.length || params.focusDocumentIds?.length)
    ) {
        const portfolioScope = wantsPortfolioFinanceScope(params.question);
        const documentIds = portfolioScope
            ? await resolveFinancePortfolioDocumentIds(params.user, params.documentIds)
            : params.documentIds;
        const { runDynamicAnalytics } = await import('./dynamicAnalyticsEngine');
        const dyn = await runDynamicAnalytics({
            user: params.user,
            question: params.question,
            phase3Agent: params.phase3Agent || FINANCE_AGENT,
            documentIds,
            focusDocumentIds: portfolioScope ? undefined : params.focusDocumentIds,
            sessionId: params.sessionId,
            force: true,
        });
        if (dyn.handled) {
            return applyAgentVisualPolicy(
                {
                    handled: true,
                    agentId: dyn.agentId || FINANCE_AGENT,
                    answer: dyn.answer,
                    visuals: dyn.visuals,
                    citations: dyn.citations,
                    coverage: dyn.coverage,
                    analyticsView: dyn.analyticsView,
                },
                params.question,
                FINANCE_AGENT
            );
        }
    }

    let resolvedIds = await narrowFinanceDocumentIds({
        user: params.user,
        question: params.question,
        scopedIds: params.documentIds,
        focusIds: params.focusDocumentIds,
        portfolioScope: wantsPortfolioFinanceScope(params.question),
    });

    if (
        questionRefersToSpecificDocument(params.question) &&
        (params.documentIds?.length || 0) > 1 &&
        !(params.focusDocumentIds && params.focusDocumentIds.length)
    ) {
        const named = await resolveFinanceDocumentIdsFromQuestion(
            params.user,
            params.question,
            { preferIds: params.documentIds }
        );
        if (!named?.length) {
            return {
                handled: true,
                agentId: FINANCE_AGENT,
                answer:
                    'Which document do you mean by “that”? Name the file (e.g. digilog) or leave only that invoice selected in Document scope, then ask again.',
            };
        }
        resolvedIds = named;
    }

    let scopedFinanceCount = 0;
    if (resolvedIds?.length) {
        scopedFinanceCount = await countFinanceDocumentsInScope(params.user, resolvedIds);
        if (!scopedFinanceCount) {
            resolvedIds = undefined;
        }
    }

    if (
        !resolvedIds?.length &&
        params.phase3Agent === FINANCE_AGENT &&
        wantsVisualization(params.question)
    ) {
        const docs = await loadFinanceDocsForAnalytics(params.user, { maxDocs: 8 });
        if (docs.length) {
            resolvedIds = docs.map((d) => d.documentId);
            scopedFinanceCount = docs.length;
        }
    }

    let intent = detectFinanceVisualIntent(params.question, params.phase3Agent, {
        hasScopedFinanceDocuments: scopedFinanceCount > 0,
        scopedFinanceDocCount: scopedFinanceCount,
    });
    // Named file or "that" for a single invoice → line items, not portfolio overview
    if (
        intent &&
        intent !== 'line_items' &&
        resolvedIds?.length === 1 &&
        !wantsPortfolioFinanceScope(params.question) &&
        /\b(chart|graph|visual|plot)\b/i.test(params.question) &&
        (questionRefersToSpecificDocument(params.question) ||
            extractDocumentNameTokens(params.question).length > 0)
    ) {
        intent = 'line_items';
    }
    if (!intent) return { handled: false };

    const loadOpts: LoadFinanceOptions = {
        documentIds: resolvedIds?.length ? resolvedIds : undefined,
        extractionCache: createFinanceExtractionCache(),
        preferredCurrency: detectCurrencyPreference(params.question),
    };
    const result = await executeFinanceAnalytics(params.user, intent, loadOpts);
    return applyAgentVisualPolicy(
        {
            handled: true,
            agentId: FINANCE_AGENT,
            visuals: result.visuals,
            citations: result.citations,
            answer: result.answer,
            coverage: result.coverage,
            analyticsView: mapFinanceIntentToPanelView(intent),
        },
        params.question,
        FINANCE_AGENT
    );
}

// P2.15 — short-TTL memoization: identical portfolio calls within ~30s return the
// same computed answer instead of re-hitting Mongo + AI for every keystroke.
type FinanceAnalyticsResult = {
    visuals: import('../types/chatVisuals').ChatVisualSpec[];
    citations: AgentChatVisualResult['citations'];
    answer: string;
    documentCount: number;
    coverage?: FinanceAnalyticsCoverage;
};
const executionCache = new Map<string, { at: number; result: FinanceAnalyticsResult }>();
const EXECUTION_CACHE_MS = 30_000;
const EXECUTION_CACHE_MAX = 200;

function pruneExecutionCache() {
    if (executionCache.size <= EXECUTION_CACHE_MAX) return;
    const cutoff = Date.now() - EXECUTION_CACHE_MS;
    for (const [k, v] of executionCache) {
        if (v.at < cutoff) executionCache.delete(k);
    }
    if (executionCache.size > EXECUTION_CACHE_MAX) {
        const oldestKey = executionCache.keys().next().value;
        if (oldestKey) executionCache.delete(oldestKey);
    }
}

function financeCacheKey(
    user: AuthUser,
    intent: string,
    loadOpts: LoadFinanceOptions,
): string {
    const ids = [...(loadOpts.documentIds || [])].sort().join(',');
    return `${user.organizationId || 'noorg'}|${user.userId || 'nouser'}|${intent}|${ids}|${loadOpts.preferredCurrency || ''}`;
}

export async function executeFinanceAnalytics(
    user: AuthUser,
    intent: FinanceVisualIntent,
    loadOpts: LoadFinanceOptions = {}
): Promise<FinanceAnalyticsResult> {
    if (intent === 'line_items') {
        return executeLineItemAnalytics(user, loadOpts);
    }

    const cacheKey = financeCacheKey(user, intent, loadOpts);
    const cached = executionCache.get(cacheKey);
    if (cached && Date.now() - cached.at < EXECUTION_CACHE_MS) {
        return cached.result;
    }

    const orgFin = await getOrgFinanceSettings(user.organizationId);
    const finOpts: LoadFinanceOptions = {
        ...loadOpts,
        vendorAliases: loadOpts.vendorAliases ?? orgFin.vendorAliases,
        baseCurrency: loadOpts.baseCurrency ?? orgFin.baseCurrency,
    };

    const loadedRecords = await loadFinanceRecords(user, finOpts);
    // Apply org client aliases before dedupe/pairing so grouping keys stay stable.
    const clientAliases = orgFin.clientAliases;
    const aliasedRecords: FinanceRecord[] = clientAliases
        ? loadedRecords.map((r) => {
              const key = r.client.trim().toLowerCase();
              const mapped = key && clientAliases[key];
              return mapped ? { ...r, client: mapped } : r;
          })
        : loadedRecords;
    // Charts keep native file currency unless the user asked for PKR/USD.
    const preferred = finOpts.preferredCurrency?.toUpperCase();
    let rawRecords = aliasedRecords;
    let convertedCount = 0;
    if (preferred) {
        const conv = convertFinanceRecordsToCurrency(
            aliasedRecords,
            preferred,
            DEFAULT_FX_RATES_TO_USD
        );
        convertedCount = conv.converted;
        rawRecords = conv.records.filter((r) => (r.currency || '').toUpperCase() === preferred);
        if (!rawRecords.length) rawRecords = conv.records;
    }
    const fxResult = {
        records: rawRecords,
        converted: convertedCount,
        unconvertedCurrencies: [] as string[],
    };
    // Dedupe BEFORE aggregation so totals reflect one real invoice per group.
    const dedupe = dedupeFinanceRecords(fxResult.records);
    // Match payment receipts → invoices; charts use outstanding balances.
    const settlement = applyPaymentsToInvoices(dedupe.records);
    const records = settlement.records;
    const docsInScope = await countFinanceDocumentsInScope(user, finOpts.documentIds);
    const scopedNote = finOpts.documentIds?.length
        ? ` (scoped to **${finOpts.documentIds.length}** selected file(s))`
        : '';

    if (!records.length) {
        const filter = await buildDocumentFilter(user, {});
        const count = await Document.countDocuments({
            ...filter,
            status: 'ready',
            classification: { $in: ['invoice', 'expense_report', 'payment_receipt', 'financial_statement'] },
        });
        const fileReport = await buildFinanceFileCoverage(user, [], finOpts);
        const skipped = (fileReport || []).filter((f) => f.status !== 'in_charts');
        const skippedBlock = skipped.length
            ? [
                  '',
                  '**Files in scope (no amounts for charts yet):**',
                  ...skipped.slice(0, 8).map(
                      (f) =>
                          `- **${f.filename}** — ${f.detail || f.status.replace(/_/g, ' ')}`
                  ),
                  '',
                  '_Open each file → **Reprocess** as invoice so `total_amount` and `invoice_date` are captured, then ask again._',
              ].join('\n')
            : '';
        return {
            visuals: [],
            citations: [],
            documentCount: 0,
            coverage: computeFinanceCoverage([], docsInScope, fileReport),
            answer: [
                '**Finance analytics**',
                '',
                docsInScope > 0
                    ? `I checked **${docsInScope}** document(s) in scope but found **no invoice amounts** to chart yet.${skippedBlock}`
                    : count > 0
                      ? `You have **${count}** ready finance document(s) in your library, but none are in this chat scope. Widen **Document scope** (select more files) or ask a portfolio question (e.g. “all vendor spend”).`
                      : 'No ready finance documents found. Upload invoices or expense reports and wait until status is **ready** with extraction complete.',
            ].join('\n'),
        };
    }

    const visuals = [];
    const citations = records.slice(0, 8).map((r) => ({
        documentId: r.documentId,
        filename: r.filename,
        documentType: 'invoice',
        phase3Agent: FINANCE_AGENT,
    }));

    const chartOpts = {
        vendorAliases: finOpts.vendorAliases,
        preferredCurrency: finOpts.preferredCurrency,
        fxRates: DEFAULT_FX_RATES_TO_USD,
    };

    if (intent === 'vendor_spend' || intent === 'overview') {
        visuals.push(buildVendorSpendVisual(records, chartOpts));
    }
    if (intent === 'client_spend' || intent === 'overview') {
        visuals.push(buildClientSpendVisual(records, chartOpts));
    }
    if (intent === 'monthly_trend' || intent === 'overview') {
        const trend = buildMonthlyTrendVisual(records);
        // Always emit for explicit trend asks so the user sees why it's empty.
        if (intent === 'monthly_trend' || trend.data.length) visuals.push(trend);
    }
    if (intent === 'aging' || intent === 'overview') {
        visuals.push(buildAgingVisual(records));
    }
    if (intent === 'doc_mix') {
        const filter = await buildDocumentFilter(user, {});
        const docQuery: Record<string, unknown> = {
            ...filter,
            classification: {
                $in: [
                    'invoice',
                    'expense_report',
                    'payment_receipt',
                    'financial_statement',
                    'tax_document',
                    'bank_statement',
                    'budget',
                ],
            },
        };
        if (loadOpts.documentIds?.length) {
            docQuery.documentId = { $in: loadOpts.documentIds };
        }
        const docs = await Document.find(docQuery).select('classification').lean();
        const counts = new Map<string, number>();
        for (const d of docs) {
            const t = String(d.classification || 'other');
            counts.set(t, (counts.get(t) || 0) + 1);
        }
        visuals.push(
            buildDocTypeMixVisual(
                [...counts.entries()].map(([type, count]) => ({ type, count })).sort((a, b) => b.count - a.count)
            )
        );
    }

    const totalsByCurrency = sumTotalsByCurrency(records);
    const totalLines = [...totalsByCurrency.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([cur, amt]) => `**${cur}** ${Math.round(amt * 100) / 100}`)
        .join(' · ');
    const coverageRecords = [...records, ...settlement.payments];
    const docIds = new Set(coverageRecords.map((r) => r.documentId));
    const fileReport = await buildFinanceFileCoverage(user, coverageRecords, finOpts);
    const dupWarnings = findDuplicateInvoiceWarnings(rawRecords.filter((r) => r.recordKind !== 'payment'));
    const coverage = computeFinanceCoverage(coverageRecords, docsInScope, fileReport, dupWarnings);

    const prefCurrency = finOpts.preferredCurrency;
    const vendorTable =
        intent === 'vendor_spend' || intent === 'overview'
            ? formatVendorSpendTable(records, 25, prefCurrency)
            : '';
    const clientTable =
        intent === 'client_spend' || intent === 'overview'
            ? formatClientSpendTable(records, 100, prefCurrency)
            : '';
    const coverageNotes = formatFinanceCoverageNotes(coverage);

    // PO ↔ invoice pairing (only when at least one PO doc + one invoice share a PO number)
    const poPairs = pairPurchaseOrdersWithInvoices(records).filter(
        (p) => p.status !== 'invoice_only' || p.invoiceDocumentIds.length > 1,
    );
    const hasRealPoPairing = poPairs.some(
        (p) => p.status === 'matched' || p.status === 'over_invoiced' || p.status === 'under_invoiced',
    );
    const poBlock = hasRealPoPairing
        ? `\n### PO vs Invoice\n\n${formatPoPairingTable(poPairs)}\n\n_Pairing joins invoices to purchase orders by \`po_number\` + vendor + currency._`
        : '';

    const skipped = (fileReport || []).filter(
        (f) => f.status === 'missing_amount' || f.status === 'no_extraction' || f.status === 'not_linked',
    );

    // P0.1 — attach Reprocess actions for skipped files onto every chart so users
    // can fix extraction from where the confusion happens, not by hunting the panel.
    const reprocessActions = skipped.slice(0, 5).map((f) => ({
        label: `Reprocess ${f.filename}`,
        kind: 'reprocess' as const,
        documentId: f.documentId,
    }));
    const uniqueVisuals = attachChartExplainActions(
        visuals
            .filter((v, i, arr) => arr.findIndex((x) => x.title === v.title) === i)
            .map((v) => ({
                ...v,
                actions: [...(v.actions || []), ...reprocessActions],
            })),
    );

    const skippedBlock = skipped.length
        ? `\n> ℹ️ *Note: ${skipped.length} of ${docsInScope} document(s) in scope are currently processing or pending extraction.*`
        : '';

    const dropped = dedupe.droppedFilenames.length
        ? `\n**${dedupe.droppedFilenames.length} duplicate invoice(s) excluded from totals:** ${dedupe.droppedFilenames.slice(0, 5).map((n) => `\`${n}\``).join(', ')}${dedupe.droppedFilenames.length > 5 ? '…' : ''}`
        : '';

    const settlementNote =
        settlement.appliedPayments > 0
            ? `\n> 💳 Applied **${settlement.appliedPayments}** payment receipt(s) (**${Math.round(settlement.totalPaidApplied * 100) / 100}** paid). Outstanding **${Math.round(settlement.totalOutstanding * 100) / 100}** of gross **${Math.round(settlement.totalGross * 100) / 100}**.`
            : '';

    const nativeCurrencies = [...new Set(aliasedRecords.map((r) => r.currency).filter(Boolean))];
    const chartCurrency = uniqueVisuals.find((v) => v.currency)?.currency;
    const fxNote =
        preferred === 'PKR'
            ? `\n> Amounts shown in **PKR** only (USD converted at 1 USD = ${DEFAULT_FX_RATES_TO_USD.PKR} PKR). INR/₹ is not used.`
            : preferred
              ? `\n> Amounts shown in **${preferred}** as requested.`
              : nativeCurrencies.length > 1 && chartCurrency
                ? `\n> Charts use native file currency (**${chartCurrency}**). Other currencies (${nativeCurrencies.filter((c) => c !== chartCurrency).join(', ')}) are excluded, not converted.`
                : nativeCurrencies.length === 1
                  ? `\n> Amounts shown in **${nativeCurrencies[0]}** as recorded in the file.`
                  : '';

    const result: FinanceAnalyticsResult = {
        visuals: uniqueVisuals,
        citations,
        documentCount: docIds.size,
        coverage,
        answer: [
            `Analyzed **${docIds.size}** document(s) with extracted financial amounts${scopedNote}:`,
            skippedBlock,
            fxNote,
            settlementNote,
            '',
            vendorTable ? `### Vendor totals\n\n${vendorTable}` : '',
            clientTable ? `### Client totals\n\n${clientTable}` : '',
            poBlock,
            coverageNotes,
            dupWarnings.length ? `\n**Duplicate Check Warnings:**\n${dupWarnings.map((w) => `- ${w}`).join('\n')}` : '',
            '',
            settlement.appliedPayments > 0
                ? 'AP/AR and aging use **outstanding** (invoice total − matched payments). Monthly trend stays gross billed volume.'
                : 'Numbers are summed from invoice extractions (one total per invoice). Add payment receipts that reference invoice numbers to net outstanding.',
        ]
            .filter(Boolean)
            .join('\n'),
    };
    executionCache.set(cacheKey, { at: Date.now(), result });
    pruneExecutionCache();
    return result;
}
