"use client";

import React, { useEffect, useState } from "react";
import Link from "next/link";
import { ArrowLeft, Download, Printer } from "lucide-react";
import { useTheme } from "@/context/ColorContext";
import { apiFetchBlob, apiRequest } from "@/lib/apiClient";
import { canPreviewMime, getDocumentDownloadUrl, getDocumentPreviewUrl } from "@/lib/documents";
import { useParams } from "next/navigation";
import * as XLSX from "xlsx";
import JSZip from "jszip";
import mammoth from "mammoth";

type PreviewState =
    | { kind: "none" }
    | { kind: "pdf" | "image" | "audio" | "video"; url: string }
    | { kind: "html"; html: string }
    | { kind: "text"; text: string }
    | { kind: "sheets"; sheets: Array<{ name: string; html: string }> }
    | { kind: "slides"; slides: string[][] };

function ext(name?: string) {
    return name?.split(".").pop()?.toLowerCase() || "";
}

async function extractPptxSlides(blob: Blob): Promise<string[][]> {
    const zip = await JSZip.loadAsync(await blob.arrayBuffer());
    const slideNames = Object.keys(zip.files)
        .filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
        .sort((a, b) => {
            const ai = Number(a.match(/slide(\d+)\.xml$/)?.[1] || 0);
            const bi = Number(b.match(/slide(\d+)\.xml$/)?.[1] || 0);
            return ai - bi;
        });

    const parser = new DOMParser();
    const slides: string[][] = [];
    for (const name of slideNames) {
        const xml = await zip.files[name].async("text");
        const doc = parser.parseFromString(xml, "application/xml");
        const textNodes = Array.from(doc.getElementsByTagName("a:t"))
            .map((node) => node.textContent?.trim() || "")
            .filter(Boolean);
        slides.push(textNodes);
    }
    return slides;
}

function DocumentPreviewContent() {
    const params = useParams();
    const id = params?.id as string;
    const { theme } = useTheme();
    const colors = theme.colors;
    const [doc, setDoc] = useState<any>(null);
    const [error, setError] = useState<string | null>(null);
    const [preview, setPreview] = useState<PreviewState>({ kind: "none" });
    const [previewLoading, setPreviewLoading] = useState(false);

    useEffect(() => {
        if (!id) return;
        apiRequest(`/docs/documents/${id}`)
            .then((data) => setDoc(data?.data?.document))
            .catch((e) => setError(e.message));
    }, [id]);

    useEffect(() => {
        if (!id || !doc || !canPreviewMime(doc.mimeType)) {
            setPreview({ kind: "none" });
            return;
        }

        let active = true;
        let objectUrl: string | null = null;
        setPreviewLoading(true);
        setError(null);

        apiFetchBlob(`/docs/documents/${id}/preview`)
            .then(async (blob) => {
                if (!active) return;
                const mime = String(doc.mimeType || blob.type || "").toLowerCase();
                const extension = ext(doc.originalFilename);

                if (mime === "application/pdf") {
                    objectUrl = URL.createObjectURL(blob);
                    setPreview({ kind: "pdf", url: objectUrl });
                    return;
                }
                if (mime.startsWith("image/")) {
                    objectUrl = URL.createObjectURL(blob);
                    setPreview({ kind: "image", url: objectUrl });
                    return;
                }
                if (mime.startsWith("audio/")) {
                    objectUrl = URL.createObjectURL(blob);
                    setPreview({ kind: "audio", url: objectUrl });
                    return;
                }
                if (mime.startsWith("video/")) {
                    objectUrl = URL.createObjectURL(blob);
                    setPreview({ kind: "video", url: objectUrl });
                    return;
                }
                if (
                    mime.includes("sheet") ||
                    mime.includes("excel") ||
                    mime === "text/csv" ||
                    extension === "xlsx" ||
                    extension === "xls" ||
                    extension === "csv"
                ) {
                    const workbook = XLSX.read(await blob.arrayBuffer(), { type: "array" });
                    const sheets = workbook.SheetNames.map((name: string) => ({
                        name,
                        html: XLSX.utils.sheet_to_html(workbook.Sheets[name]),
                    }));
                    setPreview({ kind: "sheets", sheets });
                    return;
                }
                if (
                    mime === "text/html" ||
                    extension === "html" ||
                    extension === "htm"
                ) {
                    const html = await blob.text();
                    setPreview({ kind: "html", html });
                    return;
                }
                if (mime.includes("word") || extension === "docx" || extension === "doc") {
                    const result = await mammoth.convertToHtml({ arrayBuffer: await blob.arrayBuffer() });
                    setPreview({ kind: "html", html: result.value || "<p>No preview content found.</p>" });
                    return;
                }
                if (mime.includes("presentation") || mime.includes("powerpoint") || extension === "pptx" || extension === "ppt") {
                    const slides = await extractPptxSlides(blob);
                    setPreview({ kind: "slides", slides });
                    return;
                }
                if (
                    mime.startsWith("text/") ||
                    mime === "application/json" ||
                    mime === "application/xml" ||
                    mime === "text/xml"
                ) {
                    const text = await blob.text();
                    setPreview({ kind: "text", text });
                    return;
                }

                objectUrl = URL.createObjectURL(blob);
                setPreview({ kind: "pdf", url: objectUrl });
            })
            .catch((e) => {
                if (!active) return;
                setPreview({ kind: "none" });
                setError(e.message || "Could not load preview. Is the API server running?");
            })
            .finally(() => {
                if (active) setPreviewLoading(false);
            });

        return () => {
            active = false;
            if (objectUrl) URL.revokeObjectURL(objectUrl);
        };
    }, [id, doc]);

    const downloadUrl = id ? getDocumentDownloadUrl(id) : "";
    const canPreview = doc && canPreviewMime(doc.mimeType);
    const isOfferLetter =
        String(doc?.classification || "").toLowerCase() === "offer_letter" ||
        /\boffer[\s_-]?letter\b/i.test(String(doc?.originalFilename || ""));

    const isExperienceLetter =
        String(doc?.classification || "").toLowerCase() === "experience_letter" ||
        /\bexperience[\s_-]?letter\b/i.test(String(doc?.originalFilename || ""));

    const isComplianceReport =
        String(doc?.classification || "").toLowerCase() === "compliance_report" ||
        /\bcompliance[\s_-]?report\b/i.test(String(doc?.originalFilename || ""));

    const printPdf = () => {
        if (!id) return;
        const url = getDocumentPreviewUrl(id);
        const win = window.open(url, "_blank", "noopener,noreferrer");
        if (!win) return;
        win.addEventListener("load", () => {
            try {
                win.focus();
                win.print();
            } catch {
                /* browser may block auto-print */
            }
        });
    };

    const printHtml = () => {
        if (preview.kind !== "html") return;
        const win = window.open("", "_blank", "noopener,noreferrer");
        if (!win) return;
        win.document.write(preview.html);
        win.document.close();
        win.focus();
        win.print();
    };

    return (
        <div className="p-4 sm:p-6 lg:p-8 max-w-5xl mx-auto space-y-4">
            <Link href="/documents" className={`inline-flex items-center gap-2 text-sm ${colors.textMuted} hover:text-accent`}>
                <ArrowLeft size={14} /> Back to library
            </Link>

            {error && <div className="text-red-300 text-sm">{error}</div>}
            {!doc && !error && <div className={colors.textMuted}>Loading preview…</div>}

            {doc && (
                <>
                    <div className="flex flex-wrap items-center justify-between gap-3">
                        <div>
                            <h1 className={`text-lg sm:text-xl font-bold break-all ${colors.textPrimary}`}>{doc.originalFilename}</h1>
                            <p className={`text-sm ${colors.textMuted}`}>
                                {isOfferLetter ? "Offer letter · " : ""}
                                {isExperienceLetter ? "Experience letter · " : ""}
                                {isComplianceReport ? "Compliance report · " : ""}
                                {doc.mimeType} · {doc.status}
                            </p>
                        </div>
                        <div className="flex flex-wrap items-center gap-2">
                            {preview.kind === "pdf" && (
                                <button
                                    type="button"
                                    onClick={printPdf}
                                    className="btn-gradient rounded-xl px-4 py-2.5 text-sm flex items-center gap-2"
                                >
                                    <Printer size={14} /> Print
                                </button>
                            )}
                            {preview.kind === "html" && (
                                <button
                                    type="button"
                                    onClick={printHtml}
                                    className="btn-gradient rounded-xl px-4 py-2.5 text-sm flex items-center gap-2"
                                >
                                    <Printer size={14} /> Print / Save PDF
                                </button>
                            )}
                            <a href={downloadUrl} className="btn-secondary rounded-xl px-4 py-2.5 text-sm flex items-center gap-2">
                                <Download size={14} /> Download
                            </a>
                        </div>
                    </div>

                    <div className="surface-card overflow-hidden min-h-[60vh]">
                        {canPreview ? (
                            previewLoading ? (
                                <div className={`p-12 text-center ${colors.textMuted}`}>Loading preview…</div>
                            ) : (
                                <>
                                    {preview.kind === "pdf" && (
                                        <iframe src={preview.url} className="w-full h-[70vh] border-0 bg-white" title="PDF preview" />
                                    )}
                                    {preview.kind === "image" && (
                                        <div className="p-4 flex justify-center bg-slate-50">
                                            {/* eslint-disable-next-line @next/next/no-img-element */}
                                            <img src={preview.url} alt={doc.originalFilename} className="max-h-[70vh] max-w-full object-contain rounded-lg shadow-sm" />
                                        </div>
                                    )}
                                    {preview.kind === "audio" && (
                                        <div className="p-10">
                                            <audio controls src={preview.url} className="w-full" />
                                        </div>
                                    )}
                                    {preview.kind === "video" && (
                                        <div className="p-4 bg-black">
                                            <video controls src={preview.url} className="w-full max-h-[70vh]" />
                                        </div>
                                    )}
                                    {preview.kind === "text" && (
                                        <pre className="m-0 max-h-[70vh] overflow-auto p-5 text-sm whitespace-pre-wrap break-words bg-slate-50 text-slate-800">
                                            {preview.text}
                                        </pre>
                                    )}
                                    {preview.kind === "html" && (
                                        <div
                                            className="max-h-[70vh] overflow-auto p-6 prose prose-slate max-w-none"
                                            dangerouslySetInnerHTML={{ __html: preview.html }}
                                        />
                                    )}
                                    {preview.kind === "sheets" && (
                                        <div className="max-h-[70vh] overflow-auto p-4 space-y-5 bg-slate-50">
                                            {preview.sheets.map((sheet) => (
                                                <section key={sheet.name} className="rounded-xl border border-slate-200 bg-white overflow-hidden">
                                                    <div className="px-4 py-3 border-b border-slate-200 font-semibold text-slate-800">
                                                        {sheet.name}
                                                    </div>
                                                    <div
                                                        className="overflow-auto p-4 [&_table]:min-w-full [&_table]:border-collapse [&_td]:border [&_td]:border-slate-200 [&_td]:px-2 [&_td]:py-1.5 [&_th]:border [&_th]:border-slate-200 [&_th]:bg-slate-100 [&_th]:px-2 [&_th]:py-1.5"
                                                        dangerouslySetInnerHTML={{ __html: sheet.html }}
                                                    />
                                                </section>
                                            ))}
                                        </div>
                                    )}
                                    {preview.kind === "slides" && (
                                        <div className="max-h-[70vh] overflow-auto p-5 space-y-4 bg-slate-50">
                                            {preview.slides.length ? (
                                                preview.slides.map((slide, index) => (
                                                    <section key={index} className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
                                                        <h2 className="text-sm font-semibold text-slate-800 mb-3">
                                                            Slide {index + 1}
                                                        </h2>
                                                        <ul className="space-y-2 text-sm text-slate-700">
                                                            {slide.length ? (
                                                                slide.map((line, i) => <li key={i}>{line}</li>)
                                                            ) : (
                                                                <li className="text-slate-400">No extractable text on this slide.</li>
                                                            )}
                                                        </ul>
                                                    </section>
                                                ))
                                            ) : (
                                                <div className={`p-12 text-center ${colors.textMuted}`}>
                                                    No slide text could be extracted.
                                                </div>
                                            )}
                                        </div>
                                    )}
                                    {preview.kind === "none" && (
                                        <div className={`p-12 text-center ${colors.textMuted}`}>
                                            <p>Preview could not be loaded.</p>
                                            <a href={downloadUrl} className="btn-gradient inline-flex mt-4 rounded-xl px-4 py-2 text-sm">Download file</a>
                                        </div>
                                    )}
                                </>
                            )
                        ) : (
                            <div className={`p-12 text-center ${colors.textMuted}`}>
                                <p>Preview not available for this file type.</p>
                                <a href={downloadUrl} className="btn-gradient inline-flex mt-4 rounded-xl px-4 py-2 text-sm">Download file</a>
                            </div>
                        )}
                    </div>
                </>
            )}
        </div>
    );
}

export default function DocumentPreviewPage() {
    return (
        <DocumentPreviewContent />
    );
}
