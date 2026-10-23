import rateLimit from 'express-rate-limit';

/**
 * Brute-force guard for authentication endpoints (login/register/refresh).
 * Keyed by IP; 10 attempts per 15 minutes. On violation the client gets a
 * 429 with a Retry-After header so the UI can show a sensible message.
 */
export const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 10,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    message: {
        success: false,
        message: 'Too many authentication attempts. Please try again in 15 minutes.',
    },
});

/**
 * Generic API baseline limiter — intentionally generous (600 req / 15 min /
 * IP) so normal dashboard + chat polling never trips it, while still capping
 * outright abuse. Tune from real traffic before tightening.
 */
export const apiLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 600,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    message: {
        success: false,
        message: 'Too many requests. Please slow down.',
    },
});

/** Public integration ingest — keyed by IP; generous for factory schedulers. */
export const ingestLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: Math.max(30, Number(process.env.INTEGRATION_INGEST_RATE_LIMIT || 180)),
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    message: {
        success: false,
        code: 'RATE_LIMIT',
        message: 'Too many ingest requests. Retry later or contact your admin.',
    },
});
