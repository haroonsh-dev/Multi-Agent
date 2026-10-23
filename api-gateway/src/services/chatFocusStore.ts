/**
 * Chat focus: document(s) the user last discussed for "chart of that".
 * Hot cache in memory + Mongo persistence (survives gateway restart).
 */
import ChatSessionFocus from '../models/ChatSessionFocus';

type FocusEntry = {
    documentIds: string[];
    updatedAt: number;
};

const focusBySession = new Map<string, FocusEntry>();
const TTL_MS = 1000 * 60 * 60 * 12; // 12h

function prune() {
    const now = Date.now();
    for (const [k, v] of focusBySession) {
        if (now - v.updatedAt > TTL_MS) focusBySession.delete(k);
    }
}

function cacheSet(sessionId: string, documentIds: string[]) {
    focusBySession.set(sessionId, {
        documentIds: [...new Set(documentIds.filter(Boolean))].slice(0, 5),
        updatedAt: Date.now(),
    });
}

export function setSessionFocusDocumentIds(
    sessionId: string | undefined,
    documentIds: string[],
    meta?: { organizationId?: string; userId?: string }
) {
    if (!sessionId || !documentIds.length) return;
    prune();
    const ids = [...new Set(documentIds.filter(Boolean))].slice(0, 5);
    cacheSet(sessionId, ids);

    const orgId = meta?.organizationId?.trim();
    if (!orgId) return;

    void ChatSessionFocus.findOneAndUpdate(
        { sessionId },
        {
            sessionId,
            organizationId: orgId,
            userId: meta?.userId || null,
            focusDocumentIds: ids,
        },
        { upsert: true, new: true }
    ).catch(() => {
        /* non-fatal — in-memory focus still works */
    });
}

/** Drop focus so portfolio / all-clients questions use full scope. */
export async function clearSessionFocusDocumentIds(sessionId: string | undefined): Promise<void> {
    if (!sessionId) return;
    focusBySession.delete(sessionId);
    try {
        await ChatSessionFocus.deleteOne({ sessionId });
    } catch {
        /* non-fatal */
    }
}

/** Load Mongo focus into memory when cache is cold (e.g. after restart). */
export async function hydrateSessionFocus(sessionId: string | undefined): Promise<void> {
    if (!sessionId) return;
    prune();
    const hit = focusBySession.get(sessionId);
    if (hit && Date.now() - hit.updatedAt < TTL_MS) return;

    try {
        const row = await ChatSessionFocus.findOne({ sessionId }).lean();
        if (!row?.focusDocumentIds?.length) return;
        const updated = row.updatedAt ? new Date(row.updatedAt).getTime() : Date.now();
        if (Date.now() - updated > TTL_MS) {
            void ChatSessionFocus.deleteOne({ sessionId }).catch(() => {});
            return;
        }
        cacheSet(sessionId, row.focusDocumentIds);
    } catch {
        /* DB unavailable */
    }
}

export async function getSessionFocusDocumentIds(sessionId: string | undefined): Promise<string[]> {
    if (!sessionId) return [];
    await hydrateSessionFocus(sessionId);
    prune();
    const hit = focusBySession.get(sessionId);
    if (!hit) return [];
    if (Date.now() - hit.updatedAt > TTL_MS) {
        focusBySession.delete(sessionId);
        return [];
    }
    return [...hit.documentIds];
}

export async function pruneStaleChatSessionFocus(): Promise<number> {
    const cutoff = new Date(Date.now() - TTL_MS);
    try {
        const res = await ChatSessionFocus.deleteMany({ updatedAt: { $lt: cutoff } });
        for (const [sessionId, entry] of focusBySession) {
            if (entry.updatedAt < cutoff.getTime()) focusBySession.delete(sessionId);
        }
        return res.deletedCount ?? 0;
    } catch {
        return 0;
    }
}
