/**
 * Absolute API base for Next.js server routes (Node fetch cannot use "/api").
 * Browser code should keep using NEXT_PUBLIC_API_URL (/api via rewrite).
 */
export function getServerApiBase(): string {
    const publicUrl = (process.env.NEXT_PUBLIC_API_URL || "").trim();
    if (publicUrl.startsWith("http://") || publicUrl.startsWith("https://")) {
        return publicUrl.replace(/\/$/, "");
    }
    const proxy = (process.env.DOCS_API_PROXY_TARGET || "http://localhost:5100").replace(/\/$/, "");
    return `${proxy}/api`;
}
