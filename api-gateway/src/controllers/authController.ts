import { Request, Response, NextFunction } from 'express';
import bcrypt from 'bcrypt';
import User, { defaultPermissionsForRole } from '../models/User';
import Organization from '../models/Organization';
import openRemoteService from '../services/openRemoteService';
import { generateRefreshToken, generateToken, verifyRefreshToken } from '../utils/jwt';
import logger from '../utils/logger';
import { normalizeTeamPermissions } from '../utils/permissionsUtil';
import { recordActivityAnon, recordActivityFromReq } from '../services/activityLog';

function userPermissionsForResponse(user: { role: string; permissions?: unknown }) {
    if (user.role === 'team') {
        return normalizeTeamPermissions(user.permissions);
    }
    return user.permissions;
}

function generateUserId() {
    return `usr_${Date.now()}_${Math.floor(Math.random() * 10000)}`;
}

function deriveRealm(accountType: string, organizationName?: string) {
    if (accountType === 'enterprise' && organizationName) {
        return organizationName
            .toLowerCase()
            .trim()
            .replace(/[^a-z0-9_]/g, '_')
            .replace(/_+/g, '_')
            .slice(0, 40) || 'enterprise';
    }
    return 'personal';
}

async function buildUniqueUsername(email: string): Promise<string> {
    const base = email.split('@')[0].toLowerCase().replace(/[^a-z0-9_]/g, '_').slice(0, 24) || 'user';
    let candidate = base;
    let i = 0;
    while (await User.findOne({ username: candidate })) {
        i += 1;
        candidate = `${base}_${i}`;
    }
    return candidate;
}

/**
 * Register — OpenRemote user first, then Mongo (same contract as Visibility Live).
 * OTP step omitted for Docs AI scaffold; add later when merging signup flow.
 */
export const register = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const {
            email,
            password,
            fullName,
            contactNumber,
            accountType = 'personal',
            organizationName,
        } = req.body;

        const normalizedEmail = (email || '').toString().trim().toLowerCase();
        if (!normalizedEmail || !password || !fullName) {
            return res.status(400).json({
                success: false,
                message: 'fullName, email and password are required',
            });
        }

        const existingUser = await User.findOne({ email: normalizedEmail });
        if (existingUser) {
            return res.status(409).json({ success: false, message: 'Email already exists' });
        }

        const username = await buildUniqueUsername(normalizedEmail);
        const userRealm = deriveRealm(accountType, organizationName);

        let userRole: 'admin' = 'admin';
        let targetOrganizationId: string | null = null;
        let pendingEnterpriseOrg: any = null;

        if (accountType === 'enterprise') {
            if (!organizationName) {
                return res.status(400).json({
                    success: false,
                    message: 'Organization Name is required for enterprise accounts',
                });
            }
            const orgId = `org_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
            pendingEnterpriseOrg = new Organization({
                organizationId: orgId,
                organizationName,
                contactEmail: normalizedEmail,
                status: 'active',
                subscriptionPlan: 'free',
            });
            targetOrganizationId = orgId;
        }

        const saltRounds = parseInt(process.env.BCRYPT_SALT_ROUNDS || '12');
        const passwordHash = await bcrypt.hash(password, saltRounds);
        const userId = generateUserId();

        const openRemoteEnabled = process.env.OPENREMOTE_ENABLED !== 'false';
        if (!openRemoteEnabled) {
            return res.status(503).json({
                success: false,
                message: 'OpenRemote integration is disabled. Registration is blocked.',
            });
        }

        let openRemoteResult: any;
        try {
            const ensuredRealm = await openRemoteService.ensureRealmExists(
                userRealm,
                accountType === 'enterprise' ? organizationName : 'personal'
            );
            await openRemoteService.retryWithBackoff(async () => {
                openRemoteResult = await openRemoteService.createUser({
                    username,
                    email: normalizedEmail,
                    fullName,
                    role: userRole,
                    realm: ensuredRealm,
                });
            }, 2, 500);
        } catch (error: any) {
            logger.error(`Failed to sync user ${username} to OpenRemote: ${error.message}`);
            return res.status(502).json({
                success: false,
                message: 'Failed to create realm/user in OpenRemote. User was not saved in MongoDB.',
                error: error.message,
            });
        }

        if (pendingEnterpriseOrg) {
            pendingEnterpriseOrg.openRemoteRealm = openRemoteResult?.realm || userRealm;
            await pendingEnterpriseOrg.save();
        }

        const user = new User({
            userId,
            username,
            fullName,
            email: normalizedEmail,
            passwordHash,
            role: userRole,
            accountType,
            contactNumber,
            organizationId: targetOrganizationId,
            permissions: defaultPermissionsForRole(userRole),
            openRemoteRealm: openRemoteResult?.realm || userRealm,
            openRemoteSynced: true,
            openRemoteSyncedAt: new Date(),
            openRemoteUserId: openRemoteResult?.userId,
            openRemoteSecret: openRemoteResult?.openRemoteSecret,
        });
        await user.save();

        const tokenPayload = {
            userId: user.userId,
            username: user.username,
            role: user.role,
            organizationId: user.organizationId,
            realm: user.openRemoteRealm || userRealm,
            openRemoteUserId: user.openRemoteUserId || null,
        };

        res.status(201).json({
            success: true,
            message: 'User registered successfully',
            data: {
                user: {
                    userId: user.userId,
                    username: user.username,
                    email: user.email,
                    fullName: user.fullName,
                    role: user.role,
                    accountType: user.accountType,
                    organizationId: user.organizationId,
                    openRemoteRealm: user.openRemoteRealm,
                    openRemoteUserId: user.openRemoteUserId,
                    permissions: userPermissionsForResponse(user),
                },
                accessToken: generateToken(tokenPayload),
                refreshToken: generateRefreshToken(tokenPayload),
            },
        });
    } catch (error) {
        next(error);
    }
};

export const login = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const identifier = (req.body.identifier || req.body.email || req.body.username || '')
            .toString()
            .trim();
        const password = req.body.password;
        const identifierLower = identifier.toLowerCase();

        if (!identifier || !password) {
            return res.status(400).json({
                success: false,
                message: 'Username or email and password are required',
            });
        }

        const lookupIsEmail = identifierLower.includes('@');
        const user = await User.findOne({
            ...(lookupIsEmail ? { email: identifierLower } : { username: identifierLower }),
            status: { $ne: 'blocked' },
        });

        if (!user) {
            // OpenRemote fallback — create local mirror for service accounts (same as live)
            try {
                const orAuth = await openRemoteService.authenticateUser(identifierLower, password);
                const userId = generateUserId();
                const passwordHash = await bcrypt.hash(password, 12);
                const mirrored = await User.create({
                    userId,
                    username: identifierLower.includes('@')
                        ? identifierLower.split('@')[0]
                        : identifierLower,
                    fullName: identifierLower,
                    email: identifierLower.includes('@')
                        ? identifierLower
                        : `${identifierLower}@openremote.local`,
                    passwordHash,
                    role: 'service_account',
                    accountType: 'personal',
                    openRemoteRealm: orAuth.realm,
                    openRemoteSynced: true,
                    openRemoteSyncedAt: new Date(),
                    status: 'active',
                });

                const tokenPayload = {
                    userId: mirrored.userId,
                    username: mirrored.username,
                    role: mirrored.role,
                    organizationId: null,
                    realm: orAuth.realm,
                    openRemoteUserId: mirrored.openRemoteUserId || null,
                };

                return res.status(200).json({
                    success: true,
                    message: 'Login successful (OpenRemote)',
                    data: {
                        user: {
                            userId: mirrored.userId,
                            username: mirrored.username,
                            email: mirrored.email,
                            fullName: mirrored.fullName,
                            role: 'service_account',
                            accountType: 'personal',
                            organizationId: null,
                            openRemoteRealm: orAuth.realm,
                            realm: orAuth.realm,
                        },
                        accessToken: generateToken(tokenPayload),
                        refreshToken: generateRefreshToken(tokenPayload),
                        openRemoteToken: orAuth.token,
                    },
                });
            } catch {
                return res.status(401).json({
                    success: false,
                    message: 'Invalid username/email or password',
                });
            }
        }

        const match = await bcrypt.compare(password, user.passwordHash);
        if (!match) {
            recordActivityAnon(req, {
                actorUserId: user.userId,
                actorRole: user.role,
                actorEmail: user.email,
                actorName: user.fullName,
                organizationId: user.organizationId ?? null,
                action: 'auth.login',
                category: 'auth',
                outcome: 'failure',
                message: `Failed login for ${user.email}`,
            });
            return res.status(401).json({
                success: false,
                message: 'Invalid username/email or password',
            });
        }

        user.lastLogin = new Date();
        await user.save();

        let openRemoteToken: string | undefined;
        if (user.openRemoteSecret && user.openRemoteRealm && process.env.OPENREMOTE_ENABLED !== 'false') {
            try {
                const orAuth = await openRemoteService.authenticateUser(
                    user.email || user.username,
                    user.openRemoteSecret,
                    user.openRemoteRealm || undefined
                );
                openRemoteToken = orAuth.token;
            } catch (e: any) {
                logger.warn(`OpenRemote token fetch skipped: ${e.message}`);
            }
        }

        const tokenPayload = {
            userId: user.userId,
            username: user.username,
            role: user.role,
            organizationId: user.organizationId ?? null,
            realm: user.openRemoteRealm ?? null,
            openRemoteUserId: user.openRemoteUserId ?? null,
        };

        recordActivityAnon(req, {
            actorUserId: user.userId,
            actorRole: user.role,
            actorEmail: user.email,
            actorName: user.fullName,
            organizationId: user.organizationId ?? null,
            action: 'auth.login',
            category: 'auth',
            outcome: 'success',
            message: `${user.fullName || user.email} signed in`,
        });

        res.status(200).json({
            success: true,
            message: 'Login successful',
            data: {
                user: {
                    userId: user.userId,
                    username: user.username,
                    email: user.email,
                    fullName: user.fullName,
                    role: user.role,
                    accountType: user.accountType,
                    organizationId: user.organizationId,
                    openRemoteRealm: user.openRemoteRealm,
                    openRemoteUserId: user.openRemoteUserId,
                    realm: user.openRemoteRealm,
                    permissions: userPermissionsForResponse(user),
                },
                accessToken: generateToken(tokenPayload),
                refreshToken: generateRefreshToken(tokenPayload),
                ...(openRemoteToken ? { openRemoteToken } : {}),
            },
        });
    } catch (error) {
        next(error);
    }
};

export const refresh = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const refreshToken = req.body.refreshToken || req.body.refresh_token;
        if (!refreshToken) {
            return res.status(400).json({ success: false, message: 'refreshToken is required' });
        }

        const decoded = verifyRefreshToken(refreshToken);
        const user = await User.findOne({ userId: decoded.userId, status: 'active' });
        if (!user) {
            return res.status(401).json({ success: false, message: 'User not found' });
        }

        const tokenPayload = {
            userId: user.userId,
            username: user.username,
            role: user.role,
            organizationId: user.organizationId ?? null,
            realm: user.openRemoteRealm ?? null,
            openRemoteUserId: user.openRemoteUserId ?? null,
        };

        res.json({
            success: true,
            data: {
                accessToken: generateToken(tokenPayload),
                refreshToken: generateRefreshToken(tokenPayload),
            },
        });
    } catch (error) {
        next(error);
    }
};

export const me = async (req: Request, res: Response) => {
    const user = await User.findOne({ userId: req.user.userId }).select('-passwordHash -openRemoteSecret').lean();
    if (!user) {
        res.status(404).json({ success: false, message: 'User not found' });
        return;
    }

    // Run all enrichment lookups in parallel — sequential Atlas round trips
    // were the dominant cost of this endpoint (~2s observed).
    const [orgResult, memberResult] = await Promise.allSettled([
        (async () => {
            if (!user.organizationId) return null;
            const { default: Organization } = await import('../models/Organization');
            const org = await Organization.findOne({ organizationId: user.organizationId }).lean();
            if (!org) return null;
            return {
                organizationId: org.organizationId,
                organizationName: org.organizationName,
                status: org.status,
            };
        })(),
        (async () => {
            const { default: DepartmentMember } = await import('../models/DepartmentMember');
            const membership = await DepartmentMember.findOne({ userId: user.userId }).lean();
            if (!membership) return null;
            const { default: Department } = await import('../models/Department');
            const { default: OrgRole } = await import('../models/OrgRole');
            const [dept, role] = await Promise.all([
                Department.findOne({ departmentId: membership.departmentId }).lean(),
                OrgRole.findOne({ roleId: membership.orgRoleId }).lean(),
            ]);
            return {
                department: dept
                    ? {
                          departmentId: dept.departmentId,
                          name: dept.name,
                          slug: dept.slug,
                          allowedDocumentTypes: dept.allowedDocumentTypes,
                      }
                    : null,
                orgRole: role
                    ? {
                          roleId: role.roleId,
                          name: role.name,
                          isLeader: role.isLeader,
                          rank: typeof role.rank === 'number' ? role.rank : 1,
                      }
                    : null,
            };
        })(),
    ]);

    const organization =
        orgResult.status === 'fulfilled' ? orgResult.value : null;
    const memberData =
        memberResult.status === 'fulfilled' ? memberResult.value : null;
    const department = memberData?.department || null;
    const orgRole = memberData?.orgRole || null;

    res.json({
        success: true,
        data: {
            user: {
                ...user,
                permissions: userPermissionsForResponse(user),
                department,
                orgRole,
                organization,
            },
        },
    });
};

/** PATCH /auth/profile — update display name / contact info for the signed-in user. */
export const updateProfile = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const user = await User.findOne({ userId: req.user.userId });
        if (!user) {
            return res.status(404).json({ success: false, message: 'User not found' });
        }

        const { fullName, contactNumber } = req.body || {};
        const trimmedName = typeof fullName === 'string' ? fullName.trim() : undefined;
        if (trimmedName !== undefined && !trimmedName) {
            return res.status(400).json({ success: false, message: 'Full name cannot be empty' });
        }
        if (trimmedName !== undefined) user.fullName = trimmedName;
        if (typeof contactNumber === 'string') user.contactNumber = contactNumber.trim();

        await user.save();

        recordActivityFromReq(req, {
            action: 'auth.profile_update',
            category: 'auth',
            outcome: 'success',
            message: `${user.fullName || user.email} updated their profile`,
        });

        res.json({
            success: true,
            message: 'Profile updated successfully',
            data: {
                user: {
                    userId: user.userId,
                    username: user.username,
                    email: user.email,
                    fullName: user.fullName,
                    contactNumber: user.contactNumber,
                    role: user.role,
                    accountType: user.accountType,
                    organizationId: user.organizationId,
                    openRemoteRealm: user.openRemoteRealm,
                    openRemoteUserId: user.openRemoteUserId,
                    permissions: userPermissionsForResponse(user),
                },
            },
        });
    } catch (error) {
        next(error);
    }
};

/** POST /auth/change-password — verify current password, set a new hash. */
export const changePassword = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const { currentPassword, newPassword } = req.body || {};
        if (!currentPassword || !newPassword) {
            return res.status(400).json({
                success: false,
                message: 'currentPassword and newPassword are required',
            });
        }
        if (String(newPassword).length < 6) {
            return res.status(400).json({
                success: false,
                message: 'New password must be at least 6 characters',
            });
        }

        const user = await User.findOne({ userId: req.user.userId });
        if (!user) {
            return res.status(404).json({ success: false, message: 'User not found' });
        }

        const match = await bcrypt.compare(currentPassword, user.passwordHash);
        if (!match) {
            recordActivityFromReq(req, {
                action: 'auth.password_change',
                category: 'auth',
                outcome: 'failure',
                message: `Failed password change attempt for ${user.email}`,
            });
            return res.status(400).json({
                success: false,
                message: 'Current password is incorrect',
            });
        }

        const saltRounds = parseInt(process.env.BCRYPT_SALT_ROUNDS || '12');
        user.passwordHash = await bcrypt.hash(String(newPassword), saltRounds);
        await user.save();

        recordActivityFromReq(req, {
            action: 'auth.password_change',
            category: 'auth',
            outcome: 'success',
            message: `${user.fullName || user.email} changed their password`,
        });

        res.json({ success: true, message: 'Password changed successfully' });
    } catch (error) {
        next(error);
    }
};
