import mongoose, { Document, Schema } from 'mongoose';
import { PermissionKey } from '../types/permissions';

export interface IOrgRolePermissions {
    'document.upload'?: boolean;
    'document.view'?: boolean;
    'document.delete'?: boolean;
    'document.preview'?: boolean;
    'document.share'?: boolean;
    'chat.use'?: boolean;
    'team.manage'?: boolean;
    'org.documents.view'?: boolean;
    'department.manage'?: boolean;
    'department.view'?: boolean;
    'page.dashboard'?: boolean;
    'page.documents'?: boolean;
    'page.chat'?: boolean;
    'page.activity'?: boolean;
    'page.departments'?: boolean;
    'page.plans'?: boolean;
    'page.email_reports'?: boolean;
    'page.integrations'?: boolean;
    'page.settings'?: boolean;
}

export interface IOrgRole extends Document {
    roleId: string;
    organizationId: string;
    name: string;
    description?: string;
    permissions: IOrgRolePermissions;
    /** Hierarchy: Employee=1, Leader=2, Manager=3 (+ custom) */
    rank: number;
    /** When true, department-scoped uploads are private to peers until shared */
    isLeader: boolean;
    isSystem: boolean;
    createdAt: Date;
    updatedAt: Date;
}

const OrgRolePermissionsSchema = new Schema<IOrgRolePermissions>(
    {
        'document.upload': { type: Boolean, default: true },
        'document.view': { type: Boolean, default: true },
        'document.delete': { type: Boolean, default: true },
        'document.preview': { type: Boolean, default: true },
        'document.share': { type: Boolean, default: false },
        'chat.use': { type: Boolean, default: true },
        'team.manage': { type: Boolean, default: false },
        'org.documents.view': { type: Boolean, default: false },
        'department.manage': { type: Boolean, default: false },
        'department.view': { type: Boolean, default: true },
        'page.dashboard': { type: Boolean, default: true },
        'page.documents': { type: Boolean, default: true },
        'page.chat': { type: Boolean, default: true },
        'page.activity': { type: Boolean, default: false },
        'page.departments': { type: Boolean, default: false },
        'page.plans': { type: Boolean, default: false },
        'page.email_reports': { type: Boolean, default: false },
        'page.integrations': { type: Boolean, default: false },
        'page.settings': { type: Boolean, default: false },
    },
    { _id: false }
);

const OrgRoleSchema = new Schema<IOrgRole>(
    {
        roleId: { type: String, required: true, unique: true, index: true },
        organizationId: { type: String, required: true, index: true },
        name: { type: String, required: true },
        description: { type: String, default: '' },
        permissions: { type: OrgRolePermissionsSchema, required: true },
        rank: { type: Number, default: 1, min: 1, max: 99 },
        isLeader: { type: Boolean, default: false },
        isSystem: { type: Boolean, default: false },
    },
    { timestamps: true }
);

OrgRoleSchema.index({ organizationId: 1, name: 1 }, { unique: true });

export type OrgRolePermissionMap = Partial<Record<PermissionKey, boolean>>;

export default mongoose.model<IOrgRole>('OrgRole', OrgRoleSchema);
