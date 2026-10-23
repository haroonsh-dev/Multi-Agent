import Document from '../models/Document';
import { AuthUser } from './accessScope';
import { buildDocumentFilter } from './accessScope';
import { inferDocumentTypeFromFilename } from './documentStorage';
import { createExperienceLetterFromResume } from './experienceLetterGenerationService';
import { createOfferLetterFromResume, HR_AGENT, OfferPayload } from './offerLetterGenerationService';
import { getOfferLetterPrefill, getAiDocument, resolveAiOrganizationId } from './aiServiceClient';
import { requireAllowedAgent } from './planService';
import {
    extractDocumentNameTokens,
    matchDocumentIdsByNameTokens,
} from './financeAnalyticsService';
import {
    wantsAgentAnalyticsVisual,
    wantsAgentTextOnlyExplain,
} from './agentAnalyticsPolicy';

export function wantsHrAnalyticsVisual(question: string): boolean {
    return wantsAgentAnalyticsVisual(question, HR_AGENT);
}

/** @deprecated use wantsHrAnalyticsVisual */
export function wantsHrChartQuestion(question: string): boolean {
    return wantsHrAnalyticsVisual(question);
}

export function wantsHrTextOnlyExplain(question: string): boolean {
    return wantsAgentTextOnlyExplain(question, HR_AGENT);
}

export function wantsHrCandidateDeepDive(question: string): boolean {
    const q = question.toLowerCase();
    return (
        /\b(best|top|pick|find|select|choose)\b/.test(q) &&
        /\b(cv|resume|candidate)\b/.test(q) &&
        (/\b(overview|summary|profile|detail|full|deep dive)\b/.test(q) ||
            /\b(only|not others|don't show|do not show|single candidate)\b/.test(q) ||
            /\b(for|role|position|data science|engineer|developer|analyst)\b/.test(q))
    );
}

export function detectHrCvTableAsk(question: string, phase3Agent?: string): boolean {
    if (phase3Agent && phase3Agent !== HR_AGENT) return false;
    if (wantsHrAnalyticsVisual(question)) return false;
    const q = question.toLowerCase();
    return (
        /\btable\b/.test(q) &&
        (/\b(cv|resume|candidate|candidates|comparison|compare)\b/.test(q) ||
            /\b(comparison|compare)\b/.test(q))
    );
}

export function detectHrCvOverviewAsk(question: string, phase3Agent?: string): boolean {
    if (phase3Agent && phase3Agent !== HR_AGENT) return false;
    if (detectHrCvTableAsk(question, phase3Agent)) return false;
    if (wantsHrAnalyticsVisual(question)) return false;
    return wantsHrTextOnlyExplain(question) && /\b(cv|resume|candidate|candidates|hiring)\b/.test(question.toLowerCase());
}

export type CvProfile = {
    documentId: string;
    filename: string;
    candidateName: string;
    title: string;
    cvScore: number;
    summary: string;
    skills: string[];
    recommendation: string;
};

async function loadCvProfile(
    user: AuthUser,
    row: { documentId: string; originalFilename: string; pythonDocumentId?: string | null; cvScore: number }
): Promise<CvProfile> {
    let candidateName = '';
    let title = '';
    let summary = '';
    let skills: string[] = [];
    let recommendation = '';

    if (row.pythonDocumentId) {
        const orgId = resolveAiOrganizationId(user);
        try {
            const pre = await getOfferLetterPrefill(row.pythonDocumentId, orgId);
            candidateName = pre?.prefill?.candidate_name?.trim() || '';
            title = String(pre?.prefill?.job_title || '').trim();
        } catch {
            /* optional */
        }
        try {
            const { getDocumentExtractions } = await import('./aiServiceClient');
            let extractions = await getDocumentExtractions(row.pythonDocumentId, orgId);
            if (!extractions?.length) extractions = await getDocumentExtractions(row.pythonDocumentId, '');
            for (const ext of extractions || []) {
                const data = (ext.extracted_data || {}) as Record<string, unknown>;
                if (!candidateName && typeof data.candidate_name === 'string') {
                    candidateName = data.candidate_name;
                }
                if (!title && typeof data.current_title === 'string') title = data.current_title;
                if (typeof data.evaluation_summary === 'string' && data.evaluation_summary.trim()) {
                    summary = data.evaluation_summary.trim();
                }
                if (typeof data.recommendation === 'string' && data.recommendation.trim()) {
                    recommendation = data.recommendation.trim();
                }
                if (Array.isArray(data.skills)) {
                    skills = data.skills.map(String).filter(Boolean);
                } else if (typeof data.key_skills === 'string') {
                    skills = data.key_skills
                        .split(/[,;|]/)
                        .map((s) => s.trim())
                        .filter(Boolean);
                }
            }
        } catch {
            /* optional */
        }
    }

    if (!candidateName) {
        candidateName = row.originalFilename
            .replace(/\.(pdf|png|jpg|jpeg|webp)$/i, '')
            .replace(/[_-]+/g, ' ')
            .trim();
    }

    return {
        documentId: row.documentId,
        filename: row.originalFilename,
        candidateName,
        title: title || 'Not specified',
        cvScore: Number.isFinite(row.cvScore) ? row.cvScore : NaN,
        summary: summary || 'No evaluation summary extracted yet — open the CV and wait until processing finishes.',
        skills,
        recommendation,
    };
}

function extractRoleNeedles(question: string): string[] {
    const q = question.toLowerCase();
    const known = [
        'data science',
        'data scientist',
        'machine learning',
        'ai engineer',
        'software engineer',
        'full stack',
        'backend',
        'frontend',
        'developer',
        'analyst',
    ];
    return known.filter((r) => q.includes(r));
}

function roleFitScore(profile: CvProfile, roleNeedles: string[]): number {
    if (!roleNeedles.length) return 0;
    const hay = [
        profile.title,
        profile.summary,
        profile.skills.join(' '),
        profile.candidateName,
    ]
        .join(' ')
        .toLowerCase();
    return roleNeedles.reduce((acc, needle) => acc + (hay.includes(needle) ? 2 : 0), 0);
}

function parseSkillBullets(skills: string[]): string[] {
    if (!skills.length) return [];
    const flat = skills.join(', ').trim();
    if (!flat) return [];

    // Split "Category: items, NextCategory: items" into separate bullets
    const categorized = flat.split(/,\s*(?=[A-Za-z][A-Za-z0-9\s/&-]{0,36}:)/).map((s) => s.trim());
    if (categorized.length > 1) return categorized.slice(0, 10);

    if (skills.length > 1) return skills.slice(0, 12);

    // Long comma list — one bullet per major segment
    if (flat.length > 120) {
        return flat
            .split(/,\s+/)
            .map((s) => s.trim())
            .filter(Boolean)
            .slice(0, 8);
    }

    return [flat];
}

function formatSkillBullet(raw: string): string {
    const trimmed = raw.trim();
    const colonIdx = trimmed.indexOf(':');
    if (colonIdx > 0 && colonIdx < 48) {
        const label = trimmed.slice(0, colonIdx).trim();
        const detail = trimmed.slice(colonIdx + 1).trim();
        if (detail) return `- **${label}:** ${detail}`;
    }
    return `- ${trimmed}`;
}

function formatSkillsBlock(profile: CvProfile): string {
    const bullets = parseSkillBullets(profile.skills);
    if (!bullets.length) return '';
    return ['**Key skills**', '', ...bullets.map(formatSkillBullet)].join('\n');
}

function formatCvProfileSection(profile: CvProfile, index?: number): string {
    const heading =
        index != null ? `### ${index + 1}. ${profile.candidateName}` : `### ${profile.candidateName}`;

    const scoreLine = Number.isFinite(profile.cvScore)
        ? `- **CV score:** ${profile.cvScore}/100`
        : '- **CV score:** pending (still processing)';

    const metaLines = [scoreLine, `- **File:** ${profile.filename}`];
    if (profile.title && profile.title !== 'Not specified') {
        metaLines.push(`- **Current title:** ${profile.title}`);
    }

    const blocks: string[] = [heading, '', ...metaLines];

    if (profile.summary && !/No evaluation summary extracted yet/i.test(profile.summary)) {
        blocks.push('', '**Summary**', '', profile.summary.trim());
    }

    const skillsBlock = formatSkillsBlock(profile);
    if (skillsBlock) {
        blocks.push('', skillsBlock);
    }

    if (profile.recommendation) {
        blocks.push('', '**Recommendation**', '', profile.recommendation.trim());
    }

    return blocks.join('\n').trim();
}

function formatRoleFocusLabel(roleNeedles: string[]): string {
    if (!roleNeedles.length) return '';
    const label = roleNeedles
        .map((r) => r.replace(/\b\w/g, (c) => c.toUpperCase()))
        .join(' / ');
    return `**Role focus:** ${label}`;
}

export async function tryHrCvOverviewCommand(opts: {
    user: AuthUser;
    question: string;
    phase3Agent?: string;
    documentIds?: string[];
}): Promise<HrChatActionResult> {
    if (!detectHrCvOverviewAsk(opts.question, opts.phase3Agent)) {
        return { handled: false };
    }

    const scopedIds = opts.documentIds?.filter(Boolean);
    const pool = await listTopResumesForUser(
        opts.user,
        scopedIds?.length ? Math.max(scopedIds.length, 50) : 50,
        scopedIds
    );
    if (!pool.length) {
        return {
            handled: true,
            answer:
                'No processed resumes in scope. Select CVs in Document scope, wait until they are **ready**, then ask for an overview again.',
        };
    }

    let targets = pool;
    const nameTokens = extractDocumentNameTokens(opts.question);
    if (nameTokens.length) {
        const matchedIds = matchDocumentIdsByNameTokens(
            pool.map((r) => ({
                documentId: r.documentId,
                originalFilename: r.originalFilename,
            })),
            opts.question
        );
        if (matchedIds.length) {
            const idSet = new Set(matchedIds);
            targets = pool.filter((r) => idSet.has(r.documentId));
        }
    }

    const profiles = await Promise.all(targets.slice(0, 6).map((r) => loadCvProfile(opts.user, r)));
    const roleNeedles = extractRoleNeedles(opts.question);
    const singleCandidateAsk =
        wantsHrCandidateDeepDive(opts.question) ||
        /\b(only|not others|single candidate|don't show others|do not show others)\b/i.test(opts.question);

    let chosen = profiles;
    if (singleCandidateAsk && profiles.length > 1) {
        const ranked = [...profiles].sort((a, b) => {
            const roleA = roleFitScore(a, roleNeedles);
            const roleB = roleFitScore(b, roleNeedles);
            if (roleB !== roleA) return roleB - roleA;
            const sa = Number.isFinite(a.cvScore) ? a.cvScore : -1;
            const sb = Number.isFinite(b.cvScore) ? b.cvScore : -1;
            return sb - sa;
        });
        chosen = [ranked[0]];
    }

    const q = opts.question.toLowerCase();
    const comparing = profiles.length >= 2 && /\b(compare|comparison|versus|\bvs\.?\b|and)\b/.test(q);

    let md = comparing ? `## CV overview & comparison\n\n` : `## Candidate overview\n\n`;

    if (singleCandidateAsk && roleNeedles.length) {
        md += `${formatRoleFocusLabel(roleNeedles)}\n\n`;
        md += `**Selected candidate:** ${chosen[0].candidateName} — best match in your scoped CVs for this role based on extracted skills, title, and evaluation.\n\n`;
        md += `---\n\n`;
    } else if (roleNeedles.length) {
        md += `${formatRoleFocusLabel(roleNeedles)}\n\n`;
    } else if (singleCandidateAsk) {
        md += `Here is the candidate overview from your scoped CVs:\n\n---\n\n`;
    }

    chosen.forEach((p, i) => {
        md += `${formatCvProfileSection(p, chosen.length > 1 ? i : undefined)}\n\n`;
        if (i < chosen.length - 1) {
            md += `---\n\n`;
        }
    });

    if (comparing && chosen.length >= 2) {
        const scored = chosen.filter((p) => Number.isFinite(p.cvScore));
        if (scored.length >= 2) {
            const sorted = [...scored].sort((a, b) => b.cvScore - a.cvScore);
            md += `---\n\n**Quick score comparison**\n\n`;
            md += `- **${sorted[0].candidateName}** — ${sorted[0].cvScore}/100\n`;
            md += `- **${sorted[1].candidateName}** — ${sorted[1].cvScore}/100\n\n`;
        }
        md += `_Want a side-by-side table? Ask: “comparison table of these CVs”. For a chart: “show CV ranking chart”._\n`;
    } else if (!singleCandidateAsk && profiles.length > 1) {
        md += `_Ask about a specific name, or say “best CV for data science — full overview only” to focus on one candidate._\n`;
    }

    return {
        handled: true,
        answer: md.trim(),
        citations: chosen.map((p) => ({
            documentId: p.documentId,
            filename: p.filename,
            score: Number.isFinite(p.cvScore) ? p.cvScore / 100 : undefined,
            documentType: 'resume',
            phase3Agent: HR_AGENT,
        })),
    };
}

export async function tryHrCvComparisonTable(opts: {
    user: AuthUser;
    question: string;
    phase3Agent?: string;
    documentIds?: string[];
}): Promise<HrChatActionResult> {
    if (!detectHrCvTableAsk(opts.question, opts.phase3Agent)) {
        return { handled: false };
    }

    const scopedIds = opts.documentIds?.filter(Boolean);
    const pool = await listTopResumesForUser(
        opts.user,
        scopedIds?.length ? Math.max(scopedIds.length, 50) : 50,
        scopedIds
    );
    if (!pool.length) {
        return {
            handled: true,
            answer:
                'No processed resumes in scope. Select CVs in Document scope, wait until they are **ready**, then ask for a comparison table again.',
        };
    }

    let rows = pool;
    const nameTokens = extractDocumentNameTokens(opts.question);
    if (nameTokens.length) {
        const matchedIds = matchDocumentIdsByNameTokens(
            pool.map((r) => ({
                documentId: r.documentId,
                originalFilename: r.originalFilename,
            })),
            opts.question
        );
        if (matchedIds.length >= 2) {
            const idSet = new Set(matchedIds);
            rows = pool.filter((r) => idSet.has(r.documentId));
        } else if (matchedIds.length === 1) {
            rows = pool.filter((r) => matchedIds.includes(r.documentId));
        }
    }

    if (rows.length > 12) rows = rows.slice(0, 12);

    const profiles = await Promise.all(rows.map((r) => loadCvProfile(opts.user, r)));
    const scored = rows.filter((r) => Number.isFinite(r.cvScore));

    let md = `### CV comparison\n\n`;
    if (profiles.length >= 2) {
        md += `Here is a side-by-side comparison of **${profiles.length}** candidate(s) from your scoped CVs:\n\n`;
        profiles.slice(0, 4).forEach((p, i) => {
            const score = Number.isFinite(p.cvScore) ? `${p.cvScore}/100` : 'pending';
            md += `${i + 1}. **${p.candidateName}** — ${score}`;
            if (p.title && p.title !== 'Not specified') md += ` · ${p.title}`;
            md += `\n`;
            if (p.summary && !/No evaluation summary/.test(p.summary)) {
                md += `   ${p.summary.slice(0, 220)}${p.summary.length > 220 ? '…' : ''}\n`;
            }
        });
        md += `\n`;
    }

    md += `| # | Candidate | CV score | Title | File |\n| ---: | --- | ---: | --- | --- |\n`;
    profiles.forEach((p, i) => {
        const score = Number.isFinite(p.cvScore) ? `${p.cvScore}/100` : 'pending';
        md += `| ${i + 1} | ${p.candidateName.slice(0, 32)} | ${score} | ${p.title.slice(0, 24)} | ${p.filename.slice(0, 28)} |\n`;
    });
    if (scored.length >= 2) {
        const best = [...scored].sort((a, b) => b.cvScore - a.cvScore)[0];
        md += `\n**Highest score in this comparison:** ${best.originalFilename.replace(/_/g, ' ')} (${best.cvScore}/100).\n`;
    }

    return {
        handled: true,
        answer: md,
        citations: rows.map((r) => ({
            documentId: r.documentId,
            filename: r.originalFilename,
            score: Number.isFinite(r.cvScore) ? r.cvScore / 100 : undefined,
            documentType: 'resume',
            phase3Agent: HR_AGENT,
        })),
    };
}

type ResumeRow = Awaited<ReturnType<typeof listTopResumesForUser>>[number];

export type HrChatCitation = {
    documentId: string;
    filename?: string;
    score?: number;
    documentType?: string;
    phase3Agent?: string;
};

export type HrChatActionResult = {
    handled: boolean;
    answer?: string;
    citations?: HrChatCitation[];
};

function pdfPreviewPath(documentId: string): string {
    return `/documents/${documentId}`;
}

/** Chat link text: "Joining letter — Sharjeel Ahmed" (matches what the user asked to generate). */
function letterDocLink(kindLabel: string, personName: string, documentId: string): string {
    const name = personName.replace(/\s+/g, ' ').trim() || 'Candidate';
    const kind = kindLabel.replace(/\s+/g, ' ').trim();
    return `[${kind} — ${name}](${pdfPreviewPath(documentId)})`;
}

function personLabelFromResume(r: {
    originalFilename: string;
    candidateName?: string | null;
}): string {
    if (r.candidateName?.trim()) return r.candidateName.trim();
    const base = r.originalFilename.replace(/\.[^.]+$/, '');
    const cleaned = base
        .replace(/\b(resume|cv|curriculum|vitae|biodata)\b/gi, ' ')
        .replace(/[_-]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    return cleaned || base;
}

function parseTopLimit(question: string, defaultLimit = 10): number {
    const q = question.toLowerCase();
    const m = q.match(/top\s+(\d{1,2})/);
    if (m) return Math.max(1, Math.min(25, Number(m[1])));
    if (/\btop\s+ten\b/.test(q)) return 10;
    if (/\btop\s+five\b/.test(q)) return 5;
    return defaultLimit;
}

function hasExplicitTopN(question: string): boolean {
    return /\btop\s+(\d{1,2}|ten|five)\b/i.test(question);
}

function normalizePersonQuery(s: string): string {
    return s
        .toLowerCase()
        .replace(/\.(pdf|docx?)$/i, '')
        .replace(/[^a-z0-9\s]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function nameMatchesResume(query: string, filename: string, candidateName?: string | null): boolean {
    const q = normalizePersonQuery(query);
    if (!q || q.length < 2) return false;
    const hay = normalizePersonQuery(`${candidateName || ''} ${filename}`);
    if (hay.includes(q)) return true;
    const qTokens = q.split(' ').filter((t) => t.length > 1);
    if (qTokens.length >= 2 && qTokens.every((t) => hay.includes(t))) return true;
    if (qTokens.length === 1 && qTokens[0].length >= 3 && hay.includes(qTokens[0])) return true;
    return false;
}

/** Person named in chat (not "top N"). Supports "for / of / to Name". */
export function parseCandidateNameFromMessage(question: string): string | null {
    if (hasExplicitTopN(question)) return null;
    const q = question.trim();

    const patterns = [
        /(?:offer\s*letters?|offers?|experience\s*letters?)\s+(?:for|of|to)\s+(?!top\b)([^,\n]+?)(?:\s*[,.]|\s+company\b|\s+title\b|\s+salary\b|\s+join(?:ing)?\b|\s+from\b|\s+to\b|$)/i,
        /(?:generate|create|make|draft)\s+(?:an?\s+)?(?:offer|experience)\s+(?:letter\s+)?(?:for|of|to)\s+(?!top\b)([^,\n]+?)(?:\s*[,.]|\s+company\b|\s+title\b|\s+salary\b|$)/i,
        /\b(?:for|of)\s+(?:candidate\s+)?(?!top\b)([A-Za-z][A-Za-z\s.'-]{1,70}?)(?:\s*[,.]|\s+company\b|\s+title\b|\s+salary\b|\s+join(?:ing)?\b|\s+from\b|\s+to\b|$)/i,
    ];

    for (const re of patterns) {
        const m = q.match(re);
        const raw = m?.[1]?.trim();
        if (!raw) continue;
        const cleaned = raw
            .replace(/\b(company|title|salary|joining|monthly|annual)\b.*$/i, '')
            .trim();
        if (!cleaned || /^top\s*\d*$/i.test(cleaned)) continue;
        if (cleaned.length >= 2) return cleaned;
    }

    const quoted = q.match(/["']([^"']{2,80})["']/);
    if (quoted?.[1]?.trim()) return quoted[1].trim();

    return null;
}

/** Bare "cv.pdf" / filename reply after HR asks which candidate. */
export function parseResumeFilenameFromMessage(question: string): string | null {
    const q = question.trim();
    if (!q || q.length > 180) return null;
    if (/\b(generate|create|draft|offer|experience|letter|company|salary|title)\b/i.test(q)) {
        return null;
    }
    const m = q.match(/^["']?([^"'/\n]+\.(?:pdf|docx?))["']?$/i);
    return m?.[1]?.trim() || null;
}

async function enrichResumeCandidateNames(
    user: AuthUser,
    resumes: ResumeRow[]
): Promise<Array<ResumeRow & { candidateName?: string | null }>> {
    const orgId = resolveAiOrganizationId(user);
    const out: Array<ResumeRow & { candidateName?: string | null }> = [];
    await Promise.all(
        resumes.map(async (r) => {
            let candidateName: string | null = null;
            if (r.pythonDocumentId) {
                try {
                    const pre = await getOfferLetterPrefill(r.pythonDocumentId, orgId);
                    candidateName = pre?.prefill?.candidate_name?.trim() || null;
                } catch {
                    candidateName = null;
                }
            }
            out.push({ ...r, candidateName });
        })
    );
    return out.sort(
        (a, b) =>
            resumes.findIndex((x) => x.documentId === a.documentId) -
            resumes.findIndex((x) => x.documentId === b.documentId)
    );
}

type ResolveTargetsResult =
    | { ok: true; resumes: ResumeRow[]; note?: string }
    | { ok: false; message: string };

/** Letter generation: one named/scoped CV — not default top-3 unless user says "top N". */
async function resolveLetterTargets(params: {
    user: AuthUser;
    question: string;
    scopedIds?: string[];
    pool: ResumeRow[];
}): Promise<ResolveTargetsResult> {
    const { user, question, scopedIds, pool } = params;
    if (!pool.length) {
        return { ok: false, message: 'No processed resumes found in scope.' };
    }

    if (hasExplicitTopN(question)) {
        const n = parseTopLimit(question, 3);
        return {
            ok: true,
            resumes: pool.slice(0, n),
            note: `top **${Math.min(n, pool.length)}** by CV score`,
        };
    }

    // User replied with just a filename (e.g. clicked "cv.pdf")
    const bareFile = parseResumeFilenameFromMessage(question);
    if (bareFile) {
        const want = bareFile.toLowerCase();
        const byName = pool.filter((r) => r.originalFilename.toLowerCase() === want);
        if (byName.length === 1) {
            return {
                ok: true,
                resumes: [byName[0]],
                note: `**${byName[0].originalFilename}** (selected by filename)`,
            };
        }
        const soft = pool.filter((r) => r.originalFilename.toLowerCase().includes(want.replace(/\.(pdf|docx?)$/i, '')));
        if (soft.length === 1) {
            return {
                ok: true,
                resumes: [soft[0]],
                note: `**${soft[0].originalFilename}** (selected by filename)`,
            };
        }
    }

    if (scopedIds?.length === 1) {
        const one = pool.find((r) => r.documentId === scopedIds[0]);
        if (one) {
            return {
                ok: true,
                resumes: [one],
                note: `**${one.originalFilename}** (only resume in Document scope)`,
            };
        }
    }

    const named = parseCandidateNameFromMessage(question);
    if (named) {
        const enriched = await enrichResumeCandidateNames(user, pool);
        const matched = enriched.filter((r) => nameMatchesResume(named, r.originalFilename, r.candidateName));
        if (matched.length === 1) {
            const label = matched[0].candidateName || matched[0].originalFilename;
            return {
                ok: true,
                resumes: [matched[0]],
                note: `**${label}** (matched from your message)`,
            };
        }
        if (matched.length > 1) {
            const lines = matched.map(
                (r, i) => `${i + 1}. **${r.candidateName || r.originalFilename}** (${r.originalFilename})`
            );
            return {
                ok: false,
                message: [
                    `Several resumes match **${named}**. Select one CV in **Document scope** or be more specific:`,
                    '',
                    ...lines,
                ].join('\n'),
            };
        }

        // Name may live on a joining letter / employee file while the CV is still "cv.pdf"
        const relatedHit = await nameAppearsOnRelatedHrDoc(user, named, scopedIds);
        if (relatedHit && pool.length === 1) {
            return {
                ok: true,
                resumes: [pool[0]],
                note: `**${named}** → **${pool[0].originalFilename}** (only CV in scope)`,
            };
        }
        if (pool.length === 1) {
            return {
                ok: true,
                resumes: [pool[0]],
                note: `**${pool[0].originalFilename}** (only CV in scope — using for **${named}**)`,
            };
        }

        const resumeLines = pool.slice(0, 8).map((r, i) => `${i + 1}. **${r.originalFilename}**`);
        return {
            ok: false,
            message: [
                `No resume filename/extracted name matches **${named}** yet${relatedHit ? ` (found related file **${relatedHit}**)` : ''}.`,
                '',
                'Pick one CV by filename, or narrow **Document scope** to one resume:',
                ...resumeLines,
                '',
                'Tip: rename the CV to include the person (e.g. `Haroon_Shahid_CV.pdf`) or reprocess the resume so the candidate name is extracted.',
            ].join('\n'),
        };
    }

    if (pool.length === 1) {
        return {
            ok: true,
            resumes: [pool[0]],
            note: `**${pool[0].originalFilename}**`,
        };
    }

    if (scopedIds && scopedIds.length > 1) {
        return {
            ok: false,
            message: [
                `**${pool.length}** resumes are in scope (from ${scopedIds.length} files). I generate letters for **one person at a time**. Either:`,
                '- Select **only that candidate CV** in Document scope, or',
                '- Say their name: `Generate offer letter for Ahmed Khan. Company … title … salary PKR … joining …`',
                '',
                'To generate for several people at once, say explicitly: `Generate experience letters for top 3. …`',
            ].join('\n'),
        };
    }

    return {
        ok: false,
        message: [
            'Name the candidate or narrow **Document scope** to one CV.',
            '',
            'Example:',
            '`Generate offer letter for Sara Ali. Company Visibility Bots, title Software Engineer, salary PKR 80000 monthly, joining 2026-09-01`',
            '',
            'Also works: `Generate offer letter of Sara Ali. …`',
            '',
            'Bulk by score: `Generate experience letters for top 3. Company … title … from … to …`',
        ].join('\n'),
    };
}

async function nameAppearsOnRelatedHrDoc(
    user: AuthUser,
    named: string,
    scopedIds?: string[]
): Promise<string | null> {
    const filter = await buildDocumentFilter(user, {});
    const query: Record<string, unknown> = { ...filter };
    if (scopedIds?.length) query.documentId = { $in: scopedIds };
    const docs = await Document.find(query).select('originalFilename').limit(80).lean();
    const hit = docs.find((d) => nameMatchesResume(named, d.originalFilename || '', null));
    return hit?.originalFilename || null;
}

const HR_NON_RESUME_TYPES = new Set([
    'offer_letter',
    'experience_letter',
    'joining_letter',
    'internship_letter',
    'promotion_letter',
    'warning_letter',
    'relieving_letter',
    'training_certificate',
    'hr_shortlist',
    'employee_record',
    'employment_contract',
    'leave_application',
    'attendance',
    'payroll',
    'performance_review',
    'transcript',
]);

export function isResumeLike(doc: { classification?: string | null; originalFilename?: string }): boolean {
    const filename = doc.originalFilename || '';
    const inferred = inferDocumentTypeFromFilename(filename);
    if (inferred && inferred !== 'resume') return false;
    if (inferred === 'resume') return true;
    const c = String(doc.classification || '').toLowerCase();
    if (HR_NON_RESUME_TYPES.has(c) || /\bletter\b/.test(c)) return false;
    if (c === 'resume' || c === 'cv') return true;
    if (/\b(joining|offer|experience|promotion|relieving|internship|warning)\b.*\bletter\b/i.test(filename)) {
        return false;
    }
    return /\b(cv|cvs|resume|curriculum|biodata)\b/i.test(filename);
}

export async function resolveCvScoreForResume(
    user: AuthUser,
    doc: { documentId: string; metadata?: Record<string, unknown>; pythonDocumentId?: string | null }
): Promise<number> {
    const fromMeta = Number((doc.metadata as { cvScore?: number })?.cvScore);
    if (Number.isFinite(fromMeta)) return fromMeta;
    if (!doc.pythonDocumentId) return NaN;
    try {
        const orgId = resolveAiOrganizationId(user);
        const ai = await getAiDocument(doc.pythonDocumentId, orgId);
        let raw: unknown = ai?.cv_score;
        // Fallback: resume skill stores top-level cv_score in extractions (not only cv_evaluation).
        if (raw == null || raw === '') {
            const { getDocumentExtractions } = await import('./aiServiceClient');
            let extractions = await getDocumentExtractions(doc.pythonDocumentId, orgId);
            if (!extractions?.length && orgId) {
                extractions = await getDocumentExtractions(doc.pythonDocumentId, '');
            }
            for (const ext of extractions || []) {
                const data = (ext.extracted_data || {}) as Record<string, unknown>;
                if (data.cv_score != null) {
                    raw = data.cv_score;
                    break;
                }
                const ev = data.cv_evaluation;
                if (ev && typeof ev === 'object') {
                    const overall = (ev as Record<string, unknown>).overall_score;
                    if (overall != null) {
                        raw = overall;
                        break;
                    }
                }
            }
        }
        if (raw == null || raw === '') return NaN;
        const score = Number(raw);
        if (!Number.isFinite(score)) return NaN;
        await Document.updateOne({ documentId: doc.documentId }, { $set: { 'metadata.cvScore': score } });
        return score;
    } catch {
        return NaN;
    }
}

export async function listTopResumesForUser(
    user: AuthUser,
    limit: number,
    documentIds?: string[]
): Promise<
    Array<{
        documentId: string;
        originalFilename: string;
        cvScore: number;
        pythonDocumentId?: string | null;
    }>
> {
    const filter = await buildDocumentFilter(user, {});
    const query: Record<string, unknown> = {
        ...filter,
        pythonDocumentId: { $exists: true, $nin: [null, ''] },
    };
    if (documentIds?.length) {
        query.documentId = { $in: documentIds };
    }
    const docs = await Document.find(query)
        .select('documentId originalFilename classification metadata pythonDocumentId')
        .lean();

    const resumes = docs.filter((d) => isResumeLike(d));
    const withScores = await Promise.all(
        resumes.map(async (d) => {
            const cvScore = await resolveCvScoreForResume(user, d);
            return { doc: d, cvScore };
        })
    );
    withScores.sort((a, b) => {
        const sa = Number.isFinite(a.cvScore) ? a.cvScore : -1;
        const sb = Number.isFinite(b.cvScore) ? b.cvScore : -1;
        return sb - sa;
    });

    return withScores.slice(0, limit).map(({ doc: d, cvScore }) => ({
        documentId: d.documentId,
        originalFilename: d.originalFilename,
        cvScore,
        pythonDocumentId: d.pythonDocumentId,
    }));
}

function parseOfferFromMessage(question: string): OfferPayload {
    const q = question;
    const lower = q.toLowerCase();

    let company_name = 'Visibility Bots';
    const companyMatch = q.match(/company\s+["']?([^"',\n]+?)["']?(?:\s*,|\s+salary|\s+title|\s+join|\s+for\s+top|$)/i);
    if (companyMatch?.[1]?.trim()) company_name = companyMatch[1].trim();
    else if (/visibility\s*bots/i.test(q)) company_name = 'Visibility Bots';

    let job_title = '';
    const titleMatch =
        q.match(/(?:job\s+title|title|role|position)\s*[:\s]+["']?([^"',\n]+?)["']?(?:\s*,|\s+salary|\s+join|$)/i) ||
        q.match(/\bas\s+(?:an?\s+)?["']?([^"',\n]+?)["']?(?:\s*,|\s+salary|\s+join|$)/i);
    if (titleMatch?.[1]?.trim()) job_title = titleMatch[1].trim();

    let offered_salary: number | null = null;
    const salaryMatch = lower.match(/(?:salary|pay|compensation)\s*[:\s]*(?:pkr|rs\.?)?\s*([\d,]+)/i);
    if (salaryMatch) {
        offered_salary = Number(salaryMatch[1].replace(/,/g, ''));
    } else {
        const numMatch = lower.match(/\b(pkr|rs\.?)\s*([\d,]+)/i) || lower.match(/\b([\d,]{4,})\b/);
        if (numMatch) {
            const raw = numMatch[numMatch.length - 1].replace(/,/g, '');
            offered_salary = Number(raw);
        }
    }

    let joining_date = '';
    const joinMatch = q.match(/(?:join(?:ing)?|start)\s*(?:date|on)?\s*[:\s]*(\d{4}-\d{2}-\d{2})/i);
    if (joinMatch) joining_date = joinMatch[1];

    let offer_valid_until = '';
    const validMatch = q.match(/(?:valid\s+until|offer\s+valid)\s*[:\s]*(\d{4}-\d{2}-\d{2})/i);
    if (validMatch) offer_valid_until = validMatch[1];

    let currency = 'PKR';
    if (/\busd\b/i.test(q)) currency = 'USD';

    return {
        company_name,
        job_title: job_title || undefined,
        offered_salary,
        currency,
        pay_frequency: /monthly/i.test(q) ? 'Monthly' : 'Annual',
        joining_date: joining_date || undefined,
        offer_valid_until: offer_valid_until || undefined,
        probation_period: '3 months',
    };
}

function parseExperienceFromMessage(question: string): Record<string, unknown> {
    const q = question;
    let company_name = 'Company';
    const companyMatch = q.match(/company\s+["']?([^"',\n]+?)["']?(?:\s*,|\s+title|\s+from|\s+to|$)/i);
    if (companyMatch?.[1]?.trim()) company_name = companyMatch[1].trim();

    let job_title = '';
    const titleMatch = q.match(/(?:title|role|position|as)\s+["']?([^"',\n]+?)["']?(?:\s*,|\s+from|\s+to|$)/i);
    if (titleMatch?.[1]?.trim()) job_title = titleMatch[1].trim();

    let employment_from = '';
    const fromMatch = q.match(/(?:from|started|join(?:ed)?)\s*[:\s]*(\d{4}-\d{2}-\d{2})/i);
    if (fromMatch) employment_from = fromMatch[1];

    let employment_to = '';
    const toMatch = q.match(/(?:to|until|ended)\s*[:\s]*(\d{4}-\d{2}-\d{2})/i);
    if (toMatch) employment_to = toMatch[1];

    return {
        company_name,
        job_title: job_title || undefined,
        employment_from: employment_from || undefined,
        employment_to: employment_to || undefined,
        letter_date: new Date().toISOString().slice(0, 10),
    };
}

type HrCommand = 'list' | 'generate_offer' | 'generate_experience' | null;

export function detectHrCommand(question: string, phase3Agent?: string): HrCommand {
    const q = question.toLowerCase();
    const hrContext =
        phase3Agent === HR_AGENT ||
        /\b(hr\s+agent|offer\s+letter|experience\s+letter|candidates?|resumes?|cvs?)\b/i.test(question);

    if (!hrContext) return null;

    const wantsExperience =
        /\b(generate|create|make|draft)\b.*\b(experience\s*letters?|employment\s+certificate)\b/.test(q) ||
        /\b(experience\s*letters?|employment\s+certificate)\b.*\b(generate|create|make|draft|for|of)\b/.test(q) ||
        (phase3Agent === HR_AGENT &&
            /\b(experience\s*letters?|employment\s+certificate)\b/.test(q) &&
            /\b(for|of)\b/.test(q) &&
            !/\brelieving\s+letter\b/.test(q));

    const wantsOffer =
        !wantsExperience &&
        (/\b(generate|create|make|draft)\b.*\b(offer\s*letters?|offers?)\b/.test(q) ||
            /\b(offer\s*letters?|offers?)\b.*\b(generate|create|make|draft|for|of)\b/.test(q) ||
            (phase3Agent === HR_AGENT &&
                /\boffer\s*letters?\b/.test(q) &&
                /\b(for|of)\b/.test(q) &&
                !/\bexperience\b/.test(q)));

    // Follow-up: user tapped a CV filename (e.g. "cv.pdf") — treat as offer-letter target pick
    if (
        !wantsExperience &&
        !wantsOffer &&
        phase3Agent === HR_AGENT &&
        parseResumeFilenameFromMessage(question) &&
        /\b(cv|resume|curriculum|biodata)\b/i.test(question)
    ) {
        return 'generate_offer';
    }
    if (
        !wantsExperience &&
        !wantsOffer &&
        phase3Agent === HR_AGENT &&
        parseResumeFilenameFromMessage(question)
    ) {
        return 'generate_offer';
    }

    // If the query contains specific candidate search/filtering criteria (e.g. university, degree, field of study, skills, student, location),
    // do NOT hijack it with the canned top-scored resumes overview — let RAG / AI search read the CV contents.
    const hasCandidateSearchCriteria =
        /\b(who|from|form|with|in|having|degree|bachelor|master|phd|university|unverity|college|skills?|experience\s+in|worked|location|city|student|stuent|engineer|developer|faisalabad|fasialiabd|lahore|karachi|islamabad|gpa|major)\b/i.test(
            q
        ) ||
        /\b(studied|graduated|knowledge|proficient|expert|specialist)\b/i.test(q) ||
        /\b(which|where|whose)\b/i.test(q);

    const wantsList =
        !hasCandidateSearchCriteria &&
        /\b(list|show|give|top|best|rank|shortlist)\b/.test(q) &&
        /\b(resumes?|cvs?|candidates?)\b/.test(q) &&
        !wantsOffer &&
        !wantsExperience;

    if (wantsExperience) return 'generate_experience';
    if (wantsOffer) return 'generate_offer';
    if (wantsList) return 'list';
    if (
        !hasCandidateSearchCriteria &&
        /\btop\s+\d+\b/.test(q) &&
        /\b(candidate|resume|cv)\b/.test(q) &&
        !wantsOffer &&
        !wantsExperience
    ) {
        return 'list';
    }
    return null;
}

export async function tryHrChatCommand(params: {
    user: AuthUser;
    question: string;
    phase3Agent?: string;
    documentIds?: string[];
}): Promise<HrChatActionResult> {
    if (params.phase3Agent && params.phase3Agent !== HR_AGENT) {
        return { handled: false };
    }

    if (params.phase3Agent !== HR_AGENT) {
        // Outside HR agent (e.g. All Documents mode), only trigger for explicit letter generation or explicit ranking
        const explicitHrAction =
            /\b(offer\s*letter|experience\s*letter|employment\s+certificate)\b/i.test(params.question) ||
            (/\b(rank|top\s+\d+)\b/i.test(params.question) && /\b(resumes?|cvs?|candidates?)\b/i.test(params.question));
        if (!explicitHrAction) {
            return { handled: false };
        }
    }

    const cmd = detectHrCommand(params.question, params.phase3Agent);
    if (!cmd) return { handled: false };

    if (params.user.role !== 'superAdmin') {
        const check = await requireAllowedAgent(params.user, HR_AGENT);
        if (!check.ok) {
            return {
                handled: true,
                answer: check.message,
            };
        }
    }

    const scopedIds =
        params.documentIds?.length && params.documentIds.filter(Boolean).length
            ? params.documentIds.filter(Boolean)
            : undefined;

    const scopeNote = scopedIds?.length
        ? ` (from **${scopedIds.length}** resume(s) in chat scope)`
        : '';

    const pool = await listTopResumesForUser(
        params.user,
        scopedIds?.length ? Math.max(scopedIds.length, 50) : 50,
        scopedIds
    );

    if (!pool.length) {
        return {
            handled: true,
            answer:
                `No processed resumes found${scopeNote}. Upload CVs, wait until **ready** (with CV scores), select them in **Document scope** if needed, then try again.`,
        };
    }

    const listLimit = parseTopLimit(params.question, 10);
    const top = pool.slice(0, listLimit);

    if (cmd === 'list') {
        const scoredCount = top.filter((r) => Number.isFinite(r.cvScore)).length;
        const title =
            scoredCount > 0
                ? `Here are the top ${top.length} resumes${scopeNote} by CV score:`
                : `Here are ${top.length} resume(s)${scopeNote}. Scores aren’t ready yet — open a CV and wait for processing:`;
        const lines = top.map((r, i) => {
            const score = Number.isFinite(r.cvScore) ? `${r.cvScore}/100` : 'pending';
            return `${i + 1}. **${r.originalFilename}** — ${scoredCount > 0 ? score : 'pending'}`;
        });
        return {
            handled: true,
            answer: [
                title,
                '',
                ...lines,
                '',
                'Want a chart, an offer letter, or an experience letter for someone? Say their name or select one CV in scope.',
            ].join('\n'),
            citations: top.map((r) => ({
                documentId: r.documentId,
                filename: r.originalFilename,
                score: Number.isFinite(r.cvScore) ? r.cvScore / 100 : undefined,
                documentType: 'resume',
                phase3Agent: HR_AGENT,
            })),
        };
    }

    if (cmd === 'generate_experience') {
        const resolved = await resolveLetterTargets({
            user: params.user,
            question: params.question,
            scopedIds,
            pool,
        });
        if (!resolved.ok) {
            return { handled: true, answer: resolved.message };
        }
        const letterTargets = resolved.resumes;
        const targetNote = resolved.note ? ` for ${resolved.note}` : '';

        const exp = parseExperienceFromMessage(params.question);

        // Prefill missing title/dates from the first resume's extraction so a simple
        // "Generate experience letter" click actually produces a PDF.
        if ((!exp.job_title || !exp.employment_from || !exp.employment_to) && letterTargets[0]?.pythonDocumentId) {
            try {
                const { getExperienceLetterPrefill, resolveAiOrganizationId } = await import(
                    './aiServiceClient'
                );
                const orgId = resolveAiOrganizationId(params.user);
                const pre = await getExperienceLetterPrefill(letterTargets[0].pythonDocumentId, orgId);
                const p = pre?.prefill || {};
                if (!exp.job_title && p.job_title) exp.job_title = p.job_title;
                if (!exp.company_name || exp.company_name === 'Company') {
                    // keep message company if user set one
                }
                // Dates are often absent on resumes — use safe defaults when user omitted them
            } catch {
                /* ignore prefill errors; fall through to prompts */
            }
        }

        if (!exp.job_title) exp.job_title = 'Employee';
        if (!exp.employment_from) {
            // Default: 1 year ago → today if user didn't specify (still generates a usable letter)
            const to = new Date();
            const from = new Date();
            from.setFullYear(from.getFullYear() - 1);
            exp.employment_from = from.toISOString().slice(0, 10);
            if (!exp.employment_to) exp.employment_to = to.toISOString().slice(0, 10);
        }
        if (!exp.employment_to) {
            exp.employment_to = new Date().toISOString().slice(0, 10);
        }

        const results: string[] = [];
        const citations: HrChatCitation[] = [];
        let ok = 0;
        let fail = 0;

        for (const r of letterTargets) {
            try {
                const { letterDoc } = await createExperienceLetterFromResume(params.user, r.documentId, {
                    ...exp,
                    employee_name: undefined,
                });
                ok += 1;
                const person = personLabelFromResume(r as { originalFilename: string; candidateName?: string | null });
                results.push(`- ${letterDocLink('Experience letter', person, letterDoc.documentId)}`);
                citations.push({
                    documentId: letterDoc.documentId,
                    filename: `Experience letter — ${person}.pdf`,
                    documentType: 'experience_letter',
                    phase3Agent: HR_AGENT,
                });
            } catch (e: any) {
                fail += 1;
                results.push(`- Failed for **${r.originalFilename}**: ${e?.message || e}`);
            }
        }

        return {
            handled: true,
            answer: [
                `**Experience letter generation complete** (${ok} created${fail ? `, ${fail} failed` : ''})${targetNote}${scopeNote}.`,
                '',
                ...results,
                '',
                'Use the links above to preview and print each PDF.',
                '',
                '_Tip: add `title …, from YYYY-MM-DD to YYYY-MM-DD` for exact employment dates._',
            ].join('\n'),
            citations,
        };
    }

    const resolved = await resolveLetterTargets({
        user: params.user,
        question: params.question,
        scopedIds,
        pool,
    });
    if (!resolved.ok) {
        return { handled: true, answer: resolved.message };
    }
    const letterTargets = resolved.resumes;
    const targetNote = resolved.note ? ` for ${resolved.note}` : '';

    const offer = parseOfferFromMessage(params.question);
    const missing: string[] = [];
    if (!offer.job_title) missing.push('job title (e.g. title AI Engineer Intern)');
    if (offer.offered_salary == null || Number.isNaN(Number(offer.offered_salary))) {
        missing.push('salary (e.g. salary PKR 80000 monthly)');
    }
    if (!offer.joining_date) missing.push('joining date (e.g. joining 2026-09-01)');

    if (missing.length) {
        return {
            handled: true,
            answer: [
                `I can generate an offer letter${targetNote}${scopeNote}, but I need:`,
                ...missing.map((m) => `- ${m}`),
                '',
                'Example:',
                '`Generate offer letter for Ahmed Khan. Company Visibility Bots, title AI Engineer Intern, salary PKR 80000 monthly, joining 2026-09-01`',
            ].join('\n'),
        };
    }

    const results: string[] = [];
    const citations: HrChatCitation[] = [];
    let ok = 0;
    let fail = 0;

    for (const r of letterTargets) {
        try {
            const { offerDoc } = await createOfferLetterFromResume(params.user, r.documentId, {
                ...offer,
                candidate_name: undefined,
            });
            ok += 1;
            const person = personLabelFromResume(r as { originalFilename: string; candidateName?: string | null });
            results.push(`- ${letterDocLink('Offer letter', person, offerDoc.documentId)}`);
            citations.push({
                documentId: offerDoc.documentId,
                filename: `Offer letter — ${person}.pdf`,
                documentType: 'offer_letter',
                phase3Agent: HR_AGENT,
            });
        } catch (e: any) {
            fail += 1;
            results.push(`- Failed for **${r.originalFilename}**: ${e?.message || e}`);
        }
    }

    return {
        handled: true,
        answer: [
            `**Offer letter generation complete** (${ok} created${fail ? `, ${fail} failed` : ''})${targetNote}${scopeNote}.`,
            '',
            ...results,
            '',
            'Use the links above to preview and print each PDF.',
        ].join('\n'),
        citations,
    };
}
