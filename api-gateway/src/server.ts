import dotenv from 'dotenv';
import app from './app';
import dbConnect from './config/db';
import logger from './utils/logger';
import { seedPlansOnBoot } from './services/planSeed';

dotenv.config();

const PORT = parseInt(process.env.PORT || '5100', 10);
const BACKGROUND_TICK_MS = Math.max(
    60_000,
    Number(process.env.BACKGROUND_TICK_MS || 120_000)
);
const BACKGROUND_JOBS_ENABLED = process.env.DISABLE_BACKGROUND_JOBS !== 'true';

async function start() {
    await dbConnect();
    await seedPlansOnBoot();
    try {
        const { ensureIntegrationIndexes } = await import('./services/integrationDbSetup');
        await ensureIntegrationIndexes();
    } catch (err: any) {
        logger.warn(`[integrations] index setup failed: ${err?.message || err}`);
    }
    app.listen(PORT, () => {
        logger.info(`Visibility Docs AI API listening on http://localhost:${PORT}`);
        logger.info(`OpenRemote enabled: ${process.env.OPENREMOTE_ENABLED !== 'false'}`);
        if (!BACKGROUND_JOBS_ENABLED) {
            logger.info('Background jobs disabled (DISABLE_BACKGROUND_JOBS=true)');
        }
    });

    if (!BACKGROUND_JOBS_ENABLED) return;

    // Lazy-import heavy Drive/email modules only when ticks run (keeps idle RAM lower)
    const runTicks = async () => {
        try {
            const { runDueGoogleDriveSyncs } = await import('./services/integrationSyncService');
            await runDueGoogleDriveSyncs();
        } catch (err: any) {
            logger.warn(`[integrations] auto-sync tick failed: ${err?.message || err}`);
        }
        try {
            const { runDueEmailReports } = await import('./services/emailReportService');
            await runDueEmailReports();
        } catch (err: any) {
            logger.warn(`[email-reports] tick failed: ${err?.message || err}`);
        }
        try {
            const { pruneStaleChatSessionFocus } = await import('./services/chatFocusStore');
            const removed = await pruneStaleChatSessionFocus();
            if (removed > 0) {
                logger.info(`[chat-focus] pruned ${removed} stale session focus row(s)`);
            }
        } catch (err: any) {
            logger.warn(`[chat-focus] prune failed: ${err?.message || err}`);
        }
    };

    setInterval(() => {
        void runTicks();
    }, BACKGROUND_TICK_MS);
    setTimeout(() => {
        void runTicks();
    }, 30_000);
}

start().catch((err) => {
    console.error(err);
    process.exit(1);
});

// Without these, an error thrown outside the Express request lifecycle (a
// fire-and-forget promise, a stray callback) either crashes the process with
// no structured log entry or — for a rejection — just prints a Node warning
// that nothing captures. Log it through the same logger (console + file) so
// it's reviewable, then let uncaughtException exit; process state after one
// is not trustworthy to keep serving on.
process.on('unhandledRejection', (reason) => {
    logger.error(`[unhandledRejection] ${reason instanceof Error ? reason.stack || reason.message : String(reason)}`);
});
process.on('uncaughtException', (err) => {
    logger.error(`[uncaughtException] ${err.stack || err.message}`);
    process.exit(1);
});
