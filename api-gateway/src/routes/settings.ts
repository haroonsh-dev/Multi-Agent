import { Router } from 'express';
import { authenticate, requirePermission } from '../middleware/auth';
import { PERMISSIONS } from '../types/permissions';
import {
    listApiKeys,
    saveApiKey,
    toggleApiKey,
    deleteApiKey,
    getProviderConfig,
    setPrimaryProvider,
    getFinanceSettings,
    patchFinanceSettings,
} from '../controllers/settingsController';

const router = Router();

router.use(authenticate, requirePermission(PERMISSIONS.PAGE_SETTINGS));
router.get('/api-keys', listApiKeys);
router.post('/api-keys', saveApiKey);
router.post('/api-keys/primary', setPrimaryProvider);
router.patch('/api-keys/:keyId/toggle', toggleApiKey);
router.delete('/api-keys/:keyId', deleteApiKey);
router.get('/providers', getProviderConfig);
router.get('/finance', getFinanceSettings);
router.patch('/finance', patchFinanceSettings);

export default router;
