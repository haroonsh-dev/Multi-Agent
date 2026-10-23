"use client";

import { useCallback, useEffect, useState } from "react";
import { apiRequest } from "@/lib/apiClient";

export type HrCandidateOutreachRow = {
    documentId: string;
    filename: string;
    candidateName: string;
    email: string | null;
    cvScore: number;
    title: string;
    lastOutreachAt?: string | null;
    lastOutreachTemplate?: string | null;
};

export type OutreachTemplateId = "interview_invite" | "screening_next_steps" | "rejection" | "custom";

export type SendOutreachResult = {
    sent: Array<{ documentId: string; candidateName: string; email: string }>;
    skipped: Array<{ documentId: string; candidateName: string; reason: string }>;
    failed: Array<{ documentId: string; candidateName: string; error: string }>;
};

export type OutreachPreview = {
    subject: string;
    html: string;
    candidateName: string;
    email: string | null;
    cvScore: number;
};

export function useHrCandidates(enabled = true) {
    const [candidates, setCandidates] = useState<HrCandidateOutreachRow[]>([]);
    const [emailConfigured, setEmailConfigured] = useState(false);
    const [withEmail, setWithEmail] = useState(0);
    const [loading, setLoading] = useState(false);
    const [sending, setSending] = useState(false);
    const [lastResult, setLastResult] = useState<SendOutreachResult | null>(null);

    const load = useCallback(async () => {
        if (!enabled) return;
        setLoading(true);
        try {
            const data = await apiRequest("/docs/documents/hr/candidates/outreach?limit=50");
            const payload = data?.data || {};
            setCandidates((payload.candidates || []) as HrCandidateOutreachRow[]);
            setEmailConfigured(Boolean(payload.emailConfigured));
            setWithEmail(Number(payload.withEmail) || 0);
        } catch {
            setCandidates([]);
            setEmailConfigured(false);
            setWithEmail(0);
        } finally {
            setLoading(false);
        }
    }, [enabled]);

    useEffect(() => {
        void load();
    }, [load]);

    const saveCandidateEmail = useCallback(
        async (documentId: string, email: string) => {
            await apiRequest(`/docs/documents/hr/candidates/${documentId}/email`, {
                method: "PATCH",
                body: JSON.stringify({ email }),
            });
            await load();
        },
        [load]
    );

    const previewOutreach = useCallback(
        async (
            params: {
                documentId: string;
                template: OutreachTemplateId;
                senderName?: string;
                companyName?: string;
                interviewDetails?: string;
                emailOverride?: string;
            },
            signal?: AbortSignal
        ): Promise<OutreachPreview | null> => {
            try {
                const data = await apiRequest("/docs/documents/hr/candidates/preview", {
                    method: "POST",
                    body: JSON.stringify(params),
                    signal,
                });
                return (data?.data || null) as OutreachPreview | null;
            } catch (e: unknown) {
                if (e instanceof Error && e.name === "AbortError") return null;
                return null;
            }
        },
        []
    );

    const sendOutreach = useCallback(
        async (params: {
            documentIds: string[];
            template: OutreachTemplateId;
            subject?: string;
            bodyHtml?: string;
            senderName?: string;
            companyName?: string;
            interviewDetails?: string;
            emailOverrides?: Record<string, string>;
        }) => {
            setSending(true);
            setLastResult(null);
            try {
                const data = await apiRequest("/docs/documents/hr/candidates/email", {
                    method: "POST",
                    body: JSON.stringify(params),
                });
                const result = (data?.data || {}) as SendOutreachResult;
                setLastResult(result);
                await load();
                return result;
            } finally {
                setSending(false);
            }
        },
        [load]
    );

    return {
        candidates,
        emailConfigured,
        withEmail,
        loading,
        sending,
        lastResult,
        refresh: load,
        saveCandidateEmail,
        previewOutreach,
        sendOutreach,
    };
}
