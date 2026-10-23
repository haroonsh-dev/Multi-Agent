/**
 * MCP E2E Test Harness & Protocol Verifier
 * 
 * Provides:
 * 1. Mock & Live Database fixtures for multi-tenant MCP testing.
 * 2. In-memory JSON-RPC 2.0 client dispatcher and protocol validator.
 * 3. Stdio transport framing verifier (stdout pure JSON-RPC, stderr logs).
 * 4. SSE transport session lifecycle & HTTP endpoints validator.
 * 5. Dynamic MCP module loader supporting progressive testability across milestones.
 */
import assert from 'node:assert/strict';
import http from 'node:http';
import { AsyncLocalStorage } from 'node:async_hooks';
import mongoose from 'mongoose';
import express, { Request, Response, NextFunction } from 'express';
import { ANALYTICS_AGENT_IDS, AnalyticsAgentId } from '../constants/agentCatalog';
import type { AuthUser } from '../services/accessScope';

// ============================================================================
// Types & Contracts
// ============================================================================

export interface JsonRpcRequest {
    jsonrpc: '2.0';
    id: string | number;
    method: string;
    params?: Record<string, unknown>;
}

export interface JsonRpcResponse {
    jsonrpc: '2.0';
    id: string | number;
    result?: unknown;
    error?: {
        code: number;
        message: string;
        data?: unknown;
    };
}

export interface McpTenantContext {
    organizationId: string;
    organizationName?: string;
    user: AuthUser;
    source: 'mcp';
}

export interface MockDocument {
    documentId: string;
    organizationId: string;
    uploadedBy: string;
    originalFilename: string;
    storedFilename: string;
    mimeType: string;
    sizeBytes: number;
    storagePath: string;
    status: 'uploaded' | 'processing' | 'ready' | 'failed' | 'review';
    classification?: string;
    visibilityScope: 'personal' | 'department';
    metadata?: Record<string, unknown>;
    rawText?: string;
    ocrText?: string;
    createdAt: Date;
    updatedAt: Date;
}

export interface MockOrganization {
    organizationId: string;
    organizationName: string;
    status: 'active' | 'inactive';
}

export interface MockAgentApiToken {
    tokenId: string;
    organizationId: string;
    token: string;
    isActive: boolean;
}

export interface MockActivityLog {
    logId: string;
    organizationId: string | null;
    action: string;
    category?: string;
    outcome?: string;
    metadata?: Record<string, unknown>;
    createdAt: Date;
}

// ============================================================================
// Fixture Datasets (Multi-Tenancy)
// ============================================================================

export const ORG_ALPHA: MockOrganization = {
    organizationId: 'org_alpha',
    organizationName: 'Alpha Logistics Inc',
    status: 'active',
};

export const ORG_BETA: MockOrganization = {
    organizationId: 'org_beta',
    organizationName: 'Beta Manufacturing Ltd',
    status: 'active',
};

export const TOKEN_ALPHA: MockAgentApiToken = {
    tokenId: 'aat_alpha_001',
    organizationId: 'org_alpha',
    token: 'vdag_alpha_valid_token_0123456789abcdef0123456789abcdef',
    isActive: true,
};

export const TOKEN_BETA: MockAgentApiToken = {
    tokenId: 'aat_beta_002',
    organizationId: 'org_beta',
    token: 'vdag_beta_valid_token_9876543210fedcba9876543210fedcba',
    isActive: true,
};

// Scanned invoice OCR text exceeding the 4,000 character limit (8,200 chars)
export const LONG_OCR_TEXT = `INVOICE #INV-2026-9999
Alpha Logistics Vendor Service Report
` + 'SECTION ITEM DETAILS: Logistics freight line item analysis verified. Standard handling applied. '.repeat(100);

export const FIXTURE_DOCUMENTS: MockDocument[] = [
    {
        documentId: 'doc_alpha_inv_001',
        organizationId: 'org_alpha',
        uploadedBy: 'user_alpha_1',
        originalFilename: 'INV-2026-001_CarrierFreight.pdf',
        storedFilename: 'stored_alpha_inv_001.pdf',
        mimeType: 'application/pdf',
        sizeBytes: 15420,
        storagePath: '/uploads/alpha/inv_001.pdf',
        status: 'review',
        classification: 'invoice',
        visibilityScope: 'personal',
        metadata: {
            phase3Agent: 'finance_agent',
            extractedData: {
                invoice_number: 'INV-2026-001',
                vendor_name: 'FastCarrier Freight Ltd',
                total_amount: 14500,
                currency: 'USD',
                invoice_date: '2026-08-15',
            },
            workflowExecution: {
                agentId: 'finance_agent',
                workflowType: 'invoice_review',
                stage: 'pending_approval',
                verdict: 'Pending Manager Authorization (Exceeds $1,000 threshold)',
                executedAt: '2026-08-15T10:00:00.000Z',
            },
        },
        rawText: 'Carrier Freight Service Invoice for August 2026. Total Amount: $14,500.',
        createdAt: new Date('2026-08-15T10:00:00.000Z'),
        updatedAt: new Date('2026-08-15T10:00:00.000Z'),
    },
    {
        documentId: 'doc_alpha_cert_002',
        organizationId: 'org_alpha',
        uploadedBy: 'user_alpha_2',
        originalFilename: 'ISO_9001_Compliance_Certificate.pdf',
        storedFilename: 'stored_alpha_cert_002.pdf',
        mimeType: 'application/pdf',
        sizeBytes: 32400,
        storagePath: '/uploads/alpha/cert_002.pdf',
        status: 'review',
        classification: 'certificate',
        visibilityScope: 'department',
        metadata: {
            phase3Agent: 'compliance_agent',
            extractedData: {
                standard: 'ISO 9001:2015',
                expiry_date: '2026-09-10',
            },
            workflowExecution: {
                agentId: 'compliance_agent',
                workflowType: 'certificate_expiry',
                stage: 'flagged',
                verdict: 'Certificate expires in less than 30 days',
                executedAt: '2026-08-20T08:30:00.000Z',
            },
        },
        createdAt: new Date('2026-08-20T08:30:00.000Z'),
        updatedAt: new Date('2026-08-20T08:30:00.000Z'),
    },
    {
        documentId: 'doc_alpha_cv_003',
        organizationId: 'org_alpha',
        uploadedBy: 'user_alpha_1',
        originalFilename: 'Resume_Senior_Backend_Engineer.pdf',
        storedFilename: 'stored_alpha_cv_003.pdf',
        mimeType: 'application/pdf',
        sizeBytes: 42100,
        storagePath: '/uploads/alpha/cv_003.pdf',
        status: 'review',
        classification: 'resume',
        visibilityScope: 'department',
        metadata: {
            phase3Agent: 'hr_agent',
            extractedData: {
                candidate_name: 'Jane Doe',
                match_score: 92,
            },
            workflowExecution: {
                agentId: 'hr_agent',
                workflowType: 'candidate_screening',
                stage: 'shortlisted',
                verdict: 'Candidate score 92 meets threshold >= 75',
                executedAt: '2026-08-22T14:00:00.000Z',
            },
        },
        createdAt: new Date('2026-08-22T14:00:00.000Z'),
        updatedAt: new Date('2026-08-22T14:00:00.000Z'),
    },
    {
        documentId: 'doc_alpha_long_004',
        organizationId: 'org_alpha',
        uploadedBy: 'user_alpha_1',
        originalFilename: 'Long_Scanned_Inspection_Log.pdf',
        storedFilename: 'stored_alpha_long_004.pdf',
        mimeType: 'application/pdf',
        sizeBytes: 98500,
        storagePath: '/uploads/alpha/long_004.pdf',
        status: 'ready',
        classification: 'inspection_report',
        visibilityScope: 'personal',
        metadata: {
            phase3Agent: 'compliance_agent',
        },
        rawText: LONG_OCR_TEXT,
        ocrText: LONG_OCR_TEXT,
        createdAt: new Date('2026-08-25T09:00:00.000Z'),
        updatedAt: new Date('2026-08-25T09:00:00.000Z'),
    },
    // Beta tenant document for cross-tenant isolation testing
    {
        documentId: 'doc_beta_inv_001',
        organizationId: 'org_beta',
        uploadedBy: 'user_beta_1',
        originalFilename: 'Confidential_Beta_Supplier_Invoice.pdf',
        storedFilename: 'stored_beta_inv_001.pdf',
        mimeType: 'application/pdf',
        sizeBytes: 12500,
        storagePath: '/uploads/beta/inv_001.pdf',
        status: 'review',
        classification: 'invoice',
        visibilityScope: 'personal',
        metadata: {
            phase3Agent: 'finance_agent',
            extractedData: {
                invoice_number: 'BETA-INV-888',
                vendor_name: 'Beta Exclusive Supplier',
                total_amount: 99000,
            },
            workflowExecution: {
                agentId: 'finance_agent',
                stage: 'pending_approval',
            },
        },
        rawText: 'Beta Confidential Supplier Invoice $99,000.',
        createdAt: new Date('2026-08-28T11:00:00.000Z'),
        updatedAt: new Date('2026-08-28T11:00:00.000Z'),
    },
];

// ============================================================================
// Fixture Store & In-Memory Interceptor
// ============================================================================

export class FixtureStore {
    public organizations: Map<string, MockOrganization> = new Map();
    public tokens: Map<string, MockAgentApiToken> = new Map();
    public documents: Map<string, MockDocument> = new Map();
    public activityLogs: MockActivityLog[] = [];

    constructor() {
        this.reset();
    }

    public reset() {
        this.organizations.clear();
        this.tokens.clear();
        this.documents.clear();
        this.activityLogs = [];

        this.organizations.set(ORG_ALPHA.organizationId, { ...ORG_ALPHA });
        this.organizations.set(ORG_BETA.organizationId, { ...ORG_BETA });

        this.tokens.set(TOKEN_ALPHA.token, { ...TOKEN_ALPHA });
        this.tokens.set(TOKEN_BETA.token, { ...TOKEN_BETA });

        for (const doc of FIXTURE_DOCUMENTS) {
            this.documents.set(doc.documentId, {
                ...doc,
                metadata: JSON.parse(JSON.stringify(doc.metadata || {})),
            });
        }
    }
}

export const fixtureStore = new FixtureStore();

// ============================================================================
// Dynamic Module Loader (Progressive Testability)
// ============================================================================

export function loadModuleIfExists<T>(modulePath: string): T | null {
    try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        return require(modulePath) as T;
    } catch (e: unknown) {
        return null;
    }
}

export function getMcpContextModule() {
    return loadModuleIfExists<{
        McpTenantContext: unknown;
        mcpContextStorage: AsyncLocalStorage<McpTenantContext>;
        getMcpContext: () => McpTenantContext;
        runWithMcpContext: <R>(ctx: McpTenantContext, fn: () => Promise<R> | R) => Promise<R>;
    }>('../mcp/context');
}

export function getMcpAuthModule() {
    return loadModuleIfExists<{
        resolveMcpTenant: (token: string) => Promise<McpTenantContext | null>;
    }>('../mcp/auth');
}

export function getMcpToolsModule() {
    return loadModuleIfExists<{
        registerMcpTools: (server: any) => void;
    }>('../mcp/tools');
}

export function getMcpResourcesModule() {
    return loadModuleIfExists<{
        registerMcpResources: (server: any) => void;
    }>('../mcp/resources');
}

export function getMcpPromptsModule() {
    return loadModuleIfExists<{
        registerMcpPrompts: (server: any) => void;
    }>('../mcp/prompts');
}

export function getMcpServerModule() {
    return loadModuleIfExists<{
        createMcpServer: () => any;
    }>('../mcp/server');
}

export function getMcpSseModule() {
    return loadModuleIfExists<{
        mcpSseRouter: express.Router;
    }>('../mcp/sse');
}

// Fallback in-memory context storage for testing when modules are building
export const fallbackContextStorage = new AsyncLocalStorage<McpTenantContext>();

export function getActiveContext(): McpTenantContext {
    const ctxMod = getMcpContextModule();
    if (ctxMod?.getMcpContext) {
        return ctxMod.getMcpContext();
    }
    const current = fallbackContextStorage.getStore();
    if (!current) {
        throw new Error('No active MCP tenant context found');
    }
    return current;
}

export async function runInTenantContext<R>(
    context: McpTenantContext,
    fn: () => Promise<R> | R
): Promise<R> {
    const ctxMod = getMcpContextModule();
    if (ctxMod?.runWithMcpContext) {
        return ctxMod.runWithMcpContext(context, fn);
    }
    return fallbackContextStorage.run(context, fn);
}

// ============================================================================
// Canonical Reference Implementations for Progressive Testability
// ============================================================================

export const CANONICAL_TOOL_NAMES = [
    'ask_agent',
    'search_documents',
    'get_document_details',
    'get_portfolio_readiness',
    'get_pending_approvals',
    'execute_workflow_decision',
    'get_workflow_overview',
] as const;

export const CANONICAL_RESOURCE_URIS = [
    'docs://documents/{documentId}',
    'docs://overview',
] as const;

export const CANONICAL_PROMPT_NAMES = [
    'financial_audit_review',
    'compliance_expiry_audit',
    'hr_talent_shortlist',
] as const;

export const TEXT_SIZE_LIMIT = 4000;

/**
 * Truncates raw text to 4,000 characters with an explicit indicator if exceeded.
 */
export function truncateTextPayload(text?: string): { text: string; truncated: boolean } {
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
 * Reference implementation of tools/call that exercises genuine logic and fixture state.
 */
export async function executeReferenceTool(
    name: string,
    args: Record<string, any>,
    context: McpTenantContext
): Promise<Record<string, any>> {
    switch (name) {
        case 'ask_agent': {
            const { agent_id, message, document_ids } = args;
            if (!agent_id || !ANALYTICS_AGENT_IDS.includes(agent_id)) {
                throw new Error(`Invalid agent_id: ${agent_id}. Allowed: ${ANALYTICS_AGENT_IDS.join(', ')}`);
            }
            if (!message || typeof message !== 'string') {
                throw new Error('Message is required and must be a string');
            }
            // Scoped document access check
            const attachedDocs: string[] = [];
            if (Array.isArray(document_ids)) {
                for (const docId of document_ids) {
                    const doc = fixtureStore.documents.get(docId);
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

        case 'search_documents': {
            const query = (args.query || '').toString().toLowerCase();
            const classification = args.classification;
            const limit = Math.max(1, Math.min(100, Number(args.limit) || 20));

            const matches: any[] = [];
            for (const doc of fixtureStore.documents.values()) {
                if (doc.organizationId !== context.organizationId) continue;
                if (classification && doc.classification !== classification) continue;
                if (
                    query === '' ||
                    doc.originalFilename.toLowerCase().includes(query) ||
                    (doc.rawText && doc.rawText.toLowerCase().includes(query)) ||
                    (doc.classification && doc.classification.toLowerCase().includes(query))
                ) {
                    matches.push({
                        documentId: doc.documentId,
                        originalFilename: doc.originalFilename,
                        classification: doc.classification,
                        status: doc.status,
                        sizeBytes: doc.sizeBytes,
                        createdAt: doc.createdAt.toISOString(),
                    });
                }
                if (matches.length >= limit) break;
            }
            return {
                total: matches.length,
                documents: matches,
                organizationId: context.organizationId,
            };
        }

        case 'get_document_details': {
            const { document_id } = args;
            if (!document_id) throw new Error('document_id is required');
            const doc = fixtureStore.documents.get(document_id);
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
                createdAt: doc.createdAt.toISOString(),
                updatedAt: doc.updatedAt.toISOString(),
            };
        }

        case 'get_portfolio_readiness': {
            const agentStats: any[] = [];
            for (const agentId of ANALYTICS_AGENT_IDS) {
                let docCount = 0;
                let readyCount = 0;
                for (const doc of fixtureStore.documents.values()) {
                    if (doc.organizationId !== context.organizationId) continue;
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
            return {
                organizationId: context.organizationId,
                timestamp: new Date().toISOString(),
                agents: agentStats,
            };
        }

        case 'get_pending_approvals': {
            const pendingInvoices: any[] = [];
            const expiringCertificates: any[] = [];
            const shortlistedCandidates: any[] = [];
            const pendingContracts: any[] = [];

            for (const doc of fixtureStore.documents.values()) {
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

        case 'execute_workflow_decision': {
            const { document_id, decision, notes } = args;
            const validDecisions = ['approve', 'reject', 'reprocess', 'flag'];
            if (!validDecisions.includes(decision)) {
                throw new Error(`Invalid decision "${decision}". Supported: ${validDecisions.join(', ')}`);
            }
            const doc = fixtureStore.documents.get(document_id);
            if (!doc || doc.organizationId !== context.organizationId) {
                throw new Error(`Document ${document_id} not found in tenant ${context.organizationId}`);
            }

            // Update document state
            if (decision === 'approve') {
                doc.status = 'ready';
                if (doc.metadata) {
                    doc.metadata.workflowExecution = {
                        ...(doc.metadata.workflowExecution as any),
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

            // Record audit log entry with source = "mcp"
            const logEntry: MockActivityLog = {
                logId: `log_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
                organizationId: context.organizationId,
                action: `workflow_${decision}`,
                category: 'workflow',
                outcome: 'success',
                metadata: {
                    source: 'mcp',
                    decision,
                    documentId: doc.documentId,
                    notes: notes || null,
                },
                createdAt: new Date(),
            };
            fixtureStore.activityLogs.push(logEntry);

            return {
                success: true,
                documentId: doc.documentId,
                status: doc.status,
                decision,
                auditLogged: true,
                source: 'mcp',
            };
        }

        case 'get_workflow_overview': {
            let autoApprovedInvoices = 0;
            let pendingApprovals = 0;
            let expiringCertificates = 0;
            let shortlistedCandidates = 0;
            let flaggedRisks = 0;

            for (const doc of fixtureStore.documents.values()) {
                if (doc.organizationId !== context.organizationId) continue;
                const wf = doc.metadata?.workflowExecution as any;
                if (wf?.stage === 'auto_approved') autoApprovedInvoices += 1;
                if (wf?.stage === 'pending_approval') pendingApprovals += 1;
                if (wf?.stage === 'flagged' && doc.classification === 'certificate') expiringCertificates += 1;
                if (wf?.stage === 'shortlisted') shortlistedCandidates += 1;
                if (wf?.stage === 'flagged' && doc.classification === 'invoice') flaggedRisks += 1;
            }

            return {
                organizationId: context.organizationId,
                summary: {
                    autoApprovedInvoices,
                    pendingApprovals,
                    expiringCertificates,
                    shortlistedCandidates,
                    flaggedRisks,
                },
                recentExecutions: fixtureStore.activityLogs
                    .filter((l) => l.organizationId === context.organizationId)
                    .slice(-10),
            };
        }

        default:
            throw new Error(`Unknown tool: ${name}`);
    }
}

/**
 * Reference implementation of resources/read.
 */
export async function executeReferenceResource(
    uri: string,
    context: McpTenantContext
): Promise<{ uri: string; mimeType: string; text: string }> {
    if (uri.startsWith('docs://documents/')) {
        const docId = uri.replace('docs://documents/', '').trim();
        const doc = fixtureStore.documents.get(docId);
        if (!doc || doc.organizationId !== context.organizationId) {
            throw new Error(`Document ${docId} not found in tenant ${context.organizationId}`);
        }
        const truncatedPayload = truncateTextPayload(doc.rawText || doc.ocrText);
        return {
            uri,
            mimeType: 'application/json',
            text: JSON.stringify({
                documentId: doc.documentId,
                filename: doc.originalFilename,
                classification: doc.classification,
                status: doc.status,
                content: truncatedPayload.text,
                truncated: truncatedPayload.truncated,
            }),
        };
    } else if (uri === 'docs://overview') {
        const docCount = Array.from(fixtureStore.documents.values()).filter(
            (d) => d.organizationId === context.organizationId
        ).length;
        return {
            uri,
            mimeType: 'application/json',
            text: JSON.stringify({
                organizationId: context.organizationId,
                organizationName: context.organizationName,
                totalDocuments: docCount,
                timestamp: new Date().toISOString(),
            }),
        };
    } else {
        throw new Error(`Unsupported resource URI: ${uri}`);
    }
}

/**
 * Reference implementation of prompts/get.
 */
export async function executeReferencePrompt(
    name: string,
    args?: Record<string, string>
): Promise<{ name: string; description: string; messages: Array<{ role: string; content: { type: string; text: string } }> }> {
    switch (name) {
        case 'financial_audit_review':
            return {
                name,
                description: 'Deep audit prompt for invoice duplicate checks and threshold anomalies',
                messages: [
                    {
                        role: 'user',
                        content: {
                            type: 'text',
                            text: `Perform a financial audit on invoice ${args?.invoice_number || 'N/A'}. Verify vendor, totals, and PO alignment.`,
                        },
                    },
                ],
            };
        case 'compliance_expiry_audit':
            return {
                name,
                description: 'Regulatory compliance certificate expiration and CAPA action audit',
                messages: [
                    {
                        role: 'user',
                        content: {
                            type: 'text',
                            text: `Audit compliance certificate ${args?.certificate_id || 'N/A'}. Identify days until expiration and required renewal actions.`,
                        },
                    },
                ],
            };
        case 'hr_talent_shortlist':
            return {
                name,
                description: 'HR candidate qualification assessment against role criteria',
                messages: [
                    {
                        role: 'user',
                        content: {
                            type: 'text',
                            text: `Evaluate candidate resume ${args?.candidate_name || 'N/A'} for role criteria and shortlisting viability.`,
                        },
                    },
                ],
            };
        default:
            throw new Error(`Unknown prompt: ${name}`);
    }
}
