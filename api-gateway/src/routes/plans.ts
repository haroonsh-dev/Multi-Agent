import { Router } from 'express';
import { authenticate } from '../middleware/auth';
import {
    createPlanRequest,
    getMySubscription,
    listMyPlanRequests,
    listPlansPublic,
    quotePlan,
} from '../controllers/plansController';

const router = Router();

router.use(authenticate);

router.get('/', listPlansPublic);
router.post('/quote', quotePlan);
router.post('/requests', createPlanRequest);
router.get('/requests/mine', listMyPlanRequests);
router.get('/subscription', getMySubscription);

export default router;
