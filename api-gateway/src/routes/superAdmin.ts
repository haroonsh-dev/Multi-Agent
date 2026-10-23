import { Router } from 'express';
import { authenticate, authorize } from '../middleware/auth';
import {
    createAdmin,
    deleteAdmin,
    listAdmins,
    listAllDocuments,
    listAllTeams,
    listOrganizations,
    updateAdmin,
    updateAdminStatus,
    updateOrganizationGroqKey,
    deleteOrganizationGroqKey,
    updateOrganizationAiKey,
    deleteOrganizationAiKey,
} from '../controllers/superAdminController';
import {
    approvePlanRequest,
    createPlan,
    createSubscriptionDirect,
    deletePlan,
    getPricing,
    listPlanRequests,
    listPlansAdmin,
    listSubscriptions,
    patchSubscription,
    rejectPlanRequest,
    updatePlan,
    updatePricing,
} from '../controllers/plansController';

const router = Router();

router.use(authenticate);
router.use(authorize('superAdmin'));

router.get('/admins', listAdmins);
router.post('/admins', createAdmin);
router.patch('/admins/:userId/status', updateAdminStatus);
router.put('/admins/:userId', updateAdmin);
router.delete('/admins/:userId', deleteAdmin);
router.get('/organizations', listOrganizations);
router.post('/organizations/:orgId/groq-key', updateOrganizationGroqKey);
router.put('/organizations/:orgId/groq-key', updateOrganizationGroqKey);
router.delete('/organizations/:orgId/groq-key', deleteOrganizationGroqKey);
router.post('/organizations/:orgId/ai-key', updateOrganizationAiKey);
router.put('/organizations/:orgId/ai-key', updateOrganizationAiKey);
router.delete('/organizations/:orgId/ai-key', deleteOrganizationAiKey);
router.get('/documents', listAllDocuments);
router.get('/teams', listAllTeams);

// Plans / pricing / subscriptions
router.get('/pricing', getPricing);
router.put('/pricing', updatePricing);
router.get('/plans', listPlansAdmin);
router.post('/plans', createPlan);
router.put('/plans/:planId', updatePlan);
router.delete('/plans/:planId', deletePlan);
router.get('/plan-requests', listPlanRequests);
router.post('/plan-requests/:id/approve', approvePlanRequest);
router.post('/plan-requests/:id/reject', rejectPlanRequest);
router.get('/subscriptions', listSubscriptions);
router.post('/subscriptions', createSubscriptionDirect);
router.patch('/subscriptions/:id', patchSubscription);

export default router;
