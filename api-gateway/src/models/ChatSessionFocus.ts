import mongoose, { Document, Schema } from 'mongoose';

export interface IChatSessionFocus extends Document {
    sessionId: string;
    organizationId: string;
    userId?: string | null;
    focusDocumentIds: string[];
    updatedAt: Date;
    createdAt: Date;
}

const ChatSessionFocusSchema = new Schema<IChatSessionFocus>(
    {
        sessionId: { type: String, required: true, unique: true, index: true },
        organizationId: { type: String, required: true, index: true },
        userId: { type: String, default: null, index: true },
        focusDocumentIds: { type: [String], default: [] },
    },
    { timestamps: true }
);

ChatSessionFocusSchema.index({ updatedAt: 1 });

export default mongoose.model<IChatSessionFocus>('ChatSessionFocus', ChatSessionFocusSchema);
