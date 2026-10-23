import { Request } from 'express';
import ActivityLog, { ActivityCategory, ActivityOutcome } from '../models/ActivityLog';
import logger from '../utils/logger';

export type RecordActivityInput = {
    actorUserId: string;
    actorRole: string;
    actorEmail?: string | null;
    actorName?: string | null;
    organizationId?: string | null;
    action: string;
    category: ActivityCategory;
    resourceType?: string | null;
    resourceId?: string | null;
    outcome?: ActivityOutcome;
    message?: string | null;
    metadata?: Record<string, unknown>;
    ip?: string | null;
    userAgent?: string | null;
};

function generateLogId() {
    return `act_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

function clientMeta(req?: Request) {
    if (!req) return { ip: null as string | null, userAgent: null as string | null };
    const forwarded = req.headers['x-forwarded-for'];
    const ip =
        (typeof forwarded === 'string' ? forwarded.split(',')[0]?.trim() : undefined) ||
        req.ip ||
        null;
    const userAgent = (req.headers['user-agent'] as string) || null;
    return { ip, userAgent };
}

/** Fire-and-forget activity write — never throws to callers. */
export async function recordActivity(input: RecordActivityInput): Promise<void> {
    try {
        await ActivityLog.create({
            logId: generateLogId(),
            organizationId: input.organizationId ?? null,
            actorUserId: input.actorUserId,
            actorRole: input.actorRole,
            actorEmail: input.actorEmail ?? null,
            actorName: input.actorName ?? null,
            action: input.action,
            category: input.category,
            resourceType: input.resourceType ?? null,
            resourceId: input.resourceId ?? null,
            outcome: input.outcome || 'success',
            message: input.message ?? null,
            metadata: input.metadata || {},
            ip: input.ip ?? null,
            userAgent: input.userAgent ?? null,
        });
    } catch (err: any) {
        logger.warn(`Activity log write failed: ${err?.message || err}`);
    }
}

/** Convenience: pull actor from authenticated req.user */
export function recordActivityFromReq(
    req: Request,
    partial: Omit<
        RecordActivityInput,
        'actorUserId' | 'actorRole' | 'actorEmail' | 'organizationId' | 'ip' | 'userAgent'
    > & { actorName?: string | null }
): void {
    const user = req.user;
    if (!user?.userId) return;
    const { ip, userAgent } = clientMeta(req);
    void recordActivity({
        actorUserId: user.userId,
        actorRole: user.role,
        actorEmail: user.email,
        actorName: partial.actorName || user.username || user.email || null,
        organizationId: user.organizationId ?? null,
        ip,
        userAgent,
        ...partial,
    });
}

export function recordActivityAnon(
    req: Request,
    partial: Omit<RecordActivityInput, 'ip' | 'userAgent'>
): void {
    const { ip, userAgent } = clientMeta(req);
    void recordActivity({ ...partial, ip, userAgent });
}
