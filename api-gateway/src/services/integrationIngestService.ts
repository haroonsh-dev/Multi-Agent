import axios from 'axios';
import crypto from 'crypto';
import dns from 'dns/promises';
import fs from 'fs';
import net from 'net';
import path from 'path';
import type { Request } from 'express';
import type { IIntegrationConnection } from '../models/IntegrationConnection';
import IntegrationConnection from '../models/IntegrationConnection';
import { INTEGRATION_PROVIDER_IDS } from '../constants/integrations';
import User from '../models/User';
import { PLAN_AGENT_IDS } from '../models/AgentStoragePricing';
import { getOrgEntitlement, getActiveSubscription, assertStorageAvailable } from './planService';
import { ensureUploadDir, saveUploadedFile } from './documentStorage';
import { recordActivity } from './activityLog';
import type { AuthUser } from './accessScope';
import { getExtension, isAllowedFile } from '../utils/fileValidation';

const INGEST_MAX_BYTES = Math.max(
    1_048_576,
    Number(process.env.INTEGRATION_INGEST_MAX_BYTES || 52_428_800)
);
const INGEST_FETCH_TIMEOUT_MS = Math.max(
    5_000,
    Number(process.env.INTEGRATION_INGEST_FETCH_TIMEOUT_MS || 60_000)
);
const INGEST_MAX_REDIRECTS = 3;

export type IngestUploadInput = {
    path: string;
    originalname: string;
    mimetype: string;
    size: number;
};

export type IntegrationIngestResult = {
    documentId: string;
    filename: string;
    status: string;
    providerId: string;
    aiModelResponse: unknown;
};

function isPrivateIp(ip: string): boolean {
    if (net.isIPv4(ip)) {
        const parts = ip.split('.').map(Number);
        if (parts[0] === 10) return true;
        if (parts[0] === 127) return true;
        if (parts[0] === 0) return true;
        if (parts[0] === 169 && parts[1] === 254) return true;
        if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;
        if (parts[0] === 192 && parts[1] === 168) return true;
        return false;
    }
    if (net.isIPv6(ip)) {
        const n = ip.toLowerCase();
        if (n === '::1' || n.startsWith('fe80:') || n.startsWith('fc') || n.startsWith('fd')) return true;
    }
    return false;
}

function hostnameBlocked(hostname: string): boolean {
    const h = hostname.toLowerCase().replace(/\.$/, '');
    if (!h) return true;
    if (h === 'localhost' || h.endsWith('.localhost')) return true;
    if (h.endsWith('.local') || h.endsWith('.internal')) return true;
    if (h === 'metadata.google.internal') return true;
    return false;
}

export async function assertIngestUrlSafe(rawUrl: string): Promise<URL> {
    let parsed: URL;
    try {
        parsed = new URL(rawUrl.trim());
    } catch {
        throw Object.assign(new Error('Invalid fileUrl'), { statusCode: 400 });
    }
    if (!['http:', 'https:'].includes(parsed.protocol)) {
        throw Object.assign(new Error('fileUrl must use http or https'), { statusCode: 400 });
    }
    if (process.env.NODE_ENV === 'production' && parsed.protocol !== 'https:') {
        throw Object.assign(new Error('fileUrl must use https in production'), { statusCode: 400 });
    }
    if (hostnameBlocked(parsed.hostname)) {
        throw Object.assign(new Error('fileUrl host is not allowed'), { statusCode: 400 });
    }
    if (net.isIP(parsed.hostname) && isPrivateIp(parsed.hostname)) {
        throw Object.assign(new Error('fileUrl resolves to a blocked network address'), { statusCode: 403 });
    }

    let addresses: string[] = [];
    try {
        const result = await dns.lookup(parsed.hostname, { all: true, verbatim: true });
        addresses = result.map((r) => r.address);
    } catch {
        try {
            const one = await dns.lookup(parsed.hostname);
            addresses = [one.address];
        } catch {
            throw Object.assign(new Error('Could not resolve fileUrl host'), { statusCode: 400 });
        }
    }
    if (!addresses.length || addresses.some(isPrivateIp)) {
        throw Object.assign(new Error('fileUrl resolves to a blocked network address'), { statusCode: 403 });
    }
    return parsed;
}

function filenameFromUrl(fileUrl: URL, fallback?: string): string {
    const base = path.basename(decodeURIComponent(fileUrl.pathname || '')).trim();
    if (base && base !== '/' && base !== '.') return base;
    if (fallback?.trim()) return fallback.trim();
    return `ingest_${Date.now()}.bin`;
}

function contentTypeToExt(mime: string): string {
    const m = (mime || '').toLowerCase();
    if (m.includes('pdf')) return '.pdf';
    if (m.includes('spreadsheet') || m.includes('excel')) return '.xlsx';
    if (m.includes('word')) return '.docx';
    if (m.includes('presentation') || m.includes('powerpoint')) return '.pptx';
    if (m.startsWith('image/png')) return '.png';
    if (m.startsWith('image/jpeg')) return '.jpg';
    if (m.includes('plain')) return '.txt';
    return '';
}

export async function fetchRemoteIngestFile(
    fileUrl: string,
    opts?: { filename?: string; tmpDir?: string }
): Promise<IngestUploadInput> {
    const parsed = await assertIngestUrlSafe(fileUrl);
    let originalname = filenameFromUrl(parsed, opts?.filename);
    let ext = getExtension(originalname);
    if (!ext) {
        ext = contentTypeToExt('');
        if (ext) originalname = `${originalname}${ext}`;
    }

    const tmpDir = opts?.tmpDir || path.join(process.cwd(), 'uploads', '_tmp');
    if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });
    const tmpPath = path.join(tmpDir, `ingest_${crypto.randomBytes(12).toString('hex')}`);

    let currentUrl = parsed.href;
    let redirectCount = 0;

    while (redirectCount <= INGEST_MAX_REDIRECTS) {
        const safeUrl = await assertIngestUrlSafe(currentUrl);
        const response = await axios.get<ArrayBuffer>(safeUrl.href, {
            responseType: 'arraybuffer',
            timeout: INGEST_FETCH_TIMEOUT_MS,
            maxRedirects: 0,
            validateStatus: (s) => s >= 200 && s < 400,
            maxContentLength: INGEST_MAX_BYTES + 1,
            maxBodyLength: INGEST_MAX_BYTES + 1,
        });

        if (response.status >= 300 && response.status < 400) {
            const loc = response.headers.location;
            if (!loc) {
                throw Object.assign(new Error('Remote file redirect missing Location header'), { statusCode: 502 });
            }
            redirectCount += 1;
            currentUrl = new URL(loc, safeUrl).href;
            continue;
        }

        const buffer = Buffer.from(response.data);
        if (buffer.length > INGEST_MAX_BYTES) {
            throw Object.assign(new Error(`Remote file exceeds ${INGEST_MAX_BYTES} bytes`), { statusCode: 413 });
        }
        if (!buffer.length) {
            throw Object.assign(new Error('Remote file is empty'), { statusCode: 400 });
        }

        const mimeType = String(response.headers['content-type'] || 'application/octet-stream')
            .split(';')[0]
            .trim();
        if (!getExtension(originalname)) {
            const guessed = contentTypeToExt(mimeType);
            if (guessed) originalname = `${originalname}${guessed}`;
        }

        const validation = isAllowedFile(originalname, mimeType);
        if (!validation.ok) {
            throw Object.assign(new Error(validation.reason || 'File type not allowed'), { statusCode: 415 });
        }

        fs.writeFileSync(tmpPath, buffer);
        return {
            path: tmpPath,
            originalname,
            mimetype: mimeType,
            size: buffer.length,
        };
    }

    throw Object.assign(new Error('Too many redirects fetching fileUrl'), { statusCode: 502 });
}

export async function resolveIngestConnection(apiKey: string): Promise<IIntegrationConnection | null> {
    const key = String(apiKey || '').trim();
    if (!key) return null;
    return IntegrationConnection.findOne({ ingestApiKey: key, isActive: true });
}

export function resolveIngestPhase3Agent(
    connection: IIntegrationConnection,
    override?: string | null,
    allowedAgentIds?: string[] | null
): string | undefined {
    const allowed = allowedAgentIds?.length ? new Set(allowedAgentIds) : null;
    const pick = (raw: string | undefined | null): string | undefined => {
        const v = String(raw || '').trim();
        if (!v) return undefined;
        if (!(PLAN_AGENT_IDS as readonly string[]).includes(v)) return undefined;
        if (allowed && !allowed.has(v)) return undefined;
        return v;
    };
    const overrideTrimmed = String(override ?? '').trim();
    if (overrideTrimmed) return pick(overrideTrimmed);
    return pick(String(connection.config?.phase3Agent || ''));
}

export async function assertIngestOrgAllowed(organizationId: string): Promise<void> {
    const sub = await getActiveSubscription(organizationId);
    if (!sub) {
        throw Object.assign(
            new Error('An active subscription plan is required for integration ingest'),
            { statusCode: 403, code: 'PLAN_REQUIRED' }
        );
    }
}

export async function resolveIngestEntitlementAgents(organizationId: string): Promise<string[]> {
    const entitlement = await getOrgEntitlement(organizationId);
    return entitlement.agentIds || [];
}

export async function resolveIngestAdminUser(connection: IIntegrationConnection) {
    return (
        (await User.findOne({
            organizationId: connection.organizationId,
            role: 'admin',
            status: 'active',
        }).lean()) ||
        (await User.findOne({ userId: connection.createdBy, status: 'active' }).lean())
    );
}

export async function ingestFileForConnection(opts: {
    connection: IIntegrationConnection;
    file: IngestUploadInput;
    phase3Agent?: string;
    ingestMode?: 'multipart' | 'file_url';
    externalRef?: Record<string, unknown>;
}): Promise<IntegrationIngestResult> {
    const { connection, file } = opts;
    await assertIngestOrgAllowed(connection.organizationId);
    const allowedAgents = await resolveIngestEntitlementAgents(connection.organizationId);

    const storageCheck = await assertStorageAvailable(connection.organizationId, file.size || 0);
    if (!storageCheck.ok) {
        throw Object.assign(new Error(storageCheck.message), { statusCode: 403, code: 'STORAGE_LIMIT' });
    }

    const adminUser = await resolveIngestAdminUser(connection);
    if (!adminUser) {
        throw Object.assign(new Error('No active admin user for organization'), { statusCode: 500 });
    }

    const authUser: AuthUser = {
        userId: adminUser.userId,
        role: adminUser.role,
        organizationId: connection.organizationId,
        permissions: undefined,
    };

    const phase3Agent = resolveIngestPhase3Agent(connection, opts.phase3Agent, allowedAgents);
    if (opts.phase3Agent && !phase3Agent) {
        throw Object.assign(
            new Error('phase3Agent is not enabled on this organization plan'),
            { statusCode: 403, code: 'AGENT_NOT_ALLOWED' }
        );
    }

    ensureUploadDir();
    const { doc, aiModelResponse } = await saveUploadedFile(authUser, file, phase3Agent);

    doc.metadata = {
        ...(doc.metadata || {}),
        source: connection.providerId,
        integrationConnectionId: connection.connectionId,
        integrationLabel: connection.label,
        ingestMode: opts.ingestMode || 'multipart',
        ...(opts.externalRef ? { integrationExternalRef: opts.externalRef } : {}),
    };
    await doc.save();

    connection.lastSyncAt = new Date();
    connection.lastStatus = opts.ingestMode === 'file_url' ? 'ingest_ok_url' : 'ingest_ok';
    await connection.save();

    recordActivity({
        organizationId: connection.organizationId,
        actorUserId: adminUser.userId,
        actorEmail: adminUser.email,
        actorRole: adminUser.role,
        action: 'integrations.ingest',
        category: 'document',
        resourceType: 'document',
        resourceId: doc.documentId,
        message: `Integration ingest (${connection.providerId}${opts.ingestMode === 'file_url' ? ', url' : ''}): ${doc.originalFilename}`,
        metadata: {
            providerId: connection.providerId,
            connectionId: connection.connectionId,
            filename: doc.originalFilename,
            ingestMode: opts.ingestMode || 'multipart',
        },
    });

    return {
        documentId: doc.documentId,
        filename: doc.originalFilename,
        status: doc.status,
        providerId: connection.providerId,
        aiModelResponse,
    };
}

export const MULTI_CONNECTION_PROVIDER_IDS = new Set<string>(INTEGRATION_PROVIDER_IDS);

export function buildConnectionPushUrl(base: string, connectionId: string, ingestKey?: string): string {
    const root = base.replace(/\/$/, '');
    const path = `${root}/api/docs/integrations/connections/${encodeURIComponent(connectionId)}/push`;
    if (!ingestKey) return path;
    return `${path}?key=${encodeURIComponent(ingestKey)}`;
}

export type IngestHttpResult = {
    documentId: string;
    filename: string;
    status: string;
    providerId: string;
    ingestMode: 'multipart' | 'file_url' | 'structured_record';
    recordType?: string;
    updated?: boolean;
    aiModelResponse?: unknown;
};

/** Shared multipart / JSON fileUrl / structured record ingest for public push endpoints. */
export async function processIngestHttpRequest(
    req: Request,
    connection: IIntegrationConnection
): Promise<IngestHttpResult> {
    const {
        ingestStructuredRecordForConnection,
        parseStructuredRecordFromBody,
    } = await import('./integrationRecordIngestService');

    const structuredInput = parseStructuredRecordFromBody(req.body);
    const fileUrl = String(req.body?.fileUrl || req.body?.file_url || req.body?.url || '').trim();
    const multipartFile = (req as Request & { file?: Express.Multer.File }).file;

    if (structuredInput && !multipartFile && !fileUrl) {
        const record = await ingestStructuredRecordForConnection({
            connection,
            input: structuredInput,
        });
        return {
            documentId: record.documentId,
            filename: record.title,
            status: record.status,
            providerId: record.providerId,
            ingestMode: 'structured_record',
            recordType: record.recordType,
            updated: record.updated,
        };
    }

    if (multipartFile && fileUrl) {
        throw Object.assign(new Error('Provide either multipart field "file" or JSON fileUrl — not both'), {
            statusCode: 400,
        });
    }

    if (!multipartFile && !fileUrl) {
        throw Object.assign(
            new Error(
                'Provide JSON with recordType + data (structured record), multipart field "file", or JSON body with "fileUrl"'
            ),
            { statusCode: 400 }
        );
    }

    const phase3AgentOverride =
        String(req.body?.phase3Agent || req.body?.phase3_agent || '').trim() || undefined;

    const externalRefRaw = req.body?.externalRef || req.body?.external_ref;
    const externalRef =
        externalRefRaw && typeof externalRefRaw === 'object' && !Array.isArray(externalRefRaw)
            ? (externalRefRaw as Record<string, unknown>)
            : undefined;

    let uploadInput: IngestUploadInput;
    let ingestMode: 'multipart' | 'file_url' = 'multipart';
    let tmpPath = '';

    try {
        if (multipartFile) {
            uploadInput = {
                path: multipartFile.path,
                originalname: multipartFile.originalname,
                mimetype: multipartFile.mimetype,
                size: multipartFile.size,
            };
        } else {
            ingestMode = 'file_url';
            const fetched = await fetchRemoteIngestFile(fileUrl, {
                filename: String(req.body?.filename || req.body?.originalFilename || '').trim() || undefined,
            });
            tmpPath = fetched.path;
            uploadInput = fetched;
        }

        const result = await ingestFileForConnection({
            connection,
            file: uploadInput,
            phase3Agent: phase3AgentOverride,
            ingestMode,
            externalRef,
        });

        return {
            documentId: result.documentId,
            filename: result.filename,
            status: result.status,
            providerId: result.providerId,
            ingestMode,
            aiModelResponse: result.aiModelResponse,
        };
    } finally {
        if (tmpPath && fs.existsSync(tmpPath)) {
            try {
                fs.unlinkSync(tmpPath);
            } catch {
                /* ignore */
            }
        }
    }
}
