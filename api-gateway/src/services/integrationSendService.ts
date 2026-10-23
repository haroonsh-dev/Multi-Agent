import fs from 'fs';
import path from 'path';
import os from 'os';
import axios from 'axios';
import FormData from 'form-data';
import { v4 as uuidv4 } from 'uuid';
import Document from '../models/Document';
import { IIntegrationConnection } from '../models/IntegrationConnection';
import { getAiDocument, getDocumentExtractions } from './aiServiceClient';
import {
    normalizeFolderId,
    uploadFileToDrive,
} from './googleDriveService';
import logger from '../utils/logger';

/** Artifacts are uploaded into the connection's linked Drive folder (no subfolder created). */

export type SendInclude = {
    file?: boolean;
    summary?: boolean;
    extracted?: boolean;
};

export type SendDestinations = {
    folder?: boolean;
    webhook?: boolean;
};

export type SendArtifact = {
    kind: 'file' | 'summary' | 'extracted';
    filename: string;
    mimeType: string;
    buffer: Buffer;
};

function driveCreds(conn: IIntegrationConnection) {
    const cfg = conn.config || {};
    const sec = conn.secrets || {};
    return {
        serviceAccountEmail: String(cfg.serviceAccountEmail || ''),
        privateKey: String(sec.privateKey || ''),
        folderId: normalizeFolderId(String(cfg.folderId || '')),
    };
}

function buildSummaryText(doc: any, ai: Record<string, unknown> | null): string {
    const lines: string[] = [];
    lines.push(`Visibility Docs — AI Summary`);
    lines.push(`Document: ${doc.originalFilename || doc.documentId}`);
    lines.push(`Document ID: ${doc.documentId}`);
    lines.push(`Status: ${doc.status || '—'}`);
    lines.push(`Generated: ${new Date().toISOString()}`);
    lines.push('');

    const cv = (ai?.cv_extraction_data || {}) as Record<string, unknown>;
    if (cv.evaluation_summary) {
        lines.push('## Evaluation Summary');
        lines.push(String(cv.evaluation_summary));
        lines.push('');
    }
    if (cv.recommendation) {
        lines.push('## Recommendation');
        lines.push(String(cv.recommendation));
        lines.push('');
    }
    if (ai?.cv_score != null) {
        lines.push(`## CV Score: ${ai.cv_score}`);
        lines.push('');
    }

    const extracted = ai?.extracted_data;
    if (extracted && typeof extracted === 'object') {
        lines.push('## Extracted Data (summary)');
        try {
            lines.push(JSON.stringify(extracted, null, 2).slice(0, 8000));
        } catch {
            lines.push(String(extracted).slice(0, 4000));
        }
        lines.push('');
    }

    const raw = typeof ai?.raw_text === 'string' ? ai.raw_text.trim() : '';
    if (raw && lines.length < 12) {
        lines.push('## Document Text (excerpt)');
        lines.push(raw.slice(0, 4000));
        lines.push('');
    }

    if (lines.length <= 6) {
        lines.push('No AI summary available yet. Document may still be processing.');
    }

    return lines.join('\n');
}

function safeBaseName(filename: string): string {
    const base = path.basename(filename || 'document').replace(/[^\w.\-()+ ]+/g, '_');
    return base.replace(/\.[^.]+$/, '') || 'document';
}

export async function buildSendArtifacts(
    documentId: string,
    organizationId: string,
    include: SendInclude
): Promise<{ doc: any; artifacts: SendArtifact[]; warnings: string[] }> {
    const doc = await Document.findOne({ documentId, organizationId });
    if (!doc) {
        throw Object.assign(new Error(`Document not found: ${documentId}`), { statusCode: 404 });
    }

    let ai: Record<string, unknown> | null = null;
    let extractions: unknown[] = [];
    if (doc.pythonDocumentId) {
        try {
            ai = await getAiDocument(doc.pythonDocumentId, organizationId);
        } catch (e: any) {
            logger.warn(`[send] AI doc fetch failed for ${documentId}: ${e?.message || e}`);
        }
        try {
            extractions = (await getDocumentExtractions(doc.pythonDocumentId, organizationId)) || [];
        } catch {
            extractions = [];
        }
    }

    const artifacts: SendArtifact[] = [];
    const warnings: string[] = [];
    const stem = safeBaseName(doc.originalFilename);

    if (include.file) {
        if (!doc.storagePath || !fs.existsSync(doc.storagePath)) {
            const msg = `Original file missing on disk for ${documentId}`;
            if (!include.summary && !include.extracted) {
                throw Object.assign(new Error(msg), { statusCode: 400 });
            }
            warnings.push(msg);
        } else {
            artifacts.push({
                kind: 'file',
                filename: doc.originalFilename || `${stem}.bin`,
                mimeType: doc.mimeType || 'application/octet-stream',
                buffer: fs.readFileSync(doc.storagePath),
            });
        }
    }

    if (include.summary) {
        const text = buildSummaryText(doc, ai);
        artifacts.push({
            kind: 'summary',
            filename: `${stem}_summary.txt`,
            mimeType: 'text/plain; charset=utf-8',
            buffer: Buffer.from(text, 'utf8'),
        });
    }

    if (include.extracted) {
        const payload = {
            documentId: doc.documentId,
            filename: doc.originalFilename,
            status: doc.status,
            extracted_data: ai?.extracted_data ?? null,
            cv_extraction_data: ai?.cv_extraction_data ?? null,
            cv_score: ai?.cv_score ?? null,
            extractions,
            exportedAt: new Date().toISOString(),
        };
        artifacts.push({
            kind: 'extracted',
            filename: `${stem}_extracted.json`,
            mimeType: 'application/json',
            buffer: Buffer.from(JSON.stringify(payload, null, 2), 'utf8'),
        });
    }

    if (!artifacts.length) {
        throw Object.assign(
            new Error(warnings[0] || 'Select at least one of: file, summary, extracted'),
            { statusCode: 400 }
        );
    }

    return { doc, artifacts, warnings };
}

export async function resolveDriveUploadFolder(conn: IIntegrationConnection): Promise<string> {
    const creds = driveCreds(conn);
    if (!creds.folderId || !creds.privateKey) {
        throw Object.assign(
            new Error('Google Drive folder ID and private key are required for folder send'),
            { statusCode: 400 }
        );
    }
    // Upload into the linked folder only — do not create VisibilityDocs_Sent (needs Extra write rights / confuses sharing).
    return creds.folderId;
}

export async function uploadArtifactsToDrive(
    conn: IIntegrationConnection,
    artifacts: SendArtifact[]
): Promise<Array<{ kind: string; fileId: string; name: string; webViewLink?: string }>> {
    const creds = driveCreds(conn);
    const folderId = await resolveDriveUploadFolder(conn);
    const uploaded: Array<{ kind: string; fileId: string; name: string; webViewLink?: string }> = [];

    for (const a of artifacts) {
        const res = await uploadFileToDrive({
            serviceAccountEmail: creds.serviceAccountEmail,
            privateKey: creds.privateKey,
            parentFolderId: folderId,
            filename: a.filename,
            mimeType: a.mimeType,
            buffer: a.buffer,
        });
        uploaded.push({
            kind: a.kind,
            fileId: res.id,
            name: res.name,
            webViewLink: res.webViewLink,
        });
    }
    return uploaded;
}

export async function postArtifactsToWebhook(params: {
    url: string;
    meta: Record<string, unknown>;
    artifacts: SendArtifact[];
}): Promise<{ ok: boolean; status: number; bodyPreview?: string }> {
    const url = String(params.url || '').trim();
    if (!url) throw new Error('Outbound webhook URL is empty');

    const form = new FormData();
    form.append('meta', JSON.stringify(params.meta));
    form.append(
        'payload',
        JSON.stringify({
            ...params.meta,
            artifacts: params.artifacts.map((a) => ({
                kind: a.kind,
                filename: a.filename,
                mimeType: a.mimeType,
                size: a.buffer.length,
            })),
        })
    );

    for (const a of params.artifacts) {
        form.append('files', a.buffer, {
            filename: a.filename,
            contentType: a.mimeType,
        });
        form.append(`file_${a.kind}`, a.buffer, {
            filename: a.filename,
            contentType: a.mimeType,
        });
    }

    const res = await axios.post(url, form, {
        headers: form.getHeaders(),
        timeout: 60_000,
        maxBodyLength: 80 * 1024 * 1024,
        validateStatus: () => true,
    });

    const bodyPreview =
        typeof res.data === 'string'
            ? res.data.slice(0, 500)
            : JSON.stringify(res.data || {}).slice(0, 500);

    return {
        ok: res.status >= 200 && res.status < 300,
        status: res.status,
        bodyPreview,
    };
}

export async function sendDocumentsViaIntegration(params: {
    conn: IIntegrationConnection;
    organizationId: string;
    documentIds: string[];
    include: SendInclude;
    destinations: SendDestinations;
}): Promise<{
    results: Array<{
        documentId: string;
        filename?: string;
        uploaded?: Array<{ kind: string; fileId: string; name: string; webViewLink?: string }>;
        webhookOk?: boolean;
        webhookStatus?: number;
        errors: string[];
    }>;
    outboundFolderId?: string | null;
}> {
    const { conn, organizationId, documentIds, include, destinations } = params;
    const wantFolder = !!destinations.folder;
    const wantWebhook = !!destinations.webhook;
    if (!wantFolder && !wantWebhook) {
        throw Object.assign(new Error('Select at least one destination: folder or webhook'), {
            statusCode: 400,
        });
    }

    const webhookUrl = String(conn.config?.outboundWebhookUrl || '').trim();
    if (wantWebhook && !webhookUrl) {
        throw Object.assign(
            new Error('Outbound webhook URL is not set — open Edit and add Outbound results webhook URL'),
            { statusCode: 400 }
        );
    }
    if (wantFolder && conn.providerId !== 'google_drive') {
        throw Object.assign(
            new Error(
                'Folder send is currently available for Google Drive. Use webhook for other integrations.'
            ),
            { statusCode: 400 }
        );
    }

    let outboundFolderId: string | null = null;
    if (wantFolder) {
        outboundFolderId = await resolveDriveUploadFolder(conn);
    }

    const results = [];
    for (const documentId of documentIds) {
        const errors: string[] = [];
        let filename: string | undefined;
        let uploaded: Array<{ kind: string; fileId: string; name: string; webViewLink?: string }> | undefined;
        let webhookOk: boolean | undefined;
        let webhookStatus: number | undefined;

        try {
            const { doc, artifacts, warnings } = await buildSendArtifacts(
                documentId,
                organizationId,
                include
            );
            filename = doc.originalFilename;
            errors.push(...warnings);

            if (wantFolder) {
                try {
                    uploaded = await uploadArtifactsToDrive(conn, artifacts);
                } catch (e: any) {
                    errors.push(`folder: ${e?.message || e}`);
                }
            }

            if (wantWebhook) {
                try {
                    const wh = await postArtifactsToWebhook({
                        url: webhookUrl,
                        meta: {
                            connectionId: conn.connectionId,
                            providerId: conn.providerId,
                            label: conn.label,
                            documentId: doc.documentId,
                            filename: doc.originalFilename,
                            status: doc.status,
                            organizationId,
                            sentAt: new Date().toISOString(),
                            include,
                        },
                        artifacts,
                    });
                    webhookOk = wh.ok;
                    webhookStatus = wh.status;
                    if (!wh.ok) {
                        errors.push(`webhook: HTTP ${wh.status} ${wh.bodyPreview || ''}`.trim());
                    }
                } catch (e: any) {
                    webhookOk = false;
                    errors.push(`webhook: ${e?.message || e}`);
                }
            }
        } catch (e: any) {
            errors.push(e?.message || String(e));
        }

        results.push({
            documentId,
            filename,
            uploaded,
            webhookOk,
            webhookStatus,
            errors,
        });
    }

    return { results, outboundFolderId };
}

/** Upload an arbitrary file buffer to the connection's Drive folder and/or webhook (no library document). */
export async function sendRawFileViaIntegration(params: {
    conn: IIntegrationConnection;
    organizationId: string;
    filename: string;
    mimeType: string;
    buffer: Buffer;
    destinations?: SendDestinations;
}): Promise<{
    uploaded?: Array<{ kind: string; fileId: string; name: string; webViewLink?: string }>;
    webhookOk?: boolean;
    webhookStatus?: number;
    errors: string[];
    folderId?: string | null;
}> {
    const { conn, organizationId, filename, mimeType, buffer } = params;
    const wantFolder =
        params.destinations?.folder !== undefined
            ? !!params.destinations.folder
            : conn.providerId === 'google_drive';
    const webhookUrl = String(conn.config?.outboundWebhookUrl || '').trim();
    const wantWebhook =
        params.destinations?.webhook !== undefined
            ? !!params.destinations.webhook
            : Boolean(webhookUrl);

    const errors: string[] = [];
    if (!wantFolder && !wantWebhook) {
        throw Object.assign(
            new Error(
                'No destination available. Connect Google Drive for folder send, or set Outbound webhook URL.'
            ),
            { statusCode: 400 }
        );
    }
    if (wantFolder && conn.providerId !== 'google_drive') {
        throw Object.assign(
            new Error('Folder send is currently available for Google Drive only.'),
            { statusCode: 400 }
        );
    }
    if (wantWebhook && !webhookUrl) {
        throw Object.assign(
            new Error('Outbound webhook URL is not set on this connection.'),
            { statusCode: 400 }
        );
    }

    const artifacts: SendArtifact[] = [
        {
            kind: 'file',
            filename: filename || 'chat.txt',
            mimeType: mimeType || 'text/plain',
            buffer,
        },
    ];

    let uploaded:
        | Array<{ kind: string; fileId: string; name: string; webViewLink?: string }>
        | undefined;
    let webhookOk: boolean | undefined;
    let webhookStatus: number | undefined;
    let folderId: string | null = null;

    if (wantFolder) {
        try {
            folderId = await resolveDriveUploadFolder(conn);
            uploaded = await uploadArtifactsToDrive(conn, artifacts);
        } catch (e: any) {
            errors.push(`folder: ${e?.message || e}`);
        }
    }

    if (wantWebhook) {
        try {
            const wh = await postArtifactsToWebhook({
                url: webhookUrl,
                meta: {
                    connectionId: conn.connectionId,
                    providerId: conn.providerId,
                    label: conn.label,
                    organizationId,
                    filename,
                    source: 'chat',
                    sentAt: new Date().toISOString(),
                },
                artifacts,
            });
            webhookOk = wh.ok;
            webhookStatus = wh.status;
            if (!wh.ok) {
                errors.push(`webhook: HTTP ${wh.status} ${wh.bodyPreview || ''}`.trim());
            }
        } catch (e: any) {
            webhookOk = false;
            errors.push(`webhook: ${e?.message || e}`);
        }
    }

    return { uploaded, webhookOk, webhookStatus, errors, folderId };
}

/** Cleanup helper if callers write temp files later */
export function tmpPath(prefix = 'send'): string {
    return path.join(os.tmpdir(), `${prefix}_${uuidv4()}`);
}
