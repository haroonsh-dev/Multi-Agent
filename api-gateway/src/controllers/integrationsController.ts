import crypto from 'crypto';
import { Request, Response, NextFunction } from 'express';
import { v4 as uuidv4 } from 'uuid';
import IntegrationConnection, { IntegrationSyncMode } from '../models/IntegrationConnection';
import { INTEGRATION_PROVIDER_IDS, SECRET_FIELD_KEYS } from '../constants/integrations';
import { getProviderCapabilities } from '../constants/integrationCapabilities';
import {
    resolveIngestConnectionFromRequest,
    validateIngestAuth,
    ingestAuthModeLabel,
} from '../services/integrationIngestAuth';
import { testRemoteProviderConnection } from '../services/integrationProviderTests';
import { getActiveSubscription } from '../services/planService';
import { recordActivityFromReq } from '../services/activityLog';
import {
    fetchRemoteIngestFile,
    ingestFileForConnection,
    buildConnectionPushUrl,
    processIngestHttpRequest,
    resolveIngestConnection,
} from '../services/integrationIngestService';
import { hasPermission } from '../services/accessScope';
import { PERMISSIONS } from '../types/permissions';
import {
    computeNextSyncAt,
    importDriveFiles,
    listDriveFilesWithLibraryStatus,
    testGoogleDriveConnection,
} from '../services/integrationSyncService';
import { normalizeFolderId, parseCredentials } from '../services/googleDriveService';
import { sendDocumentsViaIntegration, sendRawFileViaIntegration } from '../services/integrationSendService';
import { checkToolPolicy } from '../services/aiServiceClient';
import { policyBlocksSend } from '../utils/policyGate';
import {
    buildClickUpWebhookUrl,
    processClickUpWebhook,
    syncClickUpList,
    listClickUpAccessibleLists,
    resolveClickUpListFromTaskRef,
    verifyClickUpToken,
    verifyClickUpList,
} from '../services/clickupBridgeService';
import {
    connectionSlackCreds,
    normalizeSlackChannelId,
    processSlackWebhook,
    syncSlackChannel,
    verifySlackChannel,
    verifySlackToken,
} from '../services/slackBridgeService';
import fs from 'fs';

function buildSlackWebhookUrl(publicBase: string, connectionId: string, ingestKey: string): string {
    const base = publicBase.replace(/\/$/, '');
    return `${base}/api/docs/integrations/slack/${connectionId}/webhook?key=${encodeURIComponent(ingestKey)}`;
}

function maskSecret(value: string): string {
    if (!value || value.length < 8) return '****';
    return `${value.slice(0, 4)}****${value.slice(-4)}`;
}

function maskSecrets(secrets: Record<string, string> | undefined | null) {
    const out: Record<string, string> = {};
    if (!secrets) return out;
    for (const [k, v] of Object.entries(secrets)) {
        out[k] = maskSecret(String(v || ''));
    }
    return out;
}

function splitPayload(raw: Record<string, unknown>) {
    const config: Record<string, string | number | boolean | null> = {};
    const secrets: Record<string, string> = {};
    for (const [key, value] of Object.entries(raw || {})) {
        if (value === undefined || value === null || value === '') continue;
        if (SECRET_FIELD_KEYS.has(key) || key.toLowerCase().includes('secret') || key.toLowerCase().includes('password') || key === 'privateKey') {
            secrets[key] = String(value);
        } else if (typeof value === 'number' || typeof value === 'boolean') {
            config[key] = value;
        } else {
            config[key] = String(value);
        }
    }
    return { config, secrets };
}

function generateIngestKey(): string {
    return `vdint_${crypto.randomBytes(24).toString('hex')}`;
}

function secureIngestKeyMatch(stored: string, provided: string): boolean {
    const a = Buffer.from(String(stored || ''), 'utf8');
    const b = Buffer.from(String(provided || ''), 'utf8');
    if (a.length !== b.length) {
        if (a.length) crypto.timingSafeEqual(a, a);
        return false;
    }
    return crypto.timingSafeEqual(a, b);
}

function parseSyncMode(raw: unknown): IntegrationSyncMode {
    const v = String(raw || 'interval').toLowerCase();
    if (v === 'daily' || v === 'manual' || v === 'interval') return v;
    return 'interval';
}

function parseDailyAt(raw: unknown): string {
    const v = String(raw || '09:00').trim();
    return /^\d{1,2}:\d{2}$/.test(v) ? v : '09:00';
}

function parseBool(raw: unknown, fallback = true): boolean {
    if (typeof raw === 'boolean') return raw;
    const v = String(raw ?? '').toLowerCase();
    if (v === 'true' || v === '1' || v === 'yes') return true;
    if (v === 'false' || v === '0' || v === 'no') return false;
    return fallback;
}

async function requireAdminWithActivePlan(req: Request, res: Response): Promise<string | null> {
    if (!req.user || !hasPermission(req.user, PERMISSIONS.PAGE_INTEGRATIONS)) {
        res.status(403).json({ success: false, message: 'Missing permission: page.integrations' });
        return null;
    }
    const orgId = req.user.organizationId;
    if (!orgId) {
        res.status(400).json({ success: false, message: 'organizationId required' });
        return null;
    }
    const sub = await getActiveSubscription(orgId);
    if (!sub) {
        res.status(403).json({
            success: false,
            code: 'PLAN_REQUIRED',
            message: 'An active subscription plan is required to use Integrations',
        });
        return null;
    }
    return orgId;
}

function publicConnection(doc: any, req: Request) {
    const base =
        process.env.PUBLIC_API_URL ||
        process.env.API_PUBLIC_URL ||
        `${req.protocol}://${req.get('host')}`;
    const root = base.replace(/\/$/, '');
    const ingestUrl = `${root}/api/docs/integrations/ingest`;
    const intervalMinutes = Number(doc.intervalMinutes || doc.config?.intervalMinutes || 15);
    // Admin Integrations UI needs full push/Events URLs + ingest key (all providers).
    const keyQs =
        typeof doc.ingestApiKey === 'string' && doc.ingestApiKey.trim()
            ? `?key=${encodeURIComponent(doc.ingestApiKey.trim())}`
            : '';
    return {
        connectionId: doc.connectionId,
        providerId: doc.providerId,
        label: doc.label,
        config: {
            ...(doc.config || {}),
            intervalMinutes,
            syncMode: doc.syncMode || doc.config?.syncMode || 'interval',
            dailyAt: doc.dailyAt || doc.config?.dailyAt || '09:00',
            autoSyncEnabled:
                doc.autoSyncEnabled != null
                    ? doc.autoSyncEnabled
                    : String(doc.config?.autoSyncEnabled ?? 'true') !== 'false',
            intervalAutoUpload:
                doc.intervalAutoUpload === true ||
                String(doc.config?.intervalAutoUpload ?? '') === 'true',
        },
        secretsMasked: maskSecrets(doc.secrets),
        hasSecrets: Object.keys(doc.secrets || {}).length > 0,
        ingestApiKeyMasked: maskSecret(doc.ingestApiKey),
        ingestApiKey:
            typeof doc.ingestApiKey === 'string' && doc.ingestApiKey.trim()
                ? doc.ingestApiKey.trim()
                : undefined,
        ingestUrl,
        clickupWebhookUrl:
            doc.providerId === 'clickup' && doc.connectionId
                ? `${root}/api/docs/integrations/clickup/${doc.connectionId}/webhook${keyQs}`
                : undefined,
        slackWebhookUrl:
            doc.providerId === 'slack' && doc.connectionId
                ? `${root}/api/docs/integrations/slack/${doc.connectionId}/webhook${keyQs}`
                : undefined,
        connectionPushUrl: doc.connectionId
            ? `${root}/api/docs/integrations/connections/${doc.connectionId}/push${keyQs}`
            : undefined,
        useCase: doc.config?.useCase ? String(doc.config.useCase) : null,
        isActive: doc.isActive,
        intervalMinutes,
        syncMode: doc.syncMode || 'interval',
        dailyAt: doc.dailyAt || '09:00',
        autoSyncEnabled: doc.autoSyncEnabled !== false,
        intervalAutoUpload: doc.intervalAutoUpload === true,
        nextSyncAt: doc.nextSyncAt || null,
        pendingSyncPrompt: doc.pendingSyncPrompt || null,
        unreadSyncAlert: doc.unreadSyncAlert || null,
        direction: doc.direction,
        lastSyncAt: doc.lastSyncAt,
        lastStatus: doc.lastStatus,
        lastSyncSummary: doc.lastSyncSummary || null,
        outboundWebhookUrl: doc.config?.outboundWebhookUrl
            ? String(doc.config.outboundWebhookUrl)
            : null,
        defaultPhase3Agent: doc.config?.phase3Agent ? String(doc.config.phase3Agent) : null,
        ingestAuthMode: doc.config?.ingestAuthMode ? String(doc.config.ingestAuthMode) : 'integration_key',
        ingestAuthModeLabel: ingestAuthModeLabel(doc.config?.ingestAuthMode),
        ingestCustomHeaderName: doc.config?.ingestCustomHeaderName
            ? String(doc.config.ingestCustomHeaderName)
            : null,
        hasOutboundWebhook: Boolean(String(doc.config?.outboundWebhookUrl || '').trim()),
        outboundFolderId: doc.config?.outboundFolderId
            ? String(doc.config.outboundFolderId)
            : null,
        supportsFolderSend: doc.providerId === 'google_drive',
        createdAt: doc.createdAt,
        updatedAt: doc.updatedAt,
    };
}

export const listIntegrations = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const orgId = await requireAdminWithActivePlan(req, res);
        if (!orgId) return;

        const rows = await IntegrationConnection.find({ organizationId: orgId }).sort({ updatedAt: -1 }).lean();
        res.json({
            success: true,
            data: {
                connections: rows.map((r) => publicConnection(r, req)),
                providerIds: INTEGRATION_PROVIDER_IDS,
            },
        });
    } catch (error) {
        next(error);
    }
};

export const saveIntegration = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const orgId = await requireAdminWithActivePlan(req, res);
        if (!orgId) return;

        const providerId = String(req.body?.providerId || '').trim();
        if (!INTEGRATION_PROVIDER_IDS.includes(providerId as any)) {
            return res.status(400).json({ success: false, message: 'Invalid providerId' });
        }

        const label = String(req.body?.label || providerId).trim() || providerId;
        const direction = (['inbound', 'outbound', 'both'].includes(req.body?.direction)
            ? req.body.direction
            : 'both') as 'inbound' | 'outbound' | 'both';
        const fields = (req.body?.fields || {}) as Record<string, unknown>;
        const intervalRaw = req.body?.intervalMinutes ?? fields.intervalMinutes ?? 15;
        const intervalMinutes = Math.max(5, Math.min(1440, Number(intervalRaw) || 15));
        const syncMode = parseSyncMode(req.body?.syncMode ?? fields.syncMode);
        const dailyAt = parseDailyAt(req.body?.dailyAt ?? fields.dailyAt);
        const autoSyncEnabled = parseBool(
            req.body?.autoSyncEnabled ?? fields.autoSyncEnabled,
            syncMode !== 'manual'
        );
        const intervalAutoUpload = parseBool(
            req.body?.intervalAutoUpload ?? fields.intervalAutoUpload,
            false
        );
        const { config, secrets } = splitPayload(fields);

        config.intervalMinutes = intervalMinutes;
        config.syncMode = syncMode;
        config.dailyAt = dailyAt;
        config.autoSyncEnabled = autoSyncEnabled;
        config.intervalAutoUpload = intervalAutoUpload;
        if (fields.phase3Agent != null) config.phase3Agent = String(fields.phase3Agent);
        if (fields.useCase != null) config.useCase = String(fields.useCase);
        if (Object.prototype.hasOwnProperty.call(fields, 'outboundWebhookUrl')) {
            const outbound = String(fields.outboundWebhookUrl ?? '').trim();
            if (outbound) config.outboundWebhookUrl = outbound;
        }
        if (fields.serviceAccountEmail) config.serviceAccountEmail = String(fields.serviceAccountEmail);
        if (fields.folderId) config.folderId = normalizeFolderId(String(fields.folderId));
        if (fields.listId) config.listId = String(fields.listId).trim();
        if (fields.clickupListId) config.listId = String(fields.clickupListId).trim();
        if (fields.channelId) config.channelId = normalizeSlackChannelId(String(fields.channelId));
        if (fields.slackChannelId) {
            config.channelId = normalizeSlackChannelId(String(fields.slackChannelId));
        }
        if (fields.listId) config.listId = String(fields.listId).trim();
        // Slack: also mirror channel into listId so universal task layer can resolve it
        if (providerId === 'slack' && config.channelId) {
            config.channelId = normalizeSlackChannelId(String(config.channelId));
            config.listId = String(config.channelId);
        }
        if (fields.ingestAuthMode != null) config.ingestAuthMode = String(fields.ingestAuthMode);
        if (fields.ingestCustomHeaderName != null) {
            config.ingestCustomHeaderName = String(fields.ingestCustomHeaderName).trim();
        }
        if (fields.ingestBasicUsername != null) {
            config.ingestBasicUsername = String(fields.ingestBasicUsername).trim();
        }

        // Normalize Google service-account JSON/PEM so OpenSSL can read the stored key
        if (providerId === 'google_drive' && secrets.privateKey) {
            try {
                const parsed = parseCredentials(
                    String(config.serviceAccountEmail || fields.serviceAccountEmail || ''),
                    secrets.privateKey
                );
                secrets.privateKey = parsed.privateKey;
                if (parsed.clientEmail) config.serviceAccountEmail = parsed.clientEmail;
            } catch (e: any) {
                return res.status(400).json({
                    success: false,
                    message: e?.message || 'Invalid Google Drive private key',
                });
            }
        }

        // Slack: keep botToken as canonical; mirror to apiToken for universal task layer
        if (providerId === 'slack') {
            if (secrets.botToken && !String(secrets.botToken).includes('****')) {
                secrets.apiToken = secrets.botToken;
            } else if (secrets.apiToken && !secrets.botToken) {
                secrets.botToken = secrets.apiToken;
            }
            const tok = String(secrets.botToken || secrets.apiToken || '').trim();
            if (tok && !tok.includes('****') && /^xapp-/i.test(tok)) {
                return res.status(400).json({
                    success: false,
                    message:
                        'Wrong Slack token type (xapp-…). Use Bot User OAuth Token (xoxb-…) from OAuth & Permissions — not App-Level Token.',
                });
            }
            if (config.channelId) config.listId = String(config.channelId);
        }

        const nextSyncAt =
            autoSyncEnabled && syncMode !== 'manual'
                ? computeNextSyncAt(syncMode, intervalMinutes, dailyAt, new Date())
                : null;

        const connectionIdParam = String(req.body?.connectionId || '').trim();
        const forceCreate = req.body?.createNew === true || String(req.body?.createNew || '') === 'true';

        let doc =
            connectionIdParam && !forceCreate
                ? await IntegrationConnection.findOne({ connectionId: connectionIdParam, organizationId: orgId })
                : null;

        if (!doc && !forceCreate) {
            const labelKey = String(label || providerId).trim();
            doc = await IntegrationConnection.findOne({
                organizationId: orgId,
                providerId,
                label: labelKey,
            });
        }

        const isNew = !doc;
        if (!doc) {
            doc = await IntegrationConnection.create({
                connectionId: `int_${uuidv4()}`,
                organizationId: orgId,
                providerId,
                label,
                config,
                secrets,
                ingestApiKey: generateIngestKey(),
                isActive: true,
                intervalMinutes,
                syncMode,
                dailyAt,
                autoSyncEnabled,
                intervalAutoUpload: syncMode === 'daily' ? true : intervalAutoUpload,
                nextSyncAt,
                direction,
                lastStatus: 'connected',
                createdBy: req.user.userId,
            });
        } else {
            doc.label = label;
            doc.direction = direction;
            doc.intervalMinutes = intervalMinutes;
            doc.syncMode = syncMode;
            doc.dailyAt = dailyAt;
            doc.autoSyncEnabled = autoSyncEnabled;
            if (syncMode === 'interval') {
                doc.intervalAutoUpload = intervalAutoUpload;
            } else if (syncMode === 'daily') {
                // Daily is always silent auto-upload
                doc.intervalAutoUpload = true;
                doc.pendingSyncPrompt = null;
            } else {
                doc.intervalAutoUpload = false;
                doc.pendingSyncPrompt = null;
            }
            doc.nextSyncAt = nextSyncAt;
            doc.config = { ...(doc.config || {}), ...config };
            if (
                Object.prototype.hasOwnProperty.call(fields, 'outboundWebhookUrl') &&
                !String(fields.outboundWebhookUrl ?? '').trim()
            ) {
                delete doc.config.outboundWebhookUrl;
            }
            const mergedSecrets = { ...(doc.secrets || {}) };
            for (const [k, v] of Object.entries(secrets)) {
                if (v && !String(v).includes('****')) mergedSecrets[k] = v;
            }
            doc.secrets = mergedSecrets;
            doc.isActive = true;
            doc.lastStatus = 'connected';
            await doc.save();
        }

        recordActivityFromReq(req, {
            action: isNew ? 'integrations.connect' : 'integrations.update',
            category: 'admin',
            resourceType: 'integration',
            resourceId: doc.connectionId,
            message: `${isNew ? 'Connected' : 'Updated'} integration ${providerId}`,
            metadata: { providerId, label },
        });

        const payload = publicConnection(doc.toObject ? doc.toObject() : doc, req);
        // Show full ingest key once on create
        if (isNew) {
            payload.ingestApiKey = doc.ingestApiKey;
            const base =
                process.env.PUBLIC_API_URL ||
                process.env.API_PUBLIC_URL ||
                `${req.protocol}://${req.get('host')}`;
            if (doc.ingestApiKey) {
                (payload as Record<string, unknown>).connectionPushUrl = buildConnectionPushUrl(
                    base,
                    doc.connectionId,
                    doc.ingestApiKey
                );
            }
            if (doc.providerId === 'clickup' && doc.ingestApiKey) {
                (payload as Record<string, unknown>).clickupWebhookUrl = buildClickUpWebhookUrl(
                    base,
                    doc.connectionId,
                    doc.ingestApiKey
                );
            }
            if (doc.providerId === 'slack' && doc.ingestApiKey) {
                (payload as Record<string, unknown>).slackWebhookUrl = buildSlackWebhookUrl(
                    base,
                    doc.connectionId,
                    doc.ingestApiKey
                );
            }
        }

        res.status(isNew ? 201 : 200).json({
            success: true,
            message: isNew ? 'Integration connected' : 'Integration updated',
            data: { connection: payload },
        });
    } catch (error: any) {
        if (error?.code === 11000) {
            return res.status(409).json({ success: false, message: 'Integration already exists for this provider' });
        }
        next(error);
    }
};

export const testIntegration = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const orgId = await requireAdminWithActivePlan(req, res);
        if (!orgId) return;

        const doc = await IntegrationConnection.findOne({
            connectionId: req.params.id,
            organizationId: orgId,
        });
        if (!doc) {
            return res.status(404).json({ success: false, message: 'Integration not found' });
        }

        if (doc.providerId === 'google_drive') {
            try {
                const result = await testGoogleDriveConnection(doc);
                doc.lastStatus = `test_ok: folder accessible (${result.fileCount} file(s) visible)`;
                doc.lastSyncAt = new Date();
                await doc.save();
                return res.json({
                    success: true,
                    message: `Google Drive connected. Folder is accessible (${result.fileCount} file(s) visible in first page).`,
                    data: {
                        ok: true,
                        fileCount: result.fileCount,
                        folderId: result.folderId,
                        lastStatus: doc.lastStatus,
                    },
                });
            } catch (e: any) {
                doc.lastStatus = `test_failed: ${e?.message || e}`;
                await doc.save();
                return res.status(400).json({
                    success: false,
                    message: e?.message || 'Google Drive test failed',
                    data: { ok: false },
                });
            }
        }

        if (doc.providerId === 'slack') {
            const { botToken, channelId } = connectionSlackCreds(doc);
            const missing: string[] = [];
            if (!doc.ingestApiKey) missing.push('ingestApiKey');
            if (!botToken) missing.push('botToken');
            if (!channelId) missing.push('channelId');
            if (missing.length) {
                doc.lastStatus = `test_failed: missing ${missing.join(', ')}`;
                await doc.save();
                return res.status(400).json({
                    success: false,
                    message: `Test failed — missing: ${missing.join(', ')}`,
                    data: { ok: false, missing },
                });
            }
            try {
                const info = await verifySlackToken(botToken);
                const ch = await verifySlackChannel(botToken, channelId);
                doc.lastStatus = `test_ok: Slack ${info.user} · #${ch.name}`;
                doc.lastSyncAt = new Date();
                await doc.save();
                const base =
                    process.env.PUBLIC_API_URL ||
                    process.env.API_PUBLIC_URL ||
                    `${req.protocol}://${req.get('host')}`;
                const slackWebhookUrl = buildSlackWebhookUrl(base, doc.connectionId, doc.ingestApiKey);
                return res.json({
                    success: true,
                    message: `Slack OK — bot valid and channel #${ch.name} found. Paste the Events Request URL into Slack → Event Subscriptions, then Sync now.`,
                    data: {
                        ok: true,
                        slackUser: info.user,
                        slackTeam: info.team,
                        channelId: ch.id,
                        channelName: ch.name,
                        slackWebhookUrl,
                        lastStatus: doc.lastStatus,
                    },
                });
            } catch (e: any) {
                doc.lastStatus = `test_failed: ${e?.message || e}`;
                await doc.save();
                return res.status(400).json({
                    success: false,
                    message: e?.message || 'Slack test failed',
                    data: { ok: false },
                });
            }
        }

        if (doc.providerId === 'clickup') {
            const missing: string[] = [];
            if (!doc.ingestApiKey) missing.push('ingestApiKey');
            if (!doc.secrets?.apiToken) missing.push('apiToken');
            if (missing.length) {
                doc.lastStatus = `test_failed: missing ${missing.join(', ')}`;
                await doc.save();
                return res.status(400).json({
                    success: false,
                    message: `Test failed — missing: ${missing.join(', ')}`,
                    data: { ok: false, missing },
                });
            }
            try {
                const info = await verifyClickUpToken(doc.secrets.apiToken);
                const listId = String(doc.config?.listId || doc.config?.clickupListId || '').trim();
                let listName: string | null = null;
                if (listId) {
                    try {
                        const listInfo = await verifyClickUpList(listId, doc.secrets.apiToken);
                        listName = listInfo.listName;
                    } catch (listErr: any) {
                        let message = listErr?.message || 'ClickUp list not found';
                        try {
                            const discovery = await listClickUpAccessibleLists(doc.secrets.apiToken);
                            const accessible = discovery.lists;
                            if (accessible.length) {
                                const preview = accessible
                                    .slice(0, 6)
                                    .map((l) => `"${l.listName}" (${l.listId})`)
                                    .join(', ');
                                message += ` Your token can access: ${preview}${
                                    accessible.length > 6 ? '…' : ''
                                }. Use Browse lists in Edit to pick the correct List ID.`;
                            }
                        } catch {
                            /* optional */
                        }
                        doc.lastStatus = `test_failed: ${message}`;
                        await doc.save();
                        return res.status(400).json({
                            success: false,
                            message,
                            data: { ok: false, listId },
                        });
                    }
                }
                doc.lastStatus = listName
                    ? `test_ok: ClickUp ${info.user} · list "${listName}"`
                    : `test_ok: ClickUp ${info.user} (${info.teams} team(s))`;
                doc.lastSyncAt = new Date();
                await doc.save();
                const base =
                    process.env.PUBLIC_API_URL ||
                    process.env.API_PUBLIC_URL ||
                    `${req.protocol}://${req.get('host')}`;
                const clickupWebhookUrl = buildClickUpWebhookUrl(
                    base,
                    doc.connectionId,
                    doc.ingestApiKey
                );
                return res.json({
                    success: true,
                    message: listName
                        ? `ClickUp OK — token valid and list "${listName}" found. Paste the webhook URL into ClickUp → Integrations → Webhooks, then use Sync now to pull CV attachments.`
                        : 'ClickUp token valid. Add a List ID and save, then Run test again. Paste the webhook URL into ClickUp → Integrations → Webhooks.',
                    data: {
                        ok: true,
                        clickupUser: info.user,
                        clickupWebhookUrl,
                        defaultPhase3Agent: doc.config?.phase3Agent || null,
                        listId: listId || null,
                        listName,
                    },
                });
            } catch (e: any) {
                doc.lastStatus = `test_failed: ${e?.message || 'ClickUp test failed'}`;
                await doc.save();
                return res.status(400).json({
                    success: false,
                    message: e?.message || 'ClickUp test failed',
                    data: { ok: false },
                });
            }
        }

        if (getProviderCapabilities(doc.providerId).remoteTest) {
            try {
                const summary = await testRemoteProviderConnection(doc);
                doc.lastStatus = `test_ok: ${summary}`;
                doc.lastSyncAt = new Date();
                await doc.save();
                const base =
                    process.env.PUBLIC_API_URL ||
                    process.env.API_PUBLIC_URL ||
                    `${req.protocol}://${req.get('host')}`;
                const pushUrl = buildConnectionPushUrl(base, doc.connectionId, doc.ingestApiKey);
                return res.json({
                    success: true,
                    message: `${summary}. Copy the push URL from Status — documents ingest via HTTP POST, not scheduled ERP pull.`,
                    data: {
                        ok: true,
                        lastStatus: doc.lastStatus,
                        connectionPushUrl: pushUrl,
                        defaultPhase3Agent: doc.config?.phase3Agent || null,
                    },
                });
            } catch (e: any) {
                doc.lastStatus = `test_failed: ${e?.message || e}`;
                await doc.save();
                return res.status(e?.statusCode || 400).json({
                    success: false,
                    message: e?.message || 'Remote connection test failed',
                    data: { ok: false },
                });
            }
        }

        const missing: string[] = [];
        if (!doc.providerId) missing.push('providerId');
        if (doc.providerId === 'custom_webhook') {
            if (!doc.ingestApiKey) missing.push('ingestApiKey');
        } else if (doc.providerId === 'sql_csv_drop') {
            if (!doc.ingestApiKey) missing.push('ingestApiKey');
        } else {
            const cfg = doc.config || {};
            const sec = doc.secrets || {};
            const scheduleKeys = new Set([
                'intervalMinutes',
                'phase3Agent',
                'outboundWebhookUrl',
                'syncMode',
                'dailyAt',
                'autoSyncEnabled',
            ]);
            const meaningful =
                Object.keys(cfg).filter((k) => !scheduleKeys.has(k)).length > 0 ||
                Object.keys(sec).length > 0;
            if (!meaningful) missing.push('connection fields');
        }

        if (missing.length) {
            doc.lastStatus = `test_failed: missing ${missing.join(', ')}`;
            await doc.save();
            return res.status(400).json({
                success: false,
                message: `Test failed — missing: ${missing.join(', ')}`,
                data: { ok: false, missing },
            });
        }

        doc.lastStatus = 'test_ok';
        doc.lastSyncAt = new Date();
        await doc.save();

        const base =
            process.env.PUBLIC_API_URL ||
            process.env.API_PUBLIC_URL ||
            `${req.protocol}://${req.get('host')}`;
        const ingestUrl = `${base.replace(/\/$/, '')}/api/docs/integrations/ingest`;
        const webhookHint =
            doc.providerId === 'custom_webhook' || doc.providerId === 'sql_csv_drop'
                ? ' Supports multipart file POST and JSON { "fileUrl": "https://…" }.'
                : '';

        res.json({
            success: true,
            message: `Configuration saved.${webhookHint} Remote API not verified for this provider — use Test after adding credentials, or POST a file to the push URL.`,
            data: {
                ok: true,
                lastStatus: doc.lastStatus,
                ingestUrl: doc.ingestApiKey ? ingestUrl : undefined,
                defaultPhase3Agent: doc.config?.phase3Agent || null,
            },
        });
    } catch (error) {
        next(error);
    }
};

export const listIntegrationFiles = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const orgId = await requireAdminWithActivePlan(req, res);
        if (!orgId) return;

        const doc = await IntegrationConnection.findOne({
            connectionId: req.params.id,
            organizationId: orgId,
        });
        if (!doc) {
            return res.status(404).json({ success: false, message: 'Integration not found' });
        }
        if (doc.providerId !== 'google_drive') {
            return res.status(400).json({
                success: false,
                message: 'File listing is currently available for Google Drive only',
            });
        }

        const files = await listDriveFilesWithLibraryStatus(doc);
        res.json({
            success: true,
            data: {
                files,
                total: files.length,
                missing: files.filter((f) => !f.existsInLibrary).length,
                existing: files.filter((f) => f.existsInLibrary).length,
            },
        });
    } catch (error: any) {
        return res.status(400).json({
            success: false,
            message: error?.message || 'Failed to list files',
        });
    }
};

export const listClickUpListsForConnection = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const orgId = await requireAdminWithActivePlan(req, res);
        if (!orgId) return;

        const doc = await IntegrationConnection.findOne({
            connectionId: req.params.id,
            organizationId: orgId,
        });
        if (!doc || doc.providerId !== 'clickup') {
            return res.status(404).json({ success: false, message: 'ClickUp connection not found' });
        }
        const apiToken = String(doc.secrets?.apiToken || '').trim();
        if (!apiToken) {
            return res.status(400).json({ success: false, message: 'Save your ClickUp API token first' });
        }

        const discovery = await listClickUpAccessibleLists(apiToken);
        return res.json({
            success: true,
            data: {
                lists: discovery.lists,
                meta: discovery.meta,
                currentListId: doc.config?.listId ? String(doc.config.listId) : null,
            },
        });
    } catch (error: any) {
        return res.status(400).json({
            success: false,
            message: error?.message || 'Failed to list ClickUp lists',
        });
    }
};

export const resolveClickUpListForConnection = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const orgId = await requireAdminWithActivePlan(req, res);
        if (!orgId) return;

        const doc = await IntegrationConnection.findOne({
            connectionId: req.params.id,
            organizationId: orgId,
        });
        if (!doc || doc.providerId !== 'clickup') {
            return res.status(404).json({ success: false, message: 'ClickUp connection not found' });
        }
        const apiToken = String(doc.secrets?.apiToken || '').trim();
        if (!apiToken) {
            return res.status(400).json({ success: false, message: 'Save your ClickUp API token first' });
        }

        const taskRef = String(req.body?.taskRef || req.body?.taskUrl || req.body?.taskId || '').trim();
        const resolved = await resolveClickUpListFromTaskRef(taskRef, apiToken);
        return res.json({
            success: true,
            message: `Found list "${resolved.listName}" from task "${resolved.taskName}". Save this List ID and Run test.`,
            data: resolved,
        });
    } catch (error: any) {
        return res.status(400).json({
            success: false,
            message: error?.message || 'Failed to resolve list from task',
        });
    }
};

export const syncIntegrationFiles = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const orgId = await requireAdminWithActivePlan(req, res);
        if (!orgId) return;

        const doc = await IntegrationConnection.findOne({
            connectionId: req.params.id,
            organizationId: orgId,
        });
        if (!doc) {
            return res.status(404).json({ success: false, message: 'Integration not found' });
        }

        if (doc.providerId === 'slack') {
            const result = await syncSlackChannel(doc);
            const msgs = Number(result.taskCount || 0);
            const failed = Number(result.failed || 0);
            const summary =
                failed > 0
                    ? `Sync finished with errors: ${msgs} message${msgs === 1 ? '' : 's'} · ${failed} failed`
                    : msgs === 0
                      ? 'Sync complete: no new messages in channel'
                      : `Sync complete: ${msgs} message${msgs === 1 ? '' : 's'} → synced tasks`;
            doc.lastSyncAt = new Date();
            doc.lastStatus = failed ? `sync_partial: ${summary}` : `sync_ok: ${summary}`;
            doc.lastSyncSummary = summary;
            await doc.save();

            recordActivityFromReq(req, {
                action: 'integrations.sync',
                category: 'document',
                resourceType: 'integration',
                resourceId: doc.connectionId,
                message: `Slack channel sync: ${summary}`,
                metadata: { summary, taskCount: msgs, failed },
            });

            return res.json({
                success: true,
                message: summary,
                data: {
                    ...result,
                    connection: publicConnection(doc.toObject(), req),
                },
            });
        }

        if (doc.providerId === 'clickup') {
            const result = await syncClickUpList(doc);
            const tasks = Number(result.taskCount || 0);
            const attachments = Number(result.attachmentCount || 0);
            const ingested = Number(result.ingested || 0);
            const skipped = Number(result.skipped || 0);
            const failed = Number(result.failed || 0);
            const parts = [
                `${tasks} task${tasks === 1 ? '' : 's'}`,
                `${attachments} attachment${attachments === 1 ? '' : 's'}`,
            ];
            if (ingested) parts.push(`${ingested} file${ingested === 1 ? '' : 's'} ingested`);
            if (skipped) parts.push(`${skipped} skipped`);
            if (failed) parts.push(`${failed} failed`);
            const summary =
                failed > 0
                    ? `Sync finished with errors: ${parts.join(' · ')}`
                    : `Sync complete: ${parts.join(' · ')}`;
            doc.lastSyncAt = new Date();
            doc.lastStatus = failed ? `sync_partial: ${summary}` : `sync_ok: ${summary}`;
            doc.lastSyncSummary = summary;
            await doc.save();

            recordActivityFromReq(req, {
                action: 'integrations.sync',
                category: 'document',
                resourceType: 'integration',
                resourceId: doc.connectionId,
                message: `ClickUp list sync: ${summary}`,
                metadata: { summary, ingested: result.ingested },
            });

            return res.json({
                success: true,
                message: summary,
                data: {
                    ...result,
                    connection: publicConnection(doc.toObject(), req),
                },
            });
        }

        if (doc.providerId !== 'google_drive') {
            return res.status(400).json({
                success: false,
                message: 'Sync is available for Google Drive, ClickUp, and Slack only',
            });
        }

        const fileIds = Array.isArray(req.body?.fileIds)
            ? req.body.fileIds.map((x: unknown) => String(x))
            : undefined;
        const result = await importDriveFiles(doc, fileIds);
        const summary = `imported=${result.imported.length}, skipped=${result.skipped.length}, failed=${result.failed.length}`;

        doc.lastSyncAt = new Date();
        doc.lastStatus = result.failed.length ? `sync_partial: ${summary}` : `sync_ok: ${summary}`;
        doc.lastSyncSummary = summary;
        if (doc.autoSyncEnabled && doc.syncMode !== 'manual') {
            doc.nextSyncAt = computeNextSyncAt(
                doc.syncMode || 'interval',
                doc.intervalMinutes || 15,
                doc.dailyAt || '09:00',
                new Date()
            );
        }
        await doc.save();

        recordActivityFromReq(req, {
            action: 'integrations.sync',
            category: 'document',
            resourceType: 'integration',
            resourceId: doc.connectionId,
            message: `Google Drive sync: ${summary}`,
            metadata: { summary, imported: result.imported.length },
        });

        res.json({
            success: true,
            message: `Sync finished — ${summary}`,
            data: {
                ...result,
                connection: publicConnection(doc.toObject(), req),
            },
        });
    } catch (error: any) {
        return res.status(400).json({
            success: false,
            message: error?.message || 'Sync failed',
        });
    }
};

/** Admin poll: pending interval confirm prompts + unread sync alerts (e.g. daily failures). */
export const listSyncInbox = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const orgId = await requireAdminWithActivePlan(req, res);
        if (!orgId) return;

        const docs = await IntegrationConnection.find({
            organizationId: orgId,
            providerId: 'google_drive',
            isActive: true,
        })
            .select(
                'connectionId label syncMode intervalMinutes intervalAutoUpload pendingSyncPrompt unreadSyncAlert lastStatus'
            )
            .lean();

        const prompts = docs
            .filter((d) => d.pendingSyncPrompt && Number((d.pendingSyncPrompt as any).count || 0) > 0)
            .map((d) => ({
                connectionId: d.connectionId,
                label: d.label,
                syncMode: d.syncMode,
                intervalMinutes: d.intervalMinutes,
                intervalAutoUpload: d.intervalAutoUpload === true,
                pendingSyncPrompt: d.pendingSyncPrompt,
            }));

        const alerts = docs
            .filter((d) => d.unreadSyncAlert)
            .map((d) => ({
                connectionId: d.connectionId,
                label: d.label,
                alert: d.unreadSyncAlert,
            }));

        res.json({ success: true, data: { prompts, alerts } });
    } catch (error) {
        next(error);
    }
};

export const confirmSyncPrompt = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const orgId = await requireAdminWithActivePlan(req, res);
        if (!orgId) return;

        const doc = await IntegrationConnection.findOne({
            connectionId: req.params.id,
            organizationId: orgId,
        });
        if (!doc) {
            return res.status(404).json({ success: false, message: 'Integration not found' });
        }

        const enableAutoUpload = parseBool(req.body?.enableAutoUpload, false);
        const fileIds = Array.isArray(req.body?.fileIds)
            ? req.body.fileIds.map((x: unknown) => String(x))
            : doc.pendingSyncPrompt?.files?.map((f) => f.id);

        if (enableAutoUpload) {
            doc.intervalAutoUpload = true;
            doc.config = { ...(doc.config || {}), intervalAutoUpload: true };
        }

        const result = await importDriveFiles(doc, fileIds?.length ? fileIds : undefined);
        const summary = `imported=${result.imported.length}, skipped=${result.skipped.length}, failed=${result.failed.length}`;

        doc.pendingSyncPrompt = null;
        doc.lastSyncAt = new Date();
        doc.lastStatus = result.failed.length ? `sync_partial: ${summary}` : `sync_ok: ${summary}`;
        doc.lastSyncSummary = summary;
        await doc.save();

        recordActivityFromReq(req, {
            action: 'integrations.sync.confirm',
            category: 'document',
            resourceType: 'integration',
            resourceId: doc.connectionId,
            message: `Google Drive confirm upload: ${summary}`,
            metadata: { summary, enableAutoUpload },
        });

        res.json({
            success: true,
            message: enableAutoUpload
                ? `Uploaded. Auto-upload is on for future intervals — ${summary}`
                : `Uploaded — ${summary}`,
            data: {
                ...result,
                connection: publicConnection(doc.toObject(), req),
            },
        });
    } catch (error: any) {
        return res.status(400).json({
            success: false,
            message: error?.message || 'Confirm sync failed',
        });
    }
};

export const dismissSyncPrompt = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const orgId = await requireAdminWithActivePlan(req, res);
        if (!orgId) return;

        const doc = await IntegrationConnection.findOne({
            connectionId: req.params.id,
            organizationId: orgId,
        });
        if (!doc) {
            return res.status(404).json({ success: false, message: 'Integration not found' });
        }

        doc.pendingSyncPrompt = null;
        doc.lastStatus = 'sync_skipped: user dismissed prompt';
        await doc.save();

        res.json({
            success: true,
            message: 'Sync prompt dismissed — files were not uploaded',
            data: { connection: publicConnection(doc.toObject(), req) },
        });
    } catch (error) {
        next(error);
    }
};

export const ackSyncAlert = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const orgId = await requireAdminWithActivePlan(req, res);
        if (!orgId) return;

        const doc = await IntegrationConnection.findOne({
            connectionId: req.params.id,
            organizationId: orgId,
        });
        if (!doc) {
            return res.status(404).json({ success: false, message: 'Integration not found' });
        }

        doc.unreadSyncAlert = null;
        await doc.save();

        res.json({ success: true, message: 'Alert acknowledged' });
    } catch (error) {
        next(error);
    }
};

export const deleteIntegration = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const orgId = await requireAdminWithActivePlan(req, res);
        if (!orgId) return;

        const doc = await IntegrationConnection.findOne({
            connectionId: req.params.id,
            organizationId: orgId,
        });
        if (!doc) {
            return res.status(404).json({ success: false, message: 'Integration not found' });
        }

        const providerId = doc.providerId;
        await IntegrationConnection.deleteOne({ connectionId: doc.connectionId });

        recordActivityFromReq(req, {
            action: 'integrations.disconnect',
            category: 'admin',
            resourceType: 'integration',
            resourceId: doc.connectionId,
            message: `Disconnected integration ${providerId}`,
            metadata: { providerId },
        });

        res.json({ success: true, message: 'Integration disconnected' });
    } catch (error) {
        next(error);
    }
};

export const rotateIngestKey = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const orgId = await requireAdminWithActivePlan(req, res);
        if (!orgId) return;

        const doc = await IntegrationConnection.findOne({
            connectionId: req.params.id,
            organizationId: orgId,
        });
        if (!doc) {
            return res.status(404).json({ success: false, message: 'Integration not found' });
        }

        doc.ingestApiKey = generateIngestKey();
        await doc.save();

        const payload = publicConnection(doc.toObject(), req);
        payload.ingestApiKey = doc.ingestApiKey;

        res.json({
            success: true,
            message: 'Ingest API key rotated — copy the new key now',
            data: { connection: payload },
        });
    } catch (error) {
        next(error);
    }
};

/** User-triggered send: original file / AI summary / extracted JSON → Drive folder and/or webhook */
export const sendViaIntegration = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const orgId = await requireAdminWithActivePlan(req, res);
        if (!orgId) return;

        // Policy gate: integrations.send is a Tier-3 (high-risk, outbound) tool.
        // This controller already enforced admin + active-plan RBAC, so the
        // gateway presents that as the tool override. The ai-backend records the
        // decision in the audit trail and can still block if the tool is unknown
        // to the registry (decision == "blocked").
        const policy = await checkToolPolicy('integrations.send', orgId, ['tool.integrations.send'], req.user?.userId);
        if (policy && policyBlocksSend(policy.decision)) {
            return res.status(403).json({
                success: false,
                message: policy.reason || 'Outbound integration send was blocked by policy.',
            });
        }
        // Fail CLOSED: a null check means the policy service is unreachable. A
        // Tier-3 outbound send must not proceed without a recorded policy decision
        // (the audit row is written by the ai-backend on this call), so block it
        // rather than silently sending data outward.
        if (!policy) {
            return res.status(503).json({
                success: false,
                code: 'POLICY_SERVICE_UNAVAILABLE',
                message: 'Tool policy service is unavailable — outbound integration send is blocked until the AI backend is reachable.',
            });
        }

        const doc = await IntegrationConnection.findOne({
            connectionId: req.params.id,
            organizationId: orgId,
        });
        if (!doc) {
            return res.status(404).json({ success: false, message: 'Integration not found' });
        }
        if (!doc.isActive) {
            return res.status(400).json({ success: false, message: 'Integration is not active' });
        }

        const documentIds = Array.isArray(req.body?.documentIds)
            ? req.body.documentIds.map((x: unknown) => String(x)).filter(Boolean)
            : [];
        if (!documentIds.length) {
            return res.status(400).json({ success: false, message: 'documentIds required' });
        }

        const include = {
            file: !!req.body?.include?.file,
            summary: !!req.body?.include?.summary,
            extracted: !!req.body?.include?.extracted,
        };
        if (!include.file && !include.summary && !include.extracted) {
            return res.status(400).json({
                success: false,
                message: 'Select at least one payload: file, summary, or extracted',
            });
        }

        const destinations = {
            folder: !!req.body?.destinations?.folder,
            webhook: !!req.body?.destinations?.webhook,
        };
        if (!destinations.folder && !destinations.webhook) {
            return res.status(400).json({
                success: false,
                message: 'Select at least one destination: folder or webhook',
            });
        }

        const { results, outboundFolderId } = await sendDocumentsViaIntegration({
            conn: doc,
            organizationId: orgId,
            documentIds,
            include,
            destinations,
        });

        const isSoftWarning = (e: string) => /missing on disk/i.test(e);
        const deliveredOk = results.filter((r) => {
            const hasUpload = Array.isArray(r.uploaded) && r.uploaded.length > 0;
            const webhookOk = r.webhookOk === true;
            const hardErrors = (r.errors || []).filter((e) => !isSoftWarning(e));
            if (hardErrors.length) return false;
            if (destinations.folder && destinations.webhook) return hasUpload || webhookOk;
            if (destinations.folder) return hasUpload;
            if (destinations.webhook) return webhookOk;
            return false;
        });
        const okDocs = deliveredOk.length;
        const failCount = results.length - okDocs;
        const detailErrors = results
            .flatMap((r) => (r.errors || []).filter((e) => !isSoftWarning(e)))
            .filter(Boolean)
            .slice(0, 3);

        doc.lastStatus =
            failCount === 0
                ? `send_ok: ${okDocs} document(s)`
                : `send_partial: ok=${okDocs}, failed=${failCount}`;
        doc.lastSyncAt = new Date();
        await doc.save();

        recordActivityFromReq(req, {
            action: 'integrations.send',
            category: 'document',
            resourceType: 'integration',
            resourceId: doc.connectionId,
            message: `Sent ${okDocs}/${results.length} document(s) via ${doc.providerId}`,
            metadata: { include, destinations, results },
        });

        const message =
            failCount === 0
                ? `Sent ${okDocs} document(s) successfully`
                : detailErrors.length
                  ? `Send failed — ${detailErrors.join(' · ')}`
                  : `Sent with issues — ${okDocs} ok, ${failCount} failed`;

        res.status(failCount === results.length && results.length > 0 ? 400 : 200).json({
            success: failCount === 0,
            message,
            data: {
                results,
                outboundFolderId: outboundFolderId || doc.config?.outboundFolderId || null,
                connection: publicConnection(doc.toObject(), req),
            },
        });
    } catch (error: any) {
        const status = error?.statusCode || 400;
        return res.status(status).json({
            success: false,
            message: error?.message || 'Send failed',
        });
    }
};

/** Upload a raw file (e.g. chat .txt) straight to Drive folder / webhook — not the document library */
export const uploadFileViaIntegration = async (req: Request, res: Response, next: NextFunction) => {
    const tmpPath = req.file?.path;
    try {
        const orgId = await requireAdminWithActivePlan(req, res);
        if (!orgId) return;

        const doc = await IntegrationConnection.findOne({
            connectionId: req.params.id,
            organizationId: orgId,
        });
        if (!doc) {
            return res.status(404).json({ success: false, message: 'Integration not found' });
        }
        if (!doc.isActive) {
            return res.status(400).json({ success: false, message: 'Integration is not active' });
        }

        const file = req.file;
        if (!file) {
            return res.status(400).json({
                success: false,
                message: 'No file uploaded (multipart field: file)',
            });
        }

        const destFolderRaw = req.body?.folder ?? req.body?.destinations?.folder;
        const destWebhookRaw = req.body?.webhook ?? req.body?.destinations?.webhook;
        const destinations = {
            folder:
                destFolderRaw === undefined
                    ? undefined
                    : destFolderRaw === true ||
                      destFolderRaw === 'true' ||
                      destFolderRaw === '1',
            webhook:
                destWebhookRaw === undefined
                    ? undefined
                    : destWebhookRaw === true ||
                      destWebhookRaw === 'true' ||
                      destWebhookRaw === '1',
        };

        const buffer = fs.readFileSync(file.path);
        const result = await sendRawFileViaIntegration({
            conn: doc,
            organizationId: orgId,
            filename: file.originalname || 'upload.bin',
            mimeType: file.mimetype || 'application/octet-stream',
            buffer,
            destinations,
        });

        const delivered =
            (Array.isArray(result.uploaded) && result.uploaded.length > 0) || result.webhookOk === true;
        const message = delivered
            ? `Sent ${file.originalname || 'file'} to ${doc.label || doc.providerId}`
            : result.errors[0] || 'Send failed';

        doc.lastStatus = delivered ? `upload_ok: ${file.originalname}` : `upload_failed`;
        doc.lastSyncAt = new Date();
        await doc.save();

        recordActivityFromReq(req, {
            action: 'integrations.upload',
            category: 'document',
            resourceType: 'integration',
            resourceId: doc.connectionId,
            message,
            metadata: { filename: file.originalname, result },
        });

        res.status(delivered ? 200 : 400).json({
            success: delivered,
            message,
            data: {
                ...result,
                connection: publicConnection(doc.toObject(), req),
            },
        });
    } catch (error: any) {
        const status = error?.statusCode || 400;
        return res.status(status).json({
            success: false,
            message: error?.message || 'Upload failed',
        });
    } finally {
        if (tmpPath) {
            try {
                fs.unlinkSync(tmpPath);
            } catch {
                /* ignore */
            }
        }
    }
};

/** Public ingest endpoint — supports API key, Bearer, Basic, or custom header auth */
export const ingestViaIntegration = async (req: Request, res: Response, next: NextFunction) => {
    let multipartTmp = '';
    try {
        const connection = await resolveIngestConnectionFromRequest(req);
        if (!connection) {
            return res.status(401).json({
                success: false,
                message:
                    'Invalid or missing ingest credentials. Check your auth method (API key header, Bearer token, Basic auth, or custom header) in Integrations → Edit.',
            });
        }

        if (req.file) multipartTmp = req.file.path;
        const result = await processIngestHttpRequest(req, connection);

        res.status(201).json({
            success: true,
            message:
                result.ingestMode === 'structured_record'
                    ? result.updated
                        ? 'Structured record updated'
                        : 'Structured record ingested'
                    : result.ingestMode === 'file_url'
                      ? 'Document ingested from URL'
                      : 'Document ingested',
            data: result,
        });
    } catch (error: any) {
        if (multipartTmp && fs.existsSync(multipartTmp)) {
            try {
                fs.unlinkSync(multipartTmp);
            } catch {
                /* ignore */
            }
        }
        if (error?.statusCode) {
            return res.status(error.statusCode).json({
                success: false,
                code: error.code,
                message: error.message,
            });
        }
        next(error);
    }
};

/** Per-connection push URL — for ERP/QMS middleware that needs a unique URL per system stream. */
export const pushViaConnection = async (req: Request, res: Response, next: NextFunction) => {
    let multipartTmp = '';
    try {
        const connectionId = String(req.params.id || '').trim();
        if (!connectionId) {
            return res.status(401).json({
                success: false,
                message: 'Missing connection id',
            });
        }

        const connection = await IntegrationConnection.findOne({ connectionId, isActive: true });
        if (!connection) {
            return res.status(404).json({ success: false, message: 'Connection not found' });
        }
        if (!validateIngestAuth(connection, req)) {
            return res.status(401).json({
                success: false,
                message: 'Invalid connection or ingest credentials for this auth method',
            });
        }

        if (req.file) multipartTmp = req.file.path;
        const result = await processIngestHttpRequest(req, connection);

        res.status(201).json({
            success: true,
            message:
                result.ingestMode === 'structured_record'
                    ? result.updated
                        ? 'Structured record updated'
                        : 'Structured record ingested'
                    : result.ingestMode === 'file_url'
                      ? 'Document ingested from URL'
                      : 'Document ingested',
            data: result,
        });
    } catch (error: any) {
        if (multipartTmp && fs.existsSync(multipartTmp)) {
            try {
                fs.unlinkSync(multipartTmp);
            } catch {
                /* ignore */
            }
        }
        if (error?.statusCode) {
            return res.status(error.statusCode).json({
                success: false,
                code: error.code,
                message: error.message,
            });
        }
        next(error);
    }
};

/** Public Slack Events webhook — ?key= matches connection ingest API key. */
export const slackWebhook = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const connectionId = String(req.params.id || '').trim();
        const key = String(req.query.key || req.headers['x-integration-key'] || '').trim();
        const payload = (req.body || {}) as Record<string, unknown>;

        // Slack url_verification must answer before auth when first configuring Events
        if (String(payload.type || '') === 'url_verification' && payload.challenge != null) {
            if (connectionId && key) {
                const connection = await IntegrationConnection.findOne({
                    connectionId,
                    isActive: true,
                    providerId: 'slack',
                });
                if (connection && secureIngestKeyMatch(connection.ingestApiKey, key)) {
                    return res.json({ challenge: payload.challenge });
                }
            }
            // Still echo challenge so Slack can verify URL shape; key checked on real events
            return res.json({ challenge: payload.challenge });
        }

        if (!connectionId || !key) {
            return res.status(401).json({
                success: false,
                message: 'Missing connection id or key query parameter',
            });
        }

        const connection = await IntegrationConnection.findOne({
            connectionId,
            isActive: true,
            providerId: 'slack',
        });
        if (!connection || !secureIngestKeyMatch(connection.ingestApiKey, key)) {
            return res.status(401).json({ success: false, message: 'Invalid Slack webhook key' });
        }

        const result = await processSlackWebhook(connection, payload);
        if (result.challenge != null) {
            return res.json({ challenge: result.challenge });
        }
        return res.json({ success: true, ...result });
    } catch (error: any) {
        if (error?.statusCode) {
            return res.status(error.statusCode).json({
                success: false,
                message: error.message,
            });
        }
        next(error);
    }
};

/** Public ClickUp webhook — authenticated via ?key= ingest API key (ClickUp cannot set custom headers). */
export const clickUpWebhook = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const connectionId = String(req.params.id || '').trim();
        const key = String(req.query.key || req.headers['x-integration-key'] || '').trim();
        if (!connectionId || !key) {
            return res.status(401).json({
                success: false,
                message: 'Missing connection id or key query parameter',
            });
        }

        const connection = await IntegrationConnection.findOne({
            connectionId,
            isActive: true,
            providerId: 'clickup',
        });
        if (!connection || !secureIngestKeyMatch(connection.ingestApiKey, key)) {
            return res.status(401).json({ success: false, message: 'Invalid ClickUp webhook key' });
        }
        if (!validateIngestAuth(connection, req)) {
            return res.status(401).json({ success: false, message: 'Invalid ClickUp webhook credentials' });
        }

        const result = await processClickUpWebhook(connection, req.body || {});
        return res.json({ success: true, ...result });
    } catch (error: any) {
        if (error?.statusCode) {
            return res.status(error.statusCode).json({
                success: false,
                message: error.message,
            });
        }
        next(error);
    }
};
