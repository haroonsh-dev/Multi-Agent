/**
 * Dedicated Verification Suite for Milestone 3:
 * - MCP Standard Resources (src/mcp/resources.ts)
 *   - docs://documents/{documentId} with 4,000-char text truncation protection & multi-tenant isolation
 *   - docs://overview with live organization statistics, breakdown by classification, portfolio readiness health, pending approvals, and workflow KPIs
 * - MCP Pre-Configured Prompts (src/mcp/prompts.ts)
 *   - financial_audit_review targeting finance_agent
 *   - compliance_expiry_audit targeting compliance_agent
 *   - hr_talent_shortlist targeting hr_agent
 * 
 * Run:
 *   npx tsx src/scripts/testMcpResourcesPrompts.ts
 */
import assert from 'node:assert/strict';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import {
    registerMcpResources,
    readDocumentResource,
    readOverviewResource,
    truncateTextPayload,
    TEXT_SIZE_LIMIT,
} from '../mcp/resources';
import {
    registerMcpPrompts,
    getFinancialAuditReviewPrompt,
    getComplianceExpiryAuditPrompt,
    getHrTalentShortlistPrompt,
    CANONICAL_PROMPT_NAMES,
} from '../mcp/prompts';
import {
    runWithMcpContext,
    McpTenantContext,
} from '../mcp/context';
import {
    fixtureStore,
    ORG_ALPHA,
    ORG_BETA,
    LONG_OCR_TEXT,
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
    const server = new McpServer({ name: 'visibility-docs-m3-server', version: '1.0.0' });
    registerMcpResources(server);
    registerMcpPrompts(server);

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'visibility-docs-m3-client', version: '1.0.0' });

    await server.connect(serverTransport);
    await client.connect(clientTransport);

    return { server, client };
}

async function run() {
    console.log('=================================================================');
    console.log('  MILESTONE 3 VERIFICATION: MCP RESOURCES & PROMPTS');
    console.log('=================================================================\n');

    fixtureStore.reset();
    const { client } = await createTestClientAndServer();

    // -------------------------------------------------------------------------
    // Part 1: MCP Standard Resources Discovery & Hydration
    // -------------------------------------------------------------------------
    console.log('--- Part 1: MCP Standard Resources ---');

    await test('Resources Discovery: client.listResources lists docs://overview', async () => {
        const res = await client.listResources();
        assert.ok(Array.isArray(res.resources), 'resources must be an array');
        const overviewRes = res.resources.find((r) => r.uri === 'docs://overview');
        assert.ok(overviewRes, 'docs://overview must be registered as a static resource');
        assert.strictEqual(overviewRes.mimeType, 'application/json');
    });

    await test('Resources Discovery: client.listResourceTemplates lists docs://documents/{documentId}', async () => {
        const res = await client.listResourceTemplates();
        assert.ok(Array.isArray(res.resourceTemplates), 'resourceTemplates must be an array');
        const docTemplate = res.resourceTemplates.find((t) => t.uriTemplate === 'docs://documents/{documentId}');
        assert.ok(docTemplate, 'docs://documents/{documentId} must be registered as a resource template');
    });

    await test('Resource Read: docs://documents/{documentId} returns hydrated document payload within size limit', async () => {
        await runWithMcpContext(ALPHA_CONTEXT, async () => {
            const res = await client.readResource({ uri: 'docs://documents/doc_alpha_inv_001' });
            assert.ok(Array.isArray(res.contents) && res.contents.length > 0);
            assert.strictEqual(res.contents[0].uri, 'docs://documents/doc_alpha_inv_001');
            assert.strictEqual(res.contents[0].mimeType, 'application/json');

            const payload = JSON.parse((res.contents[0] as any).text);
            assert.strictEqual(payload.documentId, 'doc_alpha_inv_001');
            assert.strictEqual(payload.classification, 'invoice');
            assert.strictEqual(payload.status, 'review');
            assert.ok(payload.content.includes('Carrier Freight Service Invoice'));
            assert.strictEqual(payload.truncated, false, 'Payload <= 4,000 chars must have truncated: false');
        });
    });

    await test('Resource Read: docs://documents/{documentId} enforces 4,000 char size protection on large files', async () => {
        await runWithMcpContext(ALPHA_CONTEXT, async () => {
            const res = await client.readResource({ uri: 'docs://documents/doc_alpha_long_004' });
            const payload = JSON.parse((res.contents[0] as any).text);
            assert.strictEqual(payload.documentId, 'doc_alpha_long_004');
            assert.strictEqual(payload.truncated, true, 'Long document (>4,000 chars) must have truncated: true');
            assert.ok(payload.content.includes('[Truncated:'), 'Must append truncation notice');
            assert.ok(payload.content.length > TEXT_SIZE_LIMIT, 'Text plus notice exceeds limit cleanly');
        });
    });

    await test('Resource Multi-Tenancy: Tenant Alpha cannot read Tenant Beta document', async () => {
        await assert.rejects(
            async () => {
                await runWithMcpContext(ALPHA_CONTEXT, async () => {
                    await client.readResource({ uri: 'docs://documents/doc_beta_inv_001' });
                });
            },
            /not found in tenant org_alpha/,
            'Tenant Alpha must not be allowed to read Tenant Beta document'
        );
    });

    await test('Resource Multi-Tenancy: Tenant Beta can read its own document', async () => {
        await runWithMcpContext(BETA_CONTEXT, async () => {
            const res = await client.readResource({ uri: 'docs://documents/doc_beta_inv_001' });
            const payload = JSON.parse((res.contents[0] as any).text);
            assert.strictEqual(payload.documentId, 'doc_beta_inv_001');
            assert.ok(payload.content.includes('Beta Confidential Supplier Invoice'));
        });
    });

    await test('Resource Error: Non-existent document ID throws descriptive not found error', async () => {
        await assert.rejects(
            async () => {
                await runWithMcpContext(ALPHA_CONTEXT, async () => {
                    await client.readResource({ uri: 'docs://documents/doc_non_existent_999' });
                });
            },
            /not found in tenant org_alpha/,
            'Missing document must return not found'
        );
    });

    await test('Resource Read: docs://overview returns live organization statistics and all 5 required KPI dimensions', async () => {
        await runWithMcpContext(ALPHA_CONTEXT, async () => {
            const res = await client.readResource({ uri: 'docs://overview' });
            assert.ok(Array.isArray(res.contents) && res.contents.length > 0);
            assert.strictEqual(res.contents[0].uri, 'docs://overview');

            const overview = JSON.parse((res.contents[0] as any).text);
            assert.strictEqual(overview.organizationId, 'org_alpha');
            assert.strictEqual(overview.organizationName, 'Alpha Logistics Inc');

            // 1. Total documents
            assert.ok(typeof overview.totalDocuments === 'number' && overview.totalDocuments >= 4);

            // 2. Breakdown by classification
            assert.ok(overview.breakdownByClassification, 'Must include breakdownByClassification');
            assert.ok(overview.breakdownByClassification.invoice >= 1);
            assert.ok(overview.breakdownByClassification.certificate >= 1);
            assert.ok(overview.breakdownByClassification.resume >= 1);

            // 3. Portfolio readiness health across domain fleet
            assert.ok(overview.portfolioReadiness, 'Must include portfolioReadiness');
            assert.ok(Array.isArray(overview.portfolioReadiness.agents));
            assert.strictEqual(overview.portfolioReadiness.agents.length, 6);
            const finance = overview.portfolioReadiness.agents.find((a: any) => a.agentId === 'finance_agent');
            assert.ok(finance, 'Finance agent metrics must be present');
            assert.ok(typeof finance.healthScore === 'number');

            // 4. Pending approvals (invoices, certs, candidates, contracts)
            assert.ok(overview.pendingApprovals, 'Must include pendingApprovals');
            assert.ok(Array.isArray(overview.pendingApprovals.invoices));
            assert.ok(Array.isArray(overview.pendingApprovals.certificates));
            assert.ok(Array.isArray(overview.pendingApprovals.candidates));
            assert.ok(Array.isArray(overview.pendingApprovals.contracts));
            assert.ok(overview.pendingApprovals.totalPending >= 1);

            // 5. Workflow KPIs
            assert.ok(overview.workflowKpis, 'Must include workflowKpis');
            assert.ok(typeof overview.workflowKpis.pendingApprovals === 'number');
            assert.ok(typeof overview.workflowKpis.expiringCertificates === 'number');
            assert.ok(typeof overview.workflowKpis.shortlistedCandidates === 'number');
            assert.ok(typeof overview.workflowKpis.flaggedRisks === 'number');
        });
    });

    await test('Resource Multi-Tenancy: docs://overview isolates statistics per active tenant', async () => {
        // Tenant Alpha overview
        const alphaOverview = await runWithMcpContext(ALPHA_CONTEXT, async () => {
            return await readOverviewResource();
        });
        assert.strictEqual(alphaOverview.organizationId, 'org_alpha');
        assert.ok(alphaOverview.totalDocuments >= 4);

        // Tenant Beta overview
        const betaOverview = await runWithMcpContext(BETA_CONTEXT, async () => {
            return await readOverviewResource();
        });
        assert.strictEqual(betaOverview.organizationId, 'org_beta');
        assert.strictEqual(betaOverview.totalDocuments, 1, 'Tenant Beta must only count its own documents');
        assert.strictEqual(betaOverview.breakdownByClassification.invoice, 1);
    });

    // -------------------------------------------------------------------------
    // Part 2: Boundary Value Analysis for Text Truncation
    // -------------------------------------------------------------------------
    console.log('\n--- Part 2: Boundary Value Analysis (Text Truncation) ---');

    await test('BVA Truncation: Empty string -> length 0, truncated false', () => {
        const res = truncateTextPayload('');
        assert.strictEqual(res.text, '');
        assert.strictEqual(res.truncated, false);
    });

    await test('BVA Truncation: Null / undefined -> length 0, truncated false', () => {
        const res1 = truncateTextPayload(null);
        const res2 = truncateTextPayload(undefined);
        assert.strictEqual(res1.text, '');
        assert.strictEqual(res1.truncated, false);
        assert.strictEqual(res2.text, '');
        assert.strictEqual(res2.truncated, false);
    });

    await test(`BVA Truncation: Exactly 3,999 chars (N-1) -> truncated false`, () => {
        const raw = 'X'.repeat(TEXT_SIZE_LIMIT - 1);
        const res = truncateTextPayload(raw);
        assert.strictEqual(res.text.length, TEXT_SIZE_LIMIT - 1);
        assert.strictEqual(res.truncated, false);
    });

    await test(`BVA Truncation: Exactly 4,000 chars (Boundary N) -> truncated false`, () => {
        const raw = 'Y'.repeat(TEXT_SIZE_LIMIT);
        const res = truncateTextPayload(raw);
        assert.strictEqual(res.text.length, TEXT_SIZE_LIMIT);
        assert.strictEqual(res.truncated, false);
    });

    await test(`BVA Truncation: Exactly 4,001 chars (N+1) -> truncated true with notice`, () => {
        const raw = 'Z'.repeat(TEXT_SIZE_LIMIT + 1);
        const res = truncateTextPayload(raw);
        assert.strictEqual(res.truncated, true);
        assert.ok(res.text.startsWith('Z'.repeat(TEXT_SIZE_LIMIT)));
        assert.ok(res.text.includes('[Truncated: 1 characters remaining]'));
    });

    await test(`BVA Truncation: 8,200 chars scanned document -> truncated true`, () => {
        const res = truncateTextPayload(LONG_OCR_TEXT);
        assert.strictEqual(res.truncated, true);
        const remainingChars = LONG_OCR_TEXT.length - TEXT_SIZE_LIMIT;
        assert.ok(res.text.includes(`[Truncated: ${remainingChars} characters remaining]`));
    });

    // -------------------------------------------------------------------------
    // Part 3: Pre-Configured Prompts Discovery & Execution
    // -------------------------------------------------------------------------
    console.log('\n--- Part 3: MCP Pre-Configured Prompts ---');

    await test('Prompts Discovery: client.listPrompts lists all 3 canonical prompts with schemas', async () => {
        const res = await client.listPrompts();
        assert.ok(Array.isArray(res.prompts), 'prompts must be an array');
        assert.strictEqual(res.prompts.length, 3, 'Must register exactly 3 prompt templates');

        for (const promptName of CANONICAL_PROMPT_NAMES) {
            const found = res.prompts.find((p) => p.name === promptName);
            assert.ok(found, `Prompt ${promptName} must be registered on McpServer`);
            assert.ok(Array.isArray(found.arguments), `Prompt ${promptName} must have argument definitions`);
        }
    });

    await test('Prompt Execution: financial_audit_review targets finance_agent with invoice and PO matching instructions', async () => {
        const promptRes = await client.getPrompt({
            name: 'financial_audit_review',
            arguments: {
                invoice_id: 'doc_alpha_inv_001',
                audit_depth: 'deep',
            },
        });

        assert.ok(promptRes.description, 'Must provide prompt description');
        assert.ok(promptRes.description.includes('finance_agent'), 'Description must mention target finance_agent');
        assert.ok(Array.isArray(promptRes.messages) && promptRes.messages.length >= 1);
        assert.strictEqual(promptRes.messages[0].role, 'user');

        const messageText = (promptRes.messages[0].content as any).text;
        assert.ok(messageText.includes('finance_agent'), 'Instructions must explicitly target finance_agent');
        assert.ok(messageText.includes('doc_alpha_inv_001'), 'Instructions must reference invoice document ID');
        assert.ok(messageText.includes('deep'), 'Instructions must specify audit depth');
        assert.ok(messageText.includes('Purchase Order'), 'Instructions must cover PO matching');
        assert.ok(messageText.includes('Tax/VAT'), 'Instructions must cover tax checks');
        assert.ok(messageText.includes('$1,000'), 'Instructions must include threshold authorization check');
    });

    await test('Prompt Execution: compliance_expiry_audit targets compliance_agent for certificate and CAPA auditing', async () => {
        const promptRes = await client.getPrompt({
            name: 'compliance_expiry_audit',
            arguments: {
                days_threshold: '60',
                department: 'Logistics',
            },
        });

        assert.ok(promptRes.description && promptRes.description.includes('compliance_agent'));
        assert.ok(Array.isArray(promptRes.messages) && promptRes.messages.length >= 1);

        const messageText = (promptRes.messages[0].content as any).text;
        assert.ok(messageText.includes('compliance_agent'), 'Instructions must explicitly target compliance_agent');
        assert.ok(messageText.includes('60 days'), 'Instructions must use specified days_threshold');
        assert.ok(messageText.includes('Logistics'), 'Instructions must reflect specified department');
        assert.ok(messageText.includes('ISO 9001'), 'Instructions must cover ISO certificates');
        assert.ok(messageText.includes('CAPA'), 'Instructions must cover CAPA / NCR actions');
    });

    await test('Prompt Execution: compliance_expiry_audit applies default 30-day threshold when omitted', async () => {
        const promptRes = await client.getPrompt({
            name: 'compliance_expiry_audit',
            arguments: {},
        });

        const messageText = (promptRes.messages[0].content as any).text;
        assert.ok(messageText.includes('30 days'), 'Must default to 30 days when omitted');
    });

    await test('Prompt Execution: hr_talent_shortlist targets hr_agent for candidate resumes and CV scoring', async () => {
        const promptRes = await client.getPrompt({
            name: 'hr_talent_shortlist',
            arguments: {
                role_title: 'Senior Backend Engineer',
                min_cv_score: '80',
            },
        });

        assert.ok(promptRes.description && promptRes.description.includes('hr_agent'));
        assert.ok(Array.isArray(promptRes.messages) && promptRes.messages.length >= 1);

        const messageText = (promptRes.messages[0].content as any).text;
        assert.ok(messageText.includes('hr_agent'), 'Instructions must explicitly target hr_agent');
        assert.ok(messageText.includes('Senior Backend Engineer'), 'Instructions must reference specified role');
        assert.ok(messageText.includes('80/100'), 'Instructions must use specified min_cv_score');
        assert.ok(messageText.includes('CV Match Score'), 'Instructions must require CV match score calculation');
        assert.ok(messageText.includes('Shortlist for Interview'), 'Instructions must specify shortlisting actions');
    });

    await test('Prompt Execution: hr_talent_shortlist applies default 75 threshold when min_cv_score is omitted', async () => {
        const promptRes = await client.getPrompt({
            name: 'hr_talent_shortlist',
            arguments: {
                role_title: 'Lead Architect',
            },
        });

        const messageText = (promptRes.messages[0].content as any).text;
        assert.ok(messageText.includes('75/100'), 'Must default to 75 threshold matching workflow engine');
    });

    await test('Prompt Validation: hr_talent_shortlist rejects call missing required role_title argument', async () => {
        await assert.rejects(
            async () => {
                await client.getPrompt({
                    name: 'hr_talent_shortlist',
                    arguments: {},
                });
            },
            /role_title/,
            'Calling hr_talent_shortlist without role_title must fail argument validation'
        );
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
        console.log('\nAll Milestone 3 MCP Resources & Prompts tests verified successfully.');
    }
}

run().catch((err) => {
    console.error('Fatal error running testMcpResourcesPrompts:', err);
    process.exit(1);
});
