"use client";

import React, { useCallback, useEffect, useMemo, useState } from "react";
import Image from "next/image";
import Link from "next/link";
import { useRouter, usePathname } from "next/navigation";
import { Menu } from "lucide-react";
import Sidebar from "./Sidebar";
import { ToastProvider } from "./Toast";
import { ColorProvider } from "@/context/ColorContext";
import { PermissionsProvider, usePermissions } from "@/context/PermissionsContext";
import { GroqLimitProvider } from "./GroqLimitModal";
import DriveSyncInbox from "./DriveSyncInbox";
import { clearAuthState, hasValidAccessToken, canRefreshSession, getAuthValue } from "@/lib/authSession";
import DocuGemmaLogo from "./DocuGemmaLogo";

const PAGE_TITLES: Record<string, string> = {
    "/dashboard": "Dashboard",
    "/documents": "Document Vault",
    "/search": "Search",
    "/chat": "AI Assistant",
    "/activity": "System Activity",
    "/profile": "Profile",
    "/admin/departments": "Organization Hub",
    "/admin/admins": "Admins",
    "/admin/plans": "Subscriptions & Billing",
    "/plans": "Subscriptions & Billing",
    "/admin/documents": "Document Vault",
    "/admin/settings": "AI Engine Config",
    "/admin/integrations": "Integrations",
    "/admin/email-reports": "Automated Reports",
};

function resolvePageTitle(pathname: string | null): string {
    if (!pathname) return "Docs AI";
    if (PAGE_TITLES[pathname]) return PAGE_TITLES[pathname];
    if (pathname.startsWith("/documents")) return "Documents";
    if (pathname.startsWith("/search")) return "Search";
    if (pathname.startsWith("/chat")) return "AI Chat";
    if (pathname.startsWith("/activity")) return "Activity";
    if (pathname.startsWith("/departments/") && pathname.includes("/members/")) return "Employee oversight";
    if (pathname.startsWith("/departments/")) return "Department";
    if (pathname.startsWith("/admin/departments")) return "Departments";
    if (pathname.startsWith("/admin")) return "Admin";
    return "Docs AI";
}

function matchesPath(pathname: string, base: string) {
    return pathname === base || pathname.startsWith(`${base}/`);
}

function Shell({ children }: { children: React.ReactNode }) {
    const router = useRouter();
    const pathname = usePathname();
    const {
        ready,
        role,
        canAccessPage,
        firstAllowedPath,
    } = usePermissions();
    const [navOpen, setNavOpen] = useState(false);

    const closeNav = useCallback(() => setNavOpen(false), []);

    const ensureAuthed = useCallback(() => {
        const token = getAuthValue("accessToken") || getAuthValue("token");
        if (!token || (!hasValidAccessToken() && !canRefreshSession())) {
            clearAuthState();
            router.replace("/login");
            return false;
        }
        return true;
    }, [router]);

    useEffect(() => {
        ensureAuthed();
    }, [ensureAuthed, ready, pathname]);

    useEffect(() => {
        if (ready && role === "superAdmin" && pathname) {
            const allowedRoutes = [
                "/dashboard",
                "/admin/documents",
                "/search",
                "/chat",
                "/activity",
                "/admin/admins",
                "/admin/plans",
                "/admin/settings",
                "/profile",
            ];
            const isAllowed = allowedRoutes.some(
                (route) => pathname === route || pathname.startsWith(`${route}/`)
            );
            if (!isAllowed) {
                router.replace("/dashboard");
            }
        }
    }, [ready, role, pathname, router]);

    const teamRouteBlocked = useMemo(() => {
        if (!ready || role !== "team" || !pathname) return false;
        if (matchesPath(pathname, "/profile")) return false;

        if (matchesPath(pathname, "/dashboard")) return !canAccessPage("dashboard");
        if (matchesPath(pathname, "/documents")) return !canAccessPage("documents");
        if (matchesPath(pathname, "/chat")) return !canAccessPage("chat");
        if (matchesPath(pathname, "/activity")) return !canAccessPage("activity");
        if (matchesPath(pathname, "/departments")) return !canAccessPage("departments");
        if (matchesPath(pathname, "/plans")) return !canAccessPage("plans");
        if (matchesPath(pathname, "/admin/email-reports")) return !canAccessPage("email_reports");
        if (matchesPath(pathname, "/admin/integrations")) return !canAccessPage("integrations");
        if (matchesPath(pathname, "/admin/settings")) return !canAccessPage("settings");
        if (matchesPath(pathname, "/admin")) return true;
        if (matchesPath(pathname, "/team") || matchesPath(pathname, "/search")) return true;
        return false;
    }, [ready, role, pathname, canAccessPage]);

    useEffect(() => {
        if (!teamRouteBlocked) return;
        router.replace(firstAllowedPath());
    }, [teamRouteBlocked, router, firstAllowedPath]);

    useEffect(() => {
        setNavOpen(false);
    }, [pathname]);

    return (
        <div className="h-screen flex overflow-hidden app-shell text-foreground relative">
            <Sidebar open={navOpen} onClose={closeNav} />
            <div className="flex-1 min-w-0 min-h-0 flex flex-col relative z-1">
                <header className="lg:hidden shrink-0 flex items-center gap-2.5 px-3 sm:px-4 py-2 border-b border-border bg-linear-to-r from-white/90 via-[rgba(56,182,255,0.08)] to-[rgba(63,116,255,0.042)] backdrop-blur-md">
                    <button
                        type="button"
                        onClick={() => setNavOpen(true)}
                        className="btn-ghost rounded-lg p-2.5 min-h-11 min-w-11 flex items-center justify-center shrink-0"
                        aria-label="Open menu"
                    >
                        <Menu size={20} />
                    </button>
                    <Link href="/dashboard" className="shrink-0 flex items-center min-h-10">
                        <DocuGemmaLogo size="sm" />
                    </Link>
                    <div className="min-w-0 flex-1">
                        <p className="text-sm font-semibold tracking-tight truncate leading-tight">
                            {resolvePageTitle(pathname)}
                        </p>
                    </div>
                </header>
                <main className="flex-1 min-h-0 min-w-0 overflow-y-auto app-main">
                    {teamRouteBlocked ? (
                        <div className="min-h-[40vh] flex items-center justify-center text-sm text-foreground-muted">
                            Redirecting…
                        </div>
                    ) : (
                        children
                    )}
                </main>
            </div>
        </div>
    );
}

export default function ClientLayout({ children }: { children: React.ReactNode }) {
    return (
        <ColorProvider>
            <ToastProvider>
                <PermissionsProvider>
                    <GroqLimitProvider>
                        <Shell>{children}</Shell>
                        <DriveSyncInbox />
                    </GroqLimitProvider>
                </PermissionsProvider>
            </ToastProvider>
        </ColorProvider>
    );
}
