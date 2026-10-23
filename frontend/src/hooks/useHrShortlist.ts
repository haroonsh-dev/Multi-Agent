"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { apiRequest, ApiError } from "@/lib/apiClient";
import {
    mapHrPendingShortlistApiRows,
    mapHrShortlistApiRows,
    type CvPendingShortlistRow,
    type CvShortlistRow,
} from "@/lib/agentWorkspaceHr";
import { approveHrCandidatesToShortlist } from "@/lib/hrShortlistApprove";

export type HrShortlistStats = {
    totalScored: number;
    totalResumes: number;
};

export type HrShortlistNote = {
    tone: "ok" | "err";
    text: string;
};

export function useHrShortlist(enabled = true, limit = 25) {
    const [rows, setRows] = useState<CvShortlistRow[]>([]);
    const [pendingRows, setPendingRows] = useState<CvPendingShortlistRow[]>([]);
    const [stats, setStats] = useState<HrShortlistStats>({ totalScored: 0, totalResumes: 0 });
    const [pendingDocumentIds, setPendingDocumentIds] = useState<string[]>([]);
    const [loading, setLoading] = useState(false);
    const [approving, setApproving] = useState(false);
    const [approvingDocumentId, setApprovingDocumentId] = useState<string | null>(null);
    const [note, setNote] = useState<HrShortlistNote | null>(null);
    const approvingRef = useRef(false);

    const load = useCallback(async () => {
        if (!enabled) return;
        setLoading(true);
        try {
            const data = await apiRequest(`/docs/documents/hr/candidates/shortlist?limit=${limit}`);
            const payload = data?.data || {};
            setRows(mapHrShortlistApiRows(payload.rows || []));
            setPendingRows(mapHrPendingShortlistApiRows(payload.pendingRows || []));
            setStats({
                totalScored: Number(payload.totalScored) || 0,
                totalResumes: Number(payload.totalResumes) || 0,
            });
            setPendingDocumentIds(
                Array.isArray(payload.pendingDocumentIds)
                    ? payload.pendingDocumentIds.map(String).filter(Boolean)
                    : []
            );
        } catch {
            setRows([]);
            setPendingRows([]);
            setStats({ totalScored: 0, totalResumes: 0 });
            setPendingDocumentIds([]);
        } finally {
            setLoading(false);
        }
    }, [enabled, limit]);

    useEffect(() => {
        void load();
    }, [load]);

    const approve = useCallback(
        async (documentIds: string[]) => {
            const ids = [...new Set(documentIds.map(String).filter(Boolean))];
            if (!ids.length || approvingRef.current) return null;

            approvingRef.current = true;
            setApproving(true);
            setApprovingDocumentId(ids.length === 1 ? ids[0] : null);
            setNote(null);
            try {
                const result = await approveHrCandidatesToShortlist(ids);
                await load();
                const names = result.approved.map((a) => a.candidateName).join(", ");
                setNote({
                    tone: "ok",
                    text:
                        result.approved.length === 1
                            ? `${names} added to shortlist.`
                            : `${result.approved.length} candidates added to shortlist: ${names}.`,
                });
                return result;
            } catch (e) {
                const msg =
                    e instanceof ApiError
                        ? e.message
                        : e instanceof Error
                          ? e.message
                          : "Could not add to shortlist.";
                setNote({ tone: "err", text: msg });
                return null;
            } finally {
                approvingRef.current = false;
                setApproving(false);
                setApprovingDocumentId(null);
            }
        },
        [load]
    );

    const clearNote = useCallback(() => setNote(null), []);

    return {
        rows,
        pendingRows,
        stats,
        pendingDocumentIds,
        loading,
        approving,
        approvingDocumentId,
        note,
        refresh: load,
        approve,
        clearNote,
    };
}
