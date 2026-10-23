import mongoose, { Document, Schema } from 'mongoose';

export interface IMessageFeedback extends Document {
    feedbackId: string;
    sessionId: string;
    messageIndex: number;
    userId: string;
    organizationId: string;
    type: 'like' | 'dislike';
    createdAt: Date;
    updatedAt: Date;
}

const MessageFeedbackSchema = new Schema<IMessageFeedback>(
    {
        feedbackId: { type: String, required: true, unique: true, index: true },
        sessionId: { type: String, required: true, index: true },
        messageIndex: { type: Number, required: true },
        userId: { type: String, required: true, index: true },
        organizationId: { type: String, required: true, index: true },
        type: { type: String, enum: ['like', 'dislike'], required: true },
    },
    { timestamps: true }
);

MessageFeedbackSchema.index({ sessionId: 1, messageIndex: 1, userId: 1 }, { unique: true });

export default mongoose.model<IMessageFeedback>('MessageFeedback', MessageFeedbackSchema);
