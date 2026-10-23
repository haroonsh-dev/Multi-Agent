/**
 * Adversarial Stress Test Suite for Milestone 1:
 * - AsyncLocalStorage Edge Cases, Deep Nesting, Async Exceptions, & Concurrency Stress
 * - Token Authentication Attack Vectors, Disconnected DB & Error Handling
 * - Express CORS Preflight, Origin Isolation, & Header Verification (In-Memory HTTP Stream)
 * 
 * Run:
 *   npx tsx src/scripts/stressTestMcpM1.ts
 */
import assert from 'node:assert/strict';
import http from 'node:http';
import { Duplex } from 'node:stream';
import mongoose from 'mongoose';
import {
    mcpContextStorage,
    getMcpContext,
    runWithMcpContext,
    McpTenantContext,
} from '../mcp/context';
import { resolveMcpTenant } from '../mcp/auth';
import AgentApiToken from '../models/AgentApiToken';
import app from '../app';

// In-Memory Duplex Stream Pair for sandbox-safe HTTP testing without TCP socket syscalls
class DuplexPair {
    client: Duplex;
    server: Duplex;
    constructor() {
        const s1 = new Duplex({
            read() {},
            write(chunk, enc, cb) { s2.push(chunk); cb(); }
        });
        const s2 = new Duplex({
            read() {},
            write(chunk, enc, cb) { s1.push(chunk); cb(); }
        });
        this.client = s1;
        this.server = s2;
    }
}

interface SimulatedHttpResponse {
    statusCode: number;
    statusText: string;
    headers: Record<string, string>;
    body: string;
}

// Dispatches a simulated HTTP/1.1 request directly through Node's HTTP server & Express app
async function dispatchSimulatedHttp(
    method: string,
    path: string,
    headers: Record<string, string>,
    body?: string
): Promise<SimulatedHttpResponse> {
    const server = http.createServer(app);
    const pair = new DuplexPair();
    server.emit('connection', pair.server);

    return new Promise((resolve, reject) => {
        let rawResponse = '';
        const timeout = setTimeout(() => {
            reject(new Error('Simulated HTTP request timed out'));
        }, 5000);

        pair.client.on('data', (chunk) => {
            rawResponse += chunk.toString();
            // Check if response completed (header boundary reached for 204 or content body received)
            if (rawResponse.includes('\r\n\r\n')) {
                const [headerPart, ...bodyParts] = rawResponse.split('\r\n\r\n');
                const headerLines = headerPart.split('\r\n');
                const statusLine = headerLines[0];
                const [, statusCodeStr, ...statusTextParts] = statusLine.split(' ');
                const statusCode = parseInt(statusCodeStr, 10);
                const statusText = statusTextParts.join(' ');

                const parsedHeaders: Record<string, string> = {};
                for (let i = 1; i < headerLines.length; i++) {
                    const line = headerLines[i];
                    const colonIdx = line.indexOf(':');
                    if (colonIdx !== -1) {
                        const key = line.slice(0, colonIdx).trim().toLowerCase();
                        const val = line.slice(colonIdx + 1).trim();
                        parsedHeaders[key] = val;
                    }
                }

                const contentLength = parsedHeaders['content-length']
                    ? parseInt(parsedHeaders['content-length'], 10)
                    : null;
                const currentBody = bodyParts.join('\r\n\r\n');

                if (
                    statusCode === 204 ||
                    contentLength === 0 ||
                    (contentLength !== null && currentBody.length >= contentLength) ||
                    parsedHeaders['connection'] === 'close'
                ) {
                    clearTimeout(timeout);
                    resolve({
                        statusCode,
                        statusText,
                        headers: parsedHeaders,
                        body: currentBody,
                    });
                }
            }
        });

        let rawReq = `${method} ${path} HTTP/1.1\r\n`;
        rawReq += 'Host: localhost\r\n';
        rawReq += 'Connection: close\r\n';
        for (const [k, v] of Object.entries(headers)) {
            rawReq += `${k}: ${v}\r\n`;
        }
        if (body) {
            rawReq += `Content-Length: ${Buffer.byteLength(body)}\r\n`;
            rawReq += `\r\n${body}`;
        } else {
            rawReq += '\r\n';
        }

        pair.client.write(rawReq);
    });
}

// Helper to create mock tenant contexts
function createMockContext(orgId: string, orgName: string): McpTenantContext {
    return {
        organizationId: orgId,
        organizationName: orgName,
        user: {
            userId: `user-${orgId}`,
            role: 'org_admin',
            organizationId: orgId,
            permissions: { 'document.view': true, 'document.manage': true },
            primaryDepartmentId: null,
            orgRoleId: null,
        },
        source: 'mcp',
    };
}

async function runAdversarialTests() {
    console.log('================================================================');
    console.log('  CHALLENGER 2: ADVERSARIAL STRESS TEST SUITE (MILESTONE 1)     ');
    console.log('================================================================\n');

    let totalTests = 0;
    let passedTests = 0;

    function recordPass(testName: string) {
        totalTests++;
        passedTests++;
        console.log(`  ✓ [PASS] ${testName}`);
    }

    // =========================================================================
    // SECTION 1: mcpContextStorage & runWithMcpContext Edge Cases
    // =========================================================================
    console.log('--- SECTION 1: Context Isolation, Nested Calls & Async Exceptions ---');

    // 1.1: Uninitialized context access throws expected error
    assert.throws(
        () => getMcpContext(),
        /No active MCP tenant context found/,
        'Uninitialized context must throw descriptive Error'
    );
    assert.strictEqual(mcpContextStorage.getStore(), undefined);
    recordPass('1.1: Uninitialized getMcpContext throws and leaves store undefined');

    // 1.2: Synchronous exception handling inside runWithMcpContext
    let syncErrorCaught = false;
    try {
        await runWithMcpContext(createMockContext('org_err_sync', 'Sync Err Org'), () => {
            assert.strictEqual(getMcpContext().organizationId, 'org_err_sync');
            throw new Error('ADVERSARIAL_SYNC_EXCEPTION');
        });
    } catch (err: any) {
        syncErrorCaught = true;
        assert.strictEqual(err.message, 'ADVERSARIAL_SYNC_EXCEPTION');
    }
    assert.strictEqual(syncErrorCaught, true, 'Synchronous exception must be propagated');
    assert.strictEqual(mcpContextStorage.getStore(), undefined, 'Context must be cleared after sync throw');
    recordPass('1.2: Synchronous exception propagates cleanly and cleans context store');

    // 1.3: Asynchronous rejection handling inside runWithMcpContext
    let asyncErrorCaught = false;
    try {
        await runWithMcpContext(createMockContext('org_err_async', 'Async Err Org'), async () => {
            await new Promise((resolve) => setTimeout(resolve, 10));
            assert.strictEqual(getMcpContext().organizationId, 'org_err_async');
            throw new Error('ADVERSARIAL_ASYNC_REJECTION');
        });
    } catch (err: any) {
        asyncErrorCaught = true;
        assert.strictEqual(err.message, 'ADVERSARIAL_ASYNC_REJECTION');
    }
    assert.strictEqual(asyncErrorCaught, true, 'Asynchronous rejection must be propagated');
    assert.strictEqual(mcpContextStorage.getStore(), undefined, 'Context must be cleared after async rejection');
    recordPass('1.3: Asynchronous rejection propagates cleanly and cleans context store');

    // 1.4: Nested Context Isolation (Inner vs Outer)
    const ctxParent = createMockContext('org_parent', 'Parent Corp');
    const ctxChild = createMockContext('org_child', 'Child Subsidiary');

    await runWithMcpContext(ctxParent, async () => {
        assert.strictEqual(getMcpContext().organizationId, 'org_parent');

        // Enter nested child context
        const nestedResult = await runWithMcpContext(ctxChild, async () => {
            assert.strictEqual(getMcpContext().organizationId, 'org_child');
            await new Promise((resolve) => setTimeout(resolve, 10));
            assert.strictEqual(getMcpContext().organizationId, 'org_child');
            return 'child_complete';
        });

        assert.strictEqual(nestedResult, 'child_complete');
        // Outer context MUST be restored to org_parent
        assert.strictEqual(getMcpContext().organizationId, 'org_parent');
    });
    assert.strictEqual(mcpContextStorage.getStore(), undefined);
    recordPass('1.4: Nested contexts maintain strict scope and restore outer tenant');

    // 1.5: Nested Context Failure Recovery (Outer context survives inner failure)
    await runWithMcpContext(ctxParent, async () => {
        assert.strictEqual(getMcpContext().organizationId, 'org_parent');

        let innerCaught = false;
        try {
            await runWithMcpContext(ctxChild, async () => {
                assert.strictEqual(getMcpContext().organizationId, 'org_child');
                throw new Error('CHILD_COLLAPSE');
            });
        } catch (innerErr: any) {
            innerCaught = true;
            assert.strictEqual(innerErr.message, 'CHILD_COLLAPSE');
        }

        assert.strictEqual(innerCaught, true);
        // Outer parent context MUST remain intact despite inner failure!
        assert.strictEqual(getMcpContext().organizationId, 'org_parent');
        assert.strictEqual(getMcpContext().organizationName, 'Parent Corp');
    });
    recordPass('1.5: Parent context remains intact after nested child exception');

    // 1.6: Deep Nesting Call Stack Stress (15 nested levels)
    const MAX_DEPTH = 15;
    async function recurseContext(currentDepth: number): Promise<void> {
        if (currentDepth > MAX_DEPTH) return;
        const currentOrgId = `org_level_${currentDepth}`;
        const ctx = createMockContext(currentOrgId, `Level ${currentDepth}`);

        await runWithMcpContext(ctx, async () => {
            assert.strictEqual(getMcpContext().organizationId, currentOrgId);
            await recurseContext(currentDepth + 1);
            // Verify context restoration as call stack unwinds
            assert.strictEqual(getMcpContext().organizationId, currentOrgId);
        });
    }
    await recurseContext(1);
    assert.strictEqual(mcpContextStorage.getStore(), undefined);
    recordPass('1.6: Deep recursion (15 levels of nested contexts) unwinds flawlessly');

    // 1.7: Context persistence across process.nextTick and setImmediate
    await runWithMcpContext(ctxParent, async () => {
        let tickChecked = false;
        let immediateChecked = false;

        await new Promise<void>((resolve) => {
            process.nextTick(() => {
                assert.strictEqual(getMcpContext().organizationId, 'org_parent');
                tickChecked = true;
                resolve();
            });
        });

        await new Promise<void>((resolve) => {
            setImmediate(() => {
                assert.strictEqual(getMcpContext().organizationId, 'org_parent');
                immediateChecked = true;
                resolve();
            });
        });

        assert.ok(tickChecked && immediateChecked);
    });
    recordPass('1.7: Context persists across process.nextTick and setImmediate');

    // 1.8: Floating / Detached Background Promise
    let floatingFinished = false;
    await runWithMcpContext(ctxParent, async () => {
        // Spawn floating promise without awaiting it inside runWithMcpContext
        void (async () => {
            await new Promise((resolve) => setTimeout(resolve, 20));
            assert.strictEqual(getMcpContext().organizationId, 'org_parent');
            floatingFinished = true;
        })();
        return 'main_returned_early';
    });
    // Context is cleared in the caller's stack
    assert.strictEqual(mcpContextStorage.getStore(), undefined);
    // Wait for floating promise to complete
    await new Promise((resolve) => setTimeout(resolve, 35));
    assert.strictEqual(floatingFinished, true);
    recordPass('1.8: Detached asynchronous continuation preserves ambient tenant context');

    // 1.9: Concurrency Stress Test: 500 tasks across 10 distinct tenants
    const NUM_CONCURRENT_TASKS = 500;
    const NUM_TENANTS = 10;
    const tenantPool = Array.from({ length: NUM_TENANTS }, (_, i) =>
        createMockContext(`tenant_stress_${i}`, `Stress Corp ${i}`)
    );

    const stressTasks = Array.from({ length: NUM_CONCURRENT_TASKS }, async (_, taskId) => {
        const tenantIndex = taskId % NUM_TENANTS;
        const tenant = tenantPool[tenantIndex];
        const expectedId = tenant.organizationId;

        return runWithMcpContext(tenant, async () => {
            for (let step = 0; step < 5; step++) {
                // Random micro-delay to trigger unpredictable task interleaving
                const delayMs = Math.floor(Math.random() * 8) + 1;
                await new Promise((resolve) => setTimeout(resolve, delayMs));

                const currentCtx = getMcpContext();
                if (currentCtx.organizationId !== expectedId) {
                    throw new Error(
                        `LEAK DETECTED at task ${taskId}, step ${step}: expected ${expectedId} but got ${currentCtx.organizationId}`
                    );
                }
            }
            return expectedId;
        });
    });

    const stressResults = await Promise.all(stressTasks);
    assert.strictEqual(stressResults.length, NUM_CONCURRENT_TASKS);
    for (let i = 0; i < NUM_CONCURRENT_TASKS; i++) {
        assert.strictEqual(stressResults[i], `tenant_stress_${i % NUM_TENANTS}`);
    }
    assert.strictEqual(mcpContextStorage.getStore(), undefined);
    recordPass(`1.9: Concurrency Stress: 500 tasks / 2,500 async checkpoints with 0 leaks`);

    // =========================================================================
    // SECTION 2: resolveMcpTenant Robustness & Attack Vectors
    // =========================================================================
    console.log('\n--- SECTION 2: Token Resolution, Disconnected DB & Attack Vectors ---');

    // 2.1: Disconnected Database Mode handling
    assert.strictEqual(mongoose.connection.readyState, 0, 'MongoDB should not be connected');
    const validOffline = await resolveMcpTenant('vdag_alpha_valid_token_0123456789abcdef0123456789abcdef');
    assert.ok(validOffline);
    assert.strictEqual(validOffline.organizationId, 'org_alpha');
    recordPass('2.1: Disconnected DB does not hang/buffer and resolves test fixture');

    // 2.2: Bearer prefix variations (case-insensitive, whitespace)
    const bearerLower = await resolveMcpTenant('bearer vdag_alpha_valid_token_0123456789abcdef0123456789abcdef');
    const bearerUpper = await resolveMcpTenant('BEARER vdag_alpha_valid_token_0123456789abcdef0123456789abcdef');
    const bearerTabs = await resolveMcpTenant('Bearer \t  vdag_alpha_valid_token_0123456789abcdef0123456789abcdef  ');
    assert.ok(bearerLower && bearerLower.organizationId === 'org_alpha');
    assert.ok(bearerUpper && bearerUpper.organizationId === 'org_alpha');
    assert.ok(bearerTabs && bearerTabs.organizationId === 'org_alpha');
    recordPass('2.2: Case-insensitive Bearer prefix and irregular whitespace handled cleanly');

    // 2.3: Boundary & Malformed Inputs
    const invalidInputs: any[] = [
        '',
        '   ',
        '\t\n\r',
        'Bearer',
        'Bearer ',
        'Bearer    ',
        'Bearer Bearer token',
        null,
        undefined,
        123456,
        true,
        false,
        {},
        [],
        { token: 'valid' },
        Symbol('token'),
    ];

    for (const input of invalidInputs) {
        const res = await resolveMcpTenant(input);
        assert.strictEqual(res, null, `Input ${String(input)} must resolve to null`);
    }
    recordPass(`2.3: Rejection of 16 malformed, non-string, and boundary token types`);

    // 2.4: Injection Attack Vectors
    const injectionPayloads = [
        `' OR '1'='1`,
        `admin' --`,
        `{"$gt": ""}`,
        `{"$ne": null}`,
        `{"$where": "sleep(1000)"}`,
        `vdag_alpha_valid_token\0injected`,
        `../../../../etc/passwd`,
        `<script>alert(1)</script>`,
        `Bearer {"token": "vdag_alpha_valid_token_0123456789abcdef0123456789abcdef"}`,
    ];

    for (const payload of injectionPayloads) {
        const res = await resolveMcpTenant(payload);
        assert.strictEqual(res, null, `Injection payload "${payload}" must be rejected`);
    }
    recordPass('2.4: Rejection of SQL, NoSQL, null-byte, and script injection payloads');

    // 2.5: Huge String / ReDoS Attack Vector
    const HUGE_SIZE = 500_000;
    const hugeToken = 'Bearer ' + 'A'.repeat(HUGE_SIZE);
    const hugeStart = Date.now();
    const hugeResult = await resolveMcpTenant(hugeToken);
    const hugeElapsed = Date.now() - hugeStart;

    assert.strictEqual(hugeResult, null);
    assert.ok(
        hugeElapsed < 100,
        `Huge string processing took ${hugeElapsed}ms (must be under 100ms, no ReDoS)`
    );
    recordPass(`2.5: 500k char input processed in ${hugeElapsed}ms with 0 ReDoS vulnerability`);

    // 2.6: Simulated Database Error handling
    const originalFindOne = AgentApiToken.findOne;
    const originalReadyState = mongoose.connection.readyState;

    try {
        // Force readyState to 1 to simulate active connection
        Object.defineProperty(mongoose.connection, 'readyState', { value: 1, configurable: true });
        (AgentApiToken as any).findOne = () => {
            throw new Error('MongoNetworkError: connection 127.0.0.1:27017 closed unexpectedly');
        };

        // When DB query throws, resolveMcpTenant must NOT crash or rethrow
        const resAfterDbCrash = await resolveMcpTenant('unknown_crashing_token');
        assert.strictEqual(resAfterDbCrash, null, 'Must catch DB exception and return null');

        // It should still fall back gracefully to offline test fixtures
        const fixtureAfterDbCrash = await resolveMcpTenant('vdag_alpha_valid_token_0123456789abcdef0123456789abcdef');
        assert.ok(fixtureAfterDbCrash, 'Must fall back to test fixtures on DB error');
        assert.strictEqual(fixtureAfterDbCrash.organizationId, 'org_alpha');
    } finally {
        // Restore original method and state
        AgentApiToken.findOne = originalFindOne;
        Object.defineProperty(mongoose.connection, 'readyState', { value: originalReadyState, configurable: true });
    }
    recordPass('2.6: Simulated database network failure is caught gracefully without unhandled rejection');

    // 2.7: High Concurrency Token Resolution Stress (1,000 requests)
    const RESOLVE_ROUNDS = 1000;
    const candidateTokens = [
        'vdag_alpha_valid_token_0123456789abcdef0123456789abcdef',
        'Bearer vdag_beta_valid_token_9876543210fedcba9876543210fedcba',
        'invalid_token_xyz',
        '   ',
        'org_alpha',
        `{"$gt": ""}`,
        'Bearer non_existent',
    ];

    const resolveStart = Date.now();
    const resolvePromises = Array.from({ length: RESOLVE_ROUNDS }, (_, i) => {
        const token = candidateTokens[i % candidateTokens.length];
        return resolveMcpTenant(token);
    });
    const resolveResults = await Promise.all(resolvePromises);
    const resolveDuration = Date.now() - resolveStart;

    assert.strictEqual(resolveResults.length, RESOLVE_ROUNDS);
    for (let i = 0; i < RESOLVE_ROUNDS; i++) {
        const token = candidateTokens[i % candidateTokens.length];
        if (token.includes('alpha') || token === 'org_alpha') {
            assert.strictEqual(resolveResults[i]?.organizationId, 'org_alpha');
        } else if (token.includes('beta')) {
            assert.strictEqual(resolveResults[i]?.organizationId, 'org_beta');
        } else {
            assert.strictEqual(resolveResults[i], null);
        }
    }
    recordPass(`2.7: Concurrency Stress: 1,000 token resolutions executed in ${resolveDuration}ms (avg ${(resolveDuration / RESOLVE_ROUNDS).toFixed(2)}ms/req)`);

    // =========================================================================
    // SECTION 3: Express CORS Preflight & Header Verification
    // =========================================================================
    console.log('\n--- SECTION 3: CORS Headers & Preflight Verification (src/app.ts) ---');

    // 3.1: OPTIONS Preflight for 'x-api-key' from allowed origin http://localhost:3124
    const preflightRes = await dispatchSimulatedHttp('OPTIONS', '/api/health', {
        Origin: 'http://localhost:3124',
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'x-api-key',
    });

    assert.ok([200, 204].includes(preflightRes.statusCode), `Preflight must return 200 or 204, got ${preflightRes.statusCode}`);
    assert.strictEqual(
        preflightRes.headers['access-control-allow-origin'],
        'http://localhost:3124',
        'Allow-Origin must match request origin'
    );
    assert.strictEqual(
        preflightRes.headers['access-control-allow-credentials'],
        'true',
        'Allow-Credentials must be true'
    );
    const allowHeaders = (preflightRes.headers['access-control-allow-headers'] || '').toLowerCase();
    assert.ok(
        allowHeaders.includes('x-api-key'),
        `Allow-Headers (${allowHeaders}) must include x-api-key`
    );
    recordPass('3.1: Preflight OPTIONS for x-api-key succeeds with 204 and valid CORS headers');

    // 3.2: OPTIONS Preflight for 'X-Api-Key' (capitalized)
    const capPreflightRes = await dispatchSimulatedHttp('OPTIONS', '/api/health', {
        Origin: 'http://localhost:3124',
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'X-Api-Key',
    });
    assert.ok([200, 204].includes(capPreflightRes.statusCode));
    const capAllowHeaders = (capPreflightRes.headers['access-control-allow-headers'] || '').toLowerCase();
    assert.ok(capAllowHeaders.includes('x-api-key'));
    recordPass('3.2: Preflight OPTIONS for X-Api-Key (capitalized) succeeds');

    // 3.3: Preflight with multiple headers (Content-Type, Authorization, x-api-key)
    const multiHeaderRes = await dispatchSimulatedHttp('OPTIONS', '/api/health', {
        Origin: 'http://localhost:3124',
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'Content-Type, Authorization, x-api-key',
    });
    assert.ok([200, 204].includes(multiHeaderRes.statusCode));
    const multiAllowHeaders = (multiHeaderRes.headers['access-control-allow-headers'] || '').toLowerCase();
    assert.ok(multiAllowHeaders.includes('content-type'));
    assert.ok(multiAllowHeaders.includes('authorization'));
    assert.ok(multiAllowHeaders.includes('x-api-key'));
    recordPass('3.3: Preflight OPTIONS with compound headers permits all required fields');

    // 3.4: Secondary Allowed Origin http://127.0.0.1:3124
    const secOriginRes = await dispatchSimulatedHttp('OPTIONS', '/api/health', {
        Origin: 'http://127.0.0.1:3124',
        'Access-Control-Request-Method': 'GET',
        'Access-Control-Request-Headers': 'x-api-key',
    });
    assert.strictEqual(
        secOriginRes.headers['access-control-allow-origin'],
        'http://127.0.0.1:3124',
        'Must allow secondary dev origin 127.0.0.1:3124'
    );
    recordPass('3.4: Preflight from secondary dev origin http://127.0.0.1:3124 allowed');

    // 3.5: Unauthorized Origin Rejection
    const evilOriginRes = await dispatchSimulatedHttp('OPTIONS', '/api/health', {
        Origin: 'http://malicious-attacker-site.com',
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'x-api-key',
    });
    const evilAllowOrigin = evilOriginRes.headers['access-control-allow-origin'];
    assert.notStrictEqual(
        evilAllowOrigin,
        'http://malicious-attacker-site.com',
        'Unauthorized origin must NEVER be reflected in Access-Control-Allow-Origin'
    );
    recordPass('3.5: Unauthorized origin http://malicious-attacker-site.com is NOT allowed');

    // 3.6: Actual HTTP GET with x-api-key header
    const actualGetRes = await dispatchSimulatedHttp('GET', '/', {
        Origin: 'http://localhost:3124',
        'x-api-key': 'vdag_alpha_valid_token_0123456789abcdef0123456789abcdef',
    });
    assert.strictEqual(actualGetRes.statusCode, 200);
    assert.strictEqual(
        actualGetRes.headers['access-control-allow-origin'],
        'http://localhost:3124'
    );
    assert.strictEqual(
        actualGetRes.headers['access-control-allow-credentials'],
        'true'
    );
    assert.ok(actualGetRes.body.includes('Visibility Docs AI API'));
    recordPass('3.6: Live HTTP request with x-api-key header successfully processed with CORS response');

    console.log('\n================================================================');
    console.log(`  ALL ${passedTests}/${totalTests} ADVERSARIAL CHALLENGES PASSED EMPIRICALLY!`);
    console.log('================================================================');
}

runAdversarialTests().catch((err) => {
    console.error('\n❌ ADVERSARIAL CHALLENGE FAILURE:', err);
    process.exit(1);
});
