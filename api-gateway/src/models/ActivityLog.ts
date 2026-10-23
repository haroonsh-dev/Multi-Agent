import mongoose, { Document, Schema } from 'mongoose';

export type ActivityCategory = 'auth' | 'document' | 'chat' | 'team' | 'admin' | 'security' | 'department';
export type ActivityOutcome = 'success' | 'failure';

export interface IActivityLog extends Document {
    logId: string;
    organizationId?: string | null;
    actorUserId: string;
    actorRole: string;
    actorEmail?: string | null;
    actorName?: string | null;
    action: string;
    category: ActivityCategory;
    resourceType?: string | null;
    resourceId?: string | null;
    outcome: ActivityOutcome;
    message?: string | null;
    metadata?: Record<string, unknown>;
    ip?: string | null;
    userAgent?: string | null;
    createdAt: Date;
    updatedAt: Date;
}

const ActivityLogSchema = new Schema<IActivityLog>(
    {
        logId: { type: String, required: true, unique: true, index: true },
        organizationId: { type: String, default: null, index: true },
        actorUserId: { type: String, required: true, index: true },
        actorRole: { type: String, required: true },
        actorEmail: { type: String, default: null },
        actorName: { type: String, default: null },
        action: { type: String, required: true, index: true },
        category: {
            type: String,
            enum: ['auth', 'document', 'chat', 'team', 'admin', 'security', 'department'],
            required: true,
            index: true,
        },
        resourceType: { type: String, default: null },
        resourceId: { type: String, default: null },
        outcome: {
            type: String,
            enum: ['success', 'failure'],
            default: 'success',
        },
        message: { type: String, default: null },
        metadata: { type: Schema.Types.Mixed, default: {} },
        ip: { type: String, default: null },
        userAgent: { type: String, default: null },
    },
    { timestamps: true }
);

ActivityLogSchema.index({ organizationId: 1, createdAt: -1 });
ActivityLogSchema.index({ actorUserId: 1, createdAt: -1 });
ActivityLogSchema.index({ createdAt: -1 });

export default mongoose.model<IActivityLog>('ActivityLog', ActivityLogSchema);
