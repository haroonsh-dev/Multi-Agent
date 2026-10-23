import Document from '../models/Document';
import { AuthUser } from './accessScope';
import { buildDocumentFilter } from './accessScope';
import { getDocumentExtractions, getAiDocument, resolveDocumentAiOrgId, isAiServiceEnabled } from './aiServiceClient';
import { canonicalizePartyName, partyRollupKey, resolveVendorDisplayName } from './financePartyNormalize';
import { normalizeFinanceUserQuestion, wantsFinanceListAllScope } from './financeQuestionNormalize';
import { getOrgFinanceSettings } from './orgFinanceSettingsService';
import type { ChatVisualDataRow, ChatVisualSpec, FinanceAnalyticsCoverage } from '../types/chatVisuals';
import { resolveCanonicalAgent } from './documentStorage';

export const FINANCE_AGENT = 'finance_agent';

export const FINANCE_DOC_TYPES = new Set([
    'invoice',
    'financial_statement',
    'expense_report',
    'payment_receipt',
    'tax_document',
    'bank_statement',
    'budget',
    'purchase_order',
    'po',
    'receipt',
    'delivery_note',
]);

/** Classifications excluded from automatic library-wide finance analytics (still allowed when explicitly in chat scope). */
export const FINANCE_ANALYTICS_EXCLUDED_CLASSIFICATIONS = new Set([
    'offer_letter',
    'resume',
    'transcript',
    'employment_contract',
    'leave_application',
    'quotation',
]);

export type FinanceRecord = {
    documentId: string;
    filename: string;
    vendor: string;
    client: string;
    total: number;
    currency: string;
    invoiceDate: Date | null;
    dueDate: Date | null;
    /** Mongo classification: invoice, purchase_order, receipt, … Used for PO↔invoice pairing. */
    classification?: string;
    /** Normalized PO / reference number for cross-doc matching. */
    poNumber?: string;
    /** Invoice number, used for duplicate detection. */
    invoiceNumber?: string;
    /** invoice = billable doc; payment = receipt applied against invoices; other = PO/etc. */
    recordKind?: 'invoice' | 'payment' | 'other';
    /** Payment receipt amount (same as total for payments). */
    amountPaid?: number;
    /** Free-text purpose from payment_for. */
    paymentFor?: string;
    /** Invoice number this payment is meant to settle (from invoice_number or payment_for). */
    paysInvoiceNumber?: string;
    /** Sum of matched payments applied to this invoice. */
    paidApplied?: number;
    /** Remaining balance after matched payments (defaults to total when unset). */
    outstanding?: number;
    /** Spreadsheet / invoice payment status when extracted (Paid, Pending, etc.). */
    paymentStatus?: string;
};

export type LoadFinanceOptions = {
    maxDocs?: number;
    documentIds?: string[];
    /** Reuse extraction payloads within one analytics request. */
    extractionCache?: Map<string, Record<string, unknown>>;
    extractionStats?: { hits: number; misses: number };
    vendorAliases?: Record<string, string>;
    baseCurrency?: string;
    preferredCurrency?: string;
};

export function createFinanceExtractionCache(): Map<string, Record<string, unknown>> {
    return new Map();
}

function parseNumber(raw: unknown): number | null {
    if (raw == null) return null;
    if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
    const s = String(raw).replace(/,/g, '').replace(/[^\d.-]/g, '');
    const n = Number(s);
    return Number.isFinite(n) ? n : null;
}

function parseDate(raw: unknown): Date | null {
    const s = scalarField(raw);
    if (!s) return null;
    const d = new Date(s);
    return Number.isNaN(d.getTime()) ? null : d;
}

/** Unwrap plain strings or grounding objects like { source_text: "..." }. */
export function scalarField(raw: unknown): string {
    if (raw == null) return '';
    if (typeof raw === 'string') return raw.trim();
    if (typeof raw === 'number' && Number.isFinite(raw)) return String(raw);
    if (typeof raw === 'object' && raw !== null) {
        const o = raw as Record<string, unknown>;
        if (typeof o.source_text === 'string') return o.source_text.trim();
        if (typeof o.value === 'string') return o.value.trim();
    }
    return '';
}

/** Scan raw OCR text for common client-block markers (Bill To, Sold To, Customer:). */
function pickClientFromRawText(rawText: string): string {
    if (!rawText || rawText.length < 3) return '';
    const patterns = [
        /(?:^|\n)\s*(?:bill\s*to|sold\s*to|customer|buyer|invoice\s*to|deliver\s*to)\s*[:\-]\s*(.+?)(?:\n|$)/i,
        /(?:^|\n)\s*(?:bill\s*to|sold\s*to|customer|buyer|invoice\s*to)\s*\n\s*(.+?)(?:\n|$)/i,
    ];
    for (const re of patterns) {
        const m = rawText.match(re);
        if (m) {
            let candidate = m[1].trim().replace(/[|]+/g, ' ').replace(/\s+/g, ' ');
            // Cap length + strip trailing phone/address tokens.
            if (candidate.length > 80) candidate = candidate.slice(0, 80);
            if (candidate.length >= 3 && !/^\d+$/.test(candidate)) return candidate;
        }
    }
    return '';
}

function pickClient(data: Record<string, unknown>): string {
    const client =
        scalarField(data.customer_name) ||
        scalarField(data.bill_to) ||
        scalarField(data.client_name) ||
        scalarField(data.buyer_name) ||
        scalarField(data.ship_to);
    if (client) return client;
    // Heuristic fallback: parse from OCR text (`Bill To: …`, `Customer: …`, etc.).
    const raw = typeof data._raw_text === 'string' ? (data._raw_text as string) : '';
    return pickClientFromRawText(raw);
}

function pickVendor(
    data: Record<string, unknown>,
    filenameHint?: string
): string {
    let vendor =
        scalarField(data.vendor_name) ||
        scalarField(data['Vendor Name']) ||
        scalarField(data.vendor) ||
        scalarField(data.supplier_name) ||
        scalarField(data.merchant_name) ||
        scalarField(data.payee) ||
        scalarField(data.seller_name);
    if (!vendor) {
        const vn = data.vendor_name;
        if (vn && typeof vn === 'object' && vn !== null) {
            vendor = scalarField((vn as Record<string, unknown>).name);
        }
    }
    // Vendor aliases (OCR typos → canonical) come from org finance settings, not hardcoded brands.
    void filenameHint;
    if (vendor) return vendor;
    return 'Unknown vendor';
}

/** "that / this / it" → prefer focus docs from prior chat turn, not the whole scope. */
export function questionRefersToSpecificDocument(question: string): boolean {
    const q = question.toLowerCase().trim();

    // Casual portfolio language — not a single-file pointer.
    if (
        /\b(that|the|this)\s+(data|info|numbers|figures|report|summary|breakdown|analytics)\b/.test(q) &&
        !/\b(invoice|document|file|pdf|receipt|bill)\b/.test(q)
    ) {
        return false;
    }
    if (/\b(give|show|get|send|pull)\s+(me\s+)?(the\s+)?(that\s+)?(full\s+)?(finance\s+)?(data|numbers|figures|report|breakdown)\b/.test(q)) {
        return false;
    }

    if (
        /\b(this|that|the)\s+(invoice|document|file|pdf|one|bill|receipt)\b/.test(q) ||
        /\b(chart|graph|visual)\b.*\b(that|this|it)\b/.test(q) ||
        /\b(that|this|it)\b.*\b(chart|graph|visual|breakdown|items?|totals?)\b/.test(q)
    ) {
        return true;
    }
    // "give me chart of that" — not bare "give me that data"
    if (/\b(give|show|list)\b.*\b(that|this|it)\b/.test(q)) {
        if (/\b(chart|graph|visual|invoice|file|document|pdf|line[\s-]?items?)\b/.test(q)) {
            return true;
        }
        return false;
    }
    if (/\b(of|for|about)\s+(that|this|it)\b/.test(q)) return true;
    if (/^(chart|graph|visualize|show)\s+(that|this|it)\b/.test(q)) return true;
    return false;
}

/**
 * Narrow scoped IDs when the user names a file or points at one ("that").
 * Named file always wins — other scoped documents are excluded from the chart.
 */
export async function narrowFinanceDocumentIds(params: {
    user: AuthUser;
    question: string;
    scopedIds?: string[];
    focusIds?: string[];
    /** When true, always return full scopedIds (all clients/vendors in scope). */
    portfolioScope?: boolean;
}): Promise<string[] | undefined> {
    const scoped = (params.scopedIds || []).filter(Boolean);
    const focus = (params.focusIds || []).filter(Boolean);
    const q = params.question;

    if (params.portfolioScope && scoped.length) {
        return scoped;
    }
    // 1) Name in the message → only that file (never the rest of the scope)
    const fromName = await resolveFinanceDocumentIdsFromQuestion(params.user, q, {
        preferIds: scoped.length ? scoped : undefined,
    });
    if (fromName?.length) {
        return fromName.slice(0, 1);
    }

    // 2) "that / this / it" → last discussed focus doc
    if (questionRefersToSpecificDocument(q)) {
        if (focus.length && scoped.length) {
            const scopedSet = new Set(scoped);
            const hit = focus.filter((id) => scopedSet.has(id));
            if (hit.length) return hit.slice(0, 1);
        }
        if (focus.length) return focus.slice(0, 1);
        if (scoped.length === 1) return scoped;
        // Ambiguous "that" with several files → caller clarifies
        if (scoped.length > 1) return undefined;
    }

    // 3) No name / no deictic → full scope (portfolio charts)
    return scoped.length ? scoped : undefined;
}

function normalizePartyKey(name: string, aliases?: Record<string, string>): string {
    const c = partyRollupKey(name, aliases);
    return c || name.trim().toLowerCase().replace(/\s+/g, ' ');
}

function normalizeExtractionPayload(data: Record<string, unknown>): Record<string, unknown> {
    const out = { ...data };
    const add = data.additional_information;
    if (add && typeof add === 'object' && !Array.isArray(add)) {
        for (const [k, v] of Object.entries(add as Record<string, unknown>)) {
            if (out[k] == null || out[k] === '') out[k] = v;
        }
    }
    return out;
}

function inferDocumentTotal(data: Record<string, unknown>): number | null {
    // Common header total fields (English + PKR/GST variants).
    const direct =
        parseNumber(data.total_amount) ??
        parseNumber(data['Total Amount (PKR)']) ??
        parseNumber(data['Total Amount']) ??
        parseNumber(data['Grand Total']) ??
        parseNumber(data['Grand Total (PKR)']) ??
        parseNumber(data['Amount Payable']) ??
        parseNumber(data['Total Payable']) ??
        parseNumber(data.total) ??
        parseNumber(data.amount) ??
        parseNumber(data.grand_total) ??
        parseNumber(data.net_amount) ??
        parseNumber(data.invoice_total) ??
        parseNumber(data.invoice_amount) ??
        parseNumber(data.amount_due) ??
        parseNumber(data.amount_payable) ??
        parseNumber(data.total_payable) ??
        parseNumber(data.total_due) ??
        parseNumber(data.paid_amount) ??
        parseNumber(data.payment_amount) ??
        parseNumber(data.balance_due);
    if (direct != null && direct > 0) return direct;

    const subtotal =
        parseNumber(data.subtotal) ??
        parseNumber(data.sub_total) ??
        parseNumber(data.net_total) ??
        parseNumber(data['Sub Total']);
    if (subtotal != null && subtotal > 0) {
        const tax =
            parseNumber(data.tax_amount) ??
            parseNumber(data.tax) ??
            parseNumber(data.gst) ??
            parseNumber(data.vat) ??
            parseNumber(data.sales_tax) ??
            0;
        const ship = parseNumber(data.shipping_charges) ?? parseNumber(data.shipping) ?? 0;
        const disc = parseNumber(data.discount) ?? parseNumber(data.discount_amount) ?? 0;
        return subtotal + tax + ship - disc;
    }

    // Last resort: line_items sum (even when recordsFromExtraction takes a different
    // branch, coverage should still count the file as chartable).
    const items = data.line_items;
    if (Array.isArray(items)) {
        let sum = 0;
        for (const raw of items) {
            if (!raw || typeof raw !== 'object') continue;
            const row = raw as Record<string, unknown>;
            const v =
                parseNumber(row.total) ??
                parseNumber(row.amount) ??
                (parseNumber(row.quantity) != null && parseNumber(row.unit_price) != null
                    ? Number(row.quantity) * Number(row.unit_price)
                    : null);
            if (v != null && v > 0) sum += v;
        }
        if (sum > 0) return Math.round(sum * 100) / 100;
    }

    return null;
}

function pickExtractionData(extractions: Awaited<ReturnType<typeof getDocumentExtractions>>): Record<string, unknown> {
    if (!extractions?.length) return {};
    const sorted = [...extractions].sort((a, b) => {
        const ta = a.created_at ? new Date(a.created_at).getTime() : 0;
        const tb = b.created_at ? new Date(b.created_at).getTime() : 0;
        return tb - ta;
    });
    const merged: Record<string, unknown> = {};
    const tables: unknown[] = [];
    for (const ext of [...sorted].reverse()) {
        if (String(ext.extraction_type || '') === 'table_extraction') {
            const chunk = (ext.extracted_data || {}) as Record<string, unknown>;
            if (Array.isArray(chunk.tables)) tables.push(...(chunk.tables as unknown[]));
            if (typeof chunk.table_text === 'string' && !merged._table_text) {
                merged._table_text = chunk.table_text;
            }
            continue;
        }
        const chunk = (ext.extracted_data || {}) as Record<string, unknown>;
        Object.assign(merged, chunk);
    }
    if (tables.length) merged._tables = tables;
    return normalizeExtractionPayload(merged);
}

async function extractionPayloadForDoc(
    doc: {
        documentId?: string;
        pythonDocumentId?: string | null;
        organizationId?: string | null;
        metadata?: unknown;
    },
    user: AuthUser,
    cache?: Map<string, Record<string, unknown>>,
    stats?: { hits: number; misses: number }
): Promise<Record<string, unknown>> {
    const cacheKey = doc.documentId || doc.pythonDocumentId || '';
    if (cache && cacheKey && cache.has(cacheKey)) {
        if (stats) stats.hits += 1;
        return cache.get(cacheKey)!;
    }
    if (stats) stats.misses += 1;
    if (!doc.pythonDocumentId) return {};
    const orgId = resolveDocumentAiOrgId(doc as any, user);
    let extractions = await getDocumentExtractions(doc.pythonDocumentId, orgId);
    if (!extractions?.length && orgId) {
        extractions = await getDocumentExtractions(doc.pythonDocumentId, '');
    }
    let data = pickExtractionData(extractions);
    // Always pull raw_text so xlsx / OCR-only files can be row-parsed. Not just when
    // extraction is missing.
    const aiDoc = await getAiDocument(doc.pythonDocumentId, orgId);
    if (aiDoc && typeof aiDoc === 'object') {
        const rawText = (aiDoc as Record<string, unknown>).raw_text;
        if (typeof rawText === 'string' && rawText && !data._raw_text) {
            data._raw_text = rawText;
        }
        const meta = (aiDoc as Record<string, unknown>).extracted_data;
        if ((!Object.keys(data).length || inferDocumentTotal(data) == null) && meta && typeof meta === 'object') {
            data = normalizeExtractionPayload({
                ...data,
                ...(meta as Record<string, unknown>),
            });
        }
    }
    const result = preferPrintedInvoiceTotal(normalizeExtractionPayload(data));
    if (cache && cacheKey) cache.set(cacheKey, result);
    return result;
}

/** Prefer printed total_amount when line_items sum disagrees (common OCR/LLM failure). */
function preferPrintedInvoiceTotal(data: Record<string, unknown>): Record<string, unknown> {
    const items = data.line_items;
    if (!Array.isArray(items) || !items.length) return data;
    let lineSum = 0;
    let n = 0;
    for (const raw of items) {
        if (!raw || typeof raw !== 'object') continue;
        const row = raw as Record<string, unknown>;
        const t =
            parseNumber(row.total_price) ??
            parseNumber(row.total) ??
            parseNumber(row.amount) ??
            parseNumber(row.line_total);
        if (t != null) {
            lineSum += t;
            n += 1;
        }
    }
    const printed =
        parseNumber(data.total_amount) ??
        parseNumber(data.grand_total) ??
        parseNumber(data['Total Amount']);
    if (printed != null && n > 0 && Math.abs(lineSum - printed) > Math.max(1, 0.02 * printed)) {
        return {
            ...data,
            total_amount: printed,
            _line_items_sum: Math.round(lineSum * 100) / 100,
            _line_items_total_mismatch: true,
        };
    }
    return data;
}

function normalizePoNumber(raw: unknown): string {
    const s = scalarField(raw);
    if (!s) return '';
    return s.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
}

/** Normalize invoice numbers for payment↔invoice matching (INV-2024-102 ≡ inv2024102). */
export function normalizeInvoiceNumberKey(raw: string): string {
    return raw.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
}

/** Pull an invoice reference out of payment_for / narrative text. */
export function extractInvoiceRefFromText(text: string): string {
    const s = (text || '').trim();
    if (!s) return '';
    const patterns = [
        /invoice\s*(?:number|no\.?|#)?\s*[:#]?\s*([A-Z0-9][A-Z0-9\-_/]*)/i,
        /(?:against|for|re|towards)\s+(?:invoice|inv\.?)\s*#?\s*([A-Z0-9][A-Z0-9\-_/]*)/i,
        /\b(INV[-_]?\d[\w\-]*)\b/i,
    ];
    for (const re of patterns) {
        const m = s.match(re);
        if (m?.[1] && normalizeInvoiceNumberKey(m[1]).length >= 3) return m[1].trim();
    }
    return '';
}

export function isPaymentRecord(r: FinanceRecord): boolean {
    if (r.recordKind === 'payment') return true;
    const cls = (r.classification || '').toLowerCase();
    return cls === 'payment_receipt';
}

/** Amount used for AP/AR/aging after settlement (outstanding when set). */
export function chartAmount(r: FinanceRecord): number {
    if (typeof r.outstanding === 'number' && Number.isFinite(r.outstanding)) return r.outstanding;
    return r.total;
}

function isPaymentExtraction(
    doc: { classification?: string | null },
    data: Record<string, unknown>
): boolean {
    const cls = String(doc.classification || '').toLowerCase();
    if (cls === 'payment_receipt') return true;
    const amountPaid =
        parseNumber(data.amount_paid) ?? parseNumber(data.paid_amount) ?? parseNumber(data.payment_amount);
    if (amountPaid == null || amountPaid <= 0) return false;
    const hasPaymentShape =
        Boolean(scalarField(data.payment_for)) ||
        Boolean(scalarField(data.payer_name)) ||
        Boolean(scalarField(data.payee_name)) ||
        Boolean(scalarField(data.receipt_number));
    if (!hasPaymentShape) return false;
    // Don't treat a normal invoice that also has amount_paid as a receipt.
    const invoiceTotal =
        parseNumber(data.total_amount) ??
        parseNumber(data.grand_total) ??
        parseNumber(data.invoice_total) ??
        parseNumber(data.invoice_amount);
    return invoiceTotal == null || invoiceTotal <= 0;
}

function resolvePaysInvoiceNumber(data: Record<string, unknown>): string {
    const direct =
        scalarField(data.invoice_number) ||
        scalarField(data.invoice_no) ||
        scalarField(data.invoice_id) ||
        scalarField(data['Invoice Number']);
    if (direct) return direct;
    const fromPurpose = extractInvoiceRefFromText(scalarField(data.payment_for));
    if (fromPurpose) return fromPurpose;
    const extra = data.additional_information;
    if (extra && typeof extra === 'object' && !Array.isArray(extra)) {
        const o = extra as Record<string, unknown>;
        return (
            scalarField(o.invoice_number) ||
            scalarField(o.invoice_no) ||
            extractInvoiceRefFromText(scalarField(o.payment_for) || scalarField(o.remarks) || '')
        );
    }
    return '';
}

function makePaymentRecord(
    doc: { documentId: string; originalFilename: string; classification?: string | null },
    data: Record<string, unknown>,
    vendorAliases?: Record<string, string>
): FinanceRecord {
    const amountPaid =
        parseNumber(data.amount_paid) ??
        parseNumber(data.paid_amount) ??
        parseNumber(data.payment_amount) ??
        inferDocumentTotal(data) ??
        0;
    const payee = resolveVendorDisplayName(
        scalarField(data.payee_name) || pickVendor(data, doc.originalFilename),
        vendorAliases
    );
    const payer = scalarField(data.payer_name) || pickClient(data);
    const paymentFor = scalarField(data.payment_for);
    const paysInvoiceNumber = resolvePaysInvoiceNumber(data) || undefined;
    const currency = (scalarField(data.currency) || 'USD').toUpperCase().slice(0, 3);
    return {
        documentId: doc.documentId,
        filename: doc.originalFilename,
        vendor: payee.trim() || 'Unknown vendor',
        client: payer.trim(),
        total: amountPaid,
        currency,
        invoiceDate: parseDate(data.payment_date || data.document_date || data.date),
        dueDate: null,
        classification: doc.classification
            ? String(doc.classification).toLowerCase()
            : 'payment_receipt',
        recordKind: 'payment',
        amountPaid,
        paymentFor: paymentFor || undefined,
        paysInvoiceNumber,
        // Do NOT set invoiceNumber — avoids dedupe colliding with the target invoice.
    };
}

function makeRecord(
    doc: { documentId: string; originalFilename: string; classification?: string | null },
    vendor: string,
    client: string,
    total: number,
    currency: string,
    data: Record<string, unknown>
): FinanceRecord {
    const cur = (currency || scalarField(data.currency) || 'USD').toUpperCase().slice(0, 3);
    const poNumber =
        normalizePoNumber(data.po_number) ||
        normalizePoNumber(data.purchase_order_number) ||
        normalizePoNumber(data['PO Number']) ||
        normalizePoNumber(data['Purchase Order']) ||
        normalizePoNumber(data.purchase_order) ||
        normalizePoNumber(data.reference_number) ||
        normalizePoNumber(data.order_number);
    const invoiceNumber = scalarField(data.invoice_number) || scalarField(data['Invoice Number']);
    const paymentStatus =
        scalarField(data.status) ||
        scalarField(data.payment_status) ||
        scalarField(data['Status']);
    const cls = doc.classification ? String(doc.classification).toLowerCase() : undefined;
    const isPo = cls === 'purchase_order' || cls === 'po' || cls === 'quotation';
    return {
        documentId: doc.documentId,
        filename: doc.originalFilename,
        vendor: vendor.trim() || 'Unknown vendor',
        client: client.trim(),
        total,
        currency: cur,
        invoiceDate: parseDate(data.invoice_date || data.document_date || data.date),
        dueDate: parseDate(data.due_date || data.payment_due_date),
        classification: cls,
        poNumber: poNumber || undefined,
        invoiceNumber: invoiceNumber || undefined,
        paymentStatus: paymentStatus || undefined,
        recordKind: isPo ? 'other' : 'invoice',
        outstanding: total,
        paidApplied: 0,
    };
}

function isStandardInvoiceExtraction(
    data: Record<string, unknown>,
    doc?: { originalFilename?: string }
): boolean {
    const fn = (doc?.originalFilename || '').toLowerCase();
    const isSpreadsheet =
        /\.(xlsx?|csv|tsv|ods)$/i.test(fn) ||
        /sheet|table|ledger|spreadsheet|excel|csv/i.test(String(data.document_type || ''));
    if (isSpreadsheet) return false;

    const inv =
        scalarField(data.invoice_number) ||
        scalarField(data.invoice_no) ||
        scalarField(data.invoice_id);
    const total = inferDocumentTotal(data);
    const vendor = pickVendor(data, doc?.originalFilename);
    return Boolean(inv && total != null && total > 0 && vendor !== 'Unknown vendor');
}

/** True if the file looks like a spreadsheet (xlsx/csv/etc.). */
export function isSpreadsheetFilename(filename?: string): boolean {
    return /\.(xlsx?|csv|tsv|ods)$/i.test(filename || '');
}

function isSpreadsheetFilenameInternal(filename?: string): boolean {
    return isSpreadsheetFilename(filename);
}

/** Parse a markdown pipe table into rows of `{ header: value }`. */
function parseMarkdownTable(block: string): Array<Record<string, string>> {
    const lines = block.split('\n').map((l) => l.trim()).filter((l) => l.startsWith('|'));
    if (lines.length < 2) return [];
    const cells = (line: string) =>
        line
            .replace(/^\|/, '')
            .replace(/\|$/, '')
            .split('|')
            .map((c) => c.trim());
    const header = cells(lines[0]).map((h) => h.toLowerCase());
    // lines[1] is separator (---); data starts at 2
    const rows: Array<Record<string, string>> = [];
    for (let i = 2; i < lines.length; i++) {
        const c = cells(lines[i]);
        if (!c.length || c.every((x) => !x)) continue;
        const row: Record<string, string> = {};
        for (let j = 0; j < header.length; j++) row[header[j] || `col_${j}`] = c[j] ?? '';
        rows.push(row);
    }
    return rows;
}

/** Extract markdown pipe-tables from raw_text (OCR often produces them). */
function extractMarkdownTables(rawText: string): Array<Array<Record<string, string>>> {
    if (!rawText) return [];
    const blocks: string[] = [];
    const lines = rawText.split('\n');
    let buf: string[] = [];
    for (const line of lines) {
        if (line.trim().startsWith('|')) {
            buf.push(line);
        } else if (buf.length) {
            if (buf.length >= 2) blocks.push(buf.join('\n'));
            buf = [];
        }
    }
    if (buf.length >= 2) blocks.push(buf.join('\n'));
    return blocks.map(parseMarkdownTable).filter((rows) => rows.length > 0);
}

const AMOUNT_HEADERS = /^(?:amount|total|total\s*amount|grand\s*total|net\s*amount|value|price|paid|payable|payment)$/i;
const VENDOR_HEADERS = /^(?:vendor|supplier|merchant|payee|seller|from|company)$/i;
const CLIENT_HEADERS = /^(?:client|customer|buyer|bill[\s_]?to|sold[\s_]?to|account|to)$/i;
const DATE_HEADERS = /^(?:date|invoice[\s_]?date|billing[\s_]?date|txn[\s_]?date|transaction[\s_]?date)$/i;
const CURRENCY_HEADERS = /^(?:currency|ccy)$/i;
const INVOICE_HEADERS = /^(?:invoice|invoice[\s_]?number|invoice[\s_]?no|inv[\s_]?#|inv[\s_]?no)$/i;
const PO_HEADERS = /^(?:po|po[\s_]?number|purchase[\s_]?order|order[\s_]?number|reference|ref)$/i;
const STATUS_HEADERS = /^status$/i;

function normalizeHeaderKey(h: string): string {
    return h.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function isAmountLikeHeader(h: string): boolean {
    if (!h) return false;
    if (
        /invoice\s*(no|number|#)|inv\s*#|qty|quantity|unit|count|rate|date|currency|month|year/i.test(h) &&
        !/amount|spend|total|payable|payment|value|price/i.test(h)
    ) {
        return false;
    }
    return /(amount|spend|total|payable|payment|value|price|\bpkr\b|\busd\b|\beur\b|\bgbp\b)/i.test(h);
}

/** Prefer a PKR amount column over a USD amount column so charts don't sticker PKR on USD numbers. */
function scoreAmountHeader(h: string): number {
    const cur = inferCurrencyFromText(h);
    let score = 0;
    if (/grand\s*total|total\s*amount|amount\s*payable/i.test(h)) score += 50;
    else if (/\btotal\b/i.test(h)) score += 40;
    else if (/\bamount\b|\bspend\b/i.test(h)) score += 30;
    else score += 10;
    if (cur === 'PKR') score += 25;
    else if (cur === 'USD' || cur === 'EUR' || cur === 'GBP' || cur === 'INR') score += 5;
    return score;
}

function findHeaderIndex(headers: string[], kind: 'amount' | 'vendor' | 'client'): number {
    const normalized = headers.map(normalizeHeaderKey);
    if (kind === 'amount') {
        let best = -1;
        let bestScore = -1;
        for (let i = 0; i < normalized.length; i++) {
            const h = normalized[i];
            if (!isAmountLikeHeader(h)) continue;
            const score = scoreAmountHeader(h);
            if (score > bestScore) {
                bestScore = score;
                best = i;
            }
        }
        return best;
    }
    for (let i = 0; i < normalized.length; i++) {
        const h = normalized[i];
        if (!h) continue;
        if (kind === 'vendor') {
            if (
                /^(vendor|supplier|seller|merchant|payee|from|company)(\s+name)?$/i.test(h) ||
                /^vendor\b/i.test(h) ||
                /\bvendor\s+name\b/i.test(h)
            ) {
                return i;
            }
        }
        if (kind === 'client') {
            if (
                /^(client|customer|buyer|account)(\s+name)?$/i.test(h) ||
                /\bclient\s+name\b/i.test(h) ||
                /\bcustomer\s+name\b/i.test(h) ||
                /bill\s*to|sold\s*to/i.test(h)
            ) {
                return i;
            }
        }
    }
    return -1;
}

function detectColumn(header: string[], match: RegExp): number {
    for (let i = 0; i < header.length; i++) {
        if (match.test(header[i])) return i;
    }
    return -1;
}

/** Read currency from labels like "Total Amount (PKR)" instead of defaulting to USD. */
export function inferCurrencyFromText(text: string): string | null {
    const t = String(text || '').toLowerCase();
    if (!t.trim()) return null;
    const hasInr = /\binr\b|indian\s+rupee|₹/.test(t);
    const hasPkr = /\bpkr\b|pakistani(?:\s+rupee)?/.test(t);
    const hasUsd = /\busd\b|\bdollars?\b|(?:^|[^\w])\$/.test(t);
    const hasEur = /\beur\b|euros?|€/.test(t);
    const hasGbp = /\bgbp\b|pounds?|£/.test(t);
    const hits = [hasInr, hasPkr, hasUsd, hasEur, hasGbp].filter(Boolean).length;
    // Concatenated headers like "Total Amount (USD) Total Amount (PKR)" are ambiguous.
    if (hits > 1) return null;
    if (hasInr) return 'INR';
    if (hasPkr) return 'PKR';
    if (hasUsd) return 'USD';
    if (hasEur) return 'EUR';
    if (hasGbp) return 'GBP';
    if (/\brupees?\b|\brs\.?\b/.test(t)) return 'PKR';
    return null;
}

function resolveExtractionCurrency(data: Record<string, unknown>, fallback = 'USD'): string {
    const amountBlob = [
        data.total_amount,
        data.amount,
        data['Total Amount (PKR)'],
        data['Total Amount'],
        data.grand_total,
    ]
        .map((v) => String(v ?? ''))
        .join(' ');
    if (/\$/.test(amountBlob) || /\busd\b/i.test(amountBlob)) return 'USD';
    const fromAmount = inferCurrencyFromText(amountBlob);
    if (fromAmount) return fromAmount;
    const fromKeys = inferCurrencyFromText(
        Object.keys(data)
            .filter((k) => /amount|total|currency/i.test(k))
            .join(' ')
    );
    if (fromKeys) return fromKeys;
    return (scalarField(data.currency) || fallback).toUpperCase().slice(0, 3);
}

/** Turn a parsed spreadsheet table into FinanceRecords (one per row with amount + vendor|client). */
function recordsFromTableRows(
    doc: { documentId: string; originalFilename: string; classification?: string | null },
    tableRows: Array<Record<string, string>>,
    defaults: { vendor: string; client: string; currency: string; classification?: string | null },
    vendorAliases?: Record<string, string>,
): FinanceRecord[] {
    if (!tableRows.length) return [];
    const header = Object.keys(tableRows[0]);
    const amtKeyIdx = findHeaderIndex(header, 'amount');
    const amtIdx =
        amtKeyIdx >= 0
            ? amtKeyIdx
            : detectColumn(header.map(normalizeHeaderKey), AMOUNT_HEADERS);
    if (amtIdx < 0) return [];
    const amountHeader = header[amtIdx] || '';
    const headerCurrency = inferCurrencyFromText(amountHeader);
    const vendorIdx = findHeaderIndex(header, 'vendor');
    const clientIdx = findHeaderIndex(header, 'client');
    const dateIdx = detectColumn(header.map(normalizeHeaderKey), DATE_HEADERS);
    const curIdx = detectColumn(header.map(normalizeHeaderKey), CURRENCY_HEADERS);
    const invIdx = detectColumn(header.map(normalizeHeaderKey), INVOICE_HEADERS);
    const poIdx = detectColumn(header.map(normalizeHeaderKey), PO_HEADERS);
    const statusIdx = detectColumn(header.map(normalizeHeaderKey), STATUS_HEADERS);

    const cellAt = (row: Record<string, string>, idx: number) =>
        idx >= 0 && idx < header.length ? String(row[header[idx]] ?? '').trim() : '';

    const out: FinanceRecord[] = [];
    for (const row of tableRows) {
        const amount = parseNumber(cellAt(row, amtIdx));
        if (amount == null || amount <= 0) continue;
        const vendor = cellAt(row, vendorIdx) || defaults.vendor;
        const client = cellAt(row, clientIdx) || defaults.client;
        const cellCurrency = cellAt(row, curIdx).toUpperCase().replace(/[^A-Z]/g, '').slice(0, 3);
        // Amount-column header wins (e.g. "Total Amount (PKR)") so a Currency=USD cell
        // cannot relabel already-converted PKR figures as USD, or vice versa.
        const currency =
            headerCurrency ||
            (cellCurrency.length === 3 ? cellCurrency : '') ||
            defaults.currency;
        const dateStr = cellAt(row, dateIdx);
        const invoiceNumber = cellAt(row, invIdx);
        const poNumber = cellAt(row, poIdx);
        const paymentStatus = cellAt(row, statusIdx);
        const stub: Record<string, unknown> = {
            invoice_date: dateStr || undefined,
            invoice_number: invoiceNumber || undefined,
            po_number: poNumber || undefined,
            currency,
            status: paymentStatus || undefined,
        };
        out.push(
            makeRecord(
                { ...doc, classification: defaults.classification ?? doc.classification },
                resolveVendorDisplayName(vendor, vendorAliases),
                client,
                amount,
                currency,
                stub,
            ),
        );
    }
    return out;
}

/** Spreadsheet-shaped extractor: row-by-row FinanceRecords. */
function recordsFromStructuredRowArrays(
    doc: { documentId: string; originalFilename: string; classification?: string | null },
    data: Record<string, unknown>,
    defaults: { vendor: string; client: string; currency: string; classification?: string | null },
    vendorAliases?: Record<string, string>
): FinanceRecord[] {
    const spreadsheetRows =
        data.rows ||
        data.records ||
        data.transactions ||
        data.entries ||
        data.data ||
        data.items ||
        data.sheet_data;
    if (!Array.isArray(spreadsheetRows) || !spreadsheetRows.length) return [];

    const asObjects: Array<Record<string, string>> = [];
    for (const item of spreadsheetRows) {
        if (!item || typeof item !== 'object') continue;
        const row = item as Record<string, unknown>;
        const rec: Record<string, string> = {};
        for (const [k, v] of Object.entries(row)) {
            rec[normalizeHeaderKey(String(k))] = String(v ?? '').trim();
        }
        if (Object.keys(rec).length) asObjects.push(rec);
    }
    if (asObjects.length) {
        return recordsFromTableRows(doc, asObjects, defaults, vendorAliases);
    }
    return [];
}

function recordsFromSpreadsheet(
    doc: { documentId: string; originalFilename: string; classification?: string | null },
    data: Record<string, unknown>,
    vendorAliases?: Record<string, string>,
): FinanceRecord[] {
    const defaults = {
        vendor: resolveVendorDisplayName(pickVendor(data, doc.originalFilename), vendorAliases),
        client: pickClient(data),
        currency: (
            inferCurrencyFromText(
                `${doc.originalFilename} ${scalarField(data.currency)} ${Object.keys(data).join(' ')}`
            ) ||
            scalarField(data.currency) ||
            'USD'
        )
            .toUpperCase()
            .slice(0, 3),
        classification: doc.classification ?? null,
    };

    const fromJson = recordsFromStructuredRowArrays(doc, data, defaults, vendorAliases);
    if (fromJson.length) return fromJson;

    // 1) Prefer table_extraction payload's `tables` (OCR-detected).
    const tables = Array.isArray(data._tables) ? (data._tables as unknown[]) : [];
    const collected: FinanceRecord[] = [];
    for (const t of tables) {
        if (!t || typeof t !== 'object') continue;
        const rowsRaw = (t as Record<string, unknown>).rows;
        const headersRaw = (t as Record<string, unknown>).headers;
        if (!Array.isArray(rowsRaw)) continue;
        const headers = Array.isArray(headersRaw)
            ? (headersRaw as unknown[]).map((h) => String(h ?? '').toLowerCase())
            : [];
        const tableRows: Array<Record<string, string>> = (rowsRaw as unknown[])
            .filter((r) => Array.isArray(r))
            .map((r) => {
                const cells = r as unknown[];
                const rec: Record<string, string> = {};
                for (let i = 0; i < cells.length; i++) {
                    const key = headers[i] || `col_${i}`;
                    rec[key] = String(cells[i] ?? '').trim();
                }
                return rec;
            });
        collected.push(...recordsFromTableRows(doc, tableRows, defaults, vendorAliases));
    }
    if (collected.length) return collected;

    // 2) Fallback: parse markdown pipe-tables inside raw_text.
    const rawText = typeof data._raw_text === 'string' ? (data._raw_text as string) : '';
    for (const tableRows of extractMarkdownTables(rawText)) {
        collected.push(...recordsFromTableRows(doc, tableRows, defaults, vendorAliases));
    }
    return collected;
}

/**
 * Build finance rows for one document. Prefer one row per invoice (vendor + total_amount).
 * Avoids LLM-hallucinated vendor_breakdown on single invoices and line-item double counting.
 */
function recordsFromExtraction(
    doc: { documentId: string; originalFilename: string; classification?: string | null },
    data: Record<string, unknown>,
    vendorAliases?: Record<string, string>
): FinanceRecord[] {
    // Spreadsheet-first: xlsx / csv → one record per meaningful row.
    if (isSpreadsheetFilenameInternal(doc.originalFilename)) {
        const sheetRecords = recordsFromSpreadsheet(doc, data, vendorAliases);
        if (sheetRecords.length) return sheetRecords;
        return [];
    }

    // Payment receipts: never treat amount_paid as invoice spend.
    if (isPaymentExtraction(doc, data)) {
        const pay = makePaymentRecord(doc, data, vendorAliases);
        return pay.total > 0 ? [pay] : [];
    }

    const currency = resolveExtractionCurrency(data);
    const client = pickClient(data);
    const defaultVendor = resolveVendorDisplayName(
        pickVendor(data, doc.originalFilename),
        vendorAliases
    );
    const invoiceDate = parseDate(data.invoice_date || data.document_date || data.date);
    const dueDate = parseDate(data.due_date || data.payment_due_date);

    if (isStandardInvoiceExtraction(data, doc)) {
        const total = inferDocumentTotal(data)!;
        return [
            makeRecord(doc, defaultVendor, client, total, currency, {
                ...data,
                invoice_date: invoiceDate,
                due_date: dueDate,
            }),
        ];
    }

    const records: FinanceRecord[] = [];

    const spreadsheetRows =
        data.rows ||
        data.records ||
        data.transactions ||
        data.entries ||
        data.data ||
        data.items;
    if (Array.isArray(spreadsheetRows) && spreadsheetRows.length > 0) {
        for (const item of spreadsheetRows) {
            if (!item || typeof item !== 'object') continue;
            const row = item as Record<string, unknown>;
            const total =
                parseNumber(row.amount) ??
                parseNumber(row.total) ??
                parseNumber(row.total_amount) ??
                parseNumber(row.price) ??
                (parseNumber(row.quantity) != null && parseNumber(row.unit_price) != null
                    ? Number(row.quantity) * Number(row.unit_price)
                    : null);
            if (total == null || total <= 0) continue;
            const vendor =
                scalarField(row.vendor_name) ||
                scalarField(row.vendor) ||
                scalarField(row.supplier) ||
                defaultVendor;
            const rowClient =
                scalarField(row.client_name) ||
                scalarField(row.client) ||
                scalarField(row.customer) ||
                client;
            records.push(makeRecord(doc, vendor, rowClient, total, currency, row));
        }
        if (records.length) return records;
    }

    const docType = scalarField(data.document_type).toLowerCase();
    const allowVendorBreakdown =
        /expense|summary|report|rollup|aggregate/.test(docType) ||
        (!scalarField(data.invoice_number) && !scalarField(data.invoice_no));

    const vb = data.vendor_breakdown;
    if (
        allowVendorBreakdown &&
        vb &&
        typeof vb === 'object' &&
        !Array.isArray(vb) &&
        Object.keys(vb as object).length > 0
    ) {
        for (const [vendorKey, amount] of Object.entries(vb as Record<string, unknown>)) {
            const total = parseNumber(amount);
            if (total != null && total > 0) {
                records.push(
                    makeRecord(doc, vendorKey, client, total, currency, {
                        ...data,
                        invoice_date: data.invoice_date,
                        due_date: data.due_date,
                    })
                );
            }
        }
        if (records.length) return records;
    }

    const categories = data.expense_categories;
    if (Array.isArray(categories) && allowVendorBreakdown) {
        for (const cat of categories) {
            if (!cat || typeof cat !== 'object') continue;
            const c = cat as Record<string, unknown>;
            const items = c.line_items;
            if (!Array.isArray(items)) continue;
            for (const item of items) {
                if (!item || typeof item !== 'object') continue;
                const row = item as Record<string, unknown>;
                const total = parseNumber(row.amount) ?? parseNumber(row.total);
                if (total == null || total <= 0) continue;
                const vendor = scalarField(row.vendor) || scalarField(row.merchant) || defaultVendor;
                records.push(makeRecord(doc, vendor, client, total, currency, data));
            }
        }
        if (records.length) return records;
    }

    const lineItems = data.line_items;
    const lineRecords: FinanceRecord[] = [];
    if (Array.isArray(lineItems)) {
        for (const item of lineItems) {
            if (!item || typeof item !== 'object') continue;
            const row = item as Record<string, unknown>;
            const total =
                parseNumber(row.total) ??
                parseNumber(row.amount) ??
                (parseNumber(row.quantity) != null && parseNumber(row.unit_price) != null
                    ? Number(row.quantity) * Number(row.unit_price)
                    : null);
            if (total == null || total <= 0) continue;
            const vendor =
                scalarField(row.vendor) ||
                scalarField(row.vendor_name) ||
                scalarField(row.supplier) ||
                defaultVendor;
            lineRecords.push(makeRecord(doc, vendor, client, total, currency, data));
        }
    }

    const docTotal = inferDocumentTotal(data);
    if (docTotal != null && docTotal > 0 && defaultVendor !== 'Unknown vendor') {
        const lineSum = lineRecords.reduce((s, r) => s + r.total, 0);
        const tolerance = Math.max(1, docTotal * 0.02);
        if (lineRecords.length === 0 || Math.abs(lineSum - docTotal) > tolerance) {
            return [
                makeRecord(doc, defaultVendor, client, docTotal, currency, {
                    ...data,
                    invoice_date: invoiceDate,
                    due_date: dueDate,
                }),
            ];
        }
    }

    if (lineRecords.length > 0) {
        return lineRecords;
    }

    if (!records.length && docTotal != null && docTotal > 0) {
        records.push(
            makeRecord(doc, defaultVendor, client, docTotal, currency, {
                ...data,
                invoice_date: invoiceDate,
                due_date: dueDate,
            })
        );
    }

    return records;
}

/** Test / fixture hook — build chart rows from extraction JSON without DB. */
export function buildFinanceRecordsFromExtraction(
    doc: { documentId: string; originalFilename: string; classification?: string | null },
    data: Record<string, unknown>,
    vendorAliases?: Record<string, string>
): FinanceRecord[] {
    return recordsFromExtraction(doc, data, vendorAliases);
}

async function mapPool<T, R>(items: T[], concurrency: number, fn: (item: T) => Promise<R>): Promise<R[]> {
    const results: R[] = [];
    let i = 0;
    async function worker() {
        while (i < items.length) {
            const idx = i++;
            results[idx] = await fn(items[idx]);
        }
    }
    const workers = Array.from({ length: Math.min(concurrency, items.length) }, () => worker());
    await Promise.all(workers);
    return results;
}

function buildFinanceScopeQuery(filter: Record<string, unknown>, documentIds?: string[]): Record<string, unknown> {
    const query: Record<string, unknown> = {
        ...filter,
        status: 'ready',
        pythonDocumentId: { $exists: true, $nin: [null, ''] },
        classification: { $nin: [...FINANCE_ANALYTICS_EXCLUDED_CLASSIFICATIONS] },
        originalFilename: { $not: /\b(cv|cvs|resume|curriculum|biodata)\b/i },
        $or: [
            { classification: { $in: [...FINANCE_DOC_TYPES] } },
            { 'metadata.phase3Agent': FINANCE_AGENT },
            {
                originalFilename: {
                    $regex: /invoice|inv[_\-.]|bill|receipt|expense|statement/i,
                },
            },
            {
                originalFilename: {
                    $regex: /\.(xlsx?|xls|csv|tsv)$/i,
                },
            },
        ],
    };
    if (documentIds?.length) {
        query.documentId = { $in: documentIds };
    }
    return query;
}

export type FinanceFileCoverage = {
    documentId: string;
    filename: string;
    status:
        | 'in_charts'
        | 'missing_amount'
        | 'no_extraction'
        | 'not_linked'
        | 'unsupported_format';
    detail?: string;
};

const UNSUPPORTED_FINANCE_EXTENSIONS = /\.(xlsx|xls|csv|tsv|numbers|ods)$/i;

function isUnsupportedFinanceFile(filename: string): boolean {
    return UNSUPPORTED_FINANCE_EXTENSIONS.test(filename || '');
}

export async function buildFinanceFileCoverage(
    user: AuthUser,
    records: FinanceRecord[],
    options: LoadFinanceOptions = {}
): Promise<FinanceFileCoverage[]> {
    const maxDocs = options.maxDocs ?? 200;
    const filter = await buildDocumentFilter(user, {});
    const query = buildFinanceScopeQuery(filter, options.documentIds);
    const docs = await Document.find(query)
        .select('documentId originalFilename pythonDocumentId classification metadata')
        .sort({ createdAt: -1 })
        .limit(maxDocs)
        .lean();

    const inCharts = new Set(records.map((r) => r.documentId));
    const report: FinanceFileCoverage[] = [];

    for (const doc of docs) {
        if (inCharts.has(doc.documentId)) {
            report.push({
                documentId: doc.documentId,
                filename: doc.originalFilename,
                status: 'in_charts',
            });
            continue;
        }
        if (isUnsupportedFinanceFile(doc.originalFilename)) {
            report.push({
                documentId: doc.documentId,
                filename: doc.originalFilename,
                status: 'unsupported_format',
                detail:
                    'Spreadsheet parsed but no rows matched an "amount / total" column — check column headers or reprocess.',
            });
            continue;
        }
        if (!doc.pythonDocumentId) {
            report.push({
                documentId: doc.documentId,
                filename: doc.originalFilename,
                status: 'not_linked',
                detail: 'Not linked to AI processing—re-upload or reprocess.',
            });
            continue;
        }
        const data = await extractionPayloadForDoc(doc, user, options.extractionCache, options.extractionStats);
        const keys = Object.keys(data).filter((k) => !k.startsWith('_'));
        if (!keys.length) {
            report.push({
                documentId: doc.documentId,
                filename: doc.originalFilename,
                status: 'no_extraction',
                detail: 'No extraction stored yet—open document and run reprocess.',
            });
            continue;
        }
        const total = inferDocumentTotal(data);
        const vendor = pickVendor(data, doc.originalFilename);
        const hints: string[] = [];
        if (total == null) {
            hints.push(
                'no total_amount / subtotal / grand_total / amount_due / line_items — reprocess as **invoice** so an amount is captured',
            );
        }
        if (vendor === 'Unknown vendor') hints.push('no vendor_name');
        report.push({
            documentId: doc.documentId,
            filename: doc.originalFilename,
            status: 'missing_amount',
            detail:
                hints.length > 0
                    ? `Extraction ran but ${hints.join(' and ')}. Fields found: ${keys.slice(0, 8).join(', ')}${keys.length > 8 ? '…' : ''}.`
                    : `Extraction present but could not build a chart row (${keys.slice(0, 8).join(', ')}).`,
        });
    }
    return report;
}

export async function loadFinanceRecords(user: AuthUser, options: LoadFinanceOptions = {}): Promise<FinanceRecord[]> {
    const maxDocs = options.maxDocs ?? 200;
    let vendorAliases = options.vendorAliases;
    let baseCurrency = options.baseCurrency;
    if ((!vendorAliases || !baseCurrency) && user.organizationId) {
        const orgFin = await getOrgFinanceSettings(user.organizationId);
        vendorAliases = vendorAliases ?? orgFin.vendorAliases;
        baseCurrency = baseCurrency ?? orgFin.baseCurrency;
    }

    const filter = await buildDocumentFilter(user, {});
    const query = buildFinanceScopeQuery(filter, options.documentIds);

    const docs = await Document.find(query)
        .select('documentId originalFilename classification pythonDocumentId organizationId metadata')
        .sort({ createdAt: -1 })
        .limit(maxDocs)
        .lean();

    const financeDocs = docs.filter(
        (d) =>
            resolveCanonicalAgent({
                originalFilename: d.originalFilename,
                classification: d.classification,
                metadata: d.metadata as { phase3Agent?: string; naturalAgent?: string } | undefined,
            }) === FINANCE_AGENT
    );

    if (!financeDocs.length || !isAiServiceEnabled()) return [];

    const nested = await mapPool(financeDocs, 6, async (doc) => {
        try {
            const data = await extractionPayloadForDoc(doc, user, options.extractionCache, options.extractionStats);
            return recordsFromExtraction(doc, data, vendorAliases);
        } catch {
            return [] as FinanceRecord[];
        }
    });

    return nested.flat();
}

function dominantCurrency(records: FinanceRecord[], preferred?: string): string {
    const sums = new Map<string, number>();
    for (const r of records) {
        const cur = (r.currency || '').toUpperCase().slice(0, 3) || 'USD';
        sums.set(cur, (sums.get(cur) || 0) + chartAmount(r));
    }
    if (preferred && sums.has(preferred)) return preferred;
    let best = records[0]?.currency || preferred || 'USD';
    let max = -1;
    for (const [c, n] of sums) {
        if (n > max) {
            max = n;
            best = c;
        }
    }
    return best;
}

function docIdsField(ids: Set<string>): string {
    return [...ids].join(',');
}

export function computeFinanceCoverage(
    records: FinanceRecord[],
    documentsInScope: number,
    files?: FinanceFileCoverage[],
    warnings?: string[]
): FinanceAnalyticsCoverage {
    const withAmount = new Set(records.map((r) => r.documentId));
    const withClient = new Set(records.filter((r) => r.client.trim()).map((r) => r.documentId));
    const withVendor = new Set(
        records.filter((r) => r.vendor && r.vendor !== 'Unknown vendor').map((r) => r.documentId)
    );
    return {
        documentsInScope,
        documentsWithAmount: withAmount.size,
        documentsWithClient: withClient.size,
        documentsWithVendor: withVendor.size,
        files,
        warnings: warnings?.length ? warnings.slice(0, 10) : undefined,
    };
}

/** Group records that look like the same real invoice (used for both warnings and dedupe). */
function groupDuplicateRecords(records: FinanceRecord[]): Map<string, FinanceRecord[]> {
    const byKey = new Map<string, FinanceRecord[]>();
    for (const r of records) {
        // Payments never dedupe against invoices (even when they reference the same INV#).
        if (isPaymentRecord(r)) {
            const key = `PAY|${r.documentId}|${Math.round((r.amountPaid ?? r.total) * 100)}`;
            byKey.set(key, [r]);
            continue;
        }
        // Prefer invoice_number when present — most reliable duplicate signal.
        const invKey = r.invoiceNumber
            ? `INV|${(canonicalizePartyName(r.vendor) || r.vendor.toLowerCase())}|${r.invoiceNumber.trim().toUpperCase()}|${r.currency}`
            : null;
        const amt = Math.round(r.total * 100) / 100;
        const day = r.invoiceDate ? r.invoiceDate.toISOString().slice(0, 10) : 'unknown-date';
        const fallbackKey = `AMT|${canonicalizePartyName(r.vendor) || r.vendor.toLowerCase()}|${r.currency}|${amt}|${day}`;
        const key = invKey || fallbackKey;
        const arr = byKey.get(key) || [];
        arr.push(r);
        byKey.set(key, arr);
    }
    return byKey;
}

/** Same vendor + amount + currency + invoice day (or same invoice number) → likely duplicate upload. */
export function findDuplicateInvoiceWarnings(records: FinanceRecord[]): string[] {
    const out: string[] = [];
    const seen = new Set<string>();
    // Strict: same invoice_number + vendor
    const byInv = new Map<string, FinanceRecord[]>();
    for (const r of records) {
        if (!r.invoiceNumber) continue;
        const key = `${(canonicalizePartyName(r.vendor) || r.vendor.toLowerCase())}|${r.invoiceNumber.trim().toUpperCase()}|${r.currency}`;
        (byInv.get(key) || byInv.set(key, []).get(key)!).push(r);
    }
    for (const [, g] of byInv) {
        const docs = new Set(g.map((r) => r.documentId));
        if (docs.size < 2) continue;
        const names = [...new Set(g.map((r) => r.filename))];
        const sig = `inv:${names.slice(0, 3).join('|')}`;
        if (seen.has(sig)) continue;
        seen.add(sig);
        out.push(
            `Possible duplicate: **${names.slice(0, 3).join('**, **')}** share vendor + invoice number.`,
        );
    }
    // Weaker: same vendor + amount + currency + date (catches OCR that missed invoice_number)
    const byAmt = new Map<string, FinanceRecord[]>();
    for (const r of records) {
        const amt = Math.round(r.total * 100) / 100;
        const day = r.invoiceDate ? r.invoiceDate.toISOString().slice(0, 10) : 'unknown-date';
        const key = `${canonicalizePartyName(r.vendor) || r.vendor.toLowerCase()}|${r.currency}|${amt}|${day}`;
        (byAmt.get(key) || byAmt.set(key, []).get(key)!).push(r);
    }
    for (const [, g] of byAmt) {
        const docs = new Set(g.map((r) => r.documentId));
        if (docs.size < 2) continue;
        const names = [...new Set(g.map((r) => r.filename))];
        const sig = `amt:${names.slice(0, 3).join('|')}`;
        if (seen.has(sig)) continue;
        seen.add(sig);
        out.push(
            `Possible duplicate: **${names.slice(0, 3).join('**, **')}** share vendor, amount, and invoice date.`,
        );
    }
    return out.slice(0, 5);
}

/**
 * Drop duplicate invoices before aggregation so totals aren't inflated.
 * Keeps the record whose document was uploaded/updated most recently (assumed sort order).
 * Returns dedupedRecords + list of duplicate document ids that were dropped.
 */
export function dedupeFinanceRecords(records: FinanceRecord[]): {
    records: FinanceRecord[];
    droppedDocumentIds: string[];
    droppedFilenames: string[];
} {
    const groups = groupDuplicateRecords(records);
    const keep: FinanceRecord[] = [];
    const droppedDocumentIds: string[] = [];
    const droppedFilenames: string[] = [];
    for (const [, g] of groups) {
        if (g.length === 1) {
            keep.push(g[0]);
            continue;
        }
        // Keep first occurrence (docs are sorted createdAt desc → newest wins).
        keep.push(g[0]);
        for (const dup of g.slice(1)) {
            if (dup.documentId !== g[0].documentId) {
                droppedDocumentIds.push(dup.documentId);
                droppedFilenames.push(dup.filename);
            }
        }
    }
    return { records: keep, droppedDocumentIds: [...new Set(droppedDocumentIds)], droppedFilenames: [...new Set(droppedFilenames)] };
}

export type PaymentSettlementResult = {
    /** Invoice / non-payment rows with outstanding + paidApplied set. */
    records: FinanceRecord[];
    payments: FinanceRecord[];
    /** Payments that reduced at least one invoice. */
    appliedPayments: number;
    /** Payments with no matching invoice (missing/wrong INV# or currency). */
    unmatchedPayments: number;
    totalPaidApplied: number;
    totalOutstanding: number;
    totalGross: number;
};

/**
 * Match payment_receipt rows to invoices by invoice number + currency and compute
 * outstanding = invoice total − applied payments (floored at 0).
 */
export function applyPaymentsToInvoices(records: FinanceRecord[]): PaymentSettlementResult {
    const payments = records.filter(isPaymentRecord);
    const others = records.filter((r) => !isPaymentRecord(r));

    const byInv = new Map<string, number[]>();
    others.forEach((r, i) => {
        if (!r.invoiceNumber) return;
        const key = `${normalizeInvoiceNumberKey(r.invoiceNumber)}|${r.currency}`;
        const arr = byInv.get(key) || [];
        arr.push(i);
        byInv.set(key, arr);
    });

    const paidByIdx = new Map<number, number>();
    let appliedPayments = 0;
    let unmatchedPayments = 0;
    let totalPaidApplied = 0;

    for (const p of payments) {
        const ref = (p.paysInvoiceNumber || '').trim();
        const payAmt = p.amountPaid ?? p.total;
        if (!ref || !(payAmt > 0)) {
            unmatchedPayments += 1;
            continue;
        }
        const key = `${normalizeInvoiceNumberKey(ref)}|${p.currency}`;
        const idxs = byInv.get(key);
        if (!idxs?.length) {
            unmatchedPayments += 1;
            continue;
        }
        let remaining = payAmt;
        let appliedThis = 0;
        for (const i of idxs) {
            if (remaining <= 0) break;
            const inv = others[i];
            const already = paidByIdx.get(i) || 0;
            const open = Math.max(0, inv.total - already);
            const apply = Math.min(open, remaining);
            if (apply <= 0) continue;
            paidByIdx.set(i, already + apply);
            remaining -= apply;
            appliedThis += apply;
        }
        if (appliedThis > 0) {
            appliedPayments += 1;
            totalPaidApplied += appliedThis;
        } else {
            unmatchedPayments += 1;
        }
    }

    const settled = others.map((r, i) => {
        const paid = paidByIdx.get(i) || 0;
        const outstanding = Math.max(0, Math.round((r.total - paid) * 100) / 100);
        return {
            ...r,
            recordKind: r.recordKind || (r.classification === 'purchase_order' ? 'other' : 'invoice'),
            paidApplied: Math.round(paid * 100) / 100,
            outstanding,
        };
    });

    const invoiceLike = settled.filter((r) => r.recordKind !== 'other');
    const totalGross = invoiceLike.reduce((s, r) => s + r.total, 0);
    const totalOutstanding = invoiceLike.reduce((s, r) => s + (r.outstanding ?? r.total), 0);

    return {
        records: settled,
        payments,
        appliedPayments,
        unmatchedPayments,
        totalPaidApplied: Math.round(totalPaidApplied * 100) / 100,
        totalOutstanding: Math.round(totalOutstanding * 100) / 100,
        totalGross: Math.round(totalGross * 100) / 100,
    };
}

export type PoInvoicePair = {
    poNumber: string;
    vendor: string;
    currency: string;
    poDocumentId?: string;
    poFilename?: string;
    poAmount?: number;
    invoiceDocumentIds: string[];
    invoiceFilenames: string[];
    invoicedAmount: number;
    variance: number;
    variancePct: number | null;
    /** 'matched' | 'over_invoiced' | 'under_invoiced' | 'po_only' | 'invoice_only' */
    status: 'matched' | 'over_invoiced' | 'under_invoiced' | 'po_only' | 'invoice_only';
};

/** Pair purchase_order records with invoice records by po_number + vendor + currency. */
export function pairPurchaseOrdersWithInvoices(records: FinanceRecord[]): PoInvoicePair[] {
    const groups = new Map<string, { po?: FinanceRecord; invoices: FinanceRecord[] }>();
    for (const r of records) {
        if (isPaymentRecord(r)) continue;
        if (!r.poNumber) continue;
        const vendorKey = canonicalizePartyName(r.vendor) || r.vendor.toLowerCase();
        const key = `${r.poNumber}|${vendorKey}|${r.currency}`;
        const g = groups.get(key) || { invoices: [] };
        const cls = (r.classification || '').toLowerCase();
        if (cls === 'purchase_order' || cls === 'po' || cls === 'quotation') {
            // Keep the largest PO if multiple (usually the header total, not a line).
            if (!g.po || r.total > g.po.total) g.po = r;
        } else {
            g.invoices.push(r);
        }
        groups.set(key, g);
    }
    const pairs: PoInvoicePair[] = [];
    for (const [key, g] of groups) {
        const [poNumber] = key.split('|');
        const anchor = g.po || g.invoices[0];
        if (!anchor) continue;
        const invoicedAmount = g.invoices.reduce((s, r) => s + r.total, 0);
        const poAmount = g.po?.total ?? 0;
        const variance = invoicedAmount - poAmount;
        const variancePct = poAmount > 0 ? Math.round((variance / poAmount) * 1000) / 10 : null;
        let status: PoInvoicePair['status'];
        if (g.po && !g.invoices.length) status = 'po_only';
        else if (!g.po && g.invoices.length) status = 'invoice_only';
        else if (Math.abs(variance) <= Math.max(1, poAmount * 0.02)) status = 'matched';
        else if (variance > 0) status = 'over_invoiced';
        else status = 'under_invoiced';
        pairs.push({
            poNumber,
            vendor: anchor.vendor,
            currency: anchor.currency,
            poDocumentId: g.po?.documentId,
            poFilename: g.po?.filename,
            poAmount: g.po?.total,
            invoiceDocumentIds: g.invoices.map((r) => r.documentId),
            invoiceFilenames: g.invoices.map((r) => r.filename),
            invoicedAmount,
            variance,
            variancePct,
            status,
        });
    }
    return pairs.sort((a, b) => Math.abs(b.variance) - Math.abs(a.variance));
}

export function formatPoPairingTable(pairs: PoInvoicePair[], maxRows = 15): string {
    if (!pairs.length) return '';
    const rows = pairs.slice(0, maxRows);
    const lines = [
        `| PO | Vendor | PO amount | Invoiced | Variance | Status |`,
        `| --- | --- | ---: | ---: | ---: | --- |`,
        ...rows.map((p) => {
            const cur = p.currency;
            const poAmt = p.poAmount != null ? p.poAmount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '—';
            const invAmt = p.invoicedAmount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
            const varStr = `${p.variance >= 0 ? '+' : ''}${p.variance.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}${p.variancePct != null ? ` (${p.variancePct}%)` : ''}`;
            const statusLabel = p.status === 'matched' ? '✅ matched' : p.status === 'over_invoiced' ? '⚠️ over-invoiced' : p.status === 'under_invoiced' ? 'ℹ️ under-invoiced' : p.status === 'po_only' ? '📋 PO only' : '🧾 invoice only';
            return `| ${p.poNumber} | ${p.vendor.replace(/\|/g, '\\|')} | ${cur} ${poAmt} | ${cur} ${invAmt} | ${varStr} | ${statusLabel} |`;
        }),
    ];
    return lines.join('\n');
}

export const DEFAULT_FX_RATES_TO_USD: Record<string, number> = {
    USD: 1.0,
    PKR: 278.0,
    EUR: 0.92,
    GBP: 0.78,
    AED: 3.67,
    INR: 83.5,
    CAD: 1.36,
    AUD: 1.52,
    SAR: 3.75,
};

export function convertCurrencyAmount(
    amount: number,
    fromCurrency: string,
    targetCurrency: string,
    customRates?: Record<string, number>
): { amount: number; converted: boolean } {
    const from = (fromCurrency || 'USD').toUpperCase();
    const target = (targetCurrency || 'USD').toUpperCase();
    if (from === target) return { amount, converted: false };

    const rates: Record<string, number> = { ...DEFAULT_FX_RATES_TO_USD, ...(customRates || {}) };
    const fromRateToUSD = rates[from];
    const targetRateToUSD = rates[target];

    if (!fromRateToUSD || !targetRateToUSD || fromRateToUSD <= 0 || targetRateToUSD <= 0) {
        return { amount, converted: false };
    }

    const amountInUSD = amount / fromRateToUSD;
    const convertedAmount = amountInUSD * targetRateToUSD;
    return { amount: convertedAmount, converted: true };
}

function aggregateByParty(
    records: FinanceRecord[],
    party: 'vendor' | 'client',
    maxBars = 20,
    vendorAliases?: Record<string, string>,
    preferredCurrency?: string,
    fxRates?: Record<string, number>
): { rows: ChatVisualDataRow[]; currency: string; docCount: number } {
    const currency = (preferredCurrency || dominantCurrency(records, preferredCurrency)).toUpperCase();
    const groups = new Map<string, { label: string; amount: number; docs: Set<string> }>();

    for (const r of records) {
        if (isPaymentRecord(r)) continue;
        const raw = party === 'vendor' ? r.vendor : r.client;
        if (!raw?.trim()) continue;
        const key = normalizePartyKey(raw, party === 'vendor' ? vendorAliases : undefined);
        const rawAmt = chartAmount(r);
        let convertedAmt = rawAmt;
        if (preferredCurrency) {
            const from = (r.currency || '').toUpperCase();
            const to = preferredCurrency.toUpperCase();
            if (from && from !== to) {
                const fx = convertCurrencyAmount(rawAmt, from, to, fxRates);
                if (!fx.converted) continue;
                convertedAmt = fx.amount;
            }
        } else if ((r.currency || '').toUpperCase() !== currency) {
            continue;
        }

        const existing = groups.get(key);
        if (existing) {
            existing.amount += convertedAmt;
            existing.docs.add(r.documentId);
        } else {
            groups.set(key, {
                label: raw.trim(),
                amount: convertedAmt,
                docs: new Set([r.documentId]),
            });
        }
    }

    const sorted = [...groups.values()].sort((a, b) => b.amount - a.amount).slice(0, maxBars);
    const categoryKey = party === 'vendor' ? 'vendor' : 'client';
    const rows: ChatVisualDataRow[] = sorted.map((g) => ({
        [categoryKey]: g.label.length > 32 ? `${g.label.slice(0, 30)}…` : g.label,
        amount: Math.round(g.amount * 100) / 100,
        _documentIds: docIdsField(g.docs),
    }));

    const docCount = new Set(records.filter((r) => !isPaymentRecord(r)).map((r) => r.documentId)).size;
    return { rows, currency, docCount };
}

export function detectCurrencyPreference(question: string): string | undefined {
    const q = question.toLowerCase();
    if (/\b(pkr|rupees|rs|rupee|pakistani)\b/.test(q)) return 'PKR';
    if (/\b(usd|dollar|dollars|\$)\b/.test(q)) return 'USD';
    if (/\b(eur|euro|euros|€)\b/.test(q)) return 'EUR';
    if (/\b(gbp|pound|pounds|£)\b/.test(q)) return 'GBP';
    return undefined;
}

export function formatVendorSpendTable(
    records: FinanceRecord[],
    maxRows = 25,
    preferredCurrency?: string
): string {
    const { rows, currency, docCount } = aggregateByParty(
        records,
        'vendor',
        maxRows,
        undefined,
        preferredCurrency,
        DEFAULT_FX_RATES_TO_USD
    );
    if (!rows.length) return '_No vendor totals could be computed from extractions._';
    const settled = records.some((r) => (r.paidApplied || 0) > 0);
    const lines = [
        `| Vendor | ${settled ? 'Outstanding' : 'Total'} (${currency}) | Invoices |`,
        `| --- | ---: | ---: |`,
        ...rows.map((r) => {
            const vendor = String(r.vendor ?? '');
            const amount = Number(r.amount ?? 0);
            const ids = String(r._documentIds || '');
            const invCount = ids ? ids.split(',').filter(Boolean).length : 0;
            return `| ${vendor.replace(/\|/g, '\\|')} | ${amount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} | ${invCount || '—'} |`;
        }),
    ];
    const totalsByCurrency = sumTotalsByCurrency(records);
    const totalsSummaryLines: string[] = [];
    for (const [cur, amt] of totalsByCurrency.entries()) {
        totalsSummaryLines.push(`**${cur}** ${amt.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
    }

    lines.push('');
    lines.push(
        `**Grand ${settled ? 'outstanding' : 'total'}:** ${totalsSummaryLines.join(' · ')} across **${docCount}** invoice document(s).`
    );
    return lines.join('\n');
}

export function buildVendorSpendVisual(
    records: FinanceRecord[],
    opts?: { vendorAliases?: Record<string, string>; baseCurrency?: string; preferredCurrency?: string; fxRates?: Record<string, number> }
): ChatVisualSpec {
    const { rows, currency, docCount } = aggregateByParty(
        records,
        'vendor',
        20,
        opts?.vendorAliases,
        opts?.preferredCurrency,
        opts?.fxRates
    );
    const withVendor = records.filter((r) => !isPaymentRecord(r) && r.vendor && r.vendor !== 'Unknown vendor');
    const sourceDocumentIds = [...new Set(records.filter((r) => !isPaymentRecord(r)).map((r) => r.documentId))];
    const unknown = records.filter(
        (r) => !isPaymentRecord(r) && (!r.vendor || r.vendor === 'Unknown vendor')
    ).length;
    const settled = records.some((r) => (r.paidApplied || 0) > 0);
    const warnings: string[] = [];
    if (unknown) warnings.push(`${unknown} document(s) missing vendor_name — reprocess if labels look wrong.`);
    warnings.push(...findDuplicateInvoiceWarnings(records.filter((r) => !isPaymentRecord(r))));
    if (sourceDocumentIds.length === 1) {
        warnings.push(`Scoped to 1 file: ${records.find((r) => !isPaymentRecord(r))?.filename || 'invoice'}.`);
    }

    return {
        id: `fin_vendor_${Date.now()}`,
        agentId: FINANCE_AGENT,
        kind: 'bar',
        title: sourceDocumentIds.length === 1 ? 'AP — this invoice' : 'Accounts payable — by vendor',
        subtitle: `${rows.length} vendor(s) · ${docCount} document(s) · primary ${currency} · ${settled ? 'net outstanding' : 'gross invoice totals'}`,
        currency,
        categoryKey: 'vendor',
        series: [
            {
                key: 'amount',
                label: settled ? `Outstanding (${currency})` : `AP amount (${currency})`,
                color: '#2563eb',
            },
        ],
        data: rows,
        emptyState: rows.length ? undefined : 'No vendor names extracted. Reprocess invoices or ask for line items.',
        sourceDocumentIds,
        dataQuality: {
            level: unknown || warnings.length > 1 ? 'medium' : 'high',
            warnings: warnings.length ? warnings : undefined,
        },
        footer: withVendor.length
            ? settled
                ? `AP view: invoice total − matched payment receipts (by invoice #). Files: ${sourceDocumentIds.length}.`
                : `AP view: sum of extracted total_amount per invoice. Add payment receipts to net outstanding. Files: ${sourceDocumentIds.length}.`
            : 'Add vendor_name on invoices or line items with vendor to populate this chart.',
    };
}

export function formatClientSpendTable(
    records: FinanceRecord[],
    maxRows = 100,
    preferredCurrency?: string
): string {
    const clientRecords = records.filter((r) => !isPaymentRecord(r) && r.client.trim());
    const { rows, currency, docCount } = aggregateByParty(
        clientRecords,
        'client',
        maxRows,
        undefined,
        preferredCurrency,
        DEFAULT_FX_RATES_TO_USD
    );
    if (!rows.length) return '_No client totals — customer_name / bill_to missing on extractions._';
    const settled = records.some((r) => (r.paidApplied || 0) > 0);
    const lines = [
        `| Client | ${settled ? 'Outstanding' : 'Total'} (${currency}) | Invoices |`,
        `| --- | ---: | ---: |`,
        ...rows.map((r) => {
            const client = String(r.client ?? '');
            const amount = Number(r.amount ?? 0);
            const ids = String(r._documentIds || '');
            const invCount = ids ? ids.split(',').filter(Boolean).length : 0;
            return `| ${client.replace(/\|/g, '\\|')} | ${amount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} | ${invCount || '—'} |`;
        }),
    ];
    lines.push('');
    lines.push(`**Clients in chart:** ${rows.length} · **Invoice documents:** ${docCount}`);
    return lines.join('\n');
}

export function buildClientSpendVisual(
    records: FinanceRecord[],
    opts?: { vendorAliases?: Record<string, string>; baseCurrency?: string; preferredCurrency?: string; fxRates?: Record<string, number> }
): ChatVisualSpec {
    const nonPay = records.filter((r) => !isPaymentRecord(r));
    const clientRecords = nonPay.filter((r) => r.client.trim());
    const missingClientRecords = nonPay.filter((r) => !r.client.trim());
    const maxBars = Math.min(100, Math.max(20, new Set(clientRecords.map((r) => r.client)).size));
    const { rows, currency, docCount } = aggregateByParty(
        clientRecords,
        'client',
        maxBars,
        undefined,
        opts?.preferredCurrency,
        opts?.fxRates
    );
    const settled = nonPay.some((r) => (r.paidApplied || 0) > 0);

    // Add a "Missing client" bucket so users see excluded totals instead of us hiding them.
    const missingAmount = missingClientRecords.reduce((sum, r) => {
        const raw = chartAmount(r);
        const from = (r.currency || '').toUpperCase();
        if (!from || from === currency) return sum + raw;
        const fx = convertCurrencyAmount(raw, from, currency, opts?.fxRates);
        return fx.converted ? sum + fx.amount : sum;
    }, 0);
    const missingDocIds = [...new Set(missingClientRecords.map((r) => r.documentId))];
    const dataRows: ChatVisualDataRow[] = [...rows];
    if (missingClientRecords.length) {
        dataRows.push({
            client: `Missing client (${missingClientRecords.length})`,
            amount: Math.round(missingAmount * 100) / 100,
            _documentIds: missingDocIds.join(','),
        });
    }

    const totalRecords = nonPay.length;
    const missingRatio = totalRecords ? missingClientRecords.length / totalRecords : 0;
    const warnings: string[] = [];
    if (missingClientRecords.length) {
        warnings.push(
            `${missingClientRecords.length} of ${totalRecords} invoice(s) have no customer_name / bill_to / client_name — grouped under "Missing client".`
        );
    }
    const quality: 'high' | 'medium' | 'low' =
        missingRatio >= 0.5 ? 'low' : missingRatio >= 0.2 ? 'medium' : 'high';

    return {
        id: `fin_client_${Date.now()}`,
        agentId: FINANCE_AGENT,
        kind: 'bar',
        title: 'Accounts receivable — by client',
        subtitle: `${rows.length} client(s)${missingClientRecords.length ? ` + missing bucket` : ''} · ${docCount} document(s) · primary ${currency} · ${settled ? 'net outstanding' : 'gross invoice totals'}`,
        currency,
        categoryKey: 'client',
        series: [
            {
                key: 'amount',
                label: settled ? `Outstanding (${currency})` : `AR amount (${currency})`,
                color: '#4f46e5',
            },
        ],
        data: dataRows.length
            ? dataRows
            : [{ client: 'No client on file', amount: 0 }],
        footer: settled
            ? 'AR view: customer totals after matching payment receipts by invoice #.'
            : 'AR view: grouped by customer_name / bill_to / client_name. Add payment receipts to net outstanding.',
        dataQuality: warnings.length ? { level: quality, warnings } : undefined,
        emptyState: dataRows.length
            ? undefined
            : 'No invoices with a client field in scope. Reprocess so customer_name / bill_to are extracted.',
    };
}

export function buildMonthlyTrendVisual(records: FinanceRecord[]): ChatVisualSpec {
    const invoices = records.filter((r) => !isPaymentRecord(r));
    const currency = dominantCurrency(invoices.length ? invoices : records);
    const filtered = invoices.filter((r) => r.currency === currency && r.invoiceDate);
    const byMonth = new Map<string, { amount: number; docs: Set<string> }>();
    for (const r of filtered) {
        const d = r.invoiceDate!;
        const key = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
        const cur = byMonth.get(key);
        if (cur) {
            cur.amount += r.total;
            cur.docs.add(r.documentId);
        } else {
            byMonth.set(key, { amount: r.total, docs: new Set([r.documentId]) });
        }
    }
    const rows: ChatVisualDataRow[] = [...byMonth.entries()]
        .sort((a, b) => a[0].localeCompare(b[0]))
        .slice(-12)
        .map(([month, v]) => ({
            month,
            amount: Math.round(v.amount * 100) / 100,
            _documentIds: docIdsField(v.docs),
        }));

    const missingDates = invoices.filter((r) => !r.invoiceDate).length;
    const otherCurrency = invoices.filter((r) => r.currency !== currency).length;
    const warnings: string[] = [];
    if (!rows.length && invoices.length) {
        warnings.push(
            `${invoices.length} invoice(s) in scope, but none have an invoice_date extracted.`
        );
    } else if (missingDates > 0) {
        warnings.push(`${missingDates} invoice(s) skipped — no invoice_date on extraction.`);
    }
    if (otherCurrency > 0) {
        warnings.push(
            `${otherCurrency} invoice(s) in other currencies excluded from this ${currency} trend.`
        );
    }

    return {
        id: `fin_trend_${Date.now()}`,
        agentId: FINANCE_AGENT,
        kind: 'area',
        title: 'Invoice volume over time',
        subtitle: `Monthly billed totals · ${currency}${otherCurrency ? ` · ${otherCurrency} other-currency excluded` : ''}`,
        currency,
        categoryKey: 'month',
        series: [{ key: 'amount', label: `Billed (${currency})`, color: '#0d9488' }],
        data: rows,
        footer: 'Gross invoice totals by invoice_date (payments are not included in the trend).',
        emptyState: rows.length
            ? undefined
            : 'No invoice_date fields found on scoped invoices. Reprocess them so the trend can be plotted.',
        dataQuality: warnings.length
            ? { level: rows.length ? 'medium' : 'low', warnings }
            : undefined,
    };
}

export function buildAgingVisual(records: FinanceRecord[]): ChatVisualSpec {
    const invoices = records.filter((r) => !isPaymentRecord(r));
    const currency = dominantCurrency(invoices.length ? invoices : records);
    const filtered = invoices.filter((r) => r.currency === currency);
    const now = Date.now();
    const bucketKeys = ['Current (not due)', '1–30 days', '31–60 days', '61–90 days', '90+ days'] as const;
    const buckets = new Map<string, { amount: number; docs: Set<string> }>();
    for (const k of bucketKeys) buckets.set(k, { amount: 0, docs: new Set() });
    const settled = invoices.some((r) => (r.paidApplied || 0) > 0);

    for (const r of filtered) {
        let key: (typeof bucketKeys)[number] = 'Current (not due)';
        if (!r.dueDate) {
            key = 'Current (not due)';
        } else {
            const due = r.dueDate.getTime();
            if (due >= now) {
                key = 'Current (not due)';
            } else {
                const days = Math.floor((now - due) / (86400 * 1000));
                if (days <= 30) key = '1–30 days';
                else if (days <= 60) key = '31–60 days';
                else if (days <= 90) key = '61–90 days';
                else key = '90+ days';
            }
        }
        const b = buckets.get(key)!;
        b.amount += chartAmount(r);
        b.docs.add(r.documentId);
    }

    const rows: ChatVisualDataRow[] = bucketKeys.map((bucket) => {
        const b = buckets.get(bucket)!;
        return {
            bucket,
            amount: Math.round(b.amount * 100) / 100,
            _documentIds: docIdsField(b.docs),
        };
    });

    const otherCurrency = invoices.filter((r) => r.currency !== currency).length;
    const warnings: string[] = [];
    if (settled) {
        warnings.push('Aging uses outstanding = invoice total − matched payment receipts (by invoice #).');
    } else {
        warnings.push('Aging uses gross invoice totals. Add payment receipts that reference invoice numbers to net outstanding.');
    }
    if (otherCurrency > 0) {
        warnings.push(
            `${otherCurrency} invoice(s) in other currencies excluded from this ${currency} aging chart.`
        );
    }

    return {
        id: `fin_aging_${Date.now()}`,
        agentId: FINANCE_AGENT,
        kind: 'bar',
        title: settled ? 'AP aging (outstanding by due date)' : 'AP aging (by due date)',
        subtitle: `By due date · ${currency}${otherCurrency ? ` · ${otherCurrency} other-currency excluded` : ''}`,
        currency,
        categoryKey: 'bucket',
        series: [
            {
                key: 'amount',
                label: settled ? `Outstanding (${currency})` : `Amount (${currency})`,
                color: '#d97706',
            },
        ],
        data: rows,
        footer: settled
            ? 'Outstanding balances by due_date after payment matching.'
            : 'Totals from due_date + total_amount. Match payment receipts by invoice # for net outstanding.',
        dataQuality: { level: otherCurrency || !settled ? 'medium' : 'high', warnings },
    };
}

export function buildDocTypeMixVisual(counts: Array<{ type: string; count: number }>): ChatVisualSpec {
    const rows = counts.map((c) => ({
        type: c.type.replace(/_/g, ' '),
        count: c.count,
    }));
    return {
        id: `fin_mix_${Date.now()}`,
        agentId: FINANCE_AGENT,
        kind: 'pie',
        title: 'Finance documents by type',
        subtitle: 'Your library mix',
        categoryKey: 'type',
        series: [{ key: 'count', label: 'Documents' }],
        data: rows,
        footer: 'Classification counts for finance-related files.',
    };
}

export function sumTotalsByCurrency(records: FinanceRecord[]): Map<string, number> {
    const map = new Map<string, number>();
    for (const r of records) {
        if (isPaymentRecord(r)) continue;
        map.set(r.currency, (map.get(r.currency) || 0) + chartAmount(r));
    }
    return map;
}

/** Convert records into a requested display currency (e.g. user said "in PKR"). */
export function convertFinanceRecordsToCurrency(
    records: FinanceRecord[],
    targetCurrency: string,
    customRates?: Record<string, number>
): { records: FinanceRecord[]; converted: number; skippedCurrencies: string[] } {
    const target = (targetCurrency || '').toUpperCase().slice(0, 3);
    if (!target) return { records, converted: 0, skippedCurrencies: [] };
    let converted = 0;
    const skipped = new Set<string>();
    const out = records.map((r) => {
        const from = (r.currency || '').toUpperCase().slice(0, 3);
        if (!from || from === target) return r;
        const fx = convertCurrencyAmount(r.total, from, target, customRates);
        if (!fx.converted || !r.total) {
            skipped.add(from);
            return r;
        }
        converted += 1;
        const scale = fx.amount / r.total;
        return {
            ...r,
            total: fx.amount,
            currency: target,
            outstanding: r.outstanding != null ? r.outstanding * scale : fx.amount,
            amountPaid: r.amountPaid != null ? r.amountPaid * scale : undefined,
            paidApplied: r.paidApplied != null ? r.paidApplied * scale : undefined,
        };
    });
    return { records: out, converted, skippedCurrencies: [...skipped] };
}

/**
 * Convert every record to `baseCurrency` using org fxRates.
 * Records whose currency has no rate keep their original value + currency (and are
 * surfaced as `unconvertedCurrencies` so the UI can warn).
 */
export function convertRecordsToBase(
    records: FinanceRecord[],
    settings: { baseCurrency?: string; fxRates?: Record<string, number> },
): { records: FinanceRecord[]; converted: number; unconvertedCurrencies: string[] } {
    const base = settings.baseCurrency;
    if (!base || !settings.fxRates || !Object.keys(settings.fxRates).length) {
        return { records, converted: 0, unconvertedCurrencies: [] };
    }
    let converted = 0;
    const missing = new Set<string>();
    const out = records.map((r) => {
        if (!r.currency || r.currency === base) return r;
        const rate = settings.fxRates?.[r.currency];
        if (!rate || rate <= 0) {
            missing.add(r.currency);
            return r;
        }
        converted += 1;
        const scale = (n: number | undefined) =>
            n != null && Number.isFinite(n) ? n / rate : undefined;
        return {
            ...r,
            total: r.total / rate,
            currency: base,
            amountPaid: scale(r.amountPaid),
            outstanding: scale(r.outstanding),
            paidApplied: scale(r.paidApplied),
        };
    });
    return { records: out, converted, unconvertedCurrencies: [...missing] };
}

const QUESTION_STOP_WORDS = new Set([
    'give',
    'show',
    'short', // typo for "show"
    'visual',
    'chart',
    'graph',
    'plot',
    'please',
    'invoice',
    'invoices',
    'document',
    'documents',
    'file',
    'files',
    'pdf',
    'items',
    'item',
    'each',
    'also',
    'with',
    'from',
    'that',
    'this',
    'them',
    'those',
    'these',
    'your',
    'have',
    'only',
    'just',
    'about',
    'full',
    'complete',
    'price',
    'quantity',
    'subtotal',
    'total',
    'totals',
    'amount',
    'amounts',
    'line',
    'lines',
    'spend',
    'vendor',
    'vendors',
    'client',
    'clients',
    'customers',
    'breakdown',
    'analytics',
    'overview',
    'all',
    'every',
    'each',
    'entire',
    'whole',
    'data',
    'chat',
    'what',
    'across',
    'scope',
    'scoped',
    'portfolio',
    'list',
    'lists',
    'listing',
    'clietns',
    'clietn',
    'cleints',
    'cleint',
    'electronics', // too generic alone; digilog/bata still match
]);

/**
 * Filename / question-token OCR aliases used only for document-name matching.
 * Display labels still come from extraction + org finance vendorAliases (not forced here).
 */
const NAME_ALIASES: Record<string, string> = {
    dialong: 'digilog',
    dialog: 'digilog',
    dialogs: 'digilog',
    glectronics: 'digilog',
    glectronic: 'digilog',
    nigilog: 'digilog',
    nigilogic: 'digilog',
    clectronics: 'digilog',
    clectronic: 'digilog',
};

const OCR_FAMILY_PATTERNS: Array<{ re: RegExp; canonical: string }> = [
    { re: /^(glectroni|nigilog|clectroni|digilog|dialog)/i, canonical: 'digilog' },
];

function editDistance(a: string, b: string): number {
    if (a === b) return 0;
    if (!a.length) return b.length;
    if (!b.length) return a.length;
    const prev = new Array(b.length + 1);
    const cur = new Array(b.length + 1);
    for (let j = 0; j <= b.length; j++) prev[j] = j;
    for (let i = 1; i <= a.length; i++) {
        cur[0] = i;
        for (let j = 1; j <= b.length; j++) {
            const cost = a[i - 1] === b[j - 1] ? 0 : 1;
            cur[j] = Math.min(cur[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
        }
        for (let j = 0; j <= b.length; j++) prev[j] = cur[j];
    }
    return prev[b.length];
}

/** Expand a raw token with aliases + fuzzy OCR family (glectronic → digilog). */
export function expandNameToken(token: string): string[] {
    const w = token.toLowerCase().trim();
    if (!w) return [];
    const out = new Set<string>([w]);
    if (NAME_ALIASES[w]) out.add(NAME_ALIASES[w]);
    for (const [k, v] of Object.entries(NAME_ALIASES)) {
        if (w === k || w.startsWith(k) || k.startsWith(w)) out.add(v);
        else if (w.length >= 5 && k.length >= 5 && editDistance(w, k) <= 2) out.add(v);
    }
    for (const { re, canonical } of OCR_FAMILY_PATTERNS) {
        if (re.test(w)) out.add(canonical);
    }
    return [...out];
}

/** Tokens from the question that might be a filename / vendor / invoice #. */
export function extractExplicitFilenameFromQuestion(question: string): string | null {
    const m = question.match(/\b([a-z0-9][a-z0-9._-]{1,120}\.(?:xlsx?|xls|csv|tsv|ods|pdf))\b/i);
    return m ? m[1] : null;
}

export function matchDocumentsByExplicitFilename(docs: NameMatchDoc[], question: string): string[] {
    const explicit = extractExplicitFilenameFromQuestion(question);
    if (!explicit || !docs.length) return [];
    const target = explicit.toLowerCase();
    const stem = target.replace(/\.[a-z0-9]+$/i, '');

    const exact = docs.filter((d) => (d.originalFilename || '').toLowerCase() === target);
    if (exact.length === 1) return [exact[0].documentId];
    if (exact.length > 1) return [exact[0].documentId];

    const partial = docs.filter((d) => {
        const name = (d.originalFilename || '').toLowerCase();
        return name === target || name.includes(stem) || stem.includes(name.replace(/\.[a-z0-9]+$/i, ''));
    });
    if (partial.length === 1) return [partial[0].documentId];
    if (partial.length > 1) {
        const stemHits = partial.filter((d) =>
            (d.originalFilename || '').toLowerCase().includes(stem)
        );
        if (stemHits.length === 1) return [stemHits[0].documentId];
        return [partial[0].documentId];
    }
    return [];
}

export function extractDocumentNameTokens(question: string): string[] {
    const normalized = normalizeFinanceUserQuestion(question).replace(/[^a-z0-9\s_-]/g, ' ');
    const words = normalized
        .split(/\s+/)
        .map((w) => w.trim())
        .filter((w) => w.length >= 3 && !QUESTION_STOP_WORDS.has(w));

    const expanded = new Set<string>();
    for (const w of words) {
        for (const t of expandNameToken(w)) expanded.add(t);
    }
    for (const m of question.match(/\d{4,}/g) || []) {
        expanded.add(m);
    }
    return [...expanded];
}

export type NameMatchDoc = {
    documentId: string;
    originalFilename: string;
    /** Extra haystack: vendor, client, invoice #, OCR aliases */
    searchText?: string;
};

/**
 * Score scoped docs against name tokens in the question.
 * Returns only the best match(es) — never the whole scope.
 */
export function matchDocumentIdsByNameTokens(docs: NameMatchDoc[], question: string): string[] {
    const byExplicit = matchDocumentsByExplicitFilename(docs, question);
    if (byExplicit.length) return byExplicit;

    if (wantsFinanceListAllScope(question)) return [];

    const q = normalizeFinanceUserQuestion(question);
    if (/\b(all|every|full|entire)\b/.test(q) && /\b(client|customer|vendor|supplier|lists?|data)\b/.test(q)) {
        return [];
    }
    const tokens = extractDocumentNameTokens(question);
    if (!tokens.length || !docs.length) return [];

    const scored = docs
        .map((d) => {
            const name = (d.originalFilename || '').toLowerCase();
            const stem = name.replace(/\.[a-z0-9]+$/i, '');
            const compact = stem.replace(/[^a-z0-9]+/g, '');
            const extra = (d.searchText || '').toLowerCase();
            const hay = `${stem} ${compact} ${name} ${extra}`;
            let score = 0;
            for (const w of tokens) {
                if (!w) continue;
                const wc = w.replace(/[^a-z0-9]/g, '');
                if (stem === w || compact === w) score += 12;
                else if (stem.includes(w) || compact.includes(wc)) score += 6;
                else if (extra.includes(w) || (wc && extra.includes(wc))) score += 8; // vendor / OCR label
                else if (name.includes(w) || hay.includes(w)) score += 4;
                else if (stem.split(/[^a-z0-9]+/).some((p) => p === w || p.startsWith(w))) score += 5;
            }
            // Digilog OCR family: filename has digilog OR searchText has glectronic*
            if (
                tokens.includes('digilog') &&
                (/digilog|nigilog|glectronic|clectronic/i.test(hay) || /digilog/i.test(name))
            ) {
                score += 10;
            }
            return { documentId: d.documentId, score, filename: d.originalFilename };
        })
        .filter((x) => x.score > 0)
        .sort((a, b) => b.score - a.score);

    if (!scored.length) return [];
    const top = scored[0].score;
    return scored.filter((s) => s.score === top).map((s) => s.documentId);
}

/** Attach Digilog OCR synonyms into searchText when filename/vendor hints Digilog. */
export function enrichSearchTextForDoc(filename: string, vendorOrExtra = ''): string {
    const base = `${filename} ${vendorOrExtra}`.toLowerCase();
    const bits = [vendorOrExtra];
    if (/digilog|nigilog|glectronic|clectronic|dialog/i.test(base)) {
        bits.push('digilog', 'glectronics', 'glectronic', 'nigilog', 'digilog electronics');
    }
    return bits.filter(Boolean).join(' ');
}

export type LineItemRow = {
    description: string;
    quantity: number;
    unitPrice: number;
    total: number;
};

export function extractLineItemRows(data: Record<string, unknown>): LineItemRow[] {
    const items = data.line_items;
    if (!Array.isArray(items)) return [];
    const rows: LineItemRow[] = [];
    for (const item of items) {
        if (!item || typeof item !== 'object') continue;
        const row = item as Record<string, unknown>;
        const desc =
            scalarField(row.description) ||
            scalarField(row.item) ||
            scalarField(row.product_name) ||
            scalarField(row.name) ||
            'Item';
        const sku = scalarField(row.sku);
        const label = sku ? `${desc} (${sku})` : desc;

        let qty = parseNumber(row.quantity) ?? parseNumber(row.qty);
        let unit =
            parseNumber(row.unit_price) ??
            parseNumber(row.price) ??
            parseNumber(row.rate) ??
            parseNumber(row.unit_rate);
        let total =
            parseNumber(row.total_price) ??
            parseNumber(row.total) ??
            parseNumber(row.amount) ??
            parseNumber(row.line_total) ??
            parseNumber(row.line_amount);

        // Fill missing third value
        if (qty != null && unit != null && (total == null || total <= 0)) {
            total = qty * unit;
        } else if (qty != null && qty > 0 && total != null && (unit == null || unit <= 0)) {
            unit = total / qty;
        } else if (unit != null && unit > 0 && total != null && (qty == null || qty <= 0)) {
            const q = total / unit;
            qty = Math.abs(q - Math.round(q)) < 0.05 ? Math.round(q) : q;
        }

        qty = qty ?? 1;
        if (total == null || total <= 0) continue;

        // Prefer printed total; fix qty/unit when product mismatches
        if (unit != null && unit > 0 && Math.abs(qty * unit - total) > Math.max(1, 0.02 * total)) {
            const qFromUnit = total / unit;
            if (Math.abs(qFromUnit - Math.round(qFromUnit)) < 0.05 && Math.round(qFromUnit) >= 1) {
                qty = Math.round(qFromUnit);
            } else if (qty > 0) {
                unit = total / qty;
            }
        }

        rows.push({
            description: label,
            quantity: qty,
            unitPrice: unit != null && unit > 0 ? unit : total / qty,
            total,
        });
    }
    return rows;
}

function truncateLabel(text: string, max = 36): string {
    const t = text.trim();
    if (t.length <= max) return t;
    return `${t.slice(0, max - 1)}…`;
}

export function buildLineItemsVisual(
    doc: { documentId: string; originalFilename: string },
    data: Record<string, unknown>
): ChatVisualSpec | null {
    const rows = extractLineItemRows(data);
    if (!rows.length) return null;

    const currency = (scalarField(data.currency) || 'PKR').toUpperCase().slice(0, 3);
    const vendor = pickVendor(data, doc.originalFilename);
    const shortName =
        doc.originalFilename.length > 40
            ? `${doc.originalFilename.slice(0, 38)}…`
            : doc.originalFilename;
    const mismatch = Boolean(data._line_items_total_mismatch);
    const printed =
        parseNumber(data.total_amount) ?? parseNumber(data.grand_total);
    const warnings: string[] = [];
    if (mismatch) {
        warnings.push(
            printed != null
                ? `Line sum differs from printed total (${currency} ${printed}). Chart uses line amounts; trust printed total for the invoice.`
                : 'Line item arithmetic looks inconsistent — reprocess recommended.'
        );
    }

    return {
        id: `fin_lines_${doc.documentId}_${Date.now()}`,
        agentId: FINANCE_AGENT,
        kind: 'bar',
        title: `Invoice line items`,
        subtitle: `${shortName} · ${vendor} · ${rows.length} item(s) · ${currency}`,
        currency,
        categoryKey: 'item',
        series: [{ key: 'amount', label: `Line total (${currency})`, color: '#2563eb' }],
        data: rows.map((r) => ({
            item: truncateLabel(r.description),
            amount: Math.round(r.total * 100) / 100,
            quantity: r.quantity,
            unit_price: Math.round(r.unitPrice * 100) / 100,
            _documentIds: doc.documentId,
        })),
        sourceDocumentIds: [doc.documentId],
        dataQuality: {
            level: mismatch ? 'medium' : 'high',
            warnings: warnings.length ? warnings : undefined,
        },
        actions: mismatch
            ? [
                  {
                      label: 'Reprocess invoice',
                      kind: 'reprocess' as const,
                      documentId: doc.documentId,
                  },
                  {
                      label: 'Open document',
                      kind: 'open_document' as const,
                      documentId: doc.documentId,
                  },
              ]
            : [
                  {
                      label: 'Open document',
                      kind: 'open_document' as const,
                      documentId: doc.documentId,
                  },
              ],
        footer: mismatch
            ? `Data quality: medium · ${warnings[0]} · File: ${shortName}`
            : `Qty & unit price from extraction · ${rows.length} line(s) · File: ${shortName} · ${vendor}`,
    };
}

export async function loadFinanceDocsForAnalytics(
    user: AuthUser,
    options: LoadFinanceOptions = {}
): Promise<
    Array<{
        documentId: string;
        originalFilename: string;
        pythonDocumentId?: string | null;
        organizationId?: string | null;
        metadata?: unknown;
    }>
> {
    const maxDocs = options.maxDocs ?? 50;
    const filter = await buildDocumentFilter(user, {});
    const query = buildFinanceScopeQuery(filter, options.documentIds);
    const docs = await Document.find(query)
        .select('documentId originalFilename classification pythonDocumentId organizationId metadata')
        .sort({ createdAt: -1 })
        .limit(maxDocs)
        .lean();
    return docs.filter(
        (d) =>
            resolveCanonicalAgent({
                originalFilename: d.originalFilename,
                classification: d.classification,
                metadata: d.metadata as { phase3Agent?: string; naturalAgent?: string } | undefined,
            }) === FINANCE_AGENT
    );
}

export async function resolveFinanceDocumentIdsFromQuestion(
    user: AuthUser,
    question: string,
    options?: string[] | { preferIds?: string[]; seedIds?: string[] }
): Promise<string[] | undefined> {
    // Back-compat: third arg used to be seedIds: string[]
    const opts = Array.isArray(options) ? { seedIds: options } : options || {};
    if (opts.seedIds?.length) return opts.seedIds;

    const tokens = extractDocumentNameTokens(question);
    if (!tokens.length) return undefined;

    const filter = await buildDocumentFilter(user, {});
    const prefer = (opts.preferIds || []).filter(Boolean);

    // Prefer matching inside chat scope first (only the named file in selection)
    if (prefer.length) {
        const scopedDocs = await Document.find(buildFinanceScopeQuery(filter, prefer))
            .select('documentId originalFilename')
            .lean();
        const hit = matchDocumentIdsByNameTokens(
            scopedDocs.map((d) => ({
                documentId: d.documentId,
                originalFilename: d.originalFilename,
                searchText: enrichSearchTextForDoc(d.originalFilename),
            })),
            question
        );
        if (hit.length) return hit.slice(0, 1);
    }

    const docs = await Document.find(buildFinanceScopeQuery(filter))
        .select('documentId originalFilename')
        .sort({ createdAt: -1 })
        .limit(200)
        .lean();

    const hit = matchDocumentIdsByNameTokens(
        docs.map((d) => ({
            documentId: d.documentId,
            originalFilename: d.originalFilename,
            searchText: enrichSearchTextForDoc(d.originalFilename),
        })),
        question
    );
    if (!hit.length) return undefined;
    return hit.slice(0, 1);
}

export async function executeLineItemAnalytics(
    user: AuthUser,
    loadOpts: LoadFinanceOptions = {}
): Promise<{
    visuals: ChatVisualSpec[];
    citations: Array<{
        documentId: string;
        filename: string;
        documentType: string;
        phase3Agent: string;
    }>;
    answer: string;
    documentCount: number;
    coverage?: import('../types/chatVisuals').FinanceAnalyticsCoverage;
}> {
    const docs = await loadFinanceDocsForAnalytics(user, loadOpts);
    const docsInScope = docs.length;

    if (!docs.length) {
        return {
            visuals: [],
            citations: [],
            documentCount: 0,
            answer:
                'No invoice documents in scope. Select the invoice in chat scope or mention its filename (e.g. digilog) in your message.',
        };
    }

    const visuals: ChatVisualSpec[] = [];
    const citations: Array<{
        documentId: string;
        filename: string;
        documentType: string;
        phase3Agent: string;
    }> = [];
    const answerParts: string[] = ['Here are the line items from your scoped documents (from extraction):', ''];

    for (const doc of docs) {
        const data = await extractionPayloadForDoc(doc, user, loadOpts.extractionCache, loadOpts.extractionStats);
        const visual = buildLineItemsVisual(doc, data);
        const rows = extractLineItemRows(data);
        const currency = (scalarField(data.currency) || 'PKR').toUpperCase().slice(0, 3);
        const printedTotal =
            parseNumber(data.total_amount) ?? parseNumber(data.grand_total);
        const mismatch = Boolean(data._line_items_total_mismatch);

        citations.push({
            documentId: doc.documentId,
            filename: doc.originalFilename,
            documentType: 'invoice',
            phase3Agent: FINANCE_AGENT,
        });

        if (rows.length) {
            if (visual) visuals.push(visual);
            answerParts.push(`### ${doc.originalFilename}`);
            answerParts.push('| Item | Qty | Unit price | Line total |');
            answerParts.push('| --- | ---: | ---: | ---: |');
            for (const r of rows) {
                answerParts.push(
                    `| ${r.description.replace(/\|/g, '/')} | ${r.quantity} | ${currency} ${Math.round(r.unitPrice * 100) / 100} | ${currency} ${Math.round(r.total * 100) / 100} |`
                );
            }
            const sub =
                parseNumber(data.subtotal) ??
                rows.reduce((s, r) => s + r.total, 0);
            answerParts.push('');
            answerParts.push(
                `Lines sum: **${currency} ${Math.round(Number(sub) * 100) / 100}**`
            );
            if (printedTotal != null) {
                answerParts.push(
                    `Invoice total (printed): **${currency} ${Math.round(printedTotal * 100) / 100}**`
                );
            }
            if (mismatch) {
                answerParts.push(
                    `_Note: line-item qty/rate may still be wrong in storage — printed invoice total is preferred. Open the document → **Reclassify with AI** after restarting ai-backend to re-extract._`
                );
            }
            answerParts.push('');
        } else {
            answerParts.push(`- **${doc.originalFilename}** — no \`line_items\` in extraction yet (reprocess as invoice).`);
        }
    }

    const records = await loadFinanceRecords(user, loadOpts);
    const fileReport = await buildFinanceFileCoverage(user, records, loadOpts);
    const coverage = computeFinanceCoverage(records, docsInScope, fileReport);

    if (!visuals.length) {
        answerParts.push('');
        answerParts.push(
            'No line-item arrays found. Open each document → reprocess with **Finance Agent** / invoice type so `line_items` are extracted.'
        );
    } else {
        answerParts.push('Charts in the analytics panel show **quantity** and **line total** per item.');
    }

    return {
        visuals,
        citations,
        documentCount: new Set(visuals.map((v) => v.id.split('_')[2])).size || docs.length,
        coverage,
        answer: answerParts.join('\n'),
    };
}

export async function countFinanceDocumentsInScope(
    user: AuthUser,
    documentIds?: string[]
): Promise<number> {
    const filter = await buildDocumentFilter(user, {});
    const query = buildFinanceScopeQuery(filter, documentIds);
    return Document.countDocuments(query);
}

/** All ready finance-classified document IDs the user can access (library-wide cap). */
export async function listFinanceDocumentIdsForUser(
    user: AuthUser,
    maxDocs = 200
): Promise<string[]> {
    const filter = await buildDocumentFilter(user, {});
    const query = buildFinanceScopeQuery(filter, undefined);
    const docs = await Document.find(query)
        .select('documentId')
        .sort({ createdAt: -1 })
        .limit(maxDocs)
        .lean();
    return docs.map((d) => d.documentId).filter(Boolean);
}

/**
 * Portfolio finance asks use every finance-ready doc the user can access,
 * merged with explicit chat selection (deduped).
 */
export async function resolveFinancePortfolioDocumentIds(
    user: AuthUser,
    chatScopedIds?: string[],
    maxDocs = 200
): Promise<string[]> {
    const library = await listFinanceDocumentIdsForUser(user, maxDocs);
    const selected = (chatScopedIds || []).filter(Boolean);
    if (!selected.length) return library;
    const set = new Set([...selected, ...library]);
    return [...set].slice(0, maxDocs);
}
