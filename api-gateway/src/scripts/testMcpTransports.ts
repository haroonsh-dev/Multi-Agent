/**
 * Visibility Docs AI — Model Context Protocol (MCP) Transports Verification Suite
 *
 * Comprehensive automated test suite verifying Milestone 4:
 * 1. Stdio Server Transport:
 *    - Process-level child execution over stdin / stdout.
 *    - Strict stdout isolation (100% pure JSON-RPC frames, zero text contamination).
 *    - Diagnostics, startup logs, and database notices directed exclusively to stderr.
 *    - Protocol negotiation (initialize, tools/list, tools/call).
 *    - Authentication via CLI flag (--token) and environment variable (VISIBILITY_API_TOKEN).
 *    - Non-zero process exit on missing or invalid authentication credentials.
 * 2. SSE Server Transport:
 *    - GET /api/mcp/sse endpoint: Authentication via headers and query params.
 *    - Session handshake: Content-Type: text/event-stream, endpoint event with sessionId.
 *    - POST /api/mcp/messages endpoint: Session routing and JSON-RPC dispatch.
 *    - AsyncLocalStorage multi-tenant context enforcement.
 *    - Session lifecycle management and disconnect cleanup.
 * 3. App Mounting:
 *    - Verification of /api/mcp router mounted in the main Express app before 404 handler.
 *
 * Run:
 *   npx tsx src/scripts/testMcpTransports.ts
 */

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import express from 'express';
import {
    TOKEN_ALPHA,
    TOKEN_BETA,
    ORG_ALPHA,
    ORG_BETA,
    CANONICAL_TOOL_NAMES,
    fixtureStore,
} from './mcpE2eTestHarness';
import { mcpSseRouter, activeMcpSessions, cleanupSession } from '../mcp/sse';
import { extractTokenFromArgs } from '../mcp/stdio';
import app from '../app';

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

/**
 * Helper to run a stdio child process session with automated communication.
 */
function spawnStdioClient(options: {
    args?: string[];
    env?: Record<string, string>;
}): {
    child: ReturnType<typeof spawn>;
    getStdout: () => string;
    getStderr: () => string;
    getStdoutLines: () => string[];
    writeMessage: (msg: any) => Promise<void>;
    waitForMessage: (id: number | string, timeoutMs?: number) => Promise<any>;
    waitForExit: () => Promise<{ code: number | null; signal: string | null }>;
} {
    const defaultEnv = { ...process.env };
    delete defaultEnv.VISIBILITY_API_TOKEN; // Clean default unless specified

    const child = spawn(
        'npx',
        ['tsx', path.resolve(__dirname, '../mcp/stdio.ts'), ...(options.args || [])],
        {
            cwd: path.resolve(__dirname, '../..'),
            env: { ...defaultEnv, ...(options.env || {}) },
            stdio: ['pipe', 'pipe', 'pipe'],
        }
    );

    let stdoutData = '';
    let stderrData = '';
    const stdoutLines: string[] = [];
    const pendingResolvers = new Map<string | number, (data: any) => void>();

    let buffer = '';
    child.stdout.on('data', (chunk) => {
        const str = chunk.toString();
        stdoutData += str;
        buffer += str;
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';
        for (const line of lines) {
            if (!line.trim()) continue;
            stdoutLines.push(line.trim());
            try {
                const parsed = JSON.parse(line.trim());
                if (parsed.id !== undefined && pendingResolvers.has(parsed.id)) {
                    pendingResolvers.get(parsed.id)!(parsed);
                    pendingResolvers.delete(parsed.id);
                }
            } catch {
                // non-json line (if any)
            }
        }
    });

    child.stderr.on('data', (chunk) => {
        stderrData += chunk.toString();
    });

    const writeMessage = async (msg: any) => {
        child.stdin.write(JSON.stringify(msg) + '\n');
    };

    const waitForMessage = (id: number | string, timeoutMs = 15000): Promise<any> => {
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                pendingResolvers.delete(id);
                reject(new Error(`Timeout waiting for JSON-RPC response with id ${id}. Received stdout: ${stdoutData}, stderr: ${stderrData}`));
            }, timeoutMs);

            // Check if already received
            for (const line of stdoutLines) {
                try {
                    const parsed = JSON.parse(line);
                    if (parsed.id === id) {
                        clearTimeout(timer);
                        resolve(parsed);
                        return;
                    }
                } catch {
                    // ignore
                }
            }

            pendingResolvers.set(id, (data) => {
                clearTimeout(timer);
                resolve(data);
            });
        });
    };

    const waitForExit = (): Promise<{ code: number | null; signal: string | null }> => {
        return new Promise((resolve) => {
            child.on('exit', (code, signal) => {
                resolve({ code, signal });
            });
        });
    };

    return {
        child,
        getStdout: () => stdoutData,
        getStderr: () => stderrData,
        getStdoutLines: () => stdoutLines,
        writeMessage,
        waitForMessage,
        waitForExit,
    };
}

/**
 * In-memory sandbox-safe Express invocation helper.
 * Eliminates external TCP socket dependencies (avoiding connect EPERM in sandboxed environments).
 */
function invokeExpress(
    targetApp: express.Express | express.Router,
    options: {
        method: 'GET' | 'POST';
        path: string;
        headers?: Record<string, string>;
        body?: any;
        query?: Record<string, string>;
    }
): Promise<{ statusCode: number; headers: Record<string, string>; body: string; json?: any }> {
    return new Promise((resolve) => {
        let statusCode = 200;
        const responseHeaders: Record<string, string> = {};
        let responseBody = '';
        let jsonPayload: any = undefined;

        const urlParts = options.path.split('?');
        const queryParams = { ...(options.query || {}) };
        if (urlParts[1]) {
            const searchParams = new URLSearchParams(urlParts[1]);
            searchParams.forEach((v, k) => {
                queryParams[k] = v;
            });
        }

        const req: any = {
            method: options.method,
            url: options.path,
            path: urlParts[0],
            headers: Object.fromEntries(
                Object.entries(options.headers || {}).map(([k, v]) => [k.toLowerCase(), v])
            ),
            query: queryParams,
            body: options.body || {},
            params: {},
            get: (header: string) => req.headers[header.toLowerCase()],
            header: (header: string) => req.headers[header.toLowerCase()],
            socket: { remoteAddress: '127.0.0.1', encrypted: false },
            connection: { remoteAddress: '127.0.0.1', encrypted: false },
        };

        const res: any = {
            setHeader: (key: string, val: string) => {
                responseHeaders[key.toLowerCase()] = String(val);
                return res;
            },
            getHeader: (key: string) => responseHeaders[key.toLowerCase()],
            removeHeader: (key: string) => {
                delete responseHeaders[key.toLowerCase()];
                return res;
            },
            hasHeader: (key: string) => Boolean(responseHeaders[key.toLowerCase()]),
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
            (targetApp as any)(req, res, () => {
                resolve({ statusCode: 404, headers: responseHeaders, body: 'Not Found' });
            });
        }
    });
}

async function main() {
    console.log('=================================================================');
    console.log('  VISIBILITY DOCS AI — MCP DUAL TRANSPORTS VERIFICATION SUITE');
    console.log('=================================================================\n');

    fixtureStore.reset();

    // -------------------------------------------------------------------------
    // Part 1: Stdio Transport Process & Output Isolation
    // -------------------------------------------------------------------------
    console.log('--- Part 1: Stdio Transport Process & Output Isolation ---');

    await test('Stdio CLI: Unit helper extractTokenFromArgs parses flags', () => {
        assert.strictEqual(extractTokenFromArgs(['--token', 'abc123xyz']), 'abc123xyz');
        assert.strictEqual(extractTokenFromArgs(['--token=def456uvw']), 'def456uvw');
        assert.strictEqual(extractTokenFromArgs(['-t', 'ghi789rst']), 'ghi789rst');
        assert.strictEqual(extractTokenFromArgs(['--other-flag', 'value']), undefined);
    });

    await test('Stdio CLI: Spawns process and performs initialize handshake via stdout/stdin', async () => {
        const client = spawnStdioClient({
            args: ['--token', TOKEN_ALPHA.token],
        });

        try {
            const initMessage = {
                jsonrpc: '2.0',
                id: 1,
                method: 'initialize',
                params: {
                    protocolVersion: '2024-11-05',
                    capabilities: {},
                    clientInfo: { name: 'test-transport-client', version: '1.0.0' },
                },
            };

            await client.writeMessage(initMessage);
            const initRes = await client.waitForMessage(1);

            assert.strictEqual(initRes.jsonrpc, '2.0');
            assert.strictEqual(initRes.id, 1);
            assert.ok(initRes.result);
            assert.strictEqual(initRes.result.serverInfo.name, 'visibility-docs-ai-mcp');
            assert.strictEqual(initRes.result.serverInfo.version, '1.0.0');
            assert.ok(initRes.result.capabilities.tools);
        } finally {
            client.child.kill();
        }
    });

    await test('Stdio CLI: Output Isolation — stdout contains STRICTLY 100% valid JSON-RPC frames', async () => {
        const client = spawnStdioClient({
            args: ['--token', TOKEN_ALPHA.token],
        });

        try {
            await client.writeMessage({
                jsonrpc: '2.0',
                id: 10,
                method: 'initialize',
                params: {
                    protocolVersion: '2024-11-05',
                    capabilities: {},
                    clientInfo: { name: 'test-client', version: '1.0.0' },
                },
            });
            await client.waitForMessage(10);

            await client.writeMessage({
                jsonrpc: '2.0',
                id: 20,
                method: 'tools/list',
                params: {},
            });
            await client.waitForMessage(20);

            // Verify stdout lines
            const lines = client.getStdoutLines();
            assert.ok(lines.length >= 2, 'Must receive at least initialize and tools/list frames');

            for (const line of lines) {
                let parsed: any;
                try {
                    parsed = JSON.parse(line);
                } catch (err) {
                    assert.fail(`Stdout contaminated with non-JSON text: "${line}"`);
                }
                assert.strictEqual(parsed.jsonrpc, '2.0', `Line must have jsonrpc: "2.0": ${line}`);
                assert.ok(parsed.id !== undefined, `Line must have an id property: ${line}`);
            }
        } finally {
            client.child.kill();
        }
    });

    await test('Stdio CLI: Diagnostics, auth, and logs are directed strictly to stderr', async () => {
        const client = spawnStdioClient({
            args: ['--token', TOKEN_ALPHA.token],
        });

        try {
            await client.writeMessage({
                jsonrpc: '2.0',
                id: 30,
                method: 'initialize',
                params: {
                    protocolVersion: '2024-11-05',
                    capabilities: {},
                    clientInfo: { name: 'test-client', version: '1.0.0' },
                },
            });
            await client.waitForMessage(30);

            const stderr = client.getStderr();
            assert.ok(stderr.includes('[MCP Stdio] Authenticated tenant "org_alpha"'), 'Stderr must log authenticated tenant');
            assert.ok(stderr.includes('[MCP Stdio] Visibility Docs AI MCP Server initialized'), 'Stderr must log server ready notice');
        } finally {
            client.child.kill();
        }
    });

    await test('Stdio CLI: Executes tools/list and returns all 7 canonical domain tools', async () => {
        const client = spawnStdioClient({
            args: ['--token', TOKEN_ALPHA.token],
        });

        try {
            await client.writeMessage({
                jsonrpc: '2.0',
                id: 40,
                method: 'initialize',
                params: {
                    protocolVersion: '2024-11-05',
                    capabilities: {},
                    clientInfo: { name: 'test-client', version: '1.0.0' },
                },
            });
            await client.waitForMessage(40);

            await client.writeMessage({
                jsonrpc: '2.0',
                id: 41,
                method: 'tools/list',
                params: {},
            });
            const res = await client.waitForMessage(41);

            assert.strictEqual(res.id, 41);
            assert.ok(Array.isArray(res.result.tools));
            assert.strictEqual(res.result.tools.length, 7);

            const returnedToolNames = res.result.tools.map((t: any) => t.name);
            for (const canonical of CANONICAL_TOOL_NAMES) {
                assert.ok(returnedToolNames.includes(canonical), `Missing canonical tool ${canonical} over stdio`);
            }
        } finally {
            client.child.kill();
        }
    });

    await test('Stdio CLI: Executes tools/call ask_agent over stdio in tenant context', async () => {
        const client = spawnStdioClient({
            args: ['--token', TOKEN_ALPHA.token],
        });

        try {
            await client.writeMessage({
                jsonrpc: '2.0',
                id: 50,
                method: 'initialize',
                params: {
                    protocolVersion: '2024-11-05',
                    capabilities: {},
                    clientInfo: { name: 'test-client', version: '1.0.0' },
                },
            });
            await client.waitForMessage(50);

            await client.writeMessage({
                jsonrpc: '2.0',
                id: 51,
                method: 'tools/call',
                params: {
                    name: 'ask_agent',
                    arguments: {
                        agent_id: 'finance_agent',
                        message: 'Audit invoice details',
                    },
                },
            });
            const res = await client.waitForMessage(51);

            assert.strictEqual(res.id, 51);
            assert.ok(res.result);
            assert.strictEqual(res.result.agent_id, 'finance_agent');
            assert.strictEqual(res.result.organizationId, 'org_alpha');
            assert.ok(res.result.content[0].text.includes('finance_agent'));
        } finally {
            client.child.kill();
        }
    });

    await test('Stdio CLI: Authenticates via VISIBILITY_API_TOKEN environment variable', async () => {
        const client = spawnStdioClient({
            env: { VISIBILITY_API_TOKEN: TOKEN_BETA.token },
        });

        try {
            await client.writeMessage({
                jsonrpc: '2.0',
                id: 60,
                method: 'initialize',
                params: {
                    protocolVersion: '2024-11-05',
                    capabilities: {},
                    clientInfo: { name: 'test-client', version: '1.0.0' },
                },
            });
            const res = await client.waitForMessage(60);

            assert.strictEqual(res.id, 60);
            assert.ok(res.result);

            const stderr = client.getStderr();
            assert.ok(stderr.includes('[MCP Stdio] Authenticated tenant "org_beta"'), 'Stderr must confirm org_beta via env var');
        } finally {
            client.child.kill();
        }
    });

    await test('Stdio CLI: Missing token exits with non-zero exit code and stderr error', async () => {
        const client = spawnStdioClient({
            args: [], // No token arg, no env token
        });

        const exitResult = await client.waitForExit();
        assert.strictEqual(exitResult.code, 1, 'Missing token must exit with code 1');
        assert.strictEqual(client.getStdout().trim(), '', 'Stdout must be completely empty when auth fails');
        assert.ok(client.getStderr().includes('Authentication failure: Missing API token'));
    });

    await test('Stdio CLI: Invalid token exits with non-zero exit code and stderr error', async () => {
        const client = spawnStdioClient({
            args: ['--token', 'invalid_unrecognized_token_xyz_999'],
        });

        const exitResult = await client.waitForExit();
        assert.strictEqual(exitResult.code, 1, 'Invalid token must exit with code 1');
        assert.strictEqual(client.getStdout().trim(), '', 'Stdout must be completely empty on bad token');
        assert.ok(client.getStderr().includes('Authentication failure: Invalid or inactive API token'));
    });

    // -------------------------------------------------------------------------
    // Part 2: SSE Transport Endpoints & Multi-Tenancy
    // -------------------------------------------------------------------------
    console.log('\n--- Part 2: SSE Transport Endpoints & Multi-Tenancy ---');

    // Create an Express application mounting mcpSseRouter under /api/mcp
    const sseApp = express();
    sseApp.use(express.json());
    sseApp.use('/api/mcp', mcpSseRouter);

    await test('SSE Router: GET /api/mcp/sse without credentials returns 401 Unauthorized', async () => {
        const res = await invokeExpress(sseApp, {
            method: 'GET',
            path: '/api/mcp/sse',
        });
        assert.strictEqual(res.statusCode, 401);
        assert.ok(res.json?.error?.includes('Unauthorized'));
    });

    await test('SSE Router: GET /api/mcp/sse with invalid key returns 401 Unauthorized', async () => {
        const res = await invokeExpress(sseApp, {
            method: 'GET',
            path: '/api/mcp/sse',
            headers: {
                'x-api-key': 'non_existent_invalid_token',
            },
        });
        assert.strictEqual(res.statusCode, 401);
        assert.ok(res.json?.error?.includes('Unauthorized'));
    });

    let alphaSessionId = '';

    await test('SSE Router: GET /api/mcp/sse with x-api-key establishes stream and emits sessionId', async () => {
        const res = await invokeExpress(sseApp, {
            method: 'GET',
            path: '/api/mcp/sse',
            headers: {
                'x-api-key': TOKEN_ALPHA.token,
            },
        });

        assert.strictEqual(res.statusCode, 200);
        assert.ok(String(res.headers['content-type']).includes('text/event-stream'));
        assert.ok(res.body.includes('/api/mcp/messages?sessionId='));

        const match = res.body.match(/sessionId=([^&\s]+)/);
        assert.ok(match && match[1], 'Must parse sessionId from event stream payload');
        alphaSessionId = match[1];

        // Verify session is active in registry
        const session = activeMcpSessions.get(alphaSessionId);
        assert.ok(session, 'Session must be stored in activeMcpSessions registry');
        assert.strictEqual(session.context.organizationId, 'org_alpha');
    });

    await test('SSE Router: GET /api/mcp/sse with Authorization Bearer header establishes stream', async () => {
        const res = await invokeExpress(sseApp, {
            method: 'GET',
            path: '/api/mcp/sse',
            headers: {
                Authorization: `Bearer ${TOKEN_BETA.token}`,
            },
        });

        assert.strictEqual(res.statusCode, 200);
        assert.ok(String(res.headers['content-type']).includes('text/event-stream'));
        const match = res.body.match(/sessionId=([^&\s]+)/);
        assert.ok(match && match[1]);

        const session = activeMcpSessions.get(match[1]);
        assert.ok(session);
        assert.strictEqual(session.context.organizationId, 'org_beta');
        await cleanupSession(match[1]);
    });

    await test('SSE Router: GET /api/mcp/sse with query param ?token= establishes stream', async () => {
        const res = await invokeExpress(sseApp, {
            method: 'GET',
            path: `/api/mcp/sse?token=${TOKEN_ALPHA.token}`,
            query: { token: TOKEN_ALPHA.token },
        });

        assert.strictEqual(res.statusCode, 200);
        assert.ok(String(res.headers['content-type']).includes('text/event-stream'));
        const match = res.body.match(/sessionId=([^&\s]+)/);
        assert.ok(match && match[1]);
        await cleanupSession(match[1]);
    });

    await test('SSE Router: POST /api/mcp/messages without sessionId returns 400 Bad Request', async () => {
        const res = await invokeExpress(sseApp, {
            method: 'POST',
            path: '/api/mcp/messages',
            headers: { 'content-type': 'application/json' },
            body: { jsonrpc: '2.0', id: 1, method: 'tools/list' },
        });
        assert.strictEqual(res.statusCode, 400);
        assert.ok(res.json?.error?.includes('Session ID is required'));
    });

    await test('SSE Router: POST /api/mcp/messages with expired or unknown sessionId returns 400', async () => {
        const res = await invokeExpress(sseApp, {
            method: 'POST',
            path: '/api/mcp/messages?sessionId=non_existent_sess_123',
            query: { sessionId: 'non_existent_sess_123' },
            headers: { 'content-type': 'application/json' },
            body: { jsonrpc: '2.0', id: 2, method: 'tools/list' },
        });
        assert.strictEqual(res.statusCode, 400);
        assert.ok(res.json?.error?.includes('Session not found or expired'));
    });

    await test('SSE Router: POST /api/mcp/messages executes tools/list and returns all 7 tools', async () => {
        assert.ok(alphaSessionId, 'alphaSessionId must be active');
        const res = await invokeExpress(sseApp, {
            method: 'POST',
            path: `/api/mcp/messages?sessionId=${alphaSessionId}`,
            query: { sessionId: alphaSessionId },
            headers: { 'content-type': 'application/json' },
            body: {
                jsonrpc: '2.0',
                id: 201,
                method: 'tools/list',
                params: {},
            },
        });

        assert.strictEqual(res.statusCode, 200);
        assert.ok(res.json);
        assert.strictEqual(res.json.jsonrpc, '2.0');
        assert.strictEqual(res.json.id, 201);
        assert.ok(Array.isArray(res.json.result.tools));
        assert.strictEqual(res.json.result.tools.length, 7);
    });

    await test('SSE Router: POST /api/mcp/messages executes tools/call ask_agent in tenant context', async () => {
        const res = await invokeExpress(sseApp, {
            method: 'POST',
            path: `/api/mcp/messages?sessionId=${alphaSessionId}`,
            query: { sessionId: alphaSessionId },
            headers: { 'content-type': 'application/json' },
            body: {
                jsonrpc: '2.0',
                id: 202,
                method: 'tools/call',
                params: {
                    name: 'ask_agent',
                    arguments: {
                        agent_id: 'finance_agent',
                        message: 'Analyze quarterly expenses',
                    },
                },
            },
        });

        assert.strictEqual(res.statusCode, 200);
        assert.ok(res.json);
        assert.strictEqual(res.json.id, 202);
        assert.strictEqual(res.json.result.agent_id, 'finance_agent');
        assert.strictEqual(res.json.result.organizationId, 'org_alpha');
    });

    await test('SSE Router: Multi-tenant concurrency isolation between concurrent sessions', async () => {
        // Establish session for Beta
        const resBetaSse = await invokeExpress(sseApp, {
            method: 'GET',
            path: '/api/mcp/sse',
            headers: { 'x-api-key': TOKEN_BETA.token },
        });
        const matchBeta = resBetaSse.body.match(/sessionId=([^&\s]+)/);
        assert.ok(matchBeta && matchBeta[1]);
        const betaSessionId = matchBeta[1];

        // Execute concurrent requests to Alpha and Beta
        const [resAlpha, resBeta] = await Promise.all([
            invokeExpress(sseApp, {
                method: 'POST',
                path: `/api/mcp/messages?sessionId=${alphaSessionId}`,
                query: { sessionId: alphaSessionId },
                headers: { 'content-type': 'application/json' },
                body: {
                    jsonrpc: '2.0',
                    id: 301,
                    method: 'tools/call',
                    params: {
                        name: 'ask_agent',
                        arguments: { agent_id: 'compliance_agent', message: 'Check ISO certs' },
                    },
                },
            }),
            invokeExpress(sseApp, {
                method: 'POST',
                path: `/api/mcp/messages?sessionId=${betaSessionId}`,
                query: { sessionId: betaSessionId },
                headers: { 'content-type': 'application/json' },
                body: {
                    jsonrpc: '2.0',
                    id: 302,
                    method: 'tools/call',
                    params: {
                        name: 'ask_agent',
                        arguments: { agent_id: 'compliance_agent', message: 'Check ISO certs' },
                    },
                },
            }),
        ]);

        assert.strictEqual(resAlpha.json.result.organizationId, 'org_alpha');
        assert.strictEqual(resBeta.json.result.organizationId, 'org_beta');

        await cleanupSession(betaSessionId);
        await cleanupSession(alphaSessionId);
    });

    await test('SSE Router: Session cleanup helper closes transport and removes from registry', async () => {
        const fakeSessionId = 'temp_cleanup_test_sess';
        activeMcpSessions.set(fakeSessionId, {
            sessionId: fakeSessionId,
            transport: { close: async () => {} } as any,
            server: { close: async () => {} } as any,
            context: { organizationId: 'test', user: {} as any, source: 'mcp' },
            createdAt: new Date(),
            lastActiveAt: new Date(),
        });

        assert.ok(activeMcpSessions.has(fakeSessionId));
        await cleanupSession(fakeSessionId);
        assert.strictEqual(activeMcpSessions.has(fakeSessionId), false);
    });

    // -------------------------------------------------------------------------
    // Part 3: App Mount Integration
    // -------------------------------------------------------------------------
    console.log('\n--- Part 3: App Mount Integration ---');

    await test('App Integration: /api/mcp route responds from main Express app (before notFound)', async () => {
        // Unauthenticated GET to /api/mcp/sse on the real exported app should return 401 from mcpSseRouter, NOT 404 from notFound
        const res = await invokeExpress(app, {
            method: 'GET',
            path: '/api/mcp/sse',
        });
        assert.strictEqual(res.statusCode, 401, 'Mounted /api/mcp/sse must return 401 from router (not 404 from notFound)');
        assert.ok(res.json?.error?.includes('Unauthorized'));

        // Bad POST to /api/mcp/messages should return 400 from router
        const postRes = await invokeExpress(app, {
            method: 'POST',
            path: '/api/mcp/messages',
            headers: { 'content-type': 'application/json' },
            body: {},
        });
        assert.strictEqual(postRes.statusCode, 400, 'Mounted /api/mcp/messages must return 400 from router');
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
        console.log('\nAll MCP Transports tests executed and verified successfully.');
    }
}

main().catch((err) => {
    console.error('Fatal error running MCP Transports test suite:', err);
    process.exit(1);
});
