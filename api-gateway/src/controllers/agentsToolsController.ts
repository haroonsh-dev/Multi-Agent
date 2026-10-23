import { Request, Response, NextFunction } from 'express';
import { getAiAgents, getAgentTools, getToolAudit } from '../services/aiServiceClient';

/**
 * Gateway surface for the ai-backend agent registry + tool policy audit trail.
 * The frontend talks only to this gateway, so these proxy endpoints make the
 * capability marketplace (Step 6 of the plan) and the tamper-proof audit trail
 * (Step 4) reachable without exposing the ai-backend directly.
 */

/** Capability marketplace: agents + their tools/capabilities. */
export const listAgentsMarketplace = async (_req: Request, res: Response, next: NextFunction) => {
    try {
        const agents = await getAiAgents();
        if (!agents) {
            return res.status(503).json({ success: false, message: 'AI service unavailable' });
        }
        res.json({ success: true, data: { agents } });
    } catch (error) {
        next(error);
    }
};

/** Tools available to a single agent. */
export const listAgentTools = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const agentId = String(req.params.agentId || '');
        const tools = await getAgentTools(agentId);
        if (!tools) {
            return res.status(404).json({ success: false, message: `No tools for agent "${agentId}"` });
        }
        res.json({ success: true, data: { agentId, tools } });
    } catch (error) {
        next(error);
    }
};

/** Org-scoped tool-policy audit trail (admin+ only). */
export const listToolAudit = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const organizationId = req.user.organizationId;
        if (!organizationId) {
            return res.json({ success: true, data: { total: 0, rows: [] } });
        }
        const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 50));
        const toolName = req.query.tool_name ? String(req.query.tool_name) : undefined;
        const audit = await getToolAudit({ organizationId, limit, toolName });
        res.json({ success: true, data: audit || { total: 0, rows: [] } });
    } catch (error) {
        next(error);
    }
};
