import mongoose, { Document, Schema } from 'mongoose';

export type IntegrationSyncMode = 'interval' | 'daily' | 'manual';

export type PendingSyncFile = {
    id: string;
    name: string;
    mimeType?: string;
    size?: number;
};

export type PendingSyncPrompt = {
    discoveredAt: Date;
    files: PendingSyncFile[];
    count: number;
};

export type UnreadSyncAlert = {
    type: 'error' | 'info';
    message: string;
    at: Date;
};

export interface IIntegrationConnection extends Document {
    connectionId: string;
    organizationId: string;
    providerId: string;
    label: string;
    config: Record<string, string | number | boolean | null>;
    secrets: Record<string, string>;
    ingestApiKey: string;
    isActive: boolean;
    intervalMinutes: number;
    syncMode: IntegrationSyncMode;
    dailyAt: string;
    autoSyncEnabled: boolean;
    /** Interval mode only: when true, upload without asking; when false, queue a confirm prompt. */
    intervalAutoUpload: boolean;
    nextSyncAt?: Date | null;
    pendingSyncPrompt?: PendingSyncPrompt | null;
    unreadSyncAlert?: UnreadSyncAlert | null;
    direction: 'inbound' | 'outbound' | 'both';
    lastSyncAt?: Date | null;
    lastStatus?: string | null;
    lastSyncSummary?: string | null;
    createdBy: string;
    createdAt: Date;
    updatedAt: Date;
}

const IntegrationConnectionSchema = new Schema<IIntegrationConnection>(
    {
        connectionId: { type: String, required: true, unique: true, index: true },
        organizationId: { type: String, required: true, index: true },
        providerId: { type: String, required: true, index: true },
        label: { type: String, required: true },
        config: { type: Schema.Types.Mixed, default: {} },
        secrets: { type: Schema.Types.Mixed, default: {} },
        ingestApiKey: { type: String, required: true, unique: true, index: true },
        isActive: { type: Boolean, default: true },
        intervalMinutes: { type: Number, default: 15 },
        syncMode: { type: String, enum: ['interval', 'daily', 'manual'], default: 'interval' },
        dailyAt: { type: String, default: '09:00' },
        autoSyncEnabled: { type: Boolean, default: true },
        intervalAutoUpload: { type: Boolean, default: false },
        nextSyncAt: { type: Date, default: null },
        pendingSyncPrompt: { type: Schema.Types.Mixed, default: null },
        unreadSyncAlert: { type: Schema.Types.Mixed, default: null },
        direction: { type: String, enum: ['inbound', 'outbound', 'both'], default: 'both' },
        lastSyncAt: { type: Date, default: null },
        lastStatus: { type: String, default: null },
        lastSyncSummary: { type: String, default: null },
        createdBy: { type: String, required: true },
    },
    { timestamps: true }
);

IntegrationConnectionSchema.index({ organizationId: 1, providerId: 1 });
IntegrationConnectionSchema.index({ organizationId: 1, providerId: 1, label: 1 });
IntegrationConnectionSchema.index({ autoSyncEnabled: 1, nextSyncAt: 1, isActive: 1 });
IntegrationConnectionSchema.index({ organizationId: 1, isActive: 1 });

export default mongoose.model<IIntegrationConnection>('IntegrationConnection', IntegrationConnectionSchema);
