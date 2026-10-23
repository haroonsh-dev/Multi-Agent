import { Request, Response, NextFunction } from 'express';
import Document from '../models/Document';
import { buildDocumentFilter } from '../services/accessScope';
import {
    formatAiError,
    isAiServiceEnabled,
    resolveAiOrganizationId,
    searchWithAi,
} from '../services/aiServiceClient';
import { PERMISSIONS } from '../types/permissions';
import { hasPermission } from '../services/accessScope';
import logger from '../utils/logger';

export const searchDocuments = async (req: Request, res: Response, next: NextFunction) => {
    try {
        if (!hasPermission(req.user, PERMISSIONS.DOCUMENT_VIEW)) {
            return res.status(403).json({ success: false, message: 'Forbidden' });
        }

        const body = req.body || {};
        const query = (body.query || req.query.q || '').toString().trim();
        if (!query) {
            return res.status(400).json({ success: false, message: 'query is required' });
        }

        if (!isAiServiceEnabled()) {
            return res.status(503).json({
                success: false,
                message: 'AI search service is disabled. Set AI_SERVICE_ENABLED=true and start the Python service.',
            });
        }

        const organizationId = resolveAiOrganizationId(req.user);
        const documentType = (body.documentType || req.query.documentType || '').toString() || undefined;
        const phase3Agent = (body.phase3Agent || req.query.phase3Agent || body.phase3_agent || req.query.phase3_agent || '').toString() || undefined;
        if (phase3Agent && req.user.role !== 'superAdmin') {
            const { requireAllowedAgent } = await import('../services/planService');
            const check = await requireAllowedAgent(req.user, phase3Agent);
            if (!check.ok) {
                return res.status(403).json({
                    success: false,
                    code: check.code,
                    message: check.message,
                    data: { allowedAgents: check.entitlement.agentIds },
                });
            }
        }
        const statusFilter = (body.status || req.query.status || '').toString() || undefined;
        const limit = Math.min(100, parseInt((body.limit || req.query.limit || '20') as string, 10));
        const offset = Math.max(0, parseInt((body.offset || req.query.offset || '0') as string, 10));

        try {
            const result = await searchWithAi({
                organizationId,
                query,
                documentType,
                phase3Agent,
                status: statusFilter,
                limit,
                offset,
            });

            const pythonIds = [...new Set(result.results.map((r) => r.document_id).filter(Boolean))];
            const nodeDocs = await Document.find(
                await buildDocumentFilter(req.user, { pythonDocumentId: { $in: pythonIds } })
            ).lean();
            const pythonToNode = new Map(
                nodeDocs.filter((d) => d.pythonDocumentId).map((d) => [d.pythonDocumentId as string, d])
            );

            const enriched = result.results.map((hit) => {
                const nodeDoc = pythonToNode.get(hit.document_id);
                return {
                    ...hit,
                    nodeDocumentId: nodeDoc?.documentId || null,
                    previewDocumentId: nodeDoc?.documentId || hit.document_id,
                };
            });

            res.json({
                success: true,
                data: {
                    results: enriched,
                    total: result.total,
                    query: result.query,
                },
            });
        } catch (aiError: any) {
            logger.error(`AI search proxy failed: ${formatAiError(aiError)}`);
            return res.status(502).json({
                success: false,
                message: 'AI search service unavailable',
                error: formatAiError(aiError),
            });
        }
    } catch (error) {
        next(error);
    }
};
