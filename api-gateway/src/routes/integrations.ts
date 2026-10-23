import path from 'path';
import fs from 'fs';
import multer from 'multer';
import { Router } from 'express';
import { authenticate } from '../middleware/auth';
import { ingestLimiter } from '../middleware/rateLimiter';
import {
    listIntegrations,
    saveIntegration,
    testIntegration,
    deleteIntegration,
    rotateIngestKey,
    ingestViaIntegration,
    clickUpWebhook,
    slackWebhook,
    pushViaConnection,
    listIntegrationFiles,
    listClickUpListsForConnection,
    resolveClickUpListForConnection,
    syncIntegrationFiles,
    listSyncInbox,
    confirmSyncPrompt,
    dismissSyncPrompt,
    ackSyncAlert,
    sendViaIntegration,
    uploadFileViaIntegration,
} from '../controllers/integrationsController';

const tmpDir = path.join(process.cwd(), 'uploads', '_tmp');
if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });

const upload = multer({
    dest: tmpDir,
    limits: { fileSize: 50 * 1024 * 1024 },
});

const router = Router();

/** Public ingest — no JWT; uses X-Integration-Key */
router.post('/ingest', ingestLimiter, upload.single('file'), ingestViaIntegration);
/** Per-system push URL — unique per connection (SAP AP, MasterControl QC, …) */
router.post('/connections/:id/push', ingestLimiter, upload.single('file'), pushViaConnection);
/** Public ClickUp webhook — ?key= matches connection ingest API key */
router.post('/clickup/:id/webhook', ingestLimiter, clickUpWebhook);
/** Public Slack Events webhook — same universal flow as ClickUp */
router.post('/slack/:id/webhook', ingestLimiter, slackWebhook);

router.use(authenticate);
router.get('/', listIntegrations);
router.get('/sync-inbox', listSyncInbox);
router.post('/', saveIntegration);
router.post('/:id/test', testIntegration);
router.get('/:id/clickup/lists', listClickUpListsForConnection);
router.post('/:id/clickup/resolve-list', resolveClickUpListForConnection);
router.get('/:id/files', listIntegrationFiles);
router.post('/:id/sync', syncIntegrationFiles);
router.post('/:id/send', sendViaIntegration);
router.post('/:id/upload', upload.single('file'), uploadFileViaIntegration);
router.post('/:id/sync-prompt/confirm', confirmSyncPrompt);
router.post('/:id/sync-prompt/dismiss', dismissSyncPrompt);
router.post('/:id/sync-alert/ack', ackSyncAlert);
router.post('/:id/rotate-key', rotateIngestKey);
router.delete('/:id', deleteIntegration);

export default router;
