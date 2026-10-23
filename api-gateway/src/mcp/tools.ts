import mongoose from 'mongoose';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ANALYTICS_AGENT_IDS } from '../constants/agentCatalog';
import { getMcpContext } from './context';
import Document from '../models/Document';
import { recordActivity } from '../services/activityLog';
import { buildDocumentFilter } from '../services/accessScope';
import { getAgentFleetSnapshot } from '../services/agentFleetService';
import { getOrgWorkflowSummary } from '../services/agentWorkflowExecutionService';
import { chatWithDocuments } from '../controllers/chatController';

// ============================================================================
// Constants & Utilities
// ============================================================================

export const TEXT_SIZE_LIMIT = 4000;

/**
 * Truncates raw text to 4,000 characters with an explicit indicator if exceeded.
 */
export function truncateTextPayload(text?: string | null): { text: string; truncated: boolean } {
    if (!text) return { text: '', truncated: false };
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
 * Helper to safely resolve the test harness fixture store when MongoDB is disconnected.
 */
function getHarness(): any {
    try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        return require('../scripts/mcpE2eTestHarness');
    } catch {
        return null;
    }
}

// ============================================================================
// Tool Implementation Handlers
// ============================================================================

/**
 * Tool 1: ask_agent
 * Dispatches queries to one of the 6 canonical domain agents with optional document context.
 */
export async function handleAskAgent(args: {
    agent_id: string;
    message: string;
    document_ids?: string[];
}): Promise<Record<string, any>> {
    const context = getMcpContext();
    const { agent_id, message, document_ids } = args;

    if (!agent_id || !(ANALYTICS_AGENT_IDS as readonly string[]).includes(agent_id as any)) {
        throw new Error(`Invalid agent_id: ${agent_id}. Allowed: ${ANALYTICS_AGENT_IDS.join(', ')}`);
    }
    if (!message || typeof message !== 'string' || !message.trim()) {
        throw new Error('Message is required and must be a string');
    }

    const attachedDocs: string[] = [];

    // Live MongoDB mode — call the real chat/RAG pipeline (same one the REST
    // Agent API and the product's own chat UI use), instead of the placeholder
    // echo this returned before. Mirrors controllers/agentApiController.ts's
    // askAgentViaApi, which does the same req/body normalization then calls
    // chatWithDocuments directly.
    if (mongoose.connection.readyState === 1) {
        const chatReq = {
            user: context.user,
            body: {
                message,
                phase3Agent: agent_id,
                phase3_agent: agent_id,
                chatScope: Array.isArray(document_ids) && document_ids.length ? 'selected' : 'all',
                documentIds: Array.isArray(document_ids) ? document_ids : [],
            },
        } as unknown as Parameters<typeof chatWithDocuments>[0];

        let captured: { status: number; body: any } | null = null;
        const chatRes = {
            status(code: number) {
                if (captured) captured.status = code;
                else captured = { status: code, body: null };
                return this;
            },
            json(body: any) {
                if (!captured) captured = { status: 200, body };
                else captured.body = body;
                return this;
            },
        } as unknown as Parameters<typeof chatWithDocuments>[1];

        await chatWithDocuments(chatReq, chatRes, (err: unknown) => {
            throw err;
        });

        if (Array.isArray(document_ids) && document_ids.length > 0) {
            const filter = await buildDocumentFilter(context.user, {
                documentId: { $in: document_ids },
                organizationId: context.organizationId,
            });
            const docs = await Document.find(filter).select('documentId originalFilename organizationId').lean();
            for (const doc of docs) {
                attachedDocs.push(doc.originalFilename);
            }
        }

        const result = captured as { status: number; body: any } | null;
        if (!result || result.status >= 400) {
            throw new Error(result?.body?.message || 'Chat pipeline call failed');
        }

        return {
            agent_id,
            response: result.body?.data?.reply ?? '',
            citations: result.body?.data?.citations ?? [],
            contextDocuments: attachedDocs,
            organizationId: context.organizationId,
            timestamp: new Date().toISOString(),
        };
    }

    // Disconnected / test harness fallback mode
    const harness = getHarness();
    if (Array.isArray(document_ids) && harness?.fixtureStore) {
        for (const docId of document_ids) {
            const doc = harness.fixtureStore.documents.get(docId);
            if (doc && doc.organizationId === context.organizationId) {
                attachedDocs.push(doc.originalFilename);
            }
        }
    }

    return {
        agent_id,
        response: `[${agent_id}] Response to query: "${message}". Context documents: [${attachedDocs.join(', ')}]`,
        organizationId: context.organizationId,
        timestamp: new Date().toISOString(),
    };
}

/**
 * Tool 2: search_documents
 * Keyword and classification search with pagination and multi-tenant filter enforcement.
 */
export async function handleSearchDocuments(args: {
    query?: string;
    classification?: string;
    limit?: number;
    skip?: number;
}): Promise<Record<string, any>> {
    const context = getMcpContext();
    const cleanQuery = (args.query || '').toString().trim();
    const classification = args.classification ? String(args.classification).trim() : undefined;
    const limit = Math.max(1, Math.min(100, Number(args.limit) || 20));
    const skip = Math.max(0, Number(args.skip) || 0);

    // Live MongoDB mode
    if (mongoose.connection.readyState === 1) {
        const baseFilter = await buildDocumentFilter(context.user, {
            organizationId: context.organizationId,
        });
        const filter: Record<string, unknown> = { ...baseFilter };

        if (classification) {
            filter.classification = classification;
        }

        if (cleanQuery) {
            const escaped = cleanQuery.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            const regex = new RegExp(escaped, 'i');
            filter.$or = [
                { originalFilename: regex },
                { classification: regex },
                { documentId: regex },
            ];
        }

        const total = await Document.countDocuments(filter);
        const docs = await Document.find(filter)
            .sort({ createdAt: -1 })
            .skip(skip)
            .limit(limit)
            .lean();

        const matches = docs.map((d) => ({
            documentId: d.documentId,
            originalFilename: d.originalFilename,
            classification: d.classification || null,
            status: d.status,
            sizeBytes: d.sizeBytes,
            createdAt: d.createdAt instanceof Date ? d.createdAt.toISOString() : new Date(d.createdAt).toISOString(),
        }));

        return {
            total,
            documents: matches,
            organizationId: context.organizationId,
        };
    }

    // Disconnected / test harness fallback mode
    const harness = getHarness();
    const matches: any[] = [];
    if (harness?.fixtureStore) {
        for (const doc of harness.fixtureStore.documents.values()) {
            if (doc.organizationId !== context.organizationId) continue;
            if (classification && doc.classification !== classification) continue;
            const q = cleanQuery.toLowerCase();
            if (
                q === '' ||
                doc.originalFilename.toLowerCase().includes(q) ||
                (doc.rawText && doc.rawText.toLowerCase().includes(q)) ||
                (doc.classification && doc.classification.toLowerCase().includes(q)) ||
                doc.documentId.toLowerCase().includes(q)
            ) {
                matches.push({
                    documentId: doc.documentId,
                    originalFilename: doc.originalFilename,
                    classification: doc.classification,
                    status: doc.status,
                    sizeBytes: doc.sizeBytes,
                    createdAt: doc.createdAt instanceof Date ? doc.createdAt.toISOString() : new Date(doc.createdAt).toISOString(),
                });
            }
        }
    }

    const paged = matches.slice(skip, skip + limit);
    return {
        total: matches.length,
        documents: paged,
        organizationId: context.organizationId,
    };
}

/**
 * Tool 3: get_document_details
 * Retrieves document metadata, processing status, and raw text payload with 4,000 char size protection.
 */
export async function handleGetDocumentDetails(args: {
    document_id: string;
}): Promise<Record<string, any>> {
    const context = getMcpContext();
    const { document_id } = args;
    if (!document_id || typeof document_id !== 'string') {
        throw new Error('document_id is required');
    }

    // Live MongoDB mode
    if (mongoose.connection.readyState === 1) {
        const filter = await buildDocumentFilter(context.user, {
            documentId: document_id,
            organizationId: context.organizationId,
        });
        const doc = await Document.findOne(filter).lean();
        if (!doc) {
            throw new Error(`Document ${document_id} not found in tenant ${context.organizationId}`);
        }

        const rawText =
            (doc.metadata?.rawText as string) ||
            (doc.metadata?.ocrText as string) ||
            (doc as any).rawText ||
            (doc as any).ocrText ||
            '';
        const rawTextResult = truncateTextPayload(rawText);

        return {
            documentId: doc.documentId,
            originalFilename: doc.originalFilename,
            classification: doc.classification || null,
            status: doc.status,
            sizeBytes: doc.sizeBytes,
            metadata: doc.metadata || {},
            textPreview: rawTextResult.text,
            truncated: rawTextResult.truncated,
            createdAt: doc.createdAt instanceof Date ? doc.createdAt.toISOString() : new Date(doc.createdAt).toISOString(),
            updatedAt: doc.updatedAt instanceof Date ? doc.updatedAt.toISOString() : new Date(doc.updatedAt).toISOString(),
        };
    }

    // Disconnected / test harness fallback mode
    const harness = getHarness();
    const doc = harness?.fixtureStore?.documents?.get(document_id);
    if (!doc || doc.organizationId !== context.organizationId) {
        throw new Error(`Document ${document_id} not found in tenant ${context.organizationId}`);
    }

    const rawTextResult = truncateTextPayload(doc.rawText || doc.ocrText);
    return {
        documentId: doc.documentId,
        originalFilename: doc.originalFilename,
        classification: doc.classification,
        status: doc.status,
        sizeBytes: doc.sizeBytes,
        metadata: doc.metadata || {},
        textPreview: rawTextResult.text,
        truncated: rawTextResult.truncated,
        createdAt: doc.createdAt instanceof Date ? doc.createdAt.toISOString() : new Date(doc.createdAt).toISOString(),
        updatedAt: doc.updatedAt instanceof Date ? doc.updatedAt.toISOString() : new Date(doc.updatedAt).toISOString(),
    };
}

/**
 * Tool 4: get_portfolio_readiness
 * Aggregates fleet health scores and readiness metrics across all 6 domain agents.
 */
export async function handleGetPortfolioReadiness(): Promise<Record<string, any>> {
    const context = getMcpContext();

    // Live MongoDB mode
    if (mongoose.connection.readyState === 1) {
        const snapshot = await getAgentFleetSnapshot(context.user);
        return {
            organizationId: context.organizationId,
            timestamp: snapshot.timestamp,
            agents: snapshot.agents,
        };
    }

    // Disconnected / test harness fallback mode
    const harness = getHarness();
    const agentStats: any[] = [];
    if (harness?.fixtureStore) {
        for (const agentId of ANALYTICS_AGENT_IDS) {
            let docCount = 0;
            let readyCount = 0;
            for (const doc of harness.fixtureStore.documents.values()) {
                if (doc.organizationId !== context.organizationId) continue;
                if (doc.metadata?.phase3Agent === agentId) {
                    docCount += 1;
                    if (doc.status === 'ready' || doc.status === 'review') {
                        readyCount += 1;
                    }
                }
            }
            const healthScore = docCount > 0 ? Math.round((readyCount / docCount) * 100) : 0;
            let healthLabel: 'Ready' | 'Partial' | 'Empty' | 'Needs work' = 'Empty';
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
    }

    return {
        organizationId: context.organizationId,
        timestamp: new Date().toISOString(),
        agents: agentStats,
    };
}

/**
 * Tool 5: get_pending_approvals
 * Lists documents requiring manager approval or action grouped by invoices, certs, candidates, and contracts.
 */
export async function handleGetPendingApprovals(): Promise<Record<string, any>> {
    const context = getMcpContext();

    const pendingInvoices: any[] = [];
    const expiringCertificates: any[] = [];
    const shortlistedCandidates: any[] = [];
    const pendingContracts: any[] = [];

    // Live MongoDB mode
    if (mongoose.connection.readyState === 1) {
        const filter = await buildDocumentFilter(context.user, {
            organizationId: context.organizationId,
            $or: [
                { status: 'review' },
                { 'metadata.workflowExecution.stage': { $in: ['pending_approval', 'flagged', 'shortlisted'] } },
            ],
        });
        const docs = await Document.find(filter).lean();
        for (const doc of docs) {
            const wf = doc.metadata?.workflowExecution as any;
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

        return {
            organizationId: context.organizationId,
            pendingApprovals: {
                invoices: pendingInvoices,
                certificates: expiringCertificates,
                candidates: shortlistedCandidates,
                contracts: pendingContracts,
            },
            totalPending:
                pendingInvoices.length +
                expiringCertificates.length +
                shortlistedCandidates.length +
                pendingContracts.length,
        };
    }

    // Disconnected / test harness fallback mode
    const harness = getHarness();
    if (harness?.fixtureStore) {
        for (const doc of harness.fixtureStore.documents.values()) {
            if (doc.organizationId !== context.organizationId) continue;
            const wf = doc.metadata?.workflowExecution as any;
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
    }

    return {
        organizationId: context.organizationId,
        pendingApprovals: {
            invoices: pendingInvoices,
            certificates: expiringCertificates,
            candidates: shortlistedCandidates,
            contracts: pendingContracts,
        },
        totalPending:
            pendingInvoices.length +
            expiringCertificates.length +
            shortlistedCandidates.length +
            pendingContracts.length,
    };
}

/**
 * Tool 6: execute_workflow_decision
 * Triggers autonomous workflow decisions (approve, reject, reprocess, flag) with audit trail.
 */
export async function handleExecuteWorkflowDecision(args: {
    document_id: string;
    decision: 'approve' | 'reject' | 'reprocess' | 'flag';
    notes?: string;
    note?: string;
}): Promise<Record<string, any>> {
    const context = getMcpContext();
    const { document_id, decision } = args;
    const noteContent = args.notes || args.note || null;

    const validDecisions = ['approve', 'reject', 'reprocess', 'flag'];
    if (!validDecisions.includes(decision)) {
        throw new Error(`Invalid decision "${decision}". Supported: ${validDecisions.join(', ')}`);
    }

    // Live MongoDB mode
    if (mongoose.connection.readyState === 1) {
        const filter = await buildDocumentFilter(context.user, {
            documentId: document_id,
            organizationId: context.organizationId,
        });
        const doc = await Document.findOne(filter);
        if (!doc) {
            throw new Error(`Document ${document_id} not found in tenant ${context.organizationId}`);
        }

        if (decision === 'approve') {
            doc.status = 'ready';
            doc.metadata = {
                ...(doc.metadata || {}),
                workflowExecution: {
                    ...((doc.metadata?.workflowExecution as any) || {}),
                    stage: 'approved',
                    verdict: 'Approved via MCP',
                    decidedAt: new Date().toISOString(),
                },
            };
        } else if (decision === 'reject') {
            doc.status = 'failed';
            doc.metadata = {
                ...(doc.metadata || {}),
                workflowExecution: {
                    ...((doc.metadata?.workflowExecution as any) || {}),
                    stage: 'rejected',
                    verdict: 'Rejected via MCP',
                    decidedAt: new Date().toISOString(),
                },
            };
        } else if (decision === 'reprocess') {
            doc.status = 'processing';
            doc.metadata = {
                ...(doc.metadata || {}),
                workflowExecution: {
                    ...((doc.metadata?.workflowExecution as any) || {}),
                    stage: 'reprocessing',
                    verdict: 'Reprocessing initiated via MCP',
                    decidedAt: new Date().toISOString(),
                },
            };
        } else if (decision === 'flag') {
            doc.status = 'review';
            doc.metadata = {
                ...(doc.metadata || {}),
                workflowExecution: {
                    ...((doc.metadata?.workflowExecution as any) || {}),
                    stage: 'flagged',
                    verdict: 'Flagged for review via MCP',
                    decidedAt: new Date().toISOString(),
                },
            };
        }

        doc.markModified('metadata');
        await doc.save();

        await recordActivity({
            actorUserId: context.user.userId,
            actorRole: context.user.role,
            organizationId: context.organizationId,
            action: `workflow_${decision}`,
            category: 'document',
            outcome: 'success',
            resourceType: 'document',
            resourceId: doc.documentId,
            metadata: {
                source: 'mcp',
                decision,
                documentId: doc.documentId,
                notes: noteContent,
            },
        });

        return {
            success: true,
            documentId: doc.documentId,
            status: doc.status,
            decision,
            auditLogged: true,
            source: 'mcp',
        };
    }

    // Disconnected / test harness fallback mode
    const harness = getHarness();
    const doc = harness?.fixtureStore?.documents?.get(document_id);
    if (!doc || doc.organizationId !== context.organizationId) {
        throw new Error(`Document ${document_id} not found in tenant ${context.organizationId}`);
    }

    if (decision === 'approve') {
        doc.status = 'ready';
        if (doc.metadata) {
            doc.metadata.workflowExecution = {
                ...(doc.metadata?.workflowExecution as any),
                stage: 'approved',
                verdict: 'Approved via MCP',
                decidedAt: new Date().toISOString(),
            };
        }
    } else if (decision === 'reject') {
        doc.status = 'failed';
    } else if (decision === 'flag') {
        doc.status = 'review';
    } else if (decision === 'reprocess') {
        doc.status = 'processing';
    }
    doc.updatedAt = new Date();

    const logEntry = {
        logId: `log_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        organizationId: context.organizationId,
        action: `workflow_${decision}`,
        category: 'document',
        outcome: 'success',
        metadata: {
            source: 'mcp',
            decision,
            documentId: doc.documentId,
            notes: noteContent,
        },
        createdAt: new Date(),
    };
    if (harness?.fixtureStore?.activityLogs) {
        harness.fixtureStore.activityLogs.push(logEntry);
    }

    return {
        success: true,
        documentId: doc.documentId,
        status: doc.status,
        decision,
        auditLogged: true,
        source: 'mcp',
    };
}

/**
 * Tool 7: get_workflow_overview
 * Returns an organization-level overview of workflow executions and approval metrics.
 */
export async function handleGetWorkflowOverview(): Promise<Record<string, any>> {
    const context = getMcpContext();

    // Live MongoDB mode
    if (mongoose.connection.readyState === 1) {
        const summary = await getOrgWorkflowSummary(context.organizationId);
        return {
            organizationId: context.organizationId,
            summary: {
                autoApprovedInvoices: summary.autoApprovedInvoices,
                pendingApprovals: summary.pendingApprovals,
                expiringCertificates: summary.expiringCertificates,
                shortlistedCandidates: summary.shortlistedCandidates,
                flaggedRisks: summary.flaggedRisks,
            },
            recentExecutions: summary.recentExecutions,
        };
    }

    // Disconnected / test harness fallback mode
    const harness = getHarness();
    let autoApprovedInvoices = 0;
    let pendingApprovals = 0;
    let expiringCertificates = 0;
    let shortlistedCandidates = 0;
    let flaggedRisks = 0;

    if (harness?.fixtureStore) {
        for (const doc of harness.fixtureStore.documents.values()) {
            if (doc.organizationId !== context.organizationId) continue;
            const wf = doc.metadata?.workflowExecution as any;
            if (wf?.stage === 'auto_approved') autoApprovedInvoices += 1;
            if (wf?.stage === 'pending_approval') pendingApprovals += 1;
            if (wf?.stage === 'flagged' && doc.classification === 'certificate') expiringCertificates += 1;
            if (wf?.stage === 'shortlisted') shortlistedCandidates += 1;
            if (wf?.stage === 'flagged' && doc.classification === 'invoice') flaggedRisks += 1;
        }
    }

    const recentExecutions = (harness?.fixtureStore?.activityLogs || [])
        .filter((l: any) => l.organizationId === context.organizationId)
        .slice(-10);

    return {
        organizationId: context.organizationId,
        summary: {
            autoApprovedInvoices,
            pendingApprovals,
            expiringCertificates,
            shortlistedCandidates,
            flaggedRisks,
        },
        recentExecutions,
    };
}

/**
 * Unified executor for tool calls across all 7 domain tools.
 */
export async function executeTool(name: string, args: Record<string, any>): Promise<Record<string, any>> {
    switch (name) {
        case 'ask_agent':
            return handleAskAgent(args as any);
        case 'search_documents':
            return handleSearchDocuments(args as any);
        case 'get_document_details':
            return handleGetDocumentDetails(args as any);
        case 'get_portfolio_readiness':
            return handleGetPortfolioReadiness();
        case 'get_pending_approvals':
            return handleGetPendingApprovals();
        case 'execute_workflow_decision':
            return handleExecuteWorkflowDecision(args as any);
        case 'get_workflow_overview':
            return handleGetWorkflowOverview();
        default:
            throw new Error(`Unknown tool: ${name}`);
    }
}

// ============================================================================
// Registration on McpServer
// ============================================================================

/**
 * Registers the 7 Visibility Docs AI MCP tools on the provided McpServer instance.
 */
export function registerMcpTools(server: McpServer): void {
    // 1. ask_agent
    server.tool(
        'ask_agent',
        'Send prompts and queries to one of the 6 specialized domain agents with document context',
        {
            agent_id: z.enum(ANALYTICS_AGENT_IDS).describe('Target domain agent identifier'),
            message: z.string().min(1, 'Message is required and must be a string').describe('User question or directive'),
            document_ids: z.array(z.string()).optional().describe('Optional list of document IDs to attach as context'),
        },
        async (args) => {
            const res = await handleAskAgent(args);
            return {
                content: [{ type: 'text' as const, text: JSON.stringify(res, null, 2) }],
                ...res,
            };
        }
    );

    // 2. search_documents
    server.tool(
        'search_documents',
        'Search tenant documents by keyword, classification, or entity with pagination',
        {
            query: z.string().optional().default('').describe('Keyword search query'),
            classification: z.string().optional().describe('Filter by classification type'),
            limit: z.coerce.number().int().min(1).max(100).optional().default(20).describe('Result limit (1-100)'),
            skip: z.coerce.number().int().min(0).optional().default(0).describe('Pagination skip offset'),
        },
        async (args) => {
            const res = await handleSearchDocuments(args);
            return {
                content: [{ type: 'text' as const, text: JSON.stringify(res, null, 2) }],
                ...res,
            };
        }
    );

    // 3. get_document_details
    server.tool(
        'get_document_details',
        'Retrieve document metadata, extracted entities, and status with raw text size protection',
        {
            document_id: z.string().min(1, 'document_id is required').describe('Target document identifier'),
        },
        async (args) => {
            const res = await handleGetDocumentDetails(args);
            return {
                content: [{ type: 'text' as const, text: JSON.stringify(res, null, 2) }],
                ...res,
            };
        }
    );

    // 4. get_portfolio_readiness
    server.tool(
        'get_portfolio_readiness',
        'Retrieve organization portfolio health scores, document counts, and readiness distributions',
        {},
        async () => {
            const res = await handleGetPortfolioReadiness();
            return {
                content: [{ type: 'text' as const, text: JSON.stringify(res, null, 2) }],
                ...res,
            };
        }
    );

    // 5. get_pending_approvals
    server.tool(
        'get_pending_approvals',
        'List pending invoices, expiring certificates, shortlisted candidates, and review contracts',
        {},
        async () => {
            const res = await handleGetPendingApprovals();
            return {
                content: [{ type: 'text' as const, text: JSON.stringify(res, null, 2) }],
                ...res,
            };
        }
    );

    // 6. execute_workflow_decision
    server.tool(
        'execute_workflow_decision',
        'Trigger autonomous workflow decisions (approve, reject, reprocess, flag) with audit logging',
        {
            document_id: z.string().min(1, 'document_id is required').describe('Target document identifier'),
            decision: z.enum(['approve', 'reject', 'reprocess', 'flag']).describe('Workflow action to apply'),
            notes: z.string().optional().describe('Action justification notes'),
            note: z.string().optional().describe('Alias for notes parameter'),
        },
        async (args) => {
            const res = await handleExecuteWorkflowDecision(args);
            return {
                content: [{ type: 'text' as const, text: JSON.stringify(res, null, 2) }],
                ...res,
            };
        }
    );

    // 7. get_workflow_overview
    server.tool(
        'get_workflow_overview',
        'Return organization-level workflow execution summary and recent decisions',
        {},
        async () => {
            const res = await handleGetWorkflowOverview();
            return {
                content: [{ type: 'text' as const, text: JSON.stringify(res, null, 2) }],
                ...res,
            };
        }
    );
}
