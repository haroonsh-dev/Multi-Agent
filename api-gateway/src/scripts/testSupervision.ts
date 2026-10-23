import assert from 'node:assert/strict';
import dotenv from 'dotenv';
import mongoose from 'mongoose';
import { canSuperviseUser, listSupervisableUserIds } from '../services/accessScope';
import Department from '../models/Department';
import DepartmentMember from '../models/DepartmentMember';
import OrgRole from '../models/OrgRole';
import User from '../models/User';
import {
    DEFAULT_EMPLOYEE_PERMISSIONS,
    DEFAULT_LEADER_PERMISSIONS,
    DEFAULT_MANAGER_PERMISSIONS,
} from '../types/permissions';

dotenv.config();

async function main() {
    const uri = process.env.MONGO_URI || process.env.MONGODB_URI;
    if (!uri) throw new Error('MONGO_URI is required');

    const suffix = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const organizationId = `supervision_test_org_${suffix}`;
    const departmentId = `supervision_test_dept_${suffix}`;
    const otherDeptId = `supervision_test_dept_other_${suffix}`;

    const employeeRoleId = `role_emp_${suffix}`;
    const leaderRoleId = `role_leader_${suffix}`;
    const managerRoleId = `role_manager_${suffix}`;

    const employeeId = `user_emp_${suffix}`;
    const peerEmployeeId = `user_emp2_${suffix}`;
    const leaderId = `user_leader_${suffix}`;
    const managerId = `user_manager_${suffix}`;
    const otherDeptEmployeeId = `user_other_${suffix}`;
    const adminId = `user_admin_${suffix}`;

    await mongoose.connect(uri, { serverSelectionTimeoutMS: 5000 });

    try {
        await OrgRole.create([
            {
                roleId: employeeRoleId,
                organizationId,
                name: `Employee ${suffix}`,
                permissions: DEFAULT_EMPLOYEE_PERMISSIONS,
                rank: 1,
                isLeader: false,
                isSystem: false,
            },
            {
                roleId: leaderRoleId,
                organizationId,
                name: `Leader ${suffix}`,
                permissions: DEFAULT_LEADER_PERMISSIONS,
                rank: 2,
                isLeader: true,
                isSystem: false,
            },
            {
                roleId: managerRoleId,
                organizationId,
                name: `Manager ${suffix}`,
                permissions: DEFAULT_MANAGER_PERMISSIONS,
                rank: 3,
                isLeader: false,
                isSystem: false,
            },
        ]);

        await Department.create([
            {
                departmentId,
                organizationId,
                name: `Supervision Dept ${suffix}`,
                slug: `supervision-${suffix}`,
                status: 'active',
                allowedDocumentTypes: [],
                createdBy: adminId,
            },
            {
                departmentId: otherDeptId,
                organizationId,
                name: `Other Dept ${suffix}`,
                slug: `other-${suffix}`,
                status: 'active',
                allowedDocumentTypes: [],
                createdBy: adminId,
            },
        ]);

        const mkUser = (userId: string, role: 'team' | 'admin', orgRoleId?: string, dept?: string) =>
            User.create({
                userId,
                username: `${userId}@example.test`,
                fullName: userId,
                email: `${userId}@example.test`,
                passwordHash: 'not-a-real-password-hash',
                role,
                organizationId,
                orgRoleId: orgRoleId || null,
                primaryDepartmentId: dept || null,
                status: 'active',
            });

        await Promise.all([
            mkUser(employeeId, 'team', employeeRoleId, departmentId),
            mkUser(peerEmployeeId, 'team', employeeRoleId, departmentId),
            mkUser(leaderId, 'team', leaderRoleId, departmentId),
            mkUser(managerId, 'team', managerRoleId, departmentId),
            mkUser(otherDeptEmployeeId, 'team', employeeRoleId, otherDeptId),
            mkUser(adminId, 'admin'),
        ]);

        await DepartmentMember.create([
            { departmentId, userId: employeeId, organizationId, orgRoleId: employeeRoleId },
            { departmentId, userId: peerEmployeeId, organizationId, orgRoleId: employeeRoleId },
            { departmentId, userId: leaderId, organizationId, orgRoleId: leaderRoleId },
            { departmentId, userId: managerId, organizationId, orgRoleId: managerRoleId },
            {
                departmentId: otherDeptId,
                userId: otherDeptEmployeeId,
                organizationId,
                orgRoleId: employeeRoleId,
            },
        ]);

        const employeeViewer = {
            userId: employeeId,
            role: 'team',
            organizationId,
            orgRoleId: employeeRoleId,
            primaryDepartmentId: departmentId,
        };
        const leaderViewer = {
            userId: leaderId,
            role: 'team',
            organizationId,
            orgRoleId: leaderRoleId,
            primaryDepartmentId: departmentId,
        };
        const managerViewer = {
            userId: managerId,
            role: 'team',
            organizationId,
            orgRoleId: managerRoleId,
            primaryDepartmentId: departmentId,
        };
        const adminViewer = {
            userId: adminId,
            role: 'admin',
            organizationId,
        };

        // Employee cannot inspect peer
        const peerDenied = await canSuperviseUser(employeeViewer, peerEmployeeId);
        assert.equal(peerDenied.allowed, false);

        // Leader can inspect employee, not peer leader, not other dept
        const leaderOk = await canSuperviseUser(leaderViewer, employeeId);
        assert.equal(leaderOk.allowed, true);
        const leaderPeer = await canSuperviseUser(leaderViewer, managerId);
        assert.equal(leaderPeer.allowed, false);
        const leaderCross = await canSuperviseUser(leaderViewer, otherDeptEmployeeId);
        assert.equal(leaderCross.allowed, false);

        // Manager can inspect employee and leader
        const managerEmp = await canSuperviseUser(managerViewer, employeeId);
        assert.equal(managerEmp.allowed, true);
        const managerLeader = await canSuperviseUser(managerViewer, leaderId);
        assert.equal(managerLeader.allowed, true);

        const leaderRoster = await listSupervisableUserIds(leaderViewer, departmentId);
        assert.ok(leaderRoster.userIds.includes(employeeId));
        assert.ok(leaderRoster.userIds.includes(peerEmployeeId));
        assert.equal(leaderRoster.userIds.includes(managerId), false);

        const managerRoster = await listSupervisableUserIds(managerViewer, departmentId);
        assert.ok(managerRoster.userIds.includes(employeeId));
        assert.ok(managerRoster.userIds.includes(leaderId));
        assert.equal(managerRoster.userIds.includes(managerId), false);

        const adminRoster = await listSupervisableUserIds(adminViewer, departmentId);
        assert.ok(adminRoster.userIds.includes(managerId));
        assert.ok(adminRoster.isAdmin);

        console.log('Supervision hierarchy checks passed.');
    } finally {
        await DepartmentMember.deleteMany({ organizationId });
        await Department.deleteMany({ organizationId });
        await OrgRole.deleteMany({ organizationId });
        await User.deleteMany({ organizationId });
        await mongoose.disconnect();
    }
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
