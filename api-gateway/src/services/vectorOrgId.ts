import { resolveAiOrganizationId, resolveDocumentAiOrgId } from './aiServiceClient';

export type VectorOrgDoc = {
    metadata?: { aiOrgId?: string } | null;
    organizationId?: string | null;
    uploadedBy?: string;
};

/**
 * Pinecone namespace + AI SQLite partition for vectors/chunks.
 * Must match the organization_id used at index time (see metadata.aiOrgId on upload).
 */
export function resolveVectorOrganizationId(
    user: { organizationId?: string | null; userId: string },
    docs?: VectorOrgDoc[]
): string {
    const defaultOrg = resolveAiOrganizationId(user);
    if (!docs?.length) return defaultOrg;

    const perDoc = docs.map((d) => resolveDocumentAiOrgId(d, user));
    const unique = new Set(perDoc);
    if (unique.size === 1) return perDoc[0];

    const stored = docs
        .map((d) => d.metadata?.aiOrgId)
        .filter((x): x is string => typeof x === 'string' && x.trim().length > 0);
    if (stored.length) {
        const freq = new Map<string, number>();
        for (const id of stored) freq.set(id, (freq.get(id) || 0) + 1);
        return [...freq.entries()].sort((a, b) => b[1] - a[1])[0][0];
    }

    return defaultOrg;
}
