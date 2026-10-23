# Visibility Docs AI — Model Context Protocol (MCP) Server

Production-ready Model Context Protocol (MCP) server for Visibility Docs AI. Exposes the platform's domain AI agents, document intelligence, portfolio analytics, and autonomous approval workflows to external AI clients (Claude Desktop, Cursor, Antigravity, and cloud AI agents) via standard `stdio` and `SSE` transports.

---

## 1. Features & Primitives

### Tools (7 Domain Tools)
| Tool | Description |
|---|---|
| `ask_agent` | Ask questions to any of the 6 domain agents (`finance_agent`, `hr_agent`, `compliance_agent`, `procurement_agent`, `legal_agent`, `other_agent`). |
| `search_documents` | Search organization documents by keyword, classification, entity, and pagination. |
| `get_document_details` | Retrieve full document metadata, status, and OCR preview with automatic 4,000-char token protection. |
| `get_portfolio_readiness` | Retrieve fleet health scores, document counts, and chart readiness metrics. |
| `get_pending_approvals` | List pending high-value invoices, expiring certificates, and shortlisted candidates. |
| `execute_workflow_decision` | Trigger `approve`, `reject`, `reprocess`, or `flag` decisions with audit logging (`source = "mcp"`). |
| `get_workflow_overview` | Return aggregated organization KPIs and recent autonomous executions. |

### Resources (2 Standard URIs)
- `docs://documents/{documentId}`: Hydrated document payload with metadata, classification, entities, and OCR text preview.
- `docs://overview`: Live organization portfolio statistics and KPI metrics.

### Prompts (3 Preconfigured Templates)
- `financial_audit_review`: Guided cross-matching of invoices against purchase orders and budget limits.
- `compliance_expiry_audit`: Audit upcoming certificate expirations and open inspection findings.
- `hr_talent_shortlist`: Candidate resume screening against role requirements and score thresholds.

---

## 2. Client Setup Guides

### A. Claude Desktop
Add to your `claude_desktop_config.json`:
- **macOS**: `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Windows**: `%APPDATA%\Claude\claude_desktop_config.json`

```json
{
  "mcpServers": {
    "visibility-docs": {
      "command": "npx",
      "args": [
        "-y",
        "tsx",
        "/Users/haroonshahid/visbility-docs/api-gateway/src/mcp/stdio.ts"
      ],
      "env": {
        "VISIBILITY_API_TOKEN": "<YOUR_ORGANIZATION_API_TOKEN>"
      }
    }
  }
}
```

Or pass via command-line argument:
```json
{
  "mcpServers": {
    "visibility-docs": {
      "command": "npx",
      "args": [
        "-y",
        "tsx",
        "/Users/haroonshahid/visbility-docs/api-gateway/src/mcp/stdio.ts",
        "--token",
        "<YOUR_ORGANIZATION_API_TOKEN>"
      ]
    }
  }
}
```

### B. Cursor IDE
Create or edit `.cursor/mcp.json` in your workspace:

```json
{
  "mcpServers": {
    "visibility-docs": {
      "command": "npx",
      "args": [
        "tsx",
        "/Users/haroonshahid/visbility-docs/api-gateway/src/mcp/stdio.ts"
      ],
      "env": {
        "VISIBILITY_API_TOKEN": "<YOUR_ORGANIZATION_API_TOKEN>"
      }
    }
  }
}
```

### C. Remote SSE Transport (Server-Sent Events)
For cloud-based AI agents, the MCP server is mounted directly on the API Gateway:
- **SSE Stream Endpoint**: `GET https://your-gateway.com/api/mcp/sse`
- **Messages Endpoint**: `POST https://your-gateway.com/api/mcp/messages?sessionId=<SESSION_ID>`

#### Authentication Headers
Pass either:
- Header: `x-api-key: <YOUR_TOKEN>`
- Header: `Authorization: Bearer <YOUR_TOKEN>`
- Query Param: `?token=<YOUR_TOKEN>`

---

## 3. Multi-Tenant Security & Isolation
- The authenticated token resolves the caller's `organizationId`, `userId`, and `role`.
- Requests are executed within an `AsyncLocalStorage` tenant context (`src/mcp/context.ts`).
- Any client-provided `organizationId` parameter is strictly ignored, preventing cross-tenant data leaks.
- All decisions record `source: "mcp"` in the database activity log for enterprise auditability.

---

## 4. Verification & Testing

Run all MCP automated test suites:
```bash
# Core E2E Verification Suite (33 tests)
npx tsx src/scripts/testMcpServer.ts

# Domain Tools Suite (41 tests)
npx tsx src/scripts/testMcpTools.ts

# Resources & Prompts Suite (22 tests)
npx tsx src/scripts/testMcpResourcesPrompts.ts

# Transports Suite: Stdio stream isolation & SSE routing (21 tests)
npx tsx src/scripts/testMcpTransports.ts
```
