import mongoose, { Document, Schema } from 'mongoose';

/**
 * Org-scoped secret for the public Agent Ask API.
 * External apps authenticate with this token (not a user JWT).
 */
export interface IAgentApiToken extends Document {
    tokenId: string;
    organizationId: string;
    /** Full secret — shown once on create/rotate; list responses mask it. */
    token: string;
    label: string;
    isActive: boolean;
    lastUsedAt?: Date | null;
    createdAt: Date;
    updatedAt: Date;
}

const AgentApiTokenSchema = new Schema<IAgentApiToken>(
    {
        tokenId: { type: String, required: true, unique: true, index: true },
        organizationId: { type: String, required: true, unique: true, index: true },
        token: { type: String, required: true, unique: true, index: true },
        label: { type: String, default: 'Agent API' },
        isActive: { type: Boolean, default: true },
        lastUsedAt: { type: Date, default: null },
    },
    { timestamps: true }
);

export default mongoose.model<IAgentApiToken>('AgentApiToken', AgentApiTokenSchema);
