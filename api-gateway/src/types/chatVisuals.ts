/** Agent chat visualization payloads returned with chat API responses. */

export type ChatVisualSeries = {
    key: string;
    label: string;
    color?: string;
};

/** Row values for charts; `_documentIds` is comma-separated Mongo documentIds for drill-down. */
export type ChatVisualDataRow = Record<string, string | number> & {
    _documentIds?: string;
};

export type ChatVisualAction = {
    label: string;
    kind: 'reprocess' | 'open_document' | 'ask';
    documentId?: string;
    prompt?: string;
};

export type ChatVisualSpec = {
    id: string;
    agentId: string;
    kind: 'bar' | 'line' | 'area' | 'pie' | 'table';
    title: string;
    subtitle?: string;
    currency?: string;
    /** Key on each data row for category / x-axis */
    categoryKey: string;
    series: ChatVisualSeries[];
    data: ChatVisualDataRow[];
    footer?: string;
    /** Documents this chart was built from (named-file targeting). */
    sourceDocumentIds?: string[];
    /** Extraction trust signal for the panel. */
    dataQuality?: {
        level: 'high' | 'medium' | 'low';
        warnings?: string[];
    };
    /** Panel actions (reprocess, open doc, follow-up ask). */
    actions?: ChatVisualAction[];
    emptyState?: string;
};

export type FinanceAnalyticsCoverage = {
    documentsInScope: number;
    documentsWithAmount: number;
    documentsWithClient: number;
    documentsWithVendor: number;
    /** Duplicate invoices, alias hints, etc. */
    warnings?: string[];
    files?: Array<{
        documentId: string;
        filename: string;
        status:
            | 'in_charts'
            | 'missing_amount'
            | 'no_extraction'
            | 'not_linked'
            | 'unsupported_format';
        detail?: string;
    }>;
};

export type ComplianceAnalyticsCoverage = {
    documentsInScope: number;
    documentsWithExpiry: number;
    documentsWithFindings: number;
    files?: Array<{
        documentId: string;
        filename: string;
        status: 'in_charts' | 'no_extraction' | 'not_linked';
        detail?: string;
    }>;
};

/** Generic coverage for HR / legal / procurement / other. */
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
        status: 'in_charts' | 'no_extraction' | 'not_linked' | 'missing_amount' | 'unsupported_format';
        detail?: string;
    }>;
};

export type AgentChatVisualResult = {
    handled: boolean;
    answer?: string;
    visuals?: ChatVisualSpec[];
    citations?: Array<{
        documentId: string;
        filename?: string;
        score?: number;
        documentType?: string;
        phase3Agent?: string;
    }>;
    agentId?: string;
    coverage?: FinanceAnalyticsCoverage | ComplianceAnalyticsCoverage | AgentAnalyticsCoverage;
    /** Hint for analytics panel tab (trend, vendors, clients, …). */
    analyticsView?: string;
};
