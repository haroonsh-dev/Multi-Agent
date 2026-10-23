const AUTH_STORAGE_KEYS = [
    "accessToken",
    "refreshToken",
    "openRemoteToken",
    "token",
    "refresh_token",
    "user",
    "permissions",
];

const SESSION_MARKER_KEY = "vb:session:active";

function hasWindow() {
    return typeof window !== "undefined";
}

export function getTokenExpiryMs(token: string | null | undefined): number | null {
    if (!token) return null;
    try {
        const payload = token.split(".")[1];
        if (!payload) return null;
        const decoded = JSON.parse(atob(payload.replace(/-/g, "+").replace(/_/g, "/")));
        if (!decoded.exp) return null;
        return decoded.exp * 1000;
    } catch {
        return null;
    }
}

export function isTokenExpired(token: string | null | undefined, bufferMs = 0): boolean {
    const expiry = getTokenExpiryMs(token);
    if (!expiry) return false;
    return Date.now() >= expiry - bufferMs;
}

export function hasValidAccessToken(): boolean {
    const token = getAuthValue("accessToken") || getAuthValue("token");
    return !!token && !isTokenExpired(token);
}

export function canRefreshSession(): boolean {
    const refreshToken = getAuthValue("refreshToken") || getAuthValue("refresh_token");
    return !!(refreshToken && !isTokenExpired(refreshToken));
}

export function setAuthValue(key: string, value: string) {
    if (!hasWindow()) return;
    localStorage.setItem(key, value);
    sessionStorage.setItem(key, value);
    sessionStorage.setItem(SESSION_MARKER_KEY, "1");
    localStorage.setItem(SESSION_MARKER_KEY, "1");
}

export function getAuthValue(key: string): string | null {
    if (!hasWindow()) return null;
    return sessionStorage.getItem(key) || localStorage.getItem(key);
}

export function clearAuthState() {
    if (!hasWindow()) return;
    for (const key of AUTH_STORAGE_KEYS) {
        localStorage.removeItem(key);
        sessionStorage.removeItem(key);
    }
    sessionStorage.removeItem(SESSION_MARKER_KEY);
    localStorage.removeItem(SESSION_MARKER_KEY);
}

export function getStoredUser<T = any>(): T | null {
    const raw = getAuthValue("user");
    if (!raw) return null;
    try {
        return JSON.parse(raw) as T;
    } catch {
        return null;
    }
}
