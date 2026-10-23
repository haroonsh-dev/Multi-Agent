import mongoose, { Document, Schema } from 'mongoose';

export type AIProvider = 'groq' | 'openai' | 'gemini' | 'anthropic' | 'custom';

export interface IApiKey extends Document {
    keyId: string;
    organizationId: string;
    provider: AIProvider;
    apiKey: string;
    label: string;
    aiModel?: string | null;
    baseUrl?: string | null;
    isActive: boolean;
    createdBy: string;
    createdAt: Date;
    updatedAt: Date;
}

const ApiKeySchema = new Schema<IApiKey>(
    {
        keyId: { type: String, required: true, unique: true, index: true },
        organizationId: { type: String, required: false, default: 'global', index: true },
        provider: { type: String, enum: ['groq', 'openai', 'gemini', 'anthropic', 'custom'], required: true },
        apiKey: { type: String, required: true },
        label: { type: String, required: true },
        aiModel: { type: String, default: null },
        baseUrl: { type: String, default: null },
        isActive: { type: Boolean, default: true },
        createdBy: { type: String, required: true },
    },
    { timestamps: true }
);

ApiKeySchema.index({ organizationId: 1, provider: 1 });

export default mongoose.model<IApiKey>('ApiKey', ApiKeySchema);
