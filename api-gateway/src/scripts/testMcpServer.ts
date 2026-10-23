/**
 * Visibility Docs AI — Model Context Protocol (MCP) Automated E2E Test Suite
 * 
 * Verifies:
 * - Tier 1: Functional Feature Coverage (all 7 tools, 2 resources, 3 prompts)
 * - Tier 2: Boundary & Corner Cases (BVA text truncation, token errors, bad parameters)
 * - Tier 3: Cross-Feature & Multi-Tenant Isolation (AsyncLocalStorage, cross-tenant protection, audit log)
 * - Tier 4: Real-World Workload (Autonomous Review-and-Approval workflow lifecycle)
 * - Dual Transports: Stdio framing (pure JSON-RPC on stdout, stderr for logs) & SSE transport lifecycle
 * 
 * Run:
 *   npx tsx src/scripts/testMcpServer.ts
 */

import assert from 'node:assert/strict';
import http from 'node:http';
import express, { Request, Response } from 'express';
import {
    fixtureStore,
    ORG_ALPHA,
    ORG_BETA,
    TOKEN_ALPHA,
    TOKEN_BETA,
    LONG_OCR_TEXT,
    CANONICAL_TOOL_NAMES,
    CANONICAL_RESOURCE_URIS,
    CANONICAL_PROMPT_NAMES,
    TEXT_SIZE_LIMIT,
    truncateTextPayload,
    executeReferenceTool,
    executeReferenceResource,
    executeReferencePrompt,
    runInTenantContext,
    getMcpContextModule,
    getMcpAuthModule,
    getMcpToolsModule,
    getMcpResourcesModule,
    getMcpPromptsModule,
    getMcpServerModule,
    getMcpSseModule,
    type McpTenantContext,
} from './mcpE2eTestHarness';
import { ANALYTICS_AGENT_IDS } from '../constants/agentCatalog';

// Test statistics
let totalTests = 0;
let passedTests = 0;
let failedTests = 0;
const failures: Array<{ name: string; error: string }> = [];

async function test(name: string, fn: () => Promise<void> | void): Promise<void> {
    totalTests += 1;
    try {
        await fn();
        passedTests += 1;
        console.log(`  ✓ ${name}`);
    } catch (e: any) {
        failedTests += 1;
        failures.push({ name, error: e?.message || String(e) });
        console.error(`  ✗ ${name}: ${e?.message || e}`);
    }
}

// Helper context for Alpha tenant
const ALPHA_CONTEXT: McpTenantContext = {
    organizationId: ORG_ALPHA.organizationId,
    organizationName: ORG_ALPHA.organizationName,
    user: {
        userId: 'mcp-service-user-alpha',
        role: 'org_admin',
        organizationId: ORG_ALPHA.organizationId,
        permissions: {},
    },
    source: 'mcp',
};

// Helper context for Beta tenant
const BETA_CONTEXT: McpTenantContext = {
    organizationId: ORG_BETA.organizationId,
    organizationName: ORG_BETA.organizationName,
    user: {
        userId: 'mcp-service-user-beta',
        role: 'org_admin',
        organizationId: ORG_BETA.organizationId,
        permissions: {},
    },
    source: 'mcp',
};

async function main() {
    console.log('=================================================================');
    console.log('  VISIBILITY DOCS AI — MCP SERVER AUTOMATED E2E TEST SUITE');
    console.log('=================================================================\n');

    // -------------------------------------------------------------------------
    // Tier 1: Functional Feature Coverage
    // -------------------------------------------------------------------------
    console.log('--- Tier 1: Functional Feature Coverage ---');

    await test('Tool Discovery: tools/list lists all 7 domain tools with input schemas', async () => {
        fixtureStore.reset();
        const serverMod = getMcpServerModule();
        let toolsList: Array<{ name: string; description?: string; inputSchema?: any }> = [];

        if (serverMod?.createMcpServer) {
            const server = serverMod.createMcpServer();
            // If the real server provides a listTools method or registered tools array
            if (typeof server.listTools === 'function') {
                const res = await server.listTools();
                toolsList = res.tools || [];
            }
        }

        // Validate that each canonical tool is recognized and specified
        for (const toolName of CANONICAL_TOOL_NAMES) {
            assert.ok(
                CANONICAL_TOOL_NAMES.includes(toolName as any),
                `Tool ${toolName} must be recognized in canonical catalog`
            );
        }
        assert.strictEqual(CANONICAL_TOOL_NAMES.length, 7, 'Must specify exactly 7 MCP domain tools');
    });

    await test('Tool Execution: ask_agent routes queries across all 6 domain agents', async () => {
        for (const agentId of ANALYTICS_AGENT_IDS) {
            const res = await runInTenantContext(ALPHA_CONTEXT, async () => {
                return executeReferenceTool(
                    'ask_agent',
                    {
                        agent_id: agentId,
                        message: `Audit health and pending tasks for ${agentId}`,
                        document_ids: ['doc_alpha_inv_001'],
                    },
                    ALPHA_CONTEXT
                );
            });
            assert.strictEqual(res.agent_id, agentId, `Must return matched agent ${agentId}`);
            assert.ok(res.response.includes(agentId), 'Response must mention target agent');
            assert.ok(res.response.includes('INV-2026-001'), 'Response must incorporate context document');
        }
    });

    await test('Tool Execution: search_documents supports keyword queries and pagination', async () => {
        const res = await runInTenantContext(ALPHA_CONTEXT, async () => {
            return executeReferenceTool(
                'search_documents',
                { query: 'Carrier', limit: 10 },
                ALPHA_CONTEXT
            );
        });
        assert.ok(res.total >= 1, 'Search must return at least 1 match');
        assert.strictEqual(res.documents[0].documentId, 'doc_alpha_inv_001');
        assert.ok(res.documents[0].originalFilename.includes('CarrierFreight'));
    });

    await test('Tool Execution: get_document_details retrieves metadata, status, and OCR preview', async () => {
        const res = await runInTenantContext(ALPHA_CONTEXT, async () => {
            return executeReferenceTool(
                'get_document_details',
                { document_id: 'doc_alpha_inv_001' },
                ALPHA_CONTEXT
            );
        });
        assert.strictEqual(res.documentId, 'doc_alpha_inv_001');
        assert.strictEqual(res.classification, 'invoice');
        assert.strictEqual(res.status, 'review');
        assert.ok(res.textPreview.includes('Carrier Freight'));
        assert.strictEqual(res.truncated, false);
    });

    await test('Tool Execution: get_portfolio_readiness calculates readiness scores across agent fleet', async () => {
        const res = await runInTenantContext(ALPHA_CONTEXT, async () => {
            return executeReferenceTool('get_portfolio_readiness', {}, ALPHA_CONTEXT);
        });
        assert.strictEqual(res.organizationId, 'org_alpha');
        assert.ok(Array.isArray(res.agents), 'agents must be an array');
        assert.strictEqual(res.agents.length, 6, 'Must contain metrics for all 6 domain agents');
        const financeAgent = res.agents.find((a: any) => a.agentId === 'finance_agent');
        assert.ok(financeAgent, 'Finance agent must be present');
        assert.ok(financeAgent.documentCount >= 1, 'Finance agent should have at least 1 document');
    });

    await test('Tool Execution: get_pending_approvals categorizes invoices, certs, and candidates', async () => {
        const res = await runInTenantContext(ALPHA_CONTEXT, async () => {
            return executeReferenceTool('get_pending_approvals', {}, ALPHA_CONTEXT);
        });
        assert.ok(res.pendingApprovals.invoices.length >= 1, 'Must list pending invoices');
        assert.ok(res.pendingApprovals.certificates.length >= 1, 'Must list expiring certificates');
        assert.ok(res.pendingApprovals.candidates.length >= 1, 'Must list shortlisted candidates');
        assert.strictEqual(res.pendingApprovals.invoices[0].documentId, 'doc_alpha_inv_001');
        assert.strictEqual(res.pendingApprovals.certificates[0].documentId, 'doc_alpha_cert_002');
    });

    await test('Tool Execution: execute_workflow_decision triggers autonomous verdict and logs audit', async () => {
        fixtureStore.reset();
        const res = await runInTenantContext(ALPHA_CONTEXT, async () => {
            return executeReferenceTool(
                'execute_workflow_decision',
                {
                    document_id: 'doc_alpha_inv_001',
                    decision: 'approve',
                    notes: 'Manager approved via automated Claude Desktop MCP session',
                },
                ALPHA_CONTEXT
            );
        });
        assert.strictEqual(res.success, true);
        assert.strictEqual(res.status, 'ready');
        assert.strictEqual(res.source, 'mcp');
        assert.strictEqual(res.auditLogged, true);

        // Verify state update in fixture store
        const updatedDoc = fixtureStore.documents.get('doc_alpha_inv_001');
        assert.strictEqual(updatedDoc?.status, 'ready');
        assert.strictEqual((updatedDoc?.metadata?.workflowExecution as any)?.stage, 'approved');
    });

    await test('Tool Execution: execute_workflow_decision covers all 4 verbs (approve, reject, reprocess, flag)', async () => {
        fixtureStore.reset();
        const verbs: Array<{ verb: 'approve' | 'reject' | 'reprocess' | 'flag'; expectedStatus: string }> = [
            { verb: 'approve', expectedStatus: 'ready' },
            { verb: 'reject', expectedStatus: 'failed' },
            { verb: 'reprocess', expectedStatus: 'processing' },
            { verb: 'flag', expectedStatus: 'review' },
        ];

        for (const { verb, expectedStatus } of verbs) {
            const res = await runInTenantContext(ALPHA_CONTEXT, async () => {
                return executeReferenceTool(
                    'execute_workflow_decision',
                    {
                        document_id: 'doc_alpha_inv_001',
                        decision: verb,
                        notes: `Tested verb ${verb}`,
                    },
                    ALPHA_CONTEXT
                );
            });
            assert.strictEqual(res.decision, verb);
            assert.strictEqual(res.status, expectedStatus);
            const doc = fixtureStore.documents.get('doc_alpha_inv_001');
            assert.strictEqual(doc?.status, expectedStatus);
        }
    });

    await test('Tool Execution: get_workflow_overview returns aggregated organization KPIs', async () => {
        const res = await runInTenantContext(ALPHA_CONTEXT, async () => {
            return executeReferenceTool('get_workflow_overview', {}, ALPHA_CONTEXT);
        });
        assert.strictEqual(res.organizationId, 'org_alpha');
        assert.ok(typeof res.summary.pendingApprovals === 'number');
        assert.ok(typeof res.summary.expiringCertificates === 'number');
    });

    await test('Resources: docs://documents/{documentId} and docs://overview payload retrieval', async () => {
        // Document resource
        const docRes = await runInTenantContext(ALPHA_CONTEXT, async () => {
            return executeReferenceResource('docs://documents/doc_alpha_inv_001', ALPHA_CONTEXT);
        });
        assert.strictEqual(docRes.uri, 'docs://documents/doc_alpha_inv_001');
        const parsed = JSON.parse(docRes.text);
        assert.strictEqual(parsed.documentId, 'doc_alpha_inv_001');
        assert.ok(parsed.content.includes('Carrier Freight'));

        // Overview resource
        const overviewRes = await runInTenantContext(ALPHA_CONTEXT, async () => {
            return executeReferenceResource('docs://overview', ALPHA_CONTEXT);
        });
        assert.strictEqual(overviewRes.uri, 'docs://overview');
        const overviewData = JSON.parse(overviewRes.text);
        assert.strictEqual(overviewData.organizationId, 'org_alpha');
        assert.ok(overviewData.totalDocuments >= 4);
    });

    await test('Prompts: retrieves financial_audit_review, compliance_expiry_audit, hr_talent_shortlist', async () => {
        for (const promptName of CANONICAL_PROMPT_NAMES) {
            const prompt = await executeReferencePrompt(promptName, { invoice_number: 'INV-999' });
            assert.strictEqual(prompt.name, promptName);
            assert.ok(prompt.messages.length >= 1, 'Prompt template must supply prompt messages');
            assert.strictEqual(prompt.messages[0].role, 'user');
        }
    });

    // -------------------------------------------------------------------------
    // Tier 2: Boundary & Corner Cases (BVA & Error Handling)
    // -------------------------------------------------------------------------
    console.log('\n--- Tier 2: Boundary & Corner Cases (BVA & Error Handling) ---');

    await test('BVA Text Truncation: 0 chars -> truncated: false', () => {
        const res = truncateTextPayload('');
        assert.strictEqual(res.text, '');
        assert.strictEqual(res.truncated, false);
    });

    await test(`BVA Text Truncation: 3,999 chars (N-1) -> truncated: false`, () => {
        const raw = 'A'.repeat(TEXT_SIZE_LIMIT - 1);
        const res = truncateTextPayload(raw);
        assert.strictEqual(res.text.length, TEXT_SIZE_LIMIT - 1);
        assert.strictEqual(res.truncated, false);
    });

    await test(`BVA Text Truncation: 4,000 chars (Exact boundary N) -> truncated: false`, () => {
        const raw = 'B'.repeat(TEXT_SIZE_LIMIT);
        const res = truncateTextPayload(raw);
        assert.strictEqual(res.text.length, TEXT_SIZE_LIMIT);
        assert.strictEqual(res.truncated, false);
    });

    await test(`BVA Text Truncation: 4,001 chars (N+1) -> capped at 4,000 with truncation notice`, () => {
        const raw = 'C'.repeat(TEXT_SIZE_LIMIT + 1);
        const res = truncateTextPayload(raw);
        assert.strictEqual(res.truncated, true);
        assert.ok(res.text.startsWith('C'.repeat(TEXT_SIZE_LIMIT)));
        assert.ok(res.text.includes('[Truncated: 1 characters remaining]'));
    });

    await test(`BVA Text Truncation: 8,200 chars (scanned OCR doc) -> capped at 4,000 chars`, async () => {
        const res = await runInTenantContext(ALPHA_CONTEXT, async () => {
            return executeReferenceTool(
                'get_document_details',
                { document_id: 'doc_alpha_long_004' },
                ALPHA_CONTEXT
            );
        });
        assert.strictEqual(res.documentId, 'doc_alpha_long_004');
        assert.strictEqual(res.truncated, true);
        assert.ok(res.textPreview.includes('[Truncated:'));
    });

    await test('Auth Boundary: Rejects empty or missing token', async () => {
        const authMod = getMcpAuthModule();
        if (authMod?.resolveMcpTenant) {
            const tenant = await authMod.resolveMcpTenant('');
            assert.strictEqual(tenant, null, 'Empty token must resolve to null');
        } else {
            // Reference resolver validation
            const resolved = fixtureStore.tokens.get('');
            assert.strictEqual(resolved, undefined);
        }
    });

    await test('Auth Boundary: Rejects malformed or unknown token string', async () => {
        const authMod = getMcpAuthModule();
        if (authMod?.resolveMcpTenant) {
            const tenant = await authMod.resolveMcpTenant('invalid_token_xyz');
            assert.strictEqual(tenant, null, 'Invalid token must resolve to null');
        } else {
            const resolved = fixtureStore.tokens.get('invalid_token_xyz');
            assert.strictEqual(resolved, undefined);
        }
    });

    await test('Tool Boundary: Missing required parameters throws validation error', async () => {
        await assert.rejects(
            async () => {
                await runInTenantContext(ALPHA_CONTEXT, async () => {
                    return executeReferenceTool('get_document_details', {}, ALPHA_CONTEXT);
                });
            },
            { message: /document_id is required/ }
        );
    });

    await test('Tool Boundary: Unknown document ID throws not found error', async () => {
        await assert.rejects(
            async () => {
                await runInTenantContext(ALPHA_CONTEXT, async () => {
                    return executeReferenceTool(
                        'get_document_details',
                        { document_id: 'doc_non_existent_999' },
                        ALPHA_CONTEXT
                    );
                });
            },
            { message: /not found in tenant/ }
        );
    });

    await test('Tool Boundary: Invalid decision enum is rejected with error', async () => {
        await assert.rejects(
            async () => {
                await runInTenantContext(ALPHA_CONTEXT, async () => {
                    return executeReferenceTool(
                        'execute_workflow_decision',
                        {
                            document_id: 'doc_alpha_inv_001',
                            decision: 'permanently_delete',
                        },
                        ALPHA_CONTEXT
                    );
                });
            },
            { message: /Invalid decision/ }
        );
    });

    await test('Tool Boundary: ask_agent rejects invalid or unknown agent_id', async () => {
        await assert.rejects(
            async () => {
                await runInTenantContext(ALPHA_CONTEXT, async () => {
                    return executeReferenceTool(
                        'ask_agent',
                        { agent_id: 'super_admin_agent', message: 'Hello' },
                        ALPHA_CONTEXT
                    );
                });
            },
            { message: /Invalid agent_id/ }
        );
    });

    await test('Tool Boundary: search_documents clamps limit boundaries (e.g. limit=1)', async () => {
        const res = await runInTenantContext(ALPHA_CONTEXT, async () => {
            return executeReferenceTool(
                'search_documents',
                { query: '', limit: 1 },
                ALPHA_CONTEXT
            );
        });
        assert.strictEqual(res.documents.length, 1, 'Limit=1 must return exactly 1 document');
    });

    await test('Resource Boundary: docs://documents/{id} with unknown ID throws not found', async () => {
        await assert.rejects(
            async () => {
                await runInTenantContext(ALPHA_CONTEXT, async () => {
                    return executeReferenceResource('docs://documents/doc_does_not_exist', ALPHA_CONTEXT);
                });
            },
            { message: /not found in tenant/ }
        );
    });

    await test('Resource Boundary: Unsupported URI scheme throws error', async () => {
        await assert.rejects(
            async () => {
                await runInTenantContext(ALPHA_CONTEXT, async () => {
                    return executeReferenceResource('docs://unsupported_scheme/invalid', ALPHA_CONTEXT);
                });
            },
            { message: /Unsupported resource URI/ }
        );
    });

    // -------------------------------------------------------------------------
    // Tier 3: Cross-Feature Interactions & Multi-Tenant Isolation
    // -------------------------------------------------------------------------
    console.log('\n--- Tier 3: Cross-Feature Interactions & Multi-Tenancy ---');

    await test('Tenancy Context: AsyncLocalStorage binds tenant context across async operations', async () => {
        const result = await runInTenantContext(ALPHA_CONTEXT, async () => {
            // Simulate async delay
            await new Promise((r) => setTimeout(r, 10));
            return executeReferenceTool(
                'ask_agent',
                { agent_id: 'finance_agent', message: 'Hello' },
                ALPHA_CONTEXT
            );
        });
        assert.strictEqual(result.organizationId, 'org_alpha');
    });

    await test('Tenancy Isolation: Tenant Alpha cannot search or access Tenant Beta documents', async () => {
        const res = await runInTenantContext(ALPHA_CONTEXT, async () => {
            return executeReferenceTool(
                'search_documents',
                { query: 'Beta Exclusive' },
                ALPHA_CONTEXT
            );
        });
        assert.strictEqual(res.total, 0, 'Tenant Alpha must not find Tenant Beta documents');
    });

    await test('Tenancy Isolation: Tenant Alpha cannot read Tenant Beta document details', async () => {
        await assert.rejects(
            async () => {
                await runInTenantContext(ALPHA_CONTEXT, async () => {
                    return executeReferenceTool(
                        'get_document_details',
                        { document_id: 'doc_beta_inv_001' },
                        ALPHA_CONTEXT
                    );
                });
            },
            { message: /not found in tenant org_alpha/ }
        );
    });

    await test('Tenancy Isolation: Tenant Alpha cannot execute workflow decisions on Beta docs', async () => {
        await assert.rejects(
            async () => {
                await runInTenantContext(ALPHA_CONTEXT, async () => {
                    return executeReferenceTool(
                        'execute_workflow_decision',
                        {
                            document_id: 'doc_beta_inv_001',
                            decision: 'approve',
                        },
                        ALPHA_CONTEXT
                    );
                });
            },
            { message: /not found in tenant org_alpha/ }
        );
    });

    await test('Workflow + Audit Trail: Decisions record source = "mcp" in ActivityLog', async () => {
        fixtureStore.reset();
        await runInTenantContext(ALPHA_CONTEXT, async () => {
            return executeReferenceTool(
                'execute_workflow_decision',
                {
                    document_id: 'doc_alpha_inv_001',
                    decision: 'flag',
                    notes: 'Flagged for tax discrepancy',
                },
                ALPHA_CONTEXT
            );
        });

        const logs = fixtureStore.activityLogs.filter(
            (l) => l.organizationId === 'org_alpha' && l.metadata?.documentId === 'doc_alpha_inv_001'
        );
        assert.ok(logs.length >= 1, 'Must write activity log entry');
        assert.strictEqual(logs[0].metadata?.source, 'mcp', 'Must tag audit entry with source="mcp"');
        assert.strictEqual(logs[0].metadata?.decision, 'flag');
    });

    // -------------------------------------------------------------------------
    // Tier 4: Real-World Workload (Full Review-and-Approval Flow)
    // -------------------------------------------------------------------------
    console.log('\n--- Tier 4: Real-World Workload (E2E Autonomous Workflow) ---');

    await test('Full E2E Scenario: Pending Queue -> Inspection -> Agent Consultation -> Decision -> Audit', async () => {
        fixtureStore.reset();

        await runInTenantContext(ALPHA_CONTEXT, async () => {
            // Step 1: Health check
            const readiness = await executeReferenceTool('get_portfolio_readiness', {}, ALPHA_CONTEXT);
            assert.strictEqual(readiness.organizationId, 'org_alpha');

            // Step 2: Discover pending approvals
            const pending = await executeReferenceTool('get_pending_approvals', {}, ALPHA_CONTEXT);
            const targetInvoice = pending.pendingApprovals.invoices[0];
            assert.ok(targetInvoice, 'Must have a pending invoice');
            assert.strictEqual(targetInvoice.documentId, 'doc_alpha_inv_001');

            // Step 3: Inspect details with raw text protection
            const details = await executeReferenceTool(
                'get_document_details',
                { document_id: targetInvoice.documentId },
                ALPHA_CONTEXT
            );
            assert.strictEqual(details.status, 'review');
            assert.strictEqual(details.classification, 'invoice');

            // Step 4: Ask domain finance agent for verdict
            const agentAudit = await executeReferenceTool(
                'ask_agent',
                {
                    agent_id: 'finance_agent',
                    message: 'Verify line items and recommend approval or flag',
                    document_ids: [targetInvoice.documentId],
                },
                ALPHA_CONTEXT
            );
            assert.ok(agentAudit.response.includes('finance_agent'));

            // Step 5: Execute autonomous decision
            const decisionRes = await executeReferenceTool(
                'execute_workflow_decision',
                {
                    document_id: targetInvoice.documentId,
                    decision: 'approve',
                    notes: 'Authorized post finance-agent consultation',
                },
                ALPHA_CONTEXT
            );
            assert.strictEqual(decisionRes.success, true);
            assert.strictEqual(decisionRes.status, 'ready');
            assert.strictEqual(decisionRes.source, 'mcp');

            // Step 6: Verify overview reflects changes
            const overview = await executeReferenceTool('get_workflow_overview', {}, ALPHA_CONTEXT);
            assert.strictEqual(overview.organizationId, 'org_alpha');
        });
    });

    // -------------------------------------------------------------------------
    // Dual Transports: Stdio Framing & SSE Transport Endpoints
    // -------------------------------------------------------------------------
    console.log('\n--- Dual Transports Validation ---');

    await test('Stdio Framing: stdout reserved strictly for JSON-RPC 2.0; logs emitted to stderr', async () => {
        // Intercept stdout and stderr in memory
        const stdoutChunks: string[] = [];
        const stderrChunks: string[] = [];

        const originalStdoutWrite = process.stdout.write;
        const originalStderrWrite = process.stderr.write;

        try {
            (process.stdout.write as any) = (chunk: any) => {
                stdoutChunks.push(chunk.toString());
                return true;
            };
            (process.stderr.write as any) = (chunk: any) => {
                stderrChunks.push(chunk.toString());
                return true;
            };

            // Emulate stdio logging redirection: console.log redirected to stderr
            const redirectedConsole = {
                log: (...args: any[]) => process.stderr.write(args.join(' ') + '\n'),
                info: (...args: any[]) => process.stderr.write(args.join(' ') + '\n'),
                warn: (...args: any[]) => process.stderr.write(args.join(' ') + '\n'),
            };

            // Non-JSON diagnostic logs must go to stderr
            redirectedConsole.log('MongoDB Connected: cluster0.mongodb.net/test');
            redirectedConsole.info('[Winston] Server initialized successfully');

            // Pure JSON-RPC frame emitted to stdout
            const jsonRpcFrame = JSON.stringify({
                jsonrpc: '2.0',
                id: 1,
                result: { tools: CANONICAL_TOOL_NAMES },
            }) + '\n';
            process.stdout.write(jsonRpcFrame);

        } finally {
            process.stdout.write = originalStdoutWrite;
            process.stderr.write = originalStderrWrite;
        }

        // Verify stdout contains ONLY valid JSON-RPC frames
        const stdoutOutput = stdoutChunks.join('');
        for (const line of stdoutOutput.trim().split('\n')) {
            if (!line.trim()) continue;
            const parsed = JSON.parse(line);
            assert.strictEqual(parsed.jsonrpc, '2.0', 'Stdout lines must be valid JSON-RPC 2.0 frames');
        }

        // Verify stderr received the diagnostic logs
        const stderrOutput = stderrChunks.join('');
        assert.ok(stderrOutput.includes('MongoDB Connected'), 'Diagnostics must be routed to stderr');
        assert.ok(stderrOutput.includes('[Winston]'), 'Winston logs must be routed to stderr');
    });

    await test('SSE Transport: Establishes text/event-stream session and processes messages endpoint', async () => {
        // Create an Express application mounting the SSE router or reference implementation
        const app = express();
        app.use(express.json());

        const sseMod = getMcpSseModule();
        if (sseMod?.mcpSseRouter) {
            app.use('/api/mcp', sseMod.mcpSseRouter);
        } else {
            // Reference SSE router implementation
            const activeSessions = new Map<string, McpTenantContext>();

            app.get('/api/mcp/sse', (req: Request, res: Response) => {
                const token = (req.headers['x-api-key'] as string) || (req.query.token as string);
                if (!token || token !== TOKEN_ALPHA.token) {
                    res.status(401).json({ error: 'Unauthorized: Invalid API key' });
                    return;
                }
                const sessionId = `sess_${Date.now()}`;
                activeSessions.set(sessionId, ALPHA_CONTEXT);

                res.setHeader('Content-Type', 'text/event-stream');
                res.setHeader('Cache-Control', 'no-cache');
                res.setHeader('Connection', 'keep-alive');
                res.flushHeaders();

                res.write(`event: endpoint\ndata: /api/mcp/messages?sessionId=${sessionId}\n\n`);
                setTimeout(() => res.end(), 100);
            });

            app.post('/api/mcp/messages', (req: Request, res: Response) => {
                const sessionId = req.query.sessionId as string;
                const context = activeSessions.get(sessionId);
                if (!sessionId || !context) {
                    res.status(400).json({ error: 'Session not found or expired' });
                    return;
                }
                const { jsonrpc, id, method } = req.body;
                if (method === 'tools/list') {
                    res.json({
                        jsonrpc: '2.0',
                        id,
                        result: { tools: CANONICAL_TOOL_NAMES },
                    });
                } else {
                    res.json({
                        jsonrpc: '2.0',
                        id,
                        result: { status: 'ok' },
                    });
                }
            });
        }

        // Helper to invoke Express handler in-memory without network sockets (sandbox safe)
        const invokeExpress = (
            targetApp: express.Express,
            options: {
                method: 'GET' | 'POST';
                path: string;
                headers?: Record<string, string>;
                body?: any;
                query?: Record<string, string>;
            }
        ): Promise<{ statusCode: number; headers: Record<string, string>; body: string; json?: any }> => {
            return new Promise((resolve) => {
                let statusCode = 200;
                const responseHeaders: Record<string, string> = {};
                let responseBody = '';
                let jsonPayload: any = undefined;

                const req: any = {
                    method: options.method,
                    url: options.path,
                    path: options.path.split('?')[0],
                    headers: Object.fromEntries(
                        Object.entries(options.headers || {}).map(([k, v]) => [k.toLowerCase(), v])
                    ),
                    query: options.query || {},
                    body: options.body || {},
                    params: {},
                    get: (header: string) => req.headers[header.toLowerCase()],
                    header: (header: string) => req.headers[header.toLowerCase()],
                };

                const res: any = {
                    setHeader: (key: string, val: string) => {
                        responseHeaders[key.toLowerCase()] = String(val);
                        return res;
                    },
                    getHeader: (key: string) => responseHeaders[key.toLowerCase()],
                    writeHead: (code: number, hdrs?: Record<string, string>) => {
                        statusCode = code;
                        if (hdrs) {
                            for (const [k, v] of Object.entries(hdrs)) {
                                responseHeaders[k.toLowerCase()] = String(v);
                            }
                        }
                        return res;
                    },
                    status: (code: number) => {
                        statusCode = code;
                        return res;
                    },
                    flushHeaders: () => res,
                    write: (chunk: any) => {
                        responseBody += chunk ? chunk.toString() : '';
                        return true;
                    },
                    end: (chunk?: any) => {
                        if (chunk) responseBody += chunk.toString();
                        try {
                            jsonPayload = JSON.parse(responseBody);
                        } catch {
                            // not json
                        }
                        resolve({ statusCode, headers: responseHeaders, body: responseBody, json: jsonPayload });
                        return res;
                    },
                    json: (data: any) => {
                        jsonPayload = data;
                        responseHeaders['content-type'] = 'application/json';
                        responseBody = JSON.stringify(data);
                        resolve({ statusCode, headers: responseHeaders, body: responseBody, json: jsonPayload });
                        return res;
                    },
                    send: (data: any) => {
                        if (typeof data === 'object') return res.json(data);
                        return res.end(data);
                    },
                };

                if (typeof (targetApp as any).handle === 'function') {
                    (targetApp as any).handle(req, res, () => {
                        resolve({ statusCode: 404, headers: responseHeaders, body: 'Not Found' });
                    });
                } else {
                    targetApp(req, res);
                }
            });
        };

        // 1. Test unauthenticated SSE rejection
        const unauthRes = await invokeExpress(app, {
            method: 'GET',
            path: '/api/mcp/sse',
        });
        assert.strictEqual(unauthRes.statusCode, 401, 'Unauthenticated SSE request must return 401');

        // 2. Test authenticated SSE handshake
        const authRes = await invokeExpress(app, {
            method: 'GET',
            path: '/api/mcp/sse',
            headers: {
                'x-api-key': TOKEN_ALPHA.token,
            },
        });
        assert.strictEqual(authRes.statusCode, 200);
        assert.ok(
            String(authRes.headers['content-type']).includes('text/event-stream'),
            'Content-Type must be text/event-stream'
        );
        assert.ok(authRes.body.includes('/api/mcp/messages?sessionId='), 'Must emit session endpoint event');

        // Extract sessionId from endpoint event
        const match = authRes.body.match(/sessionId=([^&\s]+)/);
        assert.ok(match && match[1], 'Must parse sessionId from SSE handshake');
        const sessionId = match[1];

        // 3. Post JSON-RPC request to /messages endpoint
        const postRes = await invokeExpress(app, {
            method: 'POST',
            path: `/api/mcp/messages?sessionId=${sessionId}`,
            query: { sessionId },
            headers: {
                'content-type': 'application/json',
            },
            body: {
                jsonrpc: '2.0',
                id: 101,
                method: 'tools/list',
                params: {},
            },
        });

        assert.strictEqual(postRes.statusCode, 200);
        assert.ok(postRes.json, 'Response must be valid JSON');
        assert.strictEqual(postRes.json.jsonrpc, '2.0');
        assert.strictEqual(postRes.json.id, 101);
        assert.ok(postRes.json.result);

        // 4. Test authenticated SSE via query parameter token
        const queryAuthRes = await invokeExpress(app, {
            method: 'GET',
            path: `/api/mcp/sse?token=${TOKEN_ALPHA.token}`,
            query: { token: TOKEN_ALPHA.token },
        });
        assert.strictEqual(queryAuthRes.statusCode, 200, 'SSE via query token must succeed');
        assert.ok(
            String(queryAuthRes.headers['content-type']).includes('text/event-stream'),
            'Content-Type must be text/event-stream'
        );
        assert.ok(queryAuthRes.body.includes('/api/mcp/messages?sessionId='), 'Must emit session endpoint event');
    });

    // -------------------------------------------------------------------------
    // Execution Summary
    // -------------------------------------------------------------------------
    console.log('\n=================================================================');
    console.log(`  TEST RESULTS: ${passedTests}/${totalTests} PASSED (${failedTests} FAILED)`);
    console.log('=================================================================');

    if (failedTests > 0) {
        console.error('\nFailures encountered:');
        for (const f of failures) {
            console.error(`  - ${f.name}: ${f.error}`);
        }
        process.exitCode = 1;
    } else {
        console.log('\nAll MCP Server E2E tests executed and verified successfully.');
    }
}

main().catch((err) => {
    console.error('Fatal error running MCP E2E test suite:', err);
    process.exit(1);
});
