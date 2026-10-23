import mongoose, { Document, Schema } from 'mongoose';

export interface IOrgSubscription extends Document {
    subscriptionId: string;
    organizationId: string;
    planId?: string | null;
    planName?: string | null;
    agentIds: string[];
    storageGb: number;
    billingCycle: 'monthly' | 'yearly';
    price: number;
    status: 'active' | 'inactive' | 'expired' | 'cancelled';
    startsAt: Date;
    endsAt: Date;
    activatedBy?: string | null;
    requestId?: string | null;
    createdAt: Date;
    updatedAt: Date;
}

const OrgSubscriptionSchema = new Schema<IOrgSubscription>(
    {
        subscriptionId: { type: String, required: true, unique: true, index: true },
        organizationId: { type: String, required: true, index: true },
        planId: { type: String, default: null },
        planName: { type: String, default: null },
        agentIds: { type: [String], default: [] },
        storageGb: { type: Number, required: true, min: 0 },
        billingCycle: { type: String, enum: ['monthly', 'yearly'], required: true },
        price: { type: Number, required: true, min: 0 },
        status: {
            type: String,
            enum: ['active', 'inactive', 'expired', 'cancelled'],
            default: 'active',
            index: true,
        },
        startsAt: { type: Date, required: true },
        endsAt: { type: Date, required: true },
        activatedBy: { type: String, default: null },
        requestId: { type: String, default: null },
    },
    { timestamps: true }
);

OrgSubscriptionSchema.index({ organizationId: 1, status: 1 });

export default mongoose.model<IOrgSubscription>('OrgSubscription', OrgSubscriptionSchema);
