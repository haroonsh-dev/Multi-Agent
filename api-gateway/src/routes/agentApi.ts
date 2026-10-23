import { Router } from 'express';
import { authenticate, requirePermission } from '../middleware/auth';
import { authenticateAgentApi } from '../middleware/agentApiAuth';
import { PERMISSIONS } from '../types/permissions';
import {
    askAgentViaApi,
    getAgentApiStatus,
    revokeAgentApiToken,
    rotateAgentApiToken,
} from '../controllers/agentApiController';

/** Public Agent Ask API — token auth (no user JWT). */
export const agentApiPublicRouter = Router();
agentApiPublicRouter.post('/:agentId/ask', authenticateAgentApi, askAgentViaApi);

/** Admin management of Agent API tokens. */
export const agentApiAdminRouter = Router();
agentApiAdminRouter.use(authenticate, requirePermission(PERMISSIONS.PAGE_SETTINGS));
agentApiAdminRouter.get('/token', getAgentApiStatus);
agentApiAdminRouter.post('/token/rotate', rotateAgentApiToken);
agentApiAdminRouter.delete('/token', revokeAgentApiToken);

export default agentApiPublicRouter;
