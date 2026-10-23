import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import mongoose from 'mongoose';
import Document from '../models/Document';
import { getMcpContext, McpTenantContext } from './context';
import { getAgentFleetSnapshot } from '../services/agentFleetService';
import { getOrgWorkflowSummary } from '../services/agentWorkflowExecutionService';
import { ANALYTICS_AGENT_IDS, AnalyticsAgentId } from '../constants/agentCatalog';

export const TEXT_SIZE_LIMIT = 4000;

/**
 * Truncates raw text payload to 4,000 characters if it exceeds the limit,
 * appending an explicit indicator of remaining characters and setting truncated: true.
 */
export function truncateTextPayload(text?: string | null): { text: string; truncated: boolean } {
    if (!text || typeof text !== 'string') {
        return { text: '', truncated: false };
    }
    if (text.length <= TEXT_SIZE_LIMIT) {
        return { text, truncated: false };
    }
    const truncated = text.slice(0, TEXT_SIZE_LIMIT);
    const remaining = text.length - TEXT_SIZE_LIMIT;
    return {
        text: `${truncated}\n\n[Truncated: ${remaining} characters remaining]`,
        truncated: true,
    };
}

/**
 * Retrieves the test harness fixture store if available (used in offline / test modes).
 */
function getHarnessFixtureStore(): any | null {
    try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const harness = require('../scripts/mcpE2eTestHarness');
        return harness?.fixtureStore || null;
    } catch {
        return null;
    }
}

export interface DocumentResourcePayload {
    documentId: string;
    filename: string;
    originalFilename: string;
    mimeType: string;
    sizeBytes: number;
    classification: string | null;
    status: string;
    visibilityScope?: string;
    metadata: Record<string, unknown>;
    content: string;
    rawText: string;
    truncated: boolean;
    createdAt: string;
    updatedAt: string;
}

/**
 * Hydrates full document payload for the active tenant with size protection.
 */
export async function readDocumentResource(
    documentId: string,
    customContext?: McpTenantContext
): Promise<DocumentResourcePayload> {
    if (!documentId || typeof documentId !== 'string') {
        throw new Error('documentId is required');
    }

    const context = customContext || getMcpContext();

    // 1. Live MongoDB lookup when connected
    if (mongoose.connection && mongoose.connection.readyState === 1) {
        const doc = await Document.findOne({
            documentId,
            organizationId: context.organizationId,
        }).lean();

        if (doc) {
            let text = '';
            if (typeof (doc as any).rawText === 'string') {
                text = (doc as any).rawText;
            } else if (typeof (doc as any).ocrText === 'string') {
                text = (doc as any).ocrText;
            } else if (typeof doc.metadata?.rawText === 'string') {
                text = doc.metadata.rawText as string;
            } else if (typeof doc.metadata?.ocrText === 'string') {
                text = doc.metadata.ocrText as string;
            } else if (typeof doc.metadata?.text === 'string') {
                text = doc.metadata.text as string;
            }

            const truncatedResult = truncateTextPayload(text);

            return {
                documentId: doc.documentId,
                filename: doc.originalFilename,
                originalFilename: doc.originalFilename,
                mimeType: doc.mimeType,
                sizeBytes: doc.sizeBytes,
                classification: doc.classification || null,
                status: doc.status,
                visibilityScope: doc.visibilityScope,
                metadata: (doc.metadata as Record<string, unknown>) || {},
                content: truncatedResult.text,
                rawText: truncatedResult.text,
                truncated: truncatedResult.truncated,
                createdAt: doc.createdAt instanceof Date ? doc.createdAt.toISOString() : String(doc.createdAt),
                updatedAt: doc.updatedAt instanceof Date ? doc.updatedAt.toISOString() : String(doc.updatedAt),
            };
        }

        // Check if document belongs to a different tenant for cross-tenant rejection
        const crossOrgDoc = await Document.findOne({ documentId }).select('organizationId').lean();
        if (crossOrgDoc && crossOrgDoc.organizationId !== context.organizationId) {
            throw new Error(`Document ${documentId} not found in tenant ${context.organizationId}`);
        }
    }

    // 2. Fallback to fixture store for offline / test harness environments
    const fixtureStore = getHarnessFixtureStore();
    if (fixtureStore) {
        const mockDoc = fixtureStore.documents.get(documentId);
        if (mockDoc) {
            if (mockDoc.organizationId !== context.organizationId) {
                throw new Error(`Document ${documentId} not found in tenant ${context.organizationId}`);
            }

            const text =
                mockDoc.rawText ||
                mockDoc.ocrText ||
                (mockDoc.metadata?.rawText as string) ||
                (mockDoc.metadata?.ocrText as string) ||
                '';
            const truncatedResult = truncateTextPayload(text);

            return {
                documentId: mockDoc.documentId,
                filename: mockDoc.originalFilename,
                originalFilename: mockDoc.originalFilename,
                mimeType: mockDoc.mimeType,
                sizeBytes: mockDoc.sizeBytes,
                classification: mockDoc.classification || null,
                status: mockDoc.status,
                visibilityScope: mockDoc.visibilityScope,
                metadata: mockDoc.metadata || {},
                content: truncatedResult.text,
                rawText: truncatedResult.text,
                truncated: truncatedResult.truncated,
                createdAt:
                    mockDoc.createdAt instanceof Date
                        ? mockDoc.createdAt.toISOString()
                        : String(mockDoc.createdAt),
                updatedAt:
                    mockDoc.updatedAt instanceof Date
                        ? mockDoc.updatedAt.toISOString()
                        : String(mockDoc.updatedAt),
            };
        }
    }

    throw new Error(`Document ${documentId} not found in tenant ${context.organizationId}`);
}

export interface OverviewResourcePayload {
    organizationId: string;
    organizationName?: string;
    totalDocuments: number;
    breakdownByClassification: Record<string, number>;
    portfolioReadiness: {
        timestamp: string;
        agents: Array<{
            agentId: string;
            documentCount: number;
            readyCount: number;
            healthScore: number;
            healthLabel: string;
        }>;
    };
    pendingApprovals: {
        invoices: Array<{ documentId: string; filename: string; verdict: string }>;
        certificates: Array<{ documentId: string; filename: string; verdict: string }>;
        candidates: Array<{ documentId: string; filename: string; verdict: string }>;
        contracts: Array<{ documentId: string; filename: string }>;
        totalPending: number;
    };
    workflowKpis: {
        autoApprovedInvoices: number;
        pendingApprovals: number;
        expiringCertificates: number;
        shortlistedCandidates: number;
        flaggedRisks: number;
    };
    recentExecutions: any[];
    timestamp: string;
}

/**
 * Returns live organization statistics (total documents, breakdown by classification,
 * portfolio readiness health, pending approvals, and workflow KPIs) for the active tenant.
 */
export async function readOverviewResource(
    customContext?: McpTenantContext
): Promise<OverviewResourcePayload> {
    const context = customContext || getMcpContext();

    // 1. Live MongoDB statistics when connected
    if (mongoose.connection && mongoose.connection.readyState === 1) {
        try {
            // Total documents
            const totalDocuments = await Document.countDocuments({
                organizationId: context.organizationId,
            });

            // Classification breakdown
            const classAgg = await Document.aggregate([
                { $match: { organizationId: context.organizationId } },
                {
                    $group: {
                        _id: { $ifNull: ['$classification', 'unclassified'] },
                        count: { $sum: 1 },
                    },
                },
            ]);
            const breakdownByClassification: Record<string, number> = {};
            for (const item of classAgg) {
                breakdownByClassification[String(item._id)] = item.count;
            }

            // Portfolio readiness health
            let agentStats: OverviewResourcePayload['portfolioReadiness']['agents'] = [];
            try {
                const fleet = await getAgentFleetSnapshot(context.user);
                agentStats = fleet.agents.map((a) => ({
                    agentId: a.agentId,
                    documentCount: a.documentCount,
                    readyCount: a.readyCount,
                    healthScore: a.healthScore,
                    healthLabel: a.healthLabel,
                }));
            } catch {
                agentStats = ANALYTICS_AGENT_IDS.map((agentId) => ({
                    agentId,
                    documentCount: 0,
                    readyCount: 0,
                    healthScore: 0,
                    healthLabel: 'Empty',
                }));
            }

            // Workflow KPIs & summary
            let summaryKpis = {
                autoApprovedInvoices: 0,
                pendingApprovals: 0,
                expiringCertificates: 0,
                shortlistedCandidates: 0,
                flaggedRisks: 0,
            };
            let recentExecutions: any[] = [];
            try {
                const summary = await getOrgWorkflowSummary(context.organizationId);
                summaryKpis = {
                    autoApprovedInvoices: summary.autoApprovedInvoices,
                    pendingApprovals: summary.pendingApprovals,
                    expiringCertificates: summary.expiringCertificates,
                    shortlistedCandidates: summary.shortlistedCandidates,
                    flaggedRisks: summary.flaggedRisks,
                };
                recentExecutions = summary.recentExecutions;
            } catch {
                // Ignore workflow summary failure in partial setups
            }

            // Categorized pending approvals list
            const pendingDocs = await Document.find({
                organizationId: context.organizationId,
                $or: [
                    { status: 'review' },
                    {
                        'metadata.workflowExecution.stage': {
                            $in: ['pending_approval', 'flagged', 'shortlisted'],
                        },
                    },
                ],
            })
                .select('documentId originalFilename classification status metadata')
                .lean();

            const pendingInvoices: Array<{ documentId: string; filename: string; verdict: string }> = [];
            const expiringCertificates: Array<{ documentId: string; filename: string; verdict: string }> = [];
            const shortlistedCandidates: Array<{ documentId: string; filename: string; verdict: string }> = [];
            const pendingContracts: Array<{ documentId: string; filename: string }> = [];

            for (const doc of pendingDocs) {
                const wf = doc.metadata?.workflowExecution as any;
                if (
                    doc.classification === 'invoice' &&
                    (doc.status === 'review' || wf?.stage === 'pending_approval')
                ) {
                    pendingInvoices.push({
                        documentId: doc.documentId,
                        filename: doc.originalFilename,
                        verdict: wf?.verdict || 'Awaiting Review',
                    });
                } else if (doc.classification === 'certificate' && wf?.stage === 'flagged') {
                    expiringCertificates.push({
                        documentId: doc.documentId,
                        filename: doc.originalFilename,
                        verdict: wf?.verdict || 'Expiring Certificate',
                    });
                } else if (doc.classification === 'resume' && wf?.stage === 'shortlisted') {
                    shortlistedCandidates.push({
                        documentId: doc.documentId,
                        filename: doc.originalFilename,
                        verdict: wf?.verdict || 'Shortlisted Candidate',
                    });
                } else if (doc.classification === 'contract' && doc.status === 'review') {
                    pendingContracts.push({
                        documentId: doc.documentId,
                        filename: doc.originalFilename,
                    });
                }
            }

            const totalPending =
                pendingInvoices.length +
                expiringCertificates.length +
                shortlistedCandidates.length +
                pendingContracts.length;

            return {
                organizationId: context.organizationId,
                organizationName: context.organizationName,
                totalDocuments,
                breakdownByClassification,
                portfolioReadiness: {
                    timestamp: new Date().toISOString(),
                    agents: agentStats,
                },
                pendingApprovals: {
                    invoices: pendingInvoices,
                    certificates: expiringCertificates,
                    candidates: shortlistedCandidates,
                    contracts: pendingContracts,
                    totalPending,
                },
                workflowKpis: summaryKpis,
                recentExecutions,
                timestamp: new Date().toISOString(),
            };
        } catch (dbError) {
            // Fall through to test fixture lookup if DB aggregation fails
        }
    }

    // 2. Fallback to fixture store for offline / test harness environments
    const fixtureStore = getHarnessFixtureStore();
    if (fixtureStore) {
        const tenantDocs: any[] = [];
        for (const doc of fixtureStore.documents.values()) {
            if (doc.organizationId === context.organizationId) {
                tenantDocs.push(doc);
            }
        }

        const breakdownByClassification: Record<string, number> = {};
        for (const doc of tenantDocs) {
            const cls = doc.classification || 'unclassified';
            breakdownByClassification[cls] = (breakdownByClassification[cls] || 0) + 1;
        }

        const agentStats: OverviewResourcePayload['portfolioReadiness']['agents'] = [];
        for (const agentId of ANALYTICS_AGENT_IDS) {
            let docCount = 0;
            let readyCount = 0;
            for (const doc of tenantDocs) {
                if (doc.metadata?.phase3Agent === agentId) {
                    docCount += 1;
                    if (doc.status === 'ready' || doc.status === 'review') {
                        readyCount += 1;
                    }
                }
            }
            const healthScore = docCount > 0 ? Math.round((readyCount / docCount) * 100) : 0;
            let healthLabel = 'Empty';
            if (docCount > 0) {
                if (healthScore >= 85) healthLabel = 'Ready';
                else if (healthScore >= 45) healthLabel = 'Partial';
                else healthLabel = 'Needs work';
            }
            agentStats.push({
                agentId,
                documentCount: docCount,
                readyCount,
                healthScore,
                healthLabel,
            });
        }

        const pendingInvoices: Array<{ documentId: string; filename: string; verdict: string }> = [];
        const expiringCertificates: Array<{ documentId: string; filename: string; verdict: string }> = [];
        const shortlistedCandidates: Array<{ documentId: string; filename: string; verdict: string }> = [];
        const pendingContracts: Array<{ documentId: string; filename: string }> = [];

        let autoApprovedInvoices = 0;
        let pendingApprovalsCount = 0;
        let expiringCertificatesCount = 0;
        let shortlistedCandidatesCount = 0;
        let flaggedRisks = 0;

        for (const doc of tenantDocs) {
            const wf = doc.metadata?.workflowExecution as any;
            if (wf?.stage === 'auto_approved') autoApprovedInvoices += 1;
            if (wf?.stage === 'pending_approval') pendingApprovalsCount += 1;
            if (wf?.stage === 'flagged' && doc.classification === 'certificate') expiringCertificatesCount += 1;
            if (wf?.stage === 'shortlisted') shortlistedCandidatesCount += 1;
            if (wf?.stage === 'flagged' && (doc.classification === 'invoice' || wf?.agentId === 'legal_agent')) {
                flaggedRisks += 1;
            }

            if (doc.classification === 'invoice' && (doc.status === 'review' || wf?.stage === 'pending_approval')) {
                pendingInvoices.push({
                    documentId: doc.documentId,
                    filename: doc.originalFilename,
                    verdict: wf?.verdict || 'Awaiting Review',
                });
            } else if (doc.classification === 'certificate' && wf?.stage === 'flagged') {
                expiringCertificates.push({
                    documentId: doc.documentId,
                    filename: doc.originalFilename,
                    verdict: wf?.verdict || 'Expiring Certificate',
                });
            } else if (doc.classification === 'resume' && wf?.stage === 'shortlisted') {
                shortlistedCandidates.push({
                    documentId: doc.documentId,
                    filename: doc.originalFilename,
                    verdict: wf?.verdict || 'Shortlisted Candidate',
                });
            } else if (doc.classification === 'contract' && doc.status === 'review') {
                pendingContracts.push({
                    documentId: doc.documentId,
                    filename: doc.originalFilename,
                });
            }
        }

        const recentExecutions = fixtureStore.activityLogs
            ? fixtureStore.activityLogs
                  .filter((l: any) => l.organizationId === context.organizationId)
                  .slice(-10)
            : [];

        const totalPending =
            pendingInvoices.length +
            expiringCertificates.length +
            shortlistedCandidates.length +
            pendingContracts.length;

        return {
            organizationId: context.organizationId,
            organizationName: context.organizationName,
            totalDocuments: tenantDocs.length,
            breakdownByClassification,
            portfolioReadiness: {
                timestamp: new Date().toISOString(),
                agents: agentStats,
            },
            pendingApprovals: {
                invoices: pendingInvoices,
                certificates: expiringCertificates,
                candidates: shortlistedCandidates,
                contracts: pendingContracts,
                totalPending,
            },
            workflowKpis: {
                autoApprovedInvoices,
                pendingApprovals: pendingApprovalsCount,
                expiringCertificates: expiringCertificatesCount,
                shortlistedCandidates: shortlistedCandidatesCount,
                flaggedRisks,
            },
            recentExecutions,
            timestamp: new Date().toISOString(),
        };
    }

    // Default empty overview for isolated environments
    return {
        organizationId: context.organizationId,
        organizationName: context.organizationName,
        totalDocuments: 0,
        breakdownByClassification: {},
        portfolioReadiness: {
            timestamp: new Date().toISOString(),
            agents: ANALYTICS_AGENT_IDS.map((agentId) => ({
                agentId,
                documentCount: 0,
                readyCount: 0,
                healthScore: 0,
                healthLabel: 'Empty',
            })),
        },
        pendingApprovals: {
            invoices: [],
            certificates: [],
            candidates: [],
            contracts: [],
            totalPending: 0,
        },
        workflowKpis: {
            autoApprovedInvoices: 0,
            pendingApprovals: 0,
            expiringCertificates: 0,
            shortlistedCandidates: 0,
            flaggedRisks: 0,
        },
        recentExecutions: [],
        timestamp: new Date().toISOString(),
    };
}

/**
 * Registers all MCP standard resources on the provided McpServer instance:
 * 1. docs://documents/{documentId} - Full document payload with 4,000 char size protection
 * 2. docs://overview - Live organization statistics, readiness health, and workflow KPIs
 */
export function registerMcpResources(server: McpServer): void {
    // 1. Dynamic document payload resource template: docs://documents/{documentId}
    server.resource(
        'document',
        new ResourceTemplate('docs://documents/{documentId}', { list: undefined }),
        {
            description: 'Hydrated document payload for the active tenant with 4,000-character raw text size protection',
            mimeType: 'application/json',
        },
        async (uri, variables) => {
            const documentId = Array.isArray(variables.documentId)
                ? variables.documentId[0]
                : String(variables.documentId || '').trim();

            const payload = await readDocumentResource(documentId);
            const uriString = typeof uri === 'string' ? uri : uri.href || uri.toString();

            return {
                contents: [
                    {
                        uri: uriString,
                        mimeType: 'application/json',
                        text: JSON.stringify(payload, null, 2),
                    },
                ],
            };
        }
    );

    // 2. Static overview resource: docs://overview
    server.resource(
        'overview',
        'docs://overview',
        {
            description: 'Live organization statistics, portfolio readiness health, pending approvals, and workflow KPIs',
            mimeType: 'application/json',
        },
        async (uri) => {
            const payload = await readOverviewResource();
            const uriString = typeof uri === 'string' ? uri : uri.href || uri.toString();

            return {
                contents: [
                    {
                        uri: uriString,
                        mimeType: 'application/json',
                        text: JSON.stringify(payload, null, 2),
                    },
                ],
            };
        }
    );
}
