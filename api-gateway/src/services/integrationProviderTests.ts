import axios from 'axios';
import type { IIntegrationConnection } from '../models/IntegrationConnection';

const TEST_TIMEOUT_MS = 15_000;

function cfg(conn: IIntegrationConnection, key: string): string {
    return String(conn.config?.[key] ?? '').trim();
}

function sec(conn: IIntegrationConnection, key: string): string {
    return String(conn.secrets?.[key] ?? '').trim();
}

function normalizeBaseUrl(raw: string): string {
    return raw.replace(/\/+$/, '');
}

/** SAP B1 Service Layer login, or OData/S/4 reachability with basic auth. */
export async function testSapConnection(conn: IIntegrationConnection): Promise<string> {
    const baseUrl = normalizeBaseUrl(cfg(conn, 'baseUrl'));
    const companyDb = cfg(conn, 'companyDb');
    const username = cfg(conn, 'username');
    const password = sec(conn, 'password');
    if (!baseUrl || !username || !password) {
        throw Object.assign(new Error('SAP base URL, username, and password are required'), { statusCode: 400 });
    }

    const loginUrl = `${baseUrl}/Login`;
    try {
        const loginRes = await axios.post(
            loginUrl,
            {
                CompanyDB: companyDb || undefined,
                UserName: username,
                Password: password,
            },
            {
                timeout: TEST_TIMEOUT_MS,
                validateStatus: (s) => s < 500,
                headers: { 'Content-Type': 'application/json' },
            }
        );
        if (loginRes.status >= 200 && loginRes.status < 300) {
            return `SAP Service Layer login OK (${loginRes.status})`;
        }
    } catch (e: any) {
        const msg = String(e?.response?.data?.error?.message?.value || e?.message || '');
        if (!/404|405|ENOTFOUND|ECONNREFUSED/i.test(msg)) {
            throw Object.assign(new Error(`SAP login failed: ${msg || 'connection error'}`), { statusCode: 400 });
        }
    }

    const probe = await axios.get(baseUrl, {
        timeout: TEST_TIMEOUT_MS,
        auth: { username, password },
        validateStatus: (s) => s < 500,
    });
    if (probe.status === 401 || probe.status === 403) {
        throw Object.assign(new Error('SAP reachable but credentials rejected (401/403)'), { statusCode: 400 });
    }
    if (probe.status >= 200 && probe.status < 400) {
        return `SAP endpoint reachable (${probe.status}) — use push URL for document ingest`;
    }
    throw Object.assign(new Error(`SAP endpoint returned HTTP ${probe.status}`), { statusCode: 400 });
}

/** Azure AD client-credentials against Dynamics / Business Central environment. */
export async function testDynamics365Connection(conn: IIntegrationConnection): Promise<string> {
    const tenantId = cfg(conn, 'tenantId');
    const clientId = cfg(conn, 'clientId');
    const clientSecret = sec(conn, 'clientSecret');
    const environmentUrl = normalizeBaseUrl(cfg(conn, 'environmentUrl'));
    if (!tenantId || !clientId || !clientSecret || !environmentUrl) {
        throw Object.assign(new Error('Tenant ID, client ID, client secret, and environment URL are required'), {
            statusCode: 400,
        });
    }

    const tokenUrl = `https://login.microsoftonline.com/${encodeURIComponent(tenantId)}/oauth2/v2.0/token`;
    const scope = `${environmentUrl}/.default`;
    const body = new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: clientId,
        client_secret: clientSecret,
        scope,
    });

    const tokenRes = await axios.post(tokenUrl, body.toString(), {
        timeout: TEST_TIMEOUT_MS,
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        validateStatus: (s) => s < 500,
    });

    if (tokenRes.status !== 200 || !tokenRes.data?.access_token) {
        const err =
            tokenRes.data?.error_description ||
            tokenRes.data?.error ||
            `HTTP ${tokenRes.status}`;
        throw Object.assign(new Error(`Dynamics 365 auth failed: ${err}`), { statusCode: 400 });
    }

    return 'Dynamics 365 OAuth token acquired — use push URL for document ingest';
}

/** Odoo common.version via JSON-RPC. */
export async function testOdooConnection(conn: IIntegrationConnection): Promise<string> {
    const baseUrl = normalizeBaseUrl(cfg(conn, 'baseUrl'));
    const database = cfg(conn, 'database');
    const username = cfg(conn, 'username');
    const apiKey = sec(conn, 'apiKey');
    if (!baseUrl || !database || !username || !apiKey) {
        throw Object.assign(new Error('Odoo base URL, database, username, and API key are required'), {
            statusCode: 400,
        });
    }

    const jsonrpcUrl = `${baseUrl}/jsonrpc`;
    const versionRes = await axios.post(
        jsonrpcUrl,
        {
            jsonrpc: '2.0',
            method: 'call',
            params: { service: 'common', method: 'version', args: [] },
            id: 1,
        },
        { timeout: TEST_TIMEOUT_MS, validateStatus: (s) => s < 500 }
    );

    const version = versionRes.data?.result;
    if (!version) {
        throw Object.assign(new Error('Odoo version probe failed — check base URL'), { statusCode: 400 });
    }

    const authRes = await axios.post(
        jsonrpcUrl,
        {
            jsonrpc: '2.0',
            method: 'call',
            params: {
                service: 'common',
                method: 'authenticate',
                args: [database, username, apiKey, {}],
            },
            id: 2,
        },
        { timeout: TEST_TIMEOUT_MS, validateStatus: (s) => s < 500 }
    );

    const uid = authRes.data?.result;
    if (!uid) {
        throw Object.assign(new Error('Odoo authentication failed — check database, username, and API key'), {
            statusCode: 400,
        });
    }

    const ver =
        typeof version === 'object' && version?.server_version
            ? String(version.server_version)
            : String(version);
    return `Odoo ${ver} — authenticated as user id ${uid}. Use push URL for document ingest.`;
}

export async function testRemoteProviderConnection(conn: IIntegrationConnection): Promise<string> {
    switch (conn.providerId) {
        case 'sap':
            return testSapConnection(conn);
        case 'dynamics365':
            return testDynamics365Connection(conn);
        case 'odoo':
            return testOdooConnection(conn);
        default:
            throw Object.assign(new Error(`No remote test for provider ${conn.providerId}`), { statusCode: 400 });
    }
}
