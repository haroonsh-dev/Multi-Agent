import mongoose, { Document, Schema } from 'mongoose';

export type DocumentShareScope = 'user' | 'department' | 'all';
export type DocumentShareVisibility = 'leader_only' | 'all_members';

export interface IDocumentShare extends Document {
    shareId: string;
    documentId: string;
    sharedBy: string;
    organizationId: string;
    scope: DocumentShareScope;
    /** When scope=user: specific users who may see the doc */
    targetUserIds: string[];
    /** When scope=department: specific department may see it */
    departmentId?: string | null;
    /** Controls access level: leader_only = only dept leader can see, all_members = everyone in dept */
    visibility: DocumentShareVisibility;
    createdAt: Date;
    updatedAt: Date;
}

const DocumentShareSchema = new Schema<IDocumentShare>(
    {
        shareId: { type: String, required: true, unique: true, index: true },
        documentId: { type: String, required: true, index: true },
        sharedBy: { type: String, required: true, index: true },
        organizationId: { type: String, required: true, index: true },
        scope: { type: String, enum: ['user', 'department', 'all'], required: true },
        targetUserIds: { type: [String], default: [] },
        departmentId: { type: String, default: null },
        visibility: { type: String, enum: ['leader_only', 'all_members'], default: 'all_members' },
    },
    { timestamps: true }
);

DocumentShareSchema.index({ documentId: 1, sharedBy: 1 });

export default mongoose.model<IDocumentShare>('DocumentShare', DocumentShareSchema);
