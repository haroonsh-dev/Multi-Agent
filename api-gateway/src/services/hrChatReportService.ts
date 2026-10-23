/**
 * HR chat actions: report PDF, shortlist export, promotion/warning/relieving letters.
 */
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import Document from '../models/Document';
import { AuthUser } from './accessScope';
import {
    HR_AGENT,
    loadHrSnapshotBundle,
    formatEmployeeDirectory,
    formatCertExpiryList,
    formatOnboardingList,
    type HrSnapshotBundle,
} from './hrAnalyticsService';
import { listTopResumesForUser } from './hrChatActionService';
import {
    applyDocumentTypeStorage,
    ensureUploadDir,
    getDocumentDir,
    resolveOrgFolder,
} from './documentStorage';
import { sanitizeFilename } from '../utils/fileValidation';
import { requireAllowedAgent } from './planService';
import logger from '../utils/logger';
import { generateComplianceReportPdf } from './aiServiceClient';

export type HrReportCitation = {
    documentId: string;
    filename?: string;
    score?: number;
    documentType?: string;
    phase3Agent?: string;
};

export type HrReportActionResult = {
    handled: boolean;
    answer?: string;
    citations?: HrReportCitation[];
};

function pdfPreviewPath(documentId: string): string {
    return `/documents/${documentId}`;
}

/** Chat link: "Joining letter — Sharjeel Ahmed" — uses the generated letter type + person. */
function letterDocLink(kindLabel: string, personName: string, documentId: string): string {
    const name = personName.replace(/\s+/g, ' ').trim() || 'Candidate';
    const kind = kindLabel.replace(/\s+/g, ' ').trim();
    return `[${kind} — ${name}](${pdfPreviewPath(documentId)})`;
}

function escapeHtml(value: string): string {
    return value
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

export function detectHrReportCommand(question: string, phase3Agent?: string): boolean {
    if (phase3Agent !== HR_AGENT) return false;
    const q = question.toLowerCase().trim();
    if (!q) return false;
    const wantsGenerate =
        /\b(generate|create|make|draft|export|download|prepare|build)\b/.test(q) ||
        /\b(give\s+me|get\s+me)\b/.test(q);
    const wantsReport =
        /\bhr\s+report\b/.test(q) ||
        /\bhuman\s+resources\s+report\b/.test(q) ||
        (/\breport\b/.test(q) &&
            !/\b(finance|compliance|expense|offer|experience|extraction|email|shortlist)\s+report\b/.test(q));
    return wantsGenerate && wantsReport;
}

export function detectHrShortlistExport(question: string, phase3Agent?: string): boolean {
    if (phase3Agent !== HR_AGENT) return false;
    const q = question.toLowerCase().trim();
    const wantsExport =
        /\b(export|download|generate|create|make|prepare)\b/.test(q) ||
        /\b(give\s+me|get\s+me)\b/.test(q);
    return wantsExport && /\bshortlist\b/.test(q);
}

export type HrLetterKind =
    | 'promotion'
    | 'warning'
    | 'relieving'
    | 'joining'
    | 'internship'
    | 'training_certificate';

export function detectHrExtraLetter(question: string, phase3Agent?: string): HrLetterKind | null {
    if (phase3Agent !== HR_AGENT && !/\bhr\s+agent\b/i.test(question)) return null;
    const q = question.toLowerCase();
    const wantsLetter =
        /\b(generate|create|make|draft|write|prepare|need|send|give|hire)\b/.test(q) ||
        (phase3Agent === HR_AGENT &&
            (/\bfor\b/.test(q) || /\bof\b/.test(q) || /\bletter\b/.test(q) || /\bcertificate\b/.test(q)));
    if (!wantsLetter && !/\b(joining|internship|training)\s+(letter|certificate)\b/.test(q)) {
        return null;
    }

    // Hiring / onboarding letters first (before generic leave/analytics confusion)
    if (
        /\bjoining\s+letter\b/.test(q) ||
        /\bappointment\s+letter\b/.test(q) ||
        (/\bjoin(?:ing)?\b/.test(q) && /\bletter\b/.test(q)) ||
        (/\bhire\b/.test(q) &&
            /\bletter\b/.test(q) &&
            !/\b(offer|experience|promotion|warning|relieving|internship)\b/.test(q))
    ) {
        return 'joining';
    }
    if (
        /\binternship\s+letter\b/.test(q) ||
        /\bintern\s+offer\b/.test(q) ||
        (/\bintern(?:ship)?\b/.test(q) && /\bletter\b/.test(q))
    ) {
        return 'internship';
    }
    if (
        /\btraining\s+certificate\b/.test(q) ||
        /\bcompletion\s+certificate\b/.test(q) ||
        (/\bcertificate\b/.test(q) &&
            /\b(train|course|program)\b/.test(q) &&
            /\b(generate|create|make|draft|issue)\b/.test(q) &&
            !/\bexpir/.test(q))
    ) {
        return 'training_certificate';
    }

    // Hiring without explicit "letter" still counts as joining when HR agent + hire phrasing
    if (
        phase3Agent === HR_AGENT &&
        /\b(hire|hiring|appoint|onboard)\b/.test(q) &&
        /\b(for|of)\b/.test(q) &&
        !/\b(leave|payroll|attendance|offer|experience)\b/.test(q)
    ) {
        return 'joining';
    }

    if (/\bpromotion\s+letter\b/.test(q) || (/\bpromot(?:e|ion)\b/.test(q) && /\bletter\b/.test(q))) {
        return 'promotion';
    }
    if (/\bwarning\s+letter\b/.test(q) || /\bshow\s+cause\b/.test(q) || (/\bwarning\b/.test(q) && /\bletter\b/.test(q))) {
        return 'warning';
    }
    if (/\brelieving\s+letter\b/.test(q) && !/\bexperience\s+letter\b/.test(q)) return 'relieving';
    return null;
}

export function detectHrDirectoryCommand(question: string, phase3Agent?: string): boolean {
    if (phase3Agent !== HR_AGENT && !/\bhr\b/i.test(question)) return false;
    const q = question.toLowerCase();
    return /\b(employee\s+directory|staff\s+directory|employee\s+roster|list\s+employees|show\s+(me\s+)?employees)\b/.test(
        q
    );
}

function parseTopLimit(question: string, defaultLimit = 10): number {
    const m = question.toLowerCase().match(/top\s+(\d{1,2})/);
    if (m) return Math.max(1, Math.min(25, Number(m[1])));
    return defaultLimit;
}

function parsePersonName(question: string): string | null {
    const patterns = [
        /(?:joining|internship|appointment|promotion|warning|relieving|experience|offer|training)\s+(?:letter|certificate)\s+(?:for|of)\s+([^,\n.]+)/i,
        /(?:letter|certificate)\s+(?:for|of)\s+([^,\n.]+)/i,
        /\b(?:for|of)\s+([A-Za-z][A-Za-z\s.'-]{1,60}?)(?:\s*[,.]|\s+company\b|\s+title\b|\s+new\s+title\b|\s+so\b|\s+i\s+want\b|$)/i,
        /\bhire\s+([A-Za-z][A-Za-z\s.'-]{1,40}?)(?:\s*[,.]|\s+so\b|\s+and\b|$)/i,
    ];
    for (const re of patterns) {
        const m = question.match(re);
        const raw = m?.[1]?.trim();
        if (raw && raw.length >= 2 && !/^top\s*\d*$/i.test(raw)) {
            const cleaned = raw
                .replace(
                    /\b(company|title|new title|reason|effective|joining|salary|so|i want|to hire)\b.*$/i,
                    ''
                )
                .trim();
            if (cleaned.length >= 2) return cleaned;
        }
    }
    return null;
}

function parseField(question: string, keys: string[]): string {
    for (const key of keys) {
        const re = new RegExp(`${key}\\s*[:\\s]+([^,\\n]+)`, 'i');
        const m = question.match(re);
        if (m?.[1]) return m[1].trim();
    }
    return '';
}

function tableRowsOrEmpty(rowsHtml: string, colspan: number, empty: string): string {
    return rowsHtml || `<tr><td colspan="${colspan}" style="padding:10px;color:#94a3b8;">${empty}</td></tr>`;
}

function buildHrReportHtml(params: {
    bundle: HrSnapshotBundle;
    resumes: Array<{ originalFilename: string; cvScore: number; documentId?: string }>;
}): { subject: string; html: string } {
    const { bundle, resumes } = params;
    const generatedAt = new Date();
    const dateLabel = generatedAt.toISOString().slice(0, 10);
    const subject = `HR workforce analysis report — ${dateLabel}`;

    const expired = bundle.certs.filter((c) => c.status === 'EXPIRED').length;
    const soon = bundle.certs.filter((c) => c.status === 'EXPIRING_SOON').length;
    const soon90 = bundle.certs.filter(
        (c) => c.daysUntilExpiry != null && c.daysUntilExpiry > 30 && c.daysUntilExpiry <= 90
    ).length;
    const incomplete = bundle.onboarding.filter((o) => o.status !== 'COMPLETE').length;
    const scored = resumes.filter((r) => Number.isFinite(r.cvScore));
    const pendingScores = resumes.filter((r) => !Number.isFinite(r.cvScore)).length;
    const leaveDays = bundle.leave.reduce((s, r) => s + (r.totalDays || 0), 0);
    const pendingLeave = bundle.leave.filter((r) => /pending/i.test(r.approvalStatus)).length;
    const payrollTotal = bundle.payroll.reduce((s, r) => s + (r.netSalary || 0), 0);
    const payrollCur = bundle.payroll[0]?.currency || 'USD';
    const avgAttendance =
        bundle.attendance.length > 0
            ? Math.round(
                  (bundle.attendance.reduce((s, r) => s + r.presentPct, 0) / bundle.attendance.length) * 10
              ) / 10
            : null;
    const promoRecs = bundle.performance.filter((p) => p.promotionRecommended === true).length;
    const lowPerf = bundle.performance.filter(
        (p) => (p.ratingScore != null && p.ratingScore < 3) || /below|poor|needs/i.test(p.overallRating)
    ).length;
    const avgGpa =
        bundle.transcripts.filter((t) => t.gpa != null).length > 0
            ? Math.round(
                  (bundle.transcripts
                      .filter((t) => t.gpa != null)
                      .reduce((s, t) => s + (t.gpa || 0), 0) /
                      bundle.transcripts.filter((t) => t.gpa != null).length) *
                      100
              ) / 100
            : null;

    const insights: string[] = [];
    if (expired) insights.push(`${expired} certificate(s) already expired — renew immediately.`);
    if (soon) insights.push(`${soon} certificate(s) expire within 30 days.`);
    if (soon90) insights.push(`${soon90} certificate(s) expire within 31–90 days.`);
    if (incomplete) insights.push(`${incomplete} onboarding packet(s) incomplete — chase missing docs.`);
    if (pendingScores) insights.push(`${pendingScores} resume(s) missing CV score — reprocess as resume.`);
    if (pendingLeave) insights.push(`${pendingLeave} leave request(s) still pending approval.`);
    if (lowPerf) insights.push(`${lowPerf} performance review(s) flagged below expectations.`);
    if (promoRecs) insights.push(`${promoRecs} employee(s) recommended for promotion.`);
    if (avgAttendance != null && avgAttendance < 85) {
        insights.push(`Average attendance is ${avgAttendance}% — below 85% threshold.`);
    }
    if (!insights.length) {
        insights.push('No critical HR risk flags from scoped extractions. Continue monitoring certs and onboarding.');
    }

    const empRows = bundle.employees
        .slice(0, 50)
        .map(
            (e, i) => `<tr>
  <td style="padding:6px 8px;border-bottom:1px solid #e2e8f0;font-size:11px;">${i + 1}</td>
  <td style="padding:6px 8px;border-bottom:1px solid #e2e8f0;font-size:11px;">${escapeHtml(e.employeeName)}</td>
  <td style="padding:6px 8px;border-bottom:1px solid #e2e8f0;font-size:11px;">${escapeHtml(e.employeeId || '—')}</td>
  <td style="padding:6px 8px;border-bottom:1px solid #e2e8f0;font-size:11px;">${escapeHtml(e.department || '—')}</td>
  <td style="padding:6px 8px;border-bottom:1px solid #e2e8f0;font-size:11px;">${escapeHtml(e.designation || '—')}</td>
  <td style="padding:6px 8px;border-bottom:1px solid #e2e8f0;font-size:11px;">${escapeHtml(e.status || '—')}</td>
</tr>`
        )
        .join('\n');

    const shortlistRows = scored
        .slice(0, 25)
        .map(
            (r, i) => `<tr>
  <td style="padding:6px 8px;border-bottom:1px solid #e2e8f0;font-size:11px;">${i + 1}</td>
  <td style="padding:6px 8px;border-bottom:1px solid #e2e8f0;font-size:11px;">${escapeHtml(r.originalFilename)}</td>
  <td style="padding:6px 8px;border-bottom:1px solid #e2e8f0;font-size:11px;text-align:right;">${r.cvScore}</td>
</tr>`
        )
        .join('\n');

    const certRows = [...bundle.certs]
        .sort((a, b) => (a.daysUntilExpiry ?? 9999) - (b.daysUntilExpiry ?? 9999))
        .slice(0, 40)
        .map(
            (c) => `<tr>
  <td style="padding:6px 8px;border-bottom:1px solid #e2e8f0;font-size:11px;">${escapeHtml(c.employeeName)}</td>
  <td style="padding:6px 8px;border-bottom:1px solid #e2e8f0;font-size:11px;">${escapeHtml(c.certificateName)}</td>
  <td style="padding:6px 8px;border-bottom:1px solid #e2e8f0;font-size:11px;text-align:right;">${c.daysUntilExpiry ?? '—'}</td>
  <td style="padding:6px 8px;border-bottom:1px solid #e2e8f0;font-size:11px;">${escapeHtml(c.status)}</td>
</tr>`
        )
        .join('\n');

    const onboardRows = [...bundle.onboarding]
        .sort((a, b) => a.completeness - b.completeness)
        .slice(0, 30)
        .map(
            (o) => `<tr>
  <td style="padding:6px 8px;border-bottom:1px solid #e2e8f0;font-size:11px;">${escapeHtml(o.employeeName)}</td>
  <td style="padding:6px 8px;border-bottom:1px solid #e2e8f0;font-size:11px;text-align:right;">${o.completeness}%</td>
  <td style="padding:6px 8px;border-bottom:1px solid #e2e8f0;font-size:11px;">${escapeHtml(o.status)}</td>
  <td style="padding:6px 8px;border-bottom:1px solid #e2e8f0;font-size:11px;">${escapeHtml(o.missing.join(', ') || '—')}</td>
</tr>`
        )
        .join('\n');

    const leaveRows = bundle.leave
        .slice(0, 30)
        .map(
            (l) => `<tr>
  <td style="padding:6px 8px;border-bottom:1px solid #e2e8f0;font-size:11px;">${escapeHtml(l.employeeName)}</td>
  <td style="padding:6px 8px;border-bottom:1px solid #e2e8f0;font-size:11px;">${escapeHtml(l.department || '—')}</td>
  <td style="padding:6px 8px;border-bottom:1px solid #e2e8f0;font-size:11px;">${escapeHtml(l.leaveType)}</td>
  <td style="padding:6px 8px;border-bottom:1px solid #e2e8f0;font-size:11px;text-align:right;">${l.totalDays}</td>
  <td style="padding:6px 8px;border-bottom:1px solid #e2e8f0;font-size:11px;">${escapeHtml(l.approvalStatus || '—')}</td>
</tr>`
        )
        .join('\n');

    const payrollRows = bundle.payroll
        .slice(0, 30)
        .map(
            (p) => `<tr>
  <td style="padding:6px 8px;border-bottom:1px solid #e2e8f0;font-size:11px;">${escapeHtml(p.employeeName)}</td>
  <td style="padding:6px 8px;border-bottom:1px solid #e2e8f0;font-size:11px;">${escapeHtml(p.period)}</td>
  <td style="padding:6px 8px;border-bottom:1px solid #e2e8f0;font-size:11px;">${escapeHtml(p.department || '—')}</td>
  <td style="padding:6px 8px;border-bottom:1px solid #e2e8f0;font-size:11px;text-align:right;">${escapeHtml(p.currency)} ${p.netSalary.toLocaleString()}</td>
</tr>`
        )
        .join('\n');

    const attRows = [...bundle.attendance]
        .sort((a, b) => a.presentPct - b.presentPct)
        .slice(0, 30)
        .map(
            (a) => `<tr>
  <td style="padding:6px 8px;border-bottom:1px solid #e2e8f0;font-size:11px;">${escapeHtml(a.employeeName)}</td>
  <td style="padding:6px 8px;border-bottom:1px solid #e2e8f0;font-size:11px;">${escapeHtml(a.period || '—')}</td>
  <td style="padding:6px 8px;border-bottom:1px solid #e2e8f0;font-size:11px;text-align:right;">${a.daysPresent}/${a.totalWorkingDays}</td>
  <td style="padding:6px 8px;border-bottom:1px solid #e2e8f0;font-size:11px;text-align:right;">${a.presentPct}%</td>
</tr>`
        )
        .join('\n');

    const perfRows = bundle.performance
        .slice(0, 30)
        .map(
            (p) => `<tr>
  <td style="padding:6px 8px;border-bottom:1px solid #e2e8f0;font-size:11px;">${escapeHtml(p.employeeName)}</td>
  <td style="padding:6px 8px;border-bottom:1px solid #e2e8f0;font-size:11px;">${escapeHtml(p.period || '—')}</td>
  <td style="padding:6px 8px;border-bottom:1px solid #e2e8f0;font-size:11px;">${escapeHtml(p.overallRating || '—')}</td>
  <td style="padding:6px 8px;border-bottom:1px solid #e2e8f0;font-size:11px;text-align:right;">${p.ratingScore ?? '—'}</td>
  <td style="padding:6px 8px;border-bottom:1px solid #e2e8f0;font-size:11px;">${p.promotionRecommended == null ? '—' : p.promotionRecommended ? 'Yes' : 'No'}</td>
</tr>`
        )
        .join('\n');

    const transcriptRows = bundle.transcripts
        .slice(0, 30)
        .map(
            (t) => `<tr>
  <td style="padding:6px 8px;border-bottom:1px solid #e2e8f0;font-size:11px;">${escapeHtml(t.studentName)}</td>
  <td style="padding:6px 8px;border-bottom:1px solid #e2e8f0;font-size:11px;">${escapeHtml(t.institution || '—')}</td>
  <td style="padding:6px 8px;border-bottom:1px solid #e2e8f0;font-size:11px;">${escapeHtml(t.degree || '—')}</td>
  <td style="padding:6px 8px;border-bottom:1px solid #e2e8f0;font-size:11px;text-align:right;">${t.gpa ?? '—'}${t.maxGpa != null ? ` / ${t.maxGpa}` : ''}</td>
</tr>`
        )
        .join('\n');

    const insightLis = insights.map((i) => `<li style="margin:4px 0;">${escapeHtml(i)}</li>`).join('\n');

    const html = `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"/><title>${escapeHtml(subject)}</title>
<style>
  body { font-family: Helvetica, Arial, sans-serif; color: #0f172a; margin: 0; padding: 24px; font-size: 10pt; }
  h1 { margin: 0 0 6px; font-size: 18pt; }
  h2 { margin: 18px 0 8px; font-size: 12pt; color: #5b21b6; border-bottom: 1px solid #e2e8f0; padding-bottom: 4px; page-break-after: avoid; }
  .meta { color: #64748b; font-size: 9pt; margin-bottom: 12px; }
  .card { display: inline-block; width: 15%; min-width: 90px; margin: 0 1% 8px 0; border: 1px solid #e2e8f0; border-radius: 8px; padding: 8px 10px; background: #faf5ff; vertical-align: top; }
  .card .label { font-size: 7.5pt; color: #64748b; text-transform: uppercase; }
  .card .value { font-size: 13pt; font-weight: 700; margin-top: 2px; }
  table { width: 100%; border-collapse: collapse; margin-bottom: 4px; }
  th { text-align: left; padding: 6px 8px; font-size: 8pt; color: #64748b; border-bottom: 2px solid #e2e8f0; background: #f8fafc; }
  .note { margin: 10px 0 14px; padding: 10px 12px; background: #fff7ed; border: 1px solid #fed7aa; border-radius: 8px; font-size: 9pt; color: #9a3412; }
  .insights { margin: 8px 0 14px; padding: 10px 12px; background: #f5f3ff; border: 1px solid #ddd6fe; border-radius: 8px; font-size: 9.5pt; }
  .footer { margin-top: 18px; font-size: 8pt; color: #94a3b8; }
</style></head><body>
  <h1>HR workforce analysis report</h1>
  <div class="meta">Generated ${escapeHtml(generatedAt.toLocaleString())} · HR Agent · Full extraction analysis</div>

  <div>
    <div class="card"><div class="label">Employees</div><div class="value">${bundle.employees.length}</div></div>
    <div class="card"><div class="label">Scored CVs</div><div class="value">${scored.length}</div></div>
    <div class="card"><div class="label">Certs risk</div><div class="value">${expired + soon}</div></div>
    <div class="card"><div class="label">Onboard gaps</div><div class="value">${incomplete}</div></div>
    <div class="card"><div class="label">Leave days</div><div class="value">${leaveDays}</div></div>
    <div class="card"><div class="label">Payroll net</div><div class="value">${bundle.payroll.length ? escapeHtml(payrollCur) + ' ' + Math.round(payrollTotal).toLocaleString() : '—'}</div></div>
  </div>

  <div class="insights"><b>Executive insights & actions</b><ul style="margin:6px 0 0;padding-left:18px;">${insightLis}</ul></div>
  <div class="note">CV scores come from resume extractions (<code>cv_score</code>). If scores show pending, open each CV → <b>Reprocess</b> as resume / HR Agent, then regenerate this report.</div>

  <h2>1. Employee directory</h2>
  <table><thead><tr><th>#</th><th>Name</th><th>ID</th><th>Department</th><th>Title</th><th>Status</th></tr></thead>
  <tbody>${tableRowsOrEmpty(empRows, 6, 'No employee records in scope.')}</tbody></table>

  <h2>2. Recruitment — CV shortlist</h2>
  <p style="font-size:9pt;color:#64748b;margin:0 0 6px;">${scored.length} scored · ${pendingScores} pending score</p>
  <table><thead><tr><th>#</th><th>Resume</th><th style="text-align:right;">CV score</th></tr></thead>
  <tbody>${tableRowsOrEmpty(shortlistRows, 3, 'No scored resumes — reprocess CVs as resume type.')}</tbody></table>

  <h2>3. Training certificates — expiry register</h2>
  <p style="font-size:9pt;color:#64748b;margin:0 0 6px;">Expired ${expired} · ≤30d ${soon} · 31–90d ${soon90} · total ${bundle.certs.length}</p>
  <table><thead><tr><th>Employee</th><th>Certificate</th><th style="text-align:right;">Days</th><th>Status</th></tr></thead>
  <tbody>${tableRowsOrEmpty(certRows, 4, 'No certificates in scope.')}</tbody></table>

  <h2>4. Onboarding completeness</h2>
  <table><thead><tr><th>Employee</th><th style="text-align:right;">%</th><th>Status</th><th>Missing</th></tr></thead>
  <tbody>${tableRowsOrEmpty(onboardRows, 4, 'No onboarding packets in scope.')}</tbody></table>

  <h2>5. Leave applications</h2>
  <p style="font-size:9pt;color:#64748b;margin:0 0 6px;">${bundle.leave.length} application(s) · ${leaveDays} total days · ${pendingLeave} pending</p>
  <table><thead><tr><th>Employee</th><th>Dept</th><th>Type</th><th style="text-align:right;">Days</th><th>Status</th></tr></thead>
  <tbody>${tableRowsOrEmpty(leaveRows, 5, 'No leave applications in scope.')}</tbody></table>

  <h2>6. Payroll summary</h2>
  <p style="font-size:9pt;color:#64748b;margin:0 0 6px;">${bundle.payroll.length} payslip(s)${bundle.payroll.length ? ` · net total ${escapeHtml(payrollCur)} ${Math.round(payrollTotal).toLocaleString()}` : ''}</p>
  <table><thead><tr><th>Employee</th><th>Period</th><th>Dept</th><th style="text-align:right;">Net</th></tr></thead>
  <tbody>${tableRowsOrEmpty(payrollRows, 4, 'No payroll documents in scope.')}</tbody></table>

  <h2>7. Attendance</h2>
  <p style="font-size:9pt;color:#64748b;margin:0 0 6px;">${bundle.attendance.length} record(s)${avgAttendance != null ? ` · avg present ${avgAttendance}%` : ''}</p>
  <table><thead><tr><th>Employee</th><th>Period</th><th style="text-align:right;">Present</th><th style="text-align:right;">%</th></tr></thead>
  <tbody>${tableRowsOrEmpty(attRows, 4, 'No attendance records in scope.')}</tbody></table>

  <h2>8. Performance reviews</h2>
  <p style="font-size:9pt;color:#64748b;margin:0 0 6px;">${bundle.performance.length} review(s) · ${promoRecs} promo recommended · ${lowPerf} below-expectation</p>
  <table><thead><tr><th>Employee</th><th>Period</th><th>Rating</th><th style="text-align:right;">Score</th><th>Promo?</th></tr></thead>
  <tbody>${tableRowsOrEmpty(perfRows, 5, 'No performance reviews in scope.')}</tbody></table>

  <h2>9. Transcripts / academics</h2>
  <p style="font-size:9pt;color:#64748b;margin:0 0 6px;">${bundle.transcripts.length} transcript(s)${avgGpa != null ? ` · avg GPA ${avgGpa}` : ''}</p>
  <table><thead><tr><th>Student</th><th>Institution</th><th>Degree</th><th style="text-align:right;">GPA</th></tr></thead>
  <tbody>${tableRowsOrEmpty(transcriptRows, 4, 'No transcripts in scope.')}</tbody></table>

  <p class="footer">Full HR analysis from scoped extractions (directory, hiring, certs, onboarding, leave, payroll, attendance, performance, transcripts). Draft letters separately in chat.</p>
</body></html>`;

    return { subject, html };
}

function buildShortlistHtml(
    resumes: Array<{ originalFilename: string; cvScore: number }>
): { subject: string; html: string } {
    const dateLabel = new Date().toISOString().slice(0, 10);
    const subject = `HR shortlist — ${dateLabel}`;
    const rows = resumes
        .map(
            (r, i) => `<tr>
  <td style="padding:8px;border-bottom:1px solid #e2e8f0;">${i + 1}</td>
  <td style="padding:8px;border-bottom:1px solid #e2e8f0;">${escapeHtml(r.originalFilename)}</td>
  <td style="padding:8px;border-bottom:1px solid #e2e8f0;text-align:right;">${Number.isFinite(r.cvScore) ? r.cvScore : '—'}</td>
</tr>`
        )
        .join('\n');
    const html = `<!DOCTYPE html><html><head><meta charset="utf-8"/><title>${escapeHtml(subject)}</title>
<style>body{font-family:Helvetica,Arial,sans-serif;padding:24px;color:#0f172a}h1{font-size:18pt}table{width:100%;border-collapse:collapse}th{text-align:left;padding:8px;border-bottom:2px solid #e2e8f0;color:#64748b;font-size:9pt}</style>
</head><body><h1>Candidate shortlist</h1>
<p style="color:#64748b;font-size:9pt">Generated ${escapeHtml(new Date().toLocaleString())} · ranked by CV score</p>
<table><thead><tr><th>#</th><th>Candidate / file</th><th style="text-align:right;">CV score</th></tr></thead>
<tbody>${rows}</tbody></table></body></html>`;
    return { subject, html };
}

function buildHrLetterHtml(params: {
    kind: HrLetterKind;
    employeeName: string;
    company: string;
    title: string;
    newTitle?: string;
    reason?: string;
    effectiveDate?: string;
    lastWorkingDay?: string;
    department?: string;
    duration?: string;
    trainingName?: string;
    location?: string;
    analysisNote?: string;
}): { subject: string; html: string; classification: string } {
    const { kind, employeeName, company, title } = params;
    const today = new Date().toLocaleDateString('en-GB', {
        day: '2-digit',
        month: 'long',
        year: 'numeric',
    });
    const ref = `HR/${kind.toUpperCase().slice(0, 3)}/${new Date().getFullYear()}/${Math.floor(Math.random() * 900 + 100)}`;

    const labels: Record<HrLetterKind, string> = {
        promotion: 'Promotion Letter',
        warning: 'Warning Letter',
        relieving: 'Relieving Letter',
        joining: 'Joining / Appointment Letter',
        internship: 'Internship Letter',
        training_certificate: 'Training Completion Certificate',
    };
    const classificationMap: Record<HrLetterKind, string> = {
        promotion: 'promotion_letter',
        warning: 'warning_letter',
        relieving: 'relieving_letter',
        joining: 'joining_letter',
        internship: 'internship_letter',
        training_certificate: 'training_certificate',
    };
    const classification = classificationMap[kind];
    const joinDate = params.effectiveDate || new Date().toISOString().slice(0, 10);
    const dept = params.department ? ` — ${params.department}` : '';

    let body = '';
    if (kind === 'joining') {
        body = `
<p>Dear <b>${escapeHtml(employeeName)}</b>,</p>
<p>We are pleased to offer you employment with <b>${escapeHtml(company)}</b> and welcome you to our team.</p>
<p>This letter confirms your appointment to the position of <b>${escapeHtml(title || 'Team Member')}</b>${escapeHtml(dept)}, with joining date <b>${escapeHtml(joinDate)}</b>${params.location ? ` at ${escapeHtml(params.location)}` : ''}.</p>
<p>Please report to Human Resources on your joining date with original identification documents and signed copies of your offer / employment paperwork. Your employment will be governed by company policies and the terms communicated separately.</p>
<p>We look forward to your contribution and wish you a successful career with ${escapeHtml(company)}.</p>`;
    } else if (kind === 'internship') {
        body = `
<p>Dear <b>${escapeHtml(employeeName)}</b>,</p>
<p>We are pleased to confirm your internship with <b>${escapeHtml(company)}</b>.</p>
<p>You are appointed as <b>${escapeHtml(title || 'Intern')}</b>${escapeHtml(dept)}, commencing <b>${escapeHtml(joinDate)}</b>${params.duration ? ` for a duration of <b>${escapeHtml(params.duration)}</b>` : ''}.</p>
<p>During the internship you will work under the guidance of your assigned mentor / department lead and are expected to observe company policies, confidentiality, and professional conduct.</p>
<p>We welcome you and look forward to a productive internship period.</p>`;
    } else if (kind === 'training_certificate') {
        body = `
<div style="text-align:center;margin:28px 0 18px;">
  <div style="font-size:11pt;letter-spacing:.18em;text-transform:uppercase;color:#64748b;">Certificate of Completion</div>
  <div style="font-size:22pt;font-weight:700;margin-top:10px;color:#1e1b4b;">${escapeHtml(params.trainingName || title || 'Professional Training')}</div>
</div>
<p style="text-align:center;">This is to certify that</p>
<p style="text-align:center;font-size:16pt;font-weight:700;margin:10px 0;">${escapeHtml(employeeName)}</p>
<p style="text-align:center;">has successfully completed the training program
<b>${escapeHtml(params.trainingName || title || 'Professional Training')}</b>
conducted by <b>${escapeHtml(company)}</b>${params.duration ? ` (${escapeHtml(params.duration)})` : ''}${params.effectiveDate ? `, dated <b>${escapeHtml(params.effectiveDate)}</b>` : ''}.</p>
<p style="text-align:center;color:#475569;font-size:10pt;margin-top:18px;">Awarded in recognition of participation and satisfactory completion of all required modules.</p>`;
    } else if (kind === 'promotion') {
        body = `
<p>Dear <b>${escapeHtml(employeeName)}</b>,</p>
<p>We are pleased to confirm your promotion${params.newTitle ? ` to <b>${escapeHtml(params.newTitle)}</b>` : ''}${title ? ` (from ${escapeHtml(title)})` : ''}${params.effectiveDate ? `, effective <b>${escapeHtml(params.effectiveDate)}</b>` : ''}.</p>
<p>Please continue your excellent contribution to ${escapeHtml(company)}.</p>`;
    } else if (kind === 'warning') {
        body = `
<p>Dear <b>${escapeHtml(employeeName)}</b>,</p>
<p>This letter serves as a formal warning regarding: <b>${escapeHtml(params.reason || 'conduct / performance as discussed')}</b>.</p>
<p>You are expected to improve immediately. Further incidents may lead to additional disciplinary action.</p>
<p>Designation on record: ${escapeHtml(title || '—')}.</p>`;
    } else {
        body = `
<p>Dear <b>${escapeHtml(employeeName)}</b>,</p>
<p>This confirms that ${escapeHtml(employeeName)}${title ? ` (${escapeHtml(title)})` : ''} has been relieved from duties at ${escapeHtml(company)}${params.lastWorkingDay ? ` with effect from <b>${escapeHtml(params.lastWorkingDay)}</b>` : ''}.</p>
<p>We wish them success in future endeavours.</p>`;
    }

    const analysisBlock = params.analysisNote
        ? `<div style="margin-top:22px;padding:10px 12px;border:1px solid #e2e8f0;background:#f8fafc;font-size:9pt;color:#475569;"><b>HR notes (from scoped profile analysis):</b> ${escapeHtml(params.analysisNote)}</div>`
        : '';

    const subject = `${labels[kind]} — ${employeeName}`;
    const html = `<!DOCTYPE html><html><head><meta charset="utf-8"/><title>${escapeHtml(subject)}</title>
<style>
  body{font-family:Georgia,"Times New Roman",serif;padding:48px 56px;color:#0f172a;line-height:1.55;font-size:11.5pt;}
  .header{border-bottom:2px solid #1e1b4b;padding-bottom:12px;margin-bottom:18px;}
  .company{font-size:18pt;font-weight:700;color:#1e1b4b;letter-spacing:.02em;}
  .sub{color:#64748b;font-size:9pt;margin-top:4px;}
  .ref{margin:14px 0 22px;font-size:9.5pt;color:#475569;}
  .sign{margin-top:48px;}
  .sign-line{margin-top:36px;border-top:1px solid #94a3b8;width:220px;padding-top:6px;font-size:10pt;}
</style></head><body>
<div class="header">
  <div class="company">${escapeHtml(company)}</div>
  <div class="sub">Human Resources · Official correspondence</div>
</div>
<div class="ref">Ref: ${escapeHtml(ref)} &nbsp;|&nbsp; Date: ${escapeHtml(today)} &nbsp;|&nbsp; ${escapeHtml(labels[kind])}</div>
${body}
${analysisBlock}
<div class="sign">
  <p>Yours sincerely,</p>
  <div class="sign-line"><b>Human Resources</b><br/>${escapeHtml(company)}</div>
</div>
</body></html>`;
    return { subject, html, classification };
}

async function saveGeneratedPdf(
    user: AuthUser,
    pdfBase64: string,
    filenameBase: string,
    classification: string,
    sourceDocumentIds: string[]
): Promise<InstanceType<typeof Document>> {
    ensureUploadDir();
    const buf = Buffer.from(pdfBase64, 'base64');
    const tmpDir = path.join(process.cwd(), 'uploads', '_tmp');
    if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });
    const tmpPath = path.join(tmpDir, `hr_${uuidv4()}.pdf`);
    fs.writeFileSync(tmpPath, buf);

    const documentId = `doc_${uuidv4()}`;
    const orgFolder = resolveOrgFolder(user.organizationId, user.userId);
    const destDir = getDocumentDir(orgFolder, documentId, { inbox: true });
    fs.mkdirSync(destDir, { recursive: true });

    const originalFilename = sanitizeFilename(`${filenameBase}.pdf`);
    const storagePath = path.join(destDir, originalFilename);
    fs.renameSync(tmpPath, storagePath);

    const contentHash = crypto.createHash('sha256').update(buf).digest('hex');
    const doc = await Document.create({
        documentId,
        organizationId: user.organizationId || null,
        uploadedBy: user.userId,
        openRemoteUserId: (user as { openRemoteUserId?: string | null }).openRemoteUserId || null,
        originalFilename,
        storedFilename: originalFilename,
        mimeType: 'application/pdf',
        sizeBytes: buf.length,
        storagePath,
        contentHash,
        pythonDocumentId: null,
        aiProcessingStatus: null,
        aiErrorMessage: null,
        status: 'ready',
        classification,
        metadata: {
            source: 'hr_chat',
            phase3Agent: HR_AGENT,
            generatedVia: 'hr_chat',
            generatedFromDocumentIds: sourceDocumentIds.slice(0, 80),
            storageLayout: 'by-type',
            storageType: 'inbox',
            aiSynced: false,
        },
    });

    try {
        const { applyDocumentVisibilityScope } = await import('./documentVisibility');
        await applyDocumentVisibilityScope(doc, null);
        await doc.save();
    } catch (e: any) {
        logger.warn(`HR generated doc visibility failed for ${doc.documentId}: ${e?.message || e}`);
    }

    try {
        await applyDocumentTypeStorage(doc, classification);
        await doc.save();
    } catch (e: any) {
        logger.warn(`HR generated doc relocate failed for ${doc.documentId}: ${e?.message || e}`);
    }

    return doc;
}

export async function tryHrReportCommand(params: {
    user: AuthUser;
    question: string;
    phase3Agent?: string;
    documentIds?: string[];
}): Promise<HrReportActionResult> {
    if (!detectHrReportCommand(params.question, params.phase3Agent)) {
        return { handled: false };
    }

    if (params.user.role !== 'superAdmin') {
        const check = await requireAllowedAgent(params.user, HR_AGENT);
        if (!check.ok) return { handled: true, answer: check.message };
    }

    const scopedIds = params.documentIds?.filter(Boolean);
    const bundle = await loadHrSnapshotBundle(params.user, {
        documentIds: scopedIds?.length ? scopedIds : undefined,
        maxDocs: 150,
    });
    const resumes = await listTopResumesForUser(
        params.user,
        25,
        scopedIds?.length ? scopedIds : undefined
    );

    const hasAny =
        bundle.employees.length ||
        bundle.certs.length ||
        bundle.onboarding.length ||
        bundle.leave.length ||
        bundle.payroll.length ||
        bundle.attendance.length ||
        bundle.performance.length ||
        bundle.transcripts.length ||
        resumes.length;
    if (!hasAny) {
        return {
            handled: true,
            answer:
                'No ready **HR** documents with extractable data in scope. Upload employee records, certificates, leave, payroll, attendance, performance reviews, transcripts, or resumes, then say: `Generate HR report`.',
        };
    }

    const { html } = buildHrReportHtml({ bundle, resumes });
    const stamp = new Date().toISOString().slice(0, 10);
    const generatedPdf = await generateComplianceReportPdf({
        html,
        filename: `HR_Workforce_Report_${stamp}.pdf`,
    });
    if (!generatedPdf.pdf_base64) {
        throw new Error('HR PDF generation failed (pdf_base64 missing).');
    }

    const sourceIds = [
        ...new Set([
            ...bundle.employees.map((e) => e.documentId),
            ...bundle.certs.map((c) => c.documentId),
            ...bundle.onboarding.map((o) => o.documentId),
            ...bundle.leave.map((l) => l.documentId),
            ...bundle.payroll.map((p) => p.documentId),
            ...bundle.attendance.map((a) => a.documentId),
            ...bundle.performance.map((p) => p.documentId),
            ...bundle.transcripts.map((t) => t.documentId),
            ...resumes.map((r) => r.documentId),
        ]),
    ];

    const reportDoc = await saveGeneratedPdf(
        params.user,
        generatedPdf.pdf_base64,
        `HR_Workforce_Report_${stamp}`,
        'hr_report',
        sourceIds
    );

    const scored = resumes.filter((r) => Number.isFinite(r.cvScore)).length;
    const pending = resumes.length - scored;

    return {
        handled: true,
        answer: [
            '**HR workforce analysis report ready** (full PDF).',
            '',
            `- Employees: **${bundle.employees.length}**`,
            `- CV shortlist: **${scored}** scored${pending ? ` · **${pending}** pending score (reprocess those CVs)` : ''}`,
            `- Certificates: **${bundle.certs.length}** (expired/≤30d risk highlighted in PDF)`,
            `- Onboarding gaps: **${bundle.onboarding.filter((o) => o.status !== 'COMPLETE').length}**`,
            `- Leave / payroll / attendance / performance / transcripts: included when present in scope`,
            '',
            `[${reportDoc.originalFilename.replace(/\.pdf$/i, '')}](${pdfPreviewPath(reportDoc.documentId)})`,
            '',
            'Also available: `Generate certificate report`, `Generate transcript report`, `Generate performance report`, or `Score CVs in scope`.',
        ].join('\n'),
        citations: [
            {
                documentId: reportDoc.documentId,
                filename: reportDoc.originalFilename,
                documentType: 'hr_report',
                phase3Agent: HR_AGENT,
            },
        ],
    };
}

export async function tryHrShortlistExport(params: {
    user: AuthUser;
    question: string;
    phase3Agent?: string;
    documentIds?: string[];
}): Promise<HrReportActionResult> {
    if (!detectHrShortlistExport(params.question, params.phase3Agent)) {
        return { handled: false };
    }

    if (params.user.role !== 'superAdmin') {
        const check = await requireAllowedAgent(params.user, HR_AGENT);
        if (!check.ok) return { handled: true, answer: check.message };
    }

    const limit = parseTopLimit(params.question, 10);
    const scopedIds = params.documentIds?.filter(Boolean);
    const resumes = await listTopResumesForUser(
        params.user,
        limit,
        scopedIds?.length ? scopedIds : undefined
    );
    const scored = resumes.filter((r) => Number.isFinite(r.cvScore));
    if (!scored.length) {
        return {
            handled: true,
            answer:
                'No scored resumes in scope for a shortlist export. Select CVs, wait for CV scores, then say: `Export shortlist top 10`.',
        };
    }

    const { html } = buildShortlistHtml(scored.slice(0, limit));
    const stamp = new Date().toISOString().slice(0, 10);
    const generatedPdf = await generateComplianceReportPdf({
        html,
        filename: `HR_Shortlist_${stamp}.pdf`,
    });
    if (!generatedPdf.pdf_base64) {
        throw new Error('Shortlist PDF generation failed.');
    }

    const doc = await saveGeneratedPdf(
        params.user,
        generatedPdf.pdf_base64,
        `HR_Shortlist_Top${Math.min(limit, scored.length)}_${stamp}`,
        'hr_shortlist',
        scored.map((r) => r.documentId)
    );

    return {
        handled: true,
        answer: [
            `**Shortlist PDF** — top **${Math.min(limit, scored.length)}** by CV score.`,
            '',
            `[${doc.originalFilename.replace(/\.pdf$/i, '')}](${pdfPreviewPath(doc.documentId)})`,
            '',
            'Tip: say `Export shortlist top 5` to change the size.',
        ].join('\n'),
        citations: [
            {
                documentId: doc.documentId,
                filename: doc.originalFilename,
                documentType: 'hr_shortlist',
                phase3Agent: HR_AGENT,
            },
        ],
    };
}

export async function tryHrDirectoryCommand(params: {
    user: AuthUser;
    question: string;
    phase3Agent?: string;
    documentIds?: string[];
}): Promise<HrReportActionResult> {
    if (!detectHrDirectoryCommand(params.question, params.phase3Agent)) {
        return { handled: false };
    }

    if (params.user.role !== 'superAdmin') {
        const check = await requireAllowedAgent(params.user, HR_AGENT);
        if (!check.ok) return { handled: true, answer: check.message };
    }

    const scopedIds = params.documentIds?.filter(Boolean);
    const bundle = await loadHrSnapshotBundle(params.user, {
        documentIds: scopedIds?.length ? scopedIds : undefined,
    });

    return {
        handled: true,
        answer: [
            `**Employee directory** — **${bundle.employees.length}** record(s) in scope.`,
            '',
            formatEmployeeDirectory(bundle.employees),
            '',
            'Also try: `Chart certificate expiry`, `Show onboarding completeness`, or `Generate HR report`.',
        ].join('\n'),
        citations: bundle.employees.slice(0, 12).map((e) => ({
            documentId: e.documentId,
            filename: e.filename,
            documentType: 'employee_record',
            phase3Agent: HR_AGENT,
        })),
    };
}

export async function tryHrExtraLetterCommand(params: {
    user: AuthUser;
    question: string;
    phase3Agent?: string;
    documentIds?: string[];
}): Promise<HrReportActionResult> {
    const kind = detectHrExtraLetter(params.question, params.phase3Agent);
    if (!kind) return { handled: false };

    if (params.user.role !== 'superAdmin') {
        const check = await requireAllowedAgent(params.user, HR_AGENT);
        if (!check.ok) return { handled: true, answer: check.message };
    }

    const name = parsePersonName(params.question);
    const company =
        parseField(params.question, ['company', 'organisation', 'organization']) ||
        'Visibility Docs';
    const title = parseField(params.question, [
        'title',
        'designation',
        'current title',
        'role',
        'position',
    ]);
    const newTitle = parseField(params.question, ['new title', 'promoted to', 'promotion title']);
    const reason = parseField(params.question, ['reason', 'regarding']);
    const effectiveDate = parseField(params.question, [
        'effective',
        'joining date',
        'joining',
        'start date',
        'from',
    ]);
    const lastWorkingDay = parseField(params.question, [
        'last working day',
        'to',
        'until',
        'relieved on',
    ]);
    const duration = parseField(params.question, ['duration', 'period', 'for']);
    const trainingName = parseField(params.question, [
        'training',
        'course',
        'program',
        'certificate',
    ]);
    const department = parseField(params.question, ['department', 'dept', 'team']);
    const location = parseField(params.question, ['location', 'office', 'city']);

    if (!name) {
        const examples: Record<HrLetterKind, string> = {
            joining:
                '`Generate joining letter for Sharjeel. Company Visibility Bots, title Software Engineer, joining 2026-09-01, department Engineering`',
            internship:
                '`Generate internship letter for Sara Ali. Company Visibility Bots, title Backend Intern, joining 2026-09-01, duration 3 months`',
            training_certificate:
                '`Generate training certificate for Ali. Company Visibility Bots, training React Fundamentals, duration 4 weeks`',
            promotion:
                '`Generate promotion letter for Ahmed Khan. Company Visibility Bots, title Software Engineer, new title Senior Engineer, effective 2026-09-01`',
            warning:
                '`Generate warning letter for Ahmed Khan. Company Visibility Bots, title Software Engineer, reason late attendance`',
            relieving:
                '`Generate relieving letter for Ahmed Khan. Company Visibility Bots, title Software Engineer, last working day 2026-08-31`',
        };
        return {
            handled: true,
            answer: [
                `I can draft a professional **${kind.replace(/_/g, ' ')}**, but need the person\'s name.`,
                '',
                `Example: ${examples[kind]}`,
                '',
                '_Tip: select their resume in Document scope so I can prefill title / skills from analysis._',
            ].join('\n'),
        };
    }

    const scopedIds = params.documentIds?.filter(Boolean);
    const bundle = await loadHrSnapshotBundle(params.user, {
        documentIds: scopedIds?.length ? scopedIds : undefined,
    });
    const needle = name.toLowerCase();
    const matchEmp = bundle.employees.find(
        (e) =>
            e.employeeName.toLowerCase().includes(needle) ||
            needle.includes(e.employeeName.toLowerCase().split(' ')[0] || '___')
    );

    // Also match resume filenames / candidate extraction for hiring letters
    let resumeMatch: { documentId: string; filename: string; candidateName?: string; title?: string; summary?: string } | null =
        null;
    try {
        const resumes = await listTopResumesForUser(
            params.user,
            scopedIds?.length ? Math.max(scopedIds.length, 40) : 40,
            scopedIds?.length ? scopedIds : undefined
        );
        const nameHit = resumes.find((r) =>
            r.originalFilename.toLowerCase().replace(/[^a-z0-9]+/g, ' ').includes(
                needle.replace(/[^a-z0-9]+/g, ' ').trim()
            )
        );
        if (nameHit?.pythonDocumentId) {
            const { getOfferLetterPrefill, getDocumentExtractions, resolveAiOrganizationId } =
                await import('./aiServiceClient');
            const orgId = resolveAiOrganizationId(params.user);
            let candidateName = '';
            let resumeTitle = '';
            let summary = '';
            try {
                const pre = await getOfferLetterPrefill(nameHit.pythonDocumentId, orgId);
                candidateName = pre?.prefill?.candidate_name?.trim() || '';
                resumeTitle = String(pre?.prefill?.job_title || '').trim();
            } catch {
                /* ignore */
            }
            try {
                let extractions = await getDocumentExtractions(nameHit.pythonDocumentId, orgId);
                if (!extractions?.length) extractions = await getDocumentExtractions(nameHit.pythonDocumentId, '');
                for (const ext of extractions || []) {
                    const data = (ext.extracted_data || {}) as Record<string, unknown>;
                    if (!candidateName && typeof data.candidate_name === 'string') {
                        candidateName = data.candidate_name;
                    }
                    if (!resumeTitle && typeof data.current_title === 'string') {
                        resumeTitle = data.current_title;
                    }
                    if (typeof data.evaluation_summary === 'string') summary = data.evaluation_summary;
                    if (typeof data.cv_score === 'number') {
                        summary = summary
                            ? `${summary} (CV score ${data.cv_score}/100)`
                            : `CV score ${data.cv_score}/100`;
                    }
                }
            } catch {
                /* ignore */
            }
            const candNeedle = (candidateName || nameHit.originalFilename).toLowerCase();
            if (
                candNeedle.includes(needle) ||
                needle.split(/\s+/).every((t) => t.length < 2 || candNeedle.includes(t)) ||
                nameHit
            ) {
                resumeMatch = {
                    documentId: nameHit.documentId,
                    filename: nameHit.originalFilename,
                    candidateName: candidateName || undefined,
                    title: resumeTitle || undefined,
                    summary: summary || undefined,
                };
            }
        } else if (nameHit) {
            resumeMatch = {
                documentId: nameHit.documentId,
                filename: nameHit.originalFilename,
            };
        }
    } catch {
        /* ignore */
    }

    const displayName = matchEmp?.employeeName || resumeMatch?.candidateName || name;
    const resolvedTitle = title || matchEmp?.designation || resumeMatch?.title || '';
    const analysisNote =
        resumeMatch?.summary ||
        (matchEmp
            ? `Employee record on file (${matchEmp.department || 'dept n/a'} / ${matchEmp.designation || 'title n/a'}).`
            : undefined);

    const { html, classification } = buildHrLetterHtml({
        kind,
        employeeName: displayName,
        company,
        title: resolvedTitle,
        newTitle: newTitle || undefined,
        reason: reason || undefined,
        effectiveDate: effectiveDate || undefined,
        lastWorkingDay: lastWorkingDay || undefined,
        department: department || matchEmp?.department || undefined,
        duration: duration || undefined,
        trainingName: trainingName || undefined,
        location: location || undefined,
        analysisNote,
    });

    const stamp = new Date().toISOString().slice(0, 10);
    const generatedPdf = await generateComplianceReportPdf({
        html,
        filename: `${kind}_${stamp}.pdf`,
    });
    if (!generatedPdf.pdf_base64) {
        throw new Error(`${kind} PDF generation failed.`);
    }

    const sourceIds = [
        ...(matchEmp ? [matchEmp.documentId] : []),
        ...(resumeMatch ? [resumeMatch.documentId] : []),
    ];

    const label =
        kind === 'training_certificate'
            ? 'Training certificate'
            : `${kind[0].toUpperCase()}${kind.slice(1).replace(/_/g, ' ')} letter`;

    const doc = await saveGeneratedPdf(
        params.user,
        generatedPdf.pdf_base64,
        `${label.replace(/\s+/g, '_')}_${displayName.replace(/\s+/g, '_')}_${stamp}`,
        classification,
        sourceIds
    );

    const linkLabel = letterDocLink(label, displayName, doc.documentId);

    return {
        handled: true,
        answer: [
            `**${label}** ready for **${displayName}**.`,
            '',
            linkLabel,
            resumeMatch
                ? `_Prefill used resume analysis: ${resumeMatch.filename}_`
                : matchEmp
                  ? `_Prefill used employee record: ${matchEmp.filename}_`
                  : '_Tip: select their **resume** in Document scope for title/skills prefill from CV analysis._',
            kind === 'joining'
                ? '_Optional fields: `company`, `title`, `joining YYYY-MM-DD`, `department`, `location`._'
                : kind === 'internship'
                  ? '_Optional fields: `title`, `joining`, `duration 3 months`, `department`._'
                  : kind === 'training_certificate'
                    ? '_Optional fields: `training <name>`, `duration`, `company`._'
                    : '',
        ]
            .filter(Boolean)
            .join('\n'),
        citations: [
            {
                documentId: doc.documentId,
                filename: `${label} — ${displayName}.pdf`,
                documentType: classification,
                phase3Agent: HR_AGENT,
            },
        ],
    };
}

/** Aggregate entry for chatController — runs report/shortlist/directory/extra letters. */
export async function tryHrExtendedChatCommand(params: {
    user: AuthUser;
    question: string;
    phase3Agent?: string;
    documentIds?: string[];
}): Promise<HrReportActionResult> {
    if (params.phase3Agent && params.phase3Agent !== HR_AGENT) {
        return { handled: false };
    }

    const report = await tryHrReportCommand(params);
    if (report.handled) return report;
    const section = await tryHrSectionPdfCommand(params);
    if (section.handled) return section;
    const rescore = await tryHrRescoreCvsCommand(params);
    if (rescore.handled) return rescore;
    const shortlist = await tryHrShortlistExport(params);
    if (shortlist.handled) return shortlist;
    const directory = await tryHrDirectoryCommand(params);
    if (directory.handled) return directory;
    const letter = await tryHrExtraLetterCommand(params);
    if (letter.handled) return letter;
    return { handled: false };
}

export type HrSectionPdfKind =
    | 'certs'
    | 'transcripts'
    | 'performance'
    | 'leave'
    | 'onboarding'
    | 'attendance'
    | 'payroll';

export function detectHrSectionPdf(question: string, phase3Agent?: string): HrSectionPdfKind | null {
    if (phase3Agent !== HR_AGENT && !/\bhr\s+agent\b/i.test(question)) return null;
    const q = question.toLowerCase();
    const wantsPdf =
        /\b(generate|create|export|download|make|prepare|build)\b/.test(q) &&
        /\b(report|pdf|register|summary)\b/.test(q);
    if (!wantsPdf) return null;
    if (/\bhr\s+(workforce\s+)?report\b/.test(q)) return null; // full report handled elsewhere
    if (/\b(cert|training)\b/.test(q)) return 'certs';
    if (/\b(transcript|marksheet|gpa|academic)\b/.test(q)) return 'transcripts';
    if (/\b(performance|appraisal|review)\b/.test(q)) return 'performance';
    if (/\bleave\b/.test(q)) return 'leave';
    if (/\bonboarding\b/.test(q)) return 'onboarding';
    if (/\battendance\b/.test(q)) return 'attendance';
    if (/\b(payroll|payslip|salary)\b/.test(q)) return 'payroll';
    return null;
}

export function detectHrRescoreCvs(question: string, phase3Agent?: string): boolean {
    if (phase3Agent !== HR_AGENT && !/\bhr\s+agent\b/i.test(question)) return false;
    const q = question.toLowerCase();
    const mentionsCv = /\b(cv|cvs|resume|resumes|candidates?)\b/.test(q);
    return (
        (/\b(score|rescore|re-?score|mark)\b/.test(q) && mentionsCv) ||
        (/\b(reprocess|process)\b/.test(q) && mentionsCv)
    );
}

function buildSectionPdfHtml(
    kind: HrSectionPdfKind,
    bundle: HrSnapshotBundle
): { subject: string; html: string; empty: boolean } {
    const stamp = new Date().toISOString().slice(0, 10);
    const titles: Record<HrSectionPdfKind, string> = {
        certs: 'Certificate expiry register',
        transcripts: 'Transcript / GPA report',
        performance: 'Performance review report',
        leave: 'Leave applications report',
        onboarding: 'Onboarding completeness report',
        attendance: 'Attendance report',
        payroll: 'Payroll summary report',
    };
    const subject = `${titles[kind]} — ${stamp}`;
    let body = '';
    let empty = false;

    if (kind === 'certs') {
        empty = !bundle.certs.length;
        body = `<table><thead><tr><th>Employee</th><th>Certificate</th><th>Days</th><th>Status</th></tr></thead><tbody>${
            bundle.certs
                .sort((a, b) => (a.daysUntilExpiry ?? 9999) - (b.daysUntilExpiry ?? 9999))
                .map(
                    (c) =>
                        `<tr><td>${escapeHtml(c.employeeName)}</td><td>${escapeHtml(c.certificateName)}</td><td style="text-align:right">${c.daysUntilExpiry ?? '—'}</td><td>${escapeHtml(c.status)}</td></tr>`
                )
                .join('') || `<tr><td colspan="4">No certificates in scope.</td></tr>`
        }</tbody></table>`;
    } else if (kind === 'transcripts') {
        empty = !bundle.transcripts.length;
        body = `<table><thead><tr><th>Student</th><th>Institution</th><th>Degree</th><th>GPA</th></tr></thead><tbody>${
            bundle.transcripts
                .map(
                    (t) =>
                        `<tr><td>${escapeHtml(t.studentName)}</td><td>${escapeHtml(t.institution || '—')}</td><td>${escapeHtml(t.degree || '—')}</td><td style="text-align:right">${t.gpa ?? '—'}</td></tr>`
                )
                .join('') || `<tr><td colspan="4">No transcripts in scope.</td></tr>`
        }</tbody></table>`;
    } else if (kind === 'performance') {
        empty = !bundle.performance.length;
        body = `<table><thead><tr><th>Employee</th><th>Period</th><th>Rating</th><th>Score</th><th>Promo?</th></tr></thead><tbody>${
            bundle.performance
                .map(
                    (p) =>
                        `<tr><td>${escapeHtml(p.employeeName)}</td><td>${escapeHtml(p.period || '—')}</td><td>${escapeHtml(p.overallRating || '—')}</td><td style="text-align:right">${p.ratingScore ?? '—'}</td><td>${p.promotionRecommended == null ? '—' : p.promotionRecommended ? 'Yes' : 'No'}</td></tr>`
                )
                .join('') || `<tr><td colspan="5">No performance reviews in scope.</td></tr>`
        }</tbody></table>`;
    } else if (kind === 'leave') {
        empty = !bundle.leave.length;
        body = `<table><thead><tr><th>Employee</th><th>Type</th><th>Days</th><th>Status</th></tr></thead><tbody>${
            bundle.leave
                .map(
                    (l) =>
                        `<tr><td>${escapeHtml(l.employeeName)}</td><td>${escapeHtml(l.leaveType)}</td><td style="text-align:right">${l.totalDays}</td><td>${escapeHtml(l.approvalStatus || '—')}</td></tr>`
                )
                .join('') || `<tr><td colspan="4">No leave applications in scope.</td></tr>`
        }</tbody></table>`;
    } else if (kind === 'onboarding') {
        empty = !bundle.onboarding.length;
        body = `<table><thead><tr><th>Employee</th><th>%</th><th>Status</th><th>Missing</th></tr></thead><tbody>${
            bundle.onboarding
                .map(
                    (o) =>
                        `<tr><td>${escapeHtml(o.employeeName)}</td><td style="text-align:right">${o.completeness}%</td><td>${escapeHtml(o.status)}</td><td>${escapeHtml(o.missing.join(', ') || '—')}</td></tr>`
                )
                .join('') || `<tr><td colspan="4">No onboarding data in scope.</td></tr>`
        }</tbody></table>`;
    } else if (kind === 'attendance') {
        empty = !bundle.attendance.length;
        body = `<table><thead><tr><th>Employee</th><th>Period</th><th>Present</th><th>%</th></tr></thead><tbody>${
            bundle.attendance
                .map(
                    (a) =>
                        `<tr><td>${escapeHtml(a.employeeName)}</td><td>${escapeHtml(a.period || '—')}</td><td style="text-align:right">${a.daysPresent}/${a.totalWorkingDays}</td><td style="text-align:right">${a.presentPct}%</td></tr>`
                )
                .join('') || `<tr><td colspan="4">No attendance in scope.</td></tr>`
        }</tbody></table>`;
    } else {
        empty = !bundle.payroll.length;
        body = `<table><thead><tr><th>Employee</th><th>Period</th><th>Net</th></tr></thead><tbody>${
            bundle.payroll
                .map(
                    (p) =>
                        `<tr><td>${escapeHtml(p.employeeName)}</td><td>${escapeHtml(p.period)}</td><td style="text-align:right">${escapeHtml(p.currency)} ${p.netSalary.toLocaleString()}</td></tr>`
                )
                .join('') || `<tr><td colspan="3">No payroll in scope.</td></tr>`
        }</tbody></table>`;
    }

    const html = `<!DOCTYPE html><html><head><meta charset="utf-8"/><title>${escapeHtml(subject)}</title>
<style>body{font-family:Helvetica,Arial,sans-serif;padding:24px;color:#0f172a;font-size:10pt}h1{font-size:16pt}table{width:100%;border-collapse:collapse}th,td{padding:6px 8px;border-bottom:1px solid #e2e8f0;text-align:left}th{font-size:8pt;color:#64748b;background:#f8fafc}</style>
</head><body><h1>${escapeHtml(titles[kind])}</h1>
<p style="color:#64748b;font-size:9pt">Generated ${escapeHtml(new Date().toLocaleString())} · HR Agent</p>
${body}</body></html>`;
    return { subject, html, empty };
}

export async function tryHrSectionPdfCommand(params: {
    user: AuthUser;
    question: string;
    phase3Agent?: string;
    documentIds?: string[];
}): Promise<HrReportActionResult> {
    const kind = detectHrSectionPdf(params.question, params.phase3Agent);
    if (!kind) return { handled: false };

    if (params.user.role !== 'superAdmin') {
        const check = await requireAllowedAgent(params.user, HR_AGENT);
        if (!check.ok) return { handled: true, answer: check.message };
    }

    const scopedIds = params.documentIds?.filter(Boolean);
    const bundle = await loadHrSnapshotBundle(params.user, {
        documentIds: scopedIds?.length ? scopedIds : undefined,
        maxDocs: 150,
    });
    const { html, empty } = buildSectionPdfHtml(kind, bundle);
    if (empty) {
        return {
            handled: true,
            answer: `No **${kind}** data in scope to put in a PDF. Upload/select the related HR documents, wait until **ready**, then ask again.`,
        };
    }

    const stamp = new Date().toISOString().slice(0, 10);
    const generatedPdf = await generateComplianceReportPdf({
        html,
        filename: `HR_${kind}_${stamp}.pdf`,
    });
    if (!generatedPdf.pdf_base64) throw new Error('Section PDF generation failed.');

    const sourceIds = [
        ...bundle.certs,
        ...bundle.transcripts,
        ...bundle.performance,
        ...bundle.leave,
        ...bundle.onboarding,
        ...bundle.attendance,
        ...bundle.payroll,
    ].map((r) => r.documentId);

    const doc = await saveGeneratedPdf(
        params.user,
        generatedPdf.pdf_base64,
        `HR_${kind}_report_${stamp}`,
        'hr_report',
        [...new Set(sourceIds)]
    );

    return {
        handled: true,
        answer: [
            `**${kind} PDF report** ready.`,
            '',
            `[${doc.originalFilename.replace(/\.pdf$/i, '')}](${pdfPreviewPath(doc.documentId)})`,
        ].join('\n'),
        citations: [
            {
                documentId: doc.documentId,
                filename: doc.originalFilename,
                documentType: 'hr_report',
                phase3Agent: HR_AGENT,
            },
        ],
    };
}

export async function tryHrRescoreCvsCommand(params: {
    user: AuthUser;
    question: string;
    phase3Agent?: string;
    documentIds?: string[];
}): Promise<HrReportActionResult> {
    if (!detectHrRescoreCvs(params.question, params.phase3Agent)) {
        return { handled: false };
    }

    if (params.user.role !== 'superAdmin') {
        const check = await requireAllowedAgent(params.user, HR_AGENT);
        if (!check.ok) return { handled: true, answer: check.message };
    }

    const scopedIds = params.documentIds?.filter(Boolean);
    const pool = await listTopResumesForUser(
        params.user,
        scopedIds?.length ? Math.max(scopedIds.length, 30) : 30,
        scopedIds?.length ? scopedIds : undefined
    );
    if (!pool.length) {
        return {
            handled: true,
            answer:
                'No resumes in scope to score. Select CV files in Document scope (classification **resume**), then say: `Score CVs in scope`.',
        };
    }

    const { triggerDocumentReprocess, resolveDocumentAiOrgId } = await import('./aiServiceClient');
    let queued = 0;
    let failed = 0;
    const lines: string[] = [];

    for (const r of pool.slice(0, 15)) {
        try {
            const doc = await Document.findOne({ documentId: r.documentId });
            if (!doc?.pythonDocumentId || !doc.storagePath) {
                failed += 1;
                lines.push(`- **${r.originalFilename}** — not linked / file missing`);
                continue;
            }
            doc.status = 'processing';
            doc.classification = doc.classification || 'resume';
            doc.metadata = {
                ...(doc.metadata || {}),
                phase3Agent: HR_AGENT,
                cvScore: undefined,
            };
            await doc.save();
            const orgId = resolveDocumentAiOrgId(doc, params.user);
            await triggerDocumentReprocess(doc.pythonDocumentId, orgId);
            queued += 1;
            lines.push(`- **${r.originalFilename}** — reprocess queued`);
        } catch (e: any) {
            failed += 1;
            lines.push(`- **${r.originalFilename}** — ${e?.message || e}`);
        }
    }

    return {
        handled: true,
        answer: [
            `**CV scoring / reprocess** started for **${queued}** resume(s)${failed ? ` (${failed} failed)` : ''}.`,
            '',
            ...lines.slice(0, 12),
            '',
            'Wait until status is **ready**, then ask `Chart top CV scores` or `Generate HR report`. Scores come from resume extraction field `cv_score`.',
        ].join('\n'),
        citations: pool.slice(0, 8).map((r) => ({
            documentId: r.documentId,
            filename: r.originalFilename,
            documentType: 'resume',
            phase3Agent: HR_AGENT,
        })),
    };
}

/** Expose format helpers for tests / chat answers */
export { formatCertExpiryList, formatOnboardingList, formatEmployeeDirectory };

export type HrStructuredActionId =
    | 'full_report'
    | 'shortlist'
    | 'cert_report'
    | 'leave_report'
    | 'payroll_report'
    | 'performance_report'
    | 'joining_letter'
    | 'internship_letter'
    | 'training_certificate';

export type HrLetterContext = {
    candidateName?: string;
    companyName?: string;
    jobTitle?: string;
    department?: string;
    effectiveDate?: string;
    trainingName?: string;
    duration?: string;
};

export type HrReportExecuteResult = {
    ok: boolean;
    message: string;
    documentId?: string;
    filename?: string;
    classification?: string;
};

const SECTION_BY_ACTION: Partial<Record<HrStructuredActionId, HrSectionPdfKind>> = {
    cert_report: 'certs',
    leave_report: 'leave',
    payroll_report: 'payroll',
    performance_report: 'performance',
};

const LETTER_BY_ACTION: Partial<Record<HrStructuredActionId, HrLetterKind>> = {
    joining_letter: 'joining',
    internship_letter: 'internship',
    training_certificate: 'training_certificate',
};

export const HR_STRUCTURED_ACTION_IDS: HrStructuredActionId[] = [
    'full_report',
    'shortlist',
    'cert_report',
    'leave_report',
    'payroll_report',
    'performance_report',
    'joining_letter',
    'internship_letter',
    'training_certificate',
];

function actionResultToExecute(result: HrReportActionResult): HrReportExecuteResult {
    if (!result.handled) {
        return { ok: false, message: 'Report action could not be completed.' };
    }
    const citation = result.citations?.[0];
    const plain = String(result.answer || '')
        .replace(/\*\*/g, '')
        .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
        .trim();
    if (citation?.documentId) {
        return {
            ok: true,
            message: plain.split('\n').find(Boolean) || 'PDF ready.',
            documentId: citation.documentId,
            filename: citation.filename,
            classification: citation.documentType,
        };
    }
    return { ok: false, message: plain || 'No PDF was generated.' };
}

async function assertHrAgentAccess(user: AuthUser): Promise<HrReportExecuteResult | null> {
    if (user.role === 'superAdmin') return null;
    const check = await requireAllowedAgent(user, HR_AGENT);
    if (!check.ok) return { ok: false, message: check.message || 'HR agent not available on your plan.' };
    return null;
}

async function generateHrWorkforceReportDirect(
    user: AuthUser,
    documentIds?: string[]
): Promise<HrReportExecuteResult> {
    const scopedIds = documentIds?.filter(Boolean);
    const bundle = await loadHrSnapshotBundle(user, {
        documentIds: scopedIds?.length ? scopedIds : undefined,
        maxDocs: 150,
    });
    const resumes = await listTopResumesForUser(user, 25, scopedIds?.length ? scopedIds : undefined);

    const hasAny =
        bundle.employees.length ||
        bundle.certs.length ||
        bundle.onboarding.length ||
        bundle.leave.length ||
        bundle.payroll.length ||
        bundle.attendance.length ||
        bundle.performance.length ||
        bundle.transcripts.length ||
        resumes.length;
    if (!hasAny) {
        return {
            ok: false,
            message:
                'No ready HR documents with extractable data in scope. Upload employee records, certificates, leave, payroll, attendance, performance reviews, transcripts, or resumes first.',
        };
    }

    const { html } = buildHrReportHtml({ bundle, resumes });
    const stamp = new Date().toISOString().slice(0, 10);
    const generatedPdf = await generateComplianceReportPdf({
        html,
        filename: `HR_Workforce_Report_${stamp}.pdf`,
    });
    if (!generatedPdf.pdf_base64) {
        throw new Error('HR PDF generation failed (pdf_base64 missing).');
    }

    const sourceIds = [
        ...new Set([
            ...bundle.employees.map((e) => e.documentId),
            ...bundle.certs.map((c) => c.documentId),
            ...bundle.onboarding.map((o) => o.documentId),
            ...bundle.leave.map((l) => l.documentId),
            ...bundle.payroll.map((p) => p.documentId),
            ...bundle.attendance.map((a) => a.documentId),
            ...bundle.performance.map((p) => p.documentId),
            ...bundle.transcripts.map((t) => t.documentId),
            ...resumes.map((r) => r.documentId),
        ]),
    ];

    const reportDoc = await saveGeneratedPdf(
        user,
        generatedPdf.pdf_base64,
        `HR_Workforce_Report_${stamp}`,
        'hr_report',
        sourceIds
    );

    return {
        ok: true,
        message: 'HR workforce report ready.',
        documentId: reportDoc.documentId,
        filename: reportDoc.originalFilename,
        classification: 'hr_report',
    };
}

async function generateHrShortlistDirect(
    user: AuthUser,
    limit: number,
    documentIds?: string[]
): Promise<HrReportExecuteResult> {
    const scopedIds = documentIds?.filter(Boolean);
    const resumes = await listTopResumesForUser(
        user,
        limit,
        scopedIds?.length ? scopedIds : undefined
    );
    const scored = resumes.filter((r) => Number.isFinite(r.cvScore));
    if (!scored.length) {
        return {
            ok: false,
            message:
                'No scored resumes in scope for a shortlist export. Upload CVs, wait for scores, then try again.',
        };
    }

    const { html } = buildShortlistHtml(scored.slice(0, limit));
    const stamp = new Date().toISOString().slice(0, 10);
    const generatedPdf = await generateComplianceReportPdf({
        html,
        filename: `HR_Shortlist_${stamp}.pdf`,
    });
    if (!generatedPdf.pdf_base64) {
        throw new Error('Shortlist PDF generation failed.');
    }

    const doc = await saveGeneratedPdf(
        user,
        generatedPdf.pdf_base64,
        `HR_Shortlist_Top${Math.min(limit, scored.length)}_${stamp}`,
        'hr_shortlist',
        scored.map((r) => r.documentId)
    );

    return {
        ok: true,
        message: `Shortlist PDF — top ${Math.min(limit, scored.length)} by CV score.`,
        documentId: doc.documentId,
        filename: doc.originalFilename,
        classification: 'hr_shortlist',
    };
}

async function generateHrSectionReportDirect(
    user: AuthUser,
    kind: HrSectionPdfKind,
    documentIds?: string[]
): Promise<HrReportExecuteResult> {
    const scopedIds = documentIds?.filter(Boolean);
    const bundle = await loadHrSnapshotBundle(user, {
        documentIds: scopedIds?.length ? scopedIds : undefined,
        maxDocs: 150,
    });
    const { html, empty } = buildSectionPdfHtml(kind, bundle);
    if (empty) {
        return {
            ok: false,
            message: `No ${kind} data in scope to put in a PDF. Upload related HR documents and try again.`,
        };
    }

    const stamp = new Date().toISOString().slice(0, 10);
    const generatedPdf = await generateComplianceReportPdf({
        html,
        filename: `HR_${kind}_${stamp}.pdf`,
    });
    if (!generatedPdf.pdf_base64) {
        throw new Error('Section PDF generation failed.');
    }

    const sourceIds = [
        ...bundle.certs,
        ...bundle.transcripts,
        ...bundle.performance,
        ...bundle.leave,
        ...bundle.onboarding,
        ...bundle.attendance,
        ...bundle.payroll,
    ].map((r) => r.documentId);

    const doc = await saveGeneratedPdf(
        user,
        generatedPdf.pdf_base64,
        `HR_${kind}_report_${stamp}`,
        'hr_report',
        [...new Set(sourceIds)]
    );

    return {
        ok: true,
        message: `${kind} PDF report ready.`,
        documentId: doc.documentId,
        filename: doc.originalFilename,
        classification: 'hr_report',
    };
}

function buildStructuredLetterQuestion(
    actionId: HrStructuredActionId,
    ctx: HrLetterContext
): string | null {
    const name = ctx.candidateName?.trim();
    if (!name) return null;
    const company = ctx.companyName?.trim() || 'Visibility Bots';
    const kind = LETTER_BY_ACTION[actionId];
    if (kind === 'joining') {
        return `Generate joining letter for ${name}. Company ${company}, title ${ctx.jobTitle || 'Software Engineer'}, joining ${ctx.effectiveDate || '2026-09-01'}, department ${ctx.department || 'Engineering'}`;
    }
    if (kind === 'internship') {
        return `Generate internship letter for ${name}. Company ${company}, title ${ctx.jobTitle || 'Intern'}, joining ${ctx.effectiveDate || '2026-09-01'}, duration ${ctx.duration || '3 months'}`;
    }
    if (kind === 'training_certificate') {
        return `Generate training certificate for ${name}. Company ${company}, training ${ctx.trainingName || 'Professional Development'}, duration ${ctx.duration || '4 weeks'}`;
    }
    return null;
}

/** Structured HR report/letter generation — explicit action id, no chat regex routing. */
export async function executeHrReportAction(params: {
    user: AuthUser;
    actionId: HrStructuredActionId;
    documentIds?: string[];
    shortlistLimit?: number;
    letterContext?: HrLetterContext;
}): Promise<HrReportExecuteResult> {
    const denied = await assertHrAgentAccess(params.user);
    if (denied) return denied;

    const scopedIds = params.documentIds?.filter(Boolean);

    switch (params.actionId) {
        case 'full_report':
            return generateHrWorkforceReportDirect(params.user, scopedIds);
        case 'shortlist':
            return generateHrShortlistDirect(
                params.user,
                Math.min(50, Math.max(1, params.shortlistLimit ?? 10)),
                scopedIds
            );
        case 'cert_report':
        case 'leave_report':
        case 'payroll_report':
        case 'performance_report': {
            const kind = SECTION_BY_ACTION[params.actionId];
            if (!kind) return { ok: false, message: 'Unknown section report.' };
            return generateHrSectionReportDirect(params.user, kind, scopedIds);
        }
        case 'joining_letter':
        case 'internship_letter':
        case 'training_certificate': {
            const question = buildStructuredLetterQuestion(
                params.actionId,
                params.letterContext || {}
            );
            if (!question) {
                return {
                    ok: false,
                    message: 'Candidate name is required for letter generation.',
                };
            }
            const letterResult = await tryHrExtraLetterCommand({
                user: params.user,
                question,
                phase3Agent: HR_AGENT,
                documentIds: scopedIds,
            });
            return actionResultToExecute(letterResult);
        }
        default:
            return { ok: false, message: 'Unknown report action.' };
    }
}
