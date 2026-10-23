import { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import AgentApiToken from '../models/AgentApiToken';
import Organization from '../models/Organization';
import { DEFAULT_ADMIN_PERMISSIONS } from '../types/permissions';

function extractAgentApiKey(req: Request): string {
    const headerKey = String(req.headers['x-agent-key'] || '').trim();
    if (headerKey) return headerKey;
    const auth = String(req.headers.authorization || '');
    if (auth.toLowerCase().startsWith('bearer ')) return auth.slice(7).trim();
    const q = String(req.query?.key || '').trim();
    return q;
}

function secureTokenMatch(stored: string, provided: string): boolean {
    const a = Buffer.from(String(stored || ''), 'utf8');
    const b = Buffer.from(String(provided || ''), 'utf8');
    if (a.length !== b.length) {
        if (a.length) crypto.timingSafeEqual(a, a);
        return false;
    }
    return crypto.timingSafeEqual(a, b);
}

/**
 * Authenticate public Agent API requests via X-Agent-Key / Bearer token.
 * Sets req.user as an org-scoped service principal with chat + org doc access.
 */
export const authenticateAgentApi = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const provided = extractAgentApiKey(req);
        if (!provided) {
            return res.status(401).json({
                success: false,
                message: 'Missing Agent API key. Use Authorization: Bearer <token> or X-Agent-Key.',
            });
        }

        const row = await AgentApiToken.findOne({ token: provided, isActive: true });
        if (!row || !secureTokenMatch(row.token, provided)) {
            return res.status(401).json({
                success: false,
                message: 'Invalid or revoked Agent API key',
            });
        }

        const org = await Organization.findOne({
            organizationId: row.organizationId,
            status: 'active',
        }).lean();
        if (!org) {
            return res.status(403).json({
                success: false,
                message: 'Organization inactive or not found',
            });
        }

        row.lastUsedAt = new Date();
        void row.save().catch(() => undefined);

        req.user = {
            userId: `agent_api:${row.organizationId}`,
            username: 'agent-api',
            email: org.contactEmail || undefined,
            role: 'admin',
            organizationId: row.organizationId,
            permissions: { ...DEFAULT_ADMIN_PERMISSIONS },
            primaryDepartmentId: null,
            orgRoleId: null,
            accountType: 'agent_api',
            agentApiTokenId: row.tokenId,
        };

        next();
    } catch (error: any) {
        return res.status(500).json({
            success: false,
            message: error?.message || 'Agent API authentication failed',
        });
    }
};
