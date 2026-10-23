/**
 * Universal task provider adapter — ClickUp / Slack behind one interface for chat + playbook.
 */
import type { IIntegrationConnection } from '../models/IntegrationConnection';
import {
    assignClickUpTask,
    createClickUpTask,
    ingestAttachmentsFromTask,
    listClickUpAssignableMembers,
    resolveClickUpCompleteStatus,
    updateClickUpTaskStatus,
    type ClickUpMember,
} from './clickupBridgeService';
import {
    assignSlackTask,
    connectionSlackCreds,
    createSlackTask,
    ingestSlackTaskAfterCreate,
    listSlackAssignableMembers,
    resolveSlackCompleteStatus,
    updateSlackTaskStatus,
    type SlackMember,
} from './slackBridgeService';

export type TaskProviderMember = {
    id: number;
    username: string;
    email: string;
    label: string;
    slackUserId?: string;
};

export function isSlackConnection(conn: IIntegrationConnection | null | undefined): boolean {
    return String(conn?.providerId || '').toLowerCase() === 'slack';
}

export function connectionCredsForProvider(conn: IIntegrationConnection): {
    apiToken: string;
    listId: string;
} {
    if (isSlackConnection(conn)) {
        const { botToken, channelId } = connectionSlackCreds(conn);
        return { apiToken: botToken, listId: channelId };
    }
    const apiToken = String(conn.secrets?.apiToken || '').trim();
    const listId = String(conn.config?.listId || conn.config?.clickupListId || '').trim();
    return { apiToken, listId };
}

function toProviderMembers(members: Array<ClickUpMember | SlackMember>): TaskProviderMember[] {
    return members.map((m) => ({
        id: m.id,
        username: m.username,
        email: m.email,
        label: m.label,
        slackUserId: 'slackUserId' in m ? m.slackUserId : undefined,
    }));
}

export async function listAssignableMembersForConnection(
    conn: IIntegrationConnection
): Promise<TaskProviderMember[]> {
    const { apiToken, listId } = connectionCredsForProvider(conn);
    if (!apiToken) return [];
    if (isSlackConnection(conn)) {
        return toProviderMembers(await listSlackAssignableMembers(apiToken, { channelId: listId || undefined }));
    }
    return toProviderMembers(await listClickUpAssignableMembers(apiToken, { listId: listId || undefined }));
}

function buildSlackMemberMap(members: TaskProviderMember[]): Map<number, string> {
    const map = new Map<number, string>();
    for (const m of members) {
        if (m.slackUserId) map.set(m.id, m.slackUserId);
    }
    return map;
}

export async function createTaskForConnection(
    conn: IIntegrationConnection,
    input: { name: string; assignees?: number[]; description?: string }
): Promise<{ created: Record<string, unknown>; citationHints: string[] }> {
    const { apiToken, listId } = connectionCredsForProvider(conn);
    if (isSlackConnection(conn)) {
        const members = await listAssignableMembersForConnection(conn);
        const created = await createSlackTask(listId, apiToken, {
            name: input.name,
            assignees: input.assignees,
            description: input.description,
            memberMap: buildSlackMemberMap(members),
        });
        await ingestSlackTaskAfterCreate(conn, {
            id: String(created.id || ''),
            ts: String(created.ts || created.id || ''),
            name: input.name,
        });
        return { created, citationHints: [String(created.id || ''), String(created.ts || '')] };
    }
    const created = await createClickUpTask(listId, apiToken, input);
    const taskId = String(created.id || '').trim();
    if (taskId) await ingestAttachmentsFromTask(conn, taskId);
    return { created, citationHints: [taskId] };
}

export async function assignTaskForConnection(
    conn: IIntegrationConnection,
    taskId: string,
    opts: { add: number[]; taskName?: string }
): Promise<void> {
    const { apiToken, listId } = connectionCredsForProvider(conn);
    if (isSlackConnection(conn)) {
        const members = await listAssignableMembersForConnection(conn);
        await assignSlackTask(taskId, apiToken, {
            channelId: listId,
            add: opts.add,
            memberMap: buildSlackMemberMap(members),
            taskName: opts.taskName,
        });
        return;
    }
    await assignClickUpTask(taskId, apiToken, { add: opts.add });
}

export async function completeTaskForConnection(
    conn: IIntegrationConnection,
    taskId: string,
    opts?: { taskName?: string; status?: string }
): Promise<string> {
    const { apiToken, listId } = connectionCredsForProvider(conn);
    if (isSlackConnection(conn)) {
        const status = opts?.status || (await resolveSlackCompleteStatus());
        await updateSlackTaskStatus(taskId, apiToken, status, {
            channelId: listId,
            taskName: opts?.taskName,
        });
        return status;
    }
    const status = opts?.status || (await resolveClickUpCompleteStatus(listId, apiToken));
    await updateClickUpTaskStatus(taskId, apiToken, status);
    return status;
}

export async function resolveCompleteStatusForConnection(conn: IIntegrationConnection): Promise<string> {
    if (isSlackConnection(conn)) return resolveSlackCompleteStatus();
    const { apiToken, listId } = connectionCredsForProvider(conn);
    return resolveClickUpCompleteStatus(listId, apiToken);
}

export async function refreshTaskRecordAfterWrite(conn: IIntegrationConnection, taskId: string): Promise<void> {
    if (isSlackConnection(conn)) {
        await ingestSlackTaskAfterCreate(conn, { id: taskId, ts: taskId });
        return;
    }
    await ingestAttachmentsFromTask(conn, taskId);
}
