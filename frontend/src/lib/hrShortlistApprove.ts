import { apiRequest } from "@/lib/apiClient";

export type HrShortlistApproveResult = {
    approved: Array<{ documentId: string; candidateName: string; cvScore: number }>;
};

export async function approveHrCandidatesToShortlist(documentIds: string[]): Promise<HrShortlistApproveResult> {
    const data = await apiRequest("/docs/documents/hr/candidates/shortlist/approve", {
        method: "POST",
        body: JSON.stringify({ documentIds }),
    });
    return (data?.data || { approved: [] }) as HrShortlistApproveResult;
}
