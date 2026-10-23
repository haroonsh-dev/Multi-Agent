/**
 * Unit & Integration Verification Suite for Milestone 1:
 * - AsyncLocalStorage Tenant Context (src/mcp/context.ts)
 * - Token & Organization Resolver (src/mcp/auth.ts)
 * 
 * Run:
 *   npx tsx src/scripts/testMcpAuthContext.ts
 */
import assert from 'assert/strict';
import {
    mcpContextStorage,
    getMcpContext,
    runWithMcpContext,
    McpTenantContext,
} from '../mcp/context';
import { resolveMcpTenant } from '../mcp/auth';

async function runTests() {
    console.log('====================================================');
    console.log('  MILESTONE 1 VERIFICATION: MCP CONTEXT & AUTH');
    console.log('====================================================\n');

    // -------------------------------------------------------------
    // Test 1: getMcpContext throws when called outside an active context
    // -------------------------------------------------------------
    assert.throws(
        () => getMcpContext(),
        /No active MCP tenant context found/,
        'Must throw descriptive error when called outside runWithMcpContext'
    );
    console.log('✓ Test 1: getMcpContext throws when called outside active context');

    // -------------------------------------------------------------
    // Test 2: runWithMcpContext propagates context synchronously and asynchronously
    // -------------------------------------------------------------
    const mockAlphaContext: McpTenantContext = {
        organizationId: 'org_alpha',
        organizationName: 'Alpha Logistics Inc',
        user: {
            userId: 'mcp-service-user',
            role: 'org_admin',
            organizationId: 'org_alpha',
            permissions: { 'document.view': true },
            primaryDepartmentId: null,
            orgRoleId: null,
        },
        source: 'mcp',
    };

    const syncResult = await runWithMcpContext(mockAlphaContext, () => {
        const ctx = getMcpContext();
        assert.strictEqual(ctx.organizationId, 'org_alpha');
        assert.strictEqual(ctx.organizationName, 'Alpha Logistics Inc');
        assert.strictEqual(ctx.source, 'mcp');
        assert.strictEqual(ctx.user.userId, 'mcp-service-user');
        assert.strictEqual(ctx.user.role, 'org_admin');
        return 'sync_ok';
    });
    assert.strictEqual(syncResult, 'sync_ok');
    console.log('✓ Test 2: runWithMcpContext propagates context synchronously');

    // -------------------------------------------------------------
    // Test 3: Context persistence across async promises & timers
    // -------------------------------------------------------------
    const asyncResult = await runWithMcpContext(mockAlphaContext, async () => {
        await new Promise((resolve) => setTimeout(resolve, 15));
        const ctx1 = getMcpContext();
        assert.strictEqual(ctx1.organizationId, 'org_alpha');

        await Promise.resolve();
        const ctx2 = getMcpContext();
        assert.strictEqual(ctx2.organizationId, 'org_alpha');

        return 42;
    });
    assert.strictEqual(asyncResult, 42);
    console.log('✓ Test 3: Context persists across asynchronous operations');

    // -------------------------------------------------------------
    // Test 4: Multi-tenant concurrent isolation (no cross-contamination)
    // -------------------------------------------------------------
    const mockBetaContext: McpTenantContext = {
        organizationId: 'org_beta',
        organizationName: 'Beta Manufacturing Ltd',
        user: {
            userId: 'mcp-service-user',
            role: 'org_admin',
            organizationId: 'org_beta',
            permissions: {},
            primaryDepartmentId: null,
            orgRoleId: null,
        },
        source: 'mcp',
    };

    const runAlpha = runWithMcpContext(mockAlphaContext, async () => {
        for (let i = 0; i < 5; i++) {
            await new Promise((resolve) => setTimeout(resolve, 5));
            assert.strictEqual(getMcpContext().organizationId, 'org_alpha');
        }
        return 'alpha_done';
    });

    const runBeta = runWithMcpContext(mockBetaContext, async () => {
        for (let i = 0; i < 5; i++) {
            await new Promise((resolve) => setTimeout(resolve, 5));
            assert.strictEqual(getMcpContext().organizationId, 'org_beta');
        }
        return 'beta_done';
    });

    const [alphaDone, betaDone] = await Promise.all([runAlpha, runBeta]);
    assert.strictEqual(alphaDone, 'alpha_done');
    assert.strictEqual(betaDone, 'beta_done');
    console.log('✓ Test 4: Concurrent contexts remain strictly isolated');

    // Context is cleared once exited
    assert.strictEqual(mcpContextStorage.getStore(), undefined);
    console.log('✓ Test 5: Context store clears after runWithMcpContext exits');

    // -------------------------------------------------------------
    // Test 6: resolveMcpTenant boundary conditions
    // -------------------------------------------------------------
    assert.strictEqual(await resolveMcpTenant(''), null, 'Empty string returns null');
    assert.strictEqual(await resolveMcpTenant('   '), null, 'Whitespace returns null');
    assert.strictEqual(await resolveMcpTenant(null as any), null, 'Null returns null');
    assert.strictEqual(await resolveMcpTenant(undefined as any), null, 'Undefined returns null');
    assert.strictEqual(await resolveMcpTenant('invalid_token_12345'), null, 'Unknown token returns null');
    console.log('✓ Test 6: resolveMcpTenant rejects empty, null, and unknown tokens');

    // -------------------------------------------------------------
    // Test 7: resolveMcpTenant resolves known valid token & bearer prefix
    // -------------------------------------------------------------
    const alphaToken = 'vdag_alpha_valid_token_0123456789abcdef0123456789abcdef';
    const resolvedAlpha = await resolveMcpTenant(alphaToken);
    assert.ok(resolvedAlpha, 'Valid Alpha token must resolve');
    assert.strictEqual(resolvedAlpha.organizationId, 'org_alpha');
    assert.strictEqual(resolvedAlpha.organizationName, 'Alpha Logistics Inc');
    assert.strictEqual(resolvedAlpha.source, 'mcp');
    assert.strictEqual(resolvedAlpha.user.userId, 'mcp-service-user');
    assert.strictEqual(resolvedAlpha.user.role, 'org_admin');
    assert.strictEqual(resolvedAlpha.user.organizationId, 'org_alpha');
    assert.strictEqual(typeof resolvedAlpha.user.permissions, 'object');

    // Bearer prefix handling
    const resolvedAlphaBearer = await resolveMcpTenant(`Bearer ${alphaToken}`);
    assert.ok(resolvedAlphaBearer, 'Bearer prefix token must resolve');
    assert.strictEqual(resolvedAlphaBearer.organizationId, 'org_alpha');
    console.log('✓ Test 7: resolveMcpTenant resolves token and strips Bearer prefix');

    // -------------------------------------------------------------
    // Test 8: resolveMcpTenant fallback by organizationId / organizationName
    // -------------------------------------------------------------
    const resolvedByOrgId = await resolveMcpTenant('org_beta');
    assert.ok(resolvedByOrgId, 'Fallback by organizationId must resolve');
    assert.strictEqual(resolvedByOrgId.organizationId, 'org_beta');
    assert.strictEqual(resolvedByOrgId.organizationName, 'Beta Manufacturing Ltd');
    assert.strictEqual(resolvedByOrgId.source, 'mcp');
    console.log('✓ Test 8: resolveMcpTenant fallback by organizationId succeeds');

    console.log('\n====================================================');
    console.log('  ALL MILESTONE 1 VERIFICATION CHECKS PASSED!');
    console.log('====================================================');
}

runTests().catch((err) => {
    console.error('Test failure:', err);
    process.exit(1);
});
