import Document from '../models/Document';
import { AuthUser, buildDocumentFilter } from './accessScope';
import {
    getDocumentExtractions,
    resolveDocumentAiOrgId,
} from './aiServiceClient';
import type { ChatVisualSpec } from '../types/chatVisuals';
import { scalarField } from './financeAnalyticsService';
import { filterDocsByAgent } from './documentStorage';

export const PROCUREMENT_AGENT = 'procurement_agent';

export const PROCUREMENT_DOC_TYPES = new Set([
    'purchase_order',
    'po',
    'quotation',
    'supplier_agreement',
    'vendor_list',
    'rfq',
    'delivery_note',
    'procurement_request',
]);

export type LoadProcurementOptions = {
    maxDocs?: number;
    documentIds?: string[];
};

export type ProcurementDocSnapshot = {
    documentId: string;
    filename: string;
    classification: string;
    poNumber: string;
    vendorName: string;
    totalAmount: number;
    currency: string;
    status: 'OPEN' | 'FULFILLED' | 'PENDING_DELIVERY' | 'DISCREPANCY' | 'UNKNOWN';
    lineItemsCount: number;
    deliveryDate: Date | null;
    paymentTerms: string;
    discrepancyFlag: string | null;
};

export type ProcurementAnalyticsResult = {
    snapshots: ProcurementDocSnapshot[];
    totalOrders: number;
    openCount: number;
    fulfilledCount: number;
    discrepancyCount: number;
    totalCommittedSpend: number;
    currency: string;
    visuals: ChatVisualSpec[];
    citations: Array<{
        documentId: string;
        filename: string;
        documentType: string;
        phase3Agent: string;
    }>;
};

function parseDate(raw: unknown): Date | null {
    const s = scalarField(raw);
    if (!s) return null;
    const d = new Date(s);
    return Number.isNaN(d.getTime()) ? null : d;
}

function parseNumber(raw: unknown): number {
    if (raw == null) return 0;
    if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
    const s = String(raw).replace(/,/g, '').replace(/[^\d.-]/g, '');
    const n = Number(s);
    return Number.isFinite(n) ? n : 0;
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

function pickExtractionData(extractions: Awaited<ReturnType<typeof getDocumentExtractions>>): Record<string, unknown> {
    if (!extractions?.length) return {};
    const sorted = [...extractions].sort((a, b) => {
        const ta = a.created_at ? new Date(a.created_at).getTime() : 0;
        const tb = b.created_at ? new Date(b.created_at).getTime() : 0;
        return tb - ta;
    });
    const merged: Record<string, unknown> = {};
    for (const ext of [...sorted].reverse()) {
        const chunk = (ext.extracted_data || {}) as Record<string, unknown>;
        const payload = normalizeExtractionPayload(chunk);
        for (const [k, v] of Object.entries(payload)) {
            if (v != null && v !== '') merged[k] = v;
        }
    }
    return merged;
}

export async function loadProcurementSnapshots(
    user: AuthUser,
    options: LoadProcurementOptions = {}
): Promise<ProcurementDocSnapshot[]> {
    const maxDocs = options.maxDocs || 100;

    const queryFilter: Record<string, unknown> = {
        status: 'ready',
        $or: [
            { 'metadata.phase3Agent': PROCUREMENT_AGENT },
            { classification: { $in: Array.from(PROCUREMENT_DOC_TYPES) } },
        ],
    };
    if (options.documentIds?.length) {
        queryFilter.documentId = { $in: options.documentIds };
    }

    const filter = await buildDocumentFilter(user, queryFilter);
    const raw = await Document.find(filter).sort({ createdAt: -1 }).limit(maxDocs).lean();
    const docs = filterDocsByAgent(raw, PROCUREMENT_AGENT);
    if (!docs.length) return [];

    const snapshots: ProcurementDocSnapshot[] = [];

    for (const doc of docs) {
        let extData: Record<string, unknown> = {};
        if (doc.pythonDocumentId) {
            try {
                const orgId = resolveDocumentAiOrgId(doc as any, user);
                const exts = await getDocumentExtractions(doc.pythonDocumentId, orgId);
                extData = pickExtractionData(exts);
            } catch {
                extData = {};
            }
        }

        const docMeta = (doc.metadata || {}) as Record<string, unknown>;

        const poNumber =
            scalarField(extData.po_number || extData.purchase_order_number || extData.rfq_number || docMeta.poNumber) ||
            'Not extracted';
        const vendorName =
            scalarField(extData.vendor_name || extData.supplier_name || extData.company_name || docMeta.vendorName) ||
            'Not extracted';
        const totalAmount = parseNumber(extData.total_amount || extData.grand_total || extData.total || docMeta.totalAmount);
        const currency = scalarField(extData.currency || docMeta.currency) || 'USD';

        const rawDeliveryDate = extData.delivery_date || extData.expected_delivery || extData.shipping_date || docMeta.deliveryDate;
        const deliveryDate = parseDate(rawDeliveryDate);

        const paymentTerms =
            scalarField(extData.payment_terms || extData.terms || docMeta.paymentTerms) || 'Not extracted';

        const rawItems = extData.line_items || extData.items || extData.products;
        const lineItemsCount = Array.isArray(rawItems) ? rawItems.length : 0;

        let status: ProcurementDocSnapshot['status'] = 'OPEN';
        let discrepancyFlag: string | null = null;

        const classification = doc.classification || 'purchase_order';

        if (classification === 'delivery_note') {
            status = 'FULFILLED';
        } else if (classification === 'quotation' || classification === 'rfq') {
            status = 'OPEN';
        } else if (!totalAmount) {
            status = 'UNKNOWN';
            discrepancyFlag = 'Amount not extracted — reprocess to chart spend';
        } else {
            status = 'PENDING_DELIVERY';
            if (totalAmount >= 50000) {
                discrepancyFlag = 'High value — review approval (not a match variance)';
            }
        }

        snapshots.push({
            documentId: doc.documentId,
            filename: doc.originalFilename || 'Untitled Procurement Document',
            classification,
            poNumber,
            vendorName,
            totalAmount,
            currency,
            status,
            lineItemsCount,
            deliveryDate,
            paymentTerms,
            discrepancyFlag,
        });
    }

    const deliveriesByPo = new Map<string, ProcurementDocSnapshot[]>();
    const posByNumber = new Map<string, ProcurementDocSnapshot[]>();
    for (const s of snapshots) {
        const key = s.poNumber.trim().toLowerCase();
        if (!key || key === 'not extracted') continue;
        if (s.classification === 'delivery_note') {
            const list = deliveriesByPo.get(key) || [];
            list.push(s);
            deliveriesByPo.set(key, list);
        } else if (s.classification === 'purchase_order' || s.classification === 'po') {
            const list = posByNumber.get(key) || [];
            list.push(s);
            posByNumber.set(key, list);
        }
    }
    for (const [poKey, pos] of posByNumber.entries()) {
        const deliveries = deliveriesByPo.get(poKey) || [];
        if (deliveries.length && pos.length) {
            for (const po of pos) {
                if (po.status === 'PENDING_DELIVERY') po.status = 'FULFILLED';
            }
        }
        if (pos.length >= 2) {
            const amounts = pos.map((p) => p.totalAmount).filter((n) => n > 0);
            if (amounts.length >= 2) {
                const min = Math.min(...amounts);
                const max = Math.max(...amounts);
                if (min > 0 && (max - min) / min > 0.05) {
                    for (const po of pos) {
                        po.status = 'DISCREPANCY';
                        po.discrepancyFlag = `PO amount variance in scope (${min.toLocaleString()} vs ${max.toLocaleString()})`;
                    }
                }
            }
        }
    }

    return snapshots;
}

export async function executeProcurementAnalytics(
    user: AuthUser,
    options: LoadProcurementOptions = {}
): Promise<ProcurementAnalyticsResult> {
    const snapshots = await loadProcurementSnapshots(user, options);

    const totalOrders = snapshots.length;
    const openCount = snapshots.filter((s) => s.status === 'OPEN' || s.status === 'PENDING_DELIVERY').length;
    const fulfilledCount = snapshots.filter((s) => s.status === 'FULFILLED').length;
    const discrepancyCount = snapshots.filter((s) => s.status === 'DISCREPANCY').length;

    let currency = 'USD';
    let totalCommittedSpend = 0;
    for (const s of snapshots) {
        if (s.currency) currency = s.currency;
        totalCommittedSpend += s.totalAmount;
    }

    const citations = snapshots.map((s) => ({
        documentId: s.documentId,
        filename: s.filename,
        documentType: s.classification,
        phase3Agent: PROCUREMENT_AGENT,
    }));

    const spendByVendor = new Map<string, { amount: number; docs: Set<string> }>();
    for (const s of snapshots) {
        if (!s.totalAmount || s.vendorName === 'Not extracted') continue;
        const g = spendByVendor.get(s.vendorName) || { amount: 0, docs: new Set<string>() };
        g.amount += s.totalAmount;
        g.docs.add(s.documentId);
        spendByVendor.set(s.vendorName, g);
    }

    const visuals: ChatVisualSpec[] = [
        {
            id: 'procurement_spend_by_supplier',
            agentId: PROCUREMENT_AGENT,
            kind: 'bar',
            title: 'Committed spend by supplier',
            currency,
            categoryKey: 'vendor',
            series: [{ key: 'amount', label: `Amount (${currency})`, color: '#0d9488' }],
            data: [...spendByVendor.entries()]
                .sort((a, b) => b[1].amount - a[1].amount)
                .slice(0, 12)
                .map(([vendor, v]) => ({
                    vendor,
                    amount: v.amount,
                    _documentIds: [...v.docs].join(','),
                })),
            emptyState: 'No supplier amounts extracted from scoped POs or quotes.',
            sourceDocumentIds: snapshots.map((s) => s.documentId),
        },
        {
            id: 'procurement_kpi_grid',
            agentId: PROCUREMENT_AGENT,
            kind: 'table',
            title: 'Procurement order register',
            categoryKey: 'poNumber',
            series: [
                { key: 'poNumber', label: 'PO / ref' },
                { key: 'filename', label: 'Document' },
                { key: 'vendorName', label: 'Supplier' },
                { key: 'status', label: 'Status' },
                { key: 'totalAmount', label: 'Amount' },
            ],
            data: snapshots.map((s) => ({
                poNumber: s.poNumber,
                filename: s.filename,
                vendorName: s.vendorName,
                status: s.status.replace(/_/g, ' '),
                totalAmount: s.totalAmount ? `${s.currency} ${s.totalAmount.toLocaleString()}` : 'Not extracted',
                _documentIds: s.documentId,
            })),
            emptyState: 'No procurement documents in scope.',
            sourceDocumentIds: snapshots.map((s) => s.documentId),
        },
    ];

    return {
        snapshots,
        totalOrders,
        openCount,
        fulfilledCount,
        discrepancyCount,
        totalCommittedSpend,
        currency,
        visuals,
        citations,
    };
}
