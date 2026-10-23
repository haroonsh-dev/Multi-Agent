import Document from '../models/Document';
import User from '../models/User';
import Department from '../models/Department';
import EmailReportConfig, {
    DEFAULT_EMAIL_REPORT_SECTIONS,
    EmailReportFrequency,
    EmailReportSections,
    EmailReportType,
    IEmailReportConfig,
} from '../models/EmailReportConfig';
import { generateExtractionReportHtml, isAiServiceEnabled } from './aiServiceClient';
import { sendHtmlEmail, isEmailConfigured } from './emailService';
import logger from '../utils/logger';

function parseTime(raw: string): { hh: number; mm: number } {
    const match = /^(\d{1,2}):(\d{2})$/.exec(String(raw || '09:00').trim());
    const hh = match ? Math.min(23, Number(match[1])) : 9;
    const mm = match ? Math.min(59, Number(match[2])) : 0;
    return { hh, mm };
}

/** Next send time for daily/weekly schedules (server local time). */
export function computeNextEmailSendAt(params: {
    frequency: EmailReportFrequency;
    time: string;
    weekday: number;
    from?: Date;
}): Date {
    const from = params.from || new Date();
    const { hh, mm } = parseTime(params.time);
    const weekday = Math.max(0, Math.min(6, Number(params.weekday) || 0));

    if (params.frequency === 'daily') {
        const next = new Date(from);
        next.setHours(hh, mm, 0, 0);
        if (next.getTime() <= from.getTime()) {
            next.setDate(next.getDate() + 1);
        }
        return next;
    }

    // weekly
    const next = new Date(from);
    next.setHours(hh, mm, 0, 0);
    const cur = next.getDay();
    let add = (weekday - cur + 7) % 7;
    if (add === 0 && next.getTime() <= from.getTime()) add = 7;
    next.setDate(next.getDate() + add);
    return next;
}

function escapeHtml(s: string): string {
    return String(s || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function formatBytes(n: number): string {
    if (!n || n < 1024) return `${n || 0} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
    return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function table(headers: string[], rows: string[][]): string {
    const th = headers
        .map(
            (h) =>
                `<th style="text-align:left;padding:8px 10px;border-bottom:1px solid #e2e8f0;font-size:12px;color:#64748b;text-transform:uppercase;">${escapeHtml(h)}</th>`
        )
        .join('');
    const body = rows
        .map((r) => {
            const tds = r
                .map(
                    (c) =>
                        `<td style="padding:8px 10px;border-bottom:1px solid #f1f5f9;font-size:13px;color:#0f172a;">${c}</td>`
                )
                .join('');
            return `<tr>${tds}</tr>`;
        })
        .join('');
    return `<table style="width:100%;border-collapse:collapse;margin:12px 0 20px;">${th ? `<thead><tr>${th}</tr></thead>` : ''}<tbody>${body || `<tr><td colspan="${headers.length}" style="padding:12px;color:#64748b;">None</td></tr>`}</tbody></table>`;
}

function sectionTitle(title: string): string {
    return `<h2 style="margin:24px 0 8px;font-size:16px;color:#0f172a;">${escapeHtml(title)}</h2>`;
}

function normalizeSections(raw?: Partial<EmailReportSections> | null): EmailReportSections {
    return {
        ...DEFAULT_EMAIL_REPORT_SECTIONS,
        ...(raw || {}),
    };
}

export async function buildOrgSummaryHtml(
    organizationId: string,
    sectionsInput?: Partial<EmailReportSections> | null,
    latestFilesLimit = 10
): Promise<{ subject: string; html: string; stats: Record<string, unknown> }> {
    const sections = normalizeSections(sectionsInput);
    const limit = Math.max(1, Math.min(50, latestFilesLimit || 10));

    const docs = await Document.find({ organizationId }).lean();
    const now = Date.now();
    const dayAgo = now - 24 * 60 * 60 * 1000;
    const weekAgo = now - 7 * 24 * 60 * 60 * 1000;

    const total = docs.length;
    const byStatus: Record<string, number> = {};
    const byDeptId: Record<string, number> = {};
    const byUploaderId: Record<string, number> = {};
    let storageBytes = 0;
    let last24h = 0;
    let last7d = 0;

    for (const d of docs) {
        const st = String(d.status || 'unknown');
        byStatus[st] = (byStatus[st] || 0) + 1;
        const deptKey = d.departmentId || '_none';
        byDeptId[deptKey] = (byDeptId[deptKey] || 0) + 1;
        byUploaderId[d.uploadedBy] = (byUploaderId[d.uploadedBy] || 0) + 1;
        storageBytes += Number(d.sizeBytes || 0);
        const created = d.createdAt ? new Date(d.createdAt).getTime() : 0;
        if (created >= dayAgo) last24h += 1;
        if (created >= weekAgo) last7d += 1;
    }

    const userIds = [...new Set(docs.map((d) => d.uploadedBy).filter(Boolean))];
    const deptIds = [
        ...new Set(docs.map((d) => d.departmentId).filter(Boolean) as string[]),
    ];

    const [users, departments] = await Promise.all([
        userIds.length
            ? User.find({ userId: { $in: userIds } })
                  .select('userId fullName email username')
                  .lean()
            : Promise.resolve([]),
        deptIds.length
            ? Department.find({ departmentId: { $in: deptIds }, organizationId })
                  .select('departmentId name')
                  .lean()
            : Promise.resolve([]),
    ]);

    const userMap = new Map(
        users.map((u: any) => [
            u.userId,
            u.fullName || u.username || u.email || u.userId,
        ])
    );
    const deptMap = new Map(departments.map((d: any) => [d.departmentId, d.name]));

    const latest = [...docs]
        .sort(
            (a, b) =>
                new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime()
        )
        .slice(0, limit);

    const processed =
        (byStatus.ready || 0) + (byStatus.review || 0);
    const processing = (byStatus.processing || 0) + (byStatus.uploaded || 0);
    const failed = byStatus.failed || 0;

    const parts: string[] = [];
    parts.push(`
      <div style="font-family:Segoe UI,Arial,sans-serif;max-width:720px;margin:0 auto;background:#ffffff;color:#0f172a;">
        <div style="background:linear-gradient(135deg,#0d9488,#0891b2);color:#fff;padding:20px 24px;border-radius:12px 12px 0 0;">
          <h1 style="margin:0;font-size:20px;">Visibility Docs — System summary</h1>
          <p style="margin:6px 0 0;opacity:.9;font-size:13px;">Generated ${escapeHtml(new Date().toLocaleString())}</p>
        </div>
        <div style="padding:20px 24px;border:1px solid #e2e8f0;border-top:0;border-radius:0 0 12px 12px;">
    `);

    if (sections.overview) {
        parts.push(sectionTitle('Overview'));
        parts.push(
            table(
                ['Metric', 'Value'],
                [
                    ['Total files', String(total)],
                    ['Processed / ready', String(processed)],
                    ['Processing / uploaded', String(processing)],
                    ['Failed', String(failed)],
                    ['Uploaded last 24h', String(last24h)],
                    ['Uploaded last 7 days', String(last7d)],
                ].map(([a, b]) => [escapeHtml(a), escapeHtml(b)])
            )
        );
    }

    if (sections.byStatus) {
        parts.push(sectionTitle('By status'));
        parts.push(
            table(
                ['Status', 'Count'],
                Object.entries(byStatus)
                    .sort((a, b) => b[1] - a[1])
                    .map(([k, v]) => [escapeHtml(k), String(v)])
            )
        );
    }

    if (sections.byDepartment) {
        parts.push(sectionTitle('By department'));
        parts.push(
            table(
                ['Department', 'Files'],
                Object.entries(byDeptId)
                    .sort((a, b) => b[1] - a[1])
                    .map(([id, count]) => [
                        escapeHtml(
                            id === '_none' ? 'Unassigned / personal' : deptMap.get(id) || id
                        ),
                        String(count),
                    ])
            )
        );
    }

    if (sections.byUploader) {
        parts.push(sectionTitle('By team member'));
        parts.push(
            table(
                ['Member', 'Uploads'],
                Object.entries(byUploaderId)
                    .sort((a, b) => b[1] - a[1])
                    .map(([id, count]) => [
                        escapeHtml(String(userMap.get(id) || id)),
                        String(count),
                    ])
            )
        );
    }

    if (sections.latestFiles) {
        parts.push(sectionTitle(`Latest files (${latest.length})`));
        parts.push(
            table(
                ['File', 'Status', 'Uploaded by', 'Department', 'Created'],
                latest.map((d) => [
                    escapeHtml(d.originalFilename || d.documentId),
                    escapeHtml(String(d.status || '—')),
                    escapeHtml(String(userMap.get(d.uploadedBy) || d.uploadedBy || '—')),
                    escapeHtml(
                        d.departmentId
                            ? String(deptMap.get(d.departmentId) || d.departmentId)
                            : '—'
                    ),
                    escapeHtml(
                        d.createdAt ? new Date(d.createdAt).toLocaleString() : '—'
                    ),
                ])
            )
        );
    }

    if (sections.storage) {
        parts.push(sectionTitle('Storage'));
        parts.push(
            table(
                ['Metric', 'Value'],
                [
                    ['Total size', escapeHtml(formatBytes(storageBytes))],
                    ['Average file size', escapeHtml(formatBytes(total ? Math.round(storageBytes / total) : 0))],
                ]
            )
        );
    }

    parts.push(`
          <p style="margin-top:28px;font-size:12px;color:#94a3b8;">This report was sent by Visibility Docs AI Email reports.</p>
        </div>
      </div>
    `);

    const subject = `Visibility Docs summary — ${total} file(s) · ${new Date().toLocaleDateString()}`;
    return {
        subject,
        html: parts.join('\n'),
        stats: {
            total,
            processed,
            processing,
            failed,
            last24h,
            last7d,
            storageBytes,
        },
    };
}

export async function buildScheduledEmailReport(
    organizationId: string,
    doc: Pick<
        IEmailReportConfig,
        'reportType' | 'phase3Agent' | 'sections' | 'latestFilesLimit'
    >
): Promise<{ subject: string; html: string; stats?: Record<string, unknown> }> {
    const reportType: EmailReportType =
        doc.reportType === 'extraction' ? 'extraction' : 'library';

    if (reportType === 'extraction') {
        if (!isAiServiceEnabled()) {
            throw Object.assign(new Error('AI service is required for extraction reports'), {
                statusCode: 503,
            });
        }
        const { subject, html } = await generateExtractionReportHtml(
            organizationId,
            doc.phase3Agent || ''
        );
        return { subject, html };
    }

    const built = await buildOrgSummaryHtml(
        organizationId,
        doc.sections,
        doc.latestFilesLimit
    );
    return { subject: built.subject, html: built.html, stats: built.stats };
}

export function publicEmailReportConfig(doc: IEmailReportConfig | null, organizationId: string) {
    if (!doc) {
        return {
            organizationId,
            enabled: false,
            frequency: 'daily' as EmailReportFrequency,
            reportType: 'library' as EmailReportType,
            phase3Agent: '',
            weekday: 1,
            time: '09:00',
            recipients: [] as string[],
            sections: { ...DEFAULT_EMAIL_REPORT_SECTIONS },
            latestFilesLimit: 10,
            lastSentAt: null,
            nextSendAt: null,
            lastStatus: null,
            lastError: null,
            emailConfigured: isEmailConfigured(),
        };
    }
    return {
        organizationId: doc.organizationId,
        enabled: !!doc.enabled,
        frequency: doc.frequency || 'daily',
        reportType: doc.reportType === 'extraction' ? 'extraction' : 'library',
        phase3Agent: doc.phase3Agent || '',
        weekday: doc.weekday ?? 1,
        time: doc.time || '09:00',
        recipients: doc.recipients || [],
        sections: normalizeSections(doc.sections),
        latestFilesLimit: doc.latestFilesLimit || 10,
        lastSentAt: doc.lastSentAt || null,
        nextSendAt: doc.nextSendAt || null,
        lastStatus: doc.lastStatus || null,
        lastError: doc.lastError || null,
        emailConfigured: isEmailConfigured(),
    };
}

function normalizeRecipients(raw: unknown): string[] {
    const list = Array.isArray(raw)
        ? raw
        : String(raw || '')
              .split(/[\n,;]+/)
              .map((s) => s.trim());
    const emailRe = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    const out: string[] = [];
    const seen = new Set<string>();
    for (const item of list) {
        const e = String(item || '').trim().toLowerCase();
        if (!e || !emailRe.test(e) || seen.has(e)) continue;
        seen.add(e);
        out.push(e);
    }
    return out;
}

export async function getOrCreateEmailReportConfig(organizationId: string) {
    let doc = await EmailReportConfig.findOne({ organizationId });
    if (!doc) {
        doc = await EmailReportConfig.create({
            organizationId,
            enabled: false,
            frequency: 'daily',
            reportType: 'library',
            phase3Agent: '',
            weekday: 1,
            time: '09:00',
            recipients: [],
            sections: { ...DEFAULT_EMAIL_REPORT_SECTIONS },
            latestFilesLimit: 10,
        });
    }
    return doc;
}

export async function updateEmailReportConfig(
    organizationId: string,
    body: Record<string, unknown>
) {
    const doc = await getOrCreateEmailReportConfig(organizationId);

    if (body.enabled !== undefined) doc.enabled = !!body.enabled;
    if (body.frequency === 'daily' || body.frequency === 'weekly') {
        doc.frequency = body.frequency;
    }
    if (body.reportType === 'library' || body.reportType === 'extraction') {
        doc.reportType = body.reportType;
    }
    if (body.phase3Agent !== undefined) {
        doc.phase3Agent = String(body.phase3Agent || '').trim();
    }
    if (body.weekday !== undefined) {
        doc.weekday = Math.max(0, Math.min(6, Number(body.weekday)));
    }
    if (typeof body.time === 'string' && /^\d{1,2}:\d{2}$/.test(body.time.trim())) {
        const { hh, mm } = parseTime(body.time);
        doc.time = `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
    }
    if (body.recipients !== undefined) {
        doc.recipients = normalizeRecipients(body.recipients);
    }
    if (body.sections && typeof body.sections === 'object') {
        doc.sections = normalizeSections(body.sections as Partial<EmailReportSections>);
    }
    if (body.latestFilesLimit !== undefined) {
        doc.latestFilesLimit = Math.max(1, Math.min(50, Number(body.latestFilesLimit) || 10));
    }

    if (doc.enabled) {
        if (!doc.recipients.length) {
            throw Object.assign(
                new Error('Add at least one recipient email before enabling scheduled reports'),
                { statusCode: 400 }
            );
        }
        if (doc.reportType === 'extraction' && !isAiServiceEnabled()) {
            throw Object.assign(
                new Error('AI service must be running to schedule extraction reports'),
                { statusCode: 503 }
            );
        }
        doc.nextSendAt = computeNextEmailSendAt({
            frequency: doc.frequency,
            time: doc.time,
            weekday: doc.weekday,
        });
    } else {
        doc.nextSendAt = null;
    }

    doc.lastError = null;
    await doc.save();
    return doc;
}

export async function sendOrgEmailReportNow(organizationId: string, recipientsOverride?: string[]) {
    const doc = await getOrCreateEmailReportConfig(organizationId);
    const recipients = recipientsOverride?.length
        ? normalizeRecipients(recipientsOverride)
        : doc.recipients || [];
    if (!recipients.length) {
        throw Object.assign(new Error('No recipients configured'), { statusCode: 400 });
    }

    const { subject, html, stats } = await buildScheduledEmailReport(organizationId, doc);

    await sendHtmlEmail({ to: recipients, subject, html });

    doc.lastSentAt = new Date();
    doc.lastStatus = `sent_ok: ${recipients.length} recipient(s)`;
    doc.lastError = null;
    if (doc.enabled) {
        doc.nextSendAt = computeNextEmailSendAt({
            frequency: doc.frequency,
            time: doc.time,
            weekday: doc.weekday,
            from: new Date(),
        });
    }
    await doc.save();

    return { subject, recipients, stats, config: publicEmailReportConfig(doc, organizationId) };
}

export async function runDueEmailReports(): Promise<void> {
    const now = new Date();
    const due = await EmailReportConfig.find({
        enabled: true,
        nextSendAt: { $lte: now },
    }).limit(20);

    for (const doc of due) {
        try {
            if (!doc.recipients?.length) {
                doc.lastStatus = 'skipped_no_recipients';
                doc.lastError = 'No recipients';
                doc.nextSendAt = computeNextEmailSendAt({
                    frequency: doc.frequency,
                    time: doc.time,
                    weekday: doc.weekday,
                    from: now,
                });
                await doc.save();
                continue;
            }

            const { subject, html } = await buildScheduledEmailReport(doc.organizationId, doc);
            await sendHtmlEmail({ to: doc.recipients, subject, html });

            doc.lastSentAt = new Date();
            doc.lastStatus = `sent_ok: ${doc.recipients.length} recipient(s)`;
            doc.lastError = null;
            doc.nextSendAt = computeNextEmailSendAt({
                frequency: doc.frequency,
                time: doc.time,
                weekday: doc.weekday,
                from: new Date(),
            });
            await doc.save();
        } catch (e: any) {
            logger.warn(
                `[email-reports] Failed for org ${doc.organizationId}: ${e?.message || e}`
            );
            doc.lastStatus = 'send_failed';
            doc.lastError = String(e?.message || e).slice(0, 500);
            doc.nextSendAt = computeNextEmailSendAt({
                frequency: doc.frequency,
                time: doc.time,
                weekday: doc.weekday,
                from: new Date(),
            });
            await doc.save();
        }
    }
}
