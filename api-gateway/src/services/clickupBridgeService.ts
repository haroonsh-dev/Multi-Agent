import axios from 'axios';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { IIntegrationConnection } from '../models/IntegrationConnection';
import Document from '../models/Document';
import { getExtension, isAllowedFile } from '../utils/fileValidation';
import {
    ingestFileForConnection,
    type IngestUploadInput,
} from './integrationIngestService';
import { ingestClickUpTaskRecord } from './integrationRecordIngestService';

const CLICKUP_API = 'https://api.clickup.com/api/v2';
const CLICKUP_TIMEOUT_MS = 45_000;

export type ClickUpAttachment = {
    id: string;
    title?: string;
    url?: string;
    extension?: string;
    mimetype?: string;
    size?: number;
};

export type ClickUpWebhookPayload = {
    event?: string;
    task_id?: string;
    history_items?: Array<{ field?: string; after?: unknown }>;
};

function clickUpHeaders(apiToken: string) {
    let token = String(apiToken || '').trim();
    if (/^bearer\s+/i.test(token)) token = token.replace(/^bearer\s+/i, '').trim();
    return {
        Authorization: token,
        'Content-Type': 'application/json',
    };
}

type ClickUpApiErrorContext = 'list' | 'task' | 'user' | 'generic';

function explainInvalidClickUpListId(raw: string): string | null {
    const v = String(raw || '').trim();
    if (!v) return null;

    if (/^https?:\/\//i.test(v) || v.includes('app.clickup.com')) {
        const teamMatch = v.match(/app\.clickup\.com\/(\d+)/i);
        const slugMatch = v.match(/\/v\/l\/([^/?#]+)/i);
        const parts: string[] = [];
        if (teamMatch?.[1]) {
            parts.push(`"${teamMatch[1]}" is your workspace ID, not the list ID`);
        }
        if (slugMatch?.[1] && !/^\d+$/.test(slugMatch[1])) {
            parts.push(`"${slugMatch[1]}" is a ClickUp URL slug — the API needs the numeric list ID`);
        }
        if (parts.length) {
            return `${parts.join('. ')}. Use Browse lists in Admin, or right-click the list in ClickUp → Copy link.`;
        }
    }

    if (/^[a-z0-9]+-[0-9]+$/i.test(v)) {
        return `"${v}" is a ClickUp URL slug (like 2kzmz6c0-318), not an API list ID. Use Browse lists to pick the correct numeric ID.`;
    }

    // List IDs from the ClickUp API are numeric. Alphanumeric values are task/custom IDs.
    if (!/^\d+$/.test(v)) {
        return `"${v}" looks like a ClickUp task ID, not a list ID. Use Browse lists and pick your list (e.g. Project 1).`;
    }

    return null;
}

function formatClickUpApiError(err: unknown, context: ClickUpApiErrorContext): Error {
    const ax = err as {
        response?: { status?: number; data?: { ECODE?: string; err?: string } };
        message?: string;
    };
    const status = ax?.response?.status;
    if (status === 404) {
        const msg =
            context === 'list'
                ? 'ClickUp list not found — open your list in ClickUp and copy the List ID from the URL (number after /l/ or /li/). Do not use Space or Folder ID.'
                : context === 'task'
                  ? 'ClickUp task not found — it may have been deleted or your token cannot access it.'
                  : 'ClickUp resource not found — check List ID and workspace access.';
        return Object.assign(new Error(msg), { statusCode: 400 });
    }
    if (status === 401 || status === 403) {
        const msg =
            context === 'user'
                ? 'ClickUp API token rejected (401). In ClickUp → Settings → Apps, regenerate your token, paste the full pk_… key in Edit (do not leave blank), Save, then Run test again.'
                : 'ClickUp API token invalid or lacks access to this workspace/list.';
        return Object.assign(new Error(msg), { statusCode: 400 });
    }
    const ecode = String(ax?.response?.data?.ECODE || '');
    const detail = ax?.response?.data?.err || ax?.message || 'ClickUp API request failed';
    if (ecode === 'validateListIDEx' || /list id invalid/i.test(String(detail))) {
        return Object.assign(
            new Error(
                'ClickUp list ID invalid — click Browse lists, pick your list (e.g. Project 1), Save changes, then Run test. Do not use workspace ID, task ID, or URL slug.'
            ),
            { statusCode: 400 }
        );
    }
    return Object.assign(new Error(String(detail)), { statusCode: 400 });
}

export async function verifyClickUpToken(apiToken: string): Promise<{ user: string; teams: number }> {
    const token = String(apiToken || '').trim();
    if (!token) {
        throw Object.assign(new Error('ClickUp API token is required'), { statusCode: 400 });
    }
    try {
        const res = await axios.get(`${CLICKUP_API}/user`, {
            headers: clickUpHeaders(token),
            timeout: CLICKUP_TIMEOUT_MS,
        });
        const user = res.data?.user?.username || res.data?.user?.email || 'ok';
        const teams = Array.isArray(res.data?.teams) ? res.data.teams.length : 0;
        return { user: String(user), teams };
    } catch (err) {
        throw formatClickUpApiError(err, 'user');
    }
}

export async function verifyClickUpList(
    listId: string,
    apiToken: string
): Promise<{ listId: string; listName: string }> {
    const id = String(listId || '').trim();
    if (!id) {
        throw Object.assign(new Error('ClickUp List ID is required'), { statusCode: 400 });
    }
    const invalidHint = explainInvalidClickUpListId(id);
    if (invalidHint) {
        throw Object.assign(new Error(invalidHint), { statusCode: 400 });
    }
    try {
        const res = await axios.get(`${CLICKUP_API}/list/${encodeURIComponent(id)}`, {
            headers: clickUpHeaders(apiToken),
            timeout: CLICKUP_TIMEOUT_MS,
        });
        return { listId: id, listName: String(res.data?.name || 'list') };
    } catch (err) {
        throw formatClickUpApiError(err, 'list');
    }
}

export type ClickUpAccessibleList = {
    listId: string;
    listName: string;
    folderName?: string;
    spaceName: string;
    teamName: string;
    teamId: string;
    path: string;
};

export type ClickUpListDiscovery = {
    lists: ClickUpAccessibleList[];
    meta: {
        clickupUser: string;
        teamCount: number;
        teams: Array<{ id: string; name: string }>;
        spaceCount: number;
        folderCount: number;
        hint?: string;
    };
};

async function fetchClickUpTeams(apiToken: string): Promise<Array<{ id: string; name: string }>> {
    try {
        const res = await axios.get(`${CLICKUP_API}/team`, {
            headers: clickUpHeaders(apiToken),
            timeout: CLICKUP_TIMEOUT_MS,
        });
        const teams = Array.isArray(res.data?.teams) ? res.data.teams : [];
        if (teams.length) {
            return teams
                .map((t: { id?: string | number; name?: string }) => ({
                    id: String(t.id || ''),
                    name: String(t.name || 'Workspace'),
                }))
                .filter((t: { id: string; name: string }) => Boolean(t.id));
        }
    } catch {
        /* fall through to /user */
    }

    const userRes = await axios.get(`${CLICKUP_API}/user`, {
        headers: clickUpHeaders(apiToken),
        timeout: CLICKUP_TIMEOUT_MS,
    });
    const teams = Array.isArray(userRes.data?.teams) ? userRes.data.teams : [];
    return teams
        .map((t: { id?: string | number; name?: string }) => ({
            id: String(t.id || ''),
            name: String(t.name || 'Workspace'),
        }))
        .filter((t: { id: string; name: string }) => Boolean(t.id));
}

function pushUniqueLists(rows: ClickUpAccessibleList[], seen: Set<string>, next: ClickUpAccessibleList[]) {
    for (const row of next) {
        if (seen.has(row.listId)) continue;
        seen.add(row.listId);
        rows.push(row);
    }
}

async function fetchListsInSpace(
    token: string,
    teamId: string,
    teamName: string,
    spaceId: string,
    spaceName: string,
    includeArchived: boolean
): Promise<{ folderless: ClickUpAccessibleList[]; folderLists: ClickUpAccessibleList[]; folderCount: number }> {
    const folderless: ClickUpAccessibleList[] = [];
    const folderLists: ClickUpAccessibleList[] = [];
    let folderCount = 0;

    const listsRes = await axios.get(`${CLICKUP_API}/space/${encodeURIComponent(spaceId)}/list`, {
        headers: clickUpHeaders(token),
        timeout: CLICKUP_TIMEOUT_MS,
        params: { archived: includeArchived },
    });
    const lists = Array.isArray(listsRes.data?.lists) ? listsRes.data.lists : [];
    for (const list of lists) {
        const listId = String((list as { id?: string | number }).id || '');
        const listName = String((list as { name?: string }).name || 'List');
        if (!listId) continue;
        folderless.push({
            listId,
            listName,
            spaceName,
            teamName,
            teamId,
            path: `${teamName} → ${spaceName} → ${listName}`,
        });
    }

    const foldersRes = await axios.get(`${CLICKUP_API}/space/${encodeURIComponent(spaceId)}/folder`, {
        headers: clickUpHeaders(token),
        timeout: CLICKUP_TIMEOUT_MS,
        params: { archived: includeArchived },
    });
    const folders = Array.isArray(foldersRes.data?.folders) ? foldersRes.data.folders : [];
    folderCount += folders.length;
    for (const folder of folders) {
        const folderId = String((folder as { id?: string | number }).id || '');
        const folderName = String((folder as { name?: string }).name || 'Folder');
        if (!folderId) continue;
        const folderListRes = await axios.get(`${CLICKUP_API}/folder/${encodeURIComponent(folderId)}/list`, {
            headers: clickUpHeaders(token),
            timeout: CLICKUP_TIMEOUT_MS,
            params: { archived: includeArchived },
        });
        const folderListRows = Array.isArray(folderListRes.data?.lists) ? folderListRes.data.lists : [];
        for (const list of folderListRows) {
            const listId = String((list as { id?: string | number }).id || '');
            const listName = String((list as { name?: string }).name || 'List');
            if (!listId) continue;
            folderLists.push({
                listId,
                listName,
                folderName,
                spaceName,
                teamName,
                teamId,
                path: `${teamName} → ${spaceName} → ${folderName} → ${listName}`,
            });
        }
    }

    return { folderless, folderLists, folderCount };
}

export async function listClickUpAccessibleLists(apiToken: string): Promise<ClickUpListDiscovery> {
    const token = String(apiToken || '').trim();
    if (!token) {
        throw Object.assign(new Error('ClickUp API token is required'), { statusCode: 400 });
    }

    let clickupUser = 'unknown';
    try {
        const userRes = await axios.get(`${CLICKUP_API}/user`, {
            headers: clickUpHeaders(token),
            timeout: CLICKUP_TIMEOUT_MS,
        });
        clickupUser = String(userRes.data?.user?.username || userRes.data?.user?.email || 'ok');
    } catch (err) {
        throw formatClickUpApiError(err, 'user');
    }

    const teams = await fetchClickUpTeams(token);
    const rows: ClickUpAccessibleList[] = [];
    const seen = new Set<string>();
    let spaceCount = 0;
    let folderCount = 0;

    for (const team of teams) {
        for (const includeArchived of [false, true]) {
            let spaces: Array<{ id?: string | number; name?: string }> = [];
            try {
                const spacesRes = await axios.get(`${CLICKUP_API}/team/${encodeURIComponent(team.id)}/space`, {
                    headers: clickUpHeaders(token),
                    timeout: CLICKUP_TIMEOUT_MS,
                    params: { archived: includeArchived },
                });
                spaces = Array.isArray(spacesRes.data?.spaces) ? spacesRes.data.spaces : [];
            } catch {
                continue;
            }

            for (const space of spaces) {
                const spaceId = String(space.id || '');
                const spaceName = String(space.name || 'Space');
                if (!spaceId) continue;
                spaceCount += 1;
                try {
                    const batch = await fetchListsInSpace(
                        token,
                        team.id,
                        team.name,
                        spaceId,
                        spaceName,
                        includeArchived
                    );
                    folderCount += batch.folderCount;
                    pushUniqueLists(rows, seen, batch.folderless);
                    pushUniqueLists(rows, seen, batch.folderLists);
                } catch {
                    /* optional */
                }
            }
        }
    }

    const meta = {
        clickupUser,
        teamCount: teams.length,
        teams,
        spaceCount,
        folderCount,
        hint: undefined as string | undefined,
    };

    if (!teams.length) {
        meta.hint =
            'This API token cannot see any ClickUp workspace. Log into ClickUp in your browser, open Settings → Apps → regenerate API Token, then save it here.';
    } else if (!rows.length) {
        const teamPreview = teams.map((t) => `${t.name} (${t.id})`).join(', ');
        meta.hint = `Token user "${clickupUser}" sees workspace(s): ${teamPreview}, but the API returned 0 lists. Common causes: Guest role (need Member/Admin), private Space access, or wrong ClickUp account. Try resolving from a task link below.`;
    }

    return { lists: rows.sort((a, b) => a.path.localeCompare(b.path)), meta };
}

export function extractClickUpTaskId(raw: string): string {
    const v = String(raw || '').trim();
    if (!v) return '';

    // New ClickUp task URLs: /t/{workspace_id}/{custom_task_id}
    const modern = v.match(/\/t\/\d+\/([a-zA-Z0-9-]+)/);
    if (modern?.[1]) return modern[1];

    const patterns = [
        /\/t\/([a-zA-Z0-9-]+)/,
        /[?&]task_id=([a-zA-Z0-9-]+)/,
        /\/task\/([a-zA-Z0-9-]+)/,
    ];
    for (const re of patterns) {
        const m = v.match(re);
        if (m?.[1]) return m[1];
    }
    return v;
}

export async function resolveClickUpListFromTaskRef(
    taskRef: string,
    apiToken: string
): Promise<{ listId: string; listName: string; taskId: string; taskName: string; teamId?: string }> {
    const taskId = extractClickUpTaskId(taskRef);
    if (!taskId) {
        throw Object.assign(new Error('Paste a ClickUp task link or task ID from a task inside your HR list.'), {
            statusCode: 400,
        });
    }
    const task = await fetchClickUpTask(taskId, apiToken);
    const list = task.list as { id?: string | number; name?: string } | undefined;
    const listId = String(list?.id || '');
    if (!listId) {
        throw Object.assign(new Error('Could not read list ID from that task. Try another task in your hiring list.'), {
            statusCode: 400,
        });
    }
    const team = task.team_id ?? (task.team as { id?: string | number } | undefined)?.id;
    return {
        listId,
        listName: String(list?.name || 'list'),
        taskId: String(task.id || taskId),
        taskName: String(task.name || 'task'),
        teamId: team != null ? String(team) : undefined,
    };
}

export async function fetchClickUpTask(taskId: string, apiToken: string): Promise<Record<string, unknown>> {
    try {
        const res = await axios.get(`${CLICKUP_API}/task/${encodeURIComponent(taskId)}`, {
            headers: clickUpHeaders(apiToken),
            timeout: CLICKUP_TIMEOUT_MS,
            params: { include_subtasks: false },
        });
        return res.data || {};
    } catch (err) {
        throw formatClickUpApiError(err, 'task');
    }
}

export async function fetchClickUpListTasks(listId: string, apiToken: string): Promise<Array<Record<string, unknown>>> {
    const tasks: Array<Record<string, unknown>> = [];
    let page = 0;
    const maxPages = 20;
    try {
        while (page < maxPages) {
            const res = await axios.get(`${CLICKUP_API}/list/${encodeURIComponent(listId)}/task`, {
                headers: clickUpHeaders(apiToken),
                timeout: CLICKUP_TIMEOUT_MS,
                params: { page, include_closed: true, subtasks: false },
            });
            const batch = Array.isArray(res.data?.tasks) ? res.data.tasks : [];
            tasks.push(...batch);
            if (batch.length < 100) break;
            page += 1;
        }
        return tasks;
    } catch (err) {
        throw formatClickUpApiError(err, 'list');
    }
}

function taskListId(task: Record<string, unknown>): string {
    const list = task.list as { id?: string } | undefined;
    return String(list?.id || '');
}

function taskAttachments(task: Record<string, unknown>): ClickUpAttachment[] {
    const raw = task.attachments;
    if (!Array.isArray(raw)) return [];
    return raw
        .map((a) => ({
            id: String((a as ClickUpAttachment).id || ''),
            title: (a as ClickUpAttachment).title,
            url: (a as ClickUpAttachment).url,
            extension: (a as ClickUpAttachment).extension,
            mimetype: (a as ClickUpAttachment).mimetype,
            size: (a as ClickUpAttachment).size,
        }))
        .filter((a) => a.id && a.url);
}

function attachmentFilename(att: ClickUpAttachment): string {
    const title = String(att.title || 'attachment').trim() || 'attachment';
    if (path.extname(title)) return title;
    const ext = String(att.extension || '').replace(/^\./, '').trim();
    if (ext) return `${title}.${ext}`;
    return title;
}

export async function downloadClickUpAttachment(
    att: ClickUpAttachment,
    apiToken: string
): Promise<IngestUploadInput> {
    const url = String(att.url || '').trim();
    if (!url) {
        throw Object.assign(new Error('Attachment has no download URL'), { statusCode: 400 });
    }
    const originalname = attachmentFilename(att);
    const ext = getExtension(originalname);
    const mimeType =
        String(att.mimetype || '').trim() ||
        (ext === 'pdf'
            ? 'application/pdf'
            : ext === 'xlsx'
              ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
              : ext === 'csv'
                ? 'text/csv'
                : 'application/octet-stream');

    const validation = isAllowedFile(originalname, mimeType);
    if (!validation.ok) {
        throw Object.assign(new Error(validation.reason || 'File type not allowed'), { statusCode: 415 });
    }

    const res = await axios.get(url, {
        headers: clickUpHeaders(apiToken),
        responseType: 'arraybuffer',
        timeout: CLICKUP_TIMEOUT_MS,
        maxContentLength: 52_428_800,
    });

    const buffer = Buffer.from(res.data);
    const tmpPath = path.join(os.tmpdir(), `clickup_${Date.now()}_${Math.random().toString(36).slice(2)}_${originalname}`);
    fs.writeFileSync(tmpPath, buffer);

    return {
        path: tmpPath,
        originalname,
        mimetype: mimeType,
        size: buffer.length,
    };
}

async function attachmentAlreadyIngested(
    organizationId: string,
    connectionId: string,
    attachmentId: string
): Promise<boolean> {
    const hit = await Document.findOne({
        organizationId,
        'metadata.integrationConnectionId': connectionId,
        'metadata.integrationExternalRef.clickupAttachmentId': attachmentId,
    })
        .select('documentId')
        .lean();
    return Boolean(hit);
}

export async function ingestClickUpAttachment(opts: {
    connection: IIntegrationConnection;
    task: Record<string, unknown>;
    attachment: ClickUpAttachment;
    apiToken: string;
}) {
    const { connection, task, attachment, apiToken } = opts;

    if (
        await attachmentAlreadyIngested(
            connection.organizationId,
            connection.connectionId,
            attachment.id
        )
    ) {
        return { skipped: true as const, reason: 'already_ingested', attachmentId: attachment.id };
    }

    let tmpPath = '';
    try {
        const file = await downloadClickUpAttachment(attachment, apiToken);
        tmpPath = file.path;
        const result = await ingestFileForConnection({
            connection,
            file,
            ingestMode: 'multipart',
            externalRef: {
                clickupAttachmentId: attachment.id,
                clickupTaskId: String(task.id || ''),
                clickupTaskName: String(task.name || ''),
                clickupListId: taskListId(task),
            },
        });
        return { skipped: false as const, result };
    } finally {
        if (tmpPath && fs.existsSync(tmpPath)) {
            try {
                fs.unlinkSync(tmpPath);
            } catch {
                /* ignore */
            }
        }
    }
}

function listFilterMatches(connection: IIntegrationConnection, task: Record<string, unknown>): boolean {
    const configured = String(connection.config?.listId || connection.config?.clickupListId || '').trim();
    if (!configured) return true;
    return taskListId(task) === configured;
}

export async function ingestAttachmentsFromTask(connection: IIntegrationConnection, taskId: string) {
    const apiToken = String(connection.secrets?.apiToken || '').trim();
    if (!apiToken) {
        throw Object.assign(new Error('ClickUp API token not configured on this connection'), { statusCode: 400 });
    }

    const task = await fetchClickUpTask(taskId, apiToken);
    if (!listFilterMatches(connection, task)) {
        return {
            ingested: 0,
            skipped: 0,
            failed: 0,
            recordsIngested: 0,
            recordsUpdated: 0,
            details: [{ taskId, reason: 'list_filter' }],
        };
    }

    let recordsIngested = 0;
    let recordsUpdated = 0;
    try {
        const recordResult = await ingestClickUpTaskRecord(connection, task);
        if (recordResult.updated) recordsUpdated += 1;
        else recordsIngested += 1;
    } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : 'task record ingest failed';
        return {
            ingested: 0,
            skipped: 0,
            failed: 1,
            recordsIngested: 0,
            recordsUpdated: 0,
            details: [{ taskId, status: 'failed', error: msg }],
        };
    }

    const attachments = taskAttachments(task);
    let ingested = 0;
    let skipped = 0;
    let failed = 0;
    const details: Array<Record<string, unknown>> = [];

    for (const att of attachments) {
        try {
            const out = await ingestClickUpAttachment({ connection, task, attachment: att, apiToken });
            if (out.skipped) {
                skipped += 1;
                details.push({ attachmentId: att.id, status: 'skipped', reason: out.reason });
            } else {
                ingested += 1;
                details.push({
                    attachmentId: att.id,
                    status: 'ingested',
                    documentId: out.result.documentId,
                    filename: out.result.filename,
                });
            }
        } catch (e: any) {
            failed += 1;
            details.push({ attachmentId: att.id, status: 'failed', error: e?.message || 'ingest failed' });
        }
    }

    return {
        ingested,
        skipped,
        failed,
        recordsIngested,
        recordsUpdated,
        details,
        taskId,
        attachmentCount: attachments.length,
    };
}

export async function syncClickUpList(connection: IIntegrationConnection) {
    const apiToken = String(connection.secrets?.apiToken || '').trim();
    const listId = String(connection.config?.listId || connection.config?.clickupListId || '').trim();
    if (!apiToken) {
        throw Object.assign(new Error('ClickUp API token not configured'), { statusCode: 400 });
    }
    if (!listId) {
        throw Object.assign(new Error('ClickUp List ID is required for sync'), { statusCode: 400 });
    }

    const tasks = await fetchClickUpListTasks(listId, apiToken);
    let ingested = 0;
    let skipped = 0;
    let failed = 0;
    let recordsIngested = 0;
    let recordsUpdated = 0;
    let attachmentCount = 0;
    const details: Array<Record<string, unknown>> = [];

    // List tasks API returns lightweight rows — attachments only appear on GET /task/{id}.
    for (const task of tasks) {
        const taskId = String(task.id || '');
        if (!taskId) continue;
        try {
            const summary = await ingestAttachmentsFromTask(connection, taskId);
            ingested += summary.ingested;
            skipped += summary.skipped;
            failed += summary.failed;
            recordsIngested += summary.recordsIngested ?? 0;
            recordsUpdated += summary.recordsUpdated ?? 0;
            attachmentCount += summary.attachmentCount ?? 0;
            if (summary.details?.length) {
                details.push(...summary.details.map((d) => ({ taskId, ...d })));
            }
        } catch (e: any) {
            failed += 1;
            details.push({ taskId, status: 'failed', error: e?.message || 'task sync failed' });
        }
    }

    return {
        ingested,
        skipped,
        failed,
        recordsIngested,
        recordsUpdated,
        taskCount: tasks.length,
        attachmentCount,
        details: details.slice(0, 50),
    };
}

export async function processClickUpWebhook(
    connection: IIntegrationConnection,
    payload: ClickUpWebhookPayload
) {
    const taskId = String(payload?.task_id || '').trim();
    if (!taskId) {
        return { ok: true, action: 'ignored', reason: 'no task_id in webhook payload' };
    }

    const event = String(payload?.event || '').toLowerCase();
    const relevant =
        !event ||
        event.includes('task') ||
        event.includes('attachment') ||
        (Array.isArray(payload.history_items) &&
            payload.history_items.some((h) => String(h.field || '').toLowerCase().includes('attachment')));
    if (!relevant) {
        return { ok: true, action: 'ignored', reason: `event ${event || 'unknown'} not handled`, taskId };
    }

    const summary = await ingestAttachmentsFromTask(connection, taskId);
    return { ok: true, action: 'processed', taskId, ...summary };
}

export function buildClickUpWebhookUrl(base: string, connectionId: string, ingestKey: string): string {
    const root = base.replace(/\/$/, '');
    return `${root}/api/docs/integrations/clickup/${encodeURIComponent(connectionId)}/webhook?key=${encodeURIComponent(ingestKey)}`;
}

export type ClickUpMember = {
    id: number;
    username: string;
    email: string;
    label: string;
};

function normalizeMember(raw: unknown): ClickUpMember | null {
    const o = (raw && typeof raw === 'object' ? raw : null) as Record<string, unknown> | null;
    if (!o) return null;
    const user = (o.user && typeof o.user === 'object' ? o.user : o) as Record<string, unknown>;
    const idNum = Number(user.id ?? o.id);
    if (!Number.isFinite(idNum) || idNum <= 0) return null;
    const username = String(user.username || user.name || '').trim();
    const email = String(user.email || '').trim();
    const label = username && email ? `${username} (${email})` : username || email || String(idNum);
    return { id: idNum, username, email, label };
}

/** Workspace + list members who can be assigned on tasks. */
export async function listClickUpAssignableMembers(
    apiToken: string,
    opts?: { listId?: string; teamId?: string }
): Promise<ClickUpMember[]> {
    const byId = new Map<number, ClickUpMember>();

    const push = (raw: unknown) => {
        const m = normalizeMember(raw);
        if (m) byId.set(m.id, m);
    };

    try {
        const res = await axios.get(`${CLICKUP_API}/team`, {
            headers: clickUpHeaders(apiToken),
            timeout: CLICKUP_TIMEOUT_MS,
        });
        const teams = Array.isArray(res.data?.teams) ? res.data.teams : [];
        for (const team of teams) {
            const teamId = String((team as { id?: string | number }).id || '');
            if (opts?.teamId && teamId && teamId !== opts.teamId) continue;
            const members = Array.isArray((team as { members?: unknown[] }).members)
                ? (team as { members: unknown[] }).members
                : [];
            for (const mem of members) push(mem);
        }
    } catch (err) {
        throw formatClickUpApiError(err, 'user');
    }

    const listId = String(opts?.listId || '').trim();
    if (listId) {
        try {
            const res = await axios.get(`${CLICKUP_API}/list/${encodeURIComponent(listId)}/member`, {
                headers: clickUpHeaders(apiToken),
                timeout: CLICKUP_TIMEOUT_MS,
            });
            const members = Array.isArray(res.data?.members) ? res.data.members : [];
            for (const mem of members) push(mem);
        } catch {
            /* list members optional — team members already loaded */
        }
    }

    return [...byId.values()].sort((a, b) => a.label.localeCompare(b.label));
}

export async function createClickUpTask(
    listId: string,
    apiToken: string,
    input: { name: string; assignees?: number[]; description?: string; status?: string }
): Promise<Record<string, unknown>> {
    const id = String(listId || '').trim();
    const name = String(input.name || '').trim();
    if (!id) {
        throw Object.assign(new Error('ClickUp List ID is required to create a task'), { statusCode: 400 });
    }
    if (!name) {
        throw Object.assign(new Error('Task name is required'), { statusCode: 400 });
    }
    const body: Record<string, unknown> = { name };
    if (input.description) body.description = input.description;
    if (input.status) body.status = input.status;
    if (Array.isArray(input.assignees) && input.assignees.length) {
        body.assignees = input.assignees;
    }
    try {
        const res = await axios.post(`${CLICKUP_API}/list/${encodeURIComponent(id)}/task`, body, {
            headers: clickUpHeaders(apiToken),
            timeout: CLICKUP_TIMEOUT_MS,
        });
        return res.data || {};
    } catch (err) {
        throw formatClickUpApiError(err, 'list');
    }
}

export async function assignClickUpTask(
    taskId: string,
    apiToken: string,
    opts: { add?: number[]; rem?: number[] }
): Promise<Record<string, unknown>> {
    const id = String(taskId || '').trim();
    if (!id) {
        throw Object.assign(new Error('ClickUp task ID is required'), { statusCode: 400 });
    }
    const add = (opts.add || []).filter((n) => Number.isFinite(n) && n > 0);
    const rem = (opts.rem || []).filter((n) => Number.isFinite(n) && n > 0);
    if (!add.length && !rem.length) {
        throw Object.assign(new Error('Provide at least one assignee to add or remove'), { statusCode: 400 });
    }
    try {
        const res = await axios.put(
            `${CLICKUP_API}/task/${encodeURIComponent(id)}`,
            { assignees: { add, rem } },
            {
                headers: clickUpHeaders(apiToken),
                timeout: CLICKUP_TIMEOUT_MS,
            }
        );
        return res.data || {};
    } catch (err) {
        throw formatClickUpApiError(err, 'task');
    }
}

export async function updateClickUpTaskStatus(
    taskId: string,
    apiToken: string,
    status: string
): Promise<Record<string, unknown>> {
    const id = String(taskId || '').trim();
    const statusName = String(status || '').trim();
    if (!id) {
        throw Object.assign(new Error('ClickUp task ID is required'), { statusCode: 400 });
    }
    if (!statusName) {
        throw Object.assign(new Error('Status name is required'), { statusCode: 400 });
    }
    try {
        const res = await axios.put(
            `${CLICKUP_API}/task/${encodeURIComponent(id)}`,
            { status: statusName },
            {
                headers: clickUpHeaders(apiToken),
                timeout: CLICKUP_TIMEOUT_MS,
            }
        );
        return res.data || {};
    } catch (err) {
        throw formatClickUpApiError(err, 'task');
    }
}

/** Pick a closed/complete status name for a list (falls back to "complete"). */
export async function resolveClickUpCompleteStatus(
    listId: string,
    apiToken: string
): Promise<string> {
    const id = String(listId || '').trim();
    if (!id) return 'complete';
    try {
        const res = await axios.get(`${CLICKUP_API}/list/${encodeURIComponent(id)}`, {
            headers: clickUpHeaders(apiToken),
            timeout: CLICKUP_TIMEOUT_MS,
        });
        const statuses = Array.isArray(res.data?.statuses) ? res.data.statuses : [];
        const names = statuses
            .map((s: { status?: string; type?: string }) => ({
                status: String(s.status || '').trim(),
                type: String(s.type || '').toLowerCase(),
            }))
            .filter((s: { status: string }) => Boolean(s.status));
        const closed =
            names.find((s: { type: string }) => s.type === 'closed' || s.type === 'done') ||
            names.find((s: { status: string }) =>
                /^(complete|closed|done|resolved)$/i.test(s.status)
            ) ||
            names.find((s: { status: string }) => /complete|closed|done|resolved/i.test(s.status));
        return closed?.status || 'complete';
    } catch {
        return 'complete';
    }
}
