"use client";

import React, { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { ArrowLeft, Loader2 } from "lucide-react";
import DocumentDetailPanel, { hasModelData, isAnalysisFinished } from "@/components/DocumentDetailPanel";
import { useTheme } from "@/context/ColorContext";
import { apiRequest } from "@/lib/apiClient";
import { isGeneratedArtifactDoc } from "@/lib/generatedDocuments";

function DocumentDetailsContent() {
    const params = useParams();
    const id = params?.id as string;
    const { theme } = useTheme();
    const colors = theme.colors;
    const isDark = theme.name === "dark";

    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [intel, setIntel] = useState<any>(null);
    const [analyzing, setAnalyzing] = useState(false);
    const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
    const attemptedRef = useRef(false);

    const load = useCallback(async () => {
        if (!id) return null;
        setError(null);
        try {
            const data = await apiRequest(`/docs/documents/${id}/intelligence`);
            setIntel(data?.data || null);
            return data?.data;
        } catch (e: any) {
            setError(e.message || "Failed to load document intelligence");
            return null;
        } finally {
            setLoading(false);
        }
    }, [id]);

    const stopPolling = useCallback(() => {
        if (pollRef.current) {
            clearInterval(pollRef.current);
            pollRef.current = null;
        }
    }, []);

    const startPolling = useCallback(() => {
        stopPolling();
        let attempts = 0;
        pollRef.current = setInterval(async () => {
            attempts += 1;
            const data = await load();
            const ai = data?.aiDocument;
            const job = data?.job;
            const docStatus = data?.document?.status;
            if (hasModelData(ai) || isAnalysisFinished(ai, job, docStatus)) {
                stopPolling();
                setAnalyzing(false);
            } else if (attempts >= 60) {
                stopPolling();
                setAnalyzing(false);
            }
        }, 6000);
    }, [load, stopPolling]);

    useEffect(() => {
        if (!id) return;
        setLoading(true);
        stopPolling();
        setAnalyzing(false);
        attemptedRef.current = false;

        (async () => {
            const data = await load();
            if (isGeneratedArtifactDoc(data?.document)) return;
            if (hasModelData(data?.aiDocument) || isAnalysisFinished(data?.aiDocument, data?.job, data?.document?.status)) return;
            if (attemptedRef.current) return;
            attemptedRef.current = true;

            const stage = String(data?.job?.stage || data?.job?.status || "").toLowerCase();
            const aiStatus = String(data?.aiDocument?.status || "").toLowerCase();
            const docStatus = data?.document?.status;
            const alreadyRunning =
                ["queued", "running", "processing", "ocr_processing", "classifying", "extracting", "embedding"].some(
                    (s) => stage.includes(s) || aiStatus.includes(s)
                ) ||
                docStatus === "processing" ||
                docStatus === "uploaded";

            setAnalyzing(true);
            if (!alreadyRunning) {
                try {
                    await apiRequest(`/docs/documents/${id}/processing?runModel=true`);
                } catch {
                    /* may still trigger */
                }
            }
            startPolling();
        })();

        return () => stopPolling();
    }, [id, load, startPolling, stopPolling]);

    const doc = intel?.document;
    const aiDoc = intel?.aiDocument;

    const isProcessing =
        (analyzing || doc?.status === "processing" || doc?.status === "uploaded") &&
        !isAnalysisFinished(aiDoc, intel?.job, doc?.status);

    useEffect(() => {
        if (!isProcessing || analyzing) return;
        const interval = setInterval(load, 8000);
        return () => clearInterval(interval);
    }, [isProcessing, analyzing, load]);

    return (
        <div className="p-4 sm:p-6 lg:p-8 max-w-5xl mx-auto space-y-6">
            <Link href="/documents" className={`inline-flex items-center gap-2 text-sm ${colors.textMuted} hover:text-white`}>
                <ArrowLeft size={14} /> Back to library
            </Link>

            {loading && !doc && (
                <div className={`flex items-center gap-2 text-sm ${colors.textMuted}`}>
                    <Loader2 size={16} className="animate-spin" /> Loading document details…
                </div>
            )}
            {error && <div className="text-red-300 text-sm">{error}</div>}

            {doc && (
                <div className="surface-card p-6">
                    <DocumentDetailPanel
                        doc={doc}
                        ai={aiDoc}
                        isDark={isDark}
                        colors={colors}
                        analyzing={analyzing && !isAnalysisFinished(aiDoc, intel?.job, doc?.status)}
                    />
                </div>
            )}
        </div>
    );
}

export default function DocumentDetailsPage() {
    return (
        <DocumentDetailsContent />
    );
}
