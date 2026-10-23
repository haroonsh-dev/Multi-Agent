import Document from '../models/Document';
import { AuthUser, buildDocumentFilter } from './accessScope';
import type { ChatVisualSpec } from '../types/chatVisuals';
import { filterDocsByAgent } from './documentStorage';

export const OTHER_AGENT = 'other_agent';

export type LoadOtherOptions = {
    maxDocs?: number;
    documentIds?: string[];
};

export type OtherDocSnapshot = {
    documentId: string;
    filename: string;
    classification: string;
    sizeBytes: number;
    mimeType: string;
    pageCount: number;
    status: string;
    createdAt: Date;
    updatedAt: Date;
};

export type OtherAnalyticsResult = {
    snapshots: OtherDocSnapshot[];
    totalDocuments: number;
    totalSizeBytes: number;
    totalPages: number;
    visuals: ChatVisualSpec[];
    citations: Array<{
        documentId: string;
        filename: string;
        documentType: string;
        phase3Agent: string;
    }>;
};

function formatBytes(bytes: number): string {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

export async function loadOtherSnapshots(
    user: AuthUser,
    options: LoadOtherOptions = {}
): Promise<OtherDocSnapshot[]> {
    const maxDocs = options.maxDocs || 100;

    const queryFilter: Record<string, unknown> = {
        status: 'ready',
        $or: [
            { 'metadata.phase3Agent': OTHER_AGENT },
            { classification: 'other' },
        ],
    };
    if (options.documentIds?.length) {
        queryFilter.documentId = { $in: options.documentIds };
    }

    const filter = await buildDocumentFilter(user, queryFilter);
    const raw = await Document.find(filter).sort({ createdAt: -1 }).limit(maxDocs).lean();
    const docs = filterDocsByAgent(raw, OTHER_AGENT);
    if (!docs.length) return [];

    return docs.map((doc) => ({
        documentId: doc.documentId,
        filename: doc.originalFilename || 'Untitled Document',
        classification: doc.classification || 'other',
        sizeBytes: doc.sizeBytes || 0,
        mimeType: doc.mimeType || 'application/pdf',
        pageCount: doc.pageCount || 1,
        status: doc.status || 'ready',
        createdAt: doc.createdAt || new Date(),
        updatedAt: doc.updatedAt || new Date(),
    }));
}

export async function executeOtherAnalytics(
    user: AuthUser,
    options: LoadOtherOptions = {}
): Promise<OtherAnalyticsResult> {
    const snapshots = await loadOtherSnapshots(user, options);

    const totalDocuments = snapshots.length;
    const totalSizeBytes = snapshots.reduce((acc, s) => acc + s.sizeBytes, 0);
    const totalPages = snapshots.reduce((acc, s) => acc + s.pageCount, 0);

    const citations = snapshots.map((s) => ({
        documentId: s.documentId,
        filename: s.filename,
        documentType: s.classification,
        phase3Agent: OTHER_AGENT,
    }));

    const typeCounts = new Map<string, number>();
    for (const s of snapshots) {
        const t = s.classification || 'other';
        typeCounts.set(t, (typeCounts.get(t) || 0) + 1);
    }

    const visuals: ChatVisualSpec[] = [
        {
            id: 'general_doc_type_mix',
            agentId: OTHER_AGENT,
            kind: 'pie',
            title: 'Document type mix',
            categoryKey: 'type',
            series: [{ key: 'count', label: 'Files' }],
            data: [...typeCounts.entries()].map(([type, count]) => ({
                type: type.replace(/_/g, ' '),
                count,
            })),
            emptyState: 'No documents in scope.',
            sourceDocumentIds: snapshots.map((s) => s.documentId),
        },
        {
            id: 'general_doc_catalog_table',
            agentId: OTHER_AGENT,
            kind: 'table',
            title: 'Document catalog',
            categoryKey: 'filename',
            series: [
                { key: 'filename', label: 'File' },
                { key: 'classification', label: 'Type' },
                { key: 'size', label: 'Size' },
                { key: 'pages', label: 'Pages' },
                { key: 'status', label: 'Status' },
            ],
            data: snapshots.map((s) => ({
                filename: s.filename,
                classification: s.classification.replace(/_/g, ' '),
                size: formatBytes(s.sizeBytes),
                pages: s.pageCount,
                status: s.status,
                _documentIds: s.documentId,
            })),
            emptyState: 'No documents in scope.',
            sourceDocumentIds: snapshots.map((s) => s.documentId),
        },
    ];

    return {
        snapshots,
        totalDocuments,
        totalSizeBytes,
        totalPages,
        visuals,
        citations,
    };
}
