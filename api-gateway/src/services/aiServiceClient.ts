import axios, { AxiosError } from 'axios';
import FormData from 'form-data';
import fs from 'fs';
import path from 'path';
import Document from '../models/Document';
import logger from '../utils/logger';

const rawBaseUrl = process.env.AI_SERVICE_URL || 'http://localhost:8001';
const BASE_URL = (rawBaseUrl.startsWith('http') ? rawBaseUrl : `http://${rawBaseUrl}`).replace(/\/$/, '');
const TIMEOUT = parseInt(process.env.AI_SERVICE_TIMEOUT_MS || '300000', 10);
const CHAT_TIMEOUT = parseInt(process.env.AI_CHAT_TIMEOUT_MS || '300000', 10);
/** Status polls / document GET — ai-backend can queue behind OCR/LLM; 8s was too aggressive */
const QUICK_FETCH_TIMEOUT = parseInt(process.env.AI_QUICK_FETCH_TIMEOUT_MS || '30000', 10);
const ENABLED = process.env.AI_SERVICE_ENABLED !== 'false';
/** Well-known dev-only value; rejected in production (see below). */
const DEV_INTERNAL_SERVICE_KEY = 'dev-internal-service-key';
/** Shared secret presented to the ai-backend so mutation endpoints trust the gateway. */
const INTERNAL_SERVICE_KEY =
    process.env.AI_INTERNAL_SERVICE_KEY || process.env.INTERNAL_SERVICE_KEY || DEV_INTERNAL_SERVICE_KEY;

if (
    (process.env.NODE_ENV === 'production' || process.env.NODE_ENV === 'prod') &&
    INTERNAL_SERVICE_KEY === DEV_INTERNAL_SERVICE_KEY
) {
    throw new Error(
        'AI_INTERNAL_SERVICE_KEY must be set to a non-default value in production. ' +
        'Refusing to start with the shared dev secret (it would let anyone impersonate the gateway).'
    );
}

export function isAiServiceEnabled(): boolean {
    return ENABLED;
}

function client() {
    return axios.create({
        baseURL: BASE_URL,
        timeout: TIMEOUT,
        validateStatus: () => true,
        headers: {
            'X-Internal-Service-Key': INTERNAL_SERVICE_KEY,
        },
    });
}

/** Preserve AI JSON body so callers can detect GROQ_RATE_LIMIT etc. */
export class AiHttpError extends Error {
    status: number;
    data: any;
    constructor(message: string, status: number, data: any) {
        super(message);
        this.name = 'AiHttpError';
        this.status = status;
        this.data = data;
    }
}

function throwIfAiFailed(res: { status: number; data: any }, label: string): void {
    if (res.status < 400) return;
    const detail =
        typeof res.data?.detail === 'string'
            ? res.data.detail
            : res.data?.message || JSON.stringify(res.data);
    throw new AiHttpError(`${label} (${res.status}): ${detail}`, res.status, res.data);
}

export function resolveAiOrganizationId(user: {
    organizationId?: string | null;
    userId: string;
}): string {
    return user.organizationId || `personal_${user.userId}`;
}

export function resolveDocumentAiOrgId(
    doc: { metadata?: Record<string, unknown> | null; organizationId?: string | null; uploadedBy?: string },
    user: { organizationId?: string | null; userId: string }
): string {
    const stored = doc.metadata?.aiOrgId;
    if (typeof stored === 'string' && stored.trim()) return stored;
    return resolveAiOrganizationId({
        organizationId: doc.organizationId || user.organizationId,
        userId: doc.uploadedBy || user.userId,
    });
}

export type AiUploadResult = {
    id: string;
    title: string;
    status: string;
    message: string;
};

export type ToolPolicyCheck = {
    decision: 'allow' | 'allow_with_audit' | 'approval_required';
    risk_tier?: string;
    reason?: string;
    known?: boolean;
};

export type AiAgentCatalog = {
    agent_ids: string[];
    agent_labels: Record<string, string>;
    doc_type_to_agent: Record<string, string>;
    tool_count: number;
};

export type AiAgentInfo = {
    id: string;
    label: string;
    description?: string;
    doc_types?: string[];
    prompt_path?: string;
    tools?: Array<{ name: string; description: string; risk_tier: string; action: string }>;
    capabilities?: string[];
};

export type AiToolAuditRow = {
    id?: string | number;
    tool_name: string;
    agent_id?: string;
    user_id?: string;
    risk_tier?: string;
    decision?: string;
    result_status?: string;
    result_summary?: string;
    duration_ms?: number;
    created_at?: string;
};

export type AiToolAuditResult = {
    total: number;
    rows: AiToolAuditRow[];
};

/**
 * Fetch the canonical agent catalog (agents + doc_type -> agent map) from the
 * ai-backend registry. Returns null when the service is disabled or unreachable
 * so callers can fall back to their bundled copy.
 *
 * Cached briefly: the catalog changes only when an agent / doc_type is added
 * upstream, but pricing + entitlement lookups call this on nearly every request.
 * A 60s TTL keeps those cheap while still propagating registry changes quickly.
 */
const CATALOG_TTL_MS = 60_000;
let catalogCache: { fetchedAt: number; value: AiAgentCatalog | null } | null = null;

export async function getAiAgentCatalog(force = false): Promise<AiAgentCatalog | null> {
    if (!ENABLED) return null;
    if (!force && catalogCache && Date.now() - catalogCache.fetchedAt < CATALOG_TTL_MS) {
        return catalogCache.value;
    }
    try {
        const res = await client().get('/api/v1/agents/catalog', { timeout: 15_000 });
        const value = res.status < 400 && res.data?.data ? (res.data.data as AiAgentCatalog) : null;
        catalogCache = { fetchedAt: Date.now(), value };
        return value;
    } catch (e: any) {
        // On failure keep serving the last-known catalog if it's still fresh-ish,
        // so a transient AI-backend blip doesn't break plan/pricing lookups.
        if (catalogCache && Date.now() - catalogCache.fetchedAt < CATALOG_TTL_MS * 6) {
            logger.warn(`AI agent catalog fetch failed (serving cached copy): ${e?.message || e}`);
            return catalogCache.value;
        }
        logger.warn(`AI agent catalog fetch failed: ${e?.message || e}`);
        return null;
    }
}

/** Ask the ai-backend policy gate whether a tool may run. Records an audit row. */
export async function checkToolPolicy(
    toolName: string,
    organizationId: string,
    permissions: string[],
    userId?: string
): Promise<ToolPolicyCheck | null> {
    if (!ENABLED) return null;
    try {
        const res = await client().post(
            `/api/v1/tools/${encodeURIComponent(toolName)}/check`,
            {
                organization_id: organizationId,
                permissions,
                user_id: userId || '',
            },
            { timeout: 15_000 }
        );
        if (res.status >= 400) {
            logger.warn(`AI tool policy check failed for ${toolName}: ${JSON.stringify(res.data)}`);
            return null;
        }
        return (res.data?.data || null) as ToolPolicyCheck | null;
    } catch (e: any) {
        logger.warn(`AI tool policy check error for ${toolName}: ${e?.message || e}`);
        return null;
    }
}

/** Capability marketplace: full agent catalog with tools + capabilities. */
export async function getAiAgents(): Promise<AiAgentInfo[] | null> {
    if (!ENABLED) return null;
    try {
        const res = await client().get('/api/v1/agents', { timeout: 15_000 });
        if (res.status >= 400) return null;
        const agents = res.data?.data?.agents;
        return Array.isArray(agents) ? (agents as AiAgentInfo[]) : null;
    } catch (e: any) {
        logger.warn(`AI agent marketplace fetch failed: ${e?.message || e}`);
        return null;
    }
}

/** Tools available to one agent (registry surface). */
export async function getAgentTools(
    agentId: string
): Promise<AiAgentInfo['tools'] | null> {
    if (!ENABLED || !agentId) return null;
    try {
        const res = await client().get(`/api/v1/agents/${encodeURIComponent(agentId)}/tools`, {
            timeout: 15_000,
        });
        if (res.status >= 400 || !res.data?.data) return null;
        const tools = res.data.data.tools;
        return Array.isArray(tools) ? (tools as AiAgentInfo['tools']) : null;
    } catch (e: any) {
        logger.warn(`AI agent tools fetch failed: ${e?.message || e}`);
        return null;
    }
}

/** Agent tool invocation audit trail for an org (newest first). */
export async function getToolAudit(params: {
    organizationId: string;
    limit?: number;
    toolName?: string;
}): Promise<AiToolAuditResult | null> {
    if (!ENABLED || !params.organizationId) return null;
    try {
        const res = await client().get('/api/v1/tools/audit', {
            params: {
                organization_id: params.organizationId,
                limit: params.limit || 50,
                ...(params.toolName ? { tool_name: params.toolName } : {}),
            },
            timeout: 15_000,
        });
        if (res.status >= 400 || !res.data?.data) return null;
        return res.data.data as AiToolAuditResult;
    } catch (e: any) {
        logger.warn(`AI tool audit fetch failed: ${e?.message || e}`);
        return null;
    }
}

export async function deleteDocumentFromAi(
    pythonDocumentId: string,
    organizationId: string
): Promise<boolean> {
    if (!ENABLED || !pythonDocumentId) return false;

    const res = await client().delete(`/api/v1/documents/${pythonDocumentId}`, {
        params: { organization_id: organizationId },
    });
    return res.status < 400;
}

export async function uploadDocumentToAi(params: {
    filePath: string;
    originalFilename: string;
    mimeType: string;
    organizationId: string;
    title?: string;
    phase3Agent?: string;
    uploadedBy?: string;
    allowedAgents?: string[];
}): Promise<AiUploadResult> {
    if (!ENABLED) {
        throw new Error('AI service is disabled');
    }

    const form = new FormData();
    form.append('organization_id', params.organizationId);
    form.append('title', params.title || params.originalFilename);
    const resolvedPath = path.resolve(params.filePath);
    form.append('local_file_path', resolvedPath);
    if (fs.existsSync(resolvedPath)) {
        form.append('file', fs.createReadStream(resolvedPath), {
            filename: params.originalFilename || path.basename(resolvedPath),
            contentType: params.mimeType || 'application/octet-stream',
        });
    }
    if (params.phase3Agent) form.append('phase3_agent', params.phase3Agent);
    if (params.uploadedBy) form.append('uploaded_by', params.uploadedBy);
    if (params.allowedAgents?.length) {
        form.append('allowed_agents', params.allowedAgents.join(','));
    }

    const res = await client().post('/api/v1/documents/upload', form, {
        headers: form.getHeaders(),
        maxBodyLength: Infinity,
        maxContentLength: Infinity,
    });

    throwIfAiFailed(res, 'AI upload failed');

    return res.data as AiUploadResult;
}

export type AiChatResult = {
    answer: string;
    sources: Array<Record<string, unknown>>;
    document_id: string;
    session_id?: string;
    provider?: string;
    model?: string;
    chart_data?: Record<string, unknown> | null;
};

export type AiProviderConfig = {
    provider: string;
    apiKey: string;
    model?: string;
    baseUrl?: string | null;
};

export async function syncProviderToAIBackend(config: AiProviderConfig): Promise<void> {
    if (!ENABLED) return;
    try {
        const res = await client().post('/api/v1/settings/providers', {
            provider: config.provider,
            apiKey: config.apiKey,
            model: config.model || '',
            baseUrl: config.baseUrl || '',
        });
        if (res.status >= 400) {
            logger.warn(`AI provider sync failed for ${config.provider}: ${JSON.stringify(res.data)}`);
        }
    } catch (err) {
        logger.warn(`AI provider sync failed for ${config.provider}: ${err}`);
    }
}

export async function setAiPrimaryProvider(config: AiProviderConfig): Promise<void> {
    if (!ENABLED) return;
    const res = await client().post('/api/v1/settings/providers/primary', {
        provider: config.provider,
        apiKey: config.apiKey,
        model: config.model || '',
        baseUrl: config.baseUrl || '',
    });
    if (res.status >= 400) {
        throw new Error(`Failed to select provider ${config.provider}: ${JSON.stringify(res.data)}`);
    }
}

export async function chatWithAi(params: {
    organizationId: string;
    question: string;
    documentIds?: string[];
    sessionId?: string;
    chatHistory?: Array<{ role: string; content: string }>;
    userId?: string;
    selectedText?: string;
    phase3Agent?: string;
    documentType?: string;
    allowedAgents?: string[];
    provider?: string;
    model?: string;
    providerConfig?: AiProviderConfig;
}): Promise<AiChatResult> {
    if (!ENABLED) {
        throw new Error('AI service is disabled');
    }

    const body: Record<string, unknown> = {
        organization_id: params.organizationId,
        question: params.question,
    };
    if (params.documentIds?.length) body.document_ids = params.documentIds;
    if (params.sessionId) body.session_id = params.sessionId;
    if (params.chatHistory?.length) body.chat_history = params.chatHistory;
    if (params.userId) body.user_id = params.userId;
    if (params.selectedText) body.selected_text = params.selectedText;
    if (params.phase3Agent) body.phase3_agent = params.phase3Agent;
    if (params.documentType) body.document_type = params.documentType;
    if (params.allowedAgents?.length) body.allowed_agents = params.allowedAgents;
    if (params.provider) body.provider = params.provider;
    if (params.model) body.model = params.model;
    if (params.providerConfig) {
        body.provider_config = {
            provider: params.providerConfig.provider,
            apiKey: params.providerConfig.apiKey,
            model: params.providerConfig.model || params.model || '',
            baseUrl: params.providerConfig.baseUrl || '',
        };
    }

    // Prefer /chat when docs selected; /chat/all for org-wide or agent-folder scope
    const path =
        params.documentIds?.length || params.phase3Agent || params.documentType
            ? '/api/v1/chat'
            : '/api/v1/chat/all';
    const res = await client().post(path, body, { timeout: CHAT_TIMEOUT });

    throwIfAiFailed(res, 'AI chat failed');

    return res.data as AiChatResult;
}

export async function appendChatExchange(params: {
    organizationId: string;
    question: string;
    answer: string;
    sessionId?: string;
    userId?: string;
    sources?: Array<Record<string, unknown>>;
}): Promise<{ session_id: string; answer: string }> {
    if (!ENABLED) {
        throw new Error('AI service is disabled');
    }

    const res = await client().post(
        '/api/v1/chat/append-exchange',
        {
            organization_id: params.organizationId,
            question: params.question,
            answer: params.answer,
            session_id: params.sessionId,
            user_id: params.userId,
            sources: params.sources || [],
        },
        { timeout: 15_000 }
    );
    throwIfAiFailed(res, 'Chat append failed');
    return res.data as { session_id: string; answer: string };
}

export type AiSearchResult = {
    results: Array<{
        document_id: string;
        document_title: string;
        document_type?: string;
        chunk_text: string;
        page_number?: number;
        score: number;
        metadata?: Record<string, unknown>;
    }>;
    total: number;
    query: string;
};

export async function searchWithAi(params: {
    organizationId: string;
    query: string;
    documentType?: string;
    phase3Agent?: string;
    status?: string;
    limit?: number;
    offset?: number;
}): Promise<AiSearchResult> {
    if (!ENABLED) {
        throw new Error('AI service is disabled');
    }

    const res = await client().post('/api/v1/search', {
        query: params.query,
        organization_id: params.organizationId,
        document_type: params.documentType || undefined,
        phase3_agent: params.phase3Agent || undefined,
        status: params.status || undefined,
        limit: params.limit ?? 20,
        offset: params.offset ?? 0,
    });

    if (res.status >= 400) {
        const detail = res.data?.detail || res.data?.message || JSON.stringify(res.data);
        throw new Error(`AI search failed (${res.status}): ${detail}`);
    }

    return res.data as AiSearchResult;
}

export type AiJobStatus = {
    document_id?: string;
    status?: string;
    stage?: string;
    progress?: number;
    error?: string;
    [key: string]: unknown;
};

export async function getDocumentJobStatus(
    pythonDocumentId: string,
    organizationId?: string
): Promise<AiJobStatus | null> {
    if (!ENABLED || !pythonDocumentId) return null;

    try {
        const params = organizationId ? { organization_id: organizationId } : {};
        const res = await client().get(`/api/v1/documents/${pythonDocumentId}/job`, {
            params,
            timeout: QUICK_FETCH_TIMEOUT,
            validateStatus: (s) => s < 500,
        });
        if (res.status >= 400) return null;
        return res.data as AiJobStatus;
    } catch (e: any) {
        logger.warn(`AI job status fetch failed: ${e.message}`);
        return null;
    }
}

export type AiDocumentDetails = Record<string, unknown>;

export async function getAiDocument(
    pythonDocumentId: string,
    organizationId: string
): Promise<AiDocumentDetails | null> {
    if (!ENABLED || !pythonDocumentId) return null;

    try {
        const res = await client().get(`/api/v1/documents/${pythonDocumentId}`, {
            params: organizationId ? { organization_id: organizationId } : {},
            timeout: QUICK_FETCH_TIMEOUT,
            validateStatus: (s) => s < 500,
        });
        if (res.status < 400) return res.data as AiDocumentDetails;

        // One fallback without org filter (handles org-id mismatch), then stop
        if (organizationId && res.status === 404) {
            const fallback = await client().get(`/api/v1/documents/${pythonDocumentId}`, {
                timeout: QUICK_FETCH_TIMEOUT,
                validateStatus: (s) => s < 500,
            });
            if (fallback.status < 400) return fallback.data as AiDocumentDetails;
        }
        return null;
    } catch (e: any) {
        logger.warn(`AI document fetch failed: ${e.message}`);
        return null;
    }
}

export async function updateAiDocumentSettings(params: {
    pythonDocumentId: string;
    organizationId: string;
    documentType: string;
    phase3Agent: string;
}): Promise<Record<string, unknown> | null> {
    if (!ENABLED || !params.pythonDocumentId) return null;

    const res = await client().patch(`/api/v1/documents/${params.pythonDocumentId}`, {
        document_type: params.documentType,
        phase3_agent: params.phase3Agent,
        organization_id: params.organizationId,
    });
    if (res.status >= 400) {
        const detail = res.data?.detail || res.data?.message || JSON.stringify(res.data);
        throw new Error(`AI document update failed (${res.status}): ${detail}`);
    }
    return res.data as Record<string, unknown>;
}

/** Keep AI original_file_url in sync after gateway relocates the file on disk. */
export async function updateAiDocumentFilePath(params: {
    pythonDocumentId: string;
    organizationId: string;
    filePath: string;
}): Promise<void> {
    if (!ENABLED || !params.pythonDocumentId || !params.filePath) return;

    const res = await client().patch(`/api/v1/documents/${params.pythonDocumentId}`, {
        organization_id: params.organizationId,
        original_file_url: path.resolve(params.filePath),
    });
    if (res.status >= 400) {
        const detail = res.data?.detail || res.data?.message || JSON.stringify(res.data);
        throw new Error(`AI file path update failed (${res.status}): ${detail}`);
    }
}

export type AiDocumentImages = {
    images: Array<{ page?: number; image_path?: string; description?: string }>;
    descriptions_file?: string;
};

export async function getAiDocumentImages(
    pythonDocumentId: string,
    organizationId: string
): Promise<AiDocumentImages | null> {
    if (!ENABLED || !pythonDocumentId) return null;

    const res = await client().get(`/api/v1/documents/${pythonDocumentId}/images`, {
        params: { organization_id: organizationId },
    });
    if (res.status >= 400) return null;
    return res.data as AiDocumentImages;
}

export type AiDocumentExtraction = {
    id?: number;
    organization_id?: string;
    document_id: string;
    extraction_type: string;
    extracted_data: Record<string, unknown>;
    confidence?: number;
    reviewed?: number;
    created_at?: string;
};

export async function getDocumentExtractions(
    pythonDocumentId: string,
    organizationId: string,
    extractionType?: string
): Promise<AiDocumentExtraction[]> {
    if (!ENABLED || !pythonDocumentId) return [];

    const params: Record<string, string> = { organization_id: organizationId };
    if (extractionType) params.extraction_type = extractionType;
    const res = await client().get(`/api/v1/documents/${pythonDocumentId}/extractions`, {
        params,
    });
    if (res.status >= 400) return [];
    const data = res.data;
    if (Array.isArray(data?.extractions)) return data.extractions as AiDocumentExtraction[];
    return [];
}

export type OfferLetterPrefill = {
    candidate_name?: string | null;
    job_title?: string | null;
    email?: string | null;
    phone?: string | null;
    location?: string | null;
    resume_summary?: string | null;
    source_fields_used?: string[];
};

export async function getOfferLetterPrefill(
    pythonDocumentId: string,
    organizationId: string
): Promise<{ prefill: OfferLetterPrefill; extraction_count: number } | null> {
    if (!ENABLED || !pythonDocumentId) return null;

    const res = await client().get(
        `/api/v1/hr/documents/${pythonDocumentId}/offer-letter/prefill`,
        { params: { organization_id: organizationId }, timeout: QUICK_FETCH_TIMEOUT }
    );
    if (res.status >= 400) return null;
    return res.data as { prefill: OfferLetterPrefill; extraction_count: number };
}

export async function generateOfferLetterDocx(params: {
    pythonDocumentId: string;
    organizationId: string;
    offer: Record<string, unknown>;
}): Promise<{
    filename: string;
    mime_type: string;
    pdf_base64?: string;
    docx_base64?: string;
    size_bytes: number;
}> {
    if (!ENABLED || !params.pythonDocumentId) {
        throw new Error('AI service is disabled');
    }

    const res = await client().post(
        `/api/v1/hr/documents/${params.pythonDocumentId}/offer-letter/generate`,
        {
            organization_id: params.organizationId,
            offer: params.offer,
        },
        { timeout: 60_000 }
    );
    if (res.status >= 400) {
        const detail = res.data?.detail || res.data?.message || JSON.stringify(res.data);
        throw new Error(typeof detail === 'string' ? detail : 'Offer letter generation failed');
    }
    return res.data as {
        filename: string;
        mime_type: string;
        pdf_base64?: string;
        docx_base64?: string;
        size_bytes: number;
    };
}

export type ExperienceLetterPrefill = OfferLetterPrefill & {
    duties_summary?: string | null;
};

export async function getExperienceLetterPrefill(
    pythonDocumentId: string,
    organizationId: string
): Promise<{ prefill: ExperienceLetterPrefill; extraction_count: number } | null> {
    if (!ENABLED || !pythonDocumentId) return null;

    const res = await client().get(
        `/api/v1/hr/documents/${pythonDocumentId}/experience-letter/prefill`,
        { params: { organization_id: organizationId }, timeout: QUICK_FETCH_TIMEOUT }
    );
    if (res.status >= 400) return null;
    return res.data as { prefill: ExperienceLetterPrefill; extraction_count: number };
}

export async function generateExperienceLetterPdf(params: {
    pythonDocumentId: string;
    organizationId: string;
    experience: Record<string, unknown>;
}): Promise<{
    filename: string;
    mime_type: string;
    pdf_base64?: string;
    size_bytes: number;
}> {
    if (!ENABLED || !params.pythonDocumentId) {
        throw new Error('AI service is disabled');
    }

    const res = await client().post(
        `/api/v1/hr/documents/${params.pythonDocumentId}/experience-letter/generate`,
        {
            organization_id: params.organizationId,
            experience: params.experience,
        },
        { timeout: 60_000 }
    );
    if (res.status >= 400) {
        const detail = res.data?.detail || res.data?.message || JSON.stringify(res.data);
        throw new Error(typeof detail === 'string' ? detail : 'Experience letter generation failed');
    }
    return res.data as {
        filename: string;
        mime_type: string;
        pdf_base64?: string;
        size_bytes: number;
    };
}

export async function generateExtractionReportHtml(
    organizationId: string,
    phase3Agent = ''
): Promise<{ subject: string; html: string }> {
    if (!ENABLED || !organizationId) {
        throw new Error('AI service is disabled');
    }

    const res = await client().post(
        '/api/v1/reports/generate',
        {
            organization_id: organizationId,
            phase3_agent: phase3Agent || '',
        },
        { timeout: 120_000 }
    );
    if (res.status >= 400) {
        const detail = res.data?.detail || res.data?.message || JSON.stringify(res.data);
        throw new Error(typeof detail === 'string' ? detail : 'Extraction report generation failed');
    }
    const subject = String(res.data?.subject || 'Visibility Docs extraction report');
    const html = String(res.data?.html || '');
    if (!html) {
        throw new Error('AI returned an empty report');
    }
    return { subject, html };
}

export async function generateComplianceReportPdf(params: {
    html: string;
    filename?: string;
}): Promise<{
    filename: string;
    mime_type: string;
    pdf_base64?: string;
    size_bytes: number;
}> {
    if (!ENABLED || !params.html) {
        throw new Error('AI service is disabled');
    }

    const res = await client().post(
        '/api/v1/reports/compliance/pdf',
        {
            html: params.html,
            filename: params.filename || 'Compliance_Report.pdf',
        },
        { timeout: 120_000 }
    );

    if (res.status >= 400) {
        const detail = res.data?.detail || res.data?.message || JSON.stringify(res.data);
        throw new Error(typeof detail === 'string' ? detail : 'Compliance report PDF generation failed');
    }

    return res.data as {
        filename: string;
        mime_type: string;
        pdf_base64?: string;
        size_bytes: number;
    };
}

export type AiSimilarDocument = {
    document_id: string;
    document_title?: string;
    document_type?: string;
    chunk_text?: string;
    page_number?: number;
    score: number;
    metadata?: Record<string, unknown>;
};

export async function getSimilarDocuments(
    pythonDocumentId: string,
    organizationId: string,
    limit = 5
): Promise<AiSimilarDocument[]> {
    if (!ENABLED || !pythonDocumentId) return [];

    const res = await client().get(`/api/v1/search/similar/${pythonDocumentId}`, {
        params: { organization_id: organizationId, limit },
    });
    if (res.status >= 400) return [];
    const data = res.data;
    if (Array.isArray(data?.results)) return data.results as AiSimilarDocument[];
    if (Array.isArray(data)) return data as AiSimilarDocument[];
    return [];
}

export async function triggerDocumentReprocess(
    pythonDocumentId: string,
    organizationId: string
): Promise<Record<string, unknown>> {
    if (!ENABLED || !pythonDocumentId) {
        throw new Error('AI service is disabled');
    }

    const res = await client().post(
        `/api/v1/documents/${pythonDocumentId}/reprocess`,
        {},
        { params: { organization_id: organizationId }, timeout: 30000 }
    );
    if (res.status >= 400) {
        const detail = res.data?.detail || res.data?.message || JSON.stringify(res.data);
        throw new Error(`AI reprocess failed (${res.status}): ${detail}`);
    }
    return res.data as Record<string, unknown>;
}

export async function runDocumentProcess(
    pythonDocumentId: string,
    organizationId: string,
    force = false
): Promise<Record<string, unknown> | null> {
    if (!ENABLED || !pythonDocumentId) return null;

    const res = await client().post(
        `/api/v1/documents/${pythonDocumentId}/process`,
        { organization_id: organizationId, force },
        { params: { organization_id: organizationId, force: force ? 'true' : 'false' } }
    );
    if (res.status >= 400) {
        const detail = res.data?.detail || res.data?.message || JSON.stringify(res.data);
        throw new Error(`AI process failed (${res.status}): ${detail}`);
    }
    return res.data as Record<string, unknown>;
}

export async function streamAiAsset(path: string): Promise<{ data: NodeJS.ReadableStream; contentType: string } | null> {
    if (!ENABLED || !path) return null;

    const res = await client().get(`/api/v1/documents/image/${path}`, {
        responseType: 'stream',
    });
    if (res.status >= 400) return null;
    const contentType = String(res.headers['content-type'] || 'application/octet-stream');
    return { data: res.data, contentType };
}

export async function listAiDocuments(
    organizationId: string,
    limit = 200
): Promise<Array<{ id: string; title?: string; status?: string; document_type?: string }>> {
    if (!ENABLED || !organizationId) return [];
    try {
        const res = await client().get('/api/v1/documents', {
            params: { organization_id: organizationId, limit },
            timeout: 30_000,
        });
        if (res.status >= 400) return [];
        const data = res.data;
        if (Array.isArray(data)) return data;
        if (Array.isArray(data?.documents)) return data.documents;
        if (Array.isArray(data?.data)) return data.data;
        return [];
    } catch (e: any) {
        logger.warn(`AI list documents failed: ${e.message}`);
        return [];
    }
}

function normalizeDocName(name: string): string {
    return String(name || '')
        .toLowerCase()
        .replace(/\(\d+\)/g, '')
        .replace(/[^a-z0-9]+/g, '');
}

/**
 * Make sure Mongo docs are reachable in the AI backend before chat.
 * - Re-upload from local disk when the python id is missing
 * - Otherwise rematch by filename to an existing AI document
 */
export async function ensureDocumentsInAi(
    docs: Array<{
        documentId: string;
        originalFilename?: string;
        mimeType?: string;
        storagePath?: string;
        pythonDocumentId?: string | null;
    }>,
    organizationId: string,
    uploadedBy?: string
): Promise<Map<string, string>> {
    const resolved = new Map<string, string>();
    if (!ENABLED || !docs.length) return resolved;

    let aiList: Array<{ id: string; title?: string }> | null = null;
    const getAiList = async () => {
        if (!aiList) aiList = await listAiDocuments(organizationId);
        return aiList;
    };

    for (const doc of docs) {
        const existingId = doc.pythonDocumentId || '';
        if (existingId) {
            const aiDoc = await getAiDocument(existingId, organizationId);
            if (aiDoc) {
                resolved.set(doc.documentId, existingId);
                continue;
            }
        }

        // Re-ingest if the file is available on this machine
        if (doc.storagePath && fs.existsSync(doc.storagePath)) {
            try {
                const uploaded = await uploadDocumentToAi({
                    filePath: doc.storagePath,
                    originalFilename: doc.originalFilename || path.basename(doc.storagePath),
                    mimeType: doc.mimeType || 'application/octet-stream',
                    organizationId,
                    title: doc.originalFilename,
                    uploadedBy,
                });
                if (uploaded?.id) {
                    await Document.updateOne(
                        { documentId: doc.documentId },
                        {
                            $set: {
                                pythonDocumentId: uploaded.id,
                                status: 'processing',
                                aiProcessingStatus: uploaded.status || 'processing',
                                'metadata.aiOrgId': organizationId,
                                'metadata.aiSynced': true,
                            },
                        }
                    );
                    resolved.set(doc.documentId, uploaded.id);
                    logger.info(
                        `Re-indexed ${doc.originalFilename} → AI id ${uploaded.id} (was missing from AI DB)`
                    );
                    continue;
                }
            } catch (e: any) {
                logger.warn(`Re-index failed for ${doc.documentId}: ${e?.message || e}`);
            }
        }

        // Fallback: match by filename against AI library already on this machine
        try {
            const list = await getAiList();
            const key = normalizeDocName(doc.originalFilename || '');
            const match = list.find((a) => {
                const t = normalizeDocName(a.title || '');
                return key && t && (key === t || key.includes(t) || t.includes(key));
            });
            if (match?.id) {
                await Document.updateOne(
                    { documentId: doc.documentId },
                    {
                        $set: {
                            pythonDocumentId: match.id,
                            'metadata.aiOrgId': organizationId,
                            'metadata.aiSynced': true,
                        },
                    }
                );
                resolved.set(doc.documentId, match.id);
                logger.info(
                    `Rematched ${doc.originalFilename} → existing AI id ${match.id}`
                );
            }
        } catch (e: any) {
            logger.warn(`AI rematch failed for ${doc.documentId}: ${e?.message || e}`);
        }
    }

    return resolved;
}

export async function listAiValidations(
    organizationId: string,
    documentId?: string
): Promise<unknown[]> {
    if (!ENABLED) return [];

    const params: Record<string, string | number> = { organization_id: organizationId, limit: 50 };
    if (documentId) params.document_id = documentId;

    const res = await client().get('/api/v1/documents/validations/list', { params });
    if (res.status >= 400) return [];
    const data = res.data;
    if (Array.isArray(data)) return data;
    if (Array.isArray(data?.validations)) return data.validations;
    if (Array.isArray(data?.validation_results)) return data.validation_results;
    if (Array.isArray(data?.results)) return data.results;
    return [];
}

export type ChatSessionSummary = {
    id: string;
    organization_id: string;
    user_id?: string | null;
    document_ids: string[];
    title: string;
    created_at?: string;
    updated_at?: string;
};

export type ChatSessionMessage = {
    id?: number;
    session_id?: string;
    role: string;
    content: string;
    sources?: Array<Record<string, unknown>>;
    created_at?: string;
};

export type ChatSessionDetails = ChatSessionSummary & {
    messages: ChatSessionMessage[];
};

export async function listChatSessions(
    organizationId: string,
    userId?: string
): Promise<ChatSessionSummary[]> {
    if (!ENABLED) return [];

    const params: Record<string, string> = { organization_id: organizationId };
    if (userId) params.user_id = userId;

    try {
        const res = await client().get('/api/v1/chat/sessions', { params });
        if (res.status >= 400) return [];
        return (res.data?.sessions || []) as ChatSessionSummary[];
    } catch {
        return []; // AI service down — treat as "no sessions" so the UI degrades cleanly
    }
}

export async function getChatSession(sessionId: string): Promise<ChatSessionDetails | null> {
    if (!ENABLED || !sessionId) return null;

    try {
        const res = await client().get(`/api/v1/chat/sessions/${sessionId}`);
        if (res.status >= 400) return null;
        return res.data as ChatSessionDetails;
    } catch {
        return null;
    }
}

export async function deleteChatSession(sessionId: string): Promise<boolean> {
    if (!ENABLED || !sessionId) return false;

    try {
        const res = await client().delete(`/api/v1/chat/sessions/${sessionId}`);
        return res.status < 400;
    } catch {
        return false;
    }
}

export async function renameChatSession(
    sessionId: string,
    title: string
): Promise<ChatSessionSummary | null> {
    if (!ENABLED || !sessionId) return null;
    const trimmed = title.trim();
    if (!trimmed) return null;

    try {
        const res = await client().post(`/api/v1/chat/sessions/${sessionId}/rename`, { title: trimmed });
        if (res.status >= 400) return null;
        return (res.data?.session || { id: sessionId, title: trimmed, document_ids: [] }) as ChatSessionSummary;
    } catch {
        return null;
    }
}

export async function checkAiHealth(): Promise<boolean> {
    if (!ENABLED) return false;
    try {
        const res = await client().get('/health');
        return res.status === 200;
    } catch {
        return false;
    }
}

export type GroqLimitStatus = {
    limited: boolean;
    configured?: boolean;
    until_ts?: number | null;
    retry_after_seconds?: number;
    message?: string | null;
    model?: string | null;
    console_url?: string;
    billing_url?: string;
    key_hint?: string | null;
};

export async function getGroqStatus(): Promise<GroqLimitStatus> {
    if (!ENABLED) {
        return { limited: false, configured: false, retry_after_seconds: 0 };
    }
    // Status must never hang behind the 120s AI default — the frontend polls this.
    try {
        const res = await client().get('/api/v1/groq/status', { timeout: 5_000 });
        if (res.status >= 400) {
            return { limited: false, configured: false, retry_after_seconds: 0 };
        }
        return res.data as GroqLimitStatus;
    } catch {
        // AI service down — treat as not limited so the UI doesn't spam the modal
        return { limited: false, configured: false, retry_after_seconds: 0 };
    }
}

export async function setGroqApiKey(apiKey: string): Promise<Record<string, unknown>> {
    if (!ENABLED) throw new Error('AI service is disabled');
    const res = await client().post('/api/v1/groq/api-key', { api_key: apiKey });
    if (res.status >= 400) {
        const detail = res.data?.detail || res.data?.message || JSON.stringify(res.data);
        throw new Error(typeof detail === 'string' ? detail : 'Failed to set Groq API key');
    }
    return res.data as Record<string, unknown>;
}

export type GroqLimitErrorInfo = {
    code: 'GROQ_RATE_LIMIT';
    message: string;
    retry_after_seconds?: number;
    until_ts?: number;
    console_url?: string;
    billing_url?: string;
};

export function extractGroqLimitError(error: unknown): GroqLimitErrorInfo | null {
    let data: any = null;
    if (error instanceof AiHttpError) {
        data = error.data;
    } else if (error instanceof AxiosError) {
        data = error.response?.data;
    } else if (typeof error === 'object' && error && (error as any).data) {
        data = (error as any).data;
    }

    const msgFallback = error instanceof Error ? error.message : String(error || '');

    if (!data) {
        if (/rate.?limit|429|tokens per day|tpd|GROQ_RATE_LIMIT/i.test(msgFallback)) {
            return {
                code: 'GROQ_RATE_LIMIT',
                message: msgFallback,
                console_url: 'https://console.groq.com/keys',
                billing_url: 'https://console.groq.com/settings/billing',
                retry_after_seconds: 24 * 3600,
            };
        }
        return null;
    }
    const code = data.code || data?.error?.code;
    const detail = typeof data.detail === 'string' ? data.detail : JSON.stringify(data.detail || '');
    const message = data.message || detail || msgFallback;
    if (
        code === 'GROQ_RATE_LIMIT' ||
        code === 'rate_limit_exceeded' ||
        /rate.?limit|tokens per day|tpd|GROQ_RATE_LIMIT/i.test(String(message)) ||
        /rate.?limit|tokens per day|GROQ_RATE_LIMIT/i.test(detail) ||
        /rate.?limit|tokens per day|GROQ_RATE_LIMIT/i.test(msgFallback)
    ) {
        return {
            code: 'GROQ_RATE_LIMIT',
            message: String(message || detail || 'Groq rate limit reached'),
            retry_after_seconds: Number(data.retry_after_seconds) || 24 * 3600,
            until_ts: data.until_ts ? Number(data.until_ts) : undefined,
            console_url: data.console_url || 'https://console.groq.com/keys',
            billing_url: data.billing_url || 'https://console.groq.com/settings/billing',
        };
    }
    return null;
}

export function formatAiError(error: unknown): string {
    if (error instanceof AxiosError) {
        if (error.code === 'ECONNABORTED' || error.message.includes('timeout')) {
            return `AI backend took too long (limit ${CHAT_TIMEOUT / 1000}s). Try a narrower document scope or increase AI_CHAT_TIMEOUT_MS.`;
        }
        if (error.code === 'ECONNRESET' || error.code === 'ECONNREFUSED') {
            return 'AI backend connection dropped. Ensure python run.py is running and stable.';
        }
        const d = error.response?.data;
        if (d?.message) return d.message;
        if (typeof d?.detail === 'string') return d.detail;
        return error.message;
    }
    if (error instanceof Error) return error.message;
    return 'AI service error';
}
