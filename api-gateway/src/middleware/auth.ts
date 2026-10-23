import { Request, Response, NextFunction } from 'express';
import { verifyAccessToken } from '../utils/jwt';
import User from '../models/User';
import logger, { logError } from '../utils/logger';
import { hasPermission } from '../services/accessScope';
import { normalizeTeamPermissions, permissionsToPlain } from '../utils/permissionsUtil';

declare global {
    namespace Express {
        interface Request {
            user?: any;
        }
    }
}

export const authenticate = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const authHeader = req.headers.authorization;
        const queryToken = req.query?.token as string;
        const token = authHeader?.startsWith('Bearer ')
            ? authHeader.substring(7)
            : queryToken?.trim() || null;

        if (!token) {
            return res.status(401).json({
                success: false,
                message: 'No token provided. Use Authorization: Bearer <token>.',
            });
        }

        const decoded = verifyAccessToken(token);
        const user = await User.findOne({ userId: decoded.userId, status: 'active' });

        if (!user) {
            return res.status(401).json({
                success: false,
                message: 'User not found or inactive',
            });
        }

        const plainPerms = permissionsToPlain(user.permissions);
        const permissions =
            user.role === 'team' ? normalizeTeamPermissions(plainPerms) : plainPerms;

        req.user = {
            userId: user.userId,
            username: user.username,
            email: user.email,
            role: user.role,
            organizationId: user.organizationId,
            permissions,
            primaryDepartmentId: user.primaryDepartmentId || null,
            orgRoleId: user.orgRoleId || null,
            openRemoteRealm: user.openRemoteRealm || null,
            realm: user.openRemoteRealm || null,
            openRemoteUserId: user.openRemoteUserId || null,
            openRemoteSecret: user.openRemoteSecret || null,
            accountType: user.accountType,
        };

        next();
    } catch (error: any) {
        logError('Authentication middleware error:', error.stack || error.message);
        logger.error('Authentication error:', error.message);
        return res.status(401).json({
            success: false,
            message: 'Invalid or expired token',
            // Never echo the underlying error to the client — it can leak
            // internals (DB names, paths, stack traces). Log it instead.
            ...(process.env.NODE_ENV !== 'production' && { detail: String(error?.message || '') }),
        });
    }
};

export const authorize =
    (...roles: string[]) =>
    (req: Request, res: Response, next: NextFunction) => {
        if (!req.user || (roles.length && !roles.includes(req.user.role))) {
            return res.status(403).json({ success: false, message: 'Forbidden' });
        }
        next();
    };

export const requirePermission =
    (permission: string) =>
    (req: Request, res: Response, next: NextFunction) => {
        if (!req.user || !hasPermission(req.user, permission)) {
            return res.status(403).json({ success: false, message: `Missing permission: ${permission}` });
        }
        next();
    };
