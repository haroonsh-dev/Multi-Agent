import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import Document from '../models/Document';
import { AuthUser } from './accessScope';
import {
    COMPLIANCE_AGENT,
    analyzeMissingComplianceDocs,
    filterAttentionSnapshots,
    loadComplianceDocsForAnalytics,
    loadComplianceSnapshots,
    type ComplianceDocSnapshot,
} from './complianceAnalyticsService';
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
import { getOrgComplianceSettings } from './orgComplianceSettingsService';
import {
    extractDocumentNameTokens,
    matchDocumentIdsByNameTokens,
} from './financeAnalyticsService';
import { wantsAgentAnalyticsVisual, wantsAgentTextOnlyExplain } from './agentAnalyticsPolicy';
import {
    cleanAgentMarkdown,
    formatAgentDivider,
    formatAgentFooter,
    formatAgentHeading,
    formatAgentIntro,
    formatDate,
    formatLabeledBullets,
    formatRiskLabel,
    formatSection,
    formatStatusLabel as formatAgentStatusLabel,
} from './agentResponseFormat';

export function detectComplianceDocumentExplain(question: string, phase3Agent?: string): boolean {
    if (phase3Agent && phase3Agent !== COMPLIANCE_AGENT) return false;
    if (wantsAgentAnalyticsVisual(question, COMPLIANCE_AGENT)) return false;
    if (!wantsAgentTextOnlyExplain(question, COMPLIANCE_AGENT)) return false;
    return /\b(compliance|certificate|cert|audit|sop|iso|inspection|finding|ncr|capa)\b/i.test(
        question
    );
}

function formatComplianceSnapshotExplain(snap: ComplianceDocSnapshot): string {
    const certStatus =
        snap.certStatus === 'VALID'
            ? 'Valid'
            : snap.certStatus === 'EXPIRING_SOON'
              ? 'Expiring soon'
              : snap.certStatus === 'EXPIRED'
                ? 'Expired'
                : 'Unknown';

    const meta = formatLabeledBullets([
        { label: 'Document type', value: formatAgentStatusLabel(snap.classification) },
        { label: 'Certificate number', value: snap.certificateNumber || 'Not specified' },
        { label: 'Standard / regulation', value: snap.standardOrRegulation || 'Not specified' },
        { label: 'Issued to', value: snap.issuedTo || 'Not specified' },
        { label: 'Issuing authority', value: snap.issuingAuthority || 'Not specified' },
        { label: 'Expiry date', value: formatDate(snap.expiryDate) },
        { label: 'Certificate status', value: certStatus },
        { label: 'Compliance status', value: formatAgentStatusLabel(snap.normalizedStatus || snap.overallStatus) },
    ]);

    let md = `${formatAgentHeading(snap.filename, 3)}\n\n${meta}`;

    if (snap.daysUntilExpiry != null && snap.certStatus !== 'EXPIRED') {
        md += `\n\n${formatSection('Timeline', `${snap.daysUntilExpiry} day(s) until expiry.`)}`;
    }

    if (snap.findings.length) {
        const top = snap.findings.slice(0, 5).map((f) => {
            const sev = formatRiskLabel(f.severity || 'medium');
            return `- **${sev}:** ${f.description}`;
        });
        md += `\n\n**Key findings**\n\n${top.join('\n')}`;
    }

    return md;
}

export async function tryComplianceDocumentExplainCommand(params: {
    user: AuthUser;
    question: string;
    phase3Agent?: string;
    documentIds?: string[];
}): Promise<ComplianceChatActionResult> {
    if (!detectComplianceDocumentExplain(params.question, params.phase3Agent)) {
        return { handled: false };
    }

    const snapshots = await loadComplianceSnapshots(params.user, { documentIds: params.documentIds });
    if (!snapshots.length) {
        return {
            handled: true,
            answer:
                'No compliance documents in scope. Select certificates, audit reports, or SOPs in Document scope, then ask again.',
            citations: [],
        };
    }

    let targets = snapshots;
    const nameTokens = extractDocumentNameTokens(params.question);
    if (nameTokens.length) {
        const matchedIds = matchDocumentIdsByNameTokens(
            snapshots.map((s) => ({ documentId: s.documentId, originalFilename: s.filename })),
            params.question
        );
        if (matchedIds.length) {
            const idSet = new Set(matchedIds);
            targets = snapshots.filter((s) => idSet.has(s.documentId));
        }
    }

    if (targets.length > 1 && nameTokens.length === 0) {
        return {
            handled: true,
            answer: cleanAgentMarkdown(
                [
                    formatAgentHeading('Compliance overview', 2),
                    '',
                    `You have **${targets.length}** compliance document(s) in scope. Name a certificate or file to focus on one document.`,
                    formatAgentFooter('Example: “explain ISO 9001 certificate” or “overview of audit report”.'),
                ].join('\n')
            ),
            citations: targets.slice(0, 5).map((s) => ({
                documentId: s.documentId,
                filename: s.filename,
                documentType: s.classification,
                phase3Agent: COMPLIANCE_AGENT,
            })),
        };
    }

    const chosen = targets.length > 1 ? [targets[0]] : targets.slice(0, 1);
    let md = formatAgentIntro([
        formatAgentHeading('Compliance overview', 2),
        'Here is an overview of the compliance document in your scope:',
        formatAgentDivider(),
        formatComplianceSnapshotExplain(chosen[0]),
    ]);
    md += formatAgentFooter(
        'Ask for expiry chart, findings chart, or “compliance report” for a full PDF pack.'
    );

    return {
        handled: true,
        answer: cleanAgentMarkdown(md),
        citations: chosen.map((s) => ({
            documentId: s.documentId,
            filename: s.filename,
            documentType: s.classification,
            phase3Agent: COMPLIANCE_AGENT,
        })),
    };
}

export type ComplianceChatCitation = {
    documentId: string;
    filename?: string;
    score?: number;
    documentType?: string;
    phase3Agent?: string;
};

export type ComplianceChatActionResult = {
    handled: boolean;
    answer?: string;
    citations?: ComplianceChatCitation[];
};

const GENERATED_REPORT_TYPE = 'compliance_report';

export type ComplianceSectionKind = 'certificates' | 'findings' | 'register' | 'status';
export type ComplianceLetterKind = 'ncr' | 'capa' | 'certificate_of_compliance';

function pdfPreviewPath(documentId: string): string {
    return `/documents/${documentId}`;
}

function escapeHtml(value: string): string {
    return value
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function formatCertStatus(status: ComplianceDocSnapshot['certStatus']): string {
    return status.replace(/_/g, ' ');
}

function daysLabel(s: ComplianceDocSnapshot): string {
    if (s.daysUntilExpiry == null) return '—';
    return s.daysUntilExpiry < 0
        ? `${Math.abs(s.daysUntilExpiry)}d ago`
        : `${s.daysUntilExpiry}d left`;
}

/** Compliance Agent only — never fire for finance/HR/other agents. */
export function detectComplianceReportCommand(question: string, phase3Agent?: string): boolean {
    if (phase3Agent !== COMPLIANCE_AGENT && !/\bcompliance\s+agent\b/i.test(question)) return false;
    const q = question.toLowerCase().trim();
    if (!q) return false;

    const wantsGenerate =
        /\b(generate|create|make|draft|export|download|prepare|build)\b/.test(q) ||
        /\b(give\s+me|get\s+me)\b/.test(q);
    const wantsReport =
        /\bcompliance\s+report\b/.test(q) ||
        (/\breport\b/.test(q) &&
            !/\b(expense|offer|experience|extraction|email|hr|finance)\s+report\b/.test(q) &&
            (phase3Agent === COMPLIANCE_AGENT || /\bcompliance\b/.test(q)));

    return wantsGenerate && wantsReport;
}

export function detectComplianceSectionPdf(
    question: string,
    phase3Agent?: string
): ComplianceSectionKind | null {
    if (phase3Agent !== COMPLIANCE_AGENT && !/\bcompliance\b/i.test(question)) return null;
    const q = question.toLowerCase();
    const wants =
        /\b(generate|create|export|download|prepare|make|draft)\b/.test(q) ||
        /\b(give\s+me|get\s+me)\b/.test(q);
    if (!wants) return null;
    if (/\b(certificate|cert|expiry|expiring)\b/.test(q) && /\b(report|pdf|export|list)\b/.test(q)) {
        return 'certificates';
    }
    if (/\b(finding|findings|ncr|non[- ]?conformance)\b/.test(q) && /\b(report|pdf|export)\b/.test(q)) {
        return 'findings';
    }
    if (/\b(register|inventory|document\s+register|compliance\s+register)\b/.test(q)) {
        return 'register';
    }
    if (/\b(status\s+report|compliance\s+status\s+pdf)\b/.test(q)) return 'status';
    return null;
}

export function detectComplianceLetter(
    question: string,
    phase3Agent?: string
): ComplianceLetterKind | null {
    if (phase3Agent !== COMPLIANCE_AGENT && !/\bcompliance\b/i.test(question)) return null;
    const q = question.toLowerCase();
    const wants =
        /\b(generate|create|draft|write|prepare|make|issue|send)\b/.test(q) ||
        (phase3Agent === COMPLIANCE_AGENT && /\bletter\b/.test(q));
    if (!wants && !/\b(ncr|capa|corrective\s+action|non[- ]?conformance)\b/.test(q)) return null;

    if (
        /\b(ncr|non[- ]?conformance)\b/.test(q) &&
        (/\bletter\b/.test(q) || /\bnotice\b/.test(q) || /\b(generate|create|draft|issue)\b/.test(q))
    ) {
        return 'ncr';
    }
    if (
        /\b(capa|corrective\s+action)\b/.test(q) &&
        (/\bletter\b/.test(q) || /\brequest\b/.test(q) || /\b(generate|create|draft|issue)\b/.test(q))
    ) {
        return 'capa';
    }
    if (
        /\bcertificate\s+of\s+compliance\b/.test(q) ||
        (/\bcoc\b/.test(q) && /\b(letter|certificate|generate|draft)\b/.test(q))
    ) {
        return 'certificate_of_compliance';
    }
    return null;
}

export function detectComplianceExpiryAsk(question: string, phase3Agent?: string): boolean {
    if (phase3Agent !== COMPLIANCE_AGENT && !/\bcompliance\b/i.test(question)) return false;
    const q = question.toLowerCase();
    return (
        /\b(expir\w*|renewal|validit\w*)\b/.test(q) &&
        /\b(soon|next|within|list|show|what|which|alert|attention)\b/.test(q)
    );
}

export function detectComplianceMissingDocsAsk(question: string, phase3Agent?: string): boolean {
    if (phase3Agent !== COMPLIANCE_AGENT && !/\bcompliance\b/i.test(question)) return false;
    const q = question.toLowerCase();
    return (
        /\b(missing\s+doc|missing\s+compliance|incomplete\s+packet|required\s+docs?|packet\s+completeness)\b/.test(
            q
        ) ||
        /\bwhat\b.{0,40}\b(docs?|documents?)\b.{0,20}\bmissing\b/.test(q) ||
        /\bmissing\b.{0,30}\b(docs?|documents?|certificate|sop|audit|inspection|regulatory)\b/.test(q)
    );
}

function parseField(question: string, keys: string[]): string {
    for (const key of keys) {
        const re = new RegExp(`${key}\\s*[:=]?\\s*([^,\\n]+)`, 'i');
        const m = question.match(re);
        if (m?.[1]?.trim()) return m[1].trim().replace(/[.]+$/, '');
    }
    return '';
}

function parsePartyName(question: string): string | null {
    const patterns = [
        /(?:ncr|capa|non[- ]?conformance|corrective\s+action|certificate\s+of\s+compliance)\s+(?:letter|notice|request)?\s*(?:for|to|of)\s+([^,\n.]+)/i,
        /\b(?:for|to|of)\s+([A-Za-z][A-Za-z0-9\s.'-]{1,60}?)(?:\s*[,.]|\s+company\b|\s+regarding\b|$)/i,
    ];
    for (const re of patterns) {
        const m = question.match(re);
        const raw = m?.[1]?.trim();
        if (raw && raw.length >= 2 && !/^(top|the|a|an)$/i.test(raw)) {
            return raw.replace(/\b(company|regarding|reason|standard)\b.*$/i, '').trim();
        }
    }
    return null;
}

function formatAsOf(d: Date): string {
    return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'long', year: 'numeric' });
}

function formatStatusLabel(status: string): string {
    if (!status) return '—';
    return status.replace(/_/g, ' ');
}

function expiryHorizonBuckets(snapshots: ComplianceDocSnapshot[]): Array<{ label: string; count: number }> {
    const buckets = [
        { label: 'Already expired', count: 0 },
        { label: '0–30 days', count: 0 },
        { label: '31–60 days', count: 0 },
        { label: '61–90 days', count: 0 },
        { label: '90+ days (valid)', count: 0 },
        { label: 'Unknown expiry', count: 0 },
    ];
    for (const s of snapshots) {
        if (s.certStatus === 'EXPIRED' || (s.daysUntilExpiry != null && s.daysUntilExpiry < 0)) {
            buckets[0].count++;
        } else if (s.daysUntilExpiry == null && (s.certStatus === 'UNKNOWN' || !s.expiryDate)) {
            buckets[5].count++;
        } else if (s.daysUntilExpiry != null) {
            const d = s.daysUntilExpiry;
            if (d <= 30) buckets[1].count++;
            else if (d <= 60) buckets[2].count++;
            else if (d <= 90) buckets[3].count++;
            else buckets[4].count++;
        } else if (s.certStatus === 'VALID') {
            buckets[4].count++;
        } else if (s.certStatus === 'EXPIRING_SOON') {
            buckets[1].count++;
        }
    }
    return buckets;
}

type ComplianceFindingRow = {
    idx: number;
    severity: string;
    description: string;
    standard: string;
    sourceFile: string;
    docStatus: string;
};

function flattenFindings(snapshots: ComplianceDocSnapshot[], limit = 50): ComplianceFindingRow[] {
    const rows: ComplianceFindingRow[] = [];
    let idx = 0;
    for (const s of snapshots) {
        for (const f of s.findings) {
            idx++;
            rows.push({
                idx,
                severity: String(f.severity || '—').toUpperCase(),
                description: f.description,
                standard: s.standardOrRegulation || '—',
                sourceFile: s.filename,
                docStatus: formatStatusLabel(s.normalizedStatus || s.overallStatus),
            });
            if (rows.length >= limit) return rows;
        }
    }
    return rows;
}

function buildComplianceReportHtml(params: {
    snapshots: ComplianceDocSnapshot[];
    orgLabel?: string;
    title?: string;
    section?: ComplianceSectionKind | 'full';
    expiryWarningDays?: number;
    missingDocAnalysis?: ReturnType<typeof analyzeMissingComplianceDocs>;
}): { subject: string; html: string } {
    const { snapshots } = params;
    const section = params.section || 'full';
    const generatedAt = new Date();
    const asOf = formatAsOf(generatedAt);
    const dateStamp = generatedAt.toISOString().slice(0, 10);
    const company = params.orgLabel?.trim() || 'Visibility Docs';
    const warningDays = params.expiryWarningDays ?? 90;
    const reportRef = `COMP-REG-${dateStamp.replace(/-/g, '')}-${String(snapshots.length).padStart(2, '0')}`;

    const docTitle =
        params.title ||
        (section === 'certificates'
            ? 'Certificate & expiry register'
            : section === 'findings'
              ? 'Findings & CAPA register'
              : section === 'register'
                ? 'Compliance document register'
                : section === 'status'
                  ? 'Compliance status summary'
                  : 'Compliance status & register');

    const subject = `${docTitle} — ${dateStamp}`;

    const valid = snapshots.filter((s) => s.certStatus === 'VALID').length;
    const expiring = snapshots.filter((s) => s.certStatus === 'EXPIRING_SOON').length;
    const expired = snapshots.filter((s) => s.certStatus === 'EXPIRED').length;
    const unknownExpiry = snapshots.filter((s) => s.certStatus === 'UNKNOWN').length;
    const findingCount = snapshots.reduce((n, s) => n + s.findings.length, 0);
    const severityBuckets = snapshots.reduce(
        (acc, s) => {
            for (const f of s.findings || []) {
                const sev = String(f.severity || '').toUpperCase();
                acc[sev] = (acc[sev] || 0) + 1;
            }
            return acc;
        },
        {} as Record<string, number>
    );
    const criticalCount = severityBuckets.CRITICAL || 0;
    const majorCount = severityBuckets.MAJOR || 0;
    const minorCount = severityBuckets.MINOR || 0;
    const observationCount = severityBuckets.OBSERVATION || severityBuckets.INFO || 0;
    const attention = filterAttentionSnapshots(snapshots);
    const nonCompliant = snapshots.filter((s) => s.normalizedStatus === 'non_compliant').length;
    const partialCompliant = snapshots.filter((s) => s.normalizedStatus === 'partially_compliant').length;
    const compliant = snapshots.filter((s) => s.normalizedStatus === 'compliant').length;
    const notAssessed = snapshots.filter((s) => !s.normalizedStatus || s.normalizedStatus === 'not_assessed').length;
    const missingStandard = snapshots.filter((s) => !s.standardOrRegulation?.trim()).length;
    const missingExpiryField = snapshots.filter((s) => !s.expiryDate).length;
    const horizon = expiryHorizonBuckets(snapshots);
    const findingRows = flattenFindings(snapshots);
    const missing = params.missingDocAnalysis;

    const insights: string[] = [];
    if (expired) insights.push(`${expired} certificate(s) / licence(s) already expired — renew immediately.`);
    if (expiring) {
        insights.push(
            `${expiring} document(s) expiring within the org warning window (≤ ${warningDays} days).`
        );
    }
    if (unknownExpiry) {
        insights.push(`${unknownExpiry} document(s) have unknown expiry — treat as audit risk until reprocessed.`);
    }
    if (criticalCount) insights.push(`${criticalCount} critical finding(s) require CAPA / NCR follow-up.`);
    if (majorCount) insights.push(`${majorCount} major finding(s) should be tracked to closure.`);
    if (nonCompliant) insights.push(`${nonCompliant} document(s) marked non-compliant in extraction.`);
    if (missing?.missing.length) {
        insights.push(
            `${missing.missing.length} required document type(s) missing from scope: ${missing.missing.map((t) => t.replace(/_/g, ' ')).join(', ')}.`
        );
    }
    if (!insights.length) {
        insights.push('No urgent expiry, critical finding, or missing-type signals in current scope.');
    }
    insights.push(`Analysed ${snapshots.length} compliance document(s) · warning window ${warningDays} days.`);

    const actions: string[] = [];
    if (expired) actions.push(`Renew ${expired} expired certificate(s) before next audit cycle.`);
    if (criticalCount) actions.push(`Raise CAPA for ${criticalCount} critical finding(s) and assign owners.`);
    if (attention.length) {
        actions.push(`Review ${Math.min(attention.length, 10)} expiring/expired item(s) in Section 4.`);
    }
    if (missing?.missing.length) {
        actions.push(`Upload missing types: ${missing.missing.slice(0, 4).map((t) => t.replace(/_/g, ' ')).join(', ')}.`);
    }
    if (unknownExpiry) actions.push(`Reprocess ${unknownExpiry} file(s) with missing expiry dates.`);
    if (!actions.length) actions.push('Continue routine compliance monitoring — no critical actions flagged.');

    let registerRows = snapshots;
    if (section === 'certificates') {
        registerRows = snapshots.filter((s) => s.expiryDate != null || s.certStatus !== 'UNKNOWN');
    } else if (section === 'findings') {
        registerRows = snapshots.filter((s) => s.findings.length > 0);
    }

    const documentRegisterRows = registerRows
        .slice(0, 50)
        .map((s, i) => {
            const expiry = s.expiryDate ? s.expiryDate.toISOString().slice(0, 10) : '—';
            return `<tr>
  <td class="num">${i + 1}</td>
  <td>${escapeHtml(s.filename)}</td>
  <td>${escapeHtml(s.classification.replace(/_/g, ' '))}</td>
  <td>${escapeHtml(s.certificateNumber || '—')}</td>
  <td>${escapeHtml(formatCertStatus(s.certStatus))}</td>
  <td class="num">${escapeHtml(expiry)}</td>
  <td class="num">${escapeHtml(daysLabel(s))}</td>
  <td>${escapeHtml(formatStatusLabel(s.normalizedStatus || s.overallStatus))}</td>
  <td>${escapeHtml(s.standardOrRegulation || '—')}</td>
  <td>${escapeHtml(s.issuedTo || '—')}</td>
</tr>`;
        })
        .join('\n');

    const attentionRows = attention
        .slice(0, 20)
        .map(
            (s, i) => `<tr>
  <td class="num">${i + 1}</td>
  <td>${escapeHtml(s.filename)}</td>
  <td>${escapeHtml(s.certificateNumber || '—')}</td>
  <td>${escapeHtml(formatCertStatus(s.certStatus))}</td>
  <td class="num">${escapeHtml(daysLabel(s))}</td>
  <td>${escapeHtml(s.standardOrRegulation || '—')}</td>
  <td>${escapeHtml(s.issuingAuthority || '—')}</td>
</tr>`
        )
        .join('\n');

    const horizonRows = horizon
        .map(
            (b) => `<tr>
  <td>${escapeHtml(b.label)}</td>
  <td class="num">${b.count}</td>
</tr>`
        )
        .join('\n');

    const findingsTableRows = findingRows
        .map(
            (f) => `<tr>
  <td class="num">${f.idx}</td>
  <td>${escapeHtml(f.severity)}</td>
  <td>${escapeHtml(f.description)}</td>
  <td>${escapeHtml(f.standard)}</td>
  <td>${escapeHtml(f.sourceFile)}</td>
  <td>${escapeHtml(f.docStatus)}</td>
</tr>`
        )
        .join('\n');

    const missingDocRows =
        missing?.required
            .map(
                (t) => `<tr>
  <td>${escapeHtml(t.replace(/_/g, ' '))}</td>
  <td class="num">${missing.present.includes(t) ? missing.presentByType[t] || 1 : 0}</td>
  <td>${missing.present.includes(t) ? 'Present' : 'Missing'}</td>
</tr>`
            )
            .join('\n') || '';

    const showFull = section === 'full';
    const showStatus = section === 'full' || section === 'status';
    const showExpiry = section === 'full' || section === 'certificates' || section === 'status';
    const showFindings = section === 'full' || section === 'findings';
    const showRegister = section !== 'status';
    const showMissing = section === 'full' && missing && missing.required.length > 0;

    let sectionNum = 1;
    const nextSection = () => sectionNum++;

    const execSection =
        showFull || showStatus || section === 'findings'
            ? `<h2>${nextSection()}. Executive summary</h2>
  <div class="exec"><ol>${insights.slice(0, 6).map((i) => `<li>${escapeHtml(i)}</li>`).join('\n')}</ol></div>
  <h2>${nextSection()}. Recommended actions</h2>
  <div class="actions"><ul>${actions.slice(0, 5).map((a) => `<li>${escapeHtml(a)}</li>`).join('\n')}</ul></div>`
            : '';

    const postureSection = showStatus
        ? `<h2>${nextSection()}. Compliance posture</h2>
  <table class="summary">
    <thead><tr><th>Metric</th><th class="num">Count</th><th>Notes</th></tr></thead>
    <tbody>
      <tr><td>Documents in scope</td><td class="num">${snapshots.length}</td><td class="muted">Ready compliance files analysed</td></tr>
      <tr><td>Valid certificates</td><td class="num">${valid}</td><td class="muted">Within expiry window</td></tr>
      <tr><td>Expiring soon</td><td class="num">${expiring}</td><td class="muted">≤ ${warningDays} days warning</td></tr>
      <tr><td>Expired</td><td class="num">${expired}</td><td class="muted">Renew immediately</td></tr>
      <tr><td>Unknown expiry</td><td class="num">${unknownExpiry}</td><td class="muted">Audit risk — reprocess</td></tr>
      <tr><td>Compliant status</td><td class="num">${compliant}</td><td class="muted">Extracted overall status</td></tr>
      <tr><td>Non-compliant</td><td class="num">${nonCompliant}</td><td class="muted">Requires corrective action</td></tr>
      <tr><td>Partially compliant</td><td class="num">${partialCompliant}</td><td class="muted">Monitor / improve</td></tr>
      <tr><td>Not assessed</td><td class="num">${notAssessed}</td><td class="muted">Missing overall status</td></tr>
      <tr><td>Total findings</td><td class="num">${findingCount}</td><td class="muted">Critical ${criticalCount} · Major ${majorCount} · Minor ${minorCount}</td></tr>
    </tbody>
  </table>`
        : '';

    const expirySection = showExpiry
        ? `<h2>${nextSection()}. Expiry horizon</h2>
  <table class="data">
    <thead><tr><th>Horizon</th><th class="num">Documents</th></tr></thead>
    <tbody>${horizonRows}</tbody>
  </table>
  ${
      attention.length
          ? `<h2>${nextSection()}. Expiry attention list</h2>
  <p class="muted">Expired or expiring within ${warningDays}-day org warning window.</p>
  <table class="data">
    <thead><tr><th class="num">#</th><th>File</th><th>Ref #</th><th>Status</th><th class="num">Days</th><th>Standard</th><th>Authority</th></tr></thead>
    <tbody>${attentionRows}</tbody>
  </table>`
          : ''
  }`
        : '';

    const findingsSection = showFindings
        ? `<h2>${nextSection()}. Findings register</h2>
  <p class="muted">Extracted findings from audits, inspections, and quality reports in scope.</p>
  <table class="data">
    <thead><tr><th class="num">#</th><th>Severity</th><th>Description</th><th>Standard</th><th>Source file</th><th>Doc status</th></tr></thead>
    <tbody>${findingsTableRows || `<tr><td colspan="6" class="muted">No findings extracted in scope.</td></tr>`}</tbody>
  </table>`
        : '';

    const registerSection = showRegister
        ? `<h2>${nextSection()}. ${section === 'certificates' ? 'Certificate register' : section === 'findings' ? 'Documents with findings' : 'Compliance document register'}</h2>
  <table class="data">
    <thead>
      <tr>
        <th class="num">#</th><th>File</th><th>Type</th><th>Ref #</th><th>Cert status</th>
        <th class="num">Expiry</th><th class="num">Days</th><th>Overall</th><th>Standard</th><th>Issued to</th>
      </tr>
    </thead>
    <tbody>${documentRegisterRows || `<tr><td colspan="10" class="muted">No matching compliance documents in scope.</td></tr>`}</tbody>
  </table>`
        : '';

    const missingSection = showMissing
        ? `<h2>${nextSection()}. Required document types</h2>
  <p class="muted">Configured mandatory types vs documents in scope.</p>
  <table class="data">
    <thead><tr><th>Required type</th><th class="num">In scope</th><th>Status</th></tr></thead>
    <tbody>${missingDocRows}</tbody>
  </table>`
        : '';

    const appendixSection = showFull
        ? `<div class="appendix">
    <h2>Appendix A — Data quality</h2>
    <table class="data">
      <tbody>
        <tr><td>Missing expiry date</td><td class="num">${missingExpiryField}</td></tr>
        <tr><td>Unknown certificate status</td><td class="num">${unknownExpiry}</td></tr>
        <tr><td>Missing standard / regulation</td><td class="num">${missingStandard}</td></tr>
        <tr><td>Documents not assessed</td><td class="num">${notAssessed}</td></tr>
        <tr><td>Critical findings (open)</td><td class="num">${criticalCount}</td></tr>
        <tr><td>Major findings (open)</td><td class="num">${majorCount}</td></tr>
      </tbody>
    </table>
    <p class="muted" style="margin-top:8px;">Based on Compliance Agent AI extractions. Validate material items against source PDFs before external audit or regulatory submission. Expiry warning window: ${warningDays} days.</p>
  </div>`
        : '';

    const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<title>${escapeHtml(subject)}</title>
<style>
  @page { size: A4; margin: 16mm 14mm 18mm 14mm; }
  * { box-sizing: border-box; }
  body {
    font-family: "Helvetica Neue", Helvetica, Arial, sans-serif;
    color: #0f172a;
    margin: 0;
    padding: 0;
    font-size: 9.5pt;
    line-height: 1.4;
  }
  .letterhead {
    border-bottom: 2.5px solid #0f2744;
    padding-bottom: 10px;
    margin-bottom: 14px;
  }
  .company { font-size: 16pt; font-weight: 700; color: #0f2744; }
  .doc-title { font-size: 12.5pt; font-weight: 600; margin-top: 4px; color: #1e293b; }
  .meta-row { margin-top: 6px; font-size: 8.5pt; color: #475569; }
  .meta-row span { margin-right: 14px; }
  .badge {
    display: inline-block;
    font-size: 7.5pt;
    letter-spacing: .12em;
    text-transform: uppercase;
    border: 1px solid #94a3b8;
    padding: 2px 6px;
    color: #64748b;
    margin-top: 6px;
  }
  h2 {
    margin: 16px 0 6px;
    font-size: 10.5pt;
    color: #0f2744;
    border-bottom: 1px solid #cbd5e1;
    padding-bottom: 3px;
    text-transform: uppercase;
    letter-spacing: .04em;
  }
  .exec, .actions { margin: 0 0 10px; padding: 0; font-size: 9pt; color: #334155; }
  .exec ol, .actions ul { margin: 6px 0 0; padding-left: 18px; }
  .exec li, .actions li { margin: 3px 0; }
  table.summary, table.data { width: 100%; border-collapse: collapse; margin-top: 4px; }
  table.summary th, table.summary td, table.data th, table.data td {
    padding: 5px 7px;
    border-bottom: 1px solid #e2e8f0;
    font-size: 8.5pt;
    vertical-align: top;
  }
  table.summary th, table.data th {
    text-align: left;
    font-size: 7.5pt;
    text-transform: uppercase;
    letter-spacing: .03em;
    color: #475569;
    border-bottom: 1.5px solid #94a3b8;
    background: #f1f5f9;
  }
  td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; }
  tr.total td { border-top: 1.5px solid #0f2744; font-weight: 700; background: #f8fafc; }
  .muted { color: #64748b; font-size: 8pt; margin: 0 0 4px; }
  .appendix { margin-top: 16px; padding-top: 8px; border-top: 1px dashed #cbd5e1; }
  .footer {
    margin-top: 16px;
    padding-top: 8px;
    border-top: 1px solid #cbd5e1;
    font-size: 7.5pt;
    color: #64748b;
  }
</style>
</head>
<body>
  <div class="letterhead">
    <div class="company">${escapeHtml(company)}</div>
    <div class="doc-title">${escapeHtml(docTitle)}</div>
    <div class="meta-row">
      <span><b>Ref:</b> ${escapeHtml(reportRef)}</span>
      <span><b>As of:</b> ${escapeHtml(asOf)}</span>
      <span><b>Documents:</b> ${snapshots.length}</span>
      <span><b>Prepared by:</b> Compliance Agent</span>
    </div>
    <div class="badge">Confidential · Internal use</div>
  </div>

  ${execSection}
  ${postureSection}
  ${expirySection}
  ${findingsSection}
  ${registerSection}
  ${missingSection}
  ${appendixSection}

  <div class="footer">
    <div>${escapeHtml(reportRef)} · ${escapeHtml(company)} · Generated ${escapeHtml(generatedAt.toLocaleString())}</div>
    <div style="margin-top:4px;">Internal compliance monitoring pack — not a statutory certification. Reconcile critical items against source documents before external audit use.</div>
  </div>
</body>
</html>`;

    return { subject, html };
}

function buildComplianceLetterHtml(params: {
    kind: ComplianceLetterKind;
    partyName: string;
    company: string;
    standard?: string;
    finding?: string;
    dueDate?: string;
    reference?: string;
}): { subject: string; html: string; classification: string } {
    const today = new Date().toLocaleDateString('en-GB', {
        day: '2-digit',
        month: 'long',
        year: 'numeric',
    });
    const ref =
        params.reference ||
        `COMP/${params.kind.toUpperCase()}/${new Date().getFullYear()}/${Math.floor(Math.random() * 900 + 100)}`;

    const labels: Record<ComplianceLetterKind, string> = {
        ncr: 'Non-Conformance Notice (NCR)',
        capa: 'Corrective Action Request (CAPA)',
        certificate_of_compliance: 'Certificate of Compliance',
    };
    const classificationMap: Record<ComplianceLetterKind, string> = {
        ncr: 'ncr_letter',
        capa: 'capa_letter',
        certificate_of_compliance: 'certificate_of_compliance',
    };

    let body = '';
    if (params.kind === 'ncr') {
        body = `
<p>Dear <b>${escapeHtml(params.partyName)}</b>,</p>
<p>This notice records a non-conformance identified against <b>${escapeHtml(params.standard || 'applicable compliance requirements')}</b>.</p>
<p><b>Finding / deviation:</b> ${escapeHtml(params.finding || 'As discussed / documented in the referenced audit or inspection.')}</p>
<p>You are required to acknowledge this NCR and submit a proposed corrective action plan${params.dueDate ? ` by <b>${escapeHtml(params.dueDate)}</b>` : ''}.</p>
<p>Please treat this as an official compliance record.</p>`;
    } else if (params.kind === 'capa') {
        body = `
<p>Dear <b>${escapeHtml(params.partyName)}</b>,</p>
<p>Please initiate a Corrective and Preventive Action (CAPA) for the following issue under <b>${escapeHtml(params.standard || 'the applicable standard')}</b>.</p>
<p><b>Issue:</b> ${escapeHtml(params.finding || 'As identified in the compliance review.')}</p>
<p>Your CAPA response should include root cause analysis, containment, corrective action, and verification of effectiveness${params.dueDate ? `, due <b>${escapeHtml(params.dueDate)}</b>` : ''}.</p>`;
    } else {
        body = `
<div style="text-align:center;margin:24px 0 16px;">
  <div style="font-size:11pt;letter-spacing:.16em;text-transform:uppercase;color:#64748b;">Certificate of Compliance</div>
  <div style="font-size:18pt;font-weight:700;margin-top:8px;">${escapeHtml(params.company)}</div>
</div>
<p style="text-align:center;">This certifies that <b>${escapeHtml(params.partyName)}</b> has demonstrated compliance with
<b>${escapeHtml(params.standard || 'the stated requirements')}</b>${params.reference ? ` (ref ${escapeHtml(params.reference)})` : ''}.</p>
<p style="text-align:center;color:#475569;font-size:10pt;">Issued for official use. Validity is subject to ongoing conformance and supporting documentation on file.</p>`;
    }

    const subject = `${labels[params.kind]} — ${params.partyName}`;
    const html = `<!DOCTYPE html><html><head><meta charset="utf-8"/><title>${escapeHtml(subject)}</title>
<style>
  body{font-family:Georgia,"Times New Roman",serif;padding:48px 56px;color:#0f172a;line-height:1.55;font-size:11.5pt;}
  .header{border-bottom:2px solid #0f172a;padding-bottom:12px;margin-bottom:18px;}
  .company{font-size:18pt;font-weight:700;}
  .sub{color:#64748b;font-size:9pt;margin-top:4px;}
  .ref{margin:14px 0 22px;font-size:9.5pt;color:#475569;}
  .sign{margin-top:48px;}
  .sign-line{margin-top:36px;border-top:1px solid #94a3b8;width:240px;padding-top:6px;font-size:10pt;}
</style></head><body>
<div class="header">
  <div class="company">${escapeHtml(params.company)}</div>
  <div class="sub">Compliance · Official correspondence</div>
</div>
<div class="ref">Ref: ${escapeHtml(ref)} &nbsp;|&nbsp; Date: ${escapeHtml(today)} &nbsp;|&nbsp; ${escapeHtml(labels[params.kind])}</div>
${body}
<div class="sign">
  <p>Yours sincerely,</p>
  <div class="sign-line"><b>Compliance Officer</b><br/>${escapeHtml(params.company)}</div>
</div>
</body></html>`;

    return { subject, html, classification: classificationMap[params.kind] };
}

async function saveGeneratedCompliancePdf(
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
    const tmpPath = path.join(tmpDir, `compliance_${uuidv4()}.pdf`);
    fs.writeFileSync(tmpPath, buf);

    const documentId = `doc_${uuidv4()}`;
    const orgFolder = resolveOrgFolder(user.organizationId, user.userId);
    const destDir = getDocumentDir(orgFolder, documentId, { inbox: true });
    fs.mkdirSync(destDir, { recursive: true });

    const originalFilename = sanitizeFilename(`${filenameBase}.pdf`);
    const storedFilename = originalFilename;
    const storagePath = path.join(destDir, storedFilename);
    fs.renameSync(tmpPath, storagePath);

    const contentHash = crypto.createHash('sha256').update(buf).digest('hex');

    const doc = await Document.create({
        documentId,
        organizationId: user.organizationId || null,
        uploadedBy: user.userId,
        openRemoteUserId: (user as { openRemoteUserId?: string | null }).openRemoteUserId || null,
        originalFilename,
        storedFilename,
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
            source: 'compliance_chat',
            phase3Agent: COMPLIANCE_AGENT,
            generatedVia: 'compliance_chat',
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
        logger.warn(`Compliance PDF visibility failed for ${doc.documentId}: ${e?.message || e}`);
    }

    try {
        await applyDocumentTypeStorage(doc, classification);
        await doc.save();
    } catch (e: any) {
        logger.warn(`Compliance PDF storage relocate failed for ${doc.documentId}: ${e?.message || e}`);
    }

    return doc;
}

async function resolveSourceIds(
    user: AuthUser,
    documentIds?: string[]
): Promise<{ sourceIds: string[]; sourceDocs: Array<{ documentId: string; originalFilename: string; classification?: string | null }> }> {
    const scopedIds =
        documentIds?.length && documentIds.filter(Boolean).length
            ? documentIds.filter(Boolean)
            : undefined;
    const docs = await loadComplianceDocsForAnalytics(user, {
        documentIds: scopedIds,
        maxDocs: 80,
    });
    const sourceDocs = docs.filter((d) => String(d.classification || '') !== GENERATED_REPORT_TYPE);
    return { sourceIds: sourceDocs.map((d) => d.documentId), sourceDocs };
}

async function resolveOrgLabel(organizationId: string | null | undefined): Promise<string | undefined> {
    if (!organizationId) return undefined;
    try {
        const Organization = (await import('../models/Organization')).default;
        const org = await Organization.findOne({ organizationId })
            .select('organizationName')
            .lean();
        return org?.organizationName || undefined;
    } catch {
        return undefined;
    }
}

export async function tryComplianceReportCommand(params: {
    user: AuthUser;
    question: string;
    phase3Agent?: string;
    documentIds?: string[];
}): Promise<ComplianceChatActionResult> {
    if (!detectComplianceReportCommand(params.question, params.phase3Agent)) {
        return { handled: false };
    }

    if (params.user.role !== 'superAdmin') {
        const check = await requireAllowedAgent(params.user, COMPLIANCE_AGENT);
        if (!check.ok) return { handled: true, answer: check.message };
    }

    const { sourceIds, sourceDocs } = await resolveSourceIds(params.user, params.documentIds);
    if (!sourceIds.length) {
        return {
            handled: true,
            answer: [
                'No ready **compliance** documents in scope to report on.',
                'Upload certificates, audits, inspections, or SOPs, wait until status is **ready**, select them in Document scope, then say: `Generate compliance report`.',
            ].join('\n'),
        };
    }

    const snapshots = await loadComplianceSnapshots(params.user, { documentIds: sourceIds });
    const settings = await getOrgComplianceSettings(params.user.organizationId);
    const orgLabel = await resolveOrgLabel(params.user.organizationId);
    const missingDocAnalysis = analyzeMissingComplianceDocs(snapshots, settings.requiredDocTypes);

    const { html } = buildComplianceReportHtml({
        snapshots,
        orgLabel,
        section: 'full',
        expiryWarningDays: settings.expiryWarningDays,
        missingDocAnalysis,
    });
    const stamp = new Date().toISOString().slice(0, 10);
    const generatedPdf = await generateComplianceReportPdf({
        html,
        filename: `Compliance_Status_${stamp}.pdf`,
    });
    if (!generatedPdf.pdf_base64) {
        throw new Error('Compliance PDF generation failed (pdf_base64 missing).');
    }

    const reportDoc = await saveGeneratedCompliancePdf(
        params.user,
        generatedPdf.pdf_base64,
        `Compliance_Status_${stamp}`,
        GENERATED_REPORT_TYPE,
        sourceIds
    );

    const pathLink = pdfPreviewPath(reportDoc.documentId);
    const attention = filterAttentionSnapshots(snapshots).length;
    const findings = snapshots.reduce((n, s) => n + s.findings.length, 0);
    const expired = snapshots.filter((s) => s.certStatus === 'EXPIRED').length;
    const critical = snapshots.reduce((n, s) => {
        for (const f of s.findings) {
            if (String(f.severity || '').toUpperCase() === 'CRITICAL') n++;
        }
        return n;
    }, 0);

    return {
        handled: true,
        answer: [
            `**Compliance status pack** ready from **${sourceIds.length}** analysed file(s).`,
            '',
            `[Compliance status & register — ${stamp}](${pathLink})`,
            '',
            `Summary: **${snapshots.length}** docs · **${expired}** expired · **${attention}** expiry attention · **${findings}** findings` +
                (critical ? ` · **${critical}** critical` : '') +
                (missingDocAnalysis.missing.length
                    ? ` · **${missingDocAnalysis.missing.length}** required type(s) missing`
                    : ''),
            '',
            '_Includes executive summary, posture table, expiry horizon, findings register, document register, and data quality appendix._',
            '',
            '_Tip: `Generate certificate report`, `Generate findings report`, or `What is expiring soon?` for focused outputs._',
        ].join('\n'),
        citations: [
            {
                documentId: reportDoc.documentId,
                filename: reportDoc.originalFilename,
                documentType: GENERATED_REPORT_TYPE,
                phase3Agent: COMPLIANCE_AGENT,
            },
            ...sourceDocs.slice(0, 8).map((d) => ({
                documentId: d.documentId,
                filename: d.originalFilename,
                documentType: d.classification || 'compliance',
                phase3Agent: COMPLIANCE_AGENT,
            })),
        ],
    };
}

export async function tryComplianceSectionPdfCommand(params: {
    user: AuthUser;
    question: string;
    phase3Agent?: string;
    documentIds?: string[];
}): Promise<ComplianceChatActionResult> {
    const section = detectComplianceSectionPdf(params.question, params.phase3Agent);
    if (!section) return { handled: false };

    if (params.user.role !== 'superAdmin') {
        const check = await requireAllowedAgent(params.user, COMPLIANCE_AGENT);
        if (!check.ok) return { handled: true, answer: check.message };
    }

    const { sourceIds, sourceDocs } = await resolveSourceIds(params.user, params.documentIds);
    if (!sourceIds.length) {
        return {
            handled: true,
            answer: 'No ready compliance documents in scope. Upload & wait for **ready**, then retry.',
        };
    }

    const snapshots = await loadComplianceSnapshots(params.user, { documentIds: sourceIds });
    const settings = await getOrgComplianceSettings(params.user.organizationId);
    const orgLabel = await resolveOrgLabel(params.user.organizationId);
    const titles: Record<ComplianceSectionKind, string> = {
        certificates: 'Certificate & expiry register',
        findings: 'Findings & CAPA register',
        register: 'Compliance document register',
        status: 'Compliance status summary',
    };
    const { html } = buildComplianceReportHtml({
        snapshots,
        orgLabel,
        section,
        title: titles[section],
        expiryWarningDays: settings.expiryWarningDays,
        missingDocAnalysis: analyzeMissingComplianceDocs(snapshots, settings.requiredDocTypes),
    });
    const stamp = new Date().toISOString().slice(0, 10);
    const base = `Compliance_${section}_${stamp}`;
    const generatedPdf = await generateComplianceReportPdf({
        html,
        filename: `${base}.pdf`,
    });
    if (!generatedPdf.pdf_base64) throw new Error('Section PDF generation failed.');

    const doc = await saveGeneratedCompliancePdf(
        params.user,
        generatedPdf.pdf_base64,
        base,
        GENERATED_REPORT_TYPE,
        sourceIds
    );

    return {
        handled: true,
        answer: [
            `**${titles[section]}** ready (${sourceIds.length} source file(s)).`,
            '',
            `[${doc.originalFilename.replace(/\.pdf$/i, '')}](${pdfPreviewPath(doc.documentId)})`,
        ].join('\n'),
        citations: [
            {
                documentId: doc.documentId,
                filename: doc.originalFilename,
                documentType: GENERATED_REPORT_TYPE,
                phase3Agent: COMPLIANCE_AGENT,
            },
            ...sourceDocs.slice(0, 6).map((d) => ({
                documentId: d.documentId,
                filename: d.originalFilename,
                documentType: d.classification || 'compliance',
                phase3Agent: COMPLIANCE_AGENT,
            })),
        ],
    };
}

export async function tryComplianceLetterCommand(params: {
    user: AuthUser;
    question: string;
    phase3Agent?: string;
    documentIds?: string[];
}): Promise<ComplianceChatActionResult> {
    const kind = detectComplianceLetter(params.question, params.phase3Agent);
    if (!kind) return { handled: false };

    if (params.user.role !== 'superAdmin') {
        const check = await requireAllowedAgent(params.user, COMPLIANCE_AGENT);
        if (!check.ok) return { handled: true, answer: check.message };
    }

    const party =
        parsePartyName(params.question) ||
        parseField(params.question, ['party', 'vendor', 'supplier', 'entity', 'to']);
    const company =
        parseField(params.question, ['company', 'organisation', 'organization']) ||
        'Visibility Docs';
    const standard = parseField(params.question, ['standard', 'regulation', 'iso']);
    const finding = parseField(params.question, ['finding', 'reason', 'regarding', 'issue']);
    const dueDate = parseField(params.question, ['due', 'deadline', 'by']);

    if (!party) {
        const examples: Record<ComplianceLetterKind, string> = {
            ncr: '`Generate NCR letter for Acme Vendor. Company Visibility Bots, standard ISO 9001, finding missing calibration records, due 2026-09-01`',
            capa: '`Generate CAPA letter for Production Line 2. standard ISO 14001, issue effluent exceedance, due 2026-09-15`',
            certificate_of_compliance:
                '`Generate certificate of compliance for Acme Vendor. Company Visibility Bots, standard ISO 9001:2015`',
        };
        return {
            handled: true,
            answer: [
                `I can draft a professional **${kind.replace(/_/g, ' ')}**, but need the party / entity name.`,
                '',
                `Example: ${examples[kind]}`,
                '',
                '_Tip: select related audit/inspection docs in scope so findings can be referenced._',
            ].join('\n'),
        };
    }

    const { sourceIds } = await resolveSourceIds(params.user, params.documentIds);
    let prefillFinding = finding;
    let prefillStandard = standard;
    if (sourceIds.length) {
        const snaps = await loadComplianceSnapshots(params.user, { documentIds: sourceIds });
        if (!prefillFinding) {
            const withFindings = snaps.find((s) => s.findings.length);
            if (withFindings?.findings[0]) {
                prefillFinding = `${withFindings.findings[0].severity}: ${withFindings.findings[0].description}`;
            }
        }
        if (!prefillStandard) {
            prefillStandard = snaps.find((s) => s.standardOrRegulation)?.standardOrRegulation || '';
        }
    }

    const { html, classification } = buildComplianceLetterHtml({
        kind,
        partyName: party,
        company,
        standard: prefillStandard || undefined,
        finding: prefillFinding || undefined,
        dueDate: dueDate || undefined,
    });
    const stamp = new Date().toISOString().slice(0, 10);
    const generatedPdf = await generateComplianceReportPdf({
        html,
        filename: `${kind}_${stamp}.pdf`,
    });
    if (!generatedPdf.pdf_base64) throw new Error('Compliance letter PDF generation failed.');

    const doc = await saveGeneratedCompliancePdf(
        params.user,
        generatedPdf.pdf_base64,
        `${kind}_${party.replace(/\s+/g, '_')}_${stamp}`,
        classification,
        sourceIds
    );

    return {
        handled: true,
        answer: [
            `**${kind.replace(/_/g, ' ')}** ready for **${party}**.`,
            '',
            `[${doc.originalFilename.replace(/\.pdf$/i, '')}](${pdfPreviewPath(doc.documentId)})`,
            sourceIds.length
                ? `_Prefill used ${sourceIds.length} scoped compliance document(s)._`
                : '_Tip: select audit/inspection docs in scope for finding/standard prefill._',
        ].join('\n'),
        citations: [
            {
                documentId: doc.documentId,
                filename: doc.originalFilename,
                documentType: classification,
                phase3Agent: COMPLIANCE_AGENT,
            },
        ],
    };
}

export async function tryComplianceExpiryAlertCommand(params: {
    user: AuthUser;
    question: string;
    phase3Agent?: string;
    documentIds?: string[];
}): Promise<ComplianceChatActionResult> {
    if (!detectComplianceExpiryAsk(params.question, params.phase3Agent)) {
        return { handled: false };
    }
    if (params.user.role !== 'superAdmin') {
        const check = await requireAllowedAgent(params.user, COMPLIANCE_AGENT);
        if (!check.ok) return { handled: true, answer: check.message };
    }

    const { sourceIds, sourceDocs } = await resolveSourceIds(params.user, params.documentIds);
    if (!sourceIds.length) {
        return {
            handled: true,
            answer: 'No ready compliance documents in scope to check expiry.',
        };
    }

    const settings = await getOrgComplianceSettings(params.user.organizationId);
    const snapshots = await loadComplianceSnapshots(params.user, { documentIds: sourceIds });
    const attention = filterAttentionSnapshots(snapshots).sort(
        (a, b) => (a.daysUntilExpiry ?? 9999) - (b.daysUntilExpiry ?? 9999)
    );

    if (!attention.length) {
        return {
            handled: true,
            answer: [
                `No certificates / licences marked **expired** or **expiring soon** (warning window: **${settings.expiryWarningDays || 90}** days).`,
                '',
                `_${snapshots.length} document(s) analysed. Ask \`Generate certificate report\` for a printable PDF._`,
            ].join('\n'),
            citations: sourceDocs.slice(0, 6).map((d) => ({
                documentId: d.documentId,
                filename: d.originalFilename,
                documentType: d.classification || 'compliance',
                phase3Agent: COMPLIANCE_AGENT,
            })),
        };
    }

    const lines = attention.slice(0, 15).map((s, i) => {
        const std = s.standardOrRegulation ? ` · ${s.standardOrRegulation}` : '';
        const num = s.certificateNumber ? ` (${s.certificateNumber})` : '';
        return `${i + 1}. **${s.filename}**${num} — ${formatCertStatus(s.certStatus)} · ${daysLabel(s)}${std}`;
    });

    return {
        handled: true,
        answer: [
            `**Expiry attention** — ${attention.length} document(s) (warning ≤ **${settings.expiryWarningDays || 90}** days):`,
            '',
            ...lines,
            '',
            '_Ask `Generate certificate report` for a printable PDF of this list._',
        ].join('\n'),
        citations: attention.slice(0, 10).map((s) => ({
            documentId: s.documentId,
            filename: s.filename,
            documentType: s.classification,
            phase3Agent: COMPLIANCE_AGENT,
        })),
    };
}

export async function tryComplianceMissingDocsCommand(params: {
    user: AuthUser;
    question: string;
    phase3Agent?: string;
    documentIds?: string[];
}): Promise<ComplianceChatActionResult> {
    if (!detectComplianceMissingDocsAsk(params.question, params.phase3Agent)) {
        return { handled: false };
    }
    if (params.user.role !== 'superAdmin') {
        const check = await requireAllowedAgent(params.user, COMPLIANCE_AGENT);
        if (!check.ok) return { handled: true, answer: check.message };
    }

    const { sourceIds, sourceDocs } = await resolveSourceIds(params.user, params.documentIds);
    const settings = await getOrgComplianceSettings(params.user.organizationId);
    const snapshots = sourceIds.length
        ? await loadComplianceSnapshots(params.user, { documentIds: sourceIds })
        : [];
    const analysis = analyzeMissingComplianceDocs(snapshots, settings.requiredDocTypes);

    const presentLines = analysis.present.map(
        (t) => `- ✅ **${t.replace(/_/g, ' ')}** (${analysis.presentByType[t] || 0})`
    );
    const missingLines = analysis.missing.map((t) => `- ❌ **${t.replace(/_/g, ' ')}** — not in scope`);

    return {
        handled: true,
        answer: [
            '**Compliance packet completeness** (required types vs scoped documents):',
            '',
            presentLines.length ? '**Present:**' : '**Present:** _(none of the required types)_',
            ...(presentLines.length ? presentLines : []),
            '',
            missingLines.length ? '**Missing:**' : '**Missing:** none — packet looks complete for configured types.',
            ...(missingLines.length ? missingLines : []),
            '',
            `_Required types configurable via org compliance settings (default: ${analysis.required.join(', ')})._`,
            sourceIds.length
                ? `_Analysed ${sourceIds.length} ready compliance file(s)._`
                : '_No ready compliance files in scope yet — upload & wait for **ready**._',
        ].join('\n'),
        citations: sourceDocs.slice(0, 8).map((d) => ({
            documentId: d.documentId,
            filename: d.originalFilename,
            documentType: d.classification || 'compliance',
            phase3Agent: COMPLIANCE_AGENT,
        })),
    };
}

export function detectComplianceAuditEvidencePack(question: string, phase3Agent?: string): boolean {
    if (phase3Agent && phase3Agent !== COMPLIANCE_AGENT) return false;
    const q = question.toLowerCase();
    return (
        q.includes('audit evidence') ||
        q.includes('evidence pack') ||
        q.includes('evidence package') ||
        q.includes('auditor pack') ||
        q.includes('audit package')
    );
}

export function detectComplianceDeptGapAnalysis(question: string, phase3Agent?: string): boolean {
    if (phase3Agent && phase3Agent !== COMPLIANCE_AGENT) return false;
    const q = question.toLowerCase();
    return (
        q.includes('gap analysis') ||
        q.includes('framework gap') ||
        q.includes('compliance gap') ||
        q.includes('department gap') ||
        q.includes('iso gap')
    );
}

export async function tryComplianceAuditEvidencePackCommand(params: {
    user: AuthUser;
    question: string;
    phase3Agent?: string;
    documentIds?: string[];
}): Promise<ComplianceChatActionResult> {
    if (!detectComplianceAuditEvidencePack(params.question, params.phase3Agent)) {
        return { handled: false };
    }
    if (params.user.role !== 'superAdmin') {
        const check = await requireAllowedAgent(params.user, COMPLIANCE_AGENT);
        if (!check.ok) return { handled: true, answer: check.message };
    }

    const reportRes = await tryComplianceReportCommand({
        user: params.user,
        question: params.question,
        phase3Agent: COMPLIANCE_AGENT,
        documentIds: params.documentIds,
    });

    if (reportRes.handled && reportRes.answer) {
        return {
            handled: true,
            answer: `### 🛡️ Audit Evidence Package PDF Ready\n\n` + reportRes.answer,
            citations: reportRes.citations,
        };
    }

    return { handled: false };
}

export async function tryComplianceDeptGapAnalysisCommand(params: {
    user: AuthUser;
    question: string;
    phase3Agent?: string;
    documentIds?: string[];
}): Promise<ComplianceChatActionResult> {
    if (!detectComplianceDeptGapAnalysis(params.question, params.phase3Agent)) {
        return { handled: false };
    }
    if (params.user.role !== 'superAdmin') {
        const check = await requireAllowedAgent(params.user, COMPLIANCE_AGENT);
        if (!check.ok) return { handled: true, answer: check.message };
    }

    const { sourceIds, sourceDocs } = await resolveSourceIds(params.user, params.documentIds);
    const settings = await getOrgComplianceSettings(params.user.organizationId);
    const snapshots = sourceIds.length
        ? await loadComplianceSnapshots(params.user, { documentIds: sourceIds })
        : [];
    const analysis = analyzeMissingComplianceDocs(snapshots, settings.requiredDocTypes);

    let markdown = `### 📊 Department Compliance Framework Gap Analysis\n\n`;
    markdown += `Analyzed **${snapshots.length}** compliance file(s) against required frameworks:\n\n`;

    markdown += `| Framework / Doc Type | Document Status | Coverage Count | Risk Indicator |\n`;
    markdown += `| :--- | :--- | :--- | :--- |\n`;

    for (const reqType of analysis.required) {
        const count = analysis.presentByType[reqType] || 0;
        const statusBadge = count > 0 ? '🟢 COMPLIANT' : '🔴 MISSING GAP';
        const risk = count > 0 ? 'Low Risk' : 'High Audit Exposure';
        markdown += `| **${reqType.replace(/_/g, ' ').toUpperCase()}** | ${statusBadge} | ${count} file(s) | ${risk} |\n`;
    }

    markdown += `\n> **Gap Analysis Summary:** ${analysis.present.length} of ${analysis.required.length} required compliance standards present. ${analysis.missing.length} missing document category gaps identified.\n`;

    return {
        handled: true,
        answer: markdown,
        citations: sourceDocs.slice(0, 8).map((d) => ({
            documentId: d.documentId,
            filename: d.originalFilename,
            documentType: d.classification || 'compliance',
            phase3Agent: COMPLIANCE_AGENT,
        })),
    };
}

