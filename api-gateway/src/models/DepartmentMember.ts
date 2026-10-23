import mongoose, { Document, Schema } from 'mongoose';

export interface IDepartmentMember extends Document {
    departmentId: string;
    userId: string;
    organizationId: string;
    orgRoleId: string;
    joinedAt: Date;
    createdAt: Date;
    updatedAt: Date;
}

const DepartmentMemberSchema = new Schema<IDepartmentMember>(
    {
        departmentId: { type: String, required: true, index: true },
        userId: { type: String, required: true, index: true },
        organizationId: { type: String, required: true, index: true },
        orgRoleId: { type: String, required: true },
        joinedAt: { type: Date, default: Date.now },
    },
    { timestamps: true }
);

DepartmentMemberSchema.index({ departmentId: 1, userId: 1 }, { unique: true });
DepartmentMemberSchema.index({ organizationId: 1, userId: 1 }, { unique: true });

export default mongoose.model<IDepartmentMember>('DepartmentMember', DepartmentMemberSchema);
