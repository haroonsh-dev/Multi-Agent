import mongoose, { Document, Schema } from 'mongoose';

export interface IPlanRequest extends Document {
    requestId: string;
    organizationId: string;
    requestedBy: string;
    requestType: 'new' | 'change';
    previousAgentIds?: string[];
    planId?: string | null;
    planName?: string | null;
    agentIds: string[];
    storageGb: number;
    billingCycle: 'monthly' | 'yearly';
    quotedPrice: number;
    message?: string;
    status: 'pending' | 'approved' | 'rejected' | 'cancelled';
    reviewedBy?: string | null;
    reviewNote?: string | null;
    createdAt: Date;
    updatedAt: Date;
}

const PlanRequestSchema = new Schema<IPlanRequest>(
    {
        requestId: { type: String, required: true, unique: true, index: true },
        organizationId: { type: String, required: true, index: true },
        requestedBy: { type: String, required: true },
        requestType: { type: String, enum: ['new', 'change'], default: 'new', index: true },
        previousAgentIds: { type: [String], default: [] },
        planId: { type: String, default: null },
        planName: { type: String, default: null },
        agentIds: { type: [String], default: [] },
        storageGb: { type: Number, required: true, min: 0 },
        billingCycle: { type: String, enum: ['monthly', 'yearly'], required: true },
        quotedPrice: { type: Number, required: true, min: 0 },
        message: { type: String, default: '' },
        status: {
            type: String,
            enum: ['pending', 'approved', 'rejected', 'cancelled'],
            default: 'pending',
            index: true,
        },
        reviewedBy: { type: String, default: null },
        reviewNote: { type: String, default: null },
    },
    { timestamps: true }
);

export default mongoose.model<IPlanRequest>('PlanRequest', PlanRequestSchema);
