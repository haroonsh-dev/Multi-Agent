/**
 * Scope-driven analytics router.
 * Charts follow the documents in chat scope (and question intent), not a fixed agent playbook.
 */
import Document from '../models/Document';
import { AuthUser, buildDocumentFilter } from './accessScope';
import { DOC_TYPE_TO_AGENT, inferDocumentTypeFromFilename, resolveCanonicalAgent } from './documentStorage';
import type { AgentChatVisualResult, ChatVisualSpec } from '../types/chatVisuals';
import { executeFinanceAnalytics, wantsVisualization } from './financeChatVisualService';
import { applyAgentVisualPolicy, wantsAgentAnalyticsVisual } from './agentAnalyticsPolicy';
import {
    FINANCE_AGENT,
    FINANCE_DOC_TYPES,
    scalarField,
    narrowFinanceDocumentIds,
    questionRefersToSpecificDocument,
    resolveFinanceDocumentIdsFromQuestion,
    matchDocumentIdsByNameTokens,
    extractDocumentNameTokens,
    enrichSearchTextForDoc,
    loadFinanceRecords,
    createFinanceExtractionCache,
    resolveFinancePortfolioDocumentIds,
    detectCurrencyPreference,
} from './financeAnalyticsService';
import { canonicalizePartyName } from './financePartyNormalize';
import { COMPLIANCE_AGENT, COMPLIANCE_DOC_TYPES } from './complianceAnalyticsService';
import { executeComplianceAnalytics } from './complianceChatVisualService';
import { listTopResumesForUser } from './hrChatActionService';
import { HR_AGENT } from './offerLetterGenerationService';
import {
    classifyHrWorkIntent,
    type HrWorkTool,
} from './hrIntentRouter';
import {
    executeHrPortfolioAnalytics,
    type HrVisualIntent,
} from './hrAnalyticsService';
import {
    getDocumentExtractions,
    getAiDocument,
    resolveDocumentAiOrgId,
    isAiServiceEnabled,
} from './aiServiceClient';
import { logAnalyticsResolve } from './analyticsObservability';
import { getSessionFocusDocumentIds } from './chatFocusStore';
import { mapFinanceIntentToPanelView, parseFinanceIntent, wantsPortfolioFinanceScope, wantsMonthlyTrendQuestion } from './financeIntent';
import { executeLegalMissingDataAnalytics } from './legalAnalyticsService';
import { detectLegalMissingDataAsk } from './legalChatActionService';

async function executeHrCharts(
    user: AuthUser,
    limit: number,
    documentIds: string[] | undefined,
    intent: 'ranking' | 'distribution'
): Promise<{
    visuals: ChatVisualSpec[];
    citations: NonNullable<AgentChatVisualResult['citations']>;
    answer: string;
}> {
    const fetchLimit = intent === 'distribution' ? 100 : limit;
    const pool = await listTopResumesForUser(user, fetchLimit, documentIds);
    const top = intent === 'distribution' ? pool : pool.slice(0, limit);
    const citations = top.map((r) => ({
        documentId: r.documentId,
        filename: r.originalFilename,
        documentType: 'resume',
        phase3Agent: HR_AGENT,
    }));

    if (!top.length) {
        return {
            visuals: [],
            citations: [],
            answer:
                'No resumes in scope yet. Select CVs in Document scope, wait until they’re ready, then ask again.',
        };
    }

    if (intent === 'distribution') {
        const buckets = [
            { label: '0–39', min: 0, max: 39 },
            { label: '40–59', min: 40, max: 59 },
            { label: '60–79', min: 60, max: 79 },
            { label: '80–100', min: 80, max: 100 },
        ];
        const counts = buckets.map((b) => ({
            bucket: b.label,
            count: top.filter((r) => Number.isFinite(r.cvScore) && r.cvScore >= b.min && r.cvScore <= b.max)
                .length,
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
                },
            ],
            citations,
            answer: `Here’s the CV score distribution across ${top.length} resume(s) in your scope.`,
        };
    }

    const data = top
        .filter((r) => Number.isFinite(r.cvScore))
        .map((r) => ({
            candidate:
                r.originalFilename.length > 24
                    ? `${r.originalFilename.slice(0, 22)}…`
                    : r.originalFilename,
            score: r.cvScore,
            _documentIds: r.documentId,
        }));

    if (!data.length) {
        return {
            visuals: [],
            citations,
            answer:
                'Those CVs don’t have scores yet. Open each resume until processing finishes (you should see a score on the details page), then ask again.',
        };
    }

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
            },
        ],
        citations,
        answer: `Here’s how your scoped candidates rank by CV score (${data.length} with scores). Charts are in the analytics panel.`,
    };
}

export type AnalyticsDomain =
    | 'finance'
    | 'hr'
    | 'compliance'
    | 'procurement'
    | 'legal'
    | 'generic';

export type ScopedDoc = {
    documentId: string;
    originalFilename: string;
    classification: string;
    domain: AnalyticsDomain;
    agentId: string;
    pythonDocumentId?: string | null;
};

const PROCUREMENT_TYPES = new Set([
    'purchase_order',
    'po',
    'quotation',
    'supplier_agreement',
    'vendor_list',
    'rfq',
    'delivery_note',
    'procurement_request',
]);

const LEGAL_TYPES = new Set([
    'contract',
    'agreement',
    'nda',
    'service_agreement',
    'lease_agreement',
    'vendor_contract',
]);

const HR_TYPES = new Set([
    'resume',
    'cv',
    'employee_record',
    'hr_document',
    'offer_letter',
    'experience_letter',
    'employment_contract',
    'leave_application',
    'payroll',
    'attendance',
    'performance_review',
    'training_certificate',
    'transcript',
]);

function resolveDocType(doc: {
    classification?: string | null;
    originalFilename?: string;
}): string {
    const fromName = inferDocumentTypeFromFilename(doc.originalFilename || '');
    const c = String(doc.classification || '')
        .trim()
        .toLowerCase()
        .replace(/[\s-]+/g, '_');
    const fromClass = c === 'cv' || c === 'curriculum_vitae' ? 'resume' : c;

    if (fromName && fromName !== 'other') {
        const nameAgent = DOC_TYPE_TO_AGENT[fromName];
        const classAgent =
            fromClass && fromClass !== 'other' ? DOC_TYPE_TO_AGENT[fromClass] : undefined;
        if (nameAgent && nameAgent !== 'other_agent' && classAgent && nameAgent !== classAgent) {
            return fromName;
        }
        if (fromClass && fromClass !== 'other') return fromClass;
        return fromName;
    }
    if (fromClass && fromClass !== 'other') return fromClass;
    if (/\.(xlsx?|csv|tsv|ods)$/i.test(doc.originalFilename || '')) return 'invoice';
    return inferDocumentTypeFromFilename(doc.originalFilename || '') || 'other';
}

export function domainForDocType(docType: string): AnalyticsDomain {
    const t = docType.toLowerCase();
    if (FINANCE_DOC_TYPES.has(t) && !PROCUREMENT_TYPES.has(t)) return 'finance';
    if (PROCUREMENT_TYPES.has(t)) return 'procurement';
    if (COMPLIANCE_DOC_TYPES.has(t)) return 'compliance';
    if (HR_TYPES.has(t)) return 'hr';
    if (LEGAL_TYPES.has(t)) return 'legal';
    const agent = DOC_TYPE_TO_AGENT[t];
    if (agent === FINANCE_AGENT) return 'finance';
    if (agent === HR_AGENT) return 'hr';
    if (agent === COMPLIANCE_AGENT) return 'compliance';
    if (agent === 'procurement_agent') return 'procurement';
    if (agent === 'legal_agent') return 'legal';
    return 'generic';
}

export function agentForDomain(domain: AnalyticsDomain): string {
    switch (domain) {
        case 'finance':
            return FINANCE_AGENT;
        case 'hr':
            return HR_AGENT;
        case 'compliance':
            return COMPLIANCE_AGENT;
        case 'procurement':
            return 'procurement_agent';
        case 'legal':
            return 'legal_agent';
        default:
            return 'other_agent';
    }
}

/** Keep analytics scoped to the agent the user selected in chat. */
export function filterScopedDocsByAgent(scoped: ScopedDoc[], phase3Agent: string): ScopedDoc[] {
    return scoped.filter((d) => d.agentId === phase3Agent);
}

export async function filterDocumentIdsForAgent(
    user: AuthUser,
    documentIds: string[] | undefined,
    phase3Agent?: string
): Promise<string[] | undefined> {
    if (!documentIds?.length || !phase3Agent) return documentIds;
    const scoped = await loadScopedDocuments(user, documentIds);
    return filterScopedDocsByAgent(scoped, phase3Agent).map((d) => d.documentId);
}

export async function loadScopedDocuments(
    user: AuthUser,
    documentIds?: string[],
    maxDocs = 100
): Promise<ScopedDoc[]> {
    const filter = await buildDocumentFilter(user, {});
    const query: Record<string, unknown> = {
        ...filter,
        status: { $in: ['ready', 'review', 'processing'] },
    };
    if (documentIds?.length) {
        query.documentId = { $in: documentIds };
    } else {
        return [];
    }

    const docs = await Document.find(query)
        .select('documentId originalFilename classification pythonDocumentId metadata')
        .sort({ createdAt: -1 })
        .limit(maxDocs)
        .lean();

    return docs.map((d) => {
        const classification = resolveDocType(d);
        const domain = domainForDocType(classification);
        const meta = d.metadata as { phase3Agent?: string; naturalAgent?: string } | undefined;
        return {
            documentId: d.documentId,
            originalFilename: d.originalFilename,
            classification,
            domain,
            agentId: resolveCanonicalAgent({
                originalFilename: d.originalFilename,
                classification: d.classification,
                metadata: meta,
            }),
            pythonDocumentId: d.pythonDocumentId,
        };
    });
}

/** All ready/review docs for one agent — used by standalone agent dashboards (not chat selection). */
export async function loadAgentScopedDocuments(
    user: AuthUser,
    phase3Agent: string,
    maxDocs = 150
): Promise<ScopedDoc[]> {
    const filter = await buildDocumentFilter(user, {});
    const docs = await Document.find({
        ...filter,
        status: { $in: ['ready', 'review'] },
    })
        .select('documentId originalFilename classification pythonDocumentId metadata')
        .sort({ createdAt: -1 })
        .limit(Math.max(maxDocs * 4, 200))
        .lean();

    const mapped = docs.map((d) => {
        const classification = resolveDocType(d);
        const domain = domainForDocType(classification);
        const meta = d.metadata as { phase3Agent?: string; naturalAgent?: string } | undefined;
        return {
            documentId: d.documentId,
            originalFilename: d.originalFilename,
            classification,
            domain,
            agentId: resolveCanonicalAgent({
                originalFilename: d.originalFilename,
                classification: d.classification,
                metadata: meta,
            }),
            pythonDocumentId: d.pythonDocumentId,
        };
    });

    return mapped.filter((d) => d.agentId === phase3Agent).slice(0, maxDocs);
}

function groupByDomain(docs: ScopedDoc[]): Map<AnalyticsDomain, ScopedDoc[]> {
    const map = new Map<AnalyticsDomain, ScopedDoc[]>();
    for (const d of docs) {
        const list = map.get(d.domain) || [];
        list.push(d);
        map.set(d.domain, list);
    }
    return map;
}

export type DynamicIntent =
    | { kind: 'finance'; intent: string }
    | { kind: 'hr'; intent: 'ranking' | 'distribution' }
    | { kind: 'compliance'; intent: string }
    | { kind: 'procurement'; intent: 'supplier' | 'line_items' | 'overview' }
    | { kind: 'legal'; intent: 'mix' | 'overview' }
    | { kind: 'generic'; intent: 'doc_mix' | 'overview' }
    | { kind: 'auto' };

function detectQuestionDomains(question: string): AnalyticsDomain[] {
    const q = question.toLowerCase();
    const found: AnalyticsDomain[] = [];
    if (/\b(invoice|vendor|spend|payable|expense|finance|bank statement|receipt)\b/.test(q)) {
        found.push('finance');
    }
    if (/\b(resume|cv|candidate|hiring|offer letter|experience letter|hr)\b/.test(q)) {
        found.push('hr');
    }
    if (/\b(certificate|audit|compliance|expiry|sop|iso|inspection)\b/.test(q)) {
        found.push('compliance');
    }
    if (/\b(purchase.?order|\bpo\b|quotation|rfq|procurement|supplier)\b/.test(q)) {
        found.push('procurement');
    }
    if (/\b(contract|nda|agreement|lease|legal)\b/.test(q)) {
        found.push('legal');
    }
    return found;
}

export function wantsChartQuestion(question: string): boolean {
    return (
        wantsVisualization(question) ||
        /\b(chart|graph|graphs|visual|visuals|visuali[sz]e|plot|plots|dashboard|analytics)\b/i.test(
            question
        )
    );
}

function wantsChart(question: string): boolean {
    return wantsChartQuestion(question);
}

/** Prefer question intent; fall back to domains present in scope. */
export function planAnalyticsRun(params: {
    question: string;
    phase3Agent?: string;
    scoped: ScopedDoc[];
}): AnalyticsDomain[] {
    const byDomain = groupByDomain(params.scoped);
    const fromQuestion = detectQuestionDomains(params.question);
    const agentHint = params.phase3Agent
        ? domainForDocType(
              params.phase3Agent.replace(/_agent$/, '') === 'finance'
                  ? 'invoice'
                  : params.phase3Agent.replace(/_agent$/, '') === 'hr'
                    ? 'resume'
                    : params.phase3Agent.replace(/_agent$/, '') === 'compliance'
                      ? 'certificate'
                      : params.phase3Agent.replace(/_agent$/, '') === 'procurement'
                        ? 'purchase_order'
                        : params.phase3Agent.replace(/_agent$/, '') === 'legal'
                          ? 'contract'
                          : 'other'
          )
        : null;

    let agentDomain: AnalyticsDomain | null = null;
    if (params.phase3Agent === FINANCE_AGENT) agentDomain = 'finance';
    else if (params.phase3Agent === HR_AGENT) agentDomain = 'hr';
    else if (params.phase3Agent === COMPLIANCE_AGENT) agentDomain = 'compliance';
    else if (params.phase3Agent === 'procurement_agent') agentDomain = 'procurement';
    else if (params.phase3Agent === 'legal_agent') agentDomain = 'legal';
    else if (params.phase3Agent === 'other_agent') agentDomain = 'generic';
    else if (agentHint && agentHint !== 'generic') agentDomain = agentHint;

    // Selected agent wins — never fan out to other agents' document types.
    if (agentDomain) {
        return byDomain.has(agentDomain) ? [agentDomain] : [];
    }

    const ordered: AnalyticsDomain[] = [];
    const add = (d: AnalyticsDomain) => {
        if (byDomain.has(d) && !ordered.includes(d)) ordered.push(d);
    };

    for (const d of fromQuestion) add(d);

    // Scope-first: every domain present in selection
    for (const d of byDomain.keys()) add(d);

    // If nothing matched but we have docs, run all domains in scope
    if (!ordered.length && params.scoped.length) {
        return [...byDomain.keys()];
    }
    return ordered;
}

function parseHrIntent(question: string, phase3Agent?: string): HrVisualIntent {
    const classified = classifyHrWorkIntent(question, phase3Agent || HR_AGENT);
    const tool = classified?.tool;
    const analytics: HrWorkTool[] = [
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
    ];
    if (tool && analytics.includes(tool)) return tool as HrVisualIntent;
    const q = question.toLowerCase();
    if (/\b(distribution|histogram|bucket|spread)\b/.test(q)) return 'distribution';
    if (/\b(leave|payroll|attendance|cert|onboarding|performance|transcript|directory)\b/.test(q)) {
        return (detectFallbackHrIntent(q) || 'overview') as HrVisualIntent;
    }
    return 'ranking';
}

function detectFallbackHrIntent(q: string): HrVisualIntent | null {
    if (/\bleave\b/.test(q)) return 'leave';
    if (/\bpayroll|salary\b/.test(q)) return 'payroll';
    if (/\battendance\b/.test(q)) return 'attendance';
    if (/\bcert\b/.test(q)) return 'certs';
    if (/\bonboarding\b/.test(q)) return 'onboarding';
    if (/\bperformance|appraisal\b/.test(q)) return 'performance';
    if (/\btranscript|gpa\b/.test(q)) return 'transcript';
    if (/\bdirectory|employee\b/.test(q)) return 'directory';
    return null;
}

function parseComplianceIntent(question: string): string {
    const q = question.toLowerCase();
    if (/\b(finding|severity|audit)\b/.test(q)) return 'findings';
    if (/\b(expiry|expire|valid)\b/.test(q)) return 'expiry';
    if (/\b(cert|certificate)\b/.test(q) && /\b(status)\b/.test(q)) return 'cert_status';
    if (/\b(status|mix)\b/.test(q)) return 'status_mix';
    return 'overview';
}

async function buildDocTypeMixVisual(
    docs: ScopedDoc[],
    agentId: string
): Promise<ChatVisualSpec> {
    const counts = new Map<string, { count: number; ids: string[] }>();
    for (const d of docs) {
        const key = d.classification || 'other';
        const cur = counts.get(key) || { count: 0, ids: [] };
        cur.count += 1;
        cur.ids.push(d.documentId);
        counts.set(key, cur);
    }
    const data = [...counts.entries()]
        .sort((a, b) => b[1].count - a[1].count)
        .map(([type, v]) => ({
            type: type.replace(/_/g, ' '),
            count: v.count,
            _documentIds: v.ids.join(','),
        }));

    return {
        id: `mix_${Date.now()}`,
        agentId,
        kind: 'pie',
        title: 'Documents in scope by type',
        subtitle: `${docs.length} file(s) selected`,
        categoryKey: 'type',
        series: [{ key: 'count', label: 'Files', color: '#38b6ff' }],
        data,
        footer: 'Built from your chat scope — not a fixed agent dashboard.',
    };
}

function parseNumber(raw: unknown): number | null {
    if (raw == null) return null;
    if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
    const s = String(raw).replace(/,/g, '').replace(/[^\d.-]/g, '');
    const n = Number(s);
    return Number.isFinite(n) ? n : null;
}

async function extractionForDoc(
    doc: ScopedDoc,
    user: AuthUser
): Promise<Record<string, unknown>> {
    if (!doc.pythonDocumentId || !isAiServiceEnabled()) return {};
    try {
        const mongo = await Document.findOne({ documentId: doc.documentId }).lean();
        if (!mongo) return {};
        const orgId = resolveDocumentAiOrgId(mongo as any, user);
        const [extractions, aiDoc] = await Promise.all([
            getDocumentExtractions(doc.pythonDocumentId, orgId),
            getAiDocument(doc.pythonDocumentId, orgId),
        ]);
        const merged: Record<string, unknown> = {};
        if (aiDoc && typeof aiDoc === 'object') {
            const ed = (aiDoc as any).extracted_data;
            if (ed && typeof ed === 'object') Object.assign(merged, ed);
        }
        for (const row of extractions || []) {
            const data = row.extracted_data;
            if (data && typeof data === 'object') {
                for (const [k, v] of Object.entries(data as Record<string, unknown>)) {
                    if (v != null && v !== '' && merged[k] == null) merged[k] = v;
                }
            }
        }
        return merged;
    } catch {
        return {};
    }
}

/** Procurement / legal / generic: supplier or amount bars from extractions. */
async function executeGenericDomainAnalytics(
    user: AuthUser,
    docs: ScopedDoc[],
    domain: AnalyticsDomain,
    question: string
): Promise<{ visuals: ChatVisualSpec[]; answer: string; citations: AgentChatVisualResult['citations'] }> {
    const agentId = agentForDomain(domain);

    if (domain === 'legal' && detectLegalMissingDataAsk(question)) {
        const missing = await executeLegalMissingDataAnalytics(user, {
            documentIds: docs.map((d) => d.documentId),
        });
        return {
            visuals: missing.visuals,
            answer: missing.answer,
            citations: missing.citations,
        };
    }

    const mix = await buildDocTypeMixVisual(docs, agentId);
    const citations = docs.slice(0, 12).map((d) => ({
        documentId: d.documentId,
        filename: d.originalFilename,
        documentType: d.classification,
        phase3Agent: agentId,
    }));

    const q = question.toLowerCase();
    const wantItems =
        /\b(line[\s-]?items?|items?)\b/.test(q) || /\b(chart|graph|visual)\b/.test(q);

    const amountRows: Array<{ label: string; amount: number; documentId: string }> = [];
    const supplierMap = new Map<string, { amount: number; docs: Set<string> }>();
    const riskRows: Array<{ label: string; count: number; documentId: string }> = [];
    const clauseRows: Array<{ type: string; count: number }> = [];
    const poInvoiceRows: Array<{
        label: string;
        po: number;
        invoice: number;
        documentId: string;
    }> = [];

    if (wantItems || domain === 'procurement' || domain === 'legal' || domain === 'generic') {
        for (const doc of docs.slice(0, 40)) {
            const data = await extractionForDoc(doc, user);
            const total =
                parseNumber(data.total_amount) ??
                parseNumber(data.total) ??
                parseNumber(data.amount) ??
                parseNumber(data.grand_total) ??
                parseNumber(data.contract_value) ??
                parseNumber(data.po_amount);
            const party =
                scalarField(data.supplier_name) ||
                scalarField(data.vendor_name) ||
                scalarField(data.counterparty) ||
                scalarField(data.party_name) ||
                doc.originalFilename.slice(0, 28);

            if (total != null && total > 0) {
                amountRows.push({
                    label:
                        doc.originalFilename.length > 28
                            ? `${doc.originalFilename.slice(0, 26)}…`
                            : doc.originalFilename,
                    amount: total,
                    documentId: doc.documentId,
                });
                const key = canonicalizePartyName(party) || party.toLowerCase();
                const cur = supplierMap.get(key) || { amount: 0, docs: new Set<string>() };
                cur.amount += total;
                cur.docs.add(doc.documentId);
                supplierMap.set(key, cur);
            }

            // Legal: risk + clause mix
            if (domain === 'legal') {
                const risks = Array.isArray(data.risks)
                    ? data.risks
                    : Array.isArray(data.risk_flags)
                      ? data.risk_flags
                      : Array.isArray(data.identified_risks)
                        ? data.identified_risks
                        : [];
                if (risks.length) {
                    riskRows.push({
                        label:
                            doc.originalFilename.length > 28
                                ? `${doc.originalFilename.slice(0, 26)}…`
                                : doc.originalFilename,
                        count: risks.length,
                        documentId: doc.documentId,
                    });
                }
                const clauses = Array.isArray(data.clauses)
                    ? data.clauses
                    : Array.isArray(data.key_clauses)
                      ? data.key_clauses
                      : [];
                for (const c of clauses) {
                    const t =
                        typeof c === 'string'
                            ? c
                            : scalarField((c as any)?.type) ||
                              scalarField((c as any)?.name) ||
                              scalarField((c as any)?.title) ||
                              'clause';
                    const key = t.toLowerCase().slice(0, 40);
                    const existing = clauseRows.find((r) => r.type === key);
                    if (existing) existing.count += 1;
                    else clauseRows.push({ type: key, count: 1 });
                }
            }

            // Procurement: PO vs invoice amounts on same doc / paired fields
            if (domain === 'procurement') {
                const poAmt =
                    parseNumber(data.po_amount) ??
                    parseNumber(data.purchase_order_amount) ??
                    (doc.classification.includes('purchase') || doc.classification === 'po'
                        ? total
                        : null);
                const invAmt =
                    parseNumber(data.invoice_amount) ??
                    parseNumber(data.matched_invoice_amount) ??
                    (doc.classification === 'invoice' ? total : null);
                if (poAmt != null || invAmt != null) {
                    poInvoiceRows.push({
                        label:
                            doc.originalFilename.length > 24
                                ? `${doc.originalFilename.slice(0, 22)}…`
                                : doc.originalFilename,
                        po: poAmt ?? 0,
                        invoice: invAmt ?? 0,
                        documentId: doc.documentId,
                    });
                }
            }
        }
    }

    const visuals: ChatVisualSpec[] = [];
    // Multi-file portfolios get a type mix; a single named file should not
    if (docs.length > 1) {
        visuals.push(mix);
    }

    if (domain === 'legal' && riskRows.length) {
        visuals.unshift({
            id: `legal_risk_${Date.now()}`,
            agentId,
            kind: 'bar',
            title: 'Risk flags by document',
            subtitle: `${riskRows.length} contract(s) with extracted risks`,
            categoryKey: 'label',
            series: [{ key: 'count', label: 'Risks', color: '#e11d48' }],
            data: riskRows.map((r) => ({
                label: r.label,
                count: r.count,
                _documentIds: r.documentId,
            })),
            sourceDocumentIds: riskRows.map((r) => r.documentId),
            footer: 'Counts from risks / risk_flags in extractions — reprocess if empty.',
        });
    }
    if (domain === 'legal' && clauseRows.length) {
        const distinctTypes = new Set(clauseRows.map((r) => r.type));
        const genericOnly = distinctTypes.size === 1 && distinctTypes.has('clause');
        if (!genericOnly && distinctTypes.size >= 2) {
            visuals.unshift({
                id: `legal_clause_${Date.now()}`,
                agentId,
                kind: 'pie',
                title: 'Clause type mix',
                subtitle: `${clauseRows.reduce((n, r) => n + r.count, 0)} clause(s)`,
                categoryKey: 'type',
                series: [{ key: 'count', label: 'Clauses', color: '#7c3aed' }],
                data: clauseRows
                    .sort((a, b) => b.count - a.count)
                    .slice(0, 12)
                    .map((r) => ({ type: r.type, count: r.count })),
                sourceDocumentIds: docs.map((d) => d.documentId),
                footer: 'From clauses / key_clauses extraction fields.',
            });
        }
    }
    if (domain === 'procurement' && poInvoiceRows.length) {
        visuals.unshift({
            id: `proc_po_inv_${Date.now()}`,
            agentId,
            kind: 'bar',
            title: 'PO vs invoice amounts',
            subtitle: `${poInvoiceRows.length} file(s) with PO/invoice totals`,
            categoryKey: 'label',
            series: [
                { key: 'po', label: 'PO', color: '#0ea5e9' },
                { key: 'invoice', label: 'Invoice', color: '#f59e0b' },
            ],
            data: poInvoiceRows.map((r) => ({
                label: r.label,
                po: Math.round(r.po * 100) / 100,
                invoice: Math.round(r.invoice * 100) / 100,
                _documentIds: r.documentId,
            })),
            sourceDocumentIds: poInvoiceRows.map((r) => r.documentId),
            footer: 'Side-by-side PO and invoice totals from extractions (validation view).',
        });
    }

    if (docs.length === 1 && amountRows.length > 0 && !visuals.some((v) => v.kind === 'bar' && /amount|value/i.test(v.title))) {
        visuals.unshift({
            id: `amt_one_${Date.now()}`,
            agentId,
            kind: 'bar',
            title: domain === 'legal' ? 'Contract / agreement value' : 'Document amount',
            subtitle: docs[0].originalFilename,
            categoryKey: 'label',
            series: [{ key: 'amount', label: 'Amount', color: '#6366f1' }],
            data: amountRows.map((r) => ({
                label: r.label,
                amount: Math.round(r.amount * 100) / 100,
                _documentIds: r.documentId,
            })),
            sourceDocumentIds: [docs[0].documentId],
            dataQuality: { level: 'high' },
            footer: `Only this file · ${docs[0].originalFilename}`,
        });
    } else if (supplierMap.size > 0 && (domain === 'procurement' || /\b(supplier|vendor)\b/.test(q))) {
        const data = [...supplierMap.entries()]
            .sort((a, b) => b[1].amount - a[1].amount)
            .slice(0, 20)
            .map(([name, v]) => ({
                supplier: name.slice(0, 32),
                amount: Math.round(v.amount * 100) / 100,
                _documentIds: [...v.docs].join(','),
            }));
        visuals.unshift({
            id: `proc_supplier_${Date.now()}`,
            agentId,
            kind: 'bar',
            title: domain === 'legal' ? 'Value by party' : 'Spend by supplier',
            subtitle: `From ${docs.length} scoped file(s)`,
            categoryKey: 'supplier',
            series: [{ key: 'amount', label: 'Amount', color: '#0ea5e9' }],
            data,
            sourceDocumentIds: docs.map((d) => d.documentId),
            footer: 'Amounts from document extractions in your scope.',
        });
    } else if (amountRows.length > 0 && !visuals.some((v) => /Amounts by document|Document amount/i.test(v.title))) {
        visuals.unshift({
            id: `amt_${Date.now()}`,
            agentId,
            kind: 'bar',
            title: 'Amounts by document',
            subtitle: `${amountRows.length} file(s) with extracted totals`,
            categoryKey: 'label',
            series: [{ key: 'amount', label: 'Amount', color: '#6366f1' }],
            data: amountRows.map((r) => ({
                label: r.label,
                amount: Math.round(r.amount * 100) / 100,
                _documentIds: r.documentId,
            })),
            sourceDocumentIds: amountRows.map((r) => r.documentId),
            footer: 'One bar per scoped document with a total in extraction.',
        });
    } else if (!visuals.length) {
        visuals.push(mix);
    }

    const domainLabel =
        domain === 'procurement'
            ? 'procurement'
            : domain === 'legal'
              ? 'legal'
              : 'library';

    const answer =
        docs.length === 1
            ? [
                  `**${docs[0].originalFilename}** (${domainLabel})`,
                  amountRows.length
                      ? `Extracted total: **${Math.round(amountRows[0].amount * 100) / 100}** where available.`
                      : riskRows.length
                        ? `**${riskRows[0].count}** risk flag(s) extracted from this agreement.`
                        : clauseRows.length
                          ? `**${clauseRows.reduce((n, c) => n + c.count, 0)}** clause reference(s) extracted.`
                          : `Document type: **${docs[0].classification.replace(/_/g, ' ')}**.`,
              ].join('\n\n')
            : [
                  `Here’s what’s in your **${docs.length}** scoped ${domainLabel} file(s).`,
                  visuals.length > 1
                      ? `I charted extracted amounts where available${
                            domain === 'legal'
                                ? ', plus risk/clause views'
                                : domain === 'procurement'
                                  ? ', including PO vs invoice where present'
                                  : ''
                        }.`
                      : `I charted document types in scope. If you expected amounts, open a file and reprocess so totals are extracted.`,
              ]
                  .filter(Boolean)
                  .join(' ');

    return { visuals, answer, citations };
}

function conversationalFinanceAnswer(
    raw: string,
    visualTitles: string[],
    opts?: { filenames?: string[]; singleDoc?: boolean }
): string {
    const cleaned = raw
        .replace(/^\*\*Finance insights\*\*[^\n]*/i, '')
        .replace(/^\*\*Finance analytics\*\*\s*/i, '')
        .replace(/^\*\*Line items\*\*[^\n]*/i, 'Line items from this invoice:')
        .trim();
    const names = (opts?.filenames || []).filter(Boolean);
    const fileBit =
        opts?.singleDoc && names.length === 1
            ? `**${names[0]}** only`
            : names.length
              ? `**${names.length}** scoped file(s)`
              : 'your selected finance documents';
    const lead =
        visualTitles.length > 0
            ? opts?.singleDoc && names.length === 1
                ? `Analytics for ${fileBit} — ${visualTitles.join(', ')}.`
                : `Portfolio view across ${fileBit} — ${visualTitles.join(', ')}.`
            : `I looked at ${fileBit}.`;
    if (!cleaned) return `${lead}`;
    return `${lead}\n\n${cleaned}`;
}

function conversationalHrAnswer(raw: string): string {
    return raw
        .replace(/^\*\*HR ranking\*\*\s*—\s*/i, 'Here’s the ranking from your scoped CVs — ')
        .replace(/^\*\*CV score distribution\*\*/i, 'Here’s the CV score distribution')
        .replace(/\nCharts in the analytics panel[^\n]*/i, '\nCharts are in the analytics panel.');
}

function conversationalComplianceAnswer(raw: string): string {
    return raw
        .replace(/^\*\*[^*]+\*\*\s*—?\s*/i, (m) => m.replace(/\*\*/g, ''))
        .trim();
}

export type DynamicAnalyticsResult = {
    handled: boolean;
    answer?: string;
    visuals?: ChatVisualSpec[];
    citations?: AgentChatVisualResult['citations'];
    agentId?: string;
    domains?: AnalyticsDomain[];
    documentCount?: number;
    coverage?: import('../types/chatVisuals').FinanceAnalyticsCoverage;
    analyticsView?: string;
};

/**
 * Main entry: build charts from scoped documents + question.
 * Runs every relevant domain strategy for files in scope (parallel).
 */
export async function runDynamicAnalytics(params: {
    user: AuthUser;
    question: string;
    phase3Agent?: string;
    documentIds?: string[];
    focusDocumentIds?: string[];
    sessionId?: string;
    /** Force dashboard-style run even without chart keywords */
    force?: boolean;
}): Promise<DynamicAnalyticsResult> {
    const started = Date.now();
    const chartAsk = wantsChart(params.question) || wantsAgentAnalyticsVisual(params.question, params.phase3Agent) || Boolean(params.force);
    if (!chartAsk && !params.force) {
        return { handled: false };
    }

    const sessionFocus = await getSessionFocusDocumentIds(params.sessionId);
    const mergedFocus = [
        ...new Set([...(params.focusDocumentIds || []), ...sessionFocus]),
    ].filter(Boolean);

    const financeExtractionCache = createFinanceExtractionCache();
    const extractionStats = { hits: 0, misses: 0 };

    const portfolioScope =
        wantsPortfolioFinanceScope(params.question) &&
        (!params.phase3Agent || params.phase3Agent === FINANCE_AGENT);
    const financeScoped = !params.phase3Agent || params.phase3Agent === FINANCE_AGENT;

    let scopedIds = params.documentIds;
    if (portfolioScope) {
        scopedIds = await resolveFinancePortfolioDocumentIds(params.user, params.documentIds);
    }
    let namedFileLock = false;
    let financeIntentLogged = '-';

    // Dynamic: if the user names a file/vendor (e.g. glectronic), chart ONLY that file
    if (
        financeScoped &&
        !portfolioScope &&
        params.documentIds?.length &&
        extractDocumentNameTokens(params.question).length
    ) {
        const pool = await loadScopedDocuments(params.user, params.documentIds);
        let vendorById = new Map<string, string>();
        try {
            const records = await loadFinanceRecords(params.user, {
                documentIds: params.documentIds,
                maxDocs: params.documentIds.length,
                extractionCache: financeExtractionCache,
                extractionStats,
            });
            vendorById = new Map(records.map((r) => [r.documentId, r.vendor]));
        } catch {
            /* vendor hints optional */
        }
        const byName = matchDocumentIdsByNameTokens(
            pool.map((d) => ({
                documentId: d.documentId,
                originalFilename: d.originalFilename,
                searchText: enrichSearchTextForDoc(
                    d.originalFilename,
                    vendorById.get(d.documentId) || ''
                ),
            })),
            params.question
        );
        if (byName.length) {
            scopedIds = byName.slice(0, 1);
            namedFileLock = true;
        }
    }

    if (portfolioScope && scopedIds?.length) {
        namedFileLock = false;
    }

    // Explicit single focus (Chart chip / session) → never silently chart the whole scope
    if (
        !portfolioScope &&
        !namedFileLock &&
        mergedFocus.length === 1 &&
        chartAsk &&
        (!params.documentIds?.length || params.documentIds.includes(mergedFocus[0]))
    ) {
        scopedIds = [mergedFocus[0]];
        namedFileLock = true;
    }

    if (
        financeScoped &&
        !portfolioScope &&
        !namedFileLock &&
        (scopedIds?.length || mergedFocus.length)
    ) {
        const narrowed = await narrowFinanceDocumentIds({
            user: params.user,
            question: params.question,
            scopedIds: params.documentIds,
            focusIds: mergedFocus,
            portfolioScope,
        });
        if (
            questionRefersToSpecificDocument(params.question) &&
            (params.documentIds?.length || 0) > 1 &&
            !mergedFocus.length
        ) {
            const named = await resolveFinanceDocumentIdsFromQuestion(params.user, params.question, {
                preferIds: params.documentIds,
            });
            if (!named?.length) {
                logAnalyticsResolve({
                    question: params.question,
                    phase3Agent: params.phase3Agent,
                    scopedIn: params.documentIds?.length,
                    namedLock: false,
                    intent: 'clarify',
                });
                return {
                    handled: true,
                    agentId: params.phase3Agent || FINANCE_AGENT,
                    answer:
                        'Which document do you mean by “that”? Say the file name (e.g. digilog or bata), or narrow Document scope to one file — I’ll chart only that one.',
                    visuals: [],
                    documentCount: params.documentIds?.length || 0,
                };
            }
            scopedIds = named.slice(0, 1);
            namedFileLock = true;
        } else if (narrowed?.length) {
            scopedIds = narrowed;
            namedFileLock = narrowed.length === 1 && (params.documentIds?.length || 0) > 1;
        }
    }

    let scoped = await loadScopedDocuments(params.user, scopedIds);
    if (params.phase3Agent) {
        scoped = filterScopedDocsByAgent(scoped, params.phase3Agent);
    }
    // Focus/citation from another agent (e.g. a CV while on Finance) — use this agent's files instead.
    if (!scoped.length && params.phase3Agent && params.documentIds?.length) {
        namedFileLock = false;
        scoped = filterScopedDocsByAgent(
            await loadScopedDocuments(params.user, params.documentIds),
            params.phase3Agent
        );
    }
    if (!scoped.length) {
        if (!chartAsk) return { handled: false };
        return {
            handled: true,
            agentId: params.phase3Agent || FINANCE_AGENT,
            answer:
                'Select the documents you care about in **Document scope**, then ask again for a chart. Analytics always follow that selection.',
            visuals: [],
            documentCount: 0,
        };
    }

    const domains = planAnalyticsRun({
        question: params.question,
        phase3Agent: params.phase3Agent,
        scoped,
    });

    if (!domains.length) {
        return {
            handled: true,
            agentId: params.phase3Agent || 'other_agent',
            answer: `You have **${scoped.length}** file(s) in scope, but I couldn’t map them to a chart type yet. Try asking for a specific view (e.g. vendor totals, CV scores, certificate expiry).`,
            visuals: [],
            documentCount: scoped.length,
        };
    }

    const byDomain = groupByDomain(scoped);
    const visuals: ChatVisualSpec[] = [];
    const citations: NonNullable<AgentChatVisualResult['citations']> = [];
    const answerParts: string[] = [];
    let primaryAgent = params.phase3Agent || agentForDomain(domains[0]);
    let financeCoverage: import('../types/chatVisuals').FinanceAnalyticsCoverage | undefined;
    let financeAnalyticsView: string | undefined;

    await Promise.all(
        domains.map(async (domain) => {
            const docs = byDomain.get(domain) || [];
            if (!docs.length) return;
            const ids = docs.map((d) => d.documentId);

            try {
                if (domain === 'finance') {
                    const portfolioFinance = wantsPortfolioFinanceScope(params.question);
                    const singleDocIntent =
                        (ids.length === 1 || namedFileLock) && !portfolioFinance;
                    const intent = parseFinanceIntent(params.question, {
                        singleDoc: singleDocIntent,
                    }) as any;
                    financeIntentLogged = intent;
                    const result = await executeFinanceAnalytics(params.user, intent, {
                        documentIds: ids,
                        extractionCache: financeExtractionCache,
                        extractionStats,
                        preferredCurrency: detectCurrencyPreference(params.question),
                    });
                    financeCoverage = result.coverage ?? financeCoverage;
                    financeAnalyticsView = mapFinanceIntentToPanelView(intent);
                    visuals.push(...(result.visuals || []));
                    citations.push(...(result.citations || []));
                    const singleDocLead =
                        (ids.length === 1 || namedFileLock) &&
                        !portfolioFinance &&
                        !wantsMonthlyTrendQuestion(params.question);
                    answerParts.push(
                        conversationalFinanceAnswer(
                            result.answer,
                            (result.visuals || []).map((v) => v.title),
                            {
                                filenames: docs.map((d) => d.originalFilename),
                                singleDoc: singleDocLead,
                            }
                        )
                    );
                    if (!params.phase3Agent || params.phase3Agent === FINANCE_AGENT) {
                        primaryAgent = FINANCE_AGENT;
                    }
                } else if (domain === 'hr') {
                    const intent = parseHrIntent(params.question, params.phase3Agent);
                    if (intent === 'ranking' || intent === 'distribution') {
                        const result = await executeHrCharts(params.user, 15, ids, intent);
                        visuals.push(...(result.visuals || []));
                        citations.push(...(result.citations || []));
                        answerParts.push(conversationalHrAnswer(result.answer));
                    } else {
                        const result = await executeHrPortfolioAnalytics(
                            params.user,
                            intent,
                            ids,
                            15
                        );
                        visuals.push(...(result.visuals || []));
                        citations.push(...(result.citations || []));
                        answerParts.push(conversationalHrAnswer(result.answer));
                    }
                    if (!domains.includes('finance')) primaryAgent = HR_AGENT;
                } else if (domain === 'compliance') {
                    const intent = parseComplianceIntent(params.question) as any;
                    const result = await executeComplianceAnalytics(params.user, intent, {
                        documentIds: ids,
                    });
                    visuals.push(...(result.visuals || []));
                    citations.push(...(result.citations || []));
                    answerParts.push(conversationalComplianceAnswer(result.answer));
                    if (domains.length === 1) primaryAgent = COMPLIANCE_AGENT;
                } else {
                    const result = await executeGenericDomainAnalytics(
                        params.user,
                        docs,
                        domain,
                        params.question
                    );
                    visuals.push(...result.visuals);
                    citations.push(...(result.citations || []));
                    answerParts.push(result.answer);
                    if (domains.length === 1) primaryAgent = agentForDomain(domain);
                }
            } catch (e: any) {
                answerParts.push(
                    `Couldn’t build ${domain} charts: ${e?.message || 'unknown error'}.`
                );
            }
        })
    );

    // Scope mix only for multi-file / multi-type portfolios — not when user named one file
    const uniqueTypes = new Set(scoped.map((d) => d.classification));
    if (
        !namedFileLock &&
        scoped.length > 1 &&
        uniqueTypes.size > 1 &&
        !visuals.some((v) => /by type/i.test(v.title))
    ) {
        visuals.push(await buildDocTypeMixVisual(scoped, primaryAgent));
    }

    const uniqueCitations = citations.filter(
        (c, i, arr) => arr.findIndex((x) => x.documentId === c.documentId) === i
    );

    if (!visuals.length) {
        return {
            handled: true,
            agentId: primaryAgent,
            answer:
                answerParts.join('\n\n') ||
                `I checked **${scoped.length}** scoped file(s) but don’t have chartable extraction fields yet. Open a document, wait until processing finishes, or reprocess — then ask again.`,
            visuals: [],
            citations: uniqueCitations,
            domains,
            documentCount: scoped.length,
            coverage: financeCoverage,
            analyticsView: financeAnalyticsView,
        };
    }

    const multi = domains.length > 1;
    const lead = multi
        ? `Your scope covers **${domains.join(', ')}** documents (${scoped.length} files). I built charts for each relevant type.`
        : undefined;

    logAnalyticsResolve({
        question: params.question,
        phase3Agent: params.phase3Agent || primaryAgent,
        scopedIn: params.documentIds?.length,
        resolvedIds: scoped.map((d) => d.documentId),
        namedLock: namedFileLock,
        domains,
        intent: financeIntentLogged,
        visualCount: visuals.length,
        extractionHits: extractionStats.hits,
        extractionMisses: extractionStats.misses,
        elapsedMs: Date.now() - started,
    });

    return applyAgentVisualPolicy(
        {
            handled: true,
            agentId: params.phase3Agent || primaryAgent,
            answer: [lead, ...answerParts].filter(Boolean).join('\n\n'),
            visuals,
            citations: uniqueCitations,
            domains,
            documentCount: scoped.length,
            coverage: financeCoverage,
            analyticsView: financeAnalyticsView,
        },
        params.question,
        params.phase3Agent || primaryAgent
    );
}

/** Dashboard entry used by GET /chat/analytics — still scope-first. */
export async function runDynamicDashboard(params: {
    user: AuthUser;
    agentId: string;
    view?: string;
    documentIds?: string[];
}): Promise<DynamicAnalyticsResult> {
    const questionFromView = (() => {
        const v = params.view || 'overview';
        const map: Record<string, string> = {
            vendors: 'chart vendor spend',
            clients: 'chart client spend',
            trend: 'chart monthly trend',
            aging: 'show aging',
            mix: 'document type mix',
            expiry: 'chart certificate expiry',
            findings: 'audit findings by severity',
            cert_status: 'certificate status',
            status_mix: 'compliance status mix',
            scores: 'chart top CV scores',
            score_dist: 'CV score distribution',
            risk: 'contract risk overview',
            clauses: 'clause type mix',
            obligations: 'contract obligations overview',
            po_spend: 'po spend by supplier',
            po_status: 'purchase order status mix',
            doc_mix: 'document type mix',
            missing: 'show missing extraction fields chart',
            overview: 'show analytics overview chart',
        };
        return map[v] || 'show analytics overview chart';
    })();

    return runDynamicAnalytics({
        user: params.user,
        question: questionFromView,
        phase3Agent: params.agentId,
        documentIds: params.documentIds,
        force: true,
    });
}
