import { getAuthValue } from "./authSession";
import { firstAllowedPath } from "./permissions";

export function enrichUserFromToken(user: any, token: string | null) {
    if (!user) return user;
    if (!token) return user;
    try {
        const payload = JSON.parse(atob(token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/")));
        return {
            ...user,
            role: user.role || payload.role,
            organizationId: user.organizationId ?? payload.organizationId ?? null,
            realm: user.realm || user.openRemoteRealm || payload.realm || null,
            openRemoteUserId: user.openRemoteUserId || payload.openRemoteUserId || null,
        };
    } catch {
        return user;
    }
}

export function getRedirectPath(_accountType?: string, role?: string) {
    if (role === "superAdmin" || role === "admin") return "/dashboard";
    return firstAllowedPath(undefined, role);
}

export async function resolvePostLoginPath(user: any) {
    if (!user) return "/dashboard";
    if (user.role === "superAdmin" || user.role === "admin") return "/dashboard";
    return firstAllowedPath(user.permissions || {}, user.role || "team");
}

export function isAuthenticated() {
    return !!(getAuthValue("accessToken") || getAuthValue("token"));
}
