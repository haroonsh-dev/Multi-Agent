/**
 * HR portfolio analytics — directory, certificate expiry, onboarding,
 * leave / payroll / attendance charts built from extractions.
 */
import Document from '../models/Document';
import { AuthUser, buildDocumentFilter } from './accessScope';
import {
    getDocumentExtractions,
    getAiDocument,
    resolveDocumentAiOrgId,
} from './aiServiceClient';
import type { ChatVisualSpec } from '../types/chatVisuals';
import { scalarField } from './financeAnalyticsService';
import { HR_AGENT } from './offerLetterGenerationService';
import { listTopResumesForUser } from './hrChatActionService';
import { filterDocsByAgent } from './documentStorage';

export { HR_AGENT };

export const HR_DOC_TYPES = [
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
    'resume',
    'transcript',
] as const;

export const HR_ANALYTICS_EXCLUDED = new Set([
    'hr_report',
    'hr_shortlist',
    'promotion_letter',
    'warning_letter',
    'relieving_letter',
    'offer_letter',
    'experience_letter',
    'finance_report',
    'compliance_report',
]);

export type HrVisualIntent =
    | 'ranking'
    | 'distribution'
    | 'certs'
    | 'onboarding'
    | 'directory'
    | 'leave'
    | 'payroll'
    | 'attendance'
    | 'performance'
    | 'transcript'
    | 'overview';

export type HrEmployeeRow = {
    documentId: string;
    filename: string;
    employeeName: string;
    employeeId: string;
    department: string;
    designation: string;
    status: string;
    email: string;
    joined: string;
};

export type HrCertRow = {
    documentId: string;
    filename: string;
    employeeName: string;
    certificateName: string;
    expiryDate: Date | null;
    daysUntilExpiry: number | null;
    status: 'VALID' | 'EXPIRING_SOON' | 'EXPIRED' | 'UNKNOWN';
};

export type HrOnboardingRow = {
    documentId: string;
    filename: string;
    employeeName: string;
    completeness: number;
    status: string;
    missing: string[];
};

export type HrLeaveRow = {
    documentId: string;
    filename: string;
    employeeName: string;
    department: string;
    leaveType: string;
    totalDays: number;
    approvalStatus: string;
};

export type HrPayrollRow = {
    documentId: string;
    filename: string;
    employeeName: string;
    department: string;
    period: string;
    netSalary: number;
    currency: string;
};

export type HrAttendanceRow = {
    documentId: string;
    filename: string;
    employeeName: string;
    department: string;
    period: string;
    presentPct: number;
    daysPresent: number;
    totalWorkingDays: number;
};

export type HrPerformanceRow = {
    documentId: string;
    filename: string;
    employeeName: string;
    period: string;
    overallRating: string;
    ratingScore: number | null;
    promotionRecommended: boolean | null;
};

export type HrTranscriptRow = {
    documentId: string;
    filename: string;
    studentName: string;
    institution: string;
    degree: string;
    gpa: number | null;
    maxGpa: number | null;
};

export type HrSnapshotBundle = {
    employees: HrEmployeeRow[];
    certs: HrCertRow[];
    onboarding: HrOnboardingRow[];
    leave: HrLeaveRow[];
    payroll: HrPayrollRow[];
    attendance: HrAttendanceRow[];
    performance: HrPerformanceRow[];
    transcripts: HrTranscriptRow[];
};

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

function unwrapValue(raw: unknown): string {
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
        const o = raw as Record<string, unknown>;
        if ('value' in o) return scalarField(o.value);
    }
    return scalarField(raw);
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

function pickExtractionData(
    extractions: Awaited<ReturnType<typeof getDocumentExtractions>>
): Record<string, unknown> {
    if (!extractions?.length) return {};
    const sorted = [...extractions].sort((a, b) => {
        const ta = a.created_at ? new Date(a.created_at).getTime() : 0;
        const tb = b.created_at ? new Date(b.created_at).getTime() : 0;
        return tb - ta;
    });
    const merged: Record<string, unknown> = {};
    for (const ext of [...sorted].reverse()) {
        if (String(ext.extraction_type || '') === 'table_extraction') continue;
        Object.assign(merged, (ext.extracted_data || {}) as Record<string, unknown>);
    }
    return normalizeExtractionPayload(merged);
}

async function extractionPayloadForDoc(
    doc: { pythonDocumentId?: string | null; organizationId?: string | null },
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

function daysUntil(expiry: Date | null, now = new Date()): number | null {
    if (!expiry) return null;
    return Math.floor((expiry.getTime() - now.getTime()) / 86400000);
}

function certStatusFromDays(days: number | null): HrCertRow['status'] {
    if (days == null) return 'UNKNOWN';
    if (days < 0) return 'EXPIRED';
    if (days <= 30) return 'EXPIRING_SOON';
    return 'VALID';
}

function deriveCertStatus(
    explicit: string,
    days: number | null
): HrCertRow['status'] {
    const s = explicit.toUpperCase().replace(/\s+/g, '_');
    if (s === 'EXPIRED' || s === 'EXPIRING_SOON' || s === 'VALID') return s as HrCertRow['status'];
    return certStatusFromDays(days);
}

export function parseHrDocIntoBundle(
    doc: { documentId: string; originalFilename: string; classification?: string | null },
    data: Record<string, unknown>
): Partial<HrSnapshotBundle> {
    const cls = String(doc.classification || '').toLowerCase();
    const name =
        unwrapValue(data.employee_name) ||
        unwrapValue(data.candidate_name) ||
        unwrapValue(data.full_name) ||
        '';
    const empId = unwrapValue(data.employee_id) || '';
    const department =
        unwrapValue(data.department) || unwrapValue(data.dept) || unwrapValue(data.team) || '';
    const designation =
        unwrapValue(data.designation) ||
        unwrapValue(data.job_title) ||
        unwrapValue(data.title) ||
        '';

    const out: Partial<HrSnapshotBundle> = {};

    if (
        cls === 'employee_record' ||
        cls === 'hr_document' ||
        (name && (designation || department || empId) && cls !== 'resume')
    ) {
        if (name || empId) {
            out.employees = [
                {
                    documentId: doc.documentId,
                    filename: doc.originalFilename,
                    employeeName: name || 'Unknown',
                    employeeId: empId,
                    department,
                    designation,
                    status: unwrapValue(data.employment_status) || unwrapValue(data.status) || '',
                    email: unwrapValue(data.email),
                    joined: unwrapValue(data.date_of_joining) || unwrapValue(data.joining_date),
                },
            ];
        }
    }

    // Certificates — array form or single training_certificate
    const certsRaw = Array.isArray(data.certificates) ? data.certificates : null;
    if (certsRaw?.length) {
        const rows: HrCertRow[] = [];
        for (const c of certsRaw) {
            if (!c || typeof c !== 'object') continue;
            const row = c as Record<string, unknown>;
            const expiry = parseDate(row.expiry_date);
            const days =
                parseNumber(row.days_until_expiry) ?? daysUntil(expiry);
            rows.push({
                documentId: doc.documentId,
                filename: doc.originalFilename,
                employeeName: name || unwrapValue(row.employee_name) || 'Unknown',
                certificateName:
                    scalarField(row.certificate_name) ||
                    scalarField(row.name) ||
                    'Certificate',
                expiryDate: expiry,
                daysUntilExpiry: days,
                status: deriveCertStatus(scalarField(row.status), days),
            });
        }
        if (rows.length) out.certs = rows;
    } else if (
        cls === 'training_certificate' ||
        parseDate(data.expiry_date) ||
        unwrapValue(data.certificate_name)
    ) {
        const expiry = parseDate(data.expiry_date) || parseDate(data.valid_until);
        const days = daysUntil(expiry);
        out.certs = [
            {
                documentId: doc.documentId,
                filename: doc.originalFilename,
                employeeName: name || 'Unknown',
                certificateName:
                    unwrapValue(data.certificate_name) ||
                    unwrapValue(data.training_name) ||
                    doc.originalFilename,
                expiryDate: expiry,
                daysUntilExpiry: days,
                status: deriveCertStatus(unwrapValue(data.status), days),
            },
        ];
    }

    // Onboarding completeness
    if (
        Array.isArray(data.missing_documents) ||
        parseNumber(data.completeness_percentage) != null ||
        unwrapValue(data.onboarding_status)
    ) {
        const missing = Array.isArray(data.missing_documents)
            ? data.missing_documents.map((m) => String(m))
            : [];
        out.onboarding = [
            {
                documentId: doc.documentId,
                filename: doc.originalFilename,
                employeeName: name || 'Unknown',
                completeness: Math.max(
                    0,
                    Math.min(100, parseNumber(data.completeness_percentage) ?? (missing.length ? 0 : 100))
                ),
                status: unwrapValue(data.onboarding_status) || (missing.length ? 'INCOMPLETE' : 'COMPLETE'),
                missing,
            },
        ];
    }

    if (cls === 'leave_application' || unwrapValue(data.leave_type) || parseNumber(data.total_days) != null) {
        const days = parseNumber(data.total_days) ?? 0;
        if (name || days > 0 || unwrapValue(data.leave_type)) {
            out.leave = [
                {
                    documentId: doc.documentId,
                    filename: doc.originalFilename,
                    employeeName: name || 'Unknown',
                    department,
                    leaveType: unwrapValue(data.leave_type) || 'Leave',
                    totalDays: days,
                    approvalStatus: unwrapValue(data.approval_status) || '',
                },
            ];
        }
    }

    if (
        cls === 'payroll' ||
        parseNumber(data.net_salary) != null ||
        parseNumber(data.gross_salary) != null
    ) {
        const net =
            parseNumber(data.net_salary) ??
            parseNumber(data.gross_salary) ??
            parseNumber(data.basic_salary) ??
            0;
        if (net > 0 || name) {
            out.payroll = [
                {
                    documentId: doc.documentId,
                    filename: doc.originalFilename,
                    employeeName: name || 'Unknown',
                    department: department || unwrapValue(data.designation),
                    period: unwrapValue(data.payslip_period) || unwrapValue(data.period) || 'Unknown',
                    netSalary: net,
                    currency: (unwrapValue(data.currency) || 'USD').toUpperCase().slice(0, 3),
                },
            ];
        }
    }

    if (
        cls === 'attendance' ||
        parseNumber(data.days_present) != null ||
        parseNumber(data.total_working_days) != null
    ) {
        const present = parseNumber(data.days_present) ?? 0;
        const total = parseNumber(data.total_working_days) ?? 0;
        const pct = total > 0 ? Math.round((present / total) * 1000) / 10 : 0;
        if (name || total > 0) {
            out.attendance = [
                {
                    documentId: doc.documentId,
                    filename: doc.originalFilename,
                    employeeName: name || 'Unknown',
                    department,
                    period: unwrapValue(data.period) || '',
                    presentPct: pct,
                    daysPresent: present,
                    totalWorkingDays: total,
                },
            ];
        }
    }

    if (
        cls === 'performance_review' ||
        unwrapValue(data.overall_rating) ||
        parseNumber(data.rating_score) != null ||
        unwrapValue(data.reviewer_name)
    ) {
        const score = parseNumber(data.rating_score);
        const rating = unwrapValue(data.overall_rating);
        if (name || rating || score != null) {
            const promo = data.promotion_recommended;
            out.performance = [
                {
                    documentId: doc.documentId,
                    filename: doc.originalFilename,
                    employeeName: name || 'Unknown',
                    period: unwrapValue(data.review_period) || '',
                    overallRating: rating,
                    ratingScore: score,
                    promotionRecommended:
                        typeof promo === 'boolean' ? promo : promo == null ? null : Boolean(promo),
                },
            ];
        }
    }

    if (
        cls === 'transcript' ||
        unwrapValue(data.student_name) ||
        parseNumber(data.gpa_cgpa) != null ||
        unwrapValue(data.degree_program)
    ) {
        const student =
            unwrapValue(data.student_name) || name || 'Unknown';
        const gpa = parseNumber(data.gpa_cgpa) ?? parseNumber(data.gpa);
        if (student !== 'Unknown' || gpa != null || unwrapValue(data.institution_name)) {
            out.transcripts = [
                {
                    documentId: doc.documentId,
                    filename: doc.originalFilename,
                    studentName: student,
                    institution: unwrapValue(data.institution_name),
                    degree: unwrapValue(data.degree_program),
                    gpa,
                    maxGpa: parseNumber(data.max_gpa),
                },
            ];
        }
    }

    return out;
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
    await Promise.all(Array.from({ length: Math.min(concurrency, items.length || 1) }, () => worker()));
    return results;
}

export async function loadHrSnapshotBundle(
    user: AuthUser,
    options: { maxDocs?: number; documentIds?: string[] } = {}
): Promise<HrSnapshotBundle> {
    const filter = await buildDocumentFilter(user, {});
    const query: Record<string, unknown> = {
        ...filter,
        status: 'ready',
        pythonDocumentId: { $exists: true, $nin: [null, ''] },
        classification: { $nin: [...HR_ANALYTICS_EXCLUDED] },
        $or: [
            { classification: { $in: [...HR_DOC_TYPES] } },
            { 'metadata.phase3Agent': HR_AGENT },
        ],
    };
    if (options.documentIds?.length) {
        query.documentId = { $in: options.documentIds };
    }

    const docs = await Document.find(query)
        .sort({ createdAt: -1 })
        .limit(options.maxDocs ?? 120)
        .select('documentId originalFilename classification pythonDocumentId organizationId metadata')
        .lean();

    const hrDocs = filterDocsByAgent(docs, HR_AGENT);

    const bundle: HrSnapshotBundle = {
        employees: [],
        certs: [],
        onboarding: [],
        leave: [],
        payroll: [],
        attendance: [],
        performance: [],
        transcripts: [],
    };

    const parts = await mapPool(hrDocs, 6, async (doc) => {
        const data = await extractionPayloadForDoc(doc, user);
        return parseHrDocIntoBundle(
            {
                documentId: doc.documentId,
                originalFilename: doc.originalFilename,
                classification: doc.classification,
            },
            data
        );
    });

    for (const p of parts) {
        if (p.employees) bundle.employees.push(...p.employees);
        if (p.certs) bundle.certs.push(...p.certs);
        if (p.onboarding) bundle.onboarding.push(...p.onboarding);
        if (p.leave) bundle.leave.push(...p.leave);
        if (p.payroll) bundle.payroll.push(...p.payroll);
        if (p.attendance) bundle.attendance.push(...p.attendance);
        if (p.performance) bundle.performance.push(...p.performance);
        if (p.transcripts) bundle.transcripts.push(...p.transcripts);
    }

    return bundle;
}

export function buildCertExpiryVisual(certs: HrCertRow[]): ChatVisualSpec {
    const buckets = [
        { label: 'Expired', key: 'EXPIRED' },
        { label: '≤30 days', key: 'EXPIRING_SOON' },
        { label: '31–90 days', key: 'SOON90' },
        { label: '90+ / valid', key: 'VALID' },
        { label: 'Unknown', key: 'UNKNOWN' },
    ] as const;
    const counts = new Map<string, { n: number; docs: Set<string> }>();
    for (const b of buckets) counts.set(b.key, { n: 0, docs: new Set() });

    for (const c of certs) {
        let key: string = c.status;
        if (c.status === 'VALID' && c.daysUntilExpiry != null && c.daysUntilExpiry <= 90) {
            key = 'SOON90';
        }
        if (c.status === 'VALID' && (c.daysUntilExpiry == null || c.daysUntilExpiry > 90)) {
            key = 'VALID';
        }
        if (!counts.has(key)) key = 'UNKNOWN';
        const g = counts.get(key)!;
        g.n += 1;
        g.docs.add(c.documentId);
    }

    return {
        id: `hr_certs_${Date.now()}`,
        agentId: HR_AGENT,
        kind: 'bar',
        title: 'Certificate expiry (30 / 60 / 90 days)',
        subtitle: `${certs.length} certificate(s) in scope`,
        categoryKey: 'bucket',
        series: [{ key: 'count', label: 'Certificates', color: '#a855f7' }],
        data: buckets.map((b) => ({
            bucket: b.label,
            count: counts.get(b.key)?.n || 0,
            _documentIds: [...(counts.get(b.key)?.docs || [])].join(','),
        })),
        footer: 'From training certificates / certificate_expiry extractions. EXPIRING_SOON ≤ 30 days.',
    };
}

export function buildOnboardingVisual(rows: HrOnboardingRow[]): ChatVisualSpec {
    const sorted = [...rows].sort((a, b) => a.completeness - b.completeness).slice(0, 20);
    return {
        id: `hr_onboard_${Date.now()}`,
        agentId: HR_AGENT,
        kind: 'bar',
        title: 'Onboarding completeness',
        subtitle: `${rows.length} employee packet(s)`,
        categoryKey: 'employee',
        series: [{ key: 'pct', label: '% complete', color: '#7c3aed' }],
        data: sorted.map((r) => ({
            employee:
                r.employeeName.length > 22 ? `${r.employeeName.slice(0, 20)}…` : r.employeeName,
            pct: r.completeness,
            _documentIds: r.documentId,
        })),
        emptyState: sorted.length ? undefined : 'No onboarding completeness data in scope.',
        footer: 'Missing docs from employee_document_completeness extractions.',
    };
}

export function buildLeaveVisual(rows: HrLeaveRow[]): ChatVisualSpec {
    const byDept = new Map<string, { days: number; docs: Set<string> }>();
    for (const r of rows) {
        const key = r.department.trim() || r.employeeName || 'Unknown';
        const g = byDept.get(key) || { days: 0, docs: new Set() };
        g.days += r.totalDays || 0;
        g.docs.add(r.documentId);
        byDept.set(key, g);
    }
    const data = [...byDept.entries()]
        .map(([label, v]) => ({
            party: label.length > 24 ? `${label.slice(0, 22)}…` : label,
            days: Math.round(v.days * 10) / 10,
            _documentIds: [...v.docs].join(','),
        }))
        .sort((a, b) => b.days - a.days)
        .slice(0, 20);

    return {
        id: `hr_leave_${Date.now()}`,
        agentId: HR_AGENT,
        kind: 'bar',
        title: 'Leave days by person / dept',
        subtitle: `${rows.length} leave application(s)`,
        categoryKey: 'party',
        series: [{ key: 'days', label: 'Days', color: '#8b5cf6' }],
        data: data,
        emptyState: data.length ? undefined : 'No leave applications with day counts in scope.',
        footer: 'Sum of total_days from leave applications in scope.',
    };
}

export function buildPayrollVisual(rows: HrPayrollRow[]): ChatVisualSpec {
    const byPeriod = new Map<string, { amount: number; currency: string; docs: Set<string> }>();
    for (const r of rows) {
        const g = byPeriod.get(r.period) || { amount: 0, currency: r.currency, docs: new Set() };
        g.amount += r.netSalary;
        g.docs.add(r.documentId);
        byPeriod.set(r.period, g);
    }
    const currency = rows[0]?.currency || 'USD';
    const data = [...byPeriod.entries()]
        .map(([period, v]) => ({
            period,
            amount: Math.round(v.amount * 100) / 100,
            _documentIds: [...v.docs].join(','),
        }))
        .sort((a, b) => a.period.localeCompare(b.period))
        .slice(-12);

    // Also dept bars if periods thin
    const byDept = new Map<string, number>();
    for (const r of rows) {
        const d = r.department.trim() || 'Unknown';
        byDept.set(d, (byDept.get(d) || 0) + r.netSalary);
    }

    const visuals: ChatVisualSpec = {
        id: `hr_payroll_${Date.now()}`,
        agentId: HR_AGENT,
        kind: 'bar',
        title: data.length > 1 ? 'Payroll by period' : 'Payroll by department',
        subtitle: `${rows.length} payslip(s) · ${currency}`,
        currency,
        categoryKey: data.length > 1 ? 'period' : 'dept',
        series: [{ key: 'amount', label: `Net (${currency})`, color: '#6d28d9' }],
        data:
            data.length > 1
                ? data
                : [...byDept.entries()]
                      .map(([dept, amount]) => ({
                          dept: dept.length > 22 ? `${dept.slice(0, 20)}…` : dept,
                          amount: Math.round(amount * 100) / 100,
                      }))
                      .sort((a, b) => b.amount - a.amount)
                      .slice(0, 15),
        footer: 'Net salary from payroll extractions (not a full payroll ledger).',
    };
    return visuals;
}

export function buildAttendanceVisual(rows: HrAttendanceRow[]): ChatVisualSpec {
    const sorted = [...rows].sort((a, b) => a.presentPct - b.presentPct).slice(0, 20);
    return {
        id: `hr_att_${Date.now()}`,
        agentId: HR_AGENT,
        kind: 'bar',
        title: 'Attendance % by employee',
        subtitle: `${rows.length} attendance record(s)`,
        categoryKey: 'employee',
        series: [{ key: 'pct', label: 'Present %', color: '#9333ea' }],
        data: sorted.map((r) => ({
            employee:
                r.employeeName.length > 22 ? `${r.employeeName.slice(0, 20)}…` : r.employeeName,
            pct: r.presentPct,
            _documentIds: r.documentId,
        })),
        emptyState: sorted.length ? undefined : 'No attendance records in scope.',
        footer: 'days_present ÷ total_working_days from attendance extractions.',
    };
}

export function buildPerformanceVisual(rows: HrPerformanceRow[]): ChatVisualSpec {
    const scored = rows.filter((r) => r.ratingScore != null);
    if (scored.length) {
        return {
            id: `hr_perf_${Date.now()}`,
            agentId: HR_AGENT,
            kind: 'bar',
            title: 'Performance review scores',
            subtitle: `${scored.length} review(s) with numeric score`,
            categoryKey: 'employee',
            series: [{ key: 'score', label: 'Rating score', color: '#7c3aed' }],
            data: scored
                .sort((a, b) => (b.ratingScore || 0) - (a.ratingScore || 0))
                .slice(0, 20)
                .map((r) => ({
                    employee:
                        r.employeeName.length > 22
                            ? `${r.employeeName.slice(0, 20)}…`
                            : r.employeeName,
                    score: r.ratingScore as number,
                    _documentIds: r.documentId,
                })),
            footer: 'From performance_review extractions (rating_score).',
        };
    }
    const byRating = new Map<string, { n: number; docs: Set<string> }>();
    for (const r of rows) {
        const key = r.overallRating || 'Unrated';
        const g = byRating.get(key) || { n: 0, docs: new Set() };
        g.n += 1;
        g.docs.add(r.documentId);
        byRating.set(key, g);
    }
    return {
        id: `hr_perf_${Date.now()}`,
        agentId: HR_AGENT,
        kind: 'bar',
        title: 'Performance ratings mix',
        subtitle: `${rows.length} review(s)`,
        categoryKey: 'rating',
        series: [{ key: 'count', label: 'Reviews', color: '#7c3aed' }],
        data: [...byRating.entries()].map(([rating, v]) => ({
            rating: rating.length > 28 ? `${rating.slice(0, 26)}…` : rating,
            count: v.n,
            _documentIds: [...v.docs].join(','),
        })),
        footer: 'From overall_rating on performance reviews.',
    };
}

export function buildTranscriptVisual(rows: HrTranscriptRow[]): ChatVisualSpec {
    const scored = rows.filter((r) => r.gpa != null);
    return {
        id: `hr_tr_${Date.now()}`,
        agentId: HR_AGENT,
        kind: 'bar',
        title: 'Transcript GPA',
        subtitle: `${rows.length} transcript(s)`,
        categoryKey: 'student',
        series: [{ key: 'gpa', label: 'GPA / CGPA', color: '#a855f7' }],
        data: (scored.length ? scored : []).slice(0, 20).map((r) => ({
            student: r.studentName.length > 22 ? `${r.studentName.slice(0, 20)}…` : r.studentName,
            gpa: r.gpa ?? 0,
            _documentIds: r.documentId,
        })),
        emptyState: scored.length ? undefined : 'No GPA / CGPA extracted from transcripts in scope.',
        footer: 'From transcript extractions (gpa_cgpa).',
    };
}

export function formatPerformanceList(rows: HrPerformanceRow[], max = 25): string {
    if (!rows.length) return '_No performance reviews in scope._';
    const lines = [
        `| Employee | Period | Rating | Score | Promo? |`,
        `| --- | --- | --- | ---: | --- |`,
        ...rows.slice(0, max).map((r) => {
            const esc = (s: string) => s.replace(/\|/g, '\\|') || '—';
            const promo =
                r.promotionRecommended == null ? '—' : r.promotionRecommended ? 'Yes' : 'No';
            return `| ${esc(r.employeeName)} | ${esc(r.period)} | ${esc(r.overallRating)} | ${r.ratingScore ?? '—'} | ${promo} |`;
        }),
    ];
    return lines.join('\n');
}

export function formatTranscriptList(rows: HrTranscriptRow[], max = 25): string {
    if (!rows.length) return '_No transcripts in scope._';
    const lines = [
        `| Student | Institution | Degree | GPA |`,
        `| --- | --- | --- | ---: |`,
        ...rows.slice(0, max).map((r) => {
            const esc = (s: string) => s.replace(/\|/g, '\\|') || '—';
            return `| ${esc(r.studentName)} | ${esc(r.institution)} | ${esc(r.degree)} | ${r.gpa ?? '—'} |`;
        }),
    ];
    return lines.join('\n');
}

export function formatEmployeeDirectory(rows: HrEmployeeRow[], max = 40): string {
    if (!rows.length) return '_No employee records with extracted name/ID in scope._';
    const lines = [
        `| Name | ID | Department | Title | Status |`,
        `| --- | --- | --- | --- | --- |`,
        ...rows.slice(0, max).map((r) => {
            const esc = (s: string) => s.replace(/\|/g, '\\|') || '—';
            return `| ${esc(r.employeeName)} | ${esc(r.employeeId)} | ${esc(r.department)} | ${esc(r.designation)} | ${esc(r.status)} |`;
        }),
    ];
    if (rows.length > max) lines.push(`\n_…and ${rows.length - max} more._`);
    return lines.join('\n');
}

export function formatCertExpiryList(certs: HrCertRow[], max = 25): string {
    const urgent = [...certs]
        .filter((c) => c.status === 'EXPIRED' || c.status === 'EXPIRING_SOON' || (c.daysUntilExpiry != null && c.daysUntilExpiry <= 90))
        .sort((a, b) => (a.daysUntilExpiry ?? 9999) - (b.daysUntilExpiry ?? 9999));
    if (!urgent.length) return '_No expired or soon-expiring certificates in scope._';
    const lines = [
        `| Employee | Certificate | Days | Status |`,
        `| --- | --- | ---: | --- |`,
        ...urgent.slice(0, max).map((c) => {
            const esc = (s: string) => s.replace(/\|/g, '\\|');
            return `| ${esc(c.employeeName)} | ${esc(c.certificateName)} | ${c.daysUntilExpiry ?? '—'} | ${c.status} |`;
        }),
    ];
    return lines.join('\n');
}

export function formatOnboardingList(rows: HrOnboardingRow[], max = 25): string {
    const sorted = [...rows].sort((a, b) => a.completeness - b.completeness);
    if (!sorted.length) return '_No onboarding completeness extractions in scope._';
    const lines = [
        `| Employee | % | Status | Missing |`,
        `| --- | ---: | --- | --- |`,
        ...sorted.slice(0, max).map((r) => {
            const esc = (s: string) => s.replace(/\|/g, '\\|');
            return `| ${esc(r.employeeName)} | ${r.completeness} | ${esc(r.status)} | ${esc(r.missing.join(', ') || '—')} |`;
        }),
    ];
    return lines.join('\n');
}

export function detectHrVisualIntent(question: string, phase3Agent?: string): HrVisualIntent | null {
    const q = question.toLowerCase().trim();
    const onHr = phase3Agent === HR_AGENT;
    const hrContext =
        onHr ||
        /\b(hr\s+agent|resume|cv|candidate|employee|payroll|leave|attendance|onboarding|certificate|performance|appraisal|transcript|marksheet)\b/i.test(
            question
        );
    if (!hrContext) return null;

    // Soft HR-agent mode: natural questions count as work intents (no "chart" required).
    if (/\b(employee\s+directory|staff\s+directory|employee\s+roster|list\s+employees|show\s+(me\s+)?employees|who\s+works|headcount|roster)\b/i.test(q)) {
        return 'directory';
    }
    if (/\b(onboarding|completeness|missing\s+docs?|document\s+checklist|incomplete\s+packet)\b/i.test(q)) {
        return 'onboarding';
    }
    if (
        /\b(cert(?:ificate)?s?\s+expir(?:y|ing|es|ation)?|expir(?:y|ing)\s+cert|training\s+cert|certs?\s+expir|any\s+certs?\b|expiring\s+soon)\b/i.test(
            q
        ) ||
        (onHr &&
            /\b(certificate|training\s+cert)\b/.test(q) &&
            !/\b(generate|create|draft|issue|make|completion)\b/.test(q) &&
            !/\b(joining|internship|offer|experience|promotion|warning|relieving)\b/.test(q))
    ) {
        return 'certs';
    }
    if (
        /\b(performance\s+review|appraisal|rating\s+score|promo(?:tion)?\s+recommend)\b/i.test(q) ||
        (onHr && /\b(performance|appraisal|review\s+scores?)\b/.test(q))
    ) {
        return 'performance';
    }
    if (/\b(transcripts?|marksheets?|gpa|cgpa|degree\s+program)\b/i.test(q)) {
        return 'transcript';
    }
    if (
        /\bleave\b/.test(q) &&
        !/\b(letter|joining|hire|internship)\b/.test(q) &&
        (onHr || /\b(chart|graph|visual|summary|who|days|pending|approved)\b/.test(q))
    ) {
        return 'leave';
    }
    if (
        /\b(payroll|payslip|salary)\b/.test(q) &&
        (onHr || /\b(chart|graph|visual|summary|by|total)\b/.test(q))
    ) {
        return 'payroll';
    }
    if (
        /\battendance\b/.test(q) &&
        (onHr || /\b(chart|graph|visual|%|percent|summary)\b/.test(q))
    ) {
        return 'attendance';
    }
    if (/\b(distribution|histogram|bucket|spread)\b/i.test(q) && /\b(cv|score|resume|candidate)\b/.test(q)) {
        return 'distribution';
    }
    if (
        /\b(chart|graph|visuali[sz]e|visual|plot|rank|ranking|score|shortlist|top\s+\d+)\b/i.test(q) ||
        (/\btop\b/.test(q) && /\b(resume|cv|candidate)\b/.test(q)) ||
        (onHr && /\b(candidates?|resumes?|cvs?)\b/.test(q) && /\b(best|top|rank|score|show|list)\b/.test(q))
    ) {
        if (/\b(distribution|histogram)\b/.test(q)) return 'distribution';
        return 'ranking';
    }
    if (onHr && /\b(overview|dashboard|hr\s+analytics|workforce\s+summary|people\s+summary)\b/i.test(q)) {
        return 'overview';
    }
    if (onHr && /^(hi|hello|help|what can you do|start)\b/i.test(q)) {
        return 'overview';
    }
    return null;
}

export function mapHrPanelView(view?: string): HrVisualIntent {
    switch (view) {
        case 'score_dist':
            return 'distribution';
        case 'scores':
            return 'ranking';
        case 'expiry':
        case 'cert_status':
            return 'certs';
        case 'onboarding':
            return 'onboarding';
        case 'leave':
            return 'leave';
        case 'payroll':
            return 'payroll';
        case 'attendance':
            return 'attendance';
        case 'directory':
            return 'directory';
        case 'performance':
            return 'performance';
        case 'transcript':
            return 'transcript';
        default:
            return 'overview';
    }
}

export async function executeHrPortfolioAnalytics(
    user: AuthUser,
    intent: HrVisualIntent,
    documentIds?: string[],
    limit = 10
): Promise<{
    visuals: ChatVisualSpec[];
    citations: Array<{
        documentId: string;
        filename?: string;
        documentType?: string;
        phase3Agent?: string;
    }>;
    answer: string;
    documentCount: number;
    bundle?: HrSnapshotBundle;
}> {
    // ranking / distribution are handled by executeHrAnalytics (agentChatVisualService)
    if (intent === 'ranking' || intent === 'distribution') {
        return {
            visuals: [],
            citations: [],
            documentCount: 0,
            answer: 'Use CV ranking or score distribution prompts for resume charts.',
        };
    }

    const bundle = await loadHrSnapshotBundle(user, {
        documentIds,
        maxDocs: 120,
    });

    const visuals: ChatVisualSpec[] = [];
    const answerParts: string[] = [];
    const citeIds = new Set<string>();

    const addCite = (id: string, filename: string, type: string) => {
        citeIds.add(id);
        return { documentId: id, filename, documentType: type, phase3Agent: HR_AGENT };
    };
    const citations: Array<{
        documentId: string;
        filename?: string;
        documentType?: string;
        phase3Agent?: string;
    }> = [];

    if (intent === 'directory' || intent === 'overview') {
        answerParts.push('### Employee directory\n', formatEmployeeDirectory(bundle.employees));
        for (const e of bundle.employees.slice(0, 8)) {
            citations.push(addCite(e.documentId, e.filename, 'employee_record'));
        }
    }
    if (intent === 'certs' || intent === 'overview') {
        if (bundle.certs.length) {
            visuals.push(buildCertExpiryVisual(bundle.certs));
            answerParts.push('### Certificate expiry\n', formatCertExpiryList(bundle.certs));
            for (const c of bundle.certs.slice(0, 8)) {
                citations.push(addCite(c.documentId, c.filename, 'training_certificate'));
            }
        } else if (intent === 'certs') {
            answerParts.push(
                'No certificate expiry data in scope. Upload training certificates (or docs with certificate_expiry extraction) and wait until **ready**.'
            );
        }
    }
    if (intent === 'onboarding' || intent === 'overview') {
        if (bundle.onboarding.length) {
            visuals.push(buildOnboardingVisual(bundle.onboarding));
            answerParts.push('### Onboarding completeness\n', formatOnboardingList(bundle.onboarding));
            for (const o of bundle.onboarding.slice(0, 8)) {
                citations.push(addCite(o.documentId, o.filename, 'hr_document'));
            }
        } else if (intent === 'onboarding') {
            answerParts.push(
                'No onboarding completeness extractions in scope. Upload onboarding packets and reprocess if needed.'
            );
        }
    }
    if (intent === 'leave' || intent === 'overview') {
        if (bundle.leave.length) {
            visuals.push(buildLeaveVisual(bundle.leave));
            answerParts.push(`Leave: **${bundle.leave.length}** application(s) charted.`);
            for (const l of bundle.leave.slice(0, 6)) {
                citations.push(addCite(l.documentId, l.filename, 'leave_application'));
            }
        } else if (intent === 'leave') {
            answerParts.push('No leave applications with extracted days in scope.');
        }
    }
    if (intent === 'payroll' || intent === 'overview') {
        if (bundle.payroll.length) {
            visuals.push(buildPayrollVisual(bundle.payroll));
            answerParts.push(`Payroll: **${bundle.payroll.length}** payslip(s) charted.`);
            for (const p of bundle.payroll.slice(0, 6)) {
                citations.push(addCite(p.documentId, p.filename, 'payroll'));
            }
        } else if (intent === 'payroll') {
            answerParts.push('No payroll / payslip amounts in scope.');
        }
    }
    if (intent === 'attendance' || intent === 'overview') {
        if (bundle.attendance.length) {
            visuals.push(buildAttendanceVisual(bundle.attendance));
            answerParts.push(`Attendance: **${bundle.attendance.length}** record(s) charted.`);
            for (const a of bundle.attendance.slice(0, 6)) {
                citations.push(addCite(a.documentId, a.filename, 'attendance'));
            }
        } else if (intent === 'attendance') {
            answerParts.push('No attendance records with present/working days in scope.');
        }
    }
    if (intent === 'performance' || intent === 'overview') {
        if (bundle.performance.length) {
            visuals.push(buildPerformanceVisual(bundle.performance));
            answerParts.push('### Performance reviews\n', formatPerformanceList(bundle.performance));
            for (const p of bundle.performance.slice(0, 6)) {
                citations.push(addCite(p.documentId, p.filename, 'performance_review'));
            }
        } else if (intent === 'performance') {
            answerParts.push('No performance reviews with ratings in scope.');
        }
    }
    if (intent === 'transcript' || intent === 'overview') {
        if (bundle.transcripts.length) {
            visuals.push(buildTranscriptVisual(bundle.transcripts));
            answerParts.push('### Transcripts\n', formatTranscriptList(bundle.transcripts));
            for (const t of bundle.transcripts.slice(0, 6)) {
                citations.push(addCite(t.documentId, t.filename, 'transcript'));
            }
        } else if (intent === 'transcript') {
            answerParts.push('No transcripts with GPA/degree fields in scope.');
        }
    }

    // Overview: also include CV ranking if resumes in scope
    if (intent === 'overview') {
        try {
            const resumes = await listTopResumesForUser(user, limit, documentIds);
            const scored = resumes.filter((r) => Number.isFinite(r.cvScore)).slice(0, limit);
            if (scored.length) {
                visuals.unshift({
                    id: `hr_cv_${Date.now()}`,
                    agentId: HR_AGENT,
                    kind: 'bar',
                    title: 'Candidate CV scores',
                    subtitle: `Top ${scored.length} by score`,
                    categoryKey: 'candidate',
                    series: [{ key: 'score', label: 'CV score (0–100)', color: '#7c3aed' }],
                    data: scored.map((r) => ({
                        candidate:
                            r.originalFilename.length > 24
                                ? `${r.originalFilename.slice(0, 22)}…`
                                : r.originalFilename,
                        score: r.cvScore,
                        _documentIds: r.documentId,
                    })),
                });
                for (const r of scored.slice(0, 5)) {
                    citations.push(addCite(r.documentId, r.originalFilename, 'resume'));
                }
            }
        } catch {
            /* ignore */
        }
    }

    const uniqueCitations = [
        ...new Map(citations.map((c) => [c.documentId, c])).values(),
    ];

    const docCount = new Set([
        ...bundle.employees.map((e) => e.documentId),
        ...bundle.certs.map((c) => c.documentId),
        ...bundle.onboarding.map((o) => o.documentId),
        ...bundle.leave.map((l) => l.documentId),
        ...bundle.payroll.map((p) => p.documentId),
        ...bundle.attendance.map((a) => a.documentId),
        ...bundle.performance.map((p) => p.documentId),
        ...bundle.transcripts.map((t) => t.documentId),
        ...uniqueCitations.map((c) => c.documentId),
    ]).size;

    if (!answerParts.length && !visuals.length) {
        return {
            visuals: [],
            citations: [],
            documentCount: 0,
            answer:
                'No HR analytics data in scope yet. Select employee records, certificates, leave, payroll, attendance, or resumes, wait until **ready**, then ask again.',
            bundle,
        };
    }

    return {
        visuals,
        citations: uniqueCitations,
        documentCount: docCount,
        answer: [
            intent === 'overview'
                ? 'Here’s your **HR overview** from scoped documents.'
                : `Here’s **${intent.replace(/_/g, ' ')}** from scoped HR documents.`,
            '',
            ...answerParts,
            visuals.length ? '\nCharts are in the analytics panel.' : '',
        ]
            .filter(Boolean)
            .join('\n'),
        bundle,
    };
}
