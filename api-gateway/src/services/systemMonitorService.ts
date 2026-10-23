import Document from '../models/Document';
import IntegrationConnection from '../models/IntegrationConnection';
import ActivityLog from '../models/ActivityLog';
import { AuthUser, buildDocumentFilter, hasPermission } from './accessScope';
import { PERMISSIONS } from '../types/permissions';
import { checkAiHealth, getGroqStatus } from './aiServiceClient';
import { ANALYTICS_AGENT_IDS, docTypesForAgent } from '../constants/agentCatalog';

export type SystemMonitorAlert = {
    id: string;
    severity: 'critical' | 'warning' | 'info';
    title: string;
    detail?: string;
    href?: string;
};

export type SystemMonitorPayload = {
    timestamp: string;
    services: {
        apiGateway: 'ok';
        aiEngine: 'ok' | 'degraded' | 'offline';
        groqLimited: boolean;
    };
    pipeline: {
        total: number;
        processed: number;
        processing: number;
        failed: number;
        successRate: number;
        uploadsLast24h: number;
        stuckProcessing: number;
    };
    agents: Array<{
        agentId: string;
        documentCount: number;
        readyCount: number;
    }>;
    integrations: {
        connected: number;
        active: number;
        items: Array<{
            connectionId: string;
            label: string;
            providerId: string;
            agentId: string | null;
            lastSyncAt: string | null;
            lastStatus: string | null;
            hasAlert: boolean;
            alertMessage?: string;
        }>;
    } | null;
    activity: Array<{
        logId: string;
        action: string;
        category: string;
        outcome: string;
        message?: string;
        actorName?: string;
        createdAt: string;
    }>;
    alerts: SystemMonitorAlert[];
};

const READY_STATUSES = ['ready', 'processed', 'completed', 'embedded', 'classified', 'done', 'review'];
const PROCESSING_STATUSES = ['processing', 'uploaded', 'queued'];

async function buildActivityScope(user: AuthUser): Promise<Record<string, unknown>> {
    if (user.role === 'admin' && user.organizationId) {
        return { organizationId: user.organizationId };
    }
    if (user.role === 'superAdmin') {
        return {};
    }
    return { actorUserId: user.userId };
}

export async function getSystemMonitorSnapshot(user: AuthUser): Promise<SystemMonitorPayload> {
    const uploadedBy = user.role === 'team' ? user.userId : undefined;
    const filter = await buildDocumentFilter(user, uploadedBy ? { uploadedBy } : {});

    const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const stuckBefore = new Date(Date.now() - 2 * 60 * 60 * 1000);

    const [facetResult, aiOk, groq, activityRows, integrationRows] = await Promise.all([
        Document.aggregate([
            { $match: filter },
            {
                $facet: {
                    stats: [
                        {
                            $group: {
                                _id: null,
                                total: { $sum: 1 },
                                processed: {
                                    $sum: { $cond: [{ $in: [{ $toLower: '$status' }, READY_STATUSES] }, 1, 0] },
                                },
                                processing: {
                                    $sum: {
                                        $cond: [{ $in: [{ $toLower: '$status' }, PROCESSING_STATUSES] }, 1, 0],
                                    },
                                },
                                failed: {
                                    $sum: {
                                        $cond: [
                                            {
                                                $or: [
                                                    { $eq: [{ $toLower: '$status' }, 'failed'] },
                                                    {
                                                        $regexMatch: {
                                                            input: { $toLower: '$status' },
                                                            regex: 'fail|error',
                                                        },
                                                    },
                                                ],
                                            },
                                            1,
                                            0,
                                        ],
                                    },
                                },
                                uploadsLast24h: {
                                    $sum: { $cond: [{ $gte: ['$createdAt', oneDayAgo] }, 1, 0] },
                                },
                                stuckProcessing: {
                                    $sum: {
                                        $cond: [
                                            {
                                                $and: [
                                                    { $in: [{ $toLower: '$status' }, PROCESSING_STATUSES] },
                                                    { $lt: ['$updatedAt', stuckBefore] },
                                                ],
                                            },
                                            1,
                                            0,
                                        ],
                                    },
                                },
                            },
                        },
                    ],
                },
            },
        ]),
        checkAiHealth(),
        getGroqStatus().catch(() => ({ limited: false, configured: false })),
        ActivityLog.find(await buildActivityScope(user))
            .sort({ createdAt: -1 })
            .limit(10)
            .lean(),
        user.organizationId && hasPermission(user, PERMISSIONS.PAGE_INTEGRATIONS)
            ? IntegrationConnection.find({ organizationId: user.organizationId })
                  .select(
                      'connectionId label providerId config isActive lastSyncAt lastStatus lastSyncSummary unreadSyncAlert'
                  )
                  .sort({ updatedAt: -1 })
                  .limit(20)
                  .lean()
            : Promise.resolve([]),
    ]);

    const rawStats = facetResult[0]?.stats?.[0] || {
        total: 0,
        processed: 0,
        processing: 0,
        failed: 0,
        uploadsLast24h: 0,
        stuckProcessing: 0,
    };

    const total = rawStats.total || 0;
    const processed = rawStats.processed || 0;
    const processing = rawStats.processing || 0;
    const failed = rawStats.failed || 0;
    const successRate = total > 0 ? Math.round((processed / total) * 100) : 0;

    const agentCountPromises = ANALYTICS_AGENT_IDS.map(async (agentId) => {
        const types = docTypesForAgent(agentId);
        const orClause: Record<string, unknown>[] = [{ 'metadata.phase3Agent': agentId }];
        if (types.length) orClause.push({ classification: { $in: types } });
        const count = await Document.countDocuments({
            ...filter,
            $or: orClause,
        });
        const ready = await Document.countDocuments({
            ...filter,
            $or: orClause,
            status: { $in: ['ready', 'review'] },
        });
        return { agentId, documentCount: count, readyCount: ready };
    });
    const agents = await Promise.all(agentCountPromises);

    const integrations =
        user.organizationId && hasPermission(user, PERMISSIONS.PAGE_INTEGRATIONS)
            ? {
                  connected: integrationRows.length,
                  active: integrationRows.filter((r) => r.isActive).length,
                  items: integrationRows.map((r) => ({
                      connectionId: r.connectionId,
                      label: r.label,
                      providerId: r.providerId,
                      agentId: r.config?.phase3Agent ? String(r.config.phase3Agent) : null,
                      lastSyncAt: r.lastSyncAt ? r.lastSyncAt.toISOString() : null,
                      lastStatus: r.lastStatus ? String(r.lastStatus) : null,
                      hasAlert: !!r.unreadSyncAlert,
                      alertMessage: r.unreadSyncAlert?.message
                          ? String(r.unreadSyncAlert.message)
                          : undefined,
                  })),
              }
            : null;

    const alerts: SystemMonitorAlert[] = [];

    if (!aiOk) {
        alerts.push({
            id: 'ai-offline',
            severity: 'critical',
            title: 'AI engine offline',
            detail: 'Document extraction and chat may be unavailable.',
            href: '/admin/settings',
        });
    }

    if (groq.limited) {
        alerts.push({
            id: 'groq-limited',
            severity: 'warning',
            title: 'AI provider rate limited',
            detail:
                ('message' in groq && groq.message) ||
                'Groq quota reached — chat may be slow or blocked.',
            href: '/admin/settings',
        });
    }

    if (failed > 0) {
        alerts.push({
            id: 'docs-failed',
            severity: failed > 5 ? 'critical' : 'warning',
            title: `${failed} document${failed === 1 ? '' : 's'} failed processing`,
            detail: 'Review failed files and reprocess from the vault.',
            href: '/documents',
        });
    }

    if (rawStats.stuckProcessing > 0) {
        alerts.push({
            id: 'stuck-processing',
            severity: 'warning',
            title: `${rawStats.stuckProcessing} document${rawStats.stuckProcessing === 1 ? '' : 's'} stuck in queue`,
            detail: 'Processing for over 2 hours — check AI backend or reprocess.',
            href: '/documents',
        });
    }

    if (processing > 0) {
        alerts.push({
            id: 'processing-active',
            severity: 'info',
            title: `${processing} document${processing === 1 ? '' : 's'} processing now`,
            detail: 'Pipeline is active.',
        });
    }

    for (const item of integrations?.items.filter((i) => i.hasAlert) || []) {
        alerts.push({
            id: `integration-${item.connectionId}`,
            severity: 'warning',
            title: `Integration: ${item.label}`,
            detail: item.alertMessage || 'Sync attention required',
            href: '/admin/integrations',
        });
    }

    if (alerts.length === 0 && total > 0) {
        alerts.push({
            id: 'all-clear',
            severity: 'info',
            title: 'All systems operational',
            detail: `${processed} of ${total} documents ready (${successRate}% success rate).`,
        });
    }

    return {
        timestamp: new Date().toISOString(),
        services: {
            apiGateway: 'ok',
            aiEngine: aiOk ? (groq.limited ? 'degraded' : 'ok') : 'offline',
            groqLimited: !!groq.limited,
        },
        pipeline: {
            total,
            processed,
            processing,
            failed,
            successRate,
            uploadsLast24h: rawStats.uploadsLast24h || 0,
            stuckProcessing: rawStats.stuckProcessing || 0,
        },
        agents,
        integrations,
        activity: activityRows.map((row) => ({
            logId: String(row.logId || row._id),
            action: String(row.action || ''),
            category: String(row.category || ''),
            outcome: String(row.outcome || 'success'),
            message: row.message ? String(row.message) : undefined,
            actorName: row.actorName ? String(row.actorName) : undefined,
            createdAt: row.createdAt ? new Date(row.createdAt).toISOString() : new Date().toISOString(),
        })),
        alerts: alerts.slice(0, 12),
    };
}
