import mongoose, { Document, Schema } from 'mongoose';

export interface IPlan extends Document {
    planId: string;
    name: string;
    description?: string;
    billingCycle: 'monthly' | 'yearly';
    agentIds: string[];
    storageGb: number;
    price: number;
    status: 'active' | 'archived';
    createdAt: Date;
    updatedAt: Date;
}

const PlanSchema = new Schema<IPlan>(
    {
        planId: { type: String, required: true, unique: true, index: true },
        name: { type: String, required: true },
        description: { type: String, default: '' },
        billingCycle: { type: String, enum: ['monthly', 'yearly'], required: true },
        agentIds: { type: [String], default: [] },
        storageGb: { type: Number, required: true, min: 0 },
        price: { type: Number, required: true, min: 0 },
        status: { type: String, enum: ['active', 'archived'], default: 'active' },
    },
    { timestamps: true }
);

export default mongoose.model<IPlan>('Plan', PlanSchema);
