import crypto from 'crypto';
import type { Request } from 'express';
import type { IIntegrationConnection } from '../models/IntegrationConnection';
import IntegrationConnection from '../models/IntegrationConnection';
import { resolveIngestConnection } from './integrationIngestService';

export type IngestAuthMode =
    | 'integration_key'
    | 'bearer_token'
    | 'basic_auth'
    | 'custom_header'
    | 'query_key';

export function ingestAuthMode(connection: IIntegrationConnection): IngestAuthMode {
    const mode = String(connection.config?.ingestAuthMode || 'integration_key').toLowerCase();
    if (
        mode === 'bearer_token' ||
        mode === 'basic_auth' ||
        mode === 'custom_header' ||
        mode === 'query_key'
    ) {
        return mode;
    }
    return 'integration_key';
}

export function secureCredentialMatch(expected: string, provided: string): boolean {
    const a = Buffer.from(String(expected || ''), 'utf8');
    const b = Buffer.from(String(provided || ''), 'utf8');
    if (a.length !== b.length) {
        if (a.length) crypto.timingSafeEqual(a, a);
        return false;
    }
    return crypto.timingSafeEqual(a, b);
}

function headerValue(req: Request, name: string): string {
    const key = String(name || '').trim().toLowerCase();
    if (!key) return '';
    return String(req.headers[key] || '').trim();
}

export function validateIngestAuth(connection: IIntegrationConnection, req: Request): boolean {
    const mode = ingestAuthMode(connection);
    const secrets = connection.secrets || {};

    if (mode === 'bearer_token') {
        const auth = String(req.headers.authorization || '');
        const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
        const expected = String(secrets.ingestBearerToken || connection.ingestApiKey || '');
        return Boolean(token && expected && secureCredentialMatch(expected, token));
    }

    if (mode === 'basic_auth') {
        const auth = String(req.headers.authorization || '');
        if (!auth.startsWith('Basic ')) return false;
        let decoded = '';
        try {
            decoded = Buffer.from(auth.slice(6).trim(), 'base64').toString('utf8');
        } catch {
            return false;
        }
        const idx = decoded.indexOf(':');
        if (idx < 0) return false;
        const user = decoded.slice(0, idx);
        const pass = decoded.slice(idx + 1);
        const expectedUser = String(secrets.ingestBasicUsername || connection.config?.ingestBasicUsername || '');
        const expectedPass = String(secrets.ingestBasicPassword || '');
        return (
            Boolean(expectedUser && expectedPass) &&
            secureCredentialMatch(expectedUser, user) &&
            secureCredentialMatch(expectedPass, pass)
        );
    }

    if (mode === 'custom_header') {
        const headerName = String(connection.config?.ingestCustomHeaderName || 'X-Integration-Key').trim();
        const incoming = headerValue(req, headerName);
        const expected = String(secrets.ingestCustomHeaderValue || connection.ingestApiKey || '');
        return Boolean(incoming && expected && secureCredentialMatch(expected, incoming));
    }

    if (mode === 'query_key') {
        const key = String(req.query.key || req.body?.apiKey || '').trim();
        return Boolean(key && secureCredentialMatch(connection.ingestApiKey, key));
    }

    const key = String(
        req.headers['x-integration-key'] || req.query.key || req.body?.apiKey || ''
    ).trim();
    return Boolean(key && secureCredentialMatch(connection.ingestApiKey, key));
}

export async function resolveIngestConnectionFromRequest(
    req: Request
): Promise<IIntegrationConnection | null> {
    const headerKey = String(req.headers['x-integration-key'] || req.body?.apiKey || '').trim();
    const queryKey = String(req.query.key || '').trim();
    const key = headerKey || queryKey;
    if (key) {
        const byKey = await resolveIngestConnection(key);
        if (byKey && validateIngestAuth(byKey, req)) return byKey;
    }

    const auth = String(req.headers.authorization || '');
    if (auth.startsWith('Bearer ')) {
        const token = auth.slice(7).trim();
        if (token) {
            const byIngestKey = await IntegrationConnection.findOne({ ingestApiKey: token, isActive: true });
            if (byIngestKey && validateIngestAuth(byIngestKey, req)) return byIngestKey;
            const byBearer = await IntegrationConnection.findOne({
                'secrets.ingestBearerToken': token,
                isActive: true,
            });
            if (byBearer && validateIngestAuth(byBearer, req)) return byBearer;
        }
    }

    if (auth.startsWith('Basic ')) {
        let decoded = '';
        try {
            decoded = Buffer.from(auth.slice(6).trim(), 'base64').toString('utf8');
        } catch {
            return null;
        }
        const idx = decoded.indexOf(':');
        if (idx < 0) return null;
        const user = decoded.slice(0, idx);
        const candidates = await IntegrationConnection.find({
            isActive: true,
            $or: [
                { 'config.ingestBasicUsername': user },
                { 'secrets.ingestBasicUsername': user },
            ],
        }).limit(5);
        for (const conn of candidates) {
            if (validateIngestAuth(conn, req)) return conn;
        }
    }

    const customHeaderConnections = await IntegrationConnection.find({
        isActive: true,
        'config.ingestAuthMode': 'custom_header',
        'config.ingestCustomHeaderName': { $exists: true, $ne: '' },
    }).limit(20);

    for (const conn of customHeaderConnections) {
        if (validateIngestAuth(conn, req)) return conn;
    }

    return null;
}

export function ingestAuthModeLabel(mode?: string | null): string {
    switch (String(mode || 'integration_key').toLowerCase()) {
        case 'bearer_token':
            return 'Bearer token';
        case 'basic_auth':
            return 'Basic auth (username + password)';
        case 'custom_header':
            return 'Custom header';
        case 'query_key':
            return 'Query key (?key=)';
        default:
            return 'API key header (X-Integration-Key)';
    }
}
