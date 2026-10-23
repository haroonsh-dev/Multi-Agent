/**
 * Visibility Docs AI — Model Context Protocol (MCP) Server Factory
 *
 * Instantiates and configures an McpServer instance with:
 * - 7 Domain Agent, Document & Workflow Tools
 * - Document and live organization statistics Resources
 * - Pre-configured Domain Prompt Templates
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerMcpTools } from './tools';
import { registerMcpResources } from './resources';
import { registerMcpPrompts } from './prompts';

export interface McpServerMetadata {
    name: string;
    version: string;
}

export const MCP_SERVER_INFO: McpServerMetadata = {
    name: 'visibility-docs-ai-mcp',
    version: '1.0.0',
};

/**
 * Creates and initializes the canonical MCP Server for Visibility Docs AI.
 * Registers all domain tools, standard resources, and workflow prompts.
 */
export function createMcpServer(): McpServer {
    const server = new McpServer(
        MCP_SERVER_INFO,
        {
            capabilities: {
                tools: {
                    listChanged: true,
                },
                resources: {
                    subscribe: false,
                    listChanged: true,
                },
                prompts: {
                    listChanged: true,
                },
                logging: {},
            },
        }
    );

    // Register 7 canonical domain tools
    registerMcpTools(server);

    // Register standard resources: docs://documents/{documentId} and docs://overview
    registerMcpResources(server);

    // Register pre-configured prompts: financial_audit_review, compliance_expiry_audit, hr_talent_shortlist
    registerMcpPrompts(server);

    // Helper discovery method for tools inspection in test and diagnostic runners
    (server as any).listTools = async () => {
        const tools: Array<{ name: string; description?: string; inputSchema?: any }> = [];
        const registered = (server as any)._registeredTools;
        if (registered && typeof registered === 'object') {
            for (const [name, tool] of Object.entries(registered)) {
                tools.push({
                    name,
                    description: (tool as any)?.description,
                    inputSchema: (tool as any)?.inputSchema,
                });
            }
        }
        return { tools };
    };

    // Helper discovery method for resources inspection
    (server as any).listResources = async () => {
        const resources: Array<{ uri: string; name: string; description?: string; mimeType?: string }> = [];
        const registered = (server as any)._registeredResources;
        if (registered && typeof registered === 'object') {
            for (const [uri, res] of Object.entries(registered)) {
                resources.push({
                    uri,
                    name: (res as any)?.name || uri,
                    description: (res as any)?.description,
                    mimeType: (res as any)?.mimeType,
                });
            }
        }
        return { resources };
    };

    // Helper discovery method for prompts inspection
    (server as any).listPrompts = async () => {
        const prompts: Array<{ name: string; description?: string; arguments?: any }> = [];
        const registered = (server as any)._registeredPrompts;
        if (registered && typeof registered === 'object') {
            for (const [name, prompt] of Object.entries(registered)) {
                prompts.push({
                    name,
                    description: (prompt as any)?.description,
                    arguments: (prompt as any)?.arguments,
                });
            }
        }
        return { prompts };
    };

    return server;
}
