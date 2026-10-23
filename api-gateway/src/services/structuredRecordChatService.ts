/**
 * Generic Integration Pipeline chat — query structured JSON records (Path 2)
 * for any provider/recordType. Works the same for every agent workspace;
 * filters by phase3Agent flags and shows field summaries per record type.
 * Task create/assign/list lives in integrationTaskChatService.
 */
import Document from '../models/Document';
import { AuthUser, buildDocumentFilter } from './accessScope';
import { formatAgentHeading, formatAgentIntro } from './agentResponseFormat';

export type StructuredRecordChatResult = {
    handled: boolean;
    answer?: string;
    citations?: Array<{
        documentId: string;
        filename?: string;
        documentType?: string;
        phase3Agent?: string;
    }>;
};

type RecordRow = {
    documentId: string;
    title: string;
    recordType: string;
    source: string;
    classification: string;
    phase3Agent?: string;
    summary: string;
    data: Record<string, unknown>;
};

const AGENT_META_FLAG: Record<string, string> = {
    hr_agent: 'structuredHrRecord',
    finance_agent: 'structuredFinanceRecord',
    compliance_agent: 'structuredComplianceRecord',
    legal_agent: 'structuredLegalRecord',
    procurement_agent: 'structuredProcurementRecord',
    other_agent: 'structuredOtherRecord',
};

const AGENT_LABEL: Record<string, string> = {
    hr_agent: 'HR',
    finance_agent: 'Finance',
    compliance_agent: 'Compliance',
    legal_agent: 'Legal',
    procurement_agent: 'Procurement',
    other_agent: 'General',
};

/** Preferred summary fields per record type (universal Path 2). */
const RECORD_TYPE_FIELDS: Record<string, string[]> = {
    // HR
    candidate: ['name', 'email', 'candidateEmail', 'status', 'role', 'title', 'score', 'cvScore'],
    employee: ['name', 'email', 'department', 'title', 'status', 'employeeId'],
    resume: ['name', 'email', 'title', 'skills', 'experience'],
    payroll: ['employee', 'name', 'period', 'amount', 'netPay', 'status'],
    leave: ['employee', 'name', 'type', 'status', 'startDate', 'endDate'],
    attendance: ['employee', 'name', 'date', 'status', 'checkIn', 'checkOut'],
    performance: ['employee', 'name', 'score', 'period', 'status'],
    // Finance
    invoice: ['invoiceNumber', 'number', 'vendor', 'customer', 'amount', 'total', 'status', 'dueDate', 'currency'],
    expense: ['vendor', 'category', 'amount', 'total', 'status', 'date', 'employee'],
    payment: ['amount', 'total', 'status', 'method', 'reference', 'date', 'vendor'],
    tax: ['period', 'amount', 'total', 'status', 'jurisdiction', 'type'],
    bank_statement: ['account', 'period', 'balance', 'currency', 'bank'],
    budget: ['name', 'department', 'amount', 'total', 'period', 'status'],
    finance_report: ['title', 'name', 'period', 'status', 'amount'],
    // Procurement
    purchase_order: ['poNumber', 'number', 'vendor', 'supplier', 'amount', 'total', 'status', 'deliveryDate'],
    po: ['poNumber', 'number', 'vendor', 'supplier', 'amount', 'total', 'status'],
    quotation: ['vendor', 'supplier', 'amount', 'total', 'status', 'validUntil'],
    rfq: ['title', 'name', 'status', 'deadline', 'vendor'],
    supplier: ['name', 'vendor', 'email', 'status', 'category'],
    delivery_note: ['poNumber', 'vendor', 'status', 'date', 'items'],
    procurement_request: ['title', 'name', 'requester', 'status', 'amount', 'department'],
    // Compliance
    certificate: ['name', 'title', 'issuer', 'issuingAuthority', 'expiryDate', 'validUntil', 'status'],
    compliance: ['title', 'name', 'status', 'framework', 'owner'],
    audit: ['title', 'name', 'status', 'date', 'auditor', 'finding'],
    inspection: ['title', 'name', 'status', 'date', 'location', 'result'],
    capa: ['title', 'name', 'status', 'owner', 'dueDate'],
    sop: ['title', 'name', 'version', 'status', 'owner'],
    iso: ['title', 'name', 'standard', 'status', 'expiryDate'],
    // Legal
    contract: ['title', 'name', 'party', 'parties', 'counterparty', 'status', 'expiryDate', 'effectiveDate', 'value'],
    nda: ['title', 'name', 'party', 'counterparty', 'status', 'expiryDate', 'effectiveDate'],
    agreement: ['title', 'name', 'party', 'counterparty', 'status', 'expiryDate'],
    lease: ['title', 'name', 'property', 'tenant', 'landlord', 'status', 'expiryDate', 'rent'],
    vendor_contract: ['title', 'name', 'vendor', 'status', 'expiryDate', 'value'],
    // Generic / PM
    task: ['name', 'title', 'status', 'assignee', 'assignees', 'due_date', 'dueDate', 'list'],
    generic: ['name', 'title', 'status', 'amount', 'email', 'vendor'],
};

const AGENT_FALLBACK_FIELDS: Record<string, string[]> = {
    hr_agent: ['name', 'email', 'status', 'title', 'department', 'score'],
    finance_agent: ['name', 'title', 'vendor', 'amount', 'total', 'status', 'dueDate', 'currency'],
    compliance_agent: ['name', 'title', 'status', 'expiryDate', 'issuer', 'owner'],
    legal_agent: ['name', 'title', 'party', 'counterparty', 'status', 'expiryDate', 'value'],
    procurement_agent: ['name', 'title', 'vendor', 'supplier', 'amount', 'total', 'status', 'poNumber'],
    other_agent: ['name', 'title', 'status', 'amount', 'email', 'vendor'],
};

const DOMAIN_NOUNS =
    /\b(candidates?|employees?|resumes?|cvs?|payroll|leave|attendance|invoices?|expenses?|payments?|tax|taxes|budgets?|bank\s+statements?|purchase\s+orders?|\bpos?\b|quotations?|rfqs?|suppliers?|vendors?|delivery\s+notes?|contracts?|ndas?|agreements?|leases?|certificates?|audits?|inspections?|capas?|sops?|iso|compliance|tasks?)\b/i;

/** Detect asks about synced integration / API records (not file RAG). */
export function detectStructuredRecordAsk(question: string, phase3Agent?: string): boolean {
    const q = question.toLowerCase().trim();
    if (!q) return false;

    if (
        /\b(synced\s+records?|integration\s+records?|structured\s+(data|records?)|api\s+records?)\b/.test(
            q
        )
    ) {
        return true;
    }

    if (
        /\b(show|list|what|give|tell|find|check|how\s+many)\b/.test(q) &&
        /\b(synced|integration|from\s+(clickup|sap|odoo|dynamics|drive|ats|webhook))\b/.test(q)
    ) {
        return true;
    }

    // Explicit Path 2 record types (all agents)
    if (
        /\b(show|list|find|how\s+many|any|all)\b/.test(q) &&
        DOMAIN_NOUNS.test(q) &&
        /\b(synced|integration|record|records|from\s+)/.test(q)
    ) {
        return true;
    }

    // Agent workspace: same domain ask without requiring the word "synced"
    if (
        phase3Agent &&
        /\b(show|list|find|how\s+many|any|all|what)\b/.test(q) &&
        DOMAIN_NOUNS.test(q) &&
        !/\b(generate|create|draft|upload|pdf|letter)\b/.test(q)
    ) {
        // Prefer structured records when user is clearly asking about business objects
        // that map to Path 2 — still allow if they say "records" or provider names.
        if (
            /\b(record|records|synced|integration|api|json)\b/.test(q) ||
            /\b(from\s+(sap|odoo|dynamics|clickup|drive|ats))\b/.test(q) ||
            inferRecordTypeFromQuestion(question)
        ) {
            return true;
        }
    }

    return false;
}

function formatFieldValue(raw: unknown): string {
    if (raw == null || raw === '') return '';
    if (Array.isArray(raw)) {
        const names = raw
            .map((item) => {
                if (item && typeof item === 'object') {
                    const o = item as Record<string, unknown>;
                    return String(o.username || o.name || o.email || o.id || '').trim();
                }
                return String(item).trim();
            })
            .filter(Boolean);
        return names.slice(0, 3).join(', ');
    }
    if (typeof raw === 'object') {
        const o = raw as Record<string, unknown>;
        if (o.status != null) return String(o.status);
        if (o.name != null) return String(o.name);
        return '';
    }
    return String(raw).slice(0, 80);
}

export function pickSummaryFields(
    data: Record<string, unknown>,
    opts?: { recordType?: string; phase3Agent?: string }
): string {
    const type = String(opts?.recordType || 'generic').toLowerCase();
    const agent = opts?.phase3Agent || 'other_agent';
    const preferred = [
        ...(RECORD_TYPE_FIELDS[type] || []),
        ...(AGENT_FALLBACK_FIELDS[agent] || AGENT_FALLBACK_FIELDS.other_agent),
        'name',
        'title',
        'status',
        'email',
        'amount',
        'total',
        'vendor',
        'dueDate',
        'due_date',
    ];

    const seen = new Set<string>();
    const parts: string[] = [];
    for (const key of preferred) {
        if (seen.has(key)) continue;
        seen.add(key);
        const formatted = formatFieldValue(data[key]);
        if (!formatted) continue;
        parts.push(`${key}: ${formatted}`);
        if (parts.length >= 4) break;
    }
    if (!parts.length) {
        for (const k of Object.keys(data).slice(0, 6)) {
            const formatted = formatFieldValue(data[k]);
            if (!formatted) continue;
            parts.push(`${k}: ${formatted}`);
            if (parts.length >= 4) break;
        }
    }
    return parts.join(' · ') || '—';
}

function parseRecordFromDoc(doc: {
    documentId: string;
    originalFilename?: string | null;
    classification?: string | null;
    metadata?: Record<string, unknown> | null;
}): RecordRow | null {
    const meta = (doc.metadata || {}) as Record<string, unknown>;
    if (meta.ingestKind !== 'structured_record') return null;
    const data = (meta.structuredData || {}) as Record<string, unknown>;
    const recordType = String(meta.recordType || 'generic');
    const phase3Agent = meta.phase3Agent ? String(meta.phase3Agent) : undefined;
    const title =
        String(meta.title || data.name || data.title || doc.originalFilename || 'Record')
            .replace(/\.json$/i, '')
            .trim() || 'Record';
    return {
        documentId: doc.documentId,
        title,
        recordType,
        source: String(meta.source || meta.integrationLabel || 'integration'),
        classification: String(doc.classification || meta.classification || 'integration_record'),
        phase3Agent,
        summary: pickSummaryFields(data, { recordType, phase3Agent }),
        data,
    };
}

export async function loadStructuredRecords(
    user: AuthUser,
    opts?: {
        limit?: number;
        phase3Agent?: string;
        recordType?: string;
        source?: string;
        q?: string;
    }
): Promise<RecordRow[]> {
    const filter = await buildDocumentFilter(user, {});
    const limit = Math.min(80, Math.max(1, opts?.limit ?? 40));
    const query: Record<string, unknown> = {
        ...filter,
        status: 'ready',
        'metadata.ingestKind': 'structured_record',
    };

    if (opts?.phase3Agent) {
        const flag = AGENT_META_FLAG[opts.phase3Agent];
        if (flag) {
            query.$or = [
                { [`metadata.${flag}`]: true },
                { 'metadata.phase3Agent': opts.phase3Agent },
            ];
        } else {
            query['metadata.phase3Agent'] = opts.phase3Agent;
        }
    }
    if (opts?.recordType) {
        // Allow aliases (po ↔ purchase_order)
        if (opts.recordType === 'purchase_order' || opts.recordType === 'po') {
            query['metadata.recordType'] = { $in: ['purchase_order', 'po'] };
        } else if (opts.recordType === 'candidate' || opts.recordType === 'employee') {
            query['metadata.recordType'] = { $in: ['candidate', 'employee', 'resume'] };
        } else {
            query['metadata.recordType'] = opts.recordType;
        }
    }
    if (opts?.source) {
        query['metadata.source'] = new RegExp(
            String(opts.source).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
            'i'
        );
    }

    const docs = await Document.find(query)
        .select('documentId originalFilename classification metadata updatedAt')
        .sort({ updatedAt: -1 })
        .limit(limit * 2)
        .lean();

    let rows = docs
        .map((d) =>
            parseRecordFromDoc({
                documentId: d.documentId,
                originalFilename: d.originalFilename,
                classification: d.classification,
                metadata: d.metadata as Record<string, unknown> | undefined,
            })
        )
        .filter((r): r is RecordRow => Boolean(r));

    const needle = opts?.q?.toLowerCase().trim();
    if (needle) {
        rows = rows.filter(
            (r) =>
                r.title.toLowerCase().includes(needle) ||
                r.recordType.toLowerCase().includes(needle) ||
                r.source.toLowerCase().includes(needle) ||
                r.summary.toLowerCase().includes(needle)
        );
    }

    return rows.slice(0, limit);
}

export function inferRecordTypeFromQuestion(question: string): string | undefined {
    const q = question.toLowerCase();
    // HR
    if (/\bcandidates?\b|\bresumes?\b|\bcvs?\b/.test(q)) return 'candidate';
    if (/\bemployees?\b/.test(q)) return 'employee';
    if (/\bpayroll\b/.test(q)) return 'payroll';
    if (/\bleave\b/.test(q)) return 'leave';
    if (/\battendance\b/.test(q)) return 'attendance';
    if (/\bperformance\b/.test(q)) return 'performance';
    // Finance
    if (/\binvoices?\b/.test(q)) return 'invoice';
    if (/\bexpenses?\b/.test(q)) return 'expense';
    if (/\bpayments?\b/.test(q)) return 'payment';
    if (/\btax(es)?\b/.test(q)) return 'tax';
    if (/\bbank\s+statements?\b/.test(q)) return 'bank_statement';
    if (/\bbudgets?\b/.test(q)) return 'budget';
    // Procurement
    if (/\bpurchase\s+orders?\b|\bpo\b/.test(q)) return 'purchase_order';
    if (/\bquotations?\b|\bquotes?\b/.test(q)) return 'quotation';
    if (/\brfqs?\b/.test(q)) return 'rfq';
    if (/\bsuppliers?\b|\bvendors?\b/.test(q)) return 'supplier';
    if (/\bdelivery\s+notes?\b/.test(q)) return 'delivery_note';
    if (/\bprocurement\s+requests?\b/.test(q)) return 'procurement_request';
    // Compliance
    if (/\bcertificates?\b/.test(q)) return 'certificate';
    if (/\baudits?\b/.test(q)) return 'audit';
    if (/\binspections?\b/.test(q)) return 'inspection';
    if (/\bcapas?\b/.test(q)) return 'capa';
    if (/\bsops?\b/.test(q)) return 'sop';
    if (/\biso\b/.test(q)) return 'iso';
    // Legal
    if (/\bndas?\b/.test(q)) return 'nda';
    if (/\bleases?\b/.test(q)) return 'lease';
    if (/\bcontracts?\b/.test(q)) return 'contract';
    if (/\bagreements?\b/.test(q)) return 'agreement';
    // Tasks last (broad)
    if (/\btasks?\b/.test(q)) return 'task';
    return undefined;
}

function inferSourceFromQuestion(question: string): string | undefined {
    const q = question.toLowerCase();
    if (/\bclick\s*up\b|\bclickup\b/.test(q)) return 'clickup';
    if (/\bsap\b/.test(q)) return 'sap';
    if (/\bodoo\b/.test(q)) return 'odoo';
    if (/\bdynamics\b/.test(q)) return 'dynamics365';
    if (/\bdrive\b|\bgoogle\b/.test(q)) return 'google_drive';
    if (/\bwebhook\b/.test(q)) return 'custom_webhook';
    return undefined;
}

function buildTable(rows: RecordRow[]): string {
    const header = '| Title | Type | Source | Key fields |';
    const sep = '| --- | --- | --- | --- |';
    const body = rows.map(
        (r) =>
            `| ${r.title.replace(/\|/g, '/')} | ${r.recordType} | ${r.source} | ${r.summary.replace(/\|/g, '/')} |`
    );
    return [header, sep, ...body].join('\n');
}

function agentHeading(phase3Agent?: string): string {
    const label = phase3Agent ? AGENT_LABEL[phase3Agent] : undefined;
    return formatAgentHeading(label ? `Synced ${label} records` : 'Synced integration records', 2);
}

function emptyStateTips(phase3Agent?: string, recordType?: string): string {
    const examples: Record<string, string[]> = {
        hr_agent: [
            '`show synced candidates`',
            '`show synced employees`',
            '`process open tasks until done`',
        ],
        finance_agent: [
            '`show synced invoices`',
            '`list expenses`',
            '`process open tasks until done`',
        ],
        legal_agent: [
            '`list contracts`',
            '`show NDAs`',
            '`process open tasks until done`',
        ],
        compliance_agent: [
            '`how many certificates synced`',
            '`show audits`',
            '`process open tasks until done`',
        ],
        procurement_agent: [
            '`show purchase orders`',
            '`list suppliers`',
            '`process open tasks until done`',
        ],
        other_agent: [
            '`show synced records`',
            '`show synced tasks`',
            '`process open tasks until done`',
        ],
    };
    const lines = examples[phase3Agent || 'other_agent'] || examples.other_agent;
    const typeNote = recordType
        ? `_No **${recordType}** records yet for this agent. Try syncing that type, or ask:_`
        : '_Nothing synced for this agent yet. Try:_';
    return [typeNote, ...lines.map((l) => `- ${l}`)].join('\n');
}

export async function tryStructuredRecordCommand(params: {
    user: AuthUser;
    question: string;
    phase3Agent?: string;
}): Promise<StructuredRecordChatResult> {
    if (!detectStructuredRecordAsk(params.question, params.phase3Agent)) {
        return { handled: false };
    }

    // Task list/create/assign is owned by integrationTaskChatService — avoid double-handling
    // pure task asks here when they look like task board questions.
    const recordType = inferRecordTypeFromQuestion(params.question);
    if (recordType === 'task' && !/\b(synced\s+records?|integration\s+records?)\b/i.test(params.question)) {
        return { handled: false };
    }

    const source = inferSourceFromQuestion(params.question);
    const rows = await loadStructuredRecords(params.user, {
        phase3Agent: params.phase3Agent,
        recordType,
        source,
        limit: 40,
    });

    const agent = params.phase3Agent || 'other_agent';
    const heading = agentHeading(params.phase3Agent);
    const typeHint = recordType ? ` (**${recordType}**)` : '';
    const intro = formatAgentIntro(
        rows.length
            ? [
                  `Found **${rows.length}** synced record${rows.length === 1 ? '' : 's'}${typeHint} for this agent from Integrations (API/JSON).`,
                  'Fields below come from each record’s structured data for this domain.',
              ]
            : [
                  `No synced integration records match this question yet${typeHint}.`,
                  'Connect an integration, push/sync records tagged for this agent, then ask again.',
              ]
    );

    if (!rows.length) {
        const tips = emptyStateTips(params.phase3Agent, recordType);
        return {
            handled: true,
            answer: [heading, '', intro, '', tips].join('\n'),
            citations: [],
        };
    }

    const byType = new Map<string, number>();
    for (const r of rows) {
        byType.set(r.recordType, (byType.get(r.recordType) || 0) + 1);
    }
    const typeBreakdown =
        byType.size > 1
            ? `\n\n**By type:** ${[...byType.entries()]
                  .sort((a, b) => b[1] - a[1])
                  .map(([t, n]) => `${t} (${n})`)
                  .join(' · ')}`
            : '';

    const answer = [
        heading,
        '',
        intro,
        typeBreakdown,
        '',
        buildTable(rows),
        '',
        '_Integration pipeline records (structured data) — not uploaded PDF/DOCX files. Ask by type, e.g. “show synced invoices” / “list contracts” / “certificates”._',
    ].join('\n');

    return {
        handled: true,
        answer,
        citations: rows.slice(0, 12).map((r) => ({
            documentId: r.documentId,
            filename: `${r.title}.json`,
            documentType: r.classification || 'integration_record',
            phase3Agent: r.phase3Agent || agent,
        })),
    };
}
