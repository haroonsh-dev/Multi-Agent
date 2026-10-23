import { Request, Response, NextFunction } from 'express';
import ActivityLog from '../models/ActivityLog';
import User from '../models/User';
import { canSuperviseUser, listSupervisableUserIds, loadUserDeptContext } from '../services/accessScope';

/**
 * Visibility:
 * - team (no subordinates): own activity only
 * - team supervisor (higher rank): own + same-dept lower-rank subordinates
 * - admin: own org (self + team members)
 * - superAdmin: own + all admins + all team members (platform)
 */
async function buildActorFilter(user: any): Promise<Record<string, unknown>> {
    if (!user) return { actorUserId: '__none__' };

    if (user.role === 'team') {
        const ctx = await loadUserDeptContext(user);
        if (ctx.departmentId && ctx.rank > 1) {
            const supervision = await listSupervisableUserIds(user, ctx.departmentId);
            const ids = [...new Set([user.userId, ...supervision.userIds])];
            return { actorUserId: { $in: ids } };
        }
        return { actorUserId: user.userId };
    }

    if (user.role === 'admin') {
        if (!user.organizationId) {
            return { actorUserId: user.userId };
        }
        return { organizationId: user.organizationId };
    }

    if (user.role === 'superAdmin') {
        return {
            $or: [
                { actorUserId: user.userId },
                { actorRole: { $in: ['admin', 'team'] } },
            ],
        };
    }

    return { actorUserId: user.userId };
}

export const listActivity = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const page = Math.max(1, parseInt(String(req.query.page || '1'), 10) || 1);
        const limit = Math.min(100, Math.max(1, parseInt(String(req.query.limit || '30'), 10) || 30));
        const skip = (page - 1) * limit;

        const category = (req.query.category as string)?.trim();
        const action = (req.query.action as string)?.trim();
        const actorUserId = (req.query.actorUserId as string)?.trim();
        const q = (req.query.q as string)?.trim();
        const organizationId = (req.query.organizationId as string)?.trim();

        const scope = await buildActorFilter(req.user);
        const filter: Record<string, unknown> = { ...scope };

        const andParts: Record<string, unknown>[] = [];
        if ((scope as any).$or) {
            andParts.push({ $or: (scope as any).$or });
            delete (filter as any).$or;
        }

        if (category) andParts.push({ category });
        if (action) andParts.push({ action });
        if (actorUserId) {
            if (req.user.role === 'team' && actorUserId !== req.user.userId) {
                const check = await canSuperviseUser(req.user, actorUserId);
                if (!check.allowed) {
                    return res.status(403).json({ success: false, message: check.reason || 'Forbidden' });
                }
            }
            andParts.push({ actorUserId });
        }
        if (organizationId && req.user.role === 'superAdmin') {
            andParts.push({ organizationId });
        }
        if (q) {
            const rx = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
            andParts.push({
                $or: [
                    { message: rx },
                    { actorEmail: rx },
                    { actorName: rx },
                    { action: rx },
                    { resourceId: rx },
                ],
            });
        }

        const finalFilter =
            andParts.length === 0
                ? filter
                : Object.keys(filter).length
                  ? { $and: [filter, ...andParts] }
                  : andParts.length === 1
                    ? andParts[0]
                    : { $and: andParts };

        const [logs, total] = await Promise.all([
            ActivityLog.find(finalFilter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
            ActivityLog.countDocuments(finalFilter),
        ]);

        const missingIds = [
            ...new Set(
                logs
                    .filter((l) => !l.actorName && l.actorUserId)
                    .map((l) => l.actorUserId)
            ),
        ];
        let nameMap = new Map<string, string>();
        if (missingIds.length) {
            const users = await User.find({ userId: { $in: missingIds } })
                .select('userId fullName email')
                .lean();
            nameMap = new Map(users.map((u) => [u.userId, u.fullName || u.email]));
        }

        const data = logs.map((l) => ({
            ...l,
            actorName: l.actorName || nameMap.get(l.actorUserId) || l.actorEmail || l.actorUserId,
        }));

        res.json({
            success: true,
            data: {
                logs: data,
                total,
                page,
                limit,
                totalPages: Math.max(1, Math.ceil(total / limit)),
            },
        });
    } catch (error) {
        next(error);
    }
};

/** Team members / admins list for filter dropdown (scoped). */
export const listActivityActors = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const role = req.user.role;

        if (role === 'team') {
            const ctx = await loadUserDeptContext(req.user);
            const self = {
                userId: req.user.userId,
                fullName: req.user.username || req.user.email,
                email: req.user.email,
                role: 'team',
            };
            if (!ctx.departmentId || ctx.rank <= 1) {
                return res.json({ success: true, data: { actors: [self] } });
            }
            const supervision = await listSupervisableUserIds(req.user, ctx.departmentId);
            const subordinateIds = supervision.userIds.filter((id) => id !== req.user.userId);
            if (!subordinateIds.length) {
                return res.json({ success: true, data: { actors: [self] } });
            }
            const users = await User.find({ userId: { $in: subordinateIds } })
                .select('userId fullName email role')
                .sort({ fullName: 1 })
                .lean();
            return res.json({
                success: true,
                data: {
                    actors: [
                        self,
                        ...users.map((u) => ({
                            userId: u.userId,
                            fullName: u.fullName,
                            email: u.email,
                            role: u.role,
                        })),
                    ],
                },
            });
        }

        if (role === 'admin') {
            if (!req.user.organizationId) {
                return res.json({ success: true, data: { actors: [] } });
            }
            const users = await User.find({
                organizationId: req.user.organizationId,
                role: { $in: ['admin', 'team'] },
            })
                .select('userId fullName email role')
                .sort({ fullName: 1 })
                .lean();
            return res.json({ success: true, data: { actors: users } });
        }

        const users = await User.find({
            role: { $in: ['admin', 'team', 'superAdmin'] },
        })
            .select('userId fullName email role organizationId')
            .sort({ role: 1, fullName: 1 })
            .limit(500)
            .lean();

        res.json({ success: true, data: { actors: users } });
    } catch (error) {
        next(error);
    }
};
