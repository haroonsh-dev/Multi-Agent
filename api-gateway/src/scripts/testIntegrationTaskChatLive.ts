/**
 * Live DB smoke test for universal integration task chat (requires .env + Mongo).
 * Run: npx tsx --tsconfig tsconfig.json src/scripts/testIntegrationTaskChatLive.ts
 */
import dotenv from 'dotenv';
import dbConnect from '../config/db';
import User from '../models/User';
import Document from '../models/Document';
import {
    tryIntegrationTaskCommand,
    loadIntegrationTaskRows,
    detectIntegrationTaskAsk,
} from '../services/integrationTaskChatService';

dotenv.config();

async function main() {
    await dbConnect();

    const email = (process.env.SEED_ADMIN_EMAIL || 'admin@docs.visibilitybots.com').toLowerCase();
    const user = await User.findOne({ email }).lean();
    if (!user) {
        console.error('No seed admin user — run npm run seed');
        process.exit(1);
    }

    const authUser = {
        userId: user.userId,
        role: user.role,
        organizationId: user.organizationId,
        permissions: user.permissions as Record<string, boolean>,
    };

    const taskDocCount = await Document.countDocuments({
        organizationId: user.organizationId,
        status: 'ready',
        'metadata.ingestKind': 'structured_record',
        $or: [
            { 'metadata.recordType': 'task' },
            { 'metadata.source': 'clickup' },
            { 'metadata.integrationExternalRef.clickupTaskId': { $exists: true, $ne: '' } },
        ],
    });

    console.log(`Synced task records in org: ${taskDocCount}`);

    const rows = await loadIntegrationTaskRows(authUser, { limit: 5 });
    console.log(`loadIntegrationTaskRows sample: ${rows.length}`);
    for (const r of rows.slice(0, 3)) {
        console.log(`  - ${r.name} | ${r.status} | ${r.assignees}`);
    }

    const questions = [
        'show synced tasks',
        'Show ClickUp tasks and who is assigned',
    ];

    for (const q of questions) {
        console.log(`\n--- Q: "${q}" (detect=${detectIntegrationTaskAsk(q)}) ---`);
        const res = await tryIntegrationTaskCommand({
            user: authUser,
            question: q,
            phase3Agent: 'hr_agent',
        });
        console.log(`handled=${res.handled} citations=${res.citations?.length ?? 0}`);
        console.log((res.answer || '').slice(0, 600));
        if ((res.answer || '').length > 600) console.log('…');
    }
}

main()
    .then(() => process.exit(0))
    .catch((e) => {
        console.error(e);
        process.exit(1);
    });
