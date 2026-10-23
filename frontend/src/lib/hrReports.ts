import { docTypeLabel } from "@/lib/documentAgents";

/** Classifications saved by hrChatReportService */
export const HR_GENERATED_CLASSIFICATIONS = new Set([
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
]);

export type HrReportActionId =
    | "full_report"
    | "shortlist"
    | "cert_report"
    | "leave_report"
    | "payroll_report"
    | "performance_report"
    | "joining_letter"
    | "internship_letter"
    | "training_certificate";

export type HrLetterContext = {
    candidateName?: string;
    companyName?: string;
    jobTitle?: string;
    department?: string;
    effectiveDate?: string;
    trainingName?: string;
    duration?: string;
};

export type HrReportAction = {
    id: HrReportActionId;
    label: string;
    description: string;
    prompt: string;
    group: "reports" | "sections" | "letters";
};

export const HR_REPORT_ACTIONS: HrReportAction[] = [
    {
        id: "full_report",
        label: "Full workforce report",
        description: "PDF snapshot — employees, CVs, certs, leave, payroll",
        prompt: "Generate HR report",
        group: "reports",
    },
    {
        id: "shortlist",
        label: "CV shortlist PDF",
        description: "Top 10 candidates ranked by CV score",
        prompt: "Export shortlist top 10 candidates",
        group: "reports",
    },
    {
        id: "cert_report",
        label: "Certificate register",
        description: "Expiry status and risk highlights",
        prompt: "Generate certificate report",
        group: "sections",
    },
    {
        id: "leave_report",
        label: "Leave applications",
        description: "Time-off requests in portfolio scope",
        prompt: "Generate leave report",
        group: "sections",
    },
    {
        id: "payroll_report",
        label: "Payroll summary",
        description: "Pay runs and salary breakdown",
        prompt: "Generate payroll report",
        group: "sections",
    },
    {
        id: "performance_report",
        label: "Performance reviews",
        description: "Ratings and promotion flags",
        prompt: "Generate performance report",
        group: "sections",
    },
    {
        id: "joining_letter",
        label: "Joining letter",
        description: "Appointment / onboarding letter",
        prompt: "Generate joining letter for new hire. Company Visibility Bots",
        group: "letters",
    },
    {
        id: "internship_letter",
        label: "Internship letter",
        description: "Intern offer or confirmation",
        prompt: "Generate internship letter. Company Visibility Bots",
        group: "letters",
    },
    {
        id: "training_certificate",
        label: "Training certificate",
        description: "Course completion certificate",
        prompt: "Generate training certificate. Company Visibility Bots",
        group: "letters",
    },
];

export type HrGeneratedDoc = {
    documentId: string;
    originalFilename: string;
    classification: string;
    createdAt: string;
};

export function isHrGeneratedDoc(doc: {
    classification?: string | null;
    metadata?: { source?: string; generatedVia?: string; phase3Agent?: string } | null;
}): boolean {
    const cls = String(doc.classification || "").toLowerCase();
    if (HR_GENERATED_CLASSIFICATIONS.has(cls)) return true;
    const source = String(doc.metadata?.source || "");
    if (source === "hr_chat") return true;
    const via = String(doc.metadata?.generatedVia || "");
    if (via && doc.metadata?.phase3Agent === "hr_agent") return true;
    return false;
}

export function hrGeneratedDocLabel(doc: HrGeneratedDoc): string {
    const fromName = doc.originalFilename?.replace(/\.pdf$/i, "").trim();
    if (fromName) return fromName;
    return docTypeLabel(doc.classification);
}

export function extractDocumentIdsFromHrReply(
    reply: string,
    citations?: Array<{ documentId?: string; document_id?: string }>
): string[] {
    const fromCitations = (citations || [])
        .map((c) => c.documentId || c.document_id)
        .filter((id): id is string => Boolean(id));
    const fromLinks: string[] = [];
    const re = /\/documents\/([^/?#\s)]+)/g;
    let match: RegExpExecArray | null;
    while ((match = re.exec(reply))) {
        fromLinks.push(decodeURIComponent(match[1]));
    }
    return [...new Set([...fromCitations, ...fromLinks])];
}
