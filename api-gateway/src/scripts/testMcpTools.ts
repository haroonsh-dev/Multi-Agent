/**
 * Dedicated Verification Suite for Milestone 2:
 * - MCP 7 Domain Tools Implementation (src/mcp/tools.ts)
 *   1. ask_agent: Domain routing across 6 agents with context docs
 *   2. search_documents: Keyword, classification, pagination, multi-tenancy
 *   3. get_document_details: Metadata, OCR preview, 4,000 char truncation, tenancy
 *   4. get_portfolio_readiness: Health scores across 6 agents
 *   5. get_pending_approvals: Invoices, certs, candidates, contracts
 *   6. execute_workflow_decision: approve, reject, reprocess, flag + audit log (source = "mcp")
 *   7. get_workflow_overview: Summary metrics & recent executions
 *   - executeTool: Unified dispatcher & unknown tool handling
 *   - McpServer & InMemoryTransport client integration
 *   - Multi-tenant context enforcement & concurrency isolation
 * 
 * Run:
 *   npx tsx src/scripts/testMcpTools.ts
 */
import assert from 'node:assert/strict';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import {
    registerMcpTools,
    executeTool,
    truncateTextPayload,
    TEXT_SIZE_LIMIT,
    handleAskAgent,
    handleSearchDocuments,
    handleGetDocumentDetails,
    handleGetPortfolioReadiness,
    handleGetPendingApprovals,
    handleExecuteWorkflowDecision,
    handleGetWorkflowOverview,
} from '../mcp/tools';
import {
    runWithMcpContext,
    getMcpContext,
    McpTenantContext,
} from '../mcp/context';
import { ANALYTICS_AGENT_IDS } from '../constants/agentCatalog';
import {
    fixtureStore,
    ORG_ALPHA,
    ORG_BETA,
    LONG_OCR_TEXT,
    CANONICAL_TOOL_NAMES,
} from './mcpE2eTestHarness';

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

// Alpha tenant context
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

// Beta tenant context
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

async function createTestClientAndServer() {
    const server = new McpServer({ name: 'visibility-docs-m2-server', version: '1.0.0' });
    registerMcpTools(server);

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'visibility-docs-m2-client', version: '1.0.0' });

    await server.connect(serverTransport);
    await client.connect(clientTransport);

    return { server, client };
}

async function run() {
    console.log('=================================================================');
    console.log('  MILESTONE 2 VERIFICATION: MCP DOMAIN TOOLS SUITE');
    console.log('=================================================================\n');

    fixtureStore.reset();
    const { client } = await createTestClientAndServer();

    // -------------------------------------------------------------------------
    // Part 1: Tool Discovery & Registration
    // -------------------------------------------------------------------------
    console.log('--- Part 1: Tool Discovery & Registration ---');

    await test('Tool Discovery: client.listTools lists all 7 canonical domain tools', async () => {
        const res = await client.listTools();
        assert.ok(Array.isArray(res.tools), 'tools must be an array');
        assert.strictEqual(res.tools.length, 7, 'Must register exactly 7 tools on McpServer');

        for (const toolName of CANONICAL_TOOL_NAMES) {
            const found = res.tools.find((t) => t.name === toolName);
            assert.ok(found, `Tool ${toolName} must be registered on McpServer`);
            assert.ok(found.description, `Tool ${toolName} must have a description`);
            assert.ok(found.inputSchema, `Tool ${toolName} must have an inputSchema`);
        }
    });

    await test('Tool Schemas: All 7 tools specify valid input schemas', async () => {
        const res = await client.listTools();

        const askAgentTool = res.tools.find((t) => t.name === 'ask_agent');
        assert.ok(askAgentTool);
        const askProps = (askAgentTool.inputSchema as any)?.properties;
        assert.ok(askProps?.agent_id, 'ask_agent requires agent_id');
        assert.ok(askProps?.message, 'ask_agent requires message');
        assert.ok(askProps?.document_ids, 'ask_agent allows document_ids');

        const searchDocsTool = res.tools.find((t) => t.name === 'search_documents');
        assert.ok(searchDocsTool);
        const searchProps = (searchDocsTool.inputSchema as any)?.properties;
        assert.ok(searchProps?.query, 'search_documents allows query');
        assert.ok(searchProps?.classification, 'search_documents allows classification');
        assert.ok(searchProps?.limit, 'search_documents allows limit');
        assert.ok(searchProps?.skip, 'search_documents allows skip');

        const docDetailsTool = res.tools.find((t) => t.name === 'get_document_details');
        assert.ok(docDetailsTool);
        const docProps = (docDetailsTool.inputSchema as any)?.properties;
        assert.ok(docProps?.document_id, 'get_document_details requires document_id');

        const execDecisionTool = res.tools.find((t) => t.name === 'execute_workflow_decision');
        assert.ok(execDecisionTool);
        const execProps = (execDecisionTool.inputSchema as any)?.properties;
        assert.ok(execProps?.document_id, 'execute_workflow_decision requires document_id');
        assert.ok(execProps?.decision, 'execute_workflow_decision requires decision');
    });

    // -------------------------------------------------------------------------
    // Part 2: Tool 1 — ask_agent
    // -------------------------------------------------------------------------
    console.log('\n--- Part 2: Tool 1 — ask_agent ---');

    await test('ask_agent: Dispatches queries across all 6 canonical domain agents', async () => {
        for (const agentId of ANALYTICS_AGENT_IDS) {
            const res = await runWithMcpContext(ALPHA_CONTEXT, async () => {
                return handleAskAgent({
                    agent_id: agentId,
                    message: `Status report and audit for ${agentId}`,
                });
            });
            assert.strictEqual(res.agent_id, agentId);
            assert.strictEqual(res.organizationId, 'org_alpha');
            assert.ok(res.response.includes(`[${agentId}]`));
            assert.ok(res.timestamp);
        }
    });

    await test('ask_agent: Attaches context documents matching tenant', async () => {
        const res = await runWithMcpContext(ALPHA_CONTEXT, async () => {
            return handleAskAgent({
                agent_id: 'finance_agent',
                message: 'Review carrier invoice',
                document_ids: ['doc_alpha_inv_001'],
            });
        });
        assert.ok(res.response.includes('INV-2026-001_CarrierFreight.pdf'), 'Context document filename must appear');
    });

    await test('ask_agent: Ignores cross-tenant document context in attachment list', async () => {
        const res = await runWithMcpContext(ALPHA_CONTEXT, async () => {
            return handleAskAgent({
                agent_id: 'finance_agent',
                message: 'Review carrier invoice',
                document_ids: ['doc_beta_inv_001'], // Belongs to Beta
            });
        });
        assert.ok(!res.response.includes('Confidential_Beta_Supplier_Invoice.pdf'), 'Beta document must not be attached to Alpha');
    });

    await test('ask_agent: Rejects invalid agent identifier', async () => {
        await assert.rejects(
            async () => {
                await runWithMcpContext(ALPHA_CONTEXT, async () => {
                    await handleAskAgent({
                        agent_id: 'invalid_super_agent',
                        message: 'Hello',
                    });
                });
            },
            /Invalid agent_id/,
            'Must reject unknown agent_id'
        );
    });

    await test('ask_agent: Rejects empty message', async () => {
        await assert.rejects(
            async () => {
                await runWithMcpContext(ALPHA_CONTEXT, async () => {
                    await handleAskAgent({
                        agent_id: 'finance_agent',
                        message: '   ',
                    });
                });
            },
            /Message is required/,
            'Must reject blank message'
        );
    });

    await test('ask_agent: Executes via MCP client over InMemoryTransport', async () => {
        await runWithMcpContext(ALPHA_CONTEXT, async () => {
            const callRes = await client.callTool({
                name: 'ask_agent',
                arguments: {
                    agent_id: 'procurement_agent',
                    message: 'Check vendor compliance',
                },
            });
            assert.ok(Array.isArray((callRes as any).content));
            const parsed = JSON.parse(((callRes as any).content[0] as any).text);
            assert.strictEqual(parsed.agent_id, 'procurement_agent');
            assert.strictEqual(parsed.organizationId, 'org_alpha');
        });
    });

    // -------------------------------------------------------------------------
    // Part 3: Tool 2 — search_documents
    // -------------------------------------------------------------------------
    console.log('\n--- Part 3: Tool 2 — search_documents ---');

    await test('search_documents: Empty query returns all organization documents', async () => {
        const res = await runWithMcpContext(ALPHA_CONTEXT, async () => {
            return handleSearchDocuments({});
        });
        assert.strictEqual(res.organizationId, 'org_alpha');
        assert.ok(res.total >= 4, 'Must return at least 4 Alpha fixture documents');
        for (const doc of res.documents) {
            assert.ok(doc.documentId.startsWith('doc_alpha_'));
        }
    });

    await test('search_documents: Filters by keyword query', async () => {
        const res = await runWithMcpContext(ALPHA_CONTEXT, async () => {
            return handleSearchDocuments({ query: 'Freight' });
        });
        assert.ok(res.total >= 1);
        assert.strictEqual(res.documents[0].documentId, 'doc_alpha_inv_001');
    });

    await test('search_documents: Filters by classification type', async () => {
        const res = await runWithMcpContext(ALPHA_CONTEXT, async () => {
            return handleSearchDocuments({ classification: 'certificate' });
        });
        assert.ok(res.total >= 1);
        assert.strictEqual(res.documents[0].classification, 'certificate');
        assert.strictEqual(res.documents[0].documentId, 'doc_alpha_cert_002');
    });

    await test('search_documents: Pagination limit and skip offsets', async () => {
        const page1 = await runWithMcpContext(ALPHA_CONTEXT, async () => {
            return handleSearchDocuments({ limit: 2, skip: 0 });
        });
        assert.strictEqual(page1.documents.length, 2);

        const page2 = await runWithMcpContext(ALPHA_CONTEXT, async () => {
            return handleSearchDocuments({ limit: 2, skip: 2 });
        });
        assert.strictEqual(page2.documents.length, 2);
        assert.notStrictEqual(page1.documents[0].documentId, page2.documents[0].documentId);
    });

    await test('search_documents: Multi-tenant isolation between Alpha and Beta', async () => {
        const alphaRes = await runWithMcpContext(ALPHA_CONTEXT, async () => {
            return handleSearchDocuments({ query: 'Beta' });
        });
        assert.strictEqual(alphaRes.total, 0, 'Alpha search must never reveal Beta documents');

        const betaRes = await runWithMcpContext(BETA_CONTEXT, async () => {
            return handleSearchDocuments({ query: 'Beta' });
        });
        assert.ok(betaRes.total >= 1, 'Beta search must reveal Beta documents');
        assert.strictEqual(betaRes.documents[0].documentId, 'doc_beta_inv_001');
    });

    await test('search_documents: Executes via MCP client over InMemoryTransport', async () => {
        await runWithMcpContext(ALPHA_CONTEXT, async () => {
            const callRes = await client.callTool({
                name: 'search_documents',
                arguments: { classification: 'invoice' },
            });
            const parsed = JSON.parse(((callRes as any).content[0] as any).text);
            assert.ok(parsed.total >= 1);
            assert.strictEqual(parsed.documents[0].classification, 'invoice');
        });
    });

    // -------------------------------------------------------------------------
    // Part 4: Tool 3 — get_document_details
    // -------------------------------------------------------------------------
    console.log('\n--- Part 4: Tool 3 — get_document_details ---');

    await test('get_document_details: Retrieves metadata, status, and raw text preview', async () => {
        const res = await runWithMcpContext(ALPHA_CONTEXT, async () => {
            return handleGetDocumentDetails({ document_id: 'doc_alpha_inv_001' });
        });
        assert.strictEqual(res.documentId, 'doc_alpha_inv_001');
        assert.strictEqual(res.classification, 'invoice');
        assert.strictEqual(res.status, 'review');
        assert.ok(res.textPreview.includes('Carrier Freight Service Invoice'));
        assert.strictEqual(res.truncated, false);
    });

    await test('get_document_details: BVA text truncation under 4,000 characters is NOT truncated', async () => {
        const res = await runWithMcpContext(ALPHA_CONTEXT, async () => {
            return handleGetDocumentDetails({ document_id: 'doc_alpha_inv_001' });
        });
        assert.strictEqual(res.truncated, false);
    });

    await test('get_document_details: BVA text truncation over 4,000 characters truncates cleanly', async () => {
        const res = await runWithMcpContext(ALPHA_CONTEXT, async () => {
            return handleGetDocumentDetails({ document_id: 'doc_alpha_long_004' });
        });
        assert.strictEqual(res.truncated, true);
        assert.ok(res.textPreview.includes('[Truncated:'), 'Must append truncation notice');
        assert.ok(res.textPreview.length > TEXT_SIZE_LIMIT);
    });

    await test('get_document_details: Throws descriptive error for non-existent document', async () => {
        await assert.rejects(
            async () => {
                await runWithMcpContext(ALPHA_CONTEXT, async () => {
                    await handleGetDocumentDetails({ document_id: 'doc_non_existent' });
                });
            },
            /not found in tenant org_alpha/,
            'Must throw not found error'
        );
    });

    await test('get_document_details: Multi-tenant isolation blocks cross-tenant access', async () => {
        await assert.rejects(
            async () => {
                await runWithMcpContext(ALPHA_CONTEXT, async () => {
                    await handleGetDocumentDetails({ document_id: 'doc_beta_inv_001' });
                });
            },
            /not found in tenant org_alpha/,
            'Alpha must not be allowed to inspect Beta document'
        );
    });

    await test('get_document_details: Executes via MCP client over InMemoryTransport', async () => {
        await runWithMcpContext(ALPHA_CONTEXT, async () => {
            const callRes = await client.callTool({
                name: 'get_document_details',
                arguments: { document_id: 'doc_alpha_inv_001' },
            });
            const parsed = JSON.parse(((callRes as any).content[0] as any).text);
            assert.strictEqual(parsed.documentId, 'doc_alpha_inv_001');
        });
    });

    // -------------------------------------------------------------------------
    // Part 5: Tool 4 — get_portfolio_readiness
    // -------------------------------------------------------------------------
    console.log('\n--- Part 5: Tool 4 — get_portfolio_readiness ---');

    await test('get_portfolio_readiness: Returns fleet health scores across 6 agents', async () => {
        const res = await runWithMcpContext(ALPHA_CONTEXT, async () => {
            return handleGetPortfolioReadiness();
        });
        assert.strictEqual(res.organizationId, 'org_alpha');
        assert.ok(Array.isArray(res.agents));
        assert.strictEqual(res.agents.length, 6, 'Must have stats for all 6 domain agents');

        const financeAgent = res.agents.find((a: any) => a.agentId === 'finance_agent');
        assert.ok(financeAgent);
        assert.ok(financeAgent.documentCount >= 1);
        assert.ok(['Ready', 'Partial', 'Needs work', 'Empty'].includes(financeAgent.healthLabel));
    });

    await test('get_portfolio_readiness: Readiness metrics are strictly scoped to calling tenant', async () => {
        const alphaRes = await runWithMcpContext(ALPHA_CONTEXT, async () => {
            return handleGetPortfolioReadiness();
        });
        const betaRes = await runWithMcpContext(BETA_CONTEXT, async () => {
            return handleGetPortfolioReadiness();
        });

        assert.strictEqual(alphaRes.organizationId, 'org_alpha');
        assert.strictEqual(betaRes.organizationId, 'org_beta');
    });

    await test('get_portfolio_readiness: Executes via MCP client over InMemoryTransport', async () => {
        await runWithMcpContext(ALPHA_CONTEXT, async () => {
            const callRes = await client.callTool({
                name: 'get_portfolio_readiness',
                arguments: {},
            });
            const parsed = JSON.parse(((callRes as any).content[0] as any).text);
            assert.strictEqual(parsed.organizationId, 'org_alpha');
            assert.strictEqual(parsed.agents.length, 6);
        });
    });

    // -------------------------------------------------------------------------
    // Part 6: Tool 5 — get_pending_approvals
    // -------------------------------------------------------------------------
    console.log('\n--- Part 6: Tool 5 — get_pending_approvals ---');

    await test('get_pending_approvals: Groups pending items by category', async () => {
        const res = await runWithMcpContext(ALPHA_CONTEXT, async () => {
            return handleGetPendingApprovals();
        });
        assert.strictEqual(res.organizationId, 'org_alpha');
        assert.ok(res.pendingApprovals);
        assert.ok(Array.isArray(res.pendingApprovals.invoices));
        assert.ok(Array.isArray(res.pendingApprovals.certificates));
        assert.ok(Array.isArray(res.pendingApprovals.candidates));
        assert.ok(Array.isArray(res.pendingApprovals.contracts));

        assert.ok(res.pendingApprovals.invoices.length >= 1);
        assert.ok(res.pendingApprovals.certificates.length >= 1);
        assert.ok(res.pendingApprovals.candidates.length >= 1);
        assert.strictEqual(
            res.totalPending,
            res.pendingApprovals.invoices.length +
                res.pendingApprovals.certificates.length +
                res.pendingApprovals.candidates.length +
                res.pendingApprovals.contracts.length
        );
    });

    await test('get_pending_approvals: Scoped strictly to calling tenant', async () => {
        const alphaRes = await runWithMcpContext(ALPHA_CONTEXT, async () => {
            return handleGetPendingApprovals();
        });
        const betaRes = await runWithMcpContext(BETA_CONTEXT, async () => {
            return handleGetPendingApprovals();
        });

        const alphaDocIds = alphaRes.pendingApprovals.invoices.map((i: any) => i.documentId);
        assert.ok(alphaDocIds.includes('doc_alpha_inv_001'));
        assert.ok(!alphaDocIds.includes('doc_beta_inv_001'));

        const betaDocIds = betaRes.pendingApprovals.invoices.map((i: any) => i.documentId);
        assert.ok(betaDocIds.includes('doc_beta_inv_001'));
        assert.ok(!betaDocIds.includes('doc_alpha_inv_001'));
    });

    await test('get_pending_approvals: Executes via MCP client over InMemoryTransport', async () => {
        await runWithMcpContext(ALPHA_CONTEXT, async () => {
            const callRes = await client.callTool({
                name: 'get_pending_approvals',
                arguments: {},
            });
            const parsed = JSON.parse(((callRes as any).content[0] as any).text);
            assert.strictEqual(parsed.organizationId, 'org_alpha');
            assert.ok(parsed.totalPending >= 3);
        });
    });

    // -------------------------------------------------------------------------
    // Part 7: Tool 6 — execute_workflow_decision
    // -------------------------------------------------------------------------
    console.log('\n--- Part 7: Tool 6 — execute_workflow_decision ---');

    await test('execute_workflow_decision: Decision "approve" updates status and stage', async () => {
        fixtureStore.reset();
        const res = await runWithMcpContext(ALPHA_CONTEXT, async () => {
            return handleExecuteWorkflowDecision({
                document_id: 'doc_alpha_inv_001',
                decision: 'approve',
                notes: 'Approved by finance officer',
            });
        });
        assert.strictEqual(res.success, true);
        assert.strictEqual(res.decision, 'approve');
        assert.strictEqual(res.status, 'ready');
        assert.strictEqual(res.source, 'mcp');
        assert.strictEqual(res.auditLogged, true);

        const updatedDoc = fixtureStore.documents.get('doc_alpha_inv_001');
        assert.strictEqual(updatedDoc?.status, 'ready');
        const wf = (updatedDoc?.metadata as any)?.workflowExecution;
        assert.strictEqual(wf?.stage, 'approved');
        assert.strictEqual(wf?.verdict, 'Approved via MCP');
    });

    await test('execute_workflow_decision: Decision "reject" updates status to failed', async () => {
        fixtureStore.reset();
        const res = await runWithMcpContext(ALPHA_CONTEXT, async () => {
            return handleExecuteWorkflowDecision({
                document_id: 'doc_alpha_inv_001',
                decision: 'reject',
                notes: 'Over budget',
            });
        });
        assert.strictEqual(res.status, 'failed');
        const updatedDoc = fixtureStore.documents.get('doc_alpha_inv_001');
        assert.strictEqual(updatedDoc?.status, 'failed');
    });

    await test('execute_workflow_decision: Decision "reprocess" updates status to processing', async () => {
        fixtureStore.reset();
        const res = await runWithMcpContext(ALPHA_CONTEXT, async () => {
            return handleExecuteWorkflowDecision({
                document_id: 'doc_alpha_inv_001',
                decision: 'reprocess',
            });
        });
        assert.strictEqual(res.status, 'processing');
        const updatedDoc = fixtureStore.documents.get('doc_alpha_inv_001');
        assert.strictEqual(updatedDoc?.status, 'processing');
    });

    await test('execute_workflow_decision: Decision "flag" updates status to review', async () => {
        fixtureStore.reset();
        const res = await runWithMcpContext(ALPHA_CONTEXT, async () => {
            return handleExecuteWorkflowDecision({
                document_id: 'doc_alpha_inv_001',
                decision: 'flag',
                notes: 'Suspicious vendor details',
            });
        });
        assert.strictEqual(res.status, 'review');
        const updatedDoc = fixtureStore.documents.get('doc_alpha_inv_001');
        assert.strictEqual(updatedDoc?.status, 'review');
    });

    await test('execute_workflow_decision: Records audit log entry with source="mcp"', async () => {
        fixtureStore.reset();
        await runWithMcpContext(ALPHA_CONTEXT, async () => {
            await handleExecuteWorkflowDecision({
                document_id: 'doc_alpha_inv_001',
                decision: 'approve',
                notes: 'Audited and verified',
            });
        });

        const logs = fixtureStore.activityLogs.filter(
            (l) => l.organizationId === 'org_alpha' && l.metadata?.documentId === 'doc_alpha_inv_001'
        );
        assert.ok(logs.length >= 1, 'ActivityLog entry must be created');
        const log = logs[logs.length - 1];
        assert.strictEqual(log.metadata?.source, 'mcp', 'Must tag audit log with source="mcp"');
        assert.strictEqual(log.metadata?.decision, 'approve');
        assert.strictEqual(log.metadata?.notes, 'Audited and verified');
    });

    await test('execute_workflow_decision: Rejects invalid decision verb', async () => {
        await assert.rejects(
            async () => {
                await runWithMcpContext(ALPHA_CONTEXT, async () => {
                    await handleExecuteWorkflowDecision({
                        document_id: 'doc_alpha_inv_001',
                        decision: 'archive' as any,
                    });
                });
            },
            /Invalid decision/,
            'Must reject unapproved decision verb'
        );
    });

    await test('execute_workflow_decision: Multi-tenant isolation blocks cross-tenant updates', async () => {
        await assert.rejects(
            async () => {
                await runWithMcpContext(ALPHA_CONTEXT, async () => {
                    await handleExecuteWorkflowDecision({
                        document_id: 'doc_beta_inv_001',
                        decision: 'approve',
                    });
                });
            },
            /not found in tenant org_alpha/,
            'Alpha must not be allowed to execute workflow decisions on Beta documents'
        );
    });

    await test('execute_workflow_decision: Executes via MCP client over InMemoryTransport', async () => {
        fixtureStore.reset();
        await runWithMcpContext(ALPHA_CONTEXT, async () => {
            const callRes = await client.callTool({
                name: 'execute_workflow_decision',
                arguments: {
                    document_id: 'doc_alpha_inv_001',
                    decision: 'approve',
                    notes: 'Client callTool approval',
                },
            });
            const parsed = JSON.parse(((callRes as any).content[0] as any).text);
            assert.strictEqual(parsed.success, true);
            assert.strictEqual(parsed.decision, 'approve');
            assert.strictEqual(parsed.source, 'mcp');
        });
    });

    // -------------------------------------------------------------------------
    // Part 8: Tool 7 — get_workflow_overview
    // -------------------------------------------------------------------------
    console.log('\n--- Part 8: Tool 7 — get_workflow_overview ---');

    await test('get_workflow_overview: Returns aggregated organization KPIs', async () => {
        fixtureStore.reset();
        const res = await runWithMcpContext(ALPHA_CONTEXT, async () => {
            return handleGetWorkflowOverview();
        });
        assert.strictEqual(res.organizationId, 'org_alpha');
        assert.ok(res.summary);
        assert.ok(typeof res.summary.pendingApprovals === 'number');
        assert.ok(typeof res.summary.expiringCertificates === 'number');
        assert.ok(typeof res.summary.shortlistedCandidates === 'number');
        assert.ok(Array.isArray(res.recentExecutions));
    });

    await test('get_workflow_overview: Reflects executions in recentExecutions and summary', async () => {
        fixtureStore.reset();
        await runWithMcpContext(ALPHA_CONTEXT, async () => {
            await handleExecuteWorkflowDecision({
                document_id: 'doc_alpha_inv_001',
                decision: 'flag',
                notes: 'Flagged for tax check',
            });
        });

        const res = await runWithMcpContext(ALPHA_CONTEXT, async () => {
            return handleGetWorkflowOverview();
        });
        assert.ok(res.recentExecutions.length >= 1, 'Recent executions must include logged decision');
        const latest = res.recentExecutions[res.recentExecutions.length - 1];
        assert.strictEqual(latest.metadata?.source, 'mcp');
        assert.strictEqual(latest.metadata?.decision, 'flag');
    });

    await test('get_workflow_overview: Executes via MCP client over InMemoryTransport', async () => {
        await runWithMcpContext(ALPHA_CONTEXT, async () => {
            const callRes = await client.callTool({
                name: 'get_workflow_overview',
                arguments: {},
            });
            const parsed = JSON.parse(((callRes as any).content[0] as any).text);
            assert.strictEqual(parsed.organizationId, 'org_alpha');
            assert.ok(parsed.summary);
        });
    });

    // -------------------------------------------------------------------------
    // Part 9: Unified executeTool Dispatcher & Tenancy Context
    // -------------------------------------------------------------------------
    console.log('\n--- Part 9: executeTool Dispatcher & Tenancy Context ---');

    await test('executeTool: Dispatches each of the 7 tools by name', async () => {
        await runWithMcpContext(ALPHA_CONTEXT, async () => {
            const t1 = await executeTool('ask_agent', { agent_id: 'finance_agent', message: 'Test' });
            assert.strictEqual(t1.agent_id, 'finance_agent');

            const t2 = await executeTool('search_documents', { limit: 1 });
            assert.strictEqual(t2.organizationId, 'org_alpha');

            const t3 = await executeTool('get_document_details', { document_id: 'doc_alpha_inv_001' });
            assert.strictEqual(t3.documentId, 'doc_alpha_inv_001');

            const t4 = await executeTool('get_portfolio_readiness', {});
            assert.strictEqual(t4.agents.length, 6);

            const t5 = await executeTool('get_pending_approvals', {});
            assert.ok(t5.totalPending >= 1);

            const t6 = await executeTool('execute_workflow_decision', {
                document_id: 'doc_alpha_inv_001',
                decision: 'reprocess',
            });
            assert.strictEqual(t6.success, true);

            const t7 = await executeTool('get_workflow_overview', {});
            assert.ok(t7.summary);
        });
    });

    await test('executeTool: Rejects unknown tool name', async () => {
        await assert.rejects(
            async () => {
                await runWithMcpContext(ALPHA_CONTEXT, async () => {
                    await executeTool('unknown_magic_tool', {});
                });
            },
            /Unknown tool: unknown_magic_tool/,
            'Must throw error for unknown tool'
        );
    });

    await test('Tenancy Context: Tools throw when executed outside active MCP tenant context', async () => {
        await assert.rejects(
            async () => {
                await handleSearchDocuments({});
            },
            /No active MCP tenant context found/,
            'Tools must enforce active tenant context'
        );
    });

    await test('Tenancy Context: Concurrent executions across Alpha and Beta preserve isolation', async () => {
        const runAlpha = runWithMcpContext(ALPHA_CONTEXT, async () => {
            for (let i = 0; i < 5; i++) {
                await new Promise((r) => setTimeout(r, 5));
                const res = await handleSearchDocuments({});
                assert.strictEqual(res.organizationId, 'org_alpha');
                for (const doc of res.documents) {
                    assert.ok(!doc.documentId.includes('beta'));
                }
            }
        });

        const runBeta = runWithMcpContext(BETA_CONTEXT, async () => {
            for (let i = 0; i < 5; i++) {
                await new Promise((r) => setTimeout(r, 5));
                const res = await handleSearchDocuments({});
                assert.strictEqual(res.organizationId, 'org_beta');
                for (const doc of res.documents) {
                    assert.ok(!doc.documentId.includes('alpha'));
                }
            }
        });

        await Promise.all([runAlpha, runBeta]);
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
        console.log('\nAll Milestone 2 MCP Tools verified successfully (100% pass rate).');
    }
}

run().catch((err) => {
    console.error('Fatal error running testMcpTools:', err);
    process.exit(1);
});
