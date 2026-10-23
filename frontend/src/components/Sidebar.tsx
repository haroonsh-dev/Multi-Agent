"use client";

import React, { Suspense, useEffect } from "react";
import Link from "next/link";
import Image from "next/image";
import { usePathname, useRouter } from "next/navigation";
import {
    ChevronDown, LogOut, User, X, Building2,
} from "lucide-react";
import { usePermissions } from "@/context/PermissionsContext";
import { clearAuthState, getStoredUser } from "@/lib/authSession";
import { apiRequest } from "@/lib/apiClient";
import DocuGemmaLogo from "@/components/DocuGemmaLogo";
import { agentWorkspacePath } from "@/lib/agentWorkspace";
import { usePlanAgents } from "@/hooks/usePlanAgents";
import { cn } from "@/lib/utils";

type StoredUser = { fullName?: string; email?: string; username?: string; role?: string };
type DeptNav = { departmentId: string; name: string };
type SidebarProps = { open?: boolean; onClose?: () => void };

export function SidebarContent({ open = false, onClose }: SidebarProps) {
    const pathname = usePathname();
    const router = useRouter();
    const {
        role: permRole,
        canAccessPage,
        ready,
    } = usePermissions();
    const { agentOptions } = usePlanAgents();
    // Avoid reading localStorage during SSR/first paint (hydration mismatch)
    const [user, setUser] = React.useState<StoredUser | null>(null);
    const [mounted, setMounted] = React.useState(false);

    React.useEffect(() => {
        setMounted(true);
        setUser(getStoredUser<StoredUser>());
    }, []);

    const role = permRole || user?.role || "team";

    const [deptOpen, setDeptOpen] = React.useState(true);
    const [departments, setDepartments] = React.useState<DeptNav[]>([]);

    useEffect(() => {
        if (!mounted || !ready) return;
        let cancelled = false;
        (async () => {
            try {
                const res = await apiRequest("/docs/departments");
                if (!cancelled) setDepartments(res?.data?.departments || []);
            } catch { if (!cancelled) setDepartments([]); }
        })();
        return () => { cancelled = true; };
    }, [role, mounted, ready]);

    const isSuperAdmin = role === "superAdmin";
    const canSeeDepts =
        role === "admin" ||
        isSuperAdmin ||
        canAccessPage("departments");

    const nav: { href: string; label: string; roles: string[]; allow?: () => boolean }[] = [
        {
            href: "/dashboard",
            label: "Dashboard",
            roles: ["superAdmin", "admin", "team", "service_account"],
            allow: () => role === "admin" || role === "superAdmin" || canAccessPage("dashboard"),
        },
        {
            href: departments[0] ? `/departments/${departments[0].departmentId}` : "/documents",
            label: "Department",
            roles: ["team"],
            allow: () =>
                !canAccessPage("documents") &&
                canAccessPage("departments") &&
                departments.length > 0,
        },
        {
            href: "/documents",
            label: "Document Vault",
            roles: ["superAdmin", "admin", "team", "service_account"],
            allow: () => role === "admin" || role === "superAdmin" || canAccessPage("documents"),
        },
        { href: "/admin/documents", label: "Document Vault", roles: ["superAdmin"] },
        {
            href: "/agents",
            label: "AI Workspaces",
            roles: ["superAdmin", "admin", "team", "service_account"],
            allow: () => role === "admin" || role === "superAdmin" || canAccessPage("chat"),
        },
        {
            href: "/admin/departments",
            label: "Organization Hub",
            roles: ["admin", "superAdmin"],
        },
        { href: "/admin/admins", label: "Admins", roles: ["superAdmin"] },
        { href: "/admin/plans", label: "Subscriptions & Billing", roles: ["superAdmin"] },
        { href: "/plans", label: "Subscriptions & Billing", roles: ["admin", "team"], allow: () => role === "admin" || role === "superAdmin" || canAccessPage("plans") },
        { href: "/admin/email-reports", label: "Automated Reports", roles: ["admin", "team"], allow: () => role === "admin" || role === "superAdmin" || canAccessPage("email_reports") },
        { href: "/admin/integrations", label: "Integrations", roles: ["admin", "team"], allow: () => role === "admin" || role === "superAdmin" || canAccessPage("integrations") },
        { href: "/admin/settings", label: "AI Engine Config", roles: ["admin", "superAdmin", "team"], allow: () => role === "admin" || role === "superAdmin" || canAccessPage("settings") },
        {
            href: "/activity",
            label: "System Activity",
            roles: ["superAdmin", "admin", "team"],
            allow: () => role === "admin" || role === "superAdmin" || canAccessPage("activity"),
        },
    ];

    // Until client has hydrated auth, render a stable baseline nav (no permission gates)
    // so server HTML and first client paint match.
    const visibleNav = React.useMemo(() => {
        if (!mounted || !ready) {
            return nav.filter((n) => n.roles.includes("team") && !n.allow);
        }
        return nav
            .filter((n) => n.roles.includes(role) && (n.allow ? n.allow() : true))
            .filter((n) => !isSuperAdmin || ["/dashboard", "/admin/documents", "/search", "/chat", "/activity", "/admin/admins", "/admin/plans", "/admin/settings"].includes(n.href));
    }, [mounted, ready, role, isSuperAdmin, canAccessPage, departments]);

    const logout = () => { clearAuthState(); router.replace("/login"); };

    // Prefetch workspace routes so first click is not waiting on Turbopack compile.
    useEffect(() => {
        if (!mounted || !ready) return;
        const hrefs = [
            ...visibleNav.map((item) => item.href),
            "/profile",
            "/admin/settings",
            "/admin/integrations",
            "/documents",
            "/agents",
            "/chat",
            "/dashboard",
            ...agentOptions.map((a) => agentWorkspacePath(a.value)),
        ];
        for (const href of [...new Set(hrefs)]) {
            try {
                router.prefetch(href);
            } catch {
                /* ignore */
            }
        }
    }, [mounted, ready, router, visibleNav, agentOptions]);

    useEffect(() => {
        if (!open) return;
        const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose?.(); };
        document.addEventListener("keydown", onKey);
        return () => document.removeEventListener("keydown", onKey);
    }, [open, onClose]);

    return (
        <>
            <button type="button"
                className={cn("lg:hidden fixed inset-0 z-40 bg-black/40 backdrop-blur-sm transition-opacity", open ? "opacity-100 pointer-events-auto" : "opacity-0 pointer-events-none")}
                aria-label="Close menu" onClick={onClose} tabIndex={open ? 0 : -1}
            />

            <aside className={cn(
                "w-55 h-full app-sidebar flex flex-col overflow-hidden",
                "shadow-[8px_0_32px_rgba(8,20,30,0.45)] relative",
                "fixed inset-y-0 left-0 z-50 transition-transform duration-200 ease-out",
                "lg:static lg:z-10 lg:translate-x-0 lg:shrink-0",
                open ? "translate-x-0" : "-translate-x-full"
            )}>
                {/* Logo */}
                <div className="px-3 py-3 border-b border-white/7 relative z-1 flex items-center gap-2 bg-linear-to-r from-[rgba(56,182,255,0.08)] via-transparent to-blue-600/5 min-h-19">
                    <Link
                        href="/dashboard"
                        onClick={() => onClose?.()}
                        className="flex-1 flex items-center justify-start min-w-0 min-h-16 px-1"
                    >
                        <DocuGemmaLogo size="md" />
                    </Link>
                    <button type="button" onClick={onClose}
                        className="lg:hidden rounded-lg p-2 min-h-9 min-w-9 flex items-center justify-center shrink-0 text-slate-400 hover:text-white hover:bg-white/10 transition-colors"
                        aria-label="Close menu">
                        <X size={16} />
                    </button>
                </div>

                {/* Navigation */}
                <nav className="flex-1 px-3 py-3 space-y-0.5 overflow-y-auto relative z-1">
                    {visibleNav.map(({ href, label }) => {
                        const active =
                            pathname === href ||
                            pathname?.startsWith(`${href}/`) ||
                            (href === "/agents" && (pathname?.startsWith("/agents/") || pathname?.startsWith("/chat")));
                        const showDeptDropdown = href === "/documents" && canSeeDepts && departments.length > 0;

                        return (
                            <div key={href}>
                                <div className="flex items-center gap-1">
                                    <Link
                                        href={href}
                                        prefetch
                                        onClick={() => onClose?.()}
                                        onMouseEnter={() => {
                                            try {
                                                router.prefetch(href);
                                            } catch {
                                                /* ignore */
                                            }
                                        }}
                                        className={cn("sidebar-nav-item flex-1", active && !pathname?.startsWith("/departments/") ? "active" : "")}>
                                        {label}
                                    </Link>
                                    {showDeptDropdown && (
                                        <button type="button" onClick={() => setDeptOpen((o) => !o)}
                                            className="p-1.5 rounded-lg min-h-8 min-w-8 flex items-center justify-center text-slate-400 hover:text-white hover:bg-white/10 transition-colors"
                                            aria-label="Toggle departments">
                                            <ChevronDown size={14} className={cn("transition-transform", deptOpen ? "rotate-180" : "")} />
                                        </button>
                                    )}
                                </div>
                                {showDeptDropdown && deptOpen && (
                                    <div className="ml-4 pl-3 border-l border-white/6 space-y-0.5 mb-1 mt-0.5">
                                        {departments.map((d) => {
                                            const dActive = pathname === `/departments/${d.departmentId}`;
                                            return (
                                                <Link key={d.departmentId} href={`/departments/${d.departmentId}`} onClick={() => onClose?.()}
                                                    className={cn("flex items-center gap-2 px-2.5 py-1.5 rounded-md text-[11px] font-medium text-slate-400 hover:text-white hover:bg-white/5 transition-colors", dActive && "text-(--vb-blue-bright) bg-[rgba(56,182,255,0.1)]")}>
                                                    <Building2 size={11} className="shrink-0 opacity-60" />
                                                    <span className="truncate">{d.name}</span>
                                                </Link>
                                            );
                                        })}
                                    </div>
                                )}
                            </div>
                        );
                    })}
                </nav>

                {/* Bottom */}
                <div className="px-3 py-3 border-t border-white/6 space-y-0.5 relative z-1">
                    <Link href="/profile" onClick={() => onClose?.()}
                        className={cn("sidebar-nav-item w-full", pathname === "/profile" ? "active" : "")}>
                        <span className={cn("sidebar-icon", pathname === "/profile" ? "active" : "inactive")}>
                            <User size={14} />
                        </span>
                        Profile
                    </Link>
                    <button type="button" onClick={logout}
                        className="w-full flex items-center gap-2.5 px-3 py-2 rounded-xl text-[13px] font-medium text-rose-400/80 hover:text-rose-400 hover:bg-rose-500/10 transition-colors min-h-10">
                        <LogOut size={14} />
                        Sign out
                    </button>
                </div>
            </aside>
        </>
    );
}

export default function Sidebar(props: SidebarProps) {
    return (
        <Suspense fallback={null}>
            <SidebarContent {...props} />
        </Suspense>
    );
}
