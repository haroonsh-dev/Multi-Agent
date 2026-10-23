import logger from '../utils/logger';

/** Structured log for chart routing — question → resolved docs → intent. */
export function logAnalyticsResolve(params: {
    question: string;
    phase3Agent?: string;
    scopedIn?: number;
    resolvedIds?: string[];
    namedLock?: boolean;
    domains?: string[];
    intent?: string;
    visualCount?: number;
    extractionHits?: number;
    extractionMisses?: number;
    elapsedMs?: number;
}) {
    logger.info(
        [
            '[analytics.resolve]',
            `agent=${params.phase3Agent || '-'}`,
            `q="${(params.question || '').slice(0, 120).replace(/\s+/g, ' ')}"`,
            `scopedIn=${params.scopedIn ?? 0}`,
            `resolved=${(params.resolvedIds || []).length}`,
            `ids=${(params.resolvedIds || []).slice(0, 5).join(',') || '-'}`,
            `namedLock=${Boolean(params.namedLock)}`,
            `domains=${(params.domains || []).join('|') || '-'}`,
            `intent=${params.intent || '-'}`,
            `visuals=${params.visualCount ?? 0}`,
            `extractHit=${params.extractionHits ?? '-'}`,
            `extractMiss=${params.extractionMisses ?? '-'}`,
            `ms=${params.elapsedMs ?? '-'}`,
        ].join(' ')
    );
}
