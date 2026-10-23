import { getDocumentPreviewUrl } from "./documents";

/** Artifacts created by chat agents (not uploaded source docs for AI extraction). */
const GENERATED_DOC_TYPES = new Set([
    "compliance_report",
    "finance_report",
    "hr_report",
    "hr_shortlist",
    "offer_letter",
    "experience_letter",
    "promotion_letter",
    "warning_letter",
    "relieving_letter",
    "joining_letter",
    "internship_letter",
    "training_certificate",
    "ncr_letter",
    "capa_letter",
    "certificate_of_compliance",
]);

type DocLike = {
    status?: string | null;
    pythonDocumentId?: string | null;
    classification?: string | null;
    metadata?: {
        generatedVia?: string;
        source?: string;
        phase3Agent?: string;
    } | null;
};

export function isGeneratedArtifactDoc(doc: DocLike | null | undefined): boolean {
    if (!doc) return false;
    const c = String(doc.classification || "").toLowerCase();
    if (GENERATED_DOC_TYPES.has(c)) return true;
    const via = String(doc.metadata?.generatedVia || "");
    if (via) return true;
    const source = String(doc.metadata?.source || "");
    return source === "compliance_chat" || source === "hr_chat" || source === "finance_chat";
}

/**
 * Chat-with-document needs AI indexing (pythonDocumentId).
 * Generated PDFs are already complete and should not show a forever "Processing" chat chip.
 */
export function isDocumentChatReady(doc: DocLike | null | undefined): boolean {
    if (!doc) return false;
    if (doc.pythonDocumentId) return true;
    // Generated reports/letters: no AI pipeline — don't block UI as "Processing"
    return false;
}

export function shouldShowChatWithDocument(doc: DocLike | null | undefined): boolean {
    if (!doc) return false;
    if (isGeneratedArtifactDoc(doc)) return false;
    return true;
}

/** Preview path for generated PDFs (skip details intelligence polling). */
export function documentOpenPath(doc: DocLike & { documentId: string }): string {
    if (isGeneratedArtifactDoc(doc)) {
        return `/documents/${encodeURIComponent(doc.documentId)}`;
    }
    return `/documents/details?doc=${encodeURIComponent(doc.documentId)}`;
}

/** Chat markdown links like `/documents/doc_abc` — open native PDF in a new browser tab. */
const GENERATED_PREVIEW_PATH = /^\/documents\/([^/?#]+)$/;

export function parseGeneratedPreviewDocumentId(href: string | undefined): string | null {
    if (!href) return null;
    const match = href.match(GENERATED_PREVIEW_PATH);
    if (!match) return null;
    return decodeURIComponent(match[1]);
}

/** Direct authenticated preview URL for browser PDF viewer (new tab). */
export function generatedPreviewHref(documentId: string): string {
    return getDocumentPreviewUrl(documentId);
}
