import { apiRequest } from "@/lib/apiClient";

export type ReprocessDocumentsResult = {
    queued: string[];
    failed: Array<{ documentId: string; message: string }>;
};

/** Queue AI reprocess for portfolio files (Action Center Approve on all agents). */
export async function reprocessDocuments(
    documentIds: string[],
    options?: { limit?: number }
): Promise<ReprocessDocumentsResult> {
    const limit = options?.limit ?? 25;
    const ids = [...new Set(documentIds.map(String).filter(Boolean))].slice(0, limit);
    const queued: string[] = [];
    const failed: Array<{ documentId: string; message: string }> = [];

    for (const documentId of ids) {
        try {
            await apiRequest(`/docs/documents/${documentId}/reprocess`, { method: "POST" });
            queued.push(documentId);
        } catch (e: unknown) {
            failed.push({
                documentId,
                message: e instanceof Error ? e.message : "Reprocess failed",
            });
        }
    }

    return { queued, failed };
}
