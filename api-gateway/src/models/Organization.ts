import mongoose, { Document, Schema } from 'mongoose';

export interface IOrganization extends Document {
    organizationId: string;
    organizationName: string;
    contactEmail?: string;
    status: 'active' | 'inactive';
    subscriptionPlan?: string;
    allowedAgents?: string[];
    openRemoteRealm?: string | null;
    groqApiKey?: string | null;
    financeSettings?: {
        baseCurrency?: string;
        vendorAliases?: Record<string, string>;
        clientAliases?: Record<string, string>;
        /** 1–12; 1 = calendar year. Used for FY summaries. */
        fyStartMonth?: number;
        /** Fixed FX rates keyed by ISO currency code → units per 1 baseCurrency. */
        fxRates?: Record<string, number>;
    };
    complianceSettings?: {
        expiryWarningDays?: number;
        requiredDocTypes?: string[];
        severityAliases?: Record<string, string>;
        standardAliases?: Record<string, string>;
    };
    createdAt: Date;
    updatedAt: Date;
}

const OrganizationSchema = new Schema<IOrganization>(
    {
        organizationId: { type: String, required: true, unique: true },
        organizationName: { type: String, required: true },
        contactEmail: { type: String },
        status: { type: String, enum: ['active', 'inactive'], default: 'active' },
        subscriptionPlan: { type: String, default: 'free' },
        allowedAgents: { type: [String], default: [] },
        openRemoteRealm: { type: String, default: null },
        groqApiKey: { type: String, default: null },
        financeSettings: {
            baseCurrency: { type: String, default: null },
            vendorAliases: { type: Schema.Types.Mixed, default: undefined },
            clientAliases: { type: Schema.Types.Mixed, default: undefined },
            fyStartMonth: { type: Number, default: null },
            fxRates: { type: Schema.Types.Mixed, default: undefined },
        },
        complianceSettings: {
            expiryWarningDays: { type: Number, default: null },
            requiredDocTypes: { type: [String], default: undefined },
            severityAliases: { type: Schema.Types.Mixed, default: undefined },
            standardAliases: { type: Schema.Types.Mixed, default: undefined },
        },
    },
    { timestamps: true }
);

export default mongoose.model<IOrganization>('Organization', OrganizationSchema);
