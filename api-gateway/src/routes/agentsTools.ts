import { Router } from 'express';
import { authenticate, authorize } from '../middleware/auth';
import {
    listAgentsMarketplace,
    listAgentTools,
    listToolAudit,
} from '../controllers/agentsToolsController';

const router = Router();

// Order matters: register the audit path before the parametric /:agentId/tools.
router.get('/tools/audit', authenticate, authorize('admin', 'superAdmin'), listToolAudit);
router.get('/', authenticate, listAgentsMarketplace);
router.get('/:agentId/tools', authenticate, listAgentTools);

export default router;
