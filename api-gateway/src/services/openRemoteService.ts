import axios, { AxiosInstance } from 'axios';
import https from 'https';
import dotenv from 'dotenv';
import logger from '../utils/logger';

dotenv.config();

/**
 * Minimal OpenRemote service aligned with Visibility Live patterns
 * so Docs AI users are created/authenticated the same way for future merge.
 */
class OpenRemoteService {
    private baseURL: string;
    private realm: string;
    private adminUsername?: string;
    private adminPassword?: string;
    private masterUsername?: string;
    private masterPassword?: string;
    private masterToken: string | null = null;
    private masterTokenExpiry: Date | null = null;
    private axiosInstance: AxiosInstance;

    constructor() {
        this.baseURL = (process.env.OPENREMOTE_BASE_URL || 'http://localhost:8080').replace(/\/$/, '');
        this.realm = process.env.OPENREMOTE_REALM || 'master';
        this.adminUsername = process.env.OPENREMOTE_ADMIN_USERNAME || 'admin';
        this.adminPassword = process.env.OPENREMOTE_ADMIN_PASSWORD || 'secret';
        this.masterUsername =
            process.env.OPENREMOTE_MASTER_CLIENT_ID ||
            process.env.OPENREMOTE_MASTER_USERNAME ||
            process.env.OPENREMOTE_ADMIN_USERNAME ||
            'admin';
        this.masterPassword =
            process.env.OPENREMOTE_MASTER_CLIENT_SECRET ||
            process.env.OPENREMOTE_MASTER_PASSWORD ||
            process.env.OPENREMOTE_ADMIN_PASSWORD ||
            'secret';

        const rejectUnauthorized = process.env.OPENREMOTE_VERIFY_SSL === 'true';
        this.axiosInstance = axios.create({
            httpsAgent: new https.Agent({ rejectUnauthorized, keepAlive: true }),
            timeout: 30000,
        });
    }

    private getTokenExpiryFromJwt(token: string): Date | null {
        try {
            const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64').toString('utf8'));
            if (payload?.exp) return new Date(payload.exp * 1000);
        } catch {
            /* ignore */
        }
        return null;
    }

    private async getToken(
        clientId: string,
        clientSecretOrPassword: string,
        realm: string,
        grantType: 'client_credentials' | 'password' = 'client_credentials',
        username?: string
    ): Promise<string> {
        const tokenUrls = [
            `${this.baseURL}/auth/realms/${realm}/protocol/openid-connect/token`,
            `${this.baseURL}/realms/${realm}/protocol/openid-connect/token`,
        ];

        let lastError: any;
        for (const url of tokenUrls) {
            try {
                const params = new URLSearchParams();
                params.append('grant_type', grantType);
                params.append('client_id', clientId);

                if (grantType === 'client_credentials') {
                    params.append('client_secret', clientSecretOrPassword);
                } else {
                    params.append('username', username || this.adminUsername || 'admin');
                    params.append('password', clientSecretOrPassword);
                }

                const response = await this.axiosInstance.post(url, params.toString(), {
                    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                });
                return response.data.access_token;
            } catch (err) {
                lastError = err;
            }
        }
        throw lastError;
    }

    async getMasterToken(): Promise<string> {
        if (this.masterToken && this.masterTokenExpiry && new Date() < this.masterTokenExpiry) {
            return this.masterToken;
        }

        let token: string;
        try {
            token = await this.getToken(
                this.masterUsername || 'admin',
                this.masterPassword || 'secret',
                'master',
                'client_credentials'
            );
        } catch {
            token = await this.getToken(
                'openremote',
                this.masterPassword || 'secret',
                'master',
                'password',
                this.masterUsername
            );
        }

        this.masterToken = token;
        this.masterTokenExpiry = this.getTokenExpiryFromJwt(token) || new Date(Date.now() + 600 * 1000);
        logger.info(`OpenRemote master token acquired (expires ${this.masterTokenExpiry.toISOString()})`);
        return this.masterToken;
    }

    async ensureRealmExists(realmName: string, displayName?: string): Promise<string> {
        const normalizedRealm =
            (realmName || '')
                .toLowerCase()
                .trim()
                .replace(/[^a-z0-9_]/g, '_')
                .replace(/_+/g, '_')
                .replace(/^_+|_+$/g, '') || 'personal';

        const masterToken = await this.getMasterToken();
        const realmsResp = await this.axiosInstance.get(`${this.baseURL}/api/master/realm`, {
            headers: { Authorization: `Bearer ${masterToken}`, Accept: 'application/json' },
        });

        const existing: string[] = (realmsResp.data || []).map((r: any) => r?.name).filter(Boolean);
        if (existing.includes(normalizedRealm)) {
            return normalizedRealm;
        }

        await this.axiosInstance.post(
            `${this.baseURL}/api/master/realm`,
            {
                id: normalizedRealm,
                name: normalizedRealm,
                displayName: displayName || normalizedRealm,
                enabled: true,
                resetPasswordAllowed: true,
                registrationAllowed: true,
                loginWithEmail: true,
            },
            {
                headers: {
                    Authorization: `Bearer ${masterToken}`,
                    'Content-Type': 'application/json',
                    Accept: 'application/json',
                },
            }
        );

        logger.info(`Created OpenRemote realm: ${normalizedRealm}`);
        return normalizedRealm;
    }

    async createUser(userData: {
        username?: string;
        email: string;
        fullName?: string;
        role?: string;
        realm?: string;
        serviceAccount?: boolean;
        password?: string;
        secretKey?: string;
    }): Promise<{ success: boolean; userId: string | null; openRemoteSecret?: string | null; realm?: string }> {
        const masterToken = await this.getMasterToken();
        const normalizedRealm = (userData.realm || this.realm).replace(/\s+/g, '').toLowerCase();

        const payload = {
            username: userData.email,
            email: userData.email,
            attributes: { email: [userData.email] },
            serviceAccount: userData.serviceAccount !== false,
            enabled: true,
            realm: normalizedRealm,
        };

        const createUserUrl = `${this.baseURL}/api/master/user/${normalizedRealm}/users`;
        logger.info(`Creating OpenRemote user in ${normalizedRealm}: ${userData.email}`);

        const response = await this.axiosInstance.post(createUserUrl, payload, {
            headers: {
                Authorization: `Bearer ${masterToken}`,
                'Content-Type': 'application/json',
                Accept: 'application/json',
            },
            validateStatus: (status) => status < 500,
        });

        let userId: string | null = response.data?.id || null;
        let openRemoteSecret: string | null = null;

        if (response.status === 409 || !userId) {
            try {
                const getUserResponse = await this.axiosInstance.get(
                    `${this.baseURL}/api/master/user/${normalizedRealm}/users?username=${encodeURIComponent(userData.email)}`,
                    { headers: { Authorization: `Bearer ${masterToken}`, Accept: 'application/json' } }
                );
                if (getUserResponse.data?.length) {
                    userId = getUserResponse.data[0].id;
                }
            } catch {
                /* continue */
            }
        }

        if (userId) {
            try {
                const userInfo = await this.axiosInstance.get(
                    `${this.baseURL}/api/master/user/${normalizedRealm}/${userId}`,
                    { headers: { Authorization: `Bearer ${masterToken}`, Accept: 'application/json' } }
                );
                openRemoteSecret = userInfo.data?.secret || null;
            } catch {
                /* optional */
            }

            try {
                const realmRoles = ['user'];
                if (userData.role === 'admin' || userData.role === 'superAdmin') {
                    realmRoles.push('admin');
                }
                await this.axiosInstance.put(
                    `${this.baseURL}/api/master/user/${normalizedRealm}/userRealmRoles/${userId}`,
                    realmRoles,
                    {
                        headers: {
                            Authorization: `Bearer ${masterToken}`,
                            'Content-Type': 'application/json',
                        },
                    }
                );
            } catch (roleErr: any) {
                logger.warn(`Realm role assignment skipped: ${roleErr.message}`);
            }

            try {
                await this.axiosInstance.put(
                    `${this.baseURL}/api/master/user/${normalizedRealm}/userRoles/${userId}/openremote`,
                    ['read', 'write', 'read:assets', 'write:assets', 'read:users', 'write:user'],
                    {
                        headers: {
                            Authorization: `Bearer ${masterToken}`,
                            'Content-Type': 'application/json',
                        },
                    }
                );
            } catch (roleErr: any) {
                logger.warn(`Client role assignment skipped: ${roleErr.message}`);
            }
        }

        if (response.status >= 400 && response.status !== 409) {
            throw new Error(`OpenRemote createUser failed: ${response.status} ${JSON.stringify(response.data)}`);
        }

        return { success: true, userId, openRemoteSecret, realm: normalizedRealm };
    }

    async authenticateUser(
        usernameOrEmail: string,
        password: string,
        passedRealm?: string
    ): Promise<{ token: string; type: string; usedClientId: string; realm: string }> {
        const realmsToTry = [
            passedRealm,
            process.env.OPENREMOTE_REALM,
            'master',
            'personal',
        ].filter(Boolean) as string[];

        const uniqueRealms = [...new Set(realmsToTry)];
        let lastError: any;

        for (const realm of uniqueRealms) {
            const clients = [`${realm}-client`, 'openremote', usernameOrEmail];
            for (const clientId of clients) {
                try {
                    const token = await this.getToken(clientId, password, realm, 'client_credentials');
                    return { token, type: 'client_credentials', usedClientId: clientId, realm };
                } catch (err) {
                    lastError = err;
                }
                try {
                    const token = await this.getToken('openremote', password, realm, 'password', usernameOrEmail);
                    return { token, type: 'password', usedClientId: 'openremote', realm };
                } catch (err) {
                    lastError = err;
                }
            }
        }

        throw lastError || new Error('OpenRemote authentication failed');
    }

    async retryWithBackoff(fn: () => Promise<any>, maxRetries = 3, initialDelay = 500) {
        let lastError: any;
        for (let i = 0; i < maxRetries; i++) {
            try {
                return await fn();
            } catch (err) {
                lastError = err;
                await new Promise((r) => setTimeout(r, initialDelay * Math.pow(2, i)));
            }
        }
        throw lastError;
    }
}

export default new OpenRemoteService();
