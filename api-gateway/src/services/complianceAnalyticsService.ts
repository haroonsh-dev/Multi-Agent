import Document from '../models/Document';
import { AuthUser, buildDocumentFilter } from './accessScope';
import {
    getDocumentExtractions,
    getAiDocument,
    resolveDocumentAiOrgId,
} from './aiServiceClient';
import type { ChatVisualSpec } from '../types/chatVisuals';
import { scalarField } from './financeAnalyticsService';
import {
    defaultComplianceSettings,
    getOrgComplianceSettings,
} from './orgComplianceSettingsService';
import { filterDocsByAgent } from './documentStorage';

export const COMPLIANCE_AGENT = 'compliance_agent';

export const COMPLIANCE_DOC_TYPES = new Set([
    'sop',
    'audit_report',
    'quality_report',
    'certificate',
    'maintenance_report',
    'engineering_drawing',
    'inspection_report',
    'safety_manual',
    'iso_document',
    'compliance_form',
    'regulatory_document',
]);

export type LoadComplianceOptions = {
    maxDocs?: number;
    documentIds?: string[];
    /** Override org expiry warning window (days). */
    expiryWarningDays?: number;
};

export type ComplianceDocSnapshot = {
    documentId: string;
    filename: string;
    classification: string;
    certificateNumber?: string;
    standardOrRegulation?: string;
    expiryDate: Date | null;
    certStatus: 'VALID' | 'EXPIRING_SOON' | 'EXPIRED' | 'UNKNOWN';
    daysUntilExpiry: number | null;
    overallStatus: string;
    /** Normalized: compliant | non_compliant | partially_compliant | not_assessed | '' */
    normalizedStatus: string;
    findings: Array<{ severity: string; description: string }>;
    issuedTo?: string;
    issuingAuthority?: string;
};

export type ComplianceAnalyticsCoverage = {
    documentsInScope: number;
    documentsWithExpiry: number;
    documentsWithFindings: number;
    files?: Array<{
        documentId: string;
        filename: string;
        status: 'in_charts' | 'no_extraction' | 'not_linked';
        detail?: string;
    }>;
};

export type MissingDocAnalysis = {
    required: string[];
    present: string[];
    missing: string[];
    presentByType: Record<string, number>;
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
        if (String(ext.extraction_type || '') === 'table_extraction') continue;
        const chunk = (ext.extracted_data || {}) as Record<string, unknown>;
        Object.assign(merged, chunk);
    }
    return normalizeExtractionPayload(merged);
}

async function extractionPayloadForDoc(
    doc: { pythonDocumentId?: string | null; organizationId?: string | null; metadata?: unknown },
    user: AuthUser
): Promise<Record<string, unknown>> {
    if (!doc.pythonDocumentId) return {};
    const orgId = resolveDocumentAiOrgId(doc as { organizationId?: string | null }, user);
    let extractions = await getDocumentExtractions(doc.pythonDocumentId, orgId);
    if (!extractions?.length && orgId) {
        extractions = await getDocumentExtractions(doc.pythonDocumentId, '');
    }
    let data = pickExtractionData(extractions);
    if (!Object.keys(data).length) {
        const aiDoc = await getAiDocument(doc.pythonDocumentId, orgId);
        const meta = aiDoc?.extracted_data;
        if (meta && typeof meta === 'object') {
            data = normalizeExtractionPayload({ ...data, ...(meta as Record<string, unknown>) });
        }
    }
    return data;
}

function daysBetween(from: Date, to: Date): number {
    const ms = to.getTime() - from.getTime();
    return Math.floor(ms / (24 * 60 * 60 * 1000));
}

export function deriveCertStatus(
    expiryDate: Date | null,
    explicitStatus?: string,
    daysUntilFromExtraction?: number | null,
    expiryWarningDays = 90
): { status: ComplianceDocSnapshot['certStatus']; daysUntilExpiry: number | null } {
    const warning = Number.isFinite(expiryWarningDays) ? Math.max(7, Math.min(365, expiryWarningDays)) : 90;
    const normalized = (explicitStatus || '').toUpperCase().replace(/\s+/g, '_');
    if (normalized === 'VALID' || normalized === 'EXPIRING_SOON' || normalized === 'EXPIRED') {
        return {
            status: normalized as ComplianceDocSnapshot['certStatus'],
            daysUntilExpiry:
                daysUntilFromExtraction != null && Number.isFinite(daysUntilFromExtraction)
                    ? daysUntilFromExtraction
                    : expiryDate
                      ? daysBetween(new Date(), expiryDate)
                      : null,
        };
    }

    if (expiryDate) {
        const days = daysBetween(new Date(), expiryDate);
        if (days < 0) return { status: 'EXPIRED', daysUntilExpiry: days };
        if (days <= warning) return { status: 'EXPIRING_SOON', daysUntilExpiry: days };
        return { status: 'VALID', daysUntilExpiry: days };
    }

    if (daysUntilFromExtraction != null && Number.isFinite(daysUntilFromExtraction)) {
        const days = daysUntilFromExtraction;
        if (days < 0) return { status: 'EXPIRED', daysUntilExpiry: days };
        if (days <= warning) return { status: 'EXPIRING_SOON', daysUntilExpiry: days };
        return { status: 'VALID', daysUntilExpiry: days };
    }

    return { status: 'UNKNOWN', daysUntilExpiry: null };
}

function normalizeSeverity(raw: string, aliases?: Record<string, string>): string {
    const trimmed = raw.trim();
    if (!trimmed) return 'UNSPECIFIED';
    const aliasHit = aliases?.[trimmed.toLowerCase()];
    const s = (aliasHit || trimmed).toUpperCase().replace(/\s+/g, '_');
    if (/CRITICAL|SEVERE|HIGH|FAIL|FAILED|NON[-_]?COMPLIANT/.test(s)) return 'CRITICAL';
    if (/MAJOR/.test(s)) return 'MAJOR';
    if (/MINOR|LOW|WARNING/.test(s)) return 'MINOR';
    if (/OBSERVATION|INFO|NOTE|PASS/.test(s)) return 'OBSERVATION';
    return s.length > 24 ? `${s.slice(0, 22)}…` : s;
}

/** Map free-text overall status into a stable vocabulary for charts. */
export function normalizeOverallStatus(raw: string): string {
    const s = raw.trim().toLowerCase();
    if (!s) return '';
    if (
        /fully\s*compliant|compliant|pass|passed|satisfactory|approved|valid|in\s*compliance/.test(s) &&
        !/non|partial|conditional|needs/.test(s)
    ) {
        return 'compliant';
    }
    if (/non[- ]?compliant|fail|failed|rejected|not\s*compliant|open\s*ncr/.test(s)) {
        return 'non_compliant';
    }
    if (/partial|conditional|needs\s*improvement|under\s*review|observation/.test(s)) {
        return 'partially_compliant';
    }
    if (/not\s*assessed|n\/a|unknown|pending/.test(s)) return 'not_assessed';
    return s.replace(/\s+/g, '_').slice(0, 40);
}

export function extractComplianceFindings(
    data: Record<string, unknown>,
    severityAliases?: Record<string, string>
): Array<{ severity: string; description: string }> {
    const out: Array<{ severity: string; description: string }> = [];
    const push = (severity: string, description: string) => {
        const desc = description.trim();
        if (!desc) return;
        out.push({ severity: normalizeSeverity(severity, severityAliases), description: desc });
    };

    const structured = data.audit_findings;
    if (Array.isArray(structured)) {
        for (const row of structured) {
            if (!row || typeof row !== 'object') continue;
            const r = row as Record<string, unknown>;
            const desc =
                scalarField(r.description) ||
                scalarField(r.finding) ||
                scalarField(r.summary) ||
                scalarField(r.corrective_action_required) ||
                'Finding';
            push(scalarField(r.severity) || 'UNSPECIFIED', desc);
        }
    }

    const legacy = data.findings;
    if (Array.isArray(legacy)) {
        for (const item of legacy) {
            if (typeof item === 'string' && item.trim()) {
                push('UNSPECIFIED', item.trim());
            } else if (item && typeof item === 'object') {
                const r = item as Record<string, unknown>;
                push(
                    scalarField(r.severity) || 'UNSPECIFIED',
                    scalarField(r.description) || scalarField(r.text) || scalarField(r.finding) || 'Finding'
                );
            }
        }
    }

    const inspected = data.inspected_items;
    if (Array.isArray(inspected)) {
        for (const row of inspected) {
            if (!row || typeof row !== 'object') continue;
            const r = row as Record<string, unknown>;
            const status = (scalarField(r.status) || '').toUpperCase();
            if (!/FAIL|FAILED|NON|NC|OPEN/.test(status)) continue;
            const area = scalarField(r.area_item) || scalarField(r.item) || 'Inspection item';
            const remarks = scalarField(r.remarks) || scalarField(r.comment) || status;
            push('CRITICAL', `${area}: ${remarks}`);
        }
    }

    const params = data.test_parameters;
    if (Array.isArray(params)) {
        for (const row of params) {
            if (!row || typeof row !== 'object') continue;
            const r = row as Record<string, unknown>;
            const status = (scalarField(r.status) || '').toUpperCase();
            if (!/FAIL|FAILED|OUT|NON/.test(status)) continue;
            const name = scalarField(r.parameter) || scalarField(r.name) || 'Test parameter';
            push('MAJOR', `${name}: ${scalarField(r.result) || status}`);
        }
    }

    const conditions = data.mandatory_conditions;
    if (Array.isArray(conditions) && !out.length) {
        for (const c of conditions.slice(0, 8)) {
            if (typeof c === 'string' && c.trim()) push('OBSERVATION', c.trim());
        }
    }

    const gaps = data.gaps_identified;
    if (Array.isArray(gaps)) {
        for (const g of gaps) {
            if (typeof g === 'string' && g.trim()) push('MAJOR', g.trim());
        }
    }

    return out;
}

function pickExpiryDate(data: Record<string, unknown>): Date | null {
    return (
        parseDate(data.expiry_date) ||
        parseDate(data.expiration_date) ||
        parseDate(data.valid_until) ||
        parseDate(data.valid_to) ||
        parseDate(data.expiry) ||
        null
    );
}

function pickCertificateNumber(data: Record<string, unknown>): string {
    return (
        scalarField(data.certificate_number) ||
        scalarField(data.document_number) ||
        scalarField(data.report_number) ||
        scalarField(data.license_permit_number) ||
        scalarField(data.inspection_report_id) ||
        scalarField(data.form_id) ||
        scalarField(data.audit_id) ||
        ''
    );
}

function pickStandard(
    data: Record<string, unknown>,
    standardAliases?: Record<string, string>
): string {
    const raw =
        scalarField(data.standard_or_regulation) ||
        scalarField(data.certification_standard) ||
        scalarField(data.standard) ||
        scalarField(data.regulation) ||
        scalarField(data.iso_standard) ||
        scalarField(data.audit_standard) ||
        scalarField(data.certificate_type) ||
        '';
    if (!raw) return '';
    const alias = standardAliases?.[raw.toLowerCase()];
    return alias || raw;
}

function pickOverallStatusRaw(data: Record<string, unknown>): string {
    return (
        scalarField(data.overall_compliance_status) ||
        scalarField(data.compliance_status) ||
        scalarField(data.overall_rating) ||
        scalarField(data.inspection_result) ||
        scalarField(data.result) ||
        scalarField(data.status) ||
        ''
    );
}

/** Pure parser for golden tests / reuse. */
export function parseComplianceExtraction(
    dataIn: Record<string, unknown>,
    meta: {
        documentId: string;
        filename: string;
        classification: string;
        expiryWarningDays?: number;
        severityAliases?: Record<string, string>;
        standardAliases?: Record<string, string>;
    }
): ComplianceDocSnapshot {
    const data = normalizeExtractionPayload(dataIn);
    const expiryDate = pickExpiryDate(data);
    const daysRaw = data.days_until_expiry;
    const daysNum =
        typeof daysRaw === 'number' && Number.isFinite(daysRaw)
            ? daysRaw
            : parseInt(String(daysRaw ?? ''), 10);
    const { status, daysUntilExpiry } = deriveCertStatus(
        expiryDate,
        scalarField(data.status) || scalarField(data.certificate_status),
        Number.isFinite(daysNum) ? daysNum : null,
        meta.expiryWarningDays ?? 90
    );
    const overallStatus = pickOverallStatusRaw(data);
    return {
        documentId: meta.documentId,
        filename: meta.filename,
        classification: meta.classification,
        certificateNumber: pickCertificateNumber(data) || undefined,
        standardOrRegulation: pickStandard(data, meta.standardAliases) || undefined,
        expiryDate,
        certStatus: status,
        daysUntilExpiry,
        overallStatus,
        normalizedStatus: normalizeOverallStatus(overallStatus),
        findings: extractComplianceFindings(data, meta.severityAliases),
        issuedTo:
            scalarField(data.issued_to) ||
            scalarField(data.entity_name) ||
            scalarField(data.submitting_entity) ||
            undefined,
        issuingAuthority:
            scalarField(data.issuing_authority) ||
            scalarField(data.regulatory_agency) ||
            undefined,
    };
}

function buildComplianceScopeQuery(filter: Record<string, unknown>, documentIds?: string[]): Record<string, unknown> {
    const query: Record<string, unknown> = {
        ...filter,
        status: 'ready',
        pythonDocumentId: { $exists: true, $nin: [null, ''] },
        $or: [
            { classification: { $in: [...COMPLIANCE_DOC_TYPES] } },
            { 'metadata.phase3Agent': COMPLIANCE_AGENT },
        ],
    };
    if (documentIds?.length) {
        query.documentId = { $in: documentIds };
    }
    return query;
}

export async function loadComplianceDocsForAnalytics(
    user: AuthUser,
    options: LoadComplianceOptions = {}
) {
    const maxDocs = options.maxDocs ?? 80;
    const filter = await buildDocumentFilter(user, {});
    const query = buildComplianceScopeQuery(filter, options.documentIds);
    const docs = await Document.find(query)
        .select('documentId originalFilename classification pythonDocumentId organizationId metadata')
        .sort({ createdAt: -1 })
        .limit(maxDocs)
        .lean();
    return filterDocsByAgent(docs, COMPLIANCE_AGENT);
}

export async function loadComplianceSnapshots(
    user: AuthUser,
    options: LoadComplianceOptions = {}
): Promise<ComplianceDocSnapshot[]> {
    const docs = await loadComplianceDocsForAnalytics(user, options);
    const orgSettings = await getOrgComplianceSettings(user.organizationId);
    const expiryWarningDays =
        options.expiryWarningDays ??
        orgSettings.expiryWarningDays ??
        defaultComplianceSettings().expiryWarningDays!;
    const snapshots: ComplianceDocSnapshot[] = [];

    for (const doc of docs) {
        const data = await extractionPayloadForDoc(doc, user);
        snapshots.push(
            parseComplianceExtraction(data, {
                documentId: doc.documentId,
                filename: doc.originalFilename,
                classification: String(doc.classification || 'other'),
                expiryWarningDays,
                severityAliases: orgSettings.severityAliases,
                standardAliases: orgSettings.standardAliases,
            })
        );
    }

    return snapshots;
}

export function filterAttentionSnapshots(
    snapshots: ComplianceDocSnapshot[],
    opts?: { withinDays?: number }
): ComplianceDocSnapshot[] {
    const within = opts?.withinDays;
    return snapshots.filter((s) => {
        if (s.certStatus === 'EXPIRED' || s.certStatus === 'EXPIRING_SOON') return true;
        if (within != null && s.daysUntilExpiry != null && s.daysUntilExpiry <= within) return true;
        return false;
    });
}

export function analyzeMissingComplianceDocs(
    snapshots: ComplianceDocSnapshot[],
    requiredDocTypes?: string[]
): MissingDocAnalysis {
    const required = (requiredDocTypes?.length
        ? requiredDocTypes
        : defaultComplianceSettings().requiredDocTypes!) as string[];
    const presentByType: Record<string, number> = {};
    for (const s of snapshots) {
        const t = String(s.classification || '').toLowerCase();
        if (!t || t === 'compliance_report') continue;
        presentByType[t] = (presentByType[t] || 0) + 1;
    }
    const present = required.filter((t) => (presentByType[t] || 0) > 0);
    const missing = required.filter((t) => !present.includes(t));
    return { required, present, missing, presentByType };
}

function truncateLabel(text: string, max = 28): string {
    const t = text.trim();
    if (t.length <= max) return t;
    return `${t.slice(0, max - 1)}…`;
}

function docIdsField(ids: Set<string>): string {
    return [...ids].join(',');
}

export function buildCertStatusVisual(snapshots: ComplianceDocSnapshot[]): ChatVisualSpec {
    const counts = new Map<string, { count: number; docs: Set<string> }>();
    for (const s of snapshots) {
        if (s.expiryDate == null && s.certStatus === 'UNKNOWN') continue;
        const key = s.certStatus;
        const bucket = counts.get(key) || { count: 0, docs: new Set<string>() };
        bucket.count += 1;
        bucket.docs.add(s.documentId);
        counts.set(key, bucket);
    }

    const order = ['VALID', 'EXPIRING_SOON', 'EXPIRED', 'UNKNOWN'];
    const rows = order
        .filter((k) => counts.has(k))
        .map((k) => {
            const b = counts.get(k)!;
            return {
                status: k.replace(/_/g, ' '),
                count: b.count,
                _documentIds: docIdsField(b.docs),
            };
        });

    return {
        id: `comp_cert_status_${Date.now()}`,
        agentId: COMPLIANCE_AGENT,
        kind: 'pie',
        title: 'Certificate validity',
        subtitle: 'From expiry dates & status fields',
        categoryKey: 'status',
        series: [{ key: 'count', label: 'Documents' }],
        data: rows,
        emptyState: rows.length ? undefined : 'No certificate expiry or validity fields extracted.',
        footer: 'VALID · EXPIRING_SOON · EXPIRED from extraction (org warning window applies).',
    };
}

export function buildExpiryTimelineVisual(snapshots: ComplianceDocSnapshot[]): ChatVisualSpec {
    const withExpiry = snapshots
        .filter((s) => s.daysUntilExpiry != null)
        .sort((a, b) => (a.daysUntilExpiry ?? 0) - (b.daysUntilExpiry ?? 0))
        .slice(0, 12);

    return {
        id: `comp_expiry_${Date.now()}`,
        agentId: COMPLIANCE_AGENT,
        kind: 'bar',
        title: 'Days until certificate expiry',
        subtitle: 'Negative = already expired',
        categoryKey: 'certificate',
        series: [{ key: 'days', label: 'Days until expiry', color: '#e11d48' }],
        data: withExpiry.map((s) => ({
            certificate: truncateLabel(s.filename),
            days: s.daysUntilExpiry as number,
            _documentIds: s.documentId,
        })),
        emptyState: withExpiry.length ? undefined : 'No expiry dates extracted from scoped certificates.',
        footer: 'Sorted by soonest expiry. Based on extracted expiry / expiration dates.',
    };
}

export function buildFindingsSeverityVisual(snapshots: ComplianceDocSnapshot[]): ChatVisualSpec {
    const buckets = new Map<string, { count: number; docs: Set<string> }>();
    for (const s of snapshots) {
        for (const f of s.findings) {
            const key = f.severity;
            const b = buckets.get(key) || { count: 0, docs: new Set<string>() };
            b.count += 1;
            b.docs.add(s.documentId);
            buckets.set(key, b);
        }
    }

    const rows = [...buckets.entries()]
        .sort((a, b) => b[1].count - a[1].count)
        .map(([severity, b]) => ({
            severity,
            count: b.count,
            _documentIds: docIdsField(b.docs),
        }));

    return {
        id: `comp_findings_${Date.now()}`,
        agentId: COMPLIANCE_AGENT,
        kind: 'bar',
        title: 'Findings by severity',
        subtitle: 'Audits, inspections, quality & gaps',
        categoryKey: 'severity',
        series: [{ key: 'count', label: 'Findings', color: '#7c3aed' }],
        data: rows,
        emptyState: rows.length ? undefined : 'No audit findings extracted from scoped documents.',
        footer: 'From audit_findings, findings, inspection FAIL rows, and quality failures.',
    };
}

export function buildComplianceStatusVisual(snapshots: ComplianceDocSnapshot[]): ChatVisualSpec {
    const buckets = new Map<string, { count: number; docs: Set<string> }>();
    for (const s of snapshots) {
        const key =
            s.normalizedStatus ||
            (s.overallStatus.trim() ? s.overallStatus.trim() : 'Not specified');
        const label = key.replace(/_/g, ' ');
        const b = buckets.get(label) || { count: 0, docs: new Set<string>() };
        b.count += 1;
        b.docs.add(s.documentId);
        buckets.set(label, b);
    }

    const rows = [...buckets.entries()]
        .sort((a, b) => b[1].count - a[1].count)
        .map(([status, b]) => ({
            status: truncateLabel(status, 32),
            count: b.count,
            _documentIds: docIdsField(b.docs),
        }));

    return {
        id: `comp_status_mix_${Date.now()}`,
        agentId: COMPLIANCE_AGENT,
        kind: 'pie',
        title: 'Overall compliance status',
        subtitle: 'Normalized across audits / inspections / forms',
        categoryKey: 'status',
        series: [{ key: 'count', label: 'Documents' }],
        data: rows,
        emptyState: rows.length ? undefined : 'No normalized compliance status on scoped documents.',
        footer: 'Normalized from overall_compliance_status, compliance_status, overall_rating, result.',
    };
}

export function buildComplianceRegisterVisual(snapshots: ComplianceDocSnapshot[]): ChatVisualSpec {
    const rows = [...snapshots]
        .filter(
            (s) =>
                s.expiryDate != null ||
                s.certStatus !== 'UNKNOWN' ||
                Boolean(s.certificateNumber) ||
                Boolean(s.standardOrRegulation)
        )
        .sort((a, b) => {
            const da = a.daysUntilExpiry ?? 99999;
            const db = b.daysUntilExpiry ?? 99999;
            return da - db;
        })
        .slice(0, 50);

    return {
        id: 'compliance_cert_register',
        agentId: COMPLIANCE_AGENT,
        kind: 'table',
        title: 'Certificate & license register',
        subtitle: 'Sorted by soonest expiry',
        categoryKey: 'filename',
        series: [
            { key: 'filename', label: 'Document' },
            { key: 'standard', label: 'Standard' },
            { key: 'expiry', label: 'Expiry' },
            { key: 'daysLeft', label: 'Days left' },
            { key: 'status', label: 'Status' },
        ],
        data: rows.map((s) => ({
            filename: truncateLabel(s.filename, 40),
            standard: truncateLabel(s.standardOrRegulation || '—', 28),
            expiry: s.expiryDate ? s.expiryDate.toISOString().slice(0, 10) : '—',
            daysLeft: s.daysUntilExpiry != null ? String(s.daysUntilExpiry) : '—',
            status: s.certStatus.replace(/_/g, ' '),
            _documentIds: s.documentId,
        })),
        emptyState: rows.length ? undefined : 'No certificate expiry or standard fields extracted.',
        sourceDocumentIds: rows.map((s) => s.documentId),
    };
}

export function computeComplianceCoverage(
    snapshots: ComplianceDocSnapshot[],
    docsInScope: number
): ComplianceAnalyticsCoverage {
    const withExpiry = snapshots.filter((s) => s.expiryDate != null || s.certStatus !== 'UNKNOWN').length;
    const withFindings = snapshots.filter((s) => s.findings.length > 0).length;
    return {
        documentsInScope: docsInScope,
        documentsWithExpiry: withExpiry,
        documentsWithFindings: withFindings,
    };
}

export async function buildComplianceFileCoverage(
    user: AuthUser,
    snapshots: ComplianceDocSnapshot[],
    options: LoadComplianceOptions = {}
): Promise<NonNullable<ComplianceAnalyticsCoverage['files']>> {
    const docs = await loadComplianceDocsForAnalytics(user, options);
    const snapById = new Map(snapshots.map((s) => [s.documentId, s]));
    return docs.map((d) => {
        const snap = snapById.get(d.documentId);
        if (!d.pythonDocumentId) {
            return {
                documentId: d.documentId,
                filename: d.originalFilename,
                status: 'not_linked' as const,
                detail: 'Not linked to AI processing yet.',
            };
        }
        if (!snap) {
            return {
                documentId: d.documentId,
                filename: d.originalFilename,
                status: 'no_extraction' as const,
                detail: 'No extraction payload found.',
            };
        }
        const inCharts =
            snap.findings.length > 0 ||
            snap.expiryDate != null ||
            snap.certStatus !== 'UNKNOWN' ||
            Boolean(snap.overallStatus) ||
            Boolean(snap.standardOrRegulation);
        return {
            documentId: d.documentId,
            filename: d.originalFilename,
            status: inCharts ? ('in_charts' as const) : ('no_extraction' as const),
            detail: inCharts
                ? undefined
                : 'Reprocess with Compliance Agent for expiry/findings/status fields.',
        };
    });
}
