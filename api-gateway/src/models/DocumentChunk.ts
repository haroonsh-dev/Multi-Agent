import mongoose, { Document, Schema } from 'mongoose';

export interface IDocumentChunk extends Document {
    chunkId: string;
    documentId: string;
    organizationId?: string | null;
    pageNumber?: number;
    text: string;
    embedding?: number[] | null;
    metadata?: Record<string, unknown>;
    createdAt: Date;
    updatedAt: Date;
}

const DocumentChunkSchema = new Schema<IDocumentChunk>(
    {
        chunkId: { type: String, required: true, unique: true },
        documentId: { type: String, required: true, index: true },
        organizationId: { type: String, default: null, index: true },
        pageNumber: { type: Number },
        text: { type: String, required: true },
        embedding: { type: [Number], default: null },
        metadata: { type: Schema.Types.Mixed, default: {} },
    },
    { timestamps: true }
);

export default mongoose.model<IDocumentChunk>('DocumentChunk', DocumentChunkSchema);
