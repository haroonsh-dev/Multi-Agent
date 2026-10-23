import Document from '../models/Document';
import { AuthUser, buildDocumentFilter } from './accessScope';
import {
    getDocumentExtractions,
    resolveDocumentAiOrgId,
} from './aiServiceClient';
import type { ChatVisualSpec } from '../types/chatVisuals';
import { scalarField } from './financeAnalyticsService';
import { filterDocsByAgent } from './documentStorage';

export const LEGAL_AGENT = 'legal_agent';

export const LEGAL_DOC_TYPES = new Set([
    'contract',
    'agreement',
    'nda',
    'service_agreement',
    'lease_agreement',
    'vendor_contract',
]);

export type LoadLegalOptions = {
    maxDocs?: number;
    documentIds?: string[];
    expiryWarningDays?: number;
};

export type LegalDocSnapshot = {
    documentId: string;
    filename: string;
    classification: string;
    counterparties: string[];
    effectiveDate: Date | null;
    expiryDate: Date | null;
    contractStatus: 'ACTIVE' | 'EXPIRING_SOON' | 'EXPIRED' | 'UNKNOWN';
    daysUntilExpiry: number | null;
    governingLaw: string;
    liabilityCap: string;
    terminationNoticeDays: number | null;
    indemnification: string;
    riskLevel: 'LOW' | 'MEDIUM' | 'HIGH' | 'UNKNOWN';
    keyRisks: string[];
    missingFields: string[];
};

function parseAmount(raw: unknown): number | null {
    if (raw == null || raw === '') return null;
    if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
    const s = String(raw).replace(/[^0-9.-]/g, '');
    if (!s) return null;
    const n = Number(s);
    return Number.isFinite(n) ? n : null;
}

function computeMissingFields(
    extData: Record<string, unknown>,
    snapshot: Omit<LegalDocSnapshot, 'missingFields'>
): string[] {
    const gaps: string[] = [];
    if (!snapshot.expiryDate) gaps.push('Expiry date');
    if (!snapshot.effectiveDate) gaps.push('Effective date');
    if (!snapshot.counterparties.length) gaps.push('Counterparties');
    if (snapshot.governingLaw === 'Not Specified') gaps.push('Governing law');
    if (snapshot.liabilityCap === 'Not Specified') gaps.push('Liability cap');

    const contractValue =
        parseAmount(extData.contract_value) ??
        parseAmount(extData.total_amount) ??
        parseAmount(extData.amount) ??
        parseAmount(extData.grand_total);
    if (contractValue == null || contractValue <= 0) gaps.push('Contract value');

    const clauses = Array.isArray(extData.clauses)
        ? extData.clauses
        : Array.isArray(extData.key_clauses)
          ? extData.key_clauses
          : [];
    if (!clauses.length) gaps.push('Key clauses');

    const risks = Array.isArray(extData.risks)
        ? extData.risks
        : Array.isArray(extData.risk_flags)
          ? extData.risk_flags
          : Array.isArray(extData.identified_risks)
            ? extData.identified_risks
            : [];
    if (!risks.length) gaps.push('Risk flags');

    return gaps;
}

export type LegalAnalyticsResult = {
    snapshots: LegalDocSnapshot[];
    totalContracts: number;
    activeCount: number;
    expiringSoonCount: number;
    expiredCount: number;
    highRiskCount: number;
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

export async function loadLegalSnapshots(
    user: AuthUser,
    options: LoadLegalOptions = {}
): Promise<LegalDocSnapshot[]> {
    const maxDocs = options.maxDocs || 100;
    const expiryWarningDays = options.expiryWarningDays || 60;

    const queryFilter: Record<string, unknown> = {
        status: 'ready',
        $or: [
            { 'metadata.phase3Agent': LEGAL_AGENT },
            { classification: { $in: Array.from(LEGAL_DOC_TYPES) } },
        ],
    };
    if (options.documentIds?.length) {
        queryFilter.documentId = { $in: options.documentIds };
    }

    const filter = await buildDocumentFilter(user, queryFilter);
    const raw = await Document.find(filter).sort({ createdAt: -1 }).limit(maxDocs).lean();
    const docs = filterDocsByAgent(raw, LEGAL_AGENT);
    if (!docs.length) return [];

    const now = new Date();
    const snapshots: LegalDocSnapshot[] = [];

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

        const rawExp = extData.expiry_date || extData.expiration_date || extData.end_date || docMeta.expirationDate;
        const expiryDate = parseDate(rawExp);

        const rawEff = extData.effective_date || extData.start_date || extData.contract_date || docMeta.effectiveDate;
        const effectiveDate = parseDate(rawEff);

        let daysUntilExpiry: number | null = null;
        let contractStatus: LegalDocSnapshot['contractStatus'] = 'UNKNOWN';

        if (expiryDate) {
            const diffMs = expiryDate.getTime() - now.getTime();
            daysUntilExpiry = Math.ceil(diffMs / (1000 * 60 * 60 * 24));
            if (daysUntilExpiry < 0) {
                contractStatus = 'EXPIRED';
            } else if (daysUntilExpiry <= expiryWarningDays) {
                contractStatus = 'EXPIRING_SOON';
            } else {
                contractStatus = 'ACTIVE';
            }
        } else {
            contractStatus = 'UNKNOWN';
        }

        // Counterparties
        const rawParties = extData.counterparties || extData.parties || extData.contracting_parties || docMeta.counterparties;
        let counterparties: string[] = [];
        if (Array.isArray(rawParties)) {
            counterparties = rawParties.map(String).filter(Boolean);
        } else if (typeof rawParties === 'string' && rawParties.trim()) {
            counterparties = rawParties.split(/[,;&]/).map((s) => s.trim()).filter(Boolean);
        }

        const governingLaw = scalarField(extData.governing_law || extData.jurisdiction || docMeta.governingLaw) || 'Not Specified';
        const liabilityCap = scalarField(extData.liability_cap || extData.limitation_of_liability || docMeta.liabilityCap) || 'Not Specified';
        const indemnification = scalarField(extData.indemnification || extData.indemnity || docMeta.indemnification) || 'Standard';

        const rawNoticeDays = scalarField(extData.termination_notice_days || extData.notice_period || docMeta.noticePeriod);
        const terminationNoticeDays = rawNoticeDays ? parseInt(rawNoticeDays, 10) || null : null;

        // Determine Risk Level
        const keyRisks: string[] = [];
        let riskLevel: LegalDocSnapshot['riskLevel'] = 'LOW';

        const liabLower = liabilityCap.toLowerCase();
        if (liabLower.includes('unlimited') || liabLower.includes('none') || liabLower.includes('no limit')) {
            riskLevel = 'HIGH';
            keyRisks.push('Unlimited Liability Clause');
        }

        if (contractStatus === 'EXPIRED') {
            riskLevel = 'HIGH';
            keyRisks.push('Contract Expired');
        } else if (contractStatus === 'EXPIRING_SOON') {
            if (riskLevel !== 'HIGH') riskLevel = 'MEDIUM';
            keyRisks.push(`Expiring in ${daysUntilExpiry} days`);
        }

        if (terminationNoticeDays && terminationNoticeDays < 15) {
            if (riskLevel !== 'HIGH') riskLevel = 'MEDIUM';
            keyRisks.push(`Short termination notice (${terminationNoticeDays} days)`);
        }

        if (!keyRisks.length && contractStatus !== 'UNKNOWN') {
            keyRisks.push('No elevated risk flags extracted');
        }

        const core: Omit<LegalDocSnapshot, 'missingFields'> = {
            documentId: doc.documentId,
            filename: doc.originalFilename || 'Untitled Contract',
            classification: doc.classification || 'contract',
            counterparties,
            effectiveDate,
            expiryDate,
            contractStatus,
            daysUntilExpiry,
            governingLaw,
            liabilityCap,
            terminationNoticeDays,
            indemnification,
            riskLevel,
            keyRisks,
        };

        snapshots.push({
            ...core,
            missingFields: computeMissingFields(extData, core),
        });
    }

    return snapshots;
}

export async function executeLegalAnalytics(
    user: AuthUser,
    options: LoadLegalOptions = {}
): Promise<LegalAnalyticsResult> {
    const snapshots = await loadLegalSnapshots(user, options);

    const totalContracts = snapshots.length;
    const activeCount = snapshots.filter((s) => s.contractStatus === 'ACTIVE').length;
    const expiringSoonCount = snapshots.filter((s) => s.contractStatus === 'EXPIRING_SOON').length;
    const expiredCount = snapshots.filter((s) => s.contractStatus === 'EXPIRED').length;
    const highRiskCount = snapshots.filter((s) => s.riskLevel === 'HIGH').length;

    const citations = snapshots.map((s) => ({
        documentId: s.documentId,
        filename: s.filename,
        documentType: s.classification,
        phase3Agent: LEGAL_AGENT,
    }));

    const statusCounts = new Map<string, number>();
    const riskCounts = new Map<string, number>();
    for (const s of snapshots) {
        statusCounts.set(s.contractStatus, (statusCounts.get(s.contractStatus) || 0) + 1);
        riskCounts.set(s.riskLevel, (riskCounts.get(s.riskLevel) || 0) + 1);
    }

    const visuals: ChatVisualSpec[] = [
        {
            id: 'legal_status_mix',
            agentId: LEGAL_AGENT,
            kind: 'pie',
            title: 'Contract status mix',
            categoryKey: 'status',
            series: [{ key: 'count', label: 'Contracts' }],
            data: [...statusCounts.entries()].map(([status, count]) => ({
                status: status.replace(/_/g, ' '),
                count,
            })),
            emptyState: 'No contract status could be derived from expiry dates.',
            sourceDocumentIds: snapshots.map((s) => s.documentId),
        },
        {
            id: 'legal_risk_mix',
            agentId: LEGAL_AGENT,
            kind: 'bar',
            title: 'Risk level by contract',
            categoryKey: 'risk',
            series: [{ key: 'count', label: 'Contracts', color: '#dc2626' }],
            data: [...riskCounts.entries()].map(([risk, count]) => ({
                risk,
                count,
            })),
            emptyState: 'No risk signals extracted yet.',
            sourceDocumentIds: snapshots.map((s) => s.documentId),
        },
        {
            id: 'legal_risk_register_table',
            agentId: LEGAL_AGENT,
            kind: 'table',
            title: 'Contract risk & expiry register',
            categoryKey: 'filename',
            series: [
                { key: 'filename', label: 'Contract' },
                { key: 'classification', label: 'Type' },
                { key: 'status', label: 'Status' },
                { key: 'riskLevel', label: 'Risk' },
                { key: 'risks', label: 'Notes' },
            ],
            data: snapshots.map((s) => ({
                filename: s.filename,
                classification: s.classification.replace(/_/g, ' '),
                status: s.contractStatus.replace(/_/g, ' '),
                riskLevel: s.riskLevel,
                risks: s.keyRisks.join('; ') || '—',
                _documentIds: s.documentId,
            })),
            emptyState: 'No legal contracts in scope.',
            sourceDocumentIds: snapshots.map((s) => s.documentId),
        },
    ];

    return {
        snapshots,
        totalContracts,
        activeCount,
        expiringSoonCount,
        expiredCount,
        highRiskCount,
        visuals,
        citations,
    };
}

export type LegalMissingDataResult = {
    snapshots: LegalDocSnapshot[];
    visuals: ChatVisualSpec[];
    citations: LegalAnalyticsResult['citations'];
    answer: string;
    coverage: {
        documentsInScope: number;
        documentsCharted: number;
        documentsWithGaps: number;
        files: Array<{
            documentId: string;
            filename: string;
            status: 'complete' | 'gaps';
            detail?: string;
        }>;
    };
};

/** Chart + table for extraction gaps across scoped legal contracts. */
export async function executeLegalMissingDataAnalytics(
    user: AuthUser,
    options: LoadLegalOptions = {}
): Promise<LegalMissingDataResult> {
    const snapshots = await loadLegalSnapshots(user, options);
    const citations = snapshots.map((s) => ({
        documentId: s.documentId,
        filename: s.filename,
        documentType: s.classification,
        phase3Agent: LEGAL_AGENT,
    }));

    if (!snapshots.length) {
        return {
            snapshots: [],
            visuals: [],
            citations: [],
            answer:
                'No legal contracts in your current scope. Select agreement files in Document scope, then ask again for missing data.',
            coverage: {
                documentsInScope: 0,
                documentsCharted: 0,
                documentsWithGaps: 0,
                files: [],
            },
        };
    }

    const fieldCounts = new Map<string, number>();
    for (const s of snapshots) {
        for (const field of s.missingFields) {
            fieldCounts.set(field, (fieldCounts.get(field) || 0) + 1);
        }
    }

    const withGaps = snapshots.filter((s) => s.missingFields.length > 0);
    const barData = [...fieldCounts.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([field, count]) => ({ field, count }));

    const tableData = snapshots.map((s) => ({
        filename: s.filename,
        gapCount: s.missingFields.length,
        missing: s.missingFields.length ? s.missingFields.join('; ') : 'None — core fields present',
        _documentIds: s.documentId,
    }));

    const visuals: ChatVisualSpec[] = [
        {
            id: 'legal_missing_fields_bar',
            agentId: LEGAL_AGENT,
            kind: 'bar',
            title: 'Missing extraction fields',
            subtitle: `${withGaps.length} of ${snapshots.length} contract(s) with gaps`,
            categoryKey: 'field',
            series: [{ key: 'count', label: 'Contracts missing field', color: '#f59e0b' }],
            data: barData.length
                ? barData
                : [{ field: 'None', count: 0 }],
            emptyState: 'All scoped contracts have the tracked core fields extracted.',
            sourceDocumentIds: snapshots.map((s) => s.documentId),
            footer: 'Counts how many scoped files lack each field in AI extraction.',
        },
        {
            id: 'legal_missing_fields_table',
            agentId: LEGAL_AGENT,
            kind: 'table',
            title: 'Missing data by contract',
            categoryKey: 'filename',
            series: [
                { key: 'filename', label: 'Contract' },
                { key: 'gapCount', label: 'Gaps' },
                { key: 'missing', label: 'Missing fields' },
            ],
            data: tableData,
            sourceDocumentIds: snapshots.map((s) => s.documentId),
            footer: 'Reprocess a file from Documents if extraction finished but fields are still empty.',
        },
    ];

    const topGap = barData[0];
    let answer: string;
    if (!withGaps.length) {
        answer = `I checked **${snapshots.length}** scoped legal contract(s). Core extraction fields (dates, parties, value, clauses, risks) are present — no missing-data gaps in the tracked set.`;
    } else {
        const gapList = barData
            .slice(0, 4)
            .map(
                (row) =>
                    `**${row.field}** (${row.count} file${row.count === 1 ? '' : 's'})`
            )
            .join(', ');
        answer = [
            `I reviewed **${snapshots.length}** legal contract(s) in scope.`,
            `**${withGaps.length}** still have missing extraction fields.`,
            topGap ? `Most common gaps: ${gapList}.` : '',
            `Reprocess files in Documents if extraction should have finished.`,
        ]
            .filter(Boolean)
            .join(' ');
    }

    return {
        snapshots,
        visuals,
        citations,
        answer,
        coverage: {
            documentsInScope: snapshots.length,
            documentsCharted: snapshots.length,
            documentsWithGaps: withGaps.length,
            files: snapshots.map((s) => ({
                documentId: s.documentId,
                filename: s.filename,
                status: s.missingFields.length ? ('gaps' as const) : ('complete' as const),
                detail: s.missingFields.length ? s.missingFields.join(', ') : undefined,
            })),
        },
    };
}
