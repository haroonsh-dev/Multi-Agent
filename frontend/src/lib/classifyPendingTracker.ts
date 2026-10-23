/**
 * Tracks which uploaded documents still need the classify popup once they
 * reach "ready", independent of which poller (the fast 4-minute poll or the
 * indefinite background poll) observes that readiness first.
 *
 * Pulled out as a plain class (no React) so the state-machine behind the
 * upload -> classify handoff can be unit tested without rendering the
 * Documents page. See documents/page.tsx for the two call sites.
 */
export class ClassifyPendingTracker {
    private pending = new Set<string>();

    /** Call when a document starts processing and will need a classify popup once ready. */
    add(documentId: string) {
        this.pending.add(documentId);
    }

    isPending(documentId: string) {
        return this.pending.has(documentId);
    }

    /**
     * Call whenever any poller observes a document's terminal status.
     * Returns true exactly once per document, on the poll that first sees it go
     * "ready" while still pending — the caller should fire the classify popup then.
     * A "failed" observation clears the pending flag without ever returning true.
     */
    resolve(documentId: string, status: "ready" | "failed"): boolean {
        if (!this.pending.has(documentId)) return false;
        this.pending.delete(documentId);
        return status === "ready";
    }
}
