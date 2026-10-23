import { Request, Response, NextFunction } from 'express';
import logger from '../utils/logger';

export const errorHandler = (err: any, _req: Request, res: Response, _next: NextFunction) => {
    logger.error(err?.stack || err?.message || String(err));
    const status = err.statusCode || err.status || 500;
    const isProd = process.env.NODE_ENV === 'production';
    res.status(status).json({
        success: false,
        // In production only a generic message reaches the client — never
        // dependency internals (mongoose paths, file paths, SQL).
        message: isProd ? (status < 500 ? err.message || 'Request failed' : 'Internal server error') : err.message || 'Internal server error',
        ...(!isProd && { stack: err.stack }),
    });
};

export const notFound = (req: Request, res: Response) => {
    res.status(404).json({ success: false, message: `Route not found: ${req.method} ${req.originalUrl}` });
};
