import { Router } from 'express';
import { authenticate, requirePermission } from '../middleware/auth';
import { PERMISSIONS } from '../types/permissions';
import {
    getEmailReportConfig,
    saveEmailReportConfig,
    sendEmailReportNow,
} from '../controllers/emailReportsController';

const router = Router();

router.use(authenticate, requirePermission(PERMISSIONS.PAGE_EMAIL_REPORTS));
router.get('/', getEmailReportConfig);
router.put('/', saveEmailReportConfig);
router.post('/send-now', sendEmailReportNow);

export default router;
