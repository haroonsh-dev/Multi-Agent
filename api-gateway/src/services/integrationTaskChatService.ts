/**
 * Universal integration task chat — query/create/assign synced task records (Path 2).
 * Provider adapters (ClickUp / Slack) stay behind the scenes; chat is provider-agnostic.
 */
import Document from '../models/Document';
import IntegrationConnection, { type IIntegrationConnection } from '../models/IntegrationConnection';
import { AuthUser, buildDocumentFilter } from './accessScope';
import { formatAgentHeading, formatAgentIntro } from './agentResponseFormat';
import {
    assignTaskForConnection,
    connectionCredsForProvider,
    createTaskForConnection,
    listAssignableMembersForConnection,
    refreshTaskRecordAfterWrite,
    type TaskProviderMember as ProviderMember,
} from './taskProviderAdapter';

export type IntegrationTaskRow = {
    documentId: string;
    taskId: string;
    name: string;
    status: string;
    assignees: string;
    dueDate: string;
    listName: string;
    url: string;
    updatedAt: string;
};

export type IntegrationTaskChatResult = {
    handled: boolean;
    answer?: string;
    citations?: Array<{
        documentId: string;
        filename?: string;
        documentType?: string;
        phase3Agent?: string;
    }>;
};

/** Product agent names — never treat as synced task-name filters. */
const AGENT_PRODUCT_NAMES =
    /\b(hr|finance|legal|compliance|procurement|other)\s*agents?\b|\bagents?\s+(hr|finance|legal|compliance)\b/i;

const HR_TASK_HINTS =
    /\b(candidate|candidates|resume|cv|hiring|recruit|interview|employee|hr|engineer|offer|onboard)\b/i;

function normalizeAssignee(raw: unknown): string {
    if (!raw || typeof raw !== 'object') return '';
    const o = raw as Record<string, unknown>;
    const username = String(o.username || o.name || '').trim();
    const email = String(o.email || '').trim();
    if (username && email) return `${username} (${email})`;
    return username || email || String(o.id || '').trim();
}

export function formatTaskAssignees(assignees: unknown): string {
    if (!assignees) return 'Unassigned';
    if (Array.isArray(assignees)) {
        const names = assignees.map(normalizeAssignee).filter(Boolean);
        return names.length ? names.join(', ') : 'Unassigned';
    }
    if (typeof assignees === 'string' && assignees.trim()) return assignees.trim();
    return 'Unassigned';
}

function formatDueDate(raw: unknown): string {
    if (raw == null || raw === '') return '—';
    const n = Number(raw);
    if (Number.isFinite(n) && n > 0) {
        const d = n > 1e12 ? new Date(n) : new Date(n * 1000);
        if (!Number.isNaN(d.getTime())) return d.toISOString().slice(0, 10);
    }
    const s = String(raw).trim();
    return s || '—';
}

function readStructuredPayload(meta: Record<string, unknown>): Record<string, unknown> {
    const data = meta.structuredData ?? meta.structuredPayload ?? meta.data;
    return data && typeof data === 'object' && !Array.isArray(data)
        ? (data as Record<string, unknown>)
        : {};
}

function readExternalRef(meta: Record<string, unknown>): Record<string, unknown> {
    const ext = meta.integrationExternalRef ?? meta.externalRef;
    return ext && typeof ext === 'object' && !Array.isArray(ext)
        ? (ext as Record<string, unknown>)
        : {};
}

export function parseIntegrationTaskFromDoc(doc: {
    documentId: string;
    originalFilename?: string | null;
    metadata?: Record<string, unknown> | null;
    updatedAt?: Date;
}): IntegrationTaskRow | null {
    const meta = (doc.metadata || {}) as Record<string, unknown>;
    const data = readStructuredPayload(meta);
    const ext = readExternalRef(meta);

    const taskId = String(
        data.taskId ||
            data.id ||
            ext.clickupTaskId ||
            ext.slackMessageTs ||
            ext.recordId ||
            ''
    )
        .replace(/^clickup:task:/i, '')
        .replace(/^slack:msg:/i, '')
        .trim();
    const name =
        String(data.name || ext.clickupTaskName || doc.originalFilename || '')
            .replace(/\.json$/i, '')
            .trim() || 'Untitled task';

    if (!taskId && !name) return null;

    const listObj = data.list as { name?: string } | undefined;
    const channelObj = data.channel as { name?: string } | undefined;
    const listName = String(
        listObj?.name ||
            channelObj?.name ||
            ext.clickupListName ||
            ext.slackChannelName ||
            meta.integrationLabel ||
            '—'
    ).trim();

    const statusRaw = data.status;
    let status = '—';
    if (typeof statusRaw === 'string') status = statusRaw.trim() || '—';
    else if (statusRaw && typeof statusRaw === 'object') {
        status = String((statusRaw as { status?: string }).status || '').trim() || '—';
    }

    return {
        documentId: doc.documentId,
        taskId: taskId || doc.documentId,
        name,
        status,
        assignees: formatTaskAssignees(data.assignees),
        dueDate: formatDueDate(data.due_date ?? data.dueDate),
        listName,
        url: String(data.url || '').trim(),
        updatedAt: doc.updatedAt ? doc.updatedAt.toISOString().slice(0, 10) : '—',
    };
}

function isHrAgentContext(phase3Agent?: string, question?: string): boolean {
    if ((phase3Agent || '').toLowerCase() === 'hr_agent') return true;
    return /\bhr\s*agent\b|\bhr\b.*\b(task|tasks|clickup)\b|\b(task|tasks|clickup)\b.*\bhr\b/i.test(
        question || ''
    );
}

/** Detect asks about synced integration tasks (incl. HR Agent task questions). */
export function detectIntegrationTaskAsk(question: string, phase3Agent?: string): boolean {
    const q = question.toLowerCase().trim();
    if (!q) return false;

    if (detectTaskWriteIntent(question) || detectTaskMembersAsk(question)) return true;

    if (/\b(synced\s+tasks?|integration\s+tasks?)\b/.test(q)) return true;
    if (/\bclick\s*up\b/.test(q) || /\bclickup\b/.test(q)) return true;
    if (/\b(integration\s+record|synced\s+task|synced\s+tasks)\b/.test(q)) return true;

    if (
        /\b(who\s+is\s+assigned|assigned\s+to|assignees?|my\s+tasks)\b/.test(q) &&
        /\b(task|tasks|list|ticket)\b/.test(q)
    ) {
        return true;
    }

    if (
        /\b(task|tasks|tickets?)\b/.test(q) &&
        /\b(show|list|what|any|all|find|check|give|tell|which)\b/.test(q)
    ) {
        return true;
    }

    if (AGENT_PRODUCT_NAMES.test(q) && /\b(task|tasks|ticket|tickets)\b/.test(q)) {
        return true;
    }

    if (
        phase3Agent &&
        /_agent$/i.test(phase3Agent) &&
        /\b(candidate|candidates|hiring|recruit|interview|synced|integration|ticket|tickets)\b/.test(q) &&
        /\b(task|tasks|status|assignee|assigned)\b/.test(q)
    ) {
        return true;
    }

    if (
        isHrAgentContext(phase3Agent, question) &&
        /\b(candidate|candidates|hiring|recruit|interview|synced|integration)\b/.test(q)
    ) {
        return true;
    }

    return false;
}

export function detectTaskMembersAsk(question: string): boolean {
    const q = question.toLowerCase();
    if (
        /\b(assignable\s+members?|who\s+can\s+i\s+assign|task\s+members?|integration\s+members?)\b/.test(
            q
        )
    ) {
        return true;
    }
    return (
        /\b(click\s*up|clickup|synced\s+tasks?|integration)\b/.test(q) &&
        /\b(members?|users?|people|assignees?\s+list|who\s+can\s+i\s+assign|assignable)\b/.test(q)
    );
}

export function detectTaskWriteIntent(question: string): boolean {
    const q = question.toLowerCase().trim();
    if (!q) return false;
    if (/\b(create|add|make)\s+(?:a\s+)?(?:new\s+)?(?:click\s*up\s+|clickup\s+)?task\b/.test(q)) {
        return true;
    }
    if (/\bnew\s+(?:click\s*up\s+|clickup\s+)?task\b/.test(q)) return true;
    if (/\bassign\s+new\s+task\b/.test(q)) return true;
    // Queries, not writes
    if (/\b(who\s+is\s+assigned|tasks?\s+assigned\s+to|show\b.*\bassigned|list\b.*\bassigned)\b/.test(q)) {
        return false;
    }
    if (/\bassign\s+it\b/.test(q)) return true;
    if (/\bassign\s+to\s+[a-z]/i.test(q)) return true;
    if (/\bassign(?:ee)?\b.+\bto\b/.test(q)) return true;
    if (/\breassign\b/.test(q)) return true;
    if (/\bassign\b.+\bon\b/.test(q)) return true;
    return false;
}

const FOCUS_TASK_TOKEN = '__focus__';

function cleanTaskTitle(raw: string): string {
    return String(raw || '')
        .trim()
        .replace(/^["']|["']$/g, '')
        .replace(/^(?:like|called|named|titled|about|for)\s+/i, '')
        .replace(/\s+assigned\s+to\s+.+$/i, '')
        .replace(/\s+for\s+[A-Za-z].+$/i, '')
        .replace(/\s+/g, ' ')
        .trim();
}

/** Person named before "new/create task" in compound asks. */
export function extractImpliedAssignee(question: string): string | null {
    const patterns = [
        /(?:show|list|give|tell|get)\s+(?:me\s+)?([A-Za-z][A-Za-z.'-]{1,30}(?:\s+[A-Za-z][A-Za-z.'-]{1,30}){0,2})\s+(?:all\s+)?tasks?\b/i,
        /(?:show|list|give|tell|get)\s+(?:me\s+)?([A-Za-z][A-Za-z.'-]{1,30}(?:\s+[A-Za-z][A-Za-z.'-]{1,30}){0,2}).{0,120}?\b(?:new\s+task|assign\s+new\s+task|create\s+(?:a\s+)?(?:new\s+)?task)\b/i,
        /\b(?:for|to)\s+([A-Za-z][A-Za-z.'-]{1,30}(?:\s+[A-Za-z][A-Za-z.'-]{1,30}){0,2}).{0,80}?\b(?:new\s+task|create\s+(?:a\s+)?(?:new\s+)?task)\b/i,
        /\b(?:new\s+)?(?:click\s*up\s+|clickup\s+)?task\s+(?:called\s+|named\s+|titled\s+|like\s+)?["']?[^"'\n]+?["']?\s+(?:assigned\s+to|for|to)\s+([A-Za-z][A-Za-z.'-\s]{1,40})/i,
    ];
    for (const re of patterns) {
        const m = question.match(re);
        const raw = m?.[1]?.trim();
        if (
            raw &&
            raw.length >= 2 &&
            !/^(click|clickup|the|all|my|what|show|list|check|hr|agent|new|task|tasks|me|also|and)$/i.test(
                raw
            )
        ) {
            return raw.replace(/\b(all|task|tasks|list|clickup|and|also)\b.*$/i, '').trim();
        }
    }
    return null;
}

function parseAssigneeNeedle(question: string): string | null {
    if (AGENT_PRODUCT_NAMES.test(question)) return null;
    const patterns = [
        /tasks?\s+(?:for|assigned\s+to|of)\s+([A-Za-z][A-Za-z\s.'-]{1,40})/i,
        /assigned\s+to\s+([A-Za-z][A-Za-z\s.'-]{1,40})/i,
        /([A-Za-z][A-Za-z\s.'-]{1,40})['']?s\s+tasks?/i,
    ];
    for (const re of patterns) {
        const m = question.match(re);
        const raw = m?.[1]?.trim();
        if (
            raw &&
            raw.length >= 2 &&
            !/^(click|clickup|the|all|my|what|show|list|check|hr|agent)$/i.test(raw)
        ) {
            return raw.replace(/\b(tasks?|clickup|list|agent)\b.*$/i, '').trim();
        }
    }
    return null;
}

function parseTaskNameNeedle(question: string): string | null {
    if (AGENT_PRODUCT_NAMES.test(question) && !/task\s+(?:named|called|title)\s+/i.test(question)) {
        return null;
    }
    const m = question.match(/task\s+(?:named|called|title)\s+["']?([^"'\n.]+)/i);
    const raw = m?.[1]?.trim() || null;
    if (raw && AGENT_PRODUCT_NAMES.test(raw)) return null;
    return raw;
}

function isHrRelevantTask(row: IntegrationTaskRow): boolean {
    return HR_TASK_HINTS.test(`${row.name} ${row.listName}`);
}

function rowQualityScore(row: IntegrationTaskRow): number {
    let score = 0;
    if (row.status && row.status !== '—') score += 3;
    if (row.listName && row.listName !== '—' && !/^clickup$/i.test(row.listName)) score += 2;
    if (row.assignees && row.assignees !== 'Unassigned') score += 1;
    if (row.dueDate && row.dueDate !== '—') score += 1;
    if (row.url) score += 1;
    return score;
}

/** Prefer richer row when the same external task was synced twice. */
export function dedupeIntegrationTaskRows(rows: IntegrationTaskRow[]): IntegrationTaskRow[] {
    const byTaskId = new Map<string, IntegrationTaskRow>();
    const noId: IntegrationTaskRow[] = [];

    for (const row of rows) {
        const id = String(row.taskId || '')
            .replace(/^clickup:task:/i, '')
            .trim()
            .toLowerCase();
        if (!id || id === row.documentId.toLowerCase()) {
            noId.push(row);
            continue;
        }
        const prev = byTaskId.get(id);
        if (!prev || rowQualityScore(row) > rowQualityScore(prev)) {
            byTaskId.set(id, row);
        }
    }

    const merged = [...byTaskId.values(), ...noId];
    const byName = new Map<string, IntegrationTaskRow>();
    for (const row of merged) {
        const key = row.name.trim().toLowerCase().replace(/\s+/g, ' ');
        const prev = byName.get(key);
        if (!prev) {
            byName.set(key, row);
            continue;
        }
        const prevWeak = prev.status === '—' || /^clickup$/i.test(prev.listName);
        const rowWeak = row.status === '—' || /^clickup$/i.test(row.listName);
        if (prevWeak !== rowWeak) {
            byName.set(key, rowWeak ? prev : row);
        } else if (rowQualityScore(row) > rowQualityScore(prev)) {
            byName.set(key, row);
        }
    }

    return [...byName.values()];
}

function structuredRecordMatch(): Record<string, unknown> {
    return {
        $or: [
            { 'metadata.ingestKind': 'structured_record' },
            { mimeType: 'application/json', 'metadata.source': 'clickup' },
            { mimeType: 'application/json', 'metadata.recordType': 'task' },
            { 'metadata.integrationExternalRef.clickupTaskId': { $exists: true, $ne: '' } },
        ],
    };
}

export async function loadIntegrationTaskRows(
    user: AuthUser,
    opts?: { limit?: number; assigneeNeedle?: string; nameNeedle?: string }
): Promise<IntegrationTaskRow[]> {
    const filter = await buildDocumentFilter(user, {});
    const limit = Math.min(100, Math.max(1, opts?.limit ?? 50));

    const docs = await Document.find({
        ...filter,
        status: 'ready',
        $and: [
            structuredRecordMatch(),
            {
                $or: [
                    { 'metadata.source': 'clickup' },
                    { 'metadata.integrationExternalRef.clickupTaskId': { $exists: true, $ne: '' } },
                    { 'metadata.recordType': 'task' },
                    { classification: 'integration_record' },
                ],
            },
        ],
    })
        .select('documentId originalFilename metadata updatedAt mimeType classification')
        .sort({ updatedAt: -1 })
        .limit(limit * 2)
        .lean();

    let rows = docs
        .map((d) =>
            parseIntegrationTaskFromDoc({
                documentId: d.documentId,
                originalFilename: d.originalFilename,
                metadata: d.metadata as Record<string, unknown> | undefined,
                updatedAt: d.updatedAt,
            })
        )
        .filter((r): r is IntegrationTaskRow => Boolean(r));

    const assigneeNeedle = opts?.assigneeNeedle?.toLowerCase();
    if (assigneeNeedle) {
        rows = rows.filter(
            (r) =>
                r.assignees.toLowerCase().includes(assigneeNeedle) ||
                r.name.toLowerCase().includes(assigneeNeedle)
        );
    }

    const nameNeedle = opts?.nameNeedle?.toLowerCase();
    if (nameNeedle) {
        rows = rows.filter((r) => r.name.toLowerCase().includes(nameNeedle));
    }

    return dedupeIntegrationTaskRows(rows).slice(0, limit);
}

export async function resolveTaskIntegrationConnection(
    user: AuthUser
): Promise<IIntegrationConnection | null> {
    const orgId = String(user.organizationId || '').trim();
    if (!orgId) return null;
    // Task-capable providers (ClickUp + Slack — same universal chat layer)
    return IntegrationConnection.findOne({
        organizationId: orgId,
        isActive: true,
        providerId: { $in: ['clickup', 'slack'] },
    })
        .sort({ updatedAt: -1 })
        .exec();
}

export function connectionCreds(conn: IIntegrationConnection): { apiToken: string; listId: string } {
    return connectionCredsForProvider(conn);
}

export function isOpenIntegrationTask(row: IntegrationTaskRow): boolean {
    const s = String(row.status || '').toLowerCase().trim();
    if (!s || s === '—' || s === 'unknown') return true;
    return !/\b(complete|completed|closed|done|resolved|cancelled|canceled)\b/.test(s);
}

function scoreMemberMatch(member: ProviderMember, needle: string): number {
    const n = needle.toLowerCase().trim();
    if (!n) return 0;
    const username = member.username.toLowerCase();
    const email = member.email.toLowerCase();
    const label = member.label.toLowerCase();
    if (username === n || email === n || label === n) return 100;
    if (email.startsWith(n + '@')) return 90;
    if (username.startsWith(n) || email.startsWith(n)) return 80;
    if (username.includes(n) || email.includes(n) || label.includes(n)) return 60;
    const parts = n.split(/\s+/).filter(Boolean);
    if (parts.length > 1 && parts.every((p) => label.includes(p))) return 70;
    return 0;
}

export function matchTaskMembers(members: ProviderMember[], needle: string): ProviderMember[] {
    const scored = members
        .map((m) => ({ m, score: scoreMemberMatch(m, needle) }))
        .filter((x) => x.score > 0)
        .sort((a, b) => b.score - a.score || a.m.label.localeCompare(b.m.label));
    if (!scored.length) {
        // Fallback: first name only (handles typos on last name)
        const first = needle.trim().split(/\s+/)[0];
        if (first && first.length >= 3 && first.toLowerCase() !== needle.trim().toLowerCase()) {
            return matchTaskMembers(members, first);
        }
        return [];
    }
    const best = scored[0].score;
    return scored.filter((x) => x.score >= best - 10).map((x) => x.m);
}

function scoreTaskNameMatch(row: IntegrationTaskRow, needle: string): number {
    const n = needle.toLowerCase().trim().replace(/^task\s+/i, '');
    if (!n) return 0;
    const name = row.name.toLowerCase();
    if (name === n) return 100;
    if (name.startsWith(n)) return 85;
    if (name.includes(n)) return 70;
    const parts = n.split(/\s+/).filter((p) => p.length > 2);
    if (parts.length && parts.every((p) => name.includes(p))) return 65;
    return 0;
}

export function matchIntegrationTasks(rows: IntegrationTaskRow[], needle: string): IntegrationTaskRow[] {
    const scored = rows
        .map((r) => ({ r, score: scoreTaskNameMatch(r, needle) }))
        .filter((x) => x.score > 0)
        .sort((a, b) => b.score - a.score || a.r.name.localeCompare(b.r.name));
    if (!scored.length) return [];
    const best = scored[0].score;
    return scored.filter((x) => x.score >= best - 15).map((x) => x.r);
}

export function parseAssignCommand(question: string): { left: string; right: string } | null {
    const focusAssign = [
        /\b(?:re)?assign\s+it\s+to\s+(.+?)(?:\s*[.?!]|$)/i,
        /\b(?:re)?assign\s+(?:this|that)\s+(?:task\s+)?to\s+(.+?)(?:\s*[.?!]|$)/i,
        /\b(?:re)?assign\s+it\s+(.+?)(?:\s*[.?!]|$)/i,
        /\b(?:re)?assign\s+to\s+(.+?)(?:\s*[.?!]|$)/i,
    ];
    for (const re of focusAssign) {
        const m = question.match(re);
        const person = m?.[1]?.trim().replace(/^["']|["']$/g, '');
        if (person && person.length >= 2 && !/^(it|this|that|task|the)$/i.test(person)) {
            return { left: FOCUS_TASK_TOKEN, right: person };
        }
    }

    const patterns = [
        /\b(?:re)?assign\s+(.+?)\s+to\s+(?:task\s+)?(.+?)(?:\s*[.?!]|$)/i,
        /\b(?:re)?assign\s+(.+?)\s+on\s+(?:task\s+)?(.+?)(?:\s*[.?!]|$)/i,
        /\bset\s+assignee\s+(?:of\s+)?(.+?)\s+to\s+(.+?)(?:\s*[.?!]|$)/i,
    ];
    for (const re of patterns) {
        const m = question.match(re);
        const left = m?.[1]?.trim().replace(/^["']|["']$/g, '');
        const right = m?.[2]?.trim().replace(/^["']|["']$/g, '');
        if (left && right && left.length >= 2 && right.length >= 2) {
            if (/^(it|this|that)$/i.test(left)) {
                return { left: FOCUS_TASK_TOKEN, right };
            }
            return { left, right };
        }
    }
    return null;
}

export function parseCreateTaskCommand(
    question: string
): { name: string; assigneeNeedle?: string } | null {
    const withAssignee = question.match(
        /\b(?:create|add|make|assign)\s+(?:a\s+)?(?:new\s+)?(?:click\s*up\s+|clickup\s+)?task\s+(?:called\s+|named\s+|titled\s+|like\s+)?["']?(.+?)["']?\s+(?:assigned\s+to|for|to)\s+(.+?)(?:\s*[.?!]|$)/i
    );
    if (withAssignee?.[1]) {
        const name = cleanTaskTitle(withAssignee[1]);
        if (name) {
            return {
                name,
                assigneeNeedle: withAssignee[2]?.trim() || extractImpliedAssignee(question) || undefined,
            };
        }
    }
    const plain = question.match(
        /\b(?:create|add|make|assign)\s+(?:a\s+)?(?:new\s+)?(?:click\s*up\s+|clickup\s+)?task\s+(?:called\s+|named\s+|titled\s+|like\s+)?["']?(.+?)["']?(?:\s*[.?!]|$)/i
    );
    if (plain?.[1]) {
        const name = cleanTaskTitle(plain[1]);
        if (name && !/^(for|to|me)$/i.test(name)) {
            return {
                name,
                assigneeNeedle: extractImpliedAssignee(question) || undefined,
            };
        }
    }
    const newTask = question.match(
        /\bnew\s+(?:click\s*up\s+|clickup\s+)?task\s+(?:called\s+|named\s+|like\s+)?["']?(.+?)["']?(?:\s+(?:assigned\s+to|for|to)\s+(.+))?(?:\s*[.?!]|$)/i
    );
    if (newTask?.[1]) {
        const name = cleanTaskTitle(newTask[1]);
        if (name) {
            return {
                name,
                assigneeNeedle: newTask[2]?.trim() || extractImpliedAssignee(question) || undefined,
            };
        }
    }
    return null;
}

async function tryIntegrationTaskWriteCommand(params: {
    user: AuthUser;
    question: string;
    focusDocumentIds?: string[];
}): Promise<IntegrationTaskChatResult> {
    const q = params.question;

    if (detectTaskMembersAsk(q)) {
        const conn = await resolveTaskIntegrationConnection(params.user);
        if (!conn) {
            return {
                handled: true,
                answer: [
                    formatAgentHeading('Assignable members', 2),
                    '',
                    'No active task integration found. Admin → Integrations → connect a task provider & save.',
                ].join('\n'),
            };
        }
        const { apiToken, listId } = connectionCreds(conn);
        if (!apiToken) {
            return {
                handled: true,
                answer: 'Integration credentials are missing. Edit the connection under Admin → Integrations and save credentials.',
            };
        }
        try {
            const members = await listAssignableMembersForConnection(conn);
            if (!members.length) {
                return {
                    handled: true,
                    answer: 'No assignable members found for this integration. Check workspace access on the connected account.',
                };
            }
            const lines = members
                .slice(0, 40)
                .map((m) => `- **${m.label}**`)
                .join('\n');
            return {
                handled: true,
                answer: [
                    formatAgentHeading('Assignable members', 2),
                    '',
                    formatAgentIntro([
                        `${members.length} people you can assign from chat (from your connected task integration).`,
                        'Example: `assign Test Candidate — Engineer to Ahmed`',
                    ]),
                    '',
                    lines,
                    members.length > 40 ? `\n_Showing 40 of ${members.length}._` : '',
                ]
                    .filter(Boolean)
                    .join('\n'),
            };
        } catch (e: unknown) {
            const msg = e instanceof Error ? e.message : 'Failed to load assignable members';
            return { handled: true, answer: `Could not load assignable members: ${msg}` };
        }
    }

    if (!detectTaskWriteIntent(q)) return { handled: false };

    const conn = await resolveTaskIntegrationConnection(params.user);
    if (!conn) {
        return {
            handled: true,
            answer: [
                formatAgentHeading('Synced tasks', 2),
                '',
                'No active task integration. Connect ClickUp or Slack under Admin → Integrations, then try again.',
            ].join('\n'),
        };
    }
    const { apiToken, listId } = connectionCreds(conn);
    if (!apiToken) {
        return {
            handled: true,
            answer: 'Integration credentials are missing. Edit the connection under Admin → Integrations.',
        };
    }

    const createParsed = parseCreateTaskCommand(q);
    if (createParsed) {
        if (!listId) {
            return {
                handled: true,
                answer:
                    conn.providerId === 'slack'
                        ? 'Slack Channel ID is not set. Admin → Integrations → Edit Slack → paste Channel ID (C…) → Save.'
                        : 'Target list/board is not set on the connection. Admin → Integrations → pick a list/board → Save.',
            };
        }
        let assigneeIds: number[] = [];
        let assigneeLabel = '';
        if (createParsed.assigneeNeedle) {
            const members = await listAssignableMembersForConnection(conn);
            const matched = matchTaskMembers(members, createParsed.assigneeNeedle);
            if (!matched.length) {
                const sample = members
                    .slice(0, 12)
                    .map((m) => m.label)
                    .join(', ');
                return {
                    handled: true,
                    answer: [
                        `Could not find user **${createParsed.assigneeNeedle}**.`,
                        sample ? `Try one of: ${sample}` : 'Ask “show assignable members” to see who you can assign.',
                    ].join('\n'),
                };
            }
            if (matched.length > 1) {
                return {
                    handled: true,
                    answer: [
                        `Multiple people match **${createParsed.assigneeNeedle}**. Be more specific:`,
                        ...matched.slice(0, 8).map((m) => `- ${m.label}`),
                    ].join('\n'),
                };
            }
            assigneeIds = [matched[0].id];
            assigneeLabel = matched[0].label;
        }

        try {
            const { created, citationHints } = await createTaskForConnection(conn, {
                name: createParsed.name,
                assignees: assigneeIds.length ? assigneeIds : undefined,
            });
            const taskId = String(created.id || created.ts || '').trim();
            let citationDocId = '';
            if (taskId || citationHints.length) {
                const ids = [...new Set([taskId, ...citationHints].filter(Boolean))];
                const synced = await Document.findOne({
                    organizationId: conn.organizationId,
                    $or: [
                        { 'metadata.integrationExternalRef.clickupTaskId': { $in: ids } },
                        { 'metadata.integrationExternalRef.slackMessageTs': { $in: ids } },
                        { 'metadata.structuredData.id': { $in: ids } },
                        { 'metadata.structuredData.taskId': { $in: ids } },
                    ],
                })
                    .select('documentId')
                    .lean();
                citationDocId = String(synced?.documentId || '');
            }
            const url = String(created.url || '').trim();
            return {
                handled: true,
                answer: [
                    formatAgentHeading('Task created', 2),
                    '',
                    formatAgentIntro([
                        `Created **${createParsed.name}** in your connected integration.`,
                        assigneeLabel
                            ? `Assigned to **${assigneeLabel}**.`
                            : 'Unassigned — say `assign <task> to <person>` to assign anyone in the workspace.',
                        url ? `Open: ${url}` : '',
                        'Synced into Visibility automatically.',
                    ]),
                ].join('\n'),
                citations: citationDocId
                    ? [
                          {
                              documentId: citationDocId,
                              filename: `${createParsed.name}.json`,
                              documentType: 'integration_record',
                          },
                      ]
                    : [],
            };
        } catch (e: unknown) {
            const msg = e instanceof Error ? e.message : 'Create failed';
            return { handled: true, answer: `Could not create task: ${msg}` };
        }
    }

    const assignParsed = parseAssignCommand(q);
    if (assignParsed) {
        const members = await listAssignableMembersForConnection(conn);
        const rows = await loadIntegrationTaskRows(params.user, { limit: 80 });

        const resolveFocusRow = async (): Promise<IntegrationTaskRow | null> => {
            const focusIds = (params.focusDocumentIds || []).filter(Boolean);
            if (focusIds.length) {
                const focusRows = rows.filter((r) => focusIds.includes(r.documentId));
                if (focusRows.length === 1) return focusRows[0];
                if (focusRows.length > 1) return focusRows[0];
                const docs = await Document.find({ documentId: { $in: focusIds } })
                    .select('documentId originalFilename metadata updatedAt')
                    .lean();
                for (const d of docs) {
                    const row = parseIntegrationTaskFromDoc({
                        documentId: d.documentId,
                        originalFilename: d.originalFilename,
                        metadata: d.metadata as Record<string, unknown> | undefined,
                        updatedAt: d.updatedAt,
                    });
                    if (row) return row;
                }
            }
            // Most recently synced task (e.g. just created)
            return rows[0] || null;
        };

        let person: ProviderMember | null = null;
        let task: IntegrationTaskRow | null = null;

        if (assignParsed.left === FOCUS_TASK_TOKEN || assignParsed.right === FOCUS_TASK_TOKEN) {
            const personNeedle =
                assignParsed.left === FOCUS_TASK_TOKEN ? assignParsed.right : assignParsed.left;
            const matchedPeople = matchTaskMembers(members, personNeedle);
            if (!matchedPeople.length) {
                const sample = members
                    .slice(0, 12)
                    .map((m) => m.label)
                    .join(', ');
                return {
                    handled: true,
                    answer: [
                        `Could not find user **${personNeedle}**.`,
                        sample
                            ? `Try one of: ${sample}`
                            : 'Ask “show assignable members” to see who you can assign.',
                    ].join('\n'),
                };
            }
            if (matchedPeople.length > 1) {
                return {
                    handled: true,
                    answer: [
                        `Multiple people match **${personNeedle}**. Be more specific:`,
                        ...matchedPeople.slice(0, 8).map((m) => `- ${m.label}`),
                    ].join('\n'),
                };
            }
            person = matchedPeople[0];
            task = await resolveFocusRow();
            if (!task) {
                return {
                    handled: true,
                    answer: [
                        `Who should **${person.label}** be assigned to?`,
                        'Say the task name, e.g. `assign json format data to Haroon Shahid`, or create a task first.',
                    ].join('\n'),
                };
            }
        } else {
            const leftMembers = matchTaskMembers(members, assignParsed.left);
            const rightMembers = matchTaskMembers(members, assignParsed.right);
            const leftTasks = matchIntegrationTasks(rows, assignParsed.left);
            const rightTasks = matchIntegrationTasks(rows, assignParsed.right);

            // Prefer "assign <task> to <person>"
            if (leftTasks.length === 1 && rightMembers.length === 1) {
                task = leftTasks[0];
                person = rightMembers[0];
            } else if (leftMembers.length === 1 && rightTasks.length === 1) {
                person = leftMembers[0];
                task = rightTasks[0];
            } else if (rightMembers.length === 1 && leftTasks.length >= 1) {
                person = rightMembers[0];
                task = leftTasks.length === 1 ? leftTasks[0] : null;
            } else if (leftMembers.length === 1 && rightTasks.length >= 1) {
                person = leftMembers[0];
                task = rightTasks.length === 1 ? rightTasks[0] : null;
            }

            if (!person) {
                const candidates = [...leftMembers, ...rightMembers];
                const unique = new Map(candidates.map((m) => [m.id, m]));
                if (unique.size > 1) {
                    return {
                        handled: true,
                        answer: [
                            'Multiple users match. Pick one:',
                            ...[...unique.values()].slice(0, 10).map((m) => `- ${m.label}`),
                            '',
                            'Example: `assign Test Candidate — Engineer to Ahmed`',
                        ].join('\n'),
                    };
                }
                if (unique.size === 1) person = [...unique.values()][0];
                else {
                    const sample = members
                        .slice(0, 12)
                        .map((m) => m.label)
                        .join(', ');
                    return {
                        handled: true,
                        answer: [
                            `Could not match a user in “${assignParsed.left}” / “${assignParsed.right}”.`,
                            sample
                                ? `Assignable people include: ${sample}`
                                : 'Ask “show assignable members” to list everyone.',
                            '',
                            'Say: `assign <task name> to <person>` or `assign it to <person>` after creating a task.',
                        ].join('\n'),
                    };
                }
            }

            if (!task) {
                const taskCandidates =
                    leftTasks.length > 1
                        ? leftTasks
                        : rightTasks.length > 1
                          ? rightTasks
                          : [...leftTasks, ...rightTasks];
                if (taskCandidates.length > 1) {
                    return {
                        handled: true,
                        answer: [
                            `Multiple tasks match. Which one should **${person.label}** get?`,
                            ...taskCandidates.slice(0, 10).map((t) => `- **${t.name}** (${t.status})`),
                        ].join('\n'),
                    };
                }
                if (taskCandidates.length === 1) task = taskCandidates[0];
                else {
                    task = await resolveFocusRow();
                    if (!task) {
                        return {
                            handled: true,
                            answer: [
                                `Could not find a synced task matching “${assignParsed.left}” or “${assignParsed.right}”.`,
                                'Sync the integration first, or create with: `create task Screen Ali assigned to Ahmed`',
                            ].join('\n'),
                        };
                    }
                }
            }
        }

        try {
            await assignTaskForConnection(conn, task.taskId, {
                add: [person.id],
                taskName: task.name,
            });
            await refreshTaskRecordAfterWrite(conn, task.taskId);
            return {
                handled: true,
                answer: [
                    formatAgentHeading('Assignee updated', 2),
                    '',
                    formatAgentIntro([
                        `Assigned **${person.label}** to **${task.name}** in your connected integration.`,
                        'Visibility record refreshed automatically.',
                        task.url ? `Open: ${task.url}` : '',
                    ]),
                ].join('\n'),
                citations: [
                    {
                        documentId: task.documentId,
                        filename: `${task.name}.json`,
                        documentType: 'integration_record',
                    },
                ],
            };
        } catch (e: unknown) {
            const msg = e instanceof Error ? e.message : 'Assign failed';
            return { handled: true, answer: `Could not assign: ${msg}` };
        }
    }

    return {
        handled: true,
        answer: [
            formatAgentHeading('Task actions', 2),
            '',
            'Try one of:',
            '- `assign Test Candidate — Engineer to Ahmed`',
            '- `assign it to Haroon Shahid` (uses the last task you created)',
            '- `create task Screen candidate assigned to Sara`',
            '- `show assignable members`',
        ].join('\n'),
    };
}

function buildTaskTable(rows: IntegrationTaskRow[]): string {
    const header = '| Task | Status | Assignee(s) | Due | List |';
    const sep = '| --- | --- | --- | --- | --- |';
    const body = rows.map((r) => {
        const status = r.status === '—' ? 'unknown' : r.status;
        return `| ${r.name.replace(/\|/g, '/')} | ${status.replace(/\|/g, '/')} | ${r.assignees.replace(/\|/g, '/')} | ${r.dueDate} | ${r.listName.replace(/\|/g, '/')} |`;
    });
    return [header, sep, ...body].join('\n');
}

export async function tryIntegrationTaskCommand(params: {
    user: AuthUser;
    question: string;
    phase3Agent?: string;
    focusDocumentIds?: string[];
}): Promise<IntegrationTaskChatResult> {
    if (!detectIntegrationTaskAsk(params.question, params.phase3Agent)) {
        return { handled: false };
    }

    const write = await tryIntegrationTaskWriteCommand({
        user: params.user,
        question: params.question,
        focusDocumentIds: params.focusDocumentIds,
    });
    if (write.handled) return write;

    const hrContext = isHrAgentContext(params.phase3Agent, params.question);
    const assigneeNeedle = parseAssigneeNeedle(params.question);
    const nameNeedle = parseTaskNameNeedle(params.question);
    const rows = await loadIntegrationTaskRows(params.user, {
        assigneeNeedle: assigneeNeedle || undefined,
        nameNeedle: nameNeedle || undefined,
        limit: 40,
    });

    const citations = rows.map((r) => ({
        documentId: r.documentId,
        filename: `${r.name}.json`,
        documentType: 'integration_record',
        phase3Agent: params.phase3Agent,
    }));

    if (!rows.length) {
        const filterHint = assigneeNeedle
            ? ` matching **${assigneeNeedle}**`
            : nameNeedle
              ? ` matching **${nameNeedle}**`
              : '';
        return {
            handled: true,
            answer: [
                formatAgentHeading('Synced tasks', 2),
                '',
                formatAgentIntro([
                    hrContext
                        ? '**HR Agent** is the Visibility assistant — it is not a synced task name.'
                        : '',
                    `No synced task records found${filterHint} in your portfolio.`,
                    '**To load tasks:** Admin → Integrations → **Sync now** (or enable live webhooks).',
                    hrContext
                        ? 'For hiring work, also upload resumes in **Documents** — HR Agent analyzes files there. Integration sync is for task/status data.'
                        : 'Each task in your connected list is stored with assignees, status, and custom fields.',
                    'You can also **create** or **assign** from chat: `create task … assigned to …` / `assign <task> to <person>`.',
                ]),
            ].join('\n'),
            citations: [],
        };
    }

    const q = params.question.toLowerCase();
    const wantsByAssignee =
        Boolean(assigneeNeedle) ||
        /\b(who\s+is\s+assigned|assigned\s+to|assignees?|by\s+assignee)\b/.test(q);

    let answer = formatAgentHeading('Synced tasks', 2);

    if (hrContext) {
        answer += `\n\n${formatAgentIntro([
            '**HR Agent** is this Visibility assistant — not a synced integration task.',
            `Here are **${rows.length}** synced task(s) for HR / hiring context.`,
        ])}\n\n`;

        const hrish = rows.filter(isHrRelevantTask);
        if (hrish.length) {
            answer += '**Closest to HR / hiring:**\n\n';
            for (const t of hrish.slice(0, 8)) {
                const status = t.status === '—' ? 'unknown' : t.status;
                answer += `- **${t.name}** — ${status} · ${t.assignees}\n`;
            }
            answer += '\n';
        } else {
            answer +=
                '_No task titles look explicitly HR-related (candidate / hiring / interview). Full list below — say which task to focus on._\n\n';
        }
    } else {
        answer += `\n\n${formatAgentIntro([
            `${rows.length} task(s) from your synced task integration(s).`,
        ])}\n\n`;
    }

    if (wantsByAssignee) {
        const byAssignee = new Map<string, IntegrationTaskRow[]>();
        for (const row of rows) {
            const key = row.assignees === 'Unassigned' ? 'Unassigned' : row.assignees;
            const bucket = byAssignee.get(key) || [];
            bucket.push(row);
            byAssignee.set(key, bucket);
        }
        answer += '**By assignee:**\n\n';
        for (const [assignee, tasks] of [...byAssignee.entries()].sort((a, b) =>
            a[0].localeCompare(b[0])
        )) {
            answer += `- **${assignee}** — ${tasks.length} task(s): ${tasks
                .slice(0, 8)
                .map((t) => t.name)
                .join(', ')}${tasks.length > 8 ? '…' : ''}\n`;
        }
        answer += '\n';
    }

    answer += buildTaskTable(rows.slice(0, 25));

    if (rows.length > 25) {
        answer += `\n\n_Showing 25 of ${rows.length} tasks. Narrow with e.g. "tasks assigned to Ahmed"._`;
    }

    answer +=
        '\n\n_Assign: `assign <task> to <person>` · Create: `create task …` · **Loop:** `process open tasks until done` (reply **yes**) · Members: `show assignable members`._';

    return { handled: true, answer, citations };
}