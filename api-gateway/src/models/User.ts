import mongoose, { Document, Schema } from 'mongoose';
import { DEFAULT_ADMIN_PERMISSIONS, DEFAULT_TEAM_PERMISSIONS } from '../types/permissions';

export type UserRole = 'superAdmin' | 'admin' | 'team' | 'service_account';

export interface IUserPermissions {
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

export interface IUser extends Document {
    userId: string;
    username: string;
    fullName: string;
    email: string;
    contactNumber?: string;
    accountType: 'personal' | 'enterprise';
    passwordHash: string;
    role: UserRole;
    organizationId?: string | null;
    createdBy?: string | null;
    permissions?: IUserPermissions;
    /** Primary department for document affinity / visibility (v1: one dept) */
    primaryDepartmentId?: string | null;
    /** Department org-role template (Leader / Employee / Manager) */
    orgRoleId?: string | null;
    status: 'active' | 'blocked' | 'pending';
    emailVerified?: boolean;
    openRemoteRealm?: string | null;
    openRemoteSynced?: boolean;
    openRemoteSyncedAt?: Date;
    openRemoteUserId?: string;
    openRemoteSecret?: string;
    lastLogin?: Date;
    createdAt: Date;
    updatedAt: Date;
}

const PermissionsSchema = new Schema<IUserPermissions>(
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

const UserSchema = new Schema<IUser>(
    {
        userId: { type: String, required: true, unique: true },
        username: { type: String, required: true, unique: true },
        fullName: { type: String, required: true },
        email: { type: String, required: true, unique: true },
        contactNumber: { type: String },
        accountType: {
            type: String,
            enum: ['personal', 'enterprise'],
            default: 'personal',
            required: true,
        },
        passwordHash: { type: String, required: true },
        role: {
            type: String,
            enum: ['superAdmin', 'admin', 'team', 'service_account'],
            required: true,
        },
        organizationId: { type: String, default: null, index: true },
        createdBy: { type: String, default: null },
        permissions: { type: PermissionsSchema, default: () => ({ ...DEFAULT_TEAM_PERMISSIONS }) },
        primaryDepartmentId: { type: String, default: null, index: true },
        orgRoleId: { type: String, default: null, index: true },
        status: {
            type: String,
            enum: ['active', 'blocked', 'pending'],
            default: 'active',
        },
        emailVerified: { type: Boolean, default: false },
        openRemoteRealm: { type: String, default: null },
        openRemoteSynced: { type: Boolean, default: false },
        openRemoteSyncedAt: { type: Date },
        openRemoteUserId: { type: String },
        openRemoteSecret: { type: String },
        lastLogin: { type: Date },
    },
    { timestamps: true }
);

export function defaultPermissionsForRole(role: UserRole): IUserPermissions {
    if (role === 'admin' || role === 'superAdmin') return { ...DEFAULT_ADMIN_PERMISSIONS };
    return { ...DEFAULT_TEAM_PERMISSIONS };
}

export default mongoose.model<IUser>('User', UserSchema);
