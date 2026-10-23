/**
 * Universal integration task playbook — controlled multi-step loop:
 * plan → confirm → act (assign / complete) → re-sync → stop (max steps).
 * Provider writes use ClickUp / Slack adapters; chat stays provider-agnostic.
 */
import type { AuthUser } from './accessScope';
import { formatAgentHeading, formatAgentIntro } from './agentResponseFormat';
import {
    assignTaskForConnection,
    completeTaskForConnection,
    listAssignableMembersForConnection,
    refreshTaskRecordAfterWrite,
    resolveCompleteStatusForConnection,
} from './taskProviderAdapter';
import {
    connectionCreds,
    isOpenIntegrationTask,
    loadIntegrationTaskRows,
    matchTaskMembers,
    resolveTaskIntegrationConnection,
    type IntegrationTaskChatResult,
    type IntegrationTaskRow,
} from './integrationTaskChatService';

const MAX_STEPS = 10;
const PENDING_TTL_MS = 15 * 60 * 1000;

export type PlaybookKind = 'close_open' | 'assign_open' | 'process_open';

type PendingPlaybook = {
    key: string;
    userId: string;
    organizationId: string;
    kind: PlaybookKind;
    assigneeId?: number;
    assigneeLabel?: string;
    completeStatus: string;
    tasks: Array<{ taskId: string; documentId: string; name: string }>;
    createdAt: number;
};

const pendingByKey = new Map<string, PendingPlaybook>();

function prunePending() {
    const now = Date.now();
    for (const [k, v] of pendingByKey) {
        if (now - v.createdAt > PENDING_TTL_MS) pendingByKey.delete(k);
    }
}

function playbookKey(user: AuthUser, sessionId?: string, phase3Agent?: string): string {
    const org = String(user.organizationId || 'no-org');
    const uid = String(user.userId || 'anon');
    const sid = String(sessionId || '').trim() || 'no-session';
    const agent = String(phase3Agent || 'any_agent').trim().toLowerCase() || 'any_agent';
    return `${org}:${uid}:${sid}:${agent}`;
}

const AGENT_LABELS: Record<string, string> = {
    hr_agent: 'HR',
    finance_agent: 'Finance',
    compliance_agent: 'Compliance',
    legal_agent: 'Legal',
    procurement_agent: 'Procurement',
    other_agent: 'General',
};

function agentLabel(phase3Agent?: string): string {
    const id = String(phase3Agent || '').toLowerCase();
    return AGENT_LABELS[id] || 'Agent';
}

function playbookHeading(phase3Agent: string | undefined, title: string): string {
    return formatAgentHeading(`${agentLabel(phase3Agent)} · ${title}`, 2);
}

export function __resetPlaybookStoreForTests() {
    pendingByKey.clear();
}

export function detectPlaybookConfirm(question: string): boolean {
    const q = question.toLowerCase().trim();
    if (!q || q.length > 80) return false;
    return /^(yes|y|ok|okay|confirm|proceed|go\s+ahead|do\s+it|run\s+it|continue|approve)([!.]?)$/i.test(
        q
    );
}

export function detectPlaybookCancel(question: string): boolean {
    const q = question.toLowerCase().trim();
    if (!q || q.length > 80) return false;
    return /^(no|n|cancel|stop|abort|never\s*mind|dont|don't)([!.]?)$/i.test(q);
}

export function detectPlaybookAsk(question: string): boolean {
    const q = question.toLowerCase().trim();
    if (!q) return false;
    if (/\b(run|start|execute)\s+(the\s+)?(task\s+)?playbook\b/.test(q)) return true;
    if (/\bprocess\s+(all\s+)?(open\s+)?tasks?\b/.test(q)) return true;
    if (/\b(close|complete|finish)\s+(all\s+)?(open\s+|overdue\s+)?tasks?\b/.test(q)) return true;
    if (/\b(until\s+(done|complete|finished)|loop\s+(on\s+)?tasks?)\b/.test(q)) return true;
    if (/\bassign\s+all\s+(open\s+)?tasks?\s+to\b/.test(q)) return true;
    if (/\b(work\s+through|clear)\s+(open\s+|overdue\s+)?tasks?\b/.test(q)) return true;
    return false;
}

export function parsePlaybookKind(question: string): PlaybookKind {
    const q = question.toLowerCase();
    if (/\bassign\s+all\b/.test(q) && !/\b(close|complete|finish|process)\b/.test(q)) {
        return 'assign_open';
    }
    if (/\b(close|complete|finish)\b/.test(q) && !/\bassign\b/.test(q)) {
        return 'close_open';
    }
    return 'process_open';
}

export function parsePlaybookAssigneeNeedle(question: string): string | null {
    const patterns = [
        /\bassign(?:ed)?\s+(?:all\s+)?(?:open\s+)?tasks?\s+to\s+([A-Za-z][A-Za-z.'-\s]{1,40})(?:\s+then|\s+and|\s*[.?!]|$)/i,
        /\bto\s+([A-Za-z][A-Za-z.'-\s]{1,40})\s+(?:then\s+)?(?:close|complete|finish|until)/i,
        /\bfor\s+([A-Za-z][A-Za-z.'-\s]{1,40})(?:\s+then|\s+and|\s*[.?!]|$)/i,
    ];
    for (const re of patterns) {
        const m = question.match(re);
        const raw = m?.[1]?.trim();
        if (
            raw &&
            raw.length >= 2 &&
            !/^(all|open|tasks?|me|them|everyone|someone)$/i.test(raw)
        ) {
            return raw.replace(/\b(then|and|close|complete|finish).*$/i, '').trim();
        }
    }
    return null;
}

function kindLabel(kind: PlaybookKind): string {
    if (kind === 'close_open') return 'Mark open tasks complete';
    if (kind === 'assign_open') return 'Assign open tasks';
    return 'Process open tasks (assign if needed → complete)';
}

function filterPlaybookTasks(rows: IntegrationTaskRow[], kind: PlaybookKind): IntegrationTaskRow[] {
    const open = rows.filter(isOpenIntegrationTask);
    if (kind === 'assign_open') {
        return open.filter((r) => !r.assignees || /^unassigned$/i.test(r.assignees));
    }
    return open;
}

async function executePlaybook(
    pending: PendingPlaybook,
    phase3Agent?: string
): Promise<IntegrationTaskChatResult> {
    const userStub: AuthUser = {
        userId: pending.userId,
        role: 'admin',
        organizationId: pending.organizationId,
    };
    const conn = await resolveTaskIntegrationConnection(userStub);
    if (!conn) {
        pendingByKey.delete(pending.key);
        return {
            handled: true,
            answer:
                'Task integration is no longer available. Reconnect under Admin → Integrations.',
        };
    }
    const { apiToken, listId } = connectionCreds(conn);
    if (!apiToken) {
        return { handled: true, answer: 'Integration credentials are missing.' };
    }

    const completeStatus =
        pending.completeStatus || (await resolveCompleteStatusForConnection(conn));

    const steps: string[] = [];
    let ok = 0;
    let fail = 0;
    const citations: NonNullable<IntegrationTaskChatResult['citations']> = [];
    const batch = pending.tasks.slice(0, MAX_STEPS);

    for (let i = 0; i < batch.length; i++) {
        const t = batch[i];
        const stepNo = i + 1;
        try {
            if (
                (pending.kind === 'assign_open' || pending.kind === 'process_open') &&
                pending.assigneeId
            ) {
                await assignTaskForConnection(conn, t.taskId, {
                    add: [pending.assigneeId],
                    taskName: t.name,
                });
            }
            if (pending.kind === 'close_open' || pending.kind === 'process_open') {
                await completeTaskForConnection(conn, t.taskId, {
                    taskName: t.name,
                    status: completeStatus,
                });
            }
            await refreshTaskRecordAfterWrite(conn, t.taskId);
            ok += 1;
            const action =
                pending.kind === 'assign_open'
                    ? `assigned to ${pending.assigneeLabel || 'member'}`
                    : pending.kind === 'close_open'
                      ? `marked **${completeStatus}**`
                      : `processed${pending.assigneeLabel ? ` (→ ${pending.assigneeLabel})` : ''} + **${completeStatus}**`;
            steps.push(`${stepNo}. ✅ **${t.name}** — ${action}`);
            citations.push({
                documentId: t.documentId,
                filename: `${t.name}.json`,
                documentType: 'integration_record',
                phase3Agent,
            });
        } catch (e: unknown) {
            fail += 1;
            const msg = e instanceof Error ? e.message : 'failed';
            steps.push(`${stepNo}. ❌ **${t.name}** — ${msg}`);
        }
    }

    pendingByKey.delete(pending.key);

    const remaining = pending.tasks.length - batch.length;
    return {
        handled: true,
        answer: [
            playbookHeading(phase3Agent, 'Playbook finished'),
            '',
            formatAgentIntro([
                `${agentLabel(phase3Agent)} ran **${kindLabel(pending.kind)}** in a controlled loop (max ${MAX_STEPS} steps).`,
                `**${ok}** succeeded · **${fail}** failed${
                    remaining > 0
                        ? ` · **${remaining}** left (run the playbook again to continue)`
                        : ''
                }.`,
            ]),
            '',
            '**Steps:**',
            ...steps,
            '',
            '_Synced records refreshed after each write. Ask “show synced tasks” to verify._',
        ].join('\n'),
        citations,
    };
}

export async function tryIntegrationTaskPlaybookCommand(params: {
    user: AuthUser;
    question: string;
    phase3Agent?: string;
    sessionId?: string;
}): Promise<IntegrationTaskChatResult> {
    prunePending();
    const key = playbookKey(params.user, params.sessionId, params.phase3Agent);
    const pending = pendingByKey.get(key);

    if (pending) {
        if (detectPlaybookCancel(params.question)) {
            pendingByKey.delete(key);
            return {
                handled: true,
                answer: [
                    playbookHeading(params.phase3Agent, 'Playbook cancelled'),
                    '',
                    'No changes were made. Say `process open tasks until done` anytime to plan again.',
                ].join('\n'),
            };
        }
        if (detectPlaybookConfirm(params.question)) {
            return executePlaybook(pending, params.phase3Agent);
        }
        if (!detectPlaybookAsk(params.question)) {
            return { handled: false };
        }
    } else if (detectPlaybookConfirm(params.question) || detectPlaybookCancel(params.question)) {
        return { handled: false };
    }

    if (!detectPlaybookAsk(params.question)) {
        return { handled: false };
    }

    const kind = parsePlaybookKind(params.question);
    const assigneeNeedle = parsePlaybookAssigneeNeedle(params.question);

    const conn = await resolveTaskIntegrationConnection(params.user);
    if (!conn) {
        return {
            handled: true,
            answer: [
                playbookHeading(params.phase3Agent, 'Task playbook'),
                '',
                'No active task integration. Admin → Integrations → connect a provider, then try again.',
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

    let assigneeId: number | undefined;
    let assigneeLabel: string | undefined;
    if (kind === 'assign_open' || (kind === 'process_open' && assigneeNeedle)) {
        if (!assigneeNeedle) {
            return {
                handled: true,
                answer: [
                    playbookHeading(params.phase3Agent, 'Task playbook'),
                    '',
                    'Who should receive the open tasks?',
                    'Example: `assign all open tasks to Ahmed` or `process open tasks to Sara until done`',
                ].join('\n'),
            };
        }
        const members = await listAssignableMembersForConnection(conn);
        const matched = matchTaskMembers(members, assigneeNeedle);
        if (!matched.length) {
            const sample = members
                .slice(0, 12)
                .map((m) => m.label)
                .join(', ');
            return {
                handled: true,
                answer: [
                    `Could not find member **${assigneeNeedle}**.`,
                    sample ? `Try: ${sample}` : 'Ask “show assignable members”.',
                ].join('\n'),
            };
        }
        if (matched.length > 1) {
            return {
                handled: true,
                answer: [
                    `Multiple people match **${assigneeNeedle}**:`,
                    ...matched.slice(0, 8).map((m) => `- ${m.label}`),
                ].join('\n'),
            };
        }
        assigneeId = matched[0].id;
        assigneeLabel = matched[0].label;
    }

    const rows = await loadIntegrationTaskRows(params.user, { limit: 80 });
    const targets = filterPlaybookTasks(rows, kind).slice(0, MAX_STEPS);
    if (!targets.length) {
        return {
            handled: true,
            answer: [
                playbookHeading(params.phase3Agent, 'Task playbook'),
                '',
                formatAgentIntro([
                    kind === 'assign_open'
                        ? 'No **unassigned open** tasks to process.'
                        : 'No **open** synced tasks to process — nothing left in the loop.',
                    'Ask “show synced tasks” to review the board.',
                ]),
            ].join('\n'),
        };
    }

    const completeStatus = await resolveCompleteStatusForConnection(conn);

    const plan: PendingPlaybook = {
        key,
        userId: params.user.userId,
        organizationId: String(params.user.organizationId || conn.organizationId),
        kind,
        assigneeId,
        assigneeLabel,
        completeStatus,
        tasks: targets.map((t) => ({
            taskId: t.taskId,
            documentId: t.documentId,
            name: t.name,
        })),
        createdAt: Date.now(),
    };
    pendingByKey.set(key, plan);

    const checklist = targets
        .map((t, i) => {
            const status = t.status === '—' ? 'unknown' : t.status;
            const who = t.assignees && t.assignees !== 'Unassigned' ? ` · ${t.assignees}` : '';
            return `${i + 1}. **${t.name}** · ${status}${who}`;
        })
        .join('\n');

    const actionHint =
        kind === 'assign_open'
            ? `Assign each to **${assigneeLabel}**`
            : kind === 'close_open'
              ? `Mark each **${completeStatus}**`
              : `Assign${assigneeLabel ? ` to **${assigneeLabel}**` : ' (keep current assignees)'} then mark **${completeStatus}**`;

    return {
        handled: true,
        answer: [
            playbookHeading(params.phase3Agent, 'Playbook plan — confirm to run'),
            '',
            formatAgentIntro([
                `**${kindLabel(kind)}** · ${targets.length} step(s) (cap ${MAX_STEPS}).`,
                actionHint,
                `${agentLabel(params.phase3Agent)} will write to your connected integration, then re-sync Visibility.`,
            ]),
            '',
            '**Checklist:**',
            checklist,
            '',
            'Reply **yes** to run the loop, or **cancel** to abort.',
        ].join('\n'),
        citations: targets.map((t) => ({
            documentId: t.documentId,
            filename: `${t.name}.json`,
            documentType: 'integration_record',
            phase3Agent: params.phase3Agent,
        })),
    };
}
