import mongoose, { Document as MongooseDocument, Schema } from 'mongoose';

export type EmailReportFrequency = 'daily' | 'weekly';

/** library = Mongo file counts; extraction = AI per-document fields */
export type EmailReportType = 'library' | 'extraction';

export type EmailReportSections = {
    overview: boolean;
    byStatus: boolean;
    byDepartment: boolean;
    byUploader: boolean;
    latestFiles: boolean;
    storage: boolean;
};

export interface IEmailReportConfig extends MongooseDocument {
    organizationId: string;
    enabled: boolean;
    frequency: EmailReportFrequency;
    reportType: EmailReportType;
    /** Optional filter when reportType=extraction (e.g. hr_agent) */
    phase3Agent: string;
    /** 0 = Sunday … 6 = Saturday (used when frequency=weekly) */
    weekday: number;
    /** HH:MM server local time */
    time: string;
    recipients: string[];
    sections: EmailReportSections;
    latestFilesLimit: number;
    lastSentAt?: Date | null;
    nextSendAt?: Date | null;
    lastStatus?: string | null;
    lastError?: string | null;
    createdAt: Date;
    updatedAt: Date;
}

export const DEFAULT_EMAIL_REPORT_SECTIONS: EmailReportSections = {
    overview: true,
    byStatus: true,
    byDepartment: true,
    byUploader: true,
    latestFiles: true,
    storage: true,
};

const EmailReportConfigSchema = new Schema<IEmailReportConfig>(
    {
        organizationId: { type: String, required: true, unique: true, index: true },
        enabled: { type: Boolean, default: false },
        frequency: { type: String, enum: ['daily', 'weekly'], default: 'daily' },
        reportType: { type: String, enum: ['library', 'extraction'], default: 'library' },
        phase3Agent: { type: String, default: '' },
        weekday: { type: Number, default: 1, min: 0, max: 6 },
        time: { type: String, default: '09:00' },
        recipients: { type: [String], default: [] },
        sections: {
            type: new Schema(
                {
                    overview: { type: Boolean, default: true },
                    byStatus: { type: Boolean, default: true },
                    byDepartment: { type: Boolean, default: true },
                    byUploader: { type: Boolean, default: true },
                    latestFiles: { type: Boolean, default: true },
                    storage: { type: Boolean, default: true },
                },
                { _id: false }
            ),
            default: () => ({ ...DEFAULT_EMAIL_REPORT_SECTIONS }),
        },
        latestFilesLimit: { type: Number, default: 10, min: 1, max: 50 },
        lastSentAt: { type: Date, default: null },
        nextSendAt: { type: Date, default: null, index: true },
        lastStatus: { type: String, default: null },
        lastError: { type: String, default: null },
    },
    { timestamps: true }
);

export default mongoose.model<IEmailReportConfig>('EmailReportConfig', EmailReportConfigSchema);
