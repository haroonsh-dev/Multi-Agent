import { Request, Response, NextFunction } from 'express';
import { v4 as uuidv4 } from 'uuid';
import Department from '../models/Department';
import OrgRole from '../models/OrgRole';
import DepartmentMember from '../models/DepartmentMember';
import Document from '../models/Document';
import DocumentShare from '../models/DocumentShare';
import User from '../models/User';
import { PERMISSIONS, ORG_ROLE_EDITABLE_PERMISSIONS } from '../types/permissions';
import { hasPermission, loadUserDeptContext, canAccessDocument, canSuperviseUser, listSupervisableUserIds } from '../services/accessScope';
import { documentTypesForAgents, normalizeDocumentTypesToOrgPlan } from '../services/documentStorage';
import { getOrgEntitlement, normalizeAgentsToOrgPlan } from '../services/planService';
import { recordActivityFromReq } from '../services/activityLog';
import { ensureDefaultOrgRoles } from '../services/orgRoleSeed';
import { permissionsToPlain, applyOrgRolePermissions, resetToDefaultTeamPermissions } from '../utils/permissionsUtil';
import ActivityLog from '../models/ActivityLog';

function orgRoleForResponse(role: any) {
    const plain = typeof role?.toObject === 'function' ? role.toObject() : role;
    return {
        ...plain,
        permissions: permissionsToPlain(plain?.permissions),
    };
}

function slugify(name: string): string {
    return name
        .toLowerCase()
        .trim()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '')
        .slice(0, 64) || `dept-${Date.now()}`;
}

function requireOrg(req: Request): string | null {
    if (req.user.role === 'superAdmin') {
        return (req.query.organizationId as string) || req.body?.organizationId || req.user.organizationId || null;
    }
    return req.user.organizationId || null;
}

function canManageDepartments(req: Request): boolean {
    return (
        req.user.role === 'superAdmin' ||
        req.user.role === 'admin' ||
        hasPermission(req.user, PERMISSIONS.DEPARTMENT_MANAGE)
    );
}

function canViewDepartments(req: Request): boolean {
    if (req.user.role === 'admin' || req.user.role === 'superAdmin') return true;
    return (
        hasPermission(req.user, PERMISSIONS.PAGE_DEPARTMENTS) &&
        hasPermission(req.user, PERMISSIONS.DEPARTMENT_VIEW)
    );
}

// Router-level guards, mirroring the pattern in routes/team.ts and
// routes/superAdmin.ts (authorize()/requirePermission() middleware). Every
// mutating handler below already calls canManageDepartments() itself, so this
// is defense-in-depth — a route that forgets the in-handler check is still
// blocked here — rather than a new restriction.
export const requireDepartmentManage = (req: Request, res: Response, next: NextFunction) => {
    if (!canManageDepartments(req)) return res.status(403).json({ success: false, message: 'Forbidden' });
    next();
};
export const requireDepartmentView = (req: Request, res: Response, next: NextFunction) => {
    if (!canViewDepartments(req)) return res.status(403).json({ success: false, message: 'Forbidden' });
    next();
};

// ── Departments ──────────────────────────────────────────────

export const listDepartments = async (req: Request, res: Response, next: NextFunction) => {
    try {
        if (!canViewDepartments(req)) {
            return res.status(403).json({ success: false, message: 'Forbidden' });
        }
        const orgId = requireOrg(req);
        if (!orgId && req.user.role !== 'superAdmin') {
            return res.status(400).json({ success: false, message: 'organizationId required' });
        }

        const filter: Record<string, unknown> = { status: { $ne: 'inactive' } };
        if (orgId) filter.organizationId = orgId;

        // Non-admin team: only their department
        if (req.user.role === 'team' && !canManageDepartments(req)) {
            const ctx = await loadUserDeptContext(req.user);
            if (!ctx.departmentId) {
                return res.json({ success: true, data: { departments: [] } });
            }
            filter.departmentId = ctx.departmentId;
        }

        const departments = await Department.find(filter).sort({ name: 1 }).lean();
        const ids = departments.map((d) => d.departmentId);
        const memberCounts = await DepartmentMember.aggregate([
            { $match: { departmentId: { $in: ids } } },
            { $group: { _id: '$departmentId', count: { $sum: 1 } } },
        ]);
        const countMap = Object.fromEntries(memberCounts.map((m) => [m._id, m.count]));

        // Org hub only offers document types / agents included in the org plan
        const orgEntitlement = orgId
            ? await getOrgEntitlement(orgId)
            : { agentIds: [] as string[] };
        const orgAgentIds = orgEntitlement.agentIds?.length
            ? orgEntitlement.agentIds
            : ['other_agent'];
        const planDocumentTypes = documentTypesForAgents(orgAgentIds);

        res.json({
            success: true,
            data: {
                departments: departments.map((d) => ({
                    ...d,
                    memberCount: countMap[d.departmentId] || 0,
                    // Surface only agents still on the org plan (stale ids hidden)
                    allowedAgents: (d.allowedAgents || []).filter((a: string) =>
                        orgAgentIds.includes(a)
                    ),
                    allowedDocumentTypes: (d.allowedDocumentTypes || []).filter((t: string) =>
                        planDocumentTypes.includes(t)
                    ),
                })),
                knownDocumentTypes: planDocumentTypes,
                orgAgentIds,
            },
        });
    } catch (error) {
        next(error);
    }
};

export const createDepartment = async (req: Request, res: Response, next: NextFunction) => {
    try {
        if (!canManageDepartments(req)) {
            return res.status(403).json({ success: false, message: 'Forbidden' });
        }
        const orgId = requireOrg(req);
        if (!orgId) {
            return res.status(400).json({ success: false, message: 'organizationId required' });
        }

        const { name, description, allowedDocumentTypes, allowedAgents } = req.body || {};
        if (!name || !String(name).trim()) {
            return res.status(400).json({ success: false, message: 'name is required' });
        }

        await ensureDefaultOrgRoles(orgId);

        const orgEntitlement = await getOrgEntitlement(orgId);
        const deptAgentIds = normalizeAgentsToOrgPlan(allowedAgents, orgEntitlement.agentIds);

        const departmentId = `dept_${uuidv4()}`;
        let slug = slugify(String(name));
        const existingSlug = await Department.findOne({ organizationId: orgId, slug });
        if (existingSlug) slug = `${slug}-${Date.now().toString(36)}`;

        const types = normalizeDocumentTypesToOrgPlan(
            allowedDocumentTypes,
            orgEntitlement.agentIds
        );

        const dept = await Department.create({
            departmentId,
            organizationId: orgId,
            name: String(name).trim(),
            slug,
            description: description ? String(description) : '',
            allowedDocumentTypes: types,
            allowedAgents: deptAgentIds,
            createdBy: req.user.userId,
        });

        recordActivityFromReq(req, {
            action: 'department.create',
            category: 'department',
            resourceType: 'department',
            resourceId: departmentId,
            message: `Created department ${dept.name}`,
        });

        res.status(201).json({ success: true, data: { department: dept } });
    } catch (error) {
        next(error);
    }
};

export const updateDepartment = async (req: Request, res: Response, next: NextFunction) => {
    try {
        if (!canManageDepartments(req)) {
            return res.status(403).json({ success: false, message: 'Forbidden' });
        }
        const orgId = requireOrg(req);
        const dept = await Department.findOne({ departmentId: req.params.id });
        if (!dept) return res.status(404).json({ success: false, message: 'Department not found' });
        if (orgId && dept.organizationId !== orgId && req.user.role !== 'superAdmin') {
            return res.status(403).json({ success: false, message: 'Forbidden' });
        }

        const { name, description, allowedDocumentTypes, allowedAgents, status } = req.body || {};
        if (name) dept.name = String(name).trim();
        if (description !== undefined) dept.description = String(description);
        if (Array.isArray(allowedDocumentTypes) || allowedAgents !== undefined) {
            const orgEntitlement = await getOrgEntitlement(dept.organizationId);
            if (Array.isArray(allowedDocumentTypes)) {
                dept.allowedDocumentTypes = normalizeDocumentTypesToOrgPlan(
                    allowedDocumentTypes,
                    orgEntitlement.agentIds
                );
            }
            if (allowedAgents !== undefined) {
                dept.allowedAgents = normalizeAgentsToOrgPlan(allowedAgents, orgEntitlement.agentIds);
            }
        }
        if (status === 'active' || status === 'inactive') dept.status = status;
        await dept.save();

        res.json({ success: true, data: { department: dept } });
    } catch (error) {
        next(error);
    }
};

export const deleteDepartment = async (req: Request, res: Response, next: NextFunction) => {
    try {
        if (!canManageDepartments(req)) {
            return res.status(403).json({ success: false, message: 'Forbidden' });
        }
        const orgId = requireOrg(req);
        const dept = await Department.findOne({ departmentId: req.params.id });
        if (!dept) return res.status(404).json({ success: false, message: 'Department not found' });
        if (orgId && dept.organizationId !== orgId && req.user.role !== 'superAdmin') {
            return res.status(403).json({ success: false, message: 'Forbidden' });
        }

        await DepartmentMember.deleteMany({ departmentId: dept.departmentId });
        const affectedUsers = await User.find({
            primaryDepartmentId: dept.departmentId,
            role: 'team',
        });
        for (const user of affectedUsers) {
            user.primaryDepartmentId = null;
            user.orgRoleId = null;
            user.permissions = resetToDefaultTeamPermissions() as any;
            await user.save();
        }
        await Document.updateMany(
            { departmentId: dept.departmentId },
            { $set: { departmentId: null, visibilityScope: 'personal', uploaderIsLeader: false } }
        );
        await Department.deleteOne({ departmentId: dept.departmentId });

        recordActivityFromReq(req, {
            action: 'department.delete',
            category: 'department',
            resourceType: 'department',
            resourceId: dept.departmentId,
            message: `Deleted department ${dept.name}`,
        });

        res.json({ success: true, message: 'Department deleted' });
    } catch (error) {
        next(error);
    }
};

export const getDepartmentOverview = async (req: Request, res: Response, next: NextFunction) => {
    try {
        if (!canViewDepartments(req)) {
            return res.status(403).json({ success: false, message: 'Forbidden' });
        }
        const dept = await Department.findOne({ departmentId: req.params.id }).lean();
        if (!dept) return res.status(404).json({ success: false, message: 'Department not found' });

        if (req.user.role === 'team' && !canManageDepartments(req)) {
            const ctx = await loadUserDeptContext(req.user);
            if (ctx.departmentId !== dept.departmentId) {
                return res.status(403).json({ success: false, message: 'Forbidden' });
            }
        } else if (
            req.user.role === 'admin' &&
            req.user.organizationId &&
            dept.organizationId !== req.user.organizationId
        ) {
            return res.status(403).json({ success: false, message: 'Forbidden' });
        }

        const members = await DepartmentMember.find({ departmentId: dept.departmentId }).lean();
        const userIds = members.map((m) => m.userId);
        const roleIds = [...new Set(members.map((m) => m.orgRoleId))];
        const [users, roles] = await Promise.all([
            User.find({ userId: { $in: userIds } }).select('-passwordHash -openRemoteSecret').lean(),
            OrgRole.find({ roleId: { $in: roleIds } }).lean(),
        ]);
        const userMap = Object.fromEntries(users.map((u) => [u.userId, u]));
        const roleMap = Object.fromEntries(roles.map((r) => [r.roleId, r]));

        const classification = ((req.query.classification as string) || '').trim();
        const uploadedBy = ((req.query.uploadedBy as string) || '').trim();

        // Non-leaders shouldn't see unshared leader docs in overview either
        const ctx = await loadUserDeptContext(req.user);
        const isAdmin =
            req.user.role === 'superAdmin' ||
            (req.user.role === 'admin' && hasPermission(req.user, PERMISSIONS.ORG_DOCUMENTS_VIEW));

        // Build document filter: admins and leaders should also see documents uploaded by any member
        let docFilter: Record<string, unknown> = {
            departmentId: dept.departmentId,
            visibilityScope: 'department',
        };
        if (isAdmin || ctx.isLeader) {
            docFilter = {
                $or: [
                    { departmentId: dept.departmentId },
                    { uploadedBy: { $in: userIds } },
                ],
            };
        }
        if (classification) docFilter.classification = classification;
        if (uploadedBy) docFilter.uploadedBy = uploadedBy;

        let documents = await Document.find(docFilter).sort({ createdAt: -1 }).limit(200).lean();
        if (!isAdmin && !ctx.isLeader) {
            documents = documents.filter(
                (d) =>
                    !d.uploaderIsLeader ||
                    d.uploadedBy === req.user.userId ||
                    ctx.sharedDocumentIds.includes(d.documentId)
            );
        }

        const typeCounts: Record<string, number> = {};
        for (const d of documents) {
            const t = d.classification || 'other';
            typeCounts[t] = (typeCounts[t] || 0) + 1;
        }

        const memberRows = members.map((m) => {
            const role = roleMap[m.orgRoleId];
            return {
                ...m,
                user: userMap[m.userId] || null,
                role: role
                    ? {
                          roleId: role.roleId,
                          name: role.name,
                          isLeader: role.isLeader,
                          rank: typeof role.rank === 'number' ? role.rank : 1,
                      }
                    : null,
            };
        });

        const leaders = memberRows.filter((m) => m.role?.isLeader);
        const supervision = await listSupervisableUserIds(req.user, dept.departmentId);
        const supervisableSet = new Set(supervision.userIds);
        const supervisableMembers = memberRows
            .filter((m) => supervisableSet.has(m.userId) && m.userId !== req.user.userId)
            .map((m) => ({
                ...m,
                canOversee: true,
            }));

        res.json({
            success: true,
            data: {
                department: dept,
                members: memberRows,
                leaders,
                documents,
                typeCounts,
                supervision: {
                    viewerRank: supervision.viewerRank,
                    isAdmin: supervision.isAdmin,
                    supervisableUserIds: supervision.userIds.filter((id) => id !== req.user.userId),
                    supervisableMembers,
                },
            },
        });
    } catch (error) {
        next(error);
    }
};

// ── Members ──────────────────────────────────────────────────

export const addDepartmentMember = async (req: Request, res: Response, next: NextFunction) => {
    try {
        if (!canManageDepartments(req)) {
            return res.status(403).json({ success: false, message: 'Forbidden' });
        }
        const { userId, orgRoleId } = req.body || {};
        if (!userId || !orgRoleId) {
            return res.status(400).json({ success: false, message: 'userId and orgRoleId are required' });
        }

        const dept = await Department.findOne({ departmentId: req.params.id });
        if (!dept) return res.status(404).json({ success: false, message: 'Department not found' });

        const user = await User.findOne({ userId });
        if (!user) return res.status(404).json({ success: false, message: 'User not found' });
        if (user.organizationId !== dept.organizationId) {
            return res.status(400).json({ success: false, message: 'User must belong to the same organization' });
        }

        const role = await OrgRole.findOne({ roleId: orgRoleId, organizationId: dept.organizationId });
        if (!role) return res.status(404).json({ success: false, message: 'Role not found' });

        // v1: one department per user — remove prior membership
        await DepartmentMember.deleteMany({ userId });

        const membership = await DepartmentMember.create({
            departmentId: dept.departmentId,
            userId,
            organizationId: dept.organizationId,
            orgRoleId,
        });

        user.primaryDepartmentId = dept.departmentId;
        user.orgRoleId = orgRoleId;
        // Merge role permissions onto user (keep account-level admin overrides)
        if (user.role === 'team') {
            user.permissions = applyOrgRolePermissions(user.permissions, role.permissions) as any;
        }
        await user.save();

        recordActivityFromReq(req, {
            action: 'department.member.add',
            category: 'department',
            resourceType: 'department',
            resourceId: dept.departmentId,
            message: `Added ${user.fullName || userId} to ${dept.name} as ${role.name}`,
            metadata: { userId, orgRoleId },
        });

        res.status(201).json({ success: true, data: { membership } });
    } catch (error) {
        next(error);
    }
};

export const removeDepartmentMember = async (req: Request, res: Response, next: NextFunction) => {
    try {
        if (!canManageDepartments(req)) {
            return res.status(403).json({ success: false, message: 'Forbidden' });
        }
        const { userId } = req.params;
        const dept = await Department.findOne({ departmentId: req.params.id });
        if (!dept) return res.status(404).json({ success: false, message: 'Department not found' });

        await DepartmentMember.deleteOne({ departmentId: dept.departmentId, userId });
        const user = await User.findOne({ userId, primaryDepartmentId: dept.departmentId });
        if (user) {
            user.primaryDepartmentId = null;
            user.orgRoleId = null;
            if (user.role === 'team') {
                user.permissions = resetToDefaultTeamPermissions() as any;
            }
            await user.save();
        }

        recordActivityFromReq(req, {
            action: 'department.member.remove',
            category: 'department',
            resourceType: 'department',
            resourceId: dept.departmentId,
            message: `Removed member ${userId} from ${dept.name}`,
            metadata: { userId },
        });

        res.json({ success: true, message: 'Member removed' });
    } catch (error) {
        next(error);
    }
};

// ── Supervisor oversight ─────────────────────────────────────

export const listDepartmentSubordinates = async (req: Request, res: Response, next: NextFunction) => {
    try {
        if (!canViewDepartments(req)) {
            return res.status(403).json({ success: false, message: 'Forbidden' });
        }
        const dept = await Department.findOne({ departmentId: req.params.id }).lean();
        if (!dept) return res.status(404).json({ success: false, message: 'Department not found' });

        if (req.user.role === 'team' && !canManageDepartments(req)) {
            const ctx = await loadUserDeptContext(req.user);
            if (ctx.departmentId !== dept.departmentId) {
                return res.status(403).json({ success: false, message: 'Forbidden' });
            }
        } else if (
            req.user.role === 'admin' &&
            req.user.organizationId &&
            dept.organizationId !== req.user.organizationId
        ) {
            return res.status(403).json({ success: false, message: 'Forbidden' });
        }

        const supervision = await listSupervisableUserIds(req.user, dept.departmentId);
        const userIds = supervision.userIds.filter((id) => id !== req.user.userId);
        if (!userIds.length) {
            return res.json({
                success: true,
                data: {
                    department: {
                        departmentId: dept.departmentId,
                        name: dept.name,
                    },
                    viewerRank: supervision.viewerRank,
                    isAdmin: supervision.isAdmin,
                    members: [],
                },
            });
        }

        const memberships = await DepartmentMember.find({
            departmentId: dept.departmentId,
            userId: { $in: userIds },
        }).lean();
        const roleIds = [...new Set(memberships.map((m) => m.orgRoleId))];
        const [users, roles, docAgg, activityAgg] = await Promise.all([
            User.find({ userId: { $in: userIds } })
                .select('userId fullName email status lastLogin createdAt permissions orgRoleId primaryDepartmentId')
                .lean(),
            OrgRole.find({ roleId: { $in: roleIds } }).lean(),
            Document.aggregate([
                { $match: { uploadedBy: { $in: userIds } } },
                {
                    $group: {
                        _id: '$uploadedBy',
                        total: { $sum: 1 },
                        ready: {
                            $sum: {
                                $cond: [{ $in: ['$status', ['ready', 'processed', 'completed']] }, 1, 0],
                            },
                        },
                        processing: {
                            $sum: {
                                $cond: [{ $in: ['$status', ['processing', 'uploaded', 'queued']] }, 1, 0],
                            },
                        },
                        failed: {
                            $sum: { $cond: [{ $eq: ['$status', 'failed'] }, 1, 0] },
                        },
                    },
                },
            ]),
            ActivityLog.aggregate([
                { $match: { actorUserId: { $in: userIds } } },
                { $group: { _id: '$actorUserId', total: { $sum: 1 } } },
            ]),
        ]);

        const userMap = Object.fromEntries(users.map((u) => [u.userId, u]));
        const roleMap = Object.fromEntries(roles.map((r) => [r.roleId, r]));
        const docMap = Object.fromEntries(docAgg.map((d) => [d._id, d]));
        const activityMap = Object.fromEntries(activityAgg.map((a) => [a._id, a.total]));

        const members = memberships
            .map((m) => {
                const user = userMap[m.userId];
                const role = roleMap[m.orgRoleId];
                const docs = docMap[m.userId] || { total: 0, ready: 0, processing: 0, failed: 0 };
                return {
                    userId: m.userId,
                    joinedAt: m.joinedAt,
                    fullName: user?.fullName || m.userId,
                    email: user?.email || '',
                    status: user?.status || 'active',
                    lastLogin: user?.lastLogin || null,
                    createdAt: user?.createdAt || null,
                    role: role
                        ? {
                              roleId: role.roleId,
                              name: role.name,
                              isLeader: !!role.isLeader,
                              rank: typeof role.rank === 'number' ? role.rank : 1,
                          }
                        : null,
                    documentCounts: {
                        total: docs.total || 0,
                        ready: docs.ready || 0,
                        processing: docs.processing || 0,
                        failed: docs.failed || 0,
                    },
                    activityCount: activityMap[m.userId] || 0,
                };
            })
            .sort((a, b) => a.fullName.localeCompare(b.fullName));

        res.json({
            success: true,
            data: {
                department: {
                    departmentId: dept.departmentId,
                    name: dept.name,
                },
                viewerRank: supervision.viewerRank,
                isAdmin: supervision.isAdmin,
                members,
            },
        });
    } catch (error) {
        next(error);
    }
};

export const getDepartmentMemberDetail = async (req: Request, res: Response, next: NextFunction) => {
    try {
        if (!canViewDepartments(req)) {
            return res.status(403).json({ success: false, message: 'Forbidden' });
        }
        const departmentId = String(req.params.id || '');
        const targetUserId = String(req.params.userId || '');
        const dept = await Department.findOne({ departmentId }).lean();
        if (!dept) return res.status(404).json({ success: false, message: 'Department not found' });

        if (req.user.role === 'team' && !canManageDepartments(req)) {
            const ctx = await loadUserDeptContext(req.user);
            if (ctx.departmentId !== dept.departmentId) {
                return res.status(403).json({ success: false, message: 'Forbidden' });
            }
        } else if (
            req.user.role === 'admin' &&
            req.user.organizationId &&
            dept.organizationId !== req.user.organizationId
        ) {
            return res.status(403).json({ success: false, message: 'Forbidden' });
        }

        const check = await canSuperviseUser(req.user, targetUserId, { departmentId });
        if (!check.allowed || check.targetDepartmentId !== departmentId) {
            return res.status(403).json({
                success: false,
                message: check.reason || 'Forbidden',
            });
        }

        const membership = await DepartmentMember.findOne({ departmentId, userId: targetUserId }).lean();
        if (!membership) {
            return res.status(404).json({ success: false, message: 'Member not found in department' });
        }

        const [user, role, recentActivity, docCounts] = await Promise.all([
            User.findOne({ userId: targetUserId })
                .select('-passwordHash -openRemoteSecret')
                .lean(),
            OrgRole.findOne({ roleId: membership.orgRoleId }).lean(),
            ActivityLog.find({ actorUserId: targetUserId })
                .sort({ createdAt: -1 })
                .limit(8)
                .lean(),
            Document.aggregate([
                { $match: { uploadedBy: targetUserId } },
                {
                    $group: {
                        _id: null,
                        total: { $sum: 1 },
                        ready: {
                            $sum: {
                                $cond: [{ $in: ['$status', ['ready', 'processed', 'completed']] }, 1, 0],
                            },
                        },
                        processing: {
                            $sum: {
                                $cond: [{ $in: ['$status', ['processing', 'uploaded', 'queued']] }, 1, 0],
                            },
                        },
                        failed: {
                            $sum: { $cond: [{ $eq: ['$status', 'failed'] }, 1, 0] },
                        },
                    },
                },
            ]),
        ]);

        if (!user) return res.status(404).json({ success: false, message: 'User not found' });

        const counts = docCounts[0] || { total: 0, ready: 0, processing: 0, failed: 0 };
        const activityTotal = await ActivityLog.countDocuments({ actorUserId: targetUserId });

        res.json({
            success: true,
            data: {
                department: {
                    departmentId: dept.departmentId,
                    name: dept.name,
                    description: dept.description || '',
                },
                member: {
                    userId: user.userId,
                    fullName: user.fullName,
                    email: user.email,
                    status: user.status,
                    lastLogin: user.lastLogin || null,
                    createdAt: user.createdAt,
                    joinedAt: membership.joinedAt,
                    permissions: permissionsToPlain(user.permissions),
                    role: role
                        ? {
                              roleId: role.roleId,
                              name: role.name,
                              description: role.description || '',
                              isLeader: !!role.isLeader,
                              rank: typeof role.rank === 'number' ? role.rank : 1,
                              permissions: permissionsToPlain(role.permissions),
                          }
                        : null,
                },
                aggregates: {
                    documents: {
                        total: counts.total || 0,
                        ready: counts.ready || 0,
                        processing: counts.processing || 0,
                        failed: counts.failed || 0,
                    },
                    activityTotal,
                },
                recentActivity,
                supervision: {
                    viewerRank: check.viewerRank,
                    targetRank: check.targetRank,
                },
            },
        });
    } catch (error) {
        next(error);
    }
};

// ── Org Roles ────────────────────────────────────────────────

export const listOrgRoles = async (req: Request, res: Response, next: NextFunction) => {
    try {
        if (!canViewDepartments(req)) {
            return res.status(403).json({ success: false, message: 'Forbidden' });
        }
        const orgId = requireOrg(req);
        if (!orgId) {
            return res.status(400).json({ success: false, message: 'organizationId required' });
        }
        await ensureDefaultOrgRoles(orgId);
        const roles = await OrgRole.find({ organizationId: orgId }).sort({ name: 1 }).lean();
        res.json({
            success: true,
            data: {
                roles: roles.map(orgRoleForResponse),
                editablePermissions: ORG_ROLE_EDITABLE_PERMISSIONS,
            },
        });
    } catch (error) {
        next(error);
    }
};

export const createOrgRole = async (req: Request, res: Response, next: NextFunction) => {
    try {
        if (!canManageDepartments(req)) {
            return res.status(403).json({ success: false, message: 'Forbidden' });
        }
        const orgId = requireOrg(req);
        if (!orgId) {
            return res.status(400).json({ success: false, message: 'organizationId required' });
        }
        const { name, description, permissions, isLeader, rank } = req.body || {};
        if (!name || !String(name).trim()) {
            return res.status(400).json({ success: false, message: 'name is required' });
        }

        const roleId = `role_${uuidv4()}`;
        const perms: Record<string, boolean> = {};
        for (const key of ORG_ROLE_EDITABLE_PERMISSIONS) {
            perms[key] = permissions?.[key] === true;
        }
        perms[PERMISSIONS.DOCUMENT_PREVIEW] = perms[PERMISSIONS.DOCUMENT_VIEW] === true;
        perms[PERMISSIONS.DEPARTMENT_VIEW] = perms[PERMISSIONS.PAGE_DEPARTMENTS] === true;
        perms[PERMISSIONS.DEPARTMENT_MANAGE] = false;

        const role = await OrgRole.create({
            roleId,
            organizationId: orgId,
            name: String(name).trim(),
            description: description ? String(description) : '',
            permissions: perms,
            rank: Math.max(1, Math.min(99, Number(rank) || 1)),
            isLeader: !!isLeader,
            isSystem: false,
        });

        res.status(201).json({ success: true, data: { role: orgRoleForResponse(role) } });
    } catch (error) {
        next(error);
    }
};

export const updateOrgRole = async (req: Request, res: Response, next: NextFunction) => {
    try {
        if (!canManageDepartments(req)) {
            return res.status(403).json({ success: false, message: 'Forbidden' });
        }
        const orgId = requireOrg(req);
        const role = await OrgRole.findOne({ roleId: req.params.id });
        if (!role) return res.status(404).json({ success: false, message: 'Role not found' });
        if (orgId && role.organizationId !== orgId && req.user.role !== 'superAdmin') {
            return res.status(403).json({ success: false, message: 'Forbidden' });
        }

        const { name, description, permissions, isLeader, rank } = req.body || {};
        if (name) role.name = String(name).trim();
        if (description !== undefined) role.description = String(description);
        if (typeof isLeader === 'boolean') role.isLeader = isLeader;
        if (rank !== undefined) {
            role.rank = Math.max(1, Math.min(99, Number(rank) || 1));
        }
        if (permissions && typeof permissions === 'object') {
            const perms = permissionsToPlain(role.permissions);
            for (const key of ORG_ROLE_EDITABLE_PERMISSIONS) {
                if (typeof permissions[key] === 'boolean') perms[key] = permissions[key];
            }
            perms[PERMISSIONS.DOCUMENT_PREVIEW] = perms[PERMISSIONS.DOCUMENT_VIEW] === true;
            perms[PERMISSIONS.DEPARTMENT_VIEW] = perms[PERMISSIONS.PAGE_DEPARTMENTS] === true;
            perms[PERMISSIONS.DEPARTMENT_MANAGE] = false;
            role.permissions = perms;
        }
        await role.save();

        // Sync role permissions onto assigned team users
        if (permissions && typeof permissions === 'object') {
            const members = await DepartmentMember.find({ orgRoleId: role.roleId }).lean();
            for (const m of members) {
                const user = await User.findOne({ userId: m.userId, role: 'team' });
                if (!user) continue;
                user.permissions = applyOrgRolePermissions(user.permissions, role.permissions) as any;
                await user.save();
            }
        }

        res.json({ success: true, data: { role: orgRoleForResponse(role) } });
    } catch (error) {
        next(error);
    }
};

export const deleteOrgRole = async (req: Request, res: Response, next: NextFunction) => {
    try {
        if (!canManageDepartments(req)) {
            return res.status(403).json({ success: false, message: 'Forbidden' });
        }
        const role = await OrgRole.findOne({ roleId: req.params.id });
        if (!role) return res.status(404).json({ success: false, message: 'Role not found' });
        if (role.isSystem) {
            return res.status(400).json({ success: false, message: 'Cannot delete system roles' });
        }
        const inUse = await DepartmentMember.countDocuments({ orgRoleId: role.roleId });
        if (inUse > 0) {
            return res.status(400).json({ success: false, message: 'Role is assigned to members' });
        }
        await OrgRole.deleteOne({ roleId: role.roleId });
        res.json({ success: true, message: 'Role deleted' });
    } catch (error) {
        next(error);
    }
};

// ── Document shares ──────────────────────────────────────────

/**
 * Share a document.
 *
 * Body:
 *   scope: 'user' | 'department' | 'all'
 *   targetUserIds?: string[]      – required when scope='user'
 *   departmentId?: string         – required when scope='department' (cross-department)
 *   visibility?: 'leader_only' | 'all_members'  – default 'all_members'
 *
 * Behaviour:
 *   - scope='user'         → shares with specific users (employee → own dept peers)
 *   - scope='department'   → shares with a department
 *       • same dept        → visibility defaults to 'all_members'
 *       • cross dept       → visibility defaults to 'leader_only' (only that dept's leader)
 *   - scope='all'          → shares with everyone in the org
 *
 * Each call is additive: previous shares are NOT removed.
 * A new share with the same (document, scope, departmentId) replaces the old one.
 */
export const shareDocument = async (req: Request, res: Response, next: NextFunction) => {
    try {
        // Permission check: must have document.share OR be a leader
        if (!hasPermission(req.user, PERMISSIONS.DOCUMENT_SHARE) && req.user.role === 'team') {
            const ctx = await loadUserDeptContext(req.user);
            if (!ctx.isLeader) {
                return res.status(403).json({ success: false, message: 'Forbidden' });
            }
        }

        const doc = await Document.findOne({ documentId: req.params.id });
        if (!doc) return res.status(404).json({ success: false, message: 'Document not found' });

        // Only the uploader, admin, or superAdmin can share
        if (doc.uploadedBy !== req.user.userId && req.user.role !== 'admin' && req.user.role !== 'superAdmin') {
            return res.status(403).json({ success: false, message: 'Only the uploader can share this document' });
        }
        if (!(await canAccessDocument(req.user, doc))) {
            return res.status(403).json({ success: false, message: 'Forbidden' });
        }

        const { scope, targetUserIds, departmentId, visibility } = req.body || {};
        if (scope !== 'user' && scope !== 'department' && scope !== 'all') {
            return res.status(400).json({ success: false, message: 'scope must be user, department, or all' });
        }

        const orgId = doc.organizationId || req.user.organizationId || '';

        // Load current user's dept context to determine same vs cross dept
        const myCtx = await loadUserDeptContext(req.user);

        if (scope === 'user') {
            // ── Scope: user ──────────────────────────────────
            // Employees can only share with own dept peers
            const users = Array.isArray(targetUserIds) ? targetUserIds : [];
            if (users.length === 0) {
                return res.status(400).json({ success: false, message: 'targetUserIds is required for scope=user' });
            }

            // Employees: validate all targets are in the same department
            if (req.user.role === 'team' && !myCtx.isLeader && !hasPermission(req.user, PERMISSIONS.DOCUMENT_SHARE)) {
                const members = await DepartmentMember.find({
                    userId: { $in: users },
                    departmentId: myCtx.departmentId,
                }).lean();
                if (members.length !== users.length) {
                    return res.status(403).json({ success: false, message: 'Employees can only share with members of their own department' });
                }
            }

            // Remove existing user-scope shares for this doc by this sharer, then create new ones
            await DocumentShare.deleteMany({ documentId: doc.documentId, sharedBy: req.user.userId, scope: 'user' });

            const share = await DocumentShare.create({
                shareId: `share_${uuidv4()}`,
                documentId: doc.documentId,
                sharedBy: req.user.userId,
                organizationId: orgId,
                scope: 'user',
                targetUserIds: users,
                visibility: 'all_members',
            });

            recordActivityFromReq(req, {
                action: 'document.share',
                category: 'document',
                resourceType: 'document',
                resourceId: doc.documentId,
                message: `Shared ${doc.originalFilename} with ${users.length} user(s)`,
                metadata: { scope: 'user', targetUserIds: users },
            });

            return res.status(201).json({ success: true, data: { share } });
        }

        if (scope === 'department') {
            // ── Scope: department ──────────────────────────────
            const targetDeptId = departmentId || doc.departmentId;
            if (!targetDeptId) {
                return res.status(400).json({ success: false, message: 'departmentId is required' });
            }

            const targetDept = await Department.findOne({ departmentId: targetDeptId }).lean();
            if (!targetDept) {
                return res.status(404).json({ success: false, message: 'Target department not found' });
            }

            // Determine same-dept vs cross-dept
            const isSameDept = myCtx.departmentId === targetDeptId;

            // Cross-department: employees cannot share to other departments
            if (!isSameDept && req.user.role === 'team' && !myCtx.isLeader) {
                return res.status(403).json({ success: false, message: 'Employees cannot share documents to other departments' });
            }

            // Determine visibility: cross-department defaults to leader_only
            const finalVisibility = visibility === 'leader_only' || visibility === 'all_members'
                ? visibility
                : (isSameDept ? 'all_members' : 'leader_only');

            // Remove existing department-scope share for this doc+dept by this sharer, then create
            await DocumentShare.deleteMany({
                documentId: doc.documentId,
                sharedBy: req.user.userId,
                scope: 'department',
                departmentId: targetDeptId,
            });

            const share = await DocumentShare.create({
                shareId: `share_${uuidv4()}`,
                documentId: doc.documentId,
                sharedBy: req.user.userId,
                organizationId: orgId,
                scope: 'department',
                departmentId: targetDeptId,
                visibility: finalVisibility,
            });

            recordActivityFromReq(req, {
                action: 'document.share',
                category: 'document',
                resourceType: 'document',
                resourceId: doc.documentId,
                message: `Shared ${doc.originalFilename} with department ${targetDept.name} (${finalVisibility})`,
                metadata: { scope: 'department', departmentId: targetDeptId, visibility: finalVisibility },
            });

            return res.status(201).json({ success: true, data: { share } });
        }

        // ── Scope: all ──────────────────────────────────────
        if (scope === 'all') {
            // Only leaders, managers, admins can share to everyone
            if (req.user.role === 'team' && !myCtx.isLeader && !hasPermission(req.user, PERMISSIONS.DOCUMENT_SHARE)) {
                return res.status(403).json({ success: false, message: 'Only leaders can share with everyone' });
            }

            // Remove existing all-scope share for this doc by this sharer
            await DocumentShare.deleteMany({ documentId: doc.documentId, sharedBy: req.user.userId, scope: 'all' });

            const share = await DocumentShare.create({
                shareId: `share_${uuidv4()}`,
                documentId: doc.documentId,
                sharedBy: req.user.userId,
                organizationId: orgId,
                scope: 'all',
                visibility: 'all_members',
            });

            recordActivityFromReq(req, {
                action: 'document.share',
                category: 'document',
                resourceType: 'document',
                resourceId: doc.documentId,
                message: `Shared ${doc.originalFilename} with everyone`,
                metadata: { scope: 'all' },
            });

            return res.status(201).json({ success: true, data: { share } });
        }
    } catch (error) {
        next(error);
    }
};

/**
 * Unshare a document.
 *
 * Query params (all optional):
 *   scope         – 'user' | 'department' | 'all'
 *   departmentId  – target department (required when scope='department')
 *   targetUserId  – target user (required when scope='user')
 *
 * If no params → removes ALL shares by the current user (backward compat).
 */
export const unshareDocument = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const doc = await Document.findOne({ documentId: req.params.id });
        if (!doc) return res.status(404).json({ success: false, message: 'Document not found' });
        if (doc.uploadedBy !== req.user.userId && req.user.role !== 'admin' && req.user.role !== 'superAdmin') {
            return res.status(403).json({ success: false, message: 'Forbidden' });
        }

        const { scope, departmentId, targetUserId } = req.query || {};

        const filter: Record<string, unknown> = { documentId: doc.documentId, sharedBy: req.user.userId };

        if (scope === 'user' && targetUserId) {
            filter.scope = 'user';
            // Remove specific user from targetUserIds; delete record if empty
            const share = await DocumentShare.findOne(filter).lean();
            if (share) {
                const remaining = (share.targetUserIds || []).filter((id) => id !== targetUserId);
                if (remaining.length > 0) {
                    await DocumentShare.updateOne({ _id: share._id }, { $set: { targetUserIds: remaining } });
                } else {
                    await DocumentShare.deleteOne({ _id: share._id });
                }
            }
            return res.json({ success: true, message: 'Share removed' });
        }

        if (scope === 'department' && departmentId) {
            filter.scope = 'department';
            filter.departmentId = departmentId;
            await DocumentShare.deleteOne(filter);
            return res.json({ success: true, message: 'Share removed' });
        }

        if (scope === 'all') {
            filter.scope = 'all';
            await DocumentShare.deleteOne(filter);
            return res.json({ success: true, message: 'Share removed' });
        }

        // Fallback: remove all shares by this user for this document
        await DocumentShare.deleteMany({ documentId: doc.documentId, sharedBy: req.user.userId });
        res.json({ success: true, message: 'All shares removed' });
    } catch (error) {
        next(error);
    }
};

export const listDocumentShares = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const doc = await Document.findOne({ documentId: req.params.id }).lean();
        if (!doc) return res.status(404).json({ success: false, message: 'Document not found' });
        if (!(await canAccessDocument(req.user, doc))) {
            return res.status(403).json({ success: false, message: 'Forbidden' });
        }
        const shares = await DocumentShare.find({ documentId: doc.documentId }).lean();

        // Enrich with department names and user names
        const enriched = await Promise.all(
            shares.map(async (s) => {
                let departmentName: string | null = null;
                let targetUserNames: string[] = [];

                if (s.departmentId) {
                    const dept = await Department.findOne({ departmentId: s.departmentId }).lean();
                    departmentName = dept?.name || null;
                }
                if (s.targetUserIds && s.targetUserIds.length > 0) {
                    const users = await User.find({ userId: { $in: s.targetUserIds } })
                        .select('userId fullName')
                        .lean();
                    targetUserNames = s.targetUserIds.map(
                        (uid) => users.find((u) => u.userId === uid)?.fullName || uid
                    );
                }

                return {
                    ...s,
                    departmentName,
                    targetUserNames,
                };
            })
        );

        res.json({ success: true, data: { shares: enriched } });
    } catch (error) {
        next(error);
    }
};
