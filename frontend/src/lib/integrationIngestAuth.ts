/** Keep in sync with api-gateway/src/services/integrationIngestAuth.ts */

export type IngestAuthMode =
    | "integration_key"
    | "bearer_token"
    | "basic_auth"
    | "custom_header"
    | "query_key";

export const INGEST_AUTH_MODE_OPTIONS: Array<{ value: IngestAuthMode; label: string; hint: string }> = [
    {
        value: "integration_key",
        label: "API key header (default)",
        hint: "Send X-Integration-Key: your key — works with most middleware",
    },
    {
        value: "bearer_token",
        label: "Bearer token",
        hint: "Authorization: Bearer <token> — common for OAuth-style APIs",
    },
    {
        value: "basic_auth",
        label: "Basic auth",
        hint: "Authorization: Basic base64(username:password)",
    },
    {
        value: "custom_header",
        label: "Custom header",
        hint: "You choose the header name and secret (e.g. X-Api-Key, X-Secret-Token)",
    },
    {
        value: "query_key",
        label: "Query string only",
        hint: "Append ?key= to the URL — for systems that cannot set headers",
    },
];

export function ingestAuthModeLabel(mode?: string | null): string {
    return INGEST_AUTH_MODE_OPTIONS.find((o) => o.value === mode)?.label || "API key header (default)";
}

export function shouldShowIngestAuthField(fieldKey: string, mode: string, providerId: string): boolean {
    if (providerId !== "custom_webhook") return true;
    const m = (mode || "integration_key") as IngestAuthMode;
    if (fieldKey === "ingestAuthMode") return true;
    if (fieldKey === "ingestBearerToken") return m === "bearer_token";
    if (fieldKey === "ingestBasicUsername" || fieldKey === "ingestBasicPassword") return m === "basic_auth";
    if (fieldKey === "ingestCustomHeaderName" || fieldKey === "ingestCustomHeaderValue") {
        return m === "custom_header";
    }
    return ![
        "ingestBearerToken",
        "ingestBasicUsername",
        "ingestBasicPassword",
        "ingestCustomHeaderName",
        "ingestCustomHeaderValue",
    ].includes(fieldKey);
}

export function buildIngestCurlExamples(opts: {
    url: string;
    key: string;
    mode: IngestAuthMode | string;
    agent?: string;
    customHeaderName?: string;
    basicUsername?: string;
    basicPassword?: string;
    bearerToken?: string;
}): { multipart: string; json: string; note: string } {
    const agent = opts.agent || "finance_agent";
    const key = opts.key || "YOUR_INGEST_KEY";
    const mode = (opts.mode || "integration_key") as IngestAuthMode;

    let authHeader = `-H "X-Integration-Key: ${key}"`;
    let note = "Uses X-Integration-Key header (default Visibility ingest auth).";

    if (mode === "bearer_token") {
        const token = opts.bearerToken?.trim() || key;
        authHeader = `-H "Authorization: Bearer ${token}"`;
        note = "Uses Bearer token. Leave Bearer token blank in Edit to reuse the ingest API key as the token.";
    } else if (mode === "basic_auth") {
        const user = opts.basicUsername || "integration_user";
        const pass = opts.basicPassword || "YOUR_PASSWORD";
        authHeader = `-u "${user}:${pass}"`;
        note = "Uses HTTP Basic auth (username + password from Edit tab).";
    } else if (mode === "custom_header") {
        const name = opts.customHeaderName?.trim() || "X-Api-Key";
        authHeader = `-H "${name}: ${key}"`;
        note = `Uses custom header ${name}. Set name and secret in Edit tab.`;
    } else if (mode === "query_key") {
        authHeader = "";
        note = "Key must be in URL query only — append ?key= to the push URL.";
    }

    const urlWithKey =
        mode === "query_key" && !opts.url.includes("key=")
            ? `${opts.url}${opts.url.includes("?") ? "&" : "?"}key=${encodeURIComponent(key)}`
            : opts.url;

    const multipart = `curl -X POST "${urlWithKey}" \\\n  ${authHeader ? `${authHeader} \\\n  ` : ""}-F "file=@/path/to/document.pdf" \\\n  -F "phase3Agent=${agent}"`;

    const json = `curl -X POST "${urlWithKey}" \\\n  ${authHeader ? `${authHeader} \\\n  ` : ""}-H "Content-Type: application/json" \\\n  -d '{"fileUrl":"https://example.com/invoice.pdf","filename":"invoice.pdf","phase3Agent":"${agent}"}'`;

    return { multipart, json, note };
}
