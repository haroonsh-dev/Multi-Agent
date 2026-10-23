import { AsyncLocalStorage } from 'async_hooks';
import type { AuthUser } from '../services/accessScope';

export interface McpTenantContext {
    organizationId: string;
    organizationName?: string;
    user: AuthUser;
    source: 'mcp';
}

export const mcpContextStorage = new AsyncLocalStorage<McpTenantContext>();

/**
 * Returns the currently active MCP tenant context from AsyncLocalStorage.
 * Throws an error if called outside an active MCP tenant context.
 */
export function getMcpContext(): McpTenantContext {
    const store = mcpContextStorage.getStore();
    if (!store) {
        throw new Error('No active MCP tenant context found in AsyncLocalStorage');
    }
    return store;
}

/**
 * Executes a function within the specified MCP tenant context.
 */
export async function runWithMcpContext<T>(
    context: McpTenantContext,
    fn: () => Promise<T> | T
): Promise<T> {
    return mcpContextStorage.run(context, async () => {
        return await fn();
    });
}
