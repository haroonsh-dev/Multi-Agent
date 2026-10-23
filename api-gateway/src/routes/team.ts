import { Router } from 'express';
import { authenticate, authorize, requirePermission } from '../middleware/auth';
import {
    createMember,
    deleteMember,
    listMembers,
    updateMember,
    updateMemberPermissions,
    updateMemberStatus,
} from '../controllers/teamController';
import { PERMISSIONS } from '../types/permissions';

const router = Router();

router.use(authenticate);
// superAdmin can manage any org's team members (see teamController's org-scoping:
// admin is pinned to req.user.organizationId, superAdmin must pass ?organizationId=
// for list/create and is otherwise unscoped by org on the by-id routes).
router.use(authorize('admin', 'superAdmin'));
router.use(requirePermission(PERMISSIONS.TEAM_MANAGE));

router.get('/members', listMembers);
router.post('/members', createMember);
router.put('/members/:userId', updateMember);
router.patch('/members/:userId/status', updateMemberStatus);
router.patch('/members/:userId/permissions', updateMemberPermissions);
router.delete('/members/:userId', deleteMember);

export default router;
