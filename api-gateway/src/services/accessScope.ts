import { PERMISSIONS } from '../types/permissions';
import DepartmentMember from '../models/DepartmentMember';
import OrgRole from '../models/OrgRole';
import DocumentShare from '../models/DocumentShare';

export interface AuthUser {
    userId: string;
    role: string;
    organizationId?: string | null;
    permissions?: Record<string, boolean>;
    primaryDepartmentId?: string | null;
    orgRoleId?: string | null;
}

export type DocAccessFields = {
    uploadedBy: string;
    organizationId?: string | null;
    departmentId?: string | null;
    visibilityScope?: 'personal' | 'department' | null;
    uploaderIsLeader?: boolean | null;
    documentId?: string;
};

export type UserDeptContext = {
    departmentId: string | null;
    orgRoleId: string | null;
    isLeader: boolean;
    rank: number;
    /** Documents shared directly with this user (scope='user') */
    sharedDocumentIds: string[];
    /** Department-scoped shares with all_members visibility (visible to all dept members) */
    departmentSharedDocumentIds: string[];
    /** Department-scoped shares with leader_only visibility (visible only to leaders) */
    leaderOnlyDocumentIds: string[];
    /** All-org shares (scope='all', visible to everyone in org) */
    allOrgDocumentIds: string[];
};

export function hasPermission(user: AuthUser, permission: string): boolean {
    if (user.role === 'superAdmin') return true;
    if (user.role === 'admin') return true;
    if (user.permissions?.[permission] === true) return true;
    if (permission === PERMISSIONS.DOCUMENT_PREVIEW) {
        return user.permissions?.[PERMISSIONS.DOCUMENT_VIEW] === true;
    }
    return false;
}

/** Load membership + leader flag + document IDs shared with this user. */
export async function loadUserDeptContext(user: AuthUser): Promise<UserDeptContext> {
    const empty: UserDeptContext = {
        departmentId: null,
        orgRoleId: null,
        isLeader: false,
        rank: 1,
        sharedDocumentIds: [],
        departmentSharedDocumentIds: [],
        leaderOnlyDocumentIds: [],
        allOrgDocumentIds: [],
    };
    if (!user.userId) return empty;

    const membership = await DepartmentMember.findOne({ userId: user.userId }).lean();
    const departmentId =
        membership?.departmentId || user.primaryDepartmentId || null;
    const orgRoleId = membership?.orgRoleId || user.orgRoleId || null;

    let isLeader = false;
    let rank = 1;
    if (orgRoleId) {
        const role = await OrgRole.findOne({ roleId: orgRoleId }).lean();
        isLeader = !!role?.isLeader;
        if (typeof role?.rank === 'number' && role.rank >= 1) rank = role.rank;
    }

    const shareFilter: Record<string, unknown> = {
        $or: [
            { scope: 'user', targetUserIds: user.userId },
            ...(departmentId
                ? [{ scope: 'department', departmentId }]
                : []),
            { scope: 'all' },
        ],
    };
    if (user.organizationId) {
        shareFilter.organizationId = user.organizationId;
    }

    const shares = await DocumentShare.find(shareFilter).select('documentId scope departmentId visibility').lean();

    const sharedDocumentIds: string[] = [];
    const departmentSharedDocumentIds: string[] = [];
    const leaderOnlyDocumentIds: string[] = [];
    const allOrgDocumentIds: string[] = [];

    for (const s of shares) {
        if (s.scope === 'user') {
            sharedDocumentIds.push(s.documentId);
        } else if (s.scope === 'all') {
            allOrgDocumentIds.push(s.documentId);
        } else if (s.scope === 'department') {
            if (s.visibility === 'leader_only') {
                leaderOnlyDocumentIds.push(s.documentId);
            } else {
                departmentSharedDocumentIds.push(s.documentId);
            }
        }
    }

    return {
        departmentId,
        orgRoleId,
        isLeader,
        rank,
        sharedDocumentIds,
        departmentSharedDocumentIds,
        leaderOnlyDocumentIds,
        allOrgDocumentIds,
    };
}

export type SupervisionCheck = {
    allowed: boolean;
    reason?: string;
    viewerDepartmentId: string | null;
    viewerRank: number;
    targetDepartmentId: string | null;
    targetRank: number;
    targetUserId: string;
};

function isOrgAdmin(user: AuthUser): boolean {
    return user.role === 'superAdmin' || user.role === 'admin';
}

/** Resolve membership + role rank for any userId. */
export async function loadMembershipRank(userId: string): Promise<{
    departmentId: string | null;
    orgRoleId: string | null;
    isLeader: boolean;
    rank: number;
    organizationId: string | null;
}> {
    const membership = await DepartmentMember.findOne({ userId }).lean();
    const departmentId = membership?.departmentId || null;
    const orgRoleId = membership?.orgRoleId || null;
    let isLeader = false;
    let rank = 1;
    if (orgRoleId) {
        const role = await OrgRole.findOne({ roleId: orgRoleId }).lean();
        isLeader = !!role?.isLeader;
        if (typeof role?.rank === 'number' && role.rank >= 1) rank = role.rank;
    }
    return {
        departmentId,
        orgRoleId,
        isLeader,
        rank,
        organizationId: membership?.organizationId || null,
    };
}

/**
 * Same-department lower-rank supervision:
 * - admin/superAdmin: org-wide (admin limited to own org)
 * - team: same department AND viewer.rank > target.rank
 */
export async function canSuperviseUser(
    viewer: AuthUser,
    targetUserId: string,
    options?: { departmentId?: string }
): Promise<SupervisionCheck> {
    const targetUserIdNorm = String(targetUserId || '').trim();
    const empty: SupervisionCheck = {
        allowed: false,
        reason: 'Forbidden',
        viewerDepartmentId: null,
        viewerRank: 1,
        targetDepartmentId: null,
        targetRank: 1,
        targetUserId: targetUserIdNorm,
    };
    if (!viewer?.userId || !targetUserIdNorm) return empty;

    if (viewer.userId === targetUserIdNorm) {
        const self = await loadMembershipRank(viewer.userId);
        return {
            allowed: true,
            viewerDepartmentId: self.departmentId,
            viewerRank: self.rank,
            targetDepartmentId: self.departmentId,
            targetRank: self.rank,
            targetUserId: targetUserIdNorm,
        };
    }

    const target = await loadMembershipRank(targetUserIdNorm);
    if (options?.departmentId && target.departmentId && target.departmentId !== options.departmentId) {
        return {
            ...empty,
            targetDepartmentId: target.departmentId,
            targetRank: target.rank,
            reason: 'User is not in this department',
        };
    }

    if (isOrgAdmin(viewer)) {
        if (viewer.role === 'admin' && viewer.organizationId) {
            const User = (await import('../models/User')).default;
            const targetUser = await User.findOne({ userId: targetUserIdNorm })
                .select('organizationId')
                .lean();
            if (!targetUser || targetUser.organizationId !== viewer.organizationId) {
                return {
                    ...empty,
                    targetDepartmentId: target.departmentId,
                    targetRank: target.rank,
                    reason: 'Forbidden',
                };
            }
        }
        return {
            allowed: true,
            viewerDepartmentId: options?.departmentId || target.departmentId,
            viewerRank: 99,
            targetDepartmentId: target.departmentId,
            targetRank: target.rank,
            targetUserId: targetUserIdNorm,
        };
    }

    const viewerCtx = await loadUserDeptContext(viewer);
    if (!viewerCtx.departmentId || !target.departmentId) {
        return {
            ...empty,
            viewerDepartmentId: viewerCtx.departmentId,
            viewerRank: viewerCtx.rank,
            targetDepartmentId: target.departmentId,
            targetRank: target.rank,
            reason: 'No department membership',
        };
    }
    if (viewerCtx.departmentId !== target.departmentId) {
        return {
            ...empty,
            viewerDepartmentId: viewerCtx.departmentId,
            viewerRank: viewerCtx.rank,
            targetDepartmentId: target.departmentId,
            targetRank: target.rank,
            reason: 'Cross-department access denied',
        };
    }
    if (viewerCtx.rank <= target.rank) {
        return {
            allowed: false,
            reason: 'Insufficient rank',
            viewerDepartmentId: viewerCtx.departmentId,
            viewerRank: viewerCtx.rank,
            targetDepartmentId: target.departmentId,
            targetRank: target.rank,
            targetUserId: targetUserIdNorm,
        };
    }

    return {
        allowed: true,
        viewerDepartmentId: viewerCtx.departmentId,
        viewerRank: viewerCtx.rank,
        targetDepartmentId: target.departmentId,
        targetRank: target.rank,
        targetUserId: targetUserIdNorm,
    };
}

/** UserIds a supervisor may inspect in a department (lower rank only). Admins get all members. */
export async function listSupervisableUserIds(
    viewer: AuthUser,
    departmentId: string
): Promise<{ departmentId: string; userIds: string[]; viewerRank: number; isAdmin: boolean }> {
    const members = await DepartmentMember.find({ departmentId }).lean();
    if (!members.length) {
        return { departmentId, userIds: [], viewerRank: 1, isAdmin: isOrgAdmin(viewer) };
    }

    if (isOrgAdmin(viewer)) {
        if (viewer.role === 'admin' && viewer.organizationId) {
            const orgMembers = members.filter((m) => m.organizationId === viewer.organizationId);
            return {
                departmentId,
                userIds: orgMembers.map((m) => m.userId),
                viewerRank: 99,
                isAdmin: true,
            };
        }
        return {
            departmentId,
            userIds: members.map((m) => m.userId),
            viewerRank: 99,
            isAdmin: true,
        };
    }

    const viewerCtx = await loadUserDeptContext(viewer);
    if (!viewerCtx.departmentId || viewerCtx.departmentId !== departmentId) {
        return { departmentId, userIds: [], viewerRank: viewerCtx.rank, isAdmin: false };
    }

    const roleIds = [...new Set(members.map((m) => m.orgRoleId).filter(Boolean))];
    const roles = await OrgRole.find({ roleId: { $in: roleIds } }).lean();
    const rankMap = Object.fromEntries(
        roles.map((r) => [r.roleId, typeof r.rank === 'number' && r.rank >= 1 ? r.rank : 1])
    );

    const userIds = members
        .filter((m) => (rankMap[m.orgRoleId] ?? 1) < viewerCtx.rank)
        .map((m) => m.userId);

    return {
        departmentId,
        userIds,
        viewerRank: viewerCtx.rank,
        isAdmin: false,
    };
}

/**
 * Build Mongo filter for documents the user may access.
 * - Unassigned team users (no dept): own uploads only (legacy)
 * - Dept members: own + peer department docs (non-leader) + shared leader docs
 * - Leaders: own + all department-scoped docs in their dept
 * - Admin with org.documents.view / superAdmin: org-wide / all
 */
export async function buildDocumentFilter(
    user: AuthUser,
    extra: Record<string, unknown> = {},
    options?: {
        organizationId?: string;
        departmentId?: string;
        scope?: 'personal' | 'department' | 'all';
        classification?: string;
        ctx?: UserDeptContext;
    }
): Promise<Record<string, unknown>> {
    const base: Record<string, unknown> = { ...extra };

    if (options?.classification) {
        base.classification = options.classification;
    }

    if (user.role === 'superAdmin') {
        if (options?.organizationId) base.organizationId = options.organizationId;
        if (options?.departmentId) base.departmentId = options.departmentId;
        if (options?.scope === 'personal') base.visibilityScope = 'personal';
        if (options?.scope === 'department') base.visibilityScope = 'department';
        return base;
    }

    if (user.role === 'admin' && hasPermission(user, PERMISSIONS.ORG_DOCUMENTS_VIEW) && user.organizationId) {
        const adminFilter: Record<string, unknown> = {
            ...base,
            organizationId: user.organizationId,
        };
        if (options?.departmentId) adminFilter.departmentId = options.departmentId;
        if (options?.scope === 'personal') adminFilter.visibilityScope = 'personal';
        if (options?.scope === 'department') adminFilter.visibilityScope = 'department';
        return adminFilter;
    }

    const ctx = options?.ctx || (await loadUserDeptContext(user));
    const orClauses: Record<string, unknown>[] = [{ uploadedBy: user.userId }];

    if (ctx.departmentId) {
        // Peer department docs that are not leader-private
        orClauses.push({
            departmentId: ctx.departmentId,
            visibilityScope: 'department',
            uploaderIsLeader: { $ne: true },
        });

        // Leaders see all department-scoped docs in their dept (including other leaders)
        if (ctx.isLeader) {
            orClauses.push({
                departmentId: ctx.departmentId,
                visibilityScope: 'department',
            });
            orClauses.push({
                departmentId: ctx.departmentId,
                visibilityScope: 'personal',
            });
        }

        // Explicit user shares (always visible)
        if (ctx.sharedDocumentIds.length > 0) {
            orClauses.push({ documentId: { $in: ctx.sharedDocumentIds } });
        }

        // Department shares with all_members visibility (visible to all dept members)
        if (ctx.departmentSharedDocumentIds.length > 0) {
            orClauses.push({ documentId: { $in: ctx.departmentSharedDocumentIds } });
        }

        // Department shares with leader_only visibility (visible only to leaders)
        if (ctx.isLeader && ctx.leaderOnlyDocumentIds.length > 0) {
            orClauses.push({ documentId: { $in: ctx.leaderOnlyDocumentIds } });
        }
    }

    // All-org shares (scope='all', visible to everyone in org)
    if (ctx.allOrgDocumentIds.length > 0) {
        orClauses.push({ documentId: { $in: ctx.allOrgDocumentIds } });
    }

    const searchOr = base.$or;
    const { $or: _drop, ...baseRest } = base as { $or?: unknown; [k: string]: unknown };
    const accessClause = { $or: orClauses };

    let filter: Record<string, unknown>;
    if (searchOr) {
        filter = { ...baseRest, $and: [{ $or: searchOr }, accessClause] };
    } else {
        filter = { ...baseRest, ...accessClause };
    }

    // Optional UI filters
    if (options?.scope === 'personal') {
        filter = {
            ...baseRest,
            ...(searchOr ? { $or: searchOr } : {}),
            uploadedBy: user.userId,
            visibilityScope: 'personal',
        };
    } else if (options?.scope === 'department') {
        filter = {
            ...baseRest,
            $and: [
                ...(searchOr ? [{ $or: searchOr }] : []),
                accessClause,
                { visibilityScope: 'department' },
                ...(ctx.departmentId || options?.departmentId
                    ? [{ departmentId: options?.departmentId || ctx.departmentId }]
                    : []),
            ],
        };
    } else if (options?.departmentId) {
        const departmentMatch = { departmentId: options.departmentId };
        const departmentShareMatch =
            ctx.departmentSharedDocumentIds && ctx.departmentSharedDocumentIds.length > 0
                ? { documentId: { $in: ctx.departmentSharedDocumentIds } }
                : undefined;
        const ownDocumentMatch = { uploadedBy: user.userId };

        const departmentFilter = departmentShareMatch
            ? { $or: [departmentMatch, departmentShareMatch, ownDocumentMatch] }
            : { $or: [departmentMatch, ownDocumentMatch] };

        filter = {
            ...baseRest,
            $and: [
                ...(searchOr ? [{ $or: searchOr }] : []),
                accessClause,
                departmentFilter,
            ],
        };
    }

    return filter;
}

export async function canAccessDocument(
    user: AuthUser,
    doc: DocAccessFields,
    ctx?: UserDeptContext
): Promise<boolean> {
    if (user.role === 'superAdmin') return true;
    if (doc.uploadedBy === user.userId) return true;

    if (
        user.role === 'admin' &&
        hasPermission(user, PERMISSIONS.ORG_DOCUMENTS_VIEW) &&
        user.organizationId &&
        doc.organizationId === user.organizationId
    ) {
        return true;
    }

    const deptCtx = ctx || (await loadUserDeptContext(user));
    if (!deptCtx.departmentId) return false;

    // Personal docs of others are only visible to the owner, admins, or leaders in the same department.
    if (doc.visibilityScope === 'personal') {
        if (doc.uploadedBy === user.userId) return true;
        if (user.role === 'admin' && hasPermission(user, PERMISSIONS.ORG_DOCUMENTS_VIEW) && user.organizationId && doc.organizationId === user.organizationId) {
            return true;
        }
        if (deptCtx.isLeader && deptCtx.departmentId && doc.departmentId && doc.departmentId === deptCtx.departmentId) {
            return true;
        }
        return false;
    }

    // Department-scoped in same dept
    if (
        doc.visibilityScope === 'department' &&
        doc.departmentId &&
        doc.departmentId === deptCtx.departmentId
    ) {
        if (deptCtx.isLeader) return true;
        if (!doc.uploaderIsLeader) return true;
        // Leader doc: need share (user-scope or all_members dept-scope)
        if (doc.documentId && (deptCtx.sharedDocumentIds.includes(doc.documentId) || deptCtx.departmentSharedDocumentIds.includes(doc.documentId))) {
            return true;
        }
        return false;
    }

    // Shared explicitly (user-scope, all_members dept-scope, or all-org scope)
    if (doc.documentId && (
        deptCtx.sharedDocumentIds.includes(doc.documentId) ||
        deptCtx.departmentSharedDocumentIds.includes(doc.documentId) ||
        deptCtx.allOrgDocumentIds.includes(doc.documentId)
    )) {
        return true;
    }

    // Leader-only shares (only leaders can access)
    if (doc.documentId && deptCtx.isLeader && deptCtx.leaderOnlyDocumentIds.includes(doc.documentId)) {
        return true;
    }

    return false;
}

/**
 * Delete rules:
 * - employee (team, non-leader): own uploads only — shared docs cannot be deleted
 * - leader: own uploads + uploads by anyone in their department
 * - admin / superAdmin: any document in scope (admin = own org)
 */
export async function canDeleteDocument(
    user: AuthUser,
    doc: {
        uploadedBy: string;
        organizationId?: string | null;
        departmentId?: string | null;
    },
    options?: {
        ctx?: UserDeptContext;
        /** Preloaded dept member userIds for leaders (bulk delete) */
        deptMemberIds?: Set<string> | string[];
    }
): Promise<boolean> {
    if (user.role === 'superAdmin') return true;
    if (!hasPermission(user, PERMISSIONS.DOCUMENT_DELETE)) return false;

    if (user.role === 'admin') {
        if (
            user.organizationId &&
            doc.organizationId &&
            doc.organizationId !== user.organizationId
        ) {
            return false;
        }
        return true;
    }

    // Own uploads — always allowed (employee or leader)
    if (doc.uploadedBy === user.userId) return true;

    const ctx = options?.ctx ?? (await loadUserDeptContext(user));
    if (ctx.isLeader && ctx.departmentId) {
        if (options?.deptMemberIds) {
            const set =
                options.deptMemberIds instanceof Set
                    ? options.deptMemberIds
                    : new Set(options.deptMemberIds);
            return set.has(doc.uploadedBy);
        }
        const member = await DepartmentMember.findOne({
            departmentId: ctx.departmentId,
            userId: doc.uploadedBy,
        })
            .select('userId')
            .lean();
        return !!member;
    }

    // Regular employee: shared / peer / leader docs are view-only — not deletable
    return false;
}

/** UserIds whose uploads a leader may delete (self + all dept members). */
export async function getLeaderDeletableUploaderIds(
    user: AuthUser,
    ctx?: UserDeptContext
): Promise<string[]> {
    const deptCtx = ctx ?? (await loadUserDeptContext(user));
    if (!deptCtx.isLeader || !deptCtx.departmentId) {
        return [user.userId];
    }
    const ids = await DepartmentMember.find({ departmentId: deptCtx.departmentId })
        .distinct('userId');
    if (!ids.includes(user.userId)) ids.push(user.userId);
    return ids;
}

export async function isUserLeader(userId: string, orgRoleId?: string | null): Promise<boolean> {
    const roleId = orgRoleId;
    if (!roleId) {
        const membership = await DepartmentMember.findOne({ userId }).lean();
        if (!membership?.orgRoleId) return false;
        const role = await OrgRole.findOne({ roleId: membership.orgRoleId }).lean();
        return !!role?.isLeader;
    }
    const role = await OrgRole.findOne({ roleId }).lean();
    return !!role?.isLeader;
}
