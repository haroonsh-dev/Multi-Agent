"use client";

import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { apiRequest, ApiError } from "@/lib/apiClient";
import { isNetworkFetchError } from "@/lib/apiErrors";
import { getAuthValue, getStoredUser, setAuthValue } from "@/lib/authSession";
import {
    DEFAULT_TEAM_PERMS,
    getUserPermissions,
    getUserRole,
    hasAppPermission as checkPermission,
    canAccessPage as checkPage,
    firstAllowedPath,
    PAGE_PERM_BY_KEY,
    PERMS,
    type PageAccessKey,
} from "@/lib/permissions";

type PermissionsContextValue = {
    permissions: Record<string, boolean>;
    role: string;
    ready: boolean;
    /** Latest /auth/me user (seeded from localStorage, refreshed in background). */
    user: Record<string, unknown> | null;
    reload: () => Promise<void>;
    hasPermission: (key: string) => boolean;
    canAccessPage: (page: PageAccessKey) => boolean;
    canUpload: () => boolean;
    canViewDocs: () => boolean;
    canDeleteDocs: () => boolean;
    canShareDocs: () => boolean;
    canChat: () => boolean;
    canViewDepartments: () => boolean;
    canManageDepartments: () => boolean;
    firstAllowedPath: () => string;
};

const PermissionsContext = createContext<PermissionsContextValue | null>(null);

export function PermissionsProvider({ children }: { children: React.ReactNode }) {
    // SSR-safe defaults — localStorage is only read after mount to avoid hydration mismatch
    const [permissions, setPermissions] = useState<Record<string, boolean>>({});
    const [role, setRole] = useState("team");
    const [user, setUser] = useState<Record<string, unknown> | null>(null);
    const [ready, setReady] = useState(false);

    const reload = useCallback(async () => {
        try {
            const me = await apiRequest("/auth/me");
            const fresh = me?.data?.user;
            if (fresh) {
                const stored = getStoredUser<Record<string, unknown>>() || {};
                const merged = { ...stored, ...fresh };
                setAuthValue("user", JSON.stringify(merged));
                setUser(merged);
                const perms = fresh.permissions || {};
                setPermissions(perms);
                setRole(fresh.role || "team");
                setAuthValue("permissions", JSON.stringify(perms));
            }
        } catch (err) {
            if (isNetworkFetchError(err) || (err instanceof ApiError && err.status === 0)) {
                return;
            }
            const token = getAuthValue("accessToken") || getAuthValue("token");
            if (!token) {
                setPermissions({});
                setRole("");
                setUser(null);
                // No hard reload here: apiClient already redirects to /login on 401,
                // and Shell's ensureAuthed covers the client-side redirect.
            } else {
                setPermissions(getUserPermissions());
                setRole(getUserRole());
                setUser(getStoredUser<Record<string, unknown>>() || null);
            }
        } finally {
            setReady(true);
        }
    }, []);

    useEffect(() => {
        // Seed from cache synchronously so the UI renders immediately; reload() refreshes in the background.
        const cachedUser = getStoredUser<Record<string, unknown>>() || null;
        setUser(cachedUser);
        setPermissions(getUserPermissions());
        setRole(getUserRole());
        setReady(Boolean(getAuthValue("accessToken") || getAuthValue("token")) || Boolean(getUserRole() || Object.keys(getUserPermissions()).length));
        reload();
    }, [reload]);

    useEffect(() => {
        let debounceTimer: ReturnType<typeof setTimeout> | null = null;

        const scheduleReload = () => {
            if (typeof window !== "undefined" && window.location.pathname.startsWith("/login")) return;
            if (debounceTimer) clearTimeout(debounceTimer);
            debounceTimer = setTimeout(() => void reload(), 1000);
        };

        const onVisible = () => {
            if (document.visibilityState === "visible") scheduleReload();
        };

        window.addEventListener("focus", scheduleReload);
        document.addEventListener("visibilitychange", onVisible);
        return () => {
            if (debounceTimer) clearTimeout(debounceTimer);
            window.removeEventListener("focus", scheduleReload);
            document.removeEventListener("visibilitychange", onVisible);
        };
    }, [reload]);

    const hasPermission = useCallback(
        (key: string) => {
            if (role === "superAdmin" || role === "admin") return true;
            if (key === PERMS.PREVIEW) {
                return permissions[PERMS.PREVIEW] === true || permissions[PERMS.VIEW] === true;
            }
            if (
                key === PERMS.PAGE_DASHBOARD ||
                key === PERMS.PAGE_DOCUMENTS ||
                key === PERMS.PAGE_CHAT
            ) {
                if (key in permissions) return permissions[key] === true;
                return true;
            }
            if (
                key === PERMS.PAGE_ACTIVITY ||
                key === PERMS.PAGE_DEPARTMENTS ||
                key === PERMS.PAGE_PLANS ||
                key === PERMS.PAGE_EMAIL_REPORTS ||
                key === PERMS.PAGE_INTEGRATIONS ||
                key === PERMS.PAGE_SETTINGS
            ) {
                if (key in permissions) return permissions[key] === true;
                return false;
            }
            return permissions[key] === true;
        },
        [permissions, role]
    );

    const canAccessPageFn = useCallback(
        (page: PageAccessKey) => hasPermission(PAGE_PERM_BY_KEY[page]),
        [hasPermission]
    );

    const value = useMemo<PermissionsContextValue>(
        () => ({
            permissions,
            role,
            ready,
            user,
            reload,
            hasPermission,
            canAccessPage: canAccessPageFn,
            canUpload: () => hasPermission(PERMS.UPLOAD),
            canViewDocs: () => hasPermission(PERMS.VIEW),
            canDeleteDocs: () => hasPermission(PERMS.DELETE),
            canShareDocs: () => hasPermission(PERMS.SHARE),
            canChat: () => hasPermission(PERMS.CHAT),
            canViewDepartments: () => hasPermission(PERMS.DEPT_VIEW),
            canManageDepartments: () => hasPermission(PERMS.DEPT_MANAGE),
            firstAllowedPath: () => firstAllowedPath(permissions, role),
        }),
        [permissions, role, ready, user, reload, hasPermission, canAccessPageFn]
    );

    return <PermissionsContext.Provider value={value}>{children}</PermissionsContext.Provider>;
}

export function usePermissions() {
    const ctx = useContext(PermissionsContext);
    if (!ctx) {
        return {
            permissions: getUserPermissions(),
            role: getUserRole(),
            ready: true,
            user: getStoredUser<Record<string, unknown>>() || null,
            reload: async () => {},
            hasPermission: checkPermission,
            canAccessPage: checkPage,
            canUpload: () => checkPermission(PERMS.UPLOAD),
            canViewDocs: () => checkPermission(PERMS.VIEW),
            canDeleteDocs: () => checkPermission(PERMS.DELETE),
            canShareDocs: () => checkPermission(PERMS.SHARE),
            canChat: () => checkPermission(PERMS.CHAT),
            canViewDepartments: () => checkPermission(PERMS.DEPT_VIEW),
            canManageDepartments: () => checkPermission(PERMS.DEPT_MANAGE),
            firstAllowedPath: () => firstAllowedPath(),
        };
    }
    return ctx;
}

export { DEFAULT_TEAM_PERMS };
