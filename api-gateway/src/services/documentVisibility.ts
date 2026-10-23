import User from '../models/User';
import Department from '../models/Department';
import OrgRole from '../models/OrgRole';
import DepartmentMember from '../models/DepartmentMember';
import { normalizeDocumentType } from './documentStorage';
import type { IDocument } from '../models/Document';

/**
 * After AI classifies a document, assign department vs personal visibility
 * based on the uploader's primary department allowedDocumentTypes.
 */
export async function applyDocumentVisibilityScope(
    doc: InstanceType<typeof import('../models/Document').default> | IDocument,
    classification?: string | null
): Promise<void> {
    const type = normalizeDocumentType(classification || doc.classification);
    const uploader = await User.findOne({ userId: doc.uploadedBy }).lean();
    if (!uploader) {
        doc.visibilityScope = 'personal';
        doc.departmentId = null;
        doc.uploaderIsLeader = false;
        return;
    }

    const membership = await DepartmentMember.findOne({ userId: uploader.userId }).lean();
    const departmentId = membership?.departmentId || uploader.primaryDepartmentId || null;
    const orgRoleId = membership?.orgRoleId || uploader.orgRoleId || null;

    let isLeader = false;
    if (orgRoleId) {
        const role = await OrgRole.findOne({ roleId: orgRoleId }).lean();
        isLeader = !!role?.isLeader;
    }

    if (!departmentId) {
        doc.visibilityScope = 'personal';
        doc.departmentId = null;
        doc.uploaderIsLeader = false;
        return;
    }

    const dept = await Department.findOne({ departmentId, status: 'active' }).lean();
    if (!dept) {
        doc.visibilityScope = 'personal';
        doc.departmentId = null;
        doc.uploaderIsLeader = false;
        return;
    }

    doc.departmentId = departmentId;
    const allowed = (dept.allowedDocumentTypes || []).map((t) => normalizeDocumentType(t));
    const hasExplicitRules = allowed.length > 0;
    const matches = !hasExplicitRules || allowed.includes(type);

    if (matches) {
        doc.visibilityScope = 'department';
        doc.uploaderIsLeader = isLeader;
    } else {
        doc.visibilityScope = 'personal';
        doc.uploaderIsLeader = false;
    }
}
