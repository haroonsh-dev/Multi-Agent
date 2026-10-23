/**
 * HR candidate outreach — list scored CVs with emails and send templated messages.
 */
import Document from '../models/Document';
import { AuthUser, buildDocumentFilter } from './accessScope';
import { getDocumentExtractions, getOfferLetterPrefill, resolveAiOrganizationId } from './aiServiceClient';
import { isResumeLike, listTopResumesForUser, resolveCvScoreForResume } from './hrChatActionService';
import { sendHtmlEmail, isEmailConfigured } from './emailService';
import { requireAllowedAgent } from './planService';
import { HR_AGENT } from './offerLetterGenerationService';
import { recordActivityFromReq } from './activityLog';
import type { Request } from 'express';

export type OutreachTemplateId =
    | 'interview_invite'
    | 'screening_next_steps'
    | 'rejection'
    | 'custom';

export type CandidateOutreachRow = {
    documentId: string;
    filename: string;
    candidateName: string;
    email: string | null;
    cvScore: number;
    title: string;
    lastOutreachAt?: string | null;
    lastOutreachTemplate?: string | null;
};

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/i;

const HR_LETTER_FILENAME =
    /\b(joining|offer|experience|promotion|relieving|internship|warning)\b.*\bletter\b|\bletter\b.*\b(joining|offer|experience|promotion|relieving|internship|warning)\b/i;

export function isOutreachEligibleResume(row: {
    originalFilename: string;
    cvScore: number;
    classification?: string | null;
}): boolean {
    if (!Number.isFinite(row.cvScore) || row.cvScore <= 0) return false;
    if (HR_LETTER_FILENAME.test(row.originalFilename || '')) return false;
    const c = String(row.classification || '').toLowerCase();
    if (c && c !== 'resume' && c !== 'cv' && c !== 'unclassified' && c !== 'other') {
        if (/\bletter\b/.test(c) || c.includes('joining') || c.includes('offer')) return false;
    }
    return true;
}

function unwrapEmail(raw: unknown): string | null {
    if (raw == null) return null;
    const s = String(raw).trim();
    return EMAIL_RE.test(s) ? s : null;
}

async function resolveCandidateEmail(
    user: AuthUser,
    row: { documentId: string; pythonDocumentId?: string | null; originalFilename: string }
): Promise<string | null> {
    const doc = await Document.findOne({ documentId: row.documentId })
        .select('metadata pythonDocumentId originalFilename')
        .lean();
    const meta = doc?.metadata as { candidateEmail?: string; outreachEmail?: string } | null;
    const fromMeta = unwrapEmail(meta?.candidateEmail || meta?.outreachEmail);
    if (fromMeta) return fromMeta;

    const pythonId = row.pythonDocumentId || doc?.pythonDocumentId;
    if (!pythonId) return null;

    const orgId = resolveAiOrganizationId(user);
    try {
        const pre = await getOfferLetterPrefill(pythonId, orgId);
        const fromPrefill = unwrapEmail(pre?.prefill?.email);
        if (fromPrefill) return fromPrefill;
    } catch {
        /* optional */
    }

    try {
        const extractions = await getDocumentExtractions(pythonId, orgId);
        for (const ext of extractions || []) {
            const data = (ext.extracted_data || {}) as Record<string, unknown>;
            const found =
                unwrapEmail(data.email) ||
                unwrapEmail(data.candidate_email) ||
                unwrapEmail(data.contact_email);
            if (found) return found;
        }
    } catch {
        /* optional */
    }

    return null;
}

async function resolveCandidateTitle(
    user: AuthUser,
    row: { pythonDocumentId?: string | null }
): Promise<string> {
    if (!row.pythonDocumentId) return '';
    try {
        const pre = await getOfferLetterPrefill(row.pythonDocumentId, resolveAiOrganizationId(user));
        return String(pre?.prefill?.job_title || '').trim();
    } catch {
        return '';
    }
}

function candidateNameFromRow(row: { originalFilename: string }, prefillName?: string): string {
    if (prefillName?.trim()) return prefillName.trim();
    return row.originalFilename
        .replace(/\.(pdf|png|jpg|jpeg|webp|docx?)$/i, '')
        .replace(/[_-]+/g, ' ')
        .trim();
}

export async function saveCandidateEmailOverride(
    user: AuthUser,
    documentId: string,
    email: string
): Promise<{ documentId: string; email: string }> {
    const normalized = unwrapEmail(email);
    if (!normalized) {
        throw Object.assign(new Error('Enter a valid email address'), { statusCode: 400 });
    }

    const check = await requireAllowedAgent(user, HR_AGENT);
    if (!check.ok) {
        throw Object.assign(new Error(check.message || 'HR agent not available'), { statusCode: 403 });
    }

    const doc = await Document.findOne({ documentId }).select('documentId classification originalFilename metadata').lean();
    if (!doc) {
        throw Object.assign(new Error('Document not found'), { statusCode: 404 });
    }

    await Document.updateOne(
        { documentId },
        { $set: { 'metadata.candidateEmail': normalized, 'metadata.outreachEmail': normalized } }
    );

    return { documentId, email: normalized };
}

export async function previewOutreachEmail(
    user: AuthUser,
    params: {
        documentId: string;
        template: OutreachTemplateId;
        senderName?: string;
        companyName?: string;
        interviewDetails?: string;
        emailOverride?: string;
    }
): Promise<{ subject: string; html: string; candidateName: string; email: string | null; cvScore: number }> {
    const rows = await listCandidatesForOutreach(user, { documentIds: [params.documentId], limit: 1 });
    const row = rows[0];
    if (!row) {
        throw Object.assign(new Error('Candidate not found in HR shortlist'), { statusCode: 404 });
    }

    const email = unwrapEmail(params.emailOverride) || row.email;
    const { subject, html } = buildOutreachEmail({
        template: params.template,
        candidateName: row.candidateName,
        cvScore: row.cvScore,
        companyName: params.companyName,
        senderName: params.senderName,
        interviewDetails: params.interviewDetails,
    });

    return { subject, html, candidateName: row.candidateName, email, cvScore: row.cvScore };
}

export async function listCandidatesForOutreach(
    user: AuthUser,
    opts?: { documentIds?: string[]; limit?: number; minScore?: number; includeUnscored?: boolean }
): Promise<CandidateOutreachRow[]> {
    const limit = Math.min(100, Math.max(1, opts?.limit ?? 50));
    const pool = await listTopResumesForUser(user, Math.max(limit, 50), opts?.documentIds);
    const minScore = opts?.minScore ?? 0;

    const rows: CandidateOutreachRow[] = [];
    for (const row of pool) {
        const doc = await Document.findOne({ documentId: row.documentId })
            .select('metadata pythonDocumentId classification originalFilename')
            .lean();
        if (
            !opts?.includeUnscored &&
            !isOutreachEligibleResume({
                originalFilename: row.originalFilename,
                cvScore: row.cvScore,
                classification: doc?.classification,
            })
        ) {
            continue;
        }
        if (minScore > 0 && (!Number.isFinite(row.cvScore) || row.cvScore < minScore)) continue;
        const meta = doc?.metadata as {
            cvScore?: number;
            lastOutreach?: { at?: string; template?: string };
        } | null;

        let candidateName = '';
        if (row.pythonDocumentId) {
            try {
                const pre = await getOfferLetterPrefill(row.pythonDocumentId, resolveAiOrganizationId(user));
                candidateName = pre?.prefill?.candidate_name?.trim() || '';
            } catch {
                /* ignore */
            }
        }
        candidateName = candidateNameFromRow(row, candidateName);
        const email = await resolveCandidateEmail(user, {
            documentId: row.documentId,
            pythonDocumentId: row.pythonDocumentId,
            originalFilename: row.originalFilename,
        });
        const title = await resolveCandidateTitle(user, row);

        rows.push({
            documentId: row.documentId,
            filename: row.originalFilename,
            candidateName,
            email,
            cvScore: Number.isFinite(row.cvScore) ? row.cvScore : NaN,
            title: title || 'Candidate',
            lastOutreachAt: meta?.lastOutreach?.at ?? null,
            lastOutreachTemplate: meta?.lastOutreach?.template ?? null,
        });
        if (rows.length >= limit) break;
    }
    return rows;
}

export function buildOutreachEmail(params: {
    template: OutreachTemplateId;
    candidateName: string;
    cvScore?: number;
    companyName?: string;
    senderName?: string;
    interviewDetails?: string;
    customSubject?: string;
    customBodyHtml?: string;
}): { subject: string; html: string } {
    const name = params.candidateName || 'Candidate';
    const company = params.companyName || 'Our company';
    const sender = params.senderName || 'HR Team';
    const scoreLine =
        params.cvScore != null && Number.isFinite(params.cvScore)
            ? `<p>Your application was reviewed (CV score: <strong>${Math.round(params.cvScore)}/100</strong>).</p>`
            : '';

    if (params.template === 'custom' && params.customSubject && params.customBodyHtml) {
        const html = params.customBodyHtml
            .replace(/\{\{name\}\}/gi, name)
            .replace(/\{\{candidate\}\}/gi, name)
            .replace(/\{\{company\}\}/gi, company)
            .replace(/\{\{score\}\}/gi, params.cvScore != null ? String(Math.round(params.cvScore)) : '—');
        return { subject: params.customSubject, html };
    }

    if (params.template === 'rejection') {
        return {
            subject: `Update on your application — ${company}`,
            html: `
<p>Dear ${name},</p>
${scoreLine}
<p>Thank you for your interest in ${company} and for the time you invested in your application.</p>
<p>After careful review, we will not be moving forward with your candidacy at this time. We encourage you to apply again when a suitable role opens.</p>
<p>Wishing you success in your job search.</p>
<p>Best regards,<br/>${sender}<br/>${company}</p>`,
        };
    }

    if (params.template === 'screening_next_steps') {
        return {
            subject: `Next steps — ${company} recruitment`,
            html: `
<p>Dear ${name},</p>
${scoreLine}
<p>Thank you for applying to ${company}. Your profile has passed our initial screening.</p>
<p>Our recruiting team will contact you shortly with the next steps in the process.</p>
<p>Best regards,<br/>${sender}<br/>${company}</p>`,
        };
    }

    const details =
        params.interviewDetails?.trim() ||
        'We would like to invite you to an interview. Please reply to this email with your availability for next week.';

    return {
        subject: `Interview invitation — ${company}`,
        html: `
<p>Dear ${name},</p>
${scoreLine}
<p>Thank you for your application to ${company}. We were impressed with your profile and would like to move forward.</p>
<p>${details}</p>
<p>Best regards,<br/>${sender}<br/>${company}</p>`,
    };
}

export function detectHrCandidateEmail(question: string, phase3Agent?: string): boolean {
    if (phase3Agent && phase3Agent !== HR_AGENT) return false;
    const q = question.toLowerCase().trim();
    if (!q) return false;
    const wantsSend =
        /\b(send|email|mail|notify|message|contact)\b/.test(q) &&
        (/\b(candidate|candidates|cv|resume|shortlist|applicant|them|selected)\b/.test(q) ||
            /\b(top\s+\d+|interview\s+invite|invitation)\b/.test(q));
    return wantsSend;
}

function parseTopN(question: string, defaultN = 5): number {
    const m = question.match(/\btop\s+(\d+)\b/i) || question.match(/\b(\d+)\s+candidates?\b/i);
    if (m) return Math.min(50, Math.max(1, parseInt(m[1], 10) || defaultN));
    return defaultN;
}

function parseTemplate(question: string): OutreachTemplateId {
    const q = question.toLowerCase();
    if (/\b(reject|decline|not\s+moving\s+forward|unsuccessful)\b/.test(q)) return 'rejection';
    if (/\b(screening|next\s+steps|passed|shortlist)\b/.test(q) && !/\binterview\b/.test(q)) {
        return 'screening_next_steps';
    }
    return 'interview_invite';
}

export async function sendCandidateOutreachEmails(
    user: AuthUser,
    params: {
        documentIds: string[];
        template: OutreachTemplateId;
        subject?: string;
        bodyHtml?: string;
        senderName?: string;
        companyName?: string;
        interviewDetails?: string;
        emailOverrides?: Record<string, string>;
    },
    req?: Request
): Promise<{
    sent: Array<{ documentId: string; candidateName: string; email: string }>;
    skipped: Array<{ documentId: string; candidateName: string; reason: string }>;
    failed: Array<{ documentId: string; candidateName: string; error: string }>;
}> {
    if (!isEmailConfigured()) {
        throw Object.assign(
            new Error(
                'Email is not configured. Set EMAIL_USERNAME and EMAIL_PASSWORD on the api-gateway (.env).'
            ),
            { statusCode: 400 }
        );
    }

    const check = await requireAllowedAgent(user, HR_AGENT);
    if (!check.ok) {
        throw Object.assign(new Error(check.message || 'HR agent not available'), { statusCode: 403 });
    }

    const uniqueIds = [...new Set(params.documentIds.map((id) => String(id).trim()).filter(Boolean))];
    if (!uniqueIds.length) {
        throw Object.assign(new Error('Select at least one candidate'), { statusCode: 400 });
    }

    const candidates = await listCandidatesForOutreach(user, { documentIds: uniqueIds, limit: uniqueIds.length });
    const sent: Array<{ documentId: string; candidateName: string; email: string }> = [];
    const skipped: Array<{ documentId: string; candidateName: string; reason: string }> = [];
    const failed: Array<{ documentId: string; candidateName: string; error: string }> = [];

    for (const id of uniqueIds) {
        const row = candidates.find((c) => c.documentId === id);
        if (!row) {
            skipped.push({ documentId: id, candidateName: id, reason: 'Not found in HR scope' });
            continue;
        }
        const overrideEmail = params.emailOverrides?.[row.documentId];
        const resolvedEmail = unwrapEmail(overrideEmail) || row.email;
        if (!resolvedEmail) {
            skipped.push({
                documentId: row.documentId,
                candidateName: row.candidateName,
                reason: 'No email on CV — add one in the outreach panel or reprocess the resume',
            });
            continue;
        }

        if (overrideEmail && unwrapEmail(overrideEmail)) {
            await Document.updateOne(
                { documentId: row.documentId },
                { $set: { 'metadata.candidateEmail': resolvedEmail, 'metadata.outreachEmail': resolvedEmail } }
            );
        }

        const { subject, html } = buildOutreachEmail({
            template: params.template,
            candidateName: row.candidateName,
            cvScore: row.cvScore,
            companyName: params.companyName,
            senderName: params.senderName,
            interviewDetails: params.interviewDetails,
            customSubject: params.subject,
            customBodyHtml: params.bodyHtml,
        });

        try {
            await sendHtmlEmail({ to: resolvedEmail, subject, html });
            const now = new Date().toISOString();
            await Document.updateOne(
                { documentId: row.documentId },
                {
                    $set: {
                        'metadata.candidateEmail': resolvedEmail,
                        'metadata.lastOutreach': {
                            at: now,
                            template: params.template,
                            subject,
                        },
                    },
                }
            );
            sent.push({ documentId: row.documentId, candidateName: row.candidateName, email: resolvedEmail });
        } catch (e: unknown) {
            failed.push({
                documentId: row.documentId,
                candidateName: row.candidateName,
                error: e instanceof Error ? e.message : 'Send failed',
            });
        }
    }

    if (req) {
        recordActivityFromReq(req, {
            action: 'hr.candidate_email',
            category: 'chat',
            message: `Sent ${sent.length} candidate email(s) (${params.template})`,
            metadata: {
                phase3Agent: HR_AGENT,
                template: params.template,
                sent: sent.length,
                skipped: skipped.length,
                failed: failed.length,
            },
        });
    }

    return { sent, skipped, failed };
}

export async function tryHrCandidateEmailCommand(params: {
    user: AuthUser;
    question: string;
    phase3Agent?: string;
    documentIds?: string[];
    req?: Request;
}): Promise<{ handled: boolean; answer?: string }> {
    if (!detectHrCandidateEmail(params.question, params.phase3Agent)) {
        return { handled: false };
    }

    const template = parseTemplate(params.question);
    const topN = parseTopN(params.question, 5);
    let ids = params.documentIds?.length ? params.documentIds : undefined;

    if (!ids?.length) {
        const pool = await listCandidatesForOutreach(params.user, { limit: topN });
        ids = pool.slice(0, topN).map((c) => c.documentId);
    }

    if (!ids.length) {
        return {
            handled: true,
            answer: 'No CVs in scope to email. Upload resumes and wait until they are scored, then try again.',
        };
    }

    const result = await sendCandidateOutreachEmails(
        params.user,
        {
            documentIds: ids,
            template,
            companyName: 'Visibility Bots',
            senderName: 'HR Team',
        },
        params.req
    );

    const lines = [
        `**Candidate email run** (${template.replace(/_/g, ' ')})`,
        '',
        `✅ Sent: **${result.sent.length}**`,
    ];
    for (const s of result.sent.slice(0, 8)) {
        lines.push(`- ${s.candidateName} → ${s.email}`);
    }
    if (result.skipped.length) {
        lines.push('', `⚠️ Skipped: **${result.skipped.length}**`);
        for (const s of result.skipped.slice(0, 5)) {
            lines.push(`- ${s.candidateName}: ${s.reason}`);
        }
    }
    if (result.failed.length) {
        lines.push('', `❌ Failed: **${result.failed.length}**`);
        for (const f of result.failed.slice(0, 3)) {
            lines.push(`- ${f.candidateName}: ${f.error}`);
        }
    }
    if (!result.sent.length && !isEmailConfigured()) {
        lines.push('', '_Configure EMAIL_USERNAME and EMAIL_PASSWORD on the server to enable sending._');
    }

    return { handled: true, answer: lines.join('\n') };
}

export type HrShortlistRow = {
    rank: number;
    documentId: string;
    candidateName: string;
    filename: string;
    cvScore: number;
    email: string | null;
    pipelineStatus: string;
    agentAction: string;
    scoreSource: 'ai' | 'hr_approved';
};

export type HrPendingShortlistRow = {
    documentId: string;
    candidateName: string;
    filename: string;
};

function shortlistLabels(score: number): { pipelineStatus: string; agentAction: string } {
    if (score >= 80) return { pipelineStatus: 'Shortlisted', agentAction: 'Shortlist' };
    if (score >= 60) return { pipelineStatus: 'Under review', agentAction: 'Review CV' };
    return { pipelineStatus: 'Low match', agentAction: 'Archive' };
}

const MANUAL_SHORTLIST_SCORE = 80;

/** HR approves pending CV(s) into the ranked shortlist (uses AI score when available). */
export async function approveCandidatesToShortlist(
    user: AuthUser,
    documentIds: string[],
    req?: Request
): Promise<{ approved: Array<{ documentId: string; candidateName: string; cvScore: number }> }> {
    const check = await requireAllowedAgent(user, HR_AGENT);
    if (!check.ok) {
        throw Object.assign(new Error(check.message || 'HR agent not available'), { statusCode: 403 });
    }

    const ids = [...new Set(documentIds.map((id) => String(id || '').trim()).filter(Boolean))];
    if (!ids.length) {
        throw Object.assign(new Error('documentIds required'), { statusCode: 400 });
    }

    const filter = await buildDocumentFilter(user, {});
    const approved: Array<{ documentId: string; candidateName: string; cvScore: number }> = [];

    for (const documentId of ids) {
        const doc = await Document.findOne({ ...filter, documentId })
            .select('documentId originalFilename classification metadata pythonDocumentId')
            .lean();
        if (!doc || !isResumeLike(doc)) continue;

        const meta = (doc.metadata || {}) as {
            shortlistApproved?: boolean;
            cvScore?: number;
            pipelineStatus?: string;
        };

        if (meta.shortlistApproved) {
            const existingScore =
                Number.isFinite(Number(meta.cvScore)) && Number(meta.cvScore) > 0
                    ? Number(meta.cvScore)
                    : MANUAL_SHORTLIST_SCORE;
            approved.push({
                documentId,
                candidateName: candidateNameFromRow({ originalFilename: doc.originalFilename }),
                cvScore: existingScore,
            });
            continue;
        }

        let score = await resolveCvScoreForResume(user, doc);
        const scoreSource: 'ai' | 'hr_approved' =
            Number.isFinite(score) && score > 0 ? 'ai' : 'hr_approved';
        if (!Number.isFinite(score) || score <= 0) {
            score = MANUAL_SHORTLIST_SCORE;
        }

        await Document.updateOne(
            { documentId },
            {
                $set: {
                    'metadata.cvScore': score,
                    'metadata.shortlistApproved': true,
                    'metadata.pipelineStatus': 'Shortlisted',
                    'metadata.shortlistApprovedAt': new Date().toISOString(),
                    'metadata.scoreSource': scoreSource,
                },
            }
        );

        approved.push({
            documentId,
            candidateName: candidateNameFromRow({ originalFilename: doc.originalFilename }),
            cvScore: score,
        });
    }

    if (!approved.length) {
        throw Object.assign(new Error('No valid CV documents found in your portfolio'), { statusCode: 404 });
    }

    if (req) {
        recordActivityFromReq(req, {
            action: 'hr.shortlist.approve',
            category: 'chat',
            message: `Shortlisted ${approved.length} candidate CV(s)`,
            metadata: {
                phase3Agent: HR_AGENT,
                documentIds: approved.map((a) => a.documentId),
                candidates: approved.map((a) => a.candidateName),
            },
        });
    }

    return { approved };
}

/** Stable ranked CV shortlist — backed by resume documents + CV scores, not chart heuristics. */
export async function listHrCandidateShortlist(
    user: AuthUser,
    opts?: { limit?: number; documentIds?: string[] }
): Promise<{
    rows: HrShortlistRow[];
    pendingRows: HrPendingShortlistRow[];
    totalScored: number;
    totalResumes: number;
    pendingDocumentIds: string[];
}> {
    const limit = Math.min(100, Math.max(1, opts?.limit ?? 25));
    const pool = await listTopResumesForUser(user, Math.max(limit, 50), opts?.documentIds);

    const filter = await buildDocumentFilter(user, {});
    const approvedQuery: Record<string, unknown> = {
        ...filter,
        'metadata.shortlistApproved': true,
    };
    if (opts?.documentIds?.length) {
        approvedQuery.documentId = { $in: opts.documentIds };
    }
    const approvedDocs = await Document.find(approvedQuery)
        .select('documentId originalFilename classification metadata pythonDocumentId')
        .limit(100)
        .lean();

    const poolById = new Map(
        pool.map((r) => [
            r.documentId,
            {
                documentId: r.documentId,
                originalFilename: r.originalFilename,
                cvScore: r.cvScore,
                pythonDocumentId: r.pythonDocumentId,
            },
        ])
    );

    for (const doc of approvedDocs) {
        if (poolById.has(doc.documentId)) continue;
        const metaScore = Number((doc.metadata as { cvScore?: number } | null)?.cvScore);
        poolById.set(doc.documentId, {
            documentId: doc.documentId,
            originalFilename: doc.originalFilename,
            cvScore: Number.isFinite(metaScore) && metaScore > 0 ? metaScore : MANUAL_SHORTLIST_SCORE,
            pythonDocumentId: doc.pythonDocumentId,
        });
    }

    const mergedPool = [...poolById.values()].sort((a, b) => {
        const sa = Number.isFinite(a.cvScore) ? a.cvScore : -1;
        const sb = Number.isFinite(b.cvScore) ? b.cvScore : -1;
        return sb - sa;
    });

    const allDocIds = mergedPool.map((r) => r.documentId);
    const docs = allDocIds.length
        ? await Document.find({ documentId: { $in: allDocIds } })
              .select('documentId originalFilename metadata')
              .lean()
        : [];
    const docById = new Map(docs.map((d) => [d.documentId, d]));

    const pendingDocumentIds = mergedPool
        .filter((row) => {
            const meta = docById.get(row.documentId)?.metadata as {
                shortlistApproved?: boolean;
            } | null;
            if (meta?.shortlistApproved) return false;
            return !Number.isFinite(row.cvScore) || row.cvScore <= 0;
        })
        .map((row) => row.documentId);

    const pendingRows: HrPendingShortlistRow[] = pendingDocumentIds.map((documentId) => {
        const doc = docById.get(documentId);
        const row = mergedPool.find((r) => r.documentId === documentId);
        const filename = doc?.originalFilename || row?.originalFilename || '';
        return {
            documentId,
            candidateName: candidateNameFromRow({ originalFilename: filename }),
            filename,
        };
    });

    const scoredPool = mergedPool.filter((r) => Number.isFinite(r.cvScore) && r.cvScore > 0);
    const top = scoredPool.slice(0, limit);

    const rows: HrShortlistRow[] = top.map((row, i) => {
        const doc = docById.get(row.documentId);
        const meta = doc?.metadata as {
            candidateEmail?: string;
            outreachEmail?: string;
            shortlistApproved?: boolean;
            pipelineStatus?: string;
            scoreSource?: 'ai' | 'hr_approved';
        } | null;
        const emailRaw = meta?.candidateEmail || meta?.outreachEmail;
        const email = typeof emailRaw === 'string' && emailRaw.trim() ? emailRaw.trim() : null;
        const labels = meta?.shortlistApproved
            ? { pipelineStatus: meta.pipelineStatus || 'Shortlisted', agentAction: 'Shortlist' }
            : shortlistLabels(row.cvScore);
        const scoreSource: 'ai' | 'hr_approved' =
            meta?.scoreSource === 'hr_approved' ||
            (meta?.shortlistApproved && row.cvScore === MANUAL_SHORTLIST_SCORE && meta?.scoreSource !== 'ai')
                ? 'hr_approved'
                : 'ai';
        return {
            rank: i + 1,
            documentId: row.documentId,
            candidateName: candidateNameFromRow({
                originalFilename: doc?.originalFilename || row.originalFilename,
            }),
            filename: row.originalFilename,
            cvScore: row.cvScore,
            email,
            scoreSource,
            ...labels,
        };
    });

    return {
        rows,
        pendingRows,
        totalScored: scoredPool.length,
        totalResumes: mergedPool.length,
        pendingDocumentIds,
    };
}
