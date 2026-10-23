import { getAuthValue, getStoredUser } from "./authSession";

export const PERMS = {
    UPLOAD: "document.upload",
    VIEW: "document.view",
    DELETE: "document.delete",
    PREVIEW: "document.preview",
    SHARE: "document.share",
    CHAT: "chat.use",
    DEPT_VIEW: "department.view",
    DEPT_MANAGE: "department.manage",
    ORG_DOCS_VIEW: "org.documents.view",
    PAGE_DASHBOARD: "page.dashboard",
    PAGE_DOCUMENTS: "page.documents",
    PAGE_CHAT: "page.chat",
    PAGE_ACTIVITY: "page.activity",
    PAGE_DEPARTMENTS: "page.departments",
    PAGE_PLANS: "page.plans",
    PAGE_EMAIL_REPORTS: "page.email_reports",
    PAGE_INTEGRATIONS: "page.integrations",
    PAGE_SETTINGS: "page.settings",
} as const;

export type PageAccessKey =
    | "dashboard"
    | "documents"
    | "chat"
    | "activity"
    | "departments"
    | "plans"
    | "email_reports"
    | "integrations"
    | "settings";

export const PAGE_PERM_BY_KEY: Record<PageAccessKey, string> = {
    dashboard: PERMS.PAGE_DASHBOARD,
    documents: PERMS.PAGE_DOCUMENTS,
    chat: PERMS.PAGE_CHAT,
    activity: PERMS.PAGE_ACTIVITY,
    departments: PERMS.PAGE_DEPARTMENTS,
    plans: PERMS.PAGE_PLANS,
    email_reports: PERMS.PAGE_EMAIL_REPORTS,
    integrations: PERMS.PAGE_INTEGRATIONS,
    settings: PERMS.PAGE_SETTINGS,
};

/** Permissions editable for team members (shown in Team UI). */
export const TEAM_PERM_LABELS: { key: string; label: string; hint?: string }[] = [
    { key: PERMS.UPLOAD, label: "Upload", hint: "Add files to the library" },
    { key: PERMS.VIEW, label: "View", hint: "Browse, details, and preview files" },
    { key: PERMS.DELETE, label: "Delete", hint: "Remove documents" },
    { key: PERMS.CHAT, label: "Chat", hint: "Ask AI about documents" },
];

/** Default flags for new team members (matches api-gateway defaults). */
export const DEFAULT_TEAM_PERMS: Record<string, boolean> = {
    [PERMS.UPLOAD]: true,
    [PERMS.VIEW]: true,
    [PERMS.DELETE]: true,
    [PERMS.PREVIEW]: true,
    [PERMS.SHARE]: false,
    [PERMS.CHAT]: true,
    [PERMS.DEPT_VIEW]: true,
    [PERMS.DEPT_MANAGE]: false,
    [PERMS.ORG_DOCS_VIEW]: false,
    [PERMS.PAGE_DASHBOARD]: true,
    [PERMS.PAGE_DOCUMENTS]: true,
    [PERMS.PAGE_CHAT]: true,
    [PERMS.PAGE_ACTIVITY]: false,
    [PERMS.PAGE_DEPARTMENTS]: false,
    [PERMS.PAGE_PLANS]: false,
    [PERMS.PAGE_EMAIL_REPORTS]: false,
    [PERMS.PAGE_INTEGRATIONS]: false,
    [PERMS.PAGE_SETTINGS]: false,
};

export function getUserPermissions(): Record<string, boolean> {
    const user = getStoredUser<{ permissions?: Record<string, boolean>; role?: string }>();
    if (user?.permissions && typeof user.permissions === "object") {
        return user.permissions;
    }
    const raw = getAuthValue("permissions");
    if (!raw) return {};
    try {
        return JSON.parse(raw) as Record<string, boolean>;
    } catch {
        return {};
    }
}

export function getUserRole(): string {
    return getStoredUser<{ role?: string }>()?.role || "team";
}

/** Admins always have full access; team members use stored flags. */
export function hasAppPermission(permission: string): boolean {
    const role = getUserRole();
    if (role === "superAdmin" || role === "admin") return true;
    const perms = getUserPermissions();
    if (permission === PERMS.PREVIEW) {
        return perms[PERMS.PREVIEW] === true || perms[PERMS.VIEW] === true;
    }
    // Legacy users without page.* keys: allow core pages so they are not locked out
    if (
        permission === PERMS.PAGE_DASHBOARD ||
        permission === PERMS.PAGE_DOCUMENTS ||
        permission === PERMS.PAGE_CHAT
    ) {
        if (permission in perms) return perms[permission] === true;
        return true;
    }
    if (
        permission === PERMS.PAGE_ACTIVITY ||
        permission === PERMS.PAGE_DEPARTMENTS ||
        permission === PERMS.PAGE_PLANS ||
        permission === PERMS.PAGE_EMAIL_REPORTS ||
        permission === PERMS.PAGE_INTEGRATIONS ||
        permission === PERMS.PAGE_SETTINGS
    ) {
        if (permission in perms) return perms[permission] === true;
        return false;
    }
    return perms[permission] === true;
}

export function canAccessPage(page: PageAccessKey): boolean {
    return hasAppPermission(PAGE_PERM_BY_KEY[page]);
}

export function canUpload() {
    return hasAppPermission(PERMS.UPLOAD);
}
export function canViewDocs() {
    return hasAppPermission(PERMS.VIEW);
}
export function canDeleteDocs() {
    return hasAppPermission(PERMS.DELETE);
}
export function canChat() {
    return hasAppPermission(PERMS.CHAT);
}
export function canShareDocs() {
    return hasAppPermission(PERMS.SHARE);
}
export function canViewDepartments() {
    return hasAppPermission(PERMS.DEPT_VIEW);
}
export function canManageDepartments() {
    return hasAppPermission(PERMS.DEPT_MANAGE);
}

/** First allowed app path for a team user (fallback profile). */
export function firstAllowedPath(perms?: Record<string, boolean>, role?: string): string {
    const r = role || getUserRole();
    if (r === "superAdmin" || r === "admin") return "/dashboard";
    const p = perms || getUserPermissions();
    const check = (key: string, legacyDefault = false) => {
        if (r === "superAdmin" || r === "admin") return true;
        if (key in p) return p[key] === true;
        return legacyDefault;
    };
    if (check(PERMS.PAGE_DASHBOARD, true)) return "/dashboard";
    if (check(PERMS.PAGE_DOCUMENTS, true)) return "/documents";
    if (check(PERMS.PAGE_CHAT, true)) return "/chat";
    if (check(PERMS.PAGE_ACTIVITY, false)) return "/activity";
    if (check(PERMS.PAGE_PLANS, false)) return "/plans";
    if (check(PERMS.PAGE_EMAIL_REPORTS, false)) return "/admin/email-reports";
    if (check(PERMS.PAGE_INTEGRATIONS, false)) return "/admin/integrations";
    if (check(PERMS.PAGE_SETTINGS, false)) return "/admin/settings";
    return "/profile";
}
