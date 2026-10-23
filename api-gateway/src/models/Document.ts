import mongoose, { Document as MongooseDocument, Schema } from 'mongoose';

export type DocumentStatus =
    | 'uploaded'
    | 'processing'
    | 'ready'
    | 'failed'
    | 'review';

export type DocumentVisibilityScope = 'personal' | 'department';

export interface IDocument extends MongooseDocument {
    documentId: string;
    organizationId?: string | null;
    uploadedBy: string;
    openRemoteUserId?: string | null;
    originalFilename: string;
    storedFilename: string;
    mimeType: string;
    sizeBytes: number;
    storagePath: string;
    contentHash?: string | null;
    pythonDocumentId?: string | null;
    aiProcessingStatus?: string | null;
    aiErrorMessage?: string | null;
    status: DocumentStatus;
    classification?: string | null;
    /** Department that owns this doc when visibilityScope=department */
    departmentId?: string | null;
    /** personal = only owner (+ admin); department = peers in departmentId */
    visibilityScope: DocumentVisibilityScope;
    /** Leader uploads in a department stay private to peers until shared */
    uploaderIsLeader?: boolean;
    metadata?: Record<string, unknown>;
    pageCount?: number;
    errorMessage?: string | null;
    createdAt: Date;
    updatedAt: Date;
}

const DocumentSchema = new Schema<IDocument>(
    {
        documentId: { type: String, required: true, unique: true, index: true },
        organizationId: { type: String, default: null, index: true },
        uploadedBy: { type: String, required: true, index: true },
        openRemoteUserId: { type: String, default: null },
        originalFilename: { type: String, required: true },
        storedFilename: { type: String, required: true },
        mimeType: { type: String, required: true },
        sizeBytes: { type: Number, required: true },
        storagePath: { type: String, required: true },
        contentHash: { type: String, default: null, index: true },
        pythonDocumentId: { type: String, default: null, index: true },
        aiProcessingStatus: { type: String, default: null },
        aiErrorMessage: { type: String, default: null },
        status: {
            type: String,
            enum: ['uploaded', 'processing', 'ready', 'failed', 'review'],
            default: 'uploaded',
        },
        classification: { type: String, default: null },
        departmentId: { type: String, default: null, index: true },
        visibilityScope: {
            type: String,
            enum: ['personal', 'department'],
            default: 'personal',
            index: true,
        },
        uploaderIsLeader: { type: Boolean, default: false },
        metadata: { type: Schema.Types.Mixed, default: {} },
        pageCount: { type: Number, default: 0 },
        errorMessage: { type: String, default: null },
    },
    { timestamps: true }
);

DocumentSchema.index({ departmentId: 1, visibilityScope: 1 });
DocumentSchema.index({ organizationId: 1, createdAt: -1 });
DocumentSchema.index({ uploadedBy: 1, createdAt: -1 });
DocumentSchema.index({ status: 1, createdAt: -1 });

export default mongoose.model<IDocument>('Document', DocumentSchema);
