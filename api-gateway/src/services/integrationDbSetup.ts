import IntegrationConnection from '../models/IntegrationConnection';
import logger from '../utils/logger';

/**
 * One-time migration helper: older deployments had a unique index on
 * { organizationId, providerId } which blocked multiple custom_webhook connections.
 */
export async function ensureIntegrationIndexes(): Promise<void> {
    try {
        const collection = IntegrationConnection.collection;
        const indexes = await collection.indexes();
        const legacy = indexes.find(
            (idx) =>
                idx.unique === true &&
                idx.key &&
                idx.key.organizationId === 1 &&
                idx.key.providerId === 1 &&
                Object.keys(idx.key).length === 2
        );
        if (legacy?.name) {
            await collection.dropIndex(legacy.name);
            logger.info(`[integrations] dropped legacy unique index ${legacy.name}`);
        }
        await IntegrationConnection.syncIndexes();
        logger.info('[integrations] index sync complete');
    } catch (err: any) {
        logger.warn(`[integrations] index migration skipped: ${err?.message || err}`);
    }
}
