import assert from 'node:assert/strict';
import dotenv from 'dotenv';
import mongoose from 'mongoose';
import {
    createOrgRole,
    deleteOrgRole,
    listOrgRoles,
    updateOrgRole,
} from '../controllers/departmentController';
import DepartmentMember from '../models/DepartmentMember';
import OrgRole from '../models/OrgRole';
import User from '../models/User';
import { ORG_ROLE_EDITABLE_PERMISSIONS, PERMISSIONS } from '../types/permissions';
import { permissionsToPlain } from '../utils/permissionsUtil';

dotenv.config();

type Invocation = {
    status: number;
    body: any;
};

async function invoke(handler: any, request: Record<string, unknown>): Promise<Invocation> {
    const result: Invocation = { status: 200, body: undefined };
    const req = {
        user: {
            userId: 'role-permission-test-admin',
            role: 'admin',
            organizationId: request.organizationId,
            permissions: {},
        },
        body: {},
        query: {},
        params: {},
        ...request,
    };
    const res = {
        status(code: number) {
            result.status = code;
            return this;
        },
        json(body: unknown) {
            result.body = body;
            return this;
        },
    };
    const next = (error: unknown) => {
        throw error;
    };

    await handler(req, res, next);
    return result;
}

async function main() {
    const uri = process.env.MONGO_URI || process.env.MONGODB_URI;
    if (!uri) throw new Error('MONGO_URI is required');

    const suffix = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const organizationId = `role_permission_test_org_${suffix}`;
    const roleName = `Permission Test Manager ${suffix}`;
    const userId = `role_permission_test_user_${suffix}`;
    const departmentId = `role_permission_test_dept_${suffix}`;

    await mongoose.connect(uri, { serverSelectionTimeoutMS: 5000 });

    try {
        const initialPermissions = Object.fromEntries(
            ORG_ROLE_EDITABLE_PERMISSIONS.map((key) => [key, false])
        );
        initialPermissions[PERMISSIONS.DOCUMENT_VIEW] = true;
        initialPermissions[PERMISSIONS.PAGE_DASHBOARD] = true;

        const created = await invoke(createOrgRole, {
            organizationId,
            body: {
                name: roleName,
                description: 'Isolated CRUD verification role',
                rank: 3,
                isLeader: false,
                permissions: initialPermissions,
            },
        });
        assert.equal(created.status, 201);
        assert.equal(created.body.data.role.rank, 3);
        assert.equal(created.body.data.role.permissions[PERMISSIONS.PAGE_ACTIVITY], false);
        const roleId = created.body.data.role.roleId as string;

        await User.create({
            userId,
            username: `${userId}@example.test`,
            fullName: 'Role Permission Test User',
            email: `${userId}@example.test`,
            passwordHash: 'not-a-real-password-hash',
            role: 'team',
            organizationId,
            orgRoleId: roleId,
            primaryDepartmentId: departmentId,
            status: 'active',
        });
        await DepartmentMember.create({
            departmentId,
            userId,
            organizationId,
            orgRoleId: roleId,
        });

        const updatedPermissions = {
            ...initialPermissions,
            [PERMISSIONS.PAGE_ACTIVITY]: true,
            [PERMISSIONS.PAGE_DEPARTMENTS]: true,
            [PERMISSIONS.PAGE_PLANS]: true,
            [PERMISSIONS.PAGE_EMAIL_REPORTS]: true,
            [PERMISSIONS.PAGE_INTEGRATIONS]: true,
            [PERMISSIONS.PAGE_SETTINGS]: true,
            [PERMISSIONS.DEPARTMENT_MANAGE]: true,
            [PERMISSIONS.DOCUMENT_SHARE]: true,
        };
        const updated = await invoke(updateOrgRole, {
            organizationId,
            params: { id: roleId },
            body: { rank: 3, permissions: updatedPermissions },
        });
        assert.equal(updated.status, 200);
        assert.equal(updated.body.data.role.permissions[PERMISSIONS.PAGE_ACTIVITY], true);
        assert.equal(updated.body.data.role.permissions[PERMISSIONS.PAGE_SETTINGS], true);
        assert.equal(updated.body.data.role.permissions[PERMISSIONS.DEPARTMENT_MANAGE], false);
        assert.equal(updated.body.data.role.permissions[PERMISSIONS.DEPARTMENT_VIEW], true);

        const savedUser = await User.findOne({ userId }).lean();
        const savedUserPermissions = permissionsToPlain(savedUser?.permissions);
        assert.equal(savedUserPermissions[PERMISSIONS.PAGE_ACTIVITY], true);
        assert.equal(savedUserPermissions[PERMISSIONS.PAGE_DEPARTMENTS], true);
        assert.equal(savedUserPermissions[PERMISSIONS.PAGE_PLANS], true);
        assert.equal(savedUserPermissions[PERMISSIONS.PAGE_EMAIL_REPORTS], true);
        assert.equal(savedUserPermissions[PERMISSIONS.PAGE_INTEGRATIONS], true);
        assert.equal(savedUserPermissions[PERMISSIONS.PAGE_SETTINGS], true);
        assert.equal(savedUserPermissions[PERMISSIONS.DEPARTMENT_MANAGE], false);
        assert.equal(savedUserPermissions[PERMISSIONS.DEPARTMENT_VIEW], true);
        assert.equal(savedUserPermissions[PERMISSIONS.DOCUMENT_SHARE], true);

        const listed = await invoke(listOrgRoles, { organizationId });
        assert.equal(listed.status, 200);
        const listedRole = listed.body.data.roles.find((role: any) => role.roleId === roleId);
        assert.ok(listedRole);
        assert.equal(listedRole.permissions[PERMISSIONS.PAGE_ACTIVITY], true);
        assert.equal(listedRole.permissions[PERMISSIONS.DEPARTMENT_MANAGE], false);

        const rejectedDelete = await invoke(deleteOrgRole, {
            organizationId,
            params: { id: roleId },
        });
        assert.equal(rejectedDelete.status, 400);
        assert.equal(rejectedDelete.body.message, 'Role is assigned to members');

        await DepartmentMember.deleteOne({ organizationId, userId });
        const deleted = await invoke(deleteOrgRole, {
            organizationId,
            params: { id: roleId },
        });
        assert.equal(deleted.status, 200);
        assert.equal(await OrgRole.countDocuments({ roleId }), 0);

        console.log('Role permission CRUD and assigned-user synchronization passed.');
    } finally {
        await DepartmentMember.deleteMany({ organizationId });
        await User.deleteMany({ organizationId });
        await OrgRole.deleteMany({ organizationId });
        await mongoose.disconnect();
    }
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
