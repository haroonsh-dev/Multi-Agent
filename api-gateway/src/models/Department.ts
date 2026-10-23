import mongoose, { Document, Schema } from 'mongoose';

export interface IDepartment extends Document {
    departmentId: string;
    organizationId: string;
    name: string;
    slug: string;
    description?: string;
    allowedDocumentTypes: string[];
    /** Subset of org plan agents; empty = department may use all org plan agents */
    allowedAgents: string[];
    status: 'active' | 'inactive';
    createdBy: string;
    createdAt: Date;
    updatedAt: Date;
}

const DepartmentSchema = new Schema<IDepartment>(
    {
        departmentId: { type: String, required: true, unique: true, index: true },
        organizationId: { type: String, required: true, index: true },
        name: { type: String, required: true },
        slug: { type: String, required: true },
        description: { type: String, default: '' },
        allowedDocumentTypes: { type: [String], default: [] },
        allowedAgents: { type: [String], default: [] },
        status: { type: String, enum: ['active', 'inactive'], default: 'active' },
        createdBy: { type: String, required: true },
    },
    { timestamps: true }
);

DepartmentSchema.index({ organizationId: 1, slug: 1 }, { unique: true });

export default mongoose.model<IDepartment>('Department', DepartmentSchema);
