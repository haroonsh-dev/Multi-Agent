import { Router } from 'express';
import { authenticate } from '../middleware/auth';
import {
    addDepartmentMember,
    createDepartment,
    createOrgRole,
    deleteDepartment,
    deleteOrgRole,
    getDepartmentMemberDetail,
    getDepartmentOverview,
    listDepartmentSubordinates,
    listDepartments,
    listOrgRoles,
    removeDepartmentMember,
    requireDepartmentManage,
    requireDepartmentView,
    updateDepartment,
    updateOrgRole,
} from '../controllers/departmentController';

const router = Router();

router.use(authenticate);

router.get('/roles', requireDepartmentView, listOrgRoles);
router.post('/roles', requireDepartmentManage, createOrgRole);
router.patch('/roles/:id', requireDepartmentManage, updateOrgRole);
router.delete('/roles/:id', requireDepartmentManage, deleteOrgRole);

router.get('/', requireDepartmentView, listDepartments);
router.post('/', requireDepartmentManage, createDepartment);
router.get('/:id/overview', requireDepartmentView, getDepartmentOverview);
router.get('/:id/subordinates', requireDepartmentView, listDepartmentSubordinates);
router.get('/:id/members/:userId', requireDepartmentView, getDepartmentMemberDetail);
router.patch('/:id', requireDepartmentManage, updateDepartment);
router.delete('/:id', requireDepartmentManage, deleteDepartment);
router.post('/:id/members', requireDepartmentManage, addDepartmentMember);
router.delete('/:id/members/:userId', requireDepartmentManage, removeDepartmentMember);

export default router;
