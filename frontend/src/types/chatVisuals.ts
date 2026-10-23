export type ChatVisualSeries = {
    key: string;
    label: string;
    color?: string;
};

export type ChatVisualDataRow = Record<string, string | number> & {
    _documentIds?: string;
};

export type ChatVisualAction = {
    label: string;
    kind: "reprocess" | "open_document" | "ask";
    documentId?: string;
    prompt?: string;
};

export type ChatVisualSpec = {
    id: string;
    agentId: string;
    kind: "bar" | "line" | "area" | "pie" | "table";
    title: string;
    subtitle?: string;
    currency?: string;
    categoryKey: string;
    series: ChatVisualSeries[];
    data: ChatVisualDataRow[];
    footer?: string;
    sourceDocumentIds?: string[];
    dataQuality?: {
        level: "high" | "medium" | "low";
        warnings?: string[];
    };
    actions?: ChatVisualAction[];
    emptyState?: string;
};

export type FinanceAnalyticsCoverage = {
    documentsInScope: number;
    documentsWithAmount: number;
    documentsWithClient: number;
    documentsWithVendor: number;
    warnings?: string[];
    files?: Array<{
        documentId: string;
        filename: string;
        status:
            | "in_charts"
            | "missing_amount"
            | "no_extraction"
            | "not_linked"
            | "unsupported_format";
        detail?: string;
    }>;
};

export type ComplianceAnalyticsCoverage = {
    documentsInScope: number;
    documentsWithExpiry: number;
    documentsWithFindings: number;
    warnings?: string[];
    files?: Array<{
        documentId: string;
        filename: string;
        status: "in_charts" | "no_extraction" | "not_linked";
        detail?: string;
    }>;
};

export type AgentAnalyticsCoverage = {
    documentsInScope: number;
    documentsCharted?: number;
    documentsWithAmount?: number;
    documentsWithVendor?: number;
    documentsWithClient?: number;
    documentsWithExpiry?: number;
    documentsWithFindings?: number;
    warnings?: string[];
    files?: Array<{
        documentId: string;
        filename: string;
        status: "in_charts" | "no_extraction" | "not_linked" | "missing_amount" | "unsupported_format";
        detail?: string;
    }>;
};
