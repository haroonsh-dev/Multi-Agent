import { clearAuthState, getAuthValue, setAuthValue } from "./authSession";
import { API_UNAVAILABLE_MESSAGE, isNetworkFetchError } from "./apiErrors";

/** Same-origin /api rewrite in dev; override with NEXT_PUBLIC_API_URL if needed. */
const API_BASE = (process.env.NEXT_PUBLIC_API_URL || "/api").replace(/\/$/, "");

export type GroqLimitPayload = {
    code: "GROQ_RATE_LIMIT";
    message: string;
    retry_after_seconds?: number;
    until_ts?: number;
    console_url?: string;
    billing_url?: string;
};

export class ApiError extends Error {
    status: number;
    code?: string;
    data?: any;
    constructor(message: string, status: number, data?: any) {
        super(message);
        this.name = "ApiError";
        this.status = status;
        this.code = data?.code;
        this.data = data;
    }
}

type GroqHandler = ((info: GroqLimitPayload) => void) | null;
let groqLimitHandler: GroqHandler = null;

export function setGroqLimitHandler(fn: GroqHandler) {
    groqLimitHandler = fn;
}

function maybeNotifyGroqLimit(status: number, data: any) {
    const msg = String(data?.message || data?.detail || data?.error || "");
    const isLimit =
        data?.code === "GROQ_RATE_LIMIT" ||
        status === 429 ||
        /rate.?limit|tokens per day|tpd|GROQ_RATE_LIMIT/i.test(msg);
    if (!isLimit) return;
    const payload: GroqLimitPayload = {
        code: "GROQ_RATE_LIMIT",
        message: msg || "Groq rate limit reached",
        retry_after_seconds: Number(data?.retry_after_seconds) || 24 * 3600,
        until_ts: data?.until_ts ? Number(data.until_ts) : undefined,
        console_url: data?.console_url || "https://console.groq.com/keys",
        billing_url: data?.billing_url || "https://console.groq.com/settings/billing",
    };
    groqLimitHandler?.(payload);
}

function buildApiUrl(endpoint: string): string {
    if (endpoint.startsWith("http")) return endpoint;
    const path = endpoint.startsWith("/") ? endpoint : `/${endpoint}`;
    return `${API_BASE}${path}`;
}

async function networkSafeFetch(
    url: string,
    options: RequestInit,
    timeoutMs = 30_000
): Promise<Response> {
    try {
        const signal =
            options.signal ||
            (typeof AbortSignal !== "undefined" && "timeout" in AbortSignal
                ? AbortSignal.timeout(timeoutMs)
                : undefined);
        return await fetch(url, signal ? { ...options, signal } : options);
    } catch (error) {
        if (isNetworkFetchError(error)) {
            throw new ApiError(API_UNAVAILABLE_MESSAGE, 0, { code: "NETWORK_ERROR" });
        }
        if (error instanceof DOMException && error.name === "TimeoutError") {
            throw new ApiError("Request timed out. Check that api-gateway is running.", 0, {
                code: "TIMEOUT",
            });
        }
        throw error;
    }
}

/** Guard against parallel 401s each triggering a full page reload. */
let lastRedirectAt = 0;

function redirectToLoginIfNeeded() {
    if (typeof window === "undefined") return;
    if (window.location.pathname.startsWith("/login")) return;
    // Parallel requests may all 401 at once — only redirect once per window,
    // otherwise the page gets hammered with full reloads.
    const now = Date.now();
    if (now - lastRedirectAt < 5_000) return;
    lastRedirectAt = now;
    window.location.replace("/login");
}

/** Shared so N parallel 401s trigger exactly one refresh round trip. */
let refreshInFlight: Promise<string | null> | null = null;

async function refreshAccessToken(): Promise<string | null> {
    const refreshToken = getAuthValue("refreshToken") || getAuthValue("refresh_token");
    if (!refreshToken) return null;
    if (refreshInFlight) return refreshInFlight;

    refreshInFlight = (async () => {
        try {
            const res = await networkSafeFetch(`${API_BASE}/auth/refresh`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ refreshToken }),
            });
            if (!res.ok) return null;
            const data = await res.json();
            const accessToken = data?.data?.accessToken;
            if (accessToken) {
                setAuthValue("accessToken", accessToken);
                if (data?.data?.refreshToken) setAuthValue("refreshToken", data.data.refreshToken);
            }
            return accessToken;
        } catch {
            return null;
        } finally {
            refreshInFlight = null;
        }
    })();

    return refreshInFlight;
}

export async function apiRequest<T = any>(
    endpoint: string,
    options: RequestInit & { timeoutMs?: number } = {}
): Promise<T> {
    const url = buildApiUrl(endpoint);
    const { timeoutMs, ...fetchOptions } = options;

    const token = getAuthValue("accessToken") || getAuthValue("token");

    const doFetch = async (accessToken: string | null) => {
        const headers = new Headers(fetchOptions.headers || {});
        if (!(fetchOptions.body instanceof FormData) && !headers.has("Content-Type")) {
            headers.set("Content-Type", "application/json");
        }
        if (accessToken) headers.set("Authorization", `Bearer ${accessToken}`);
        return networkSafeFetch(url, { ...fetchOptions, headers }, timeoutMs ?? 30_000);
    };

    let res = await doFetch(token);
    if (res.status === 401) {
        const next = await refreshAccessToken();
        if (next) {
            res = await doFetch(next);
        } else {
            clearAuthState();
            redirectToLoginIfNeeded();
        }
    }

    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
        if (res.status === 401) {
            clearAuthState();
            redirectToLoginIfNeeded();
        }
        maybeNotifyGroqLimit(res.status, data);
        const gatewayDown = res.status === 502 || res.status === 503 || res.status === 504;
        let detailMsg: string | undefined;
        if (typeof data.detail === "string") detailMsg = data.detail;
        else if (Array.isArray(data.detail)) {
            detailMsg = data.detail
                .map((item: { msg?: string }) => item?.msg || String(item))
                .filter(Boolean)
                .join("; ");
        }
        const message = gatewayDown
            ? API_UNAVAILABLE_MESSAGE
            : data.message || detailMsg || data.error || `Request failed (${res.status})`;
        throw new ApiError(message, res.status, data);
    }
    return data as T;
}

export async function apiFetchBlob(
    endpoint: string,
    options: RequestInit = {}
): Promise<Blob> {
    const url = buildApiUrl(endpoint);

    const token = getAuthValue("accessToken") || getAuthValue("token");

    const doFetch = async (accessToken: string | null) => {
        const headers = new Headers(options.headers || {});
        if (accessToken) headers.set("Authorization", `Bearer ${accessToken}`);
        return networkSafeFetch(url, { ...options, headers });
    };

    let res = await doFetch(token);
    if (res.status === 401) {
        const next = await refreshAccessToken();
        if (next) {
            res = await doFetch(next);
        } else {
            clearAuthState();
            redirectToLoginIfNeeded();
        }
    }

    if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        if (res.status === 401) {
            clearAuthState();
            redirectToLoginIfNeeded();
        }
        maybeNotifyGroqLimit(res.status, data);
        const gatewayDown = res.status === 502 || res.status === 503 || res.status === 504;
        const message = gatewayDown
            ? API_UNAVAILABLE_MESSAGE
            : data.message || `Request failed (${res.status})`;
        throw new ApiError(message, res.status, data);
    }
    return res.blob();
}

export { API_UNAVAILABLE_MESSAGE, getRequestErrorMessage } from "./apiErrors";
