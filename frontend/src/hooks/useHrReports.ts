"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { apiRequest } from "@/lib/apiClient";
import {
    type HrGeneratedDoc,
    type HrLetterContext,
    type HrReportActionId,
    HR_REPORT_ACTIONS,
    isHrGeneratedDoc,
} from "@/lib/hrReports";
import { generatedPreviewHref } from "@/lib/generatedDocuments";

export type HrGenerateResult = {
    ok: boolean;
    message: string;
    documentId?: string;
};

type GenerateOptions = {
    shortlistLimit?: number;
    letterContext?: HrLetterContext;
};

export function useHrReports() {
    const [history, setHistory] = useState<HrGeneratedDoc[]>([]);
    const [historyLoading, setHistoryLoading] = useState(false);
    const [generatingId, setGeneratingId] = useState<HrReportActionId | null>(null);
    const [lastMessage, setLastMessage] = useState<string | null>(null);
    const abortRef = useRef<AbortController | null>(null);
    const generatingRef = useRef(false);

    const loadHistory = useCallback(async () => {
        setHistoryLoading(true);
        try {
            const data = await apiRequest("/docs/documents?limit=60&sortBy=createdAt&sortOrder=desc");
            const docs = (data?.data?.documents || []) as Array<{
                documentId: string;
                originalFilename?: string;
                classification?: string;
                createdAt?: string;
                metadata?: { source?: string; generatedVia?: string; phase3Agent?: string };
            }>;
            const filtered = docs
                .filter(isHrGeneratedDoc)
                .slice(0, 12)
                .map((d) => ({
                    documentId: d.documentId,
                    originalFilename: d.originalFilename || "HR document",
                    classification: String(d.classification || "hr_report"),
                    createdAt: d.createdAt || new Date().toISOString(),
                }));
            setHistory(filtered);
        } catch {
            setHistory([]);
        } finally {
            setHistoryLoading(false);
        }
    }, []);

    useEffect(() => {
        void loadHistory();
    }, [loadHistory]);

    const generate = useCallback(
        async (
            actionId: HrReportActionId,
            options?: GenerateOptions
        ): Promise<HrGenerateResult> => {
            const action = HR_REPORT_ACTIONS.find((a) => a.id === actionId);
            if (!action) return { ok: false, message: "Unknown report action." };

            if (generatingRef.current) {
                return { ok: false, message: "Another report is already generating." };
            }

            generatingRef.current = true;
            setGeneratingId(actionId);
            setLastMessage(null);
            abortRef.current?.abort();
            abortRef.current = new AbortController();

            try {
                const body: Record<string, unknown> = { actionId };
                if (actionId === "shortlist") {
                    body.shortlistLimit = options?.shortlistLimit ?? 10;
                }
                if (options?.letterContext) {
                    body.letterContext = options.letterContext;
                }

                const data = await apiRequest("/docs/documents/hr/reports/generate", {
                    method: "POST",
                    body: JSON.stringify(body),
                    signal: abortRef.current.signal,
                    timeoutMs: 120_000,
                });

                const result = data?.data as {
                    ok?: boolean;
                    message?: string;
                    documentId?: string;
                } | null;
                const message = String(result?.message || data?.message || "");
                const documentId = result?.documentId;

                if (documentId && (result?.ok ?? data?.success)) {
                    window.open(generatedPreviewHref(documentId), "_blank", "noopener,noreferrer");
                    void loadHistory();
                    return {
                        ok: true,
                        message: message || `${action.label} ready — opened in a new tab.`,
                        documentId,
                    };
                }

                setLastMessage(message || "No PDF was generated. Check your HR documents in scope.");
                return {
                    ok: false,
                    message: message || "No PDF was generated. Upload HR documents and try again.",
                };
            } catch (e: unknown) {
                if (e instanceof Error && e.name === "AbortError") {
                    return { ok: false, message: "Cancelled." };
                }
                const msg =
                    e instanceof Error
                        ? e.message
                        : typeof (e as { message?: string })?.message === "string"
                          ? (e as { message: string }).message
                          : "Failed to generate report.";
                setLastMessage(msg);
                return { ok: false, message: msg };
            } finally {
                generatingRef.current = false;
                setGeneratingId(null);
            }
        },
        [loadHistory]
    );

    const generateByPrompt = useCallback(
        async (prompt: string): Promise<HrGenerateResult> => {
            const match = HR_REPORT_ACTIONS.find((a) => a.prompt === prompt);
            if (match) return generate(match.id);
            return { ok: false, message: "Use the report cards to generate PDFs." };
        },
        [generate]
    );

    return {
        history,
        historyLoading,
        generatingId,
        lastMessage,
        loadHistory,
        generate,
        generateByPrompt,
        isGenerating: generatingId !== null,
    };
}
