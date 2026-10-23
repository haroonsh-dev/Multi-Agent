import { v4 as uuidv4 } from 'uuid';
import OrgRole from '../models/OrgRole';
import DepartmentMember from '../models/DepartmentMember';
import User from '../models/User';
import {
    ALL_PERMISSIONS,
    DEFAULT_EMPLOYEE_PERMISSIONS,
    DEFAULT_LEADER_PERMISSIONS,
    DEFAULT_MANAGER_PERMISSIONS,
    PERMISSIONS,
    PermissionKey,
} from '../types/permissions';
import { applyOrgRolePermissions, permissionsToPlain } from '../utils/permissionsUtil';

const DEFAULTS = [
    {
        name: 'Employee',
        description: 'Department member — dashboard, documents, and chat',
        isLeader: false,
        rank: 1,
        permissions: DEFAULT_EMPLOYEE_PERMISSIONS,
    },
    {
        name: 'Leader',
        description: 'Department head — private uploads until shared; activity + departments',
        isLeader: true,
        rank: 2,
        permissions: DEFAULT_LEADER_PERMISSIONS,
    },
    {
        name: 'Manager',
        description: 'Above leader — manage department membership and broader document visibility',
        isLeader: false,
        rank: 3,
        permissions: DEFAULT_MANAGER_PERMISSIONS,
    },
];

function fillMissingPermissionKeys(
    existing: Record<string, unknown> | undefined,
    defaults: Record<PermissionKey, boolean>
): { perms: Record<string, boolean>; changed: boolean } {
    const perms: Record<string, boolean> = {};
    let changed = false;
    for (const key of ALL_PERMISSIONS) {
        const cur = existing?.[key];
        if (typeof cur === 'boolean') {
            perms[key] = cur;
        } else {
            perms[key] = defaults[key] === true;
            changed = true;
        }
    }
    perms[PERMISSIONS.DOCUMENT_PREVIEW] = perms[PERMISSIONS.DOCUMENT_VIEW] === true;
    return { perms, changed };
}

async function syncRolePermissionsToAssignedUsers(roleId: string, rolePermissions: unknown) {
    const members = await DepartmentMember.find({ orgRoleId: roleId }).lean();
    for (const m of members) {
        const user = await User.findOne({ userId: m.userId, role: 'team' });
        if (!user) continue;
        user.permissions = applyOrgRolePermissions(user.permissions, rolePermissions) as any;
        await user.save();
    }
}

/** Idempotent seed + upgrade of Leader / Employee / Manager for an organization. */
export async function ensureDefaultOrgRoles(organizationId: string): Promise<void> {
    if (!organizationId) return;
    for (const def of DEFAULTS) {
        const existing = await OrgRole.findOne({ organizationId, name: def.name });
        if (!existing) {
            const perms = { ...def.permissions };
            perms[PERMISSIONS.DOCUMENT_PREVIEW] = perms[PERMISSIONS.DOCUMENT_VIEW];
            await OrgRole.create({
                roleId: `role_${uuidv4()}`,
                organizationId,
                name: def.name,
                description: def.description,
                permissions: perms,
                rank: def.rank,
                isLeader: def.isLeader,
                isSystem: true,
            });
            continue;
        }

        // Upgrade: fill missing page/feature keys and rank without overwriting set booleans
        const { perms, changed } = fillMissingPermissionKeys(
            permissionsToPlain(existing.permissions),
            def.permissions
        );
        let dirty = changed;
        if (existing.rank == null || Number(existing.rank) < 1) {
            existing.rank = def.rank;
            dirty = true;
        }
        if (dirty) {
            existing.permissions = perms as any;
            if (!existing.description && def.description) {
                existing.description = def.description;
            }
            await existing.save();
            await syncRolePermissionsToAssignedUsers(existing.roleId, existing.permissions);
        }
    }
}
