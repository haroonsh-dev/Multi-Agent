import { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import AgentApiToken from '../models/AgentApiToken';
import { hasPermission } from '../services/accessScope';
import { getActiveSubscription, getAllowedAgentsForOrg, requireAllowedAgent } from '../services/planService';
import { PERMISSIONS } from '../types/permissions';
import { PLAN_AGENT_LABELS } from '../models/AgentStoragePricing';
import { chatWithDocuments } from './chatController';
import { recordActivityFromReq } from '../services/activityLog';

function generateAgentApiKey(): string {
    return `vdag_${crypto.randomBytes(24).toString('hex')}`;
}

function maskToken(token: string): string {
    const t = String(token || '');
    if (t.length < 12) return '••••';
    return `${t.slice(0, 6)}****${t.slice(-4)}`;
}

function publicBase(req: Request): string {
    // req.protocol/host is NOT reliable here: the frontend's Next.js rewrite proxy
    // (next.config.ts) rewrites the Host header to match its internal fetch target
    // (api-gateway:5100) when forwarding, so that fallback previously leaked the
    // Docker-internal hostname into customer-facing Ask URL / example cURL — a real
    // partner integration would get a DNS failure copying it verbatim.
    const configured = process.env.PUBLIC_API_URL || process.env.API_PUBLIC_URL || '';
    // FRONTEND_URL may be a comma-separated list (see CORS setup in app.ts); take the first.
    const base = (configured || (process.env.FRONTEND_URL || '').split(',')[0] || `${req.protocol}://${req.get('host')}`).trim();
    return base.replace(/\/$/, '');
}

async function requireSettingsAdmin(req: Request, res: Response): Promise<string | null> {
    if (!req.user || !hasPermission(req.user, PERMISSIONS.PAGE_SETTINGS)) {
        res.status(403).json({ success: false, message: 'Missing permission: page.settings' });
        return null;
    }
    const orgId = req.user.organizationId;
    if (!orgId) {
        res.status(400).json({ success: false, message: 'organizationId required' });
        return null;
    }
    const sub = await getActiveSubscription(orgId);
    if (!sub && req.user.role !== 'superAdmin') {
        res.status(403).json({
            success: false,
            message: 'Active subscription required to use Agent API',
        });
        return null;
    }
    return orgId;
}

/** Admin: get token status + example URLs (key masked). */
export const getAgentApiStatus = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const orgId = await requireSettingsAdmin(req, res);
        if (!orgId) return;

        const row = await AgentApiToken.findOne({ organizationId: orgId }).lean();
        const agents = await getAllowedAgentsForOrg(orgId);
        const base = publicBase(req);

        res.json({
            success: true,
            data: {
                hasToken: Boolean(row?.token && row?.isActive),
                tokenMasked: row?.token ? maskToken(row.token) : null,
                label: row?.label || null,
                isActive: row?.isActive ?? false,
                lastUsedAt: row?.lastUsedAt || null,
                createdAt: row?.createdAt || null,
                allowedAgents: agents.map((id) => ({
                    id,
                    label: PLAN_AGENT_LABELS[id] || id,
                })),
                askUrlTemplate: `${base}/api/v1/agents/{agentId}/ask`,
                exampleAskUrl: agents[0]
                    ? `${base}/api/v1/agents/${agents[0]}/ask`
                    : `${base}/api/v1/agents/compliance_agent/ask`,
            },
        });
    } catch (error) {
        next(error);
    }
};

/** Admin: create or rotate Agent API token (full key returned once). */
export const rotateAgentApiToken = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const orgId = await requireSettingsAdmin(req, res);
        if (!orgId) return;

        const label = String(req.body?.label || 'Agent API').trim() || 'Agent API';
        const token = generateAgentApiKey();
        const tokenId = `aat_${crypto.randomBytes(8).toString('hex')}`;

        let row = await AgentApiToken.findOne({ organizationId: orgId });
        const isNew = !row;
        if (!row) {
            row = new AgentApiToken({
                tokenId,
                organizationId: orgId,
                token,
                label,
                isActive: true,
            });
        } else {
            row.token = token;
            row.label = label;
            row.isActive = true;
            row.lastUsedAt = null;
        }
        await row.save();

        recordActivityFromReq(req, {
            action: isNew ? 'agent_api.create' : 'agent_api.rotate',
            category: 'admin',
            resourceType: 'agent_api_token',
            resourceId: row.tokenId,
            message: isNew ? 'Created Agent API token' : 'Rotated Agent API token',
        });

        const base = publicBase(req);
        const agents = await getAllowedAgentsForOrg(orgId);

        res.json({
            success: true,
            message: isNew
                ? 'Agent API token created — copy it now'
                : 'Agent API token rotated — copy the new key now',
            data: {
                token,
                tokenMasked: maskToken(token),
                label: row.label,
                askUrlTemplate: `${base}/api/v1/agents/{agentId}/ask`,
                exampleAskUrl: agents[0]
                    ? `${base}/api/v1/agents/${agents[0]}/ask`
                    : `${base}/api/v1/agents/compliance_agent/ask`,
                allowedAgents: agents,
                curlExample: buildCurlExample(
                    agents[0] || 'compliance_agent',
                    `${base}/api/v1/agents/${agents[0] || 'compliance_agent'}/ask`,
                    token
                ),
            },
        });
    } catch (error) {
        next(error);
    }
};

/** Admin: revoke token. */
export const revokeAgentApiToken = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const orgId = await requireSettingsAdmin(req, res);
        if (!orgId) return;

        const row = await AgentApiToken.findOne({ organizationId: orgId });
        if (!row) {
            return res.status(404).json({ success: false, message: 'No Agent API token found' });
        }
        row.isActive = false;
        await row.save();

        recordActivityFromReq(req, {
            action: 'agent_api.revoke',
            category: 'admin',
            resourceType: 'agent_api_token',
            resourceId: row.tokenId,
            message: 'Revoked Agent API token',
        });

        res.json({ success: true, message: 'Agent API token revoked' });
    } catch (error) {
        next(error);
    }
};

function buildCurlExample(agentId: string, url: string, token: string): string {
    return `curl -sS -X POST '${url}' \\\n  -H 'Authorization: Bearer ${token}' \\\n  -H 'Content-Type: application/json' \\\n  -d '{"message":"What can you help with?","sessionId":"demo-1"}'`;
}

/**
 * Public: POST /api/v1/agents/:agentId/ask
 * Auth via Agent API token. Reuses the same chat brain as the Visibility UI.
 */
export const askAgentViaApi = async (req: Request, res: Response, next: NextFunction) => {
    try {
        if (!req.user?.organizationId) {
            return res.status(401).json({ success: false, message: 'Unauthorized' });
        }

        const rawAgent = String(req.params.agentId || '').trim();
        const allowed = await getAllowedAgentsForOrg(req.user.organizationId);
        let agentId = rawAgent.toLowerCase().replace(/-/g, '_');
        if (agentId && !allowed.includes(agentId) && !agentId.endsWith('_agent')) {
            const withSuffix = `${agentId}_agent`;
            if (allowed.includes(withSuffix)) agentId = withSuffix;
        }

        if (!agentId) {
            return res.status(400).json({
                success: false,
                message: 'agentId is required in the path, e.g. /api/v1/agents/compliance_agent/ask',
            });
        }

        const check = await requireAllowedAgent(req.user, agentId);
        if (!check.ok) {
            return res.status(403).json({
                success: false,
                code: check.code,
                message: check.message,
                data: { allowedAgents: check.entitlement.agentIds },
            });
        }

        const message = (req.body?.message || req.body?.query || req.body?.question || '')
            .toString()
            .trim();
        if (!message) {
            return res.status(400).json({ success: false, message: 'message is required' });
        }

        // Normalize body for chatWithDocuments
        req.body = {
            ...req.body,
            message,
            phase3Agent: agentId,
            phase3_agent: agentId,
            chatScope: req.body?.chatScope || (Array.isArray(req.body?.documentIds) && req.body.documentIds.length ? 'selected' : 'all'),
            sessionId: req.body?.sessionId || req.body?.threadId || undefined,
            documentIds: Array.isArray(req.body?.documentIds) ? req.body.documentIds : [],
        };

        return chatWithDocuments(req, res, next);
    } catch (error) {
        next(error);
    }
};
