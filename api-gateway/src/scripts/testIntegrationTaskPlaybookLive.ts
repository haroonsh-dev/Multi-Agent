/**
 * Live smoke: plan → confirm playbook against Mongo + integration connection.
 * Run: npx tsx --tsconfig tsconfig.json src/scripts/testIntegrationTaskPlaybookLive.ts
 * Safe mode: only plans unless PLAYBOOK_EXECUTE=1 (then confirms and writes).
 */
import dotenv from 'dotenv';
import dbConnect from '../config/db';
import User from '../models/User';
import {
    __resetPlaybookStoreForTests,
    detectPlaybookAsk,
    tryIntegrationTaskPlaybookCommand,
} from '../services/integrationTaskPlaybookService';
import { loadIntegrationTaskRows, isOpenIntegrationTask } from '../services/integrationTaskChatService';

dotenv.config();

async function main() {
    await dbConnect();
    __resetPlaybookStoreForTests();

    const email = (process.env.SEED_ADMIN_EMAIL || 'admin@docs.visibilitybots.com').toLowerCase();
    const userDoc = await User.findOne({ email }).lean();
    if (!userDoc) {
        console.error('No seed admin — run npm run seed');
        process.exit(1);
    }

    const user = {
        userId: userDoc.userId,
        role: userDoc.role,
        organizationId: userDoc.organizationId,
        permissions: userDoc.permissions as Record<string, boolean>,
    };

    const rows = await loadIntegrationTaskRows(user, { limit: 50 });
    const open = rows.filter(isOpenIntegrationTask);
    console.log(`Synced tasks: ${rows.length} · open: ${open.length}`);
    for (const r of open.slice(0, 5)) {
        console.log(`  - ${r.name} | ${r.status} | ${r.assignees}`);
    }

    const q = 'process open tasks until done';
    console.log(`\n--- Q: "${q}" (detect=${detectPlaybookAsk(q)}) ---`);
    const plan = await tryIntegrationTaskPlaybookCommand({
        user,
        question: q,
        phase3Agent: 'hr_agent',
        sessionId: 'playbook-live-test',
    });
    console.log(`handled=${plan.handled}`);
    console.log((plan.answer || '').slice(0, 900));

    if (!plan.handled) {
        console.error('Expected plan to be handled');
        process.exit(1);
    }

    if (process.env.PLAYBOOK_EXECUTE === '1') {
        console.log('\n--- Confirm: yes (EXECUTE) ---');
        const run = await tryIntegrationTaskPlaybookCommand({
            user,
            question: 'yes',
            phase3Agent: 'hr_agent',
            sessionId: 'playbook-live-test',
        });
        console.log(`handled=${run.handled}`);
        console.log((run.answer || '').slice(0, 1200));
    } else {
        console.log('\n--- Confirm: cancel (dry) ---');
        const cancel = await tryIntegrationTaskPlaybookCommand({
            user,
            question: 'cancel',
            phase3Agent: 'hr_agent',
            sessionId: 'playbook-live-test',
        });
        console.log(`handled=${cancel.handled}`);
        console.log((cancel.answer || '').slice(0, 400));
        console.log('\nSet PLAYBOOK_EXECUTE=1 to run the write loop against the live integration.');
    }
}

main()
    .then(() => process.exit(0))
    .catch((e) => {
        console.error(e);
        process.exit(1);
    });
