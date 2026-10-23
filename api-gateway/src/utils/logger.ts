import winston from 'winston';
import path from 'path';

const format = winston.format.combine(
    winston.format.timestamp(),
    winston.format.printf(({ level, message, timestamp }) => `${timestamp} [${level}] ${message}`)
);

// docker compose recreates containers (new container id, old logs gone) on every
// deploy, so `docker logs` alone can't be relied on after a redeploy. Mirror
// errors to a file on a persistent volume (see LOG_DIR / docker-compose.onprem.yml)
// so an incident from before the last deploy is still reviewable.
const transports: winston.transport[] = [new winston.transports.Console()];
if (process.env.LOG_DIR) {
    transports.push(
        new winston.transports.File({
            filename: path.join(process.env.LOG_DIR, 'error.log'),
            level: 'error',
            maxsize: 10 * 1024 * 1024,
            maxFiles: 5,
        })
    );
}

const logger = winston.createLogger({
    level: process.env.NODE_ENV === 'production' ? 'info' : 'debug',
    format,
    transports,
});

export function logError(message: string, detail?: unknown) {
    logger.error(`${message} ${detail ? String(detail) : ''}`);
}

export default logger;
