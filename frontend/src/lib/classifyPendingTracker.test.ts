import { describe, expect, it } from "vitest";
import { ClassifyPendingTracker } from "./classifyPendingTracker";

// Regression coverage for the bug fixed 2026-09-22: pollUntilTerminal used to
// give up after a fixed 4 minutes and treat that as a hard failure, which
// silently meant the classify popup never fired for documents slow enough to
// cross that window — they'd finish processing on the backend but sit in the
// library unrouted forever. The fix hands off to the background poller
// instead of failing. These tests pin that handoff at the state-machine level.

describe("ClassifyPendingTracker", () => {
    it("fires the popup when the background poller sees ready after the fast poll times out", () => {
        const tracker = new ClassifyPendingTracker();
        tracker.add("doc-1");

        // Fast poll (pollUntilTerminal) times out — must NOT drop the pending flag.
        // (Simulated by simply not calling resolve() on timeout, as the real code does.)
        expect(tracker.isPending("doc-1")).toBe(true);

        // Background poller later observes the doc reached "ready".
        const shouldPopup = tracker.resolve("doc-1", "ready");
        expect(shouldPopup).toBe(true);
        expect(tracker.isPending("doc-1")).toBe(false);
    });

    it("does not fire the popup twice if both pollers observe readiness", () => {
        const tracker = new ClassifyPendingTracker();
        tracker.add("doc-1");

        expect(tracker.resolve("doc-1", "ready")).toBe(true);
        // A second observation (e.g. the other poller's tick) must be a no-op.
        expect(tracker.resolve("doc-1", "ready")).toBe(false);
    });

    it("clears pending state on failure without ever firing the popup", () => {
        const tracker = new ClassifyPendingTracker();
        tracker.add("doc-1");

        expect(tracker.resolve("doc-1", "failed")).toBe(false);
        expect(tracker.isPending("doc-1")).toBe(false);
        // Even if a stray "ready" observation arrives afterwards, it's already resolved.
        expect(tracker.resolve("doc-1", "ready")).toBe(false);
    });

    it("ignores documents that were never registered as pending", () => {
        const tracker = new ClassifyPendingTracker();
        expect(tracker.resolve("unknown-doc", "ready")).toBe(false);
    });

    it("tracks multiple in-flight documents independently", () => {
        const tracker = new ClassifyPendingTracker();
        tracker.add("doc-1");
        tracker.add("doc-2");

        expect(tracker.resolve("doc-1", "failed")).toBe(false);
        expect(tracker.isPending("doc-2")).toBe(true);
        expect(tracker.resolve("doc-2", "ready")).toBe(true);
    });
});
