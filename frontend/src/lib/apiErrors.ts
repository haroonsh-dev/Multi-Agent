export const API_UNAVAILABLE_MESSAGE =
    "Cannot reach the API. Start the api-gateway on port 5100 (see api-gateway/.env).";

/** Next dev proxy or gateway closed a long-running request before the AI finished. */
export const CHAT_PROXY_TIMEOUT_MESSAGE =
    "Chat connection dropped before the answer finished (proxy or timeout). Restart Next dev after config changes, or set AI_CHAT_TIMEOUT_MS / DOCS_API_PROXY_TIMEOUT_MS higher.";

export function isNetworkFetchError(error: unknown): boolean {
    if (error instanceof TypeError) return true;
    if (
        error &&
        typeof error === "object" &&
        "status" in error &&
        (error as { status: number }).status === 0
    ) {
        return true;
    }
    if (error instanceof Error) {
        const m = error.message.toLowerCase();
        return (
            m === "failed to fetch" ||
            m.includes("networkerror") ||
            m.includes("network request failed") ||
            m.includes("fetch failed") ||
            m.includes("econnrefused") ||
            m.includes("econnreset") ||
            m.includes("socket hang up")
        );
    }
    return false;
}

export function isChatProxyDrop(error: unknown): boolean {
    if (!(error instanceof Error)) return false;
    const m = error.message.toLowerCase();
    return m.includes("socket hang up") || m.includes("econnreset");
}

export function getRequestErrorMessage(error: unknown, fallback = "Request failed"): string {
    if (error instanceof Error && error.message) {
        if (isNetworkFetchError(error)) return API_UNAVAILABLE_MESSAGE;
        return error.message;
    }
    return fallback;
}
