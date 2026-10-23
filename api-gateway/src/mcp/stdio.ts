/**
 * Visibility Docs AI — Model Context Protocol (MCP) Stdio Transport Entrypoint
 *
 * CRITICAL ARCHITECTURAL INVARIANT:
 * stdout MUST remain 100% pure JSON-RPC 2.0 frames.
 * Any non-JSON text output (diagnostics, info, startup messages, database warnings)
 * WILL corrupt client protocol framing in Claude Desktop, Cursor, and Antigravity.
 * Therefore, console.log/info/warn/debug are immediately redirected to console.error
 * before importing database configs or loggers.
 */

// ---------------------------------------------------------------------------
// 1. Immediate Logging Redirection (stdout -> stderr)
// ---------------------------------------------------------------------------
const originalConsoleError = console.error.bind(console);
console.log = (...args: any[]) => originalConsoleError(...args);
console.info = (...args: any[]) => originalConsoleError(...args);
console.warn = (...args: any[]) => originalConsoleError(...args);
console.debug = (...args: any[]) => originalConsoleError(...args);

// ---------------------------------------------------------------------------
// 2. Environment & Module Imports
// ---------------------------------------------------------------------------
import dotenv from 'dotenv';
dotenv.config();

import mongoose from 'mongoose';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createMcpServer } from './server';
import { resolveMcpTenant } from './auth';
import { mcpContextStorage, McpTenantContext } from './context';

// Ensure winston console transports also write to stderr rather than stdout
try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const loggerMod = require('../utils/logger');
    const logger = loggerMod?.default || loggerMod;
    if (logger && Array.isArray(logger.transports)) {
        for (const transport of logger.transports) {
            (transport as any).stderrLevels = ['error', 'warn', 'info', 'http', 'verbose', 'debug', 'silly'];
        }
    }
} catch {
    // Logger optional during standalone execution
}

// ---------------------------------------------------------------------------
// 3. Command-line & Token Parsing Helpers
// ---------------------------------------------------------------------------
export function extractTokenFromArgs(argv: string[] = process.argv.slice(2)): string | undefined {
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === '--token' && i + 1 < argv.length) {
            return argv[i + 1];
        }
        if (arg.startsWith('--token=')) {
            return arg.slice('--token='.length);
        }
        if (arg === '-t' && i + 1 < argv.length) {
            return argv[i + 1];
        }
    }
    return undefined;
}

// ---------------------------------------------------------------------------
// 4. Stdio Server Execution
// ---------------------------------------------------------------------------
export async function runStdioServer(overrideToken?: string): Promise<void> {
    const token = overrideToken || process.env.VISIBILITY_API_TOKEN || extractTokenFromArgs();

    if (!token) {
        console.error(
            '[MCP Stdio] Authentication failure: Missing API token.\n' +
            'Provide token via VISIBILITY_API_TOKEN environment variable or --token <token> command-line argument.'
        );
        process.exit(1);
    }

    // Optional database connection if MONGO_URI is set and mongoose is disconnected
    if (process.env.MONGO_URI && mongoose.connection.readyState === 0) {
        try {
            await mongoose.connect(process.env.MONGO_URI, {
                bufferCommands: false,
                serverSelectionTimeoutMS: 3000,
            });
            console.error('[MCP Stdio] Database connection established.');
        } catch (dbErr: any) {
            console.error(
                `[MCP Stdio] Database connection failed (${dbErr?.message || dbErr}). Proceeding in fallback mode.`
            );
        }
    }

    // Authenticate and resolve tenant context
    const context = await resolveMcpTenant(token);
    if (!context) {
        console.error(`[MCP Stdio] Authentication failure: Invalid or inactive API token "${token.slice(0, 8)}...".`);
        process.exit(1);
    }

    console.error(
        `[MCP Stdio] Authenticated tenant "${context.organizationId}" (${context.organizationName || 'N/A'}) [role: ${context.user.role}]`
    );

    const server = createMcpServer();
    const transport = new StdioServerTransport();

    // Wrap transport.onmessage to execute within AsyncLocalStorage tenant context
    let originalOnMessage = transport.onmessage;
    Object.defineProperty(transport, 'onmessage', {
        get() {
            return originalOnMessage;
        },
        set(newHandler) {
            originalOnMessage = (message: any, ...rest: any[]) => {
                return mcpContextStorage.run(context, () => {
                    return (newHandler as any)(message, ...rest);
                });
            };
        },
        configurable: true,
        enumerable: true,
    });

    // Connect server to transport inside tenant context
    await mcpContextStorage.run(context, async () => {
        await server.connect(transport);
        console.error('[MCP Stdio] Visibility Docs AI MCP Server initialized on stdio transport. Ready for JSON-RPC 2.0 messages.');
    });

    // Graceful shutdown handling
    const handleShutdown = async (signal: string) => {
        console.error(`[MCP Stdio] Received ${signal}, shutting down...`);
        try {
            await server.close();
            await transport.close();
        } catch (e: any) {
            console.error(`[MCP Stdio] Error during shutdown: ${e?.message || e}`);
        }
        process.exit(0);
    };

    process.on('SIGINT', () => handleShutdown('SIGINT'));
    process.on('SIGTERM', () => handleShutdown('SIGTERM'));
}

// CLI entrypoint execution
if (require.main === module) {
    runStdioServer().catch((err) => {
        console.error(`[MCP Stdio] Fatal server error: ${err?.message || err}`);
        process.exit(1);
    });
}
