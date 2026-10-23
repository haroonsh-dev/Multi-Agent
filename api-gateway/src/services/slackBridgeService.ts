/**
 * Slack bridge — same flow as ClickUp for the universal task layer:
 * connect bot token + channel → webhook → sync messages as tasks → create/assign from chat.
 */
import axios from 'axios';
import type { IIntegrationConnection } from '../models/IntegrationConnection';
import { ingestStructuredRecordForConnection } from './integrationRecordIngestService';

const SLACK_API = 'https://slack.com/api';
const SLACK_TIMEOUT_MS = 30_000;

export type SlackMember = {
    id: number;
    slackUserId: string;
    username: string;
    email: string;
    label: string;
};

function slackHeaders(botToken: string) {
    let token = String(botToken || '').trim();
    if (/^bearer\s+/i.test(token)) token = token.replace(/^bearer\s+/i, '').trim();
    return {
        Authorization: `Bearer ${token}`,
        // Slack Web API (esp. conversations.info / history) expects form bodies — JSON → invalid_arguments
        'Content-Type': 'application/x-www-form-urlencoded; charset=utf-8',
    };
}

/** Reject app-level / user tokens — Web API needs Bot User OAuth Token (xoxb-…). */
export function assertSlackBotToken(token: string): string {
    const t = String(token || '').trim().replace(/^bearer\s+/i, '').trim();
    if (!t) {
        throw Object.assign(new Error('Slack bot token is required (xoxb-…).'), { statusCode: 400 });
    }
    if (/^xapp-/i.test(t)) {
        throw Object.assign(
            new Error(
                'Wrong token type (xapp-…). Use Bot User OAuth Token from api.slack.com → Your App → OAuth & Permissions → Bot User OAuth Token (starts with xoxb-). App-level tokens (xapp-) are not supported.'
            ),
            { statusCode: 400 }
        );
    }
    if (/^xoxp-/i.test(t)) {
        throw Object.assign(
            new Error(
                'Wrong token type (xoxp- user token). Use Bot User OAuth Token (xoxb-…) from OAuth & Permissions.'
            ),
            { statusCode: 400 }
        );
    }
    if (!/^xoxb-/i.test(t)) {
        throw Object.assign(
            new Error(
                'Slack token must be a Bot User OAuth Token starting with xoxb-. Open api.slack.com → OAuth & Permissions and copy Bot User OAuth Token.'
            ),
            { statusCode: 400 }
        );
    }
    return t;
}

function formatSlackError(err: unknown, fallback: string): Error {
    const ax = err as {
        response?: { status?: number; data?: { error?: string; ok?: boolean } };
        message?: string;
    };
    const apiErr = String(ax?.response?.data?.error || '');
    const detail = apiErr || ax?.message || fallback;
    const status = ax?.response?.status;
    if (apiErr === 'not_allowed_token_type') {
        return Object.assign(
            new Error(
                'Slack rejected this token type. Paste Bot User OAuth Token (xoxb-…), not App-Level Token (xapp-…). Path: api.slack.com → Your App → OAuth & Permissions → Bot User OAuth Token.'
            ),
            { statusCode: 400 }
        );
    }
    if (apiErr === 'invalid_arguments' || apiErr === 'missing_argument') {
        return Object.assign(
            new Error(
                'Slack channel request failed (invalid_arguments). Confirm Channel ID (C…) is correct, bot has channels:read, and the bot is invited to the channel (/invite @YourBot).'
            ),
            { statusCode: 400 }
        );
    }
    if (apiErr === 'missing_scope') {
        return Object.assign(
            new Error(
                'Slack bot is missing a required scope. Add channels:history, channels:read, chat:write, users:read, users:read.email, reactions:write — then Reinstall the app to the workspace.'
            ),
            { statusCode: 400 }
        );
    }
    if (status === 401 || status === 403 || apiErr === 'invalid_auth' || apiErr === 'not_authed') {
        return Object.assign(
            new Error('Slack bot token rejected. Create a bot at api.slack.com → OAuth & Permissions → Bot User OAuth Token (xoxb-…).'),
            { statusCode: 400 }
        );
    }
    if (apiErr === 'channel_not_found' || apiErr === 'not_in_channel') {
        return Object.assign(
            new Error(
                'Slack channel not found or bot is not in the channel. Open the channel, run /invite @YourBot, then use Channel ID (C…).'
            ),
            { statusCode: 400 }
        );
    }
    return Object.assign(new Error(String(detail)), { statusCode: 400 });
}

async function slackApi<T = Record<string, unknown>>(
    method: string,
    botToken: string,
    body?: Record<string, unknown>
): Promise<T> {
    const token = assertSlackBotToken(botToken);
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(body || {})) {
        if (v === undefined || v === null) continue;
        if (typeof v === 'object') params.set(k, JSON.stringify(v));
        else params.set(k, String(v));
    }
    try {
        const res = await axios.post(`${SLACK_API}/${method}`, params.toString(), {
            headers: slackHeaders(token),
            timeout: SLACK_TIMEOUT_MS,
        });
        if (!res.data?.ok) {
            throw Object.assign(new Error(String(res.data?.error || 'Slack API error')), {
                response: { status: 400, data: res.data },
            });
        }
        return res.data as T;
    } catch (err) {
        throw formatSlackError(err, `Slack ${method} failed`);
    }
}

/** Stable numeric id for chat matching (Slack user ids are strings). */
export function slackUserIdToNumeric(slackUserId: string): number {
    const s = String(slackUserId || '').trim();
    let h = 0;
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
    return h || 1;
}

/**
 * Accept raw Channel ID (C…) or a Slack URL that contains it.
 * Rejects DMs (D…) — bots sync workspace channels, not 1:1 DMs.
 */
export function normalizeSlackChannelId(raw: string): string {
    const v = String(raw || '').trim();
    if (!v) return '';

    const fromUrl =
        v.match(/\/(?:client\/[^/]+|archives)\/([CG][A-Z0-9]+)/i) ||
        v.match(/\b([CG][A-Z0-9]{8,})\b/i);
    if (fromUrl?.[1]) return fromUrl[1].toUpperCase();

    if (/^[CG][A-Z0-9]+$/i.test(v)) return v.toUpperCase();

    return v;
}

export function connectionSlackCreds(connection: IIntegrationConnection): {
    botToken: string;
    channelId: string;
} {
    const botToken = String(
        connection.secrets?.botToken || connection.secrets?.apiToken || ''
    ).trim();
    const channelId = normalizeSlackChannelId(
        String(
            connection.config?.channelId || connection.config?.listId || connection.config?.slackChannelId || ''
        )
    );
    return { botToken, channelId };
}

export async function verifySlackToken(botToken: string): Promise<{ user: string; team: string }> {
    const token = assertSlackBotToken(botToken);
    const data = await slackApi<{
        user?: string;
        user_id?: string;
        team?: string;
        team_id?: string;
    }>('auth.test', token);
    return {
        user: String(data.user || data.user_id || 'ok'),
        team: String(data.team || data.team_id || ''),
    };
}

export async function verifySlackChannel(
    botToken: string,
    channelId: string
): Promise<{ id: string; name: string }> {
    const token = assertSlackBotToken(botToken);
    const raw = String(channelId || '').trim();
    const id = normalizeSlackChannelId(raw);
    if (!id) {
        throw Object.assign(new Error('Slack Channel ID is required'), { statusCode: 400 });
    }
    if (/^D/i.test(id) || /^D/i.test(raw) || /\/D[A-Z0-9]+/i.test(raw)) {
        throw Object.assign(
            new Error(
                [
                    'That looks like a Direct Message (D…), not a channel.',
                    '1) Open a Channel (e.g. #general or #hr-hiring) — not a DM.',
                    '2) Click the channel name → View channel details.',
                    '3) Scroll to the bottom → copy Channel ID (starts with C…).',
                    '4) In the channel type: /invite @YourBot',
                    '5) Paste the C… ID and Run test again.',
                ].join(' ')
            ),
            { statusCode: 400 }
        );
    }
    if (!/^[CG][A-Z0-9]+$/i.test(id)) {
        throw Object.assign(
            new Error(
                'Invalid Channel ID. Paste a Channel ID starting with C… (or a Slack channel URL). Example: C0123456789'
            ),
            { statusCode: 400 }
        );
    }
    const data = await slackApi<{ channel?: { id?: string; name?: string } }>('conversations.info', token, {
        channel: id,
    });
    const ch = data.channel || {};
    return { id: String(ch.id || id), name: String(ch.name || id) };
}

function messageToTaskRecord(msg: Record<string, unknown>, channelId: string, channelName?: string) {
    const ts = String(msg.ts || '').trim();
    const text = String(msg.text || '').trim() || '(empty message)';
    const user = String(msg.user || msg.username || '').trim();
    const taskId = ts;
    const status = msg.reactions
        ? Array.isArray(msg.reactions) &&
          (msg.reactions as Array<{ name?: string }>).some((r) =>
              /white_check_mark|heavy_check_mark|done|complete/i.test(String(r.name || ''))
          )
            ? 'complete'
            : 'open'
        : 'open';

    return {
        recordType: 'task' as const,
        title: text.slice(0, 120),
        externalId: taskId ? `slack:msg:${taskId}` : undefined,
        data: {
            taskId,
            name: text.slice(0, 200),
            description: text,
            status,
            assignees: user ? [{ id: user, username: user }] : [],
            channel: { id: channelId, name: channelName || channelId },
            list: { id: channelId, name: channelName || channelId },
            url: '',
            date_created: ts,
            date_updated: ts,
            provider: 'slack',
        },
        externalRef: {
            recordId: taskId ? `slack:msg:${taskId}` : undefined,
            slackMessageTs: taskId,
            slackChannelId: channelId,
            slackChannelName: channelName,
            slackUserId: user,
        },
    };
}

export async function ingestSlackMessageRecord(
    connection: IIntegrationConnection,
    msg: Record<string, unknown>,
    channelName?: string
) {
    const { channelId } = connectionSlackCreds(connection);
    const input = messageToTaskRecord(msg, channelId, channelName);
    return ingestStructuredRecordForConnection({ connection, input });
}

export async function syncSlackChannel(connection: IIntegrationConnection) {
    const { botToken, channelId } = connectionSlackCreds(connection);
    if (!botToken) {
        throw Object.assign(new Error('Slack bot token not configured'), { statusCode: 400 });
    }
    if (!channelId) {
        throw Object.assign(new Error('Slack Channel ID is required for sync'), { statusCode: 400 });
    }

    let channelName = channelId;
    try {
        const info = await verifySlackChannel(botToken, channelId);
        channelName = info.name;
    } catch {
        /* continue with id */
    }

    const data = await slackApi<{ messages?: Array<Record<string, unknown>> }>('conversations.history', botToken, {
        channel: channelId,
        limit: 50,
    });
    const messages = Array.isArray(data.messages) ? data.messages : [];

    let recordsIngested = 0;
    let recordsUpdated = 0;
    let failed = 0;
    const details: Array<Record<string, unknown>> = [];

    for (const msg of messages) {
        if (msg.subtype && msg.subtype !== 'file_share') continue;
        const ts = String(msg.ts || '');
        if (!ts) continue;
        try {
            const result = await ingestSlackMessageRecord(connection, msg, channelName);
            if (result.updated) recordsUpdated += 1;
            else recordsIngested += 1;
            details.push({ ts, status: result.updated ? 'updated' : 'ingested', title: result.title });
        } catch (e: unknown) {
            failed += 1;
            details.push({
                ts,
                status: 'failed',
                error: e instanceof Error ? e.message : 'ingest failed',
            });
        }
    }

    return {
        ingested: 0,
        skipped: 0,
        failed,
        recordsIngested,
        recordsUpdated,
        taskCount: messages.length,
        attachmentCount: 0,
        details: details.slice(0, 50),
    };
}

/** Slack Events API — url_verification + message events. */
export async function processSlackWebhook(
    connection: IIntegrationConnection,
    payload: Record<string, unknown>
): Promise<Record<string, unknown>> {
    const type = String(payload.type || '');
    if (type === 'url_verification') {
        return { ok: true, challenge: payload.challenge, action: 'url_verification' };
    }

    const event = (payload.event || {}) as Record<string, unknown>;
    const eventType = String(event.type || '');
    if (eventType !== 'message' && eventType !== 'app_mention') {
        return { ok: true, action: 'ignored', reason: `event ${eventType || type || 'unknown'}` };
    }
    if (event.bot_id || event.subtype === 'bot_message') {
        return { ok: true, action: 'ignored', reason: 'bot message' };
    }

    const { channelId } = connectionSlackCreds(connection);
    const eventChannel = String(event.channel || '').trim();
    if (channelId && eventChannel && eventChannel !== channelId) {
        return { ok: true, action: 'ignored', reason: 'different channel', channel: eventChannel };
    }

    let channelName = channelId;
    try {
        const { botToken } = connectionSlackCreds(connection);
        if (botToken && eventChannel) {
            const info = await verifySlackChannel(botToken, eventChannel);
            channelName = info.name;
        }
    } catch {
        /* optional */
    }

    const result = await ingestSlackMessageRecord(connection, event, channelName);
    return {
        ok: true,
        action: result.updated ? 'updated' : 'ingested',
        documentId: result.documentId,
        title: result.title,
    };
}

export async function listSlackAssignableMembers(
    botToken: string,
    opts?: { channelId?: string }
): Promise<SlackMember[]> {
    const byId = new Map<string, SlackMember>();

    const push = (u: Record<string, unknown>) => {
        if (u.deleted || u.is_bot) return;
        const slackUserId = String(u.id || '').trim();
        if (!slackUserId) return;
        const profile = (u.profile || {}) as Record<string, unknown>;
        const username = String(u.name || profile.display_name || profile.real_name || slackUserId).trim();
        const email = String(profile.email || '').trim();
        const real = String(profile.real_name || username).trim();
        const label = email ? `${real} (${email})` : real;
        byId.set(slackUserId, {
            id: slackUserIdToNumeric(slackUserId),
            slackUserId,
            username,
            email,
            label,
        });
    };

    const channelId = String(opts?.channelId || '').trim();
    if (channelId) {
        try {
            const data = await slackApi<{ members?: string[] }>('conversations.members', botToken, {
                channel: channelId,
                limit: 200,
            });
            const ids = Array.isArray(data.members) ? data.members : [];
            for (const uid of ids.slice(0, 80)) {
                try {
                    const info = await slackApi<{ user?: Record<string, unknown> }>('users.info', botToken, {
                        user: uid,
                    });
                    if (info.user) push(info.user);
                } catch {
                    /* skip */
                }
            }
        } catch {
            /* fall through to users.list */
        }
    }

    if (!byId.size) {
        const data = await slackApi<{ members?: Array<Record<string, unknown>> }>('users.list', botToken, {
            limit: 200,
        });
        for (const u of data.members || []) push(u);
    }

    return [...byId.values()].sort((a, b) => a.label.localeCompare(b.label));
}

export async function createSlackTask(
    channelId: string,
    botToken: string,
    input: { name: string; assignees?: number[]; description?: string; memberMap?: Map<number, string> }
): Promise<Record<string, unknown>> {
    const channel = String(channelId || '').trim();
    const name = String(input.name || '').trim();
    if (!channel) {
        throw Object.assign(new Error('Slack Channel ID is required to create a task'), { statusCode: 400 });
    }
    if (!name) {
        throw Object.assign(new Error('Task name is required'), { statusCode: 400 });
    }

    let text = `*Task:* ${name}`;
    if (input.description) text += `\n${input.description}`;
    const mentions: string[] = [];
    if (input.assignees?.length && input.memberMap) {
        for (const id of input.assignees) {
            const slackId = input.memberMap.get(id);
            if (slackId) mentions.push(`<@${slackId}>`);
        }
    }
    if (mentions.length) text += `\nAssigned: ${mentions.join(' ')}`;

    const data = await slackApi<{ ts?: string; channel?: string; message?: Record<string, unknown> }>(
        'chat.postMessage',
        botToken,
        { channel, text }
    );

    const ts = String(data.ts || '').trim();
    return {
        id: ts,
        name,
        url: '',
        channel: data.channel || channel,
        ts,
    };
}

export async function assignSlackTask(
    taskTs: string,
    botToken: string,
    opts: {
        channelId: string;
        add?: number[];
        memberMap?: Map<number, string>;
        taskName?: string;
    }
): Promise<Record<string, unknown>> {
    const ts = String(taskTs || '').trim();
    const channel = String(opts.channelId || '').trim();
    if (!ts || !channel) {
        throw Object.assign(new Error('Slack message ts and channel are required'), { statusCode: 400 });
    }
    const mentions: string[] = [];
    for (const id of opts.add || []) {
        const slackId = opts.memberMap?.get(id);
        if (slackId) mentions.push(`<@${slackId}>`);
    }
    if (!mentions.length) {
        throw Object.assign(new Error('Provide at least one assignee'), { statusCode: 400 });
    }
    const text = `Assigned ${mentions.join(' ')}${opts.taskName ? ` → *${opts.taskName}*` : ''}`;
    const data = await slackApi('chat.postMessage', botToken, {
        channel,
        thread_ts: ts,
        text,
    });
    return data as Record<string, unknown>;
}

export async function updateSlackTaskStatus(
    taskTs: string,
    botToken: string,
    status: string,
    opts: { channelId: string; taskName?: string }
): Promise<Record<string, unknown>> {
    const ts = String(taskTs || '').trim();
    const channel = String(opts.channelId || '').trim();
    const statusName = String(status || '').trim() || 'complete';
    if (!ts || !channel) {
        throw Object.assign(new Error('Slack message ts and channel are required'), { statusCode: 400 });
    }

    try {
        await slackApi('reactions.add', botToken, {
            channel,
            timestamp: ts,
            name: 'white_check_mark',
        });
    } catch {
        /* reaction optional */
    }

    return slackApi('chat.postMessage', botToken, {
        channel,
        thread_ts: ts,
        text: `Status → *${statusName}*${opts.taskName ? ` (${opts.taskName})` : ''}`,
    }) as Promise<Record<string, unknown>>;
}

export async function resolveSlackCompleteStatus(): Promise<string> {
    return 'complete';
}

/** After create — re-ingest the posted message as a structured task record. */
export async function ingestSlackTaskAfterCreate(
    connection: IIntegrationConnection,
    created: { id?: string; ts?: string; name?: string }
) {
    const { botToken, channelId } = connectionSlackCreds(connection);
    const ts = String(created.ts || created.id || '').trim();
    if (!botToken || !channelId || !ts) return null;
    const msg = {
        ts,
        text: String(created.name || ''),
        user: '',
    };
    return ingestSlackMessageRecord(connection, msg);
}
