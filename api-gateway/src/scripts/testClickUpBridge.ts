/**
 * Unit checks for ClickUp bridge helpers (no live API).
 * Run: npm run test:clickup-bridge
 */
import {
    buildClickUpWebhookUrl,
    extractClickUpTaskId,
    type ClickUpWebhookPayload,
} from '../services/clickupBridgeService';
import { buildConnectionPushUrl } from '../services/integrationIngestService';

function assert(cond: boolean, msg: string) {
    if (!cond) {
        console.error(`FAIL ${msg}`);
        process.exitCode = 1;
    } else {
        console.log(`OK ${msg}`);
    }
}

function taskAttachments(task: Record<string, unknown>) {
    const raw = task.attachments;
    if (!Array.isArray(raw)) return [];
    return raw;
}

assert(
    buildClickUpWebhookUrl('http://localhost:5100', 'int_abc', 'vdint_key123').includes(
        '/clickup/int_abc/webhook?key=vdint_key123'
    ),
    'webhook URL builder'
);

const payload: ClickUpWebhookPayload = { event: 'taskUpdated', task_id: '86abc' };
assert(Boolean(payload.task_id), 'webhook payload task_id');

const task = {
    id: '86abc',
    name: 'Invoice review',
    list: { id: '901111' },
    attachments: [{ id: 'att1', title: 'invoice', extension: 'pdf', url: 'https://example.com/a.pdf' }],
};
const atts = taskAttachments(task);
assert(atts.length === 1, 'attachment parse');

assert(
    buildConnectionPushUrl('http://localhost:5100', 'int_sap_ap', 'vdint_key').includes(
        '/connections/int_sap_ap/push?key=vdint_key'
    ),
    'connection push URL builder'
);

assert(
    extractClickUpTaskId('https://app.clickup.com/t/90182752640/z8m132xx6f') === 'z8m132xx6f',
    'modern task URL extracts custom task id'
);

assert(
    extractClickUpTaskId('https://app.clickup.com/t/86abc123') === '86abc123',
    'classic task URL extracts task id'
);

console.log(process.exitCode ? 'Some ClickUp bridge checks failed' : 'All ClickUp bridge checks passed');
