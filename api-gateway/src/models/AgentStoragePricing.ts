import mongoose, { Document, Schema } from 'mongoose';

export const PLAN_AGENT_IDS = [
    'finance_agent',
    'procurement_agent',
    'hr_agent',
    'legal_agent',
    'compliance_agent',
    'other_agent',
] as const;

export type PlanAgentId = (typeof PLAN_AGENT_IDS)[number];

export const PLAN_AGENT_LABELS: Record<string, string> = {
    finance_agent: 'Finance Agent',
    procurement_agent: 'Procurement Agent',
    hr_agent: 'HR Agent',
    legal_agent: 'Legal Agent',
    compliance_agent: 'Compliance Agent',
    other_agent: 'Other Agent',
};

export interface AgentPriceRow {
    agentId: string;
    monthlyPrice: number;
    yearlyPrice: number;
    enabled: boolean;
}

export interface IAgentStoragePricing extends Document {
    configId: string;
    currency: string;
    agents: AgentPriceRow[];
    pricePerGbMonthly: number;
    pricePerGbYearly: number;
    /** Free-tier defaults when org has no active subscription */
    freeAgentIds: string[];
    freeStorageGb: number;
    createdAt: Date;
    updatedAt: Date;
}

const AgentPriceSchema = new Schema<AgentPriceRow>(
    {
        agentId: { type: String, required: true },
        monthlyPrice: { type: Number, required: true, default: 0, min: 0 },
        yearlyPrice: { type: Number, required: true, default: 0, min: 0 },
        enabled: { type: Boolean, default: true },
    },
    { _id: false }
);

const AgentStoragePricingSchema = new Schema<IAgentStoragePricing>(
    {
        configId: { type: String, required: true, unique: true, default: 'default' },
        currency: { type: String, default: 'USD' },
        agents: { type: [AgentPriceSchema], default: [] },
        pricePerGbMonthly: { type: Number, default: 1, min: 0 },
        pricePerGbYearly: { type: Number, default: 10, min: 0 },
        freeAgentIds: { type: [String], default: ['other_agent'] },
        freeStorageGb: { type: Number, default: 1, min: 0 },
    },
    { timestamps: true }
);

export default mongoose.model<IAgentStoragePricing>('AgentStoragePricing', AgentStoragePricingSchema);
