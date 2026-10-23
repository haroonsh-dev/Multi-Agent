import Organization from '../models/Organization';

export type OrgComplianceSettings = {
    /** Days before expiry to flag EXPIRING_SOON (default 90). */
    expiryWarningDays?: number;
    /** Document types expected in a complete compliance packet. */
    requiredDocTypes?: string[];
    /** Map free-text severity → CRITICAL|MAJOR|MINOR|OBSERVATION. */
    severityAliases?: Record<string, string>;
    /** Map alias standard names → canonical label (e.g. iso9001 → ISO 9001:2015). */
    standardAliases?: Record<string, string>;
};

const DEFAULT_REQUIRED = [
    'certificate',
    'audit_report',
    'sop',
    'inspection_report',
    'regulatory_document',
];

const cache = new Map<string, { settings: OrgComplianceSettings; at: number }>();
const CACHE_MS = 5 * 60 * 1000;

export function defaultComplianceSettings(): OrgComplianceSettings {
    return {
        expiryWarningDays: 90,
        requiredDocTypes: [...DEFAULT_REQUIRED],
    };
}

export async function getOrgComplianceSettings(
    organizationId: string | null | undefined
): Promise<OrgComplianceSettings> {
    const defaults = defaultComplianceSettings();
    if (!organizationId) return defaults;
    const hit = cache.get(organizationId);
    if (hit && Date.now() - hit.at < CACHE_MS) return { ...defaults, ...hit.settings };

    try {
        const org = await Organization.findOne({ organizationId })
            .select('complianceSettings')
            .lean();
        const raw = (org as { complianceSettings?: OrgComplianceSettings } | null)?.complianceSettings;
        const settings: OrgComplianceSettings = {
            expiryWarningDays: normalizeExpiryDays(raw?.expiryWarningDays) ?? defaults.expiryWarningDays,
            requiredDocTypes: normalizeDocTypes(raw?.requiredDocTypes) ?? defaults.requiredDocTypes,
            severityAliases: normalizeAliases(raw?.severityAliases),
            standardAliases: normalizeAliases(raw?.standardAliases),
        };
        cache.set(organizationId, { settings, at: Date.now() });
        return settings;
    } catch {
        return defaults;
    }
}

export function clearOrgComplianceSettingsCache(organizationId?: string) {
    if (organizationId) cache.delete(organizationId);
    else cache.clear();
}

function normalizeExpiryDays(raw: unknown): number | undefined {
    const n = Number(raw);
    if (!Number.isFinite(n)) return undefined;
    const d = Math.round(n);
    return d >= 7 && d <= 365 ? d : undefined;
}

function normalizeDocTypes(raw: unknown): string[] | undefined {
    if (!Array.isArray(raw)) return undefined;
    const out: string[] = [];
    for (const item of raw) {
        const t = String(item || '')
            .trim()
            .toLowerCase()
            .replace(/\s+/g, '_');
        if (!t || t.length > 64) continue;
        if (!out.includes(t)) out.push(t);
        if (out.length >= 30) break;
    }
    return out.length ? out : undefined;
}

function normalizeAliases(raw: unknown): Record<string, string> | undefined {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
        const key = String(k).trim().toLowerCase();
        const val = String(v ?? '').trim();
        if (!key || !val || key.length > 80 || val.length > 120) continue;
        out[key] = val;
        if (Object.keys(out).length >= 100) break;
    }
    return Object.keys(out).length ? out : undefined;
}

export async function updateOrgComplianceSettings(
    organizationId: string,
    patch: OrgComplianceSettings
): Promise<OrgComplianceSettings> {
    const update: Record<string, unknown> = {};
    if (patch.expiryWarningDays !== undefined) {
        update['complianceSettings.expiryWarningDays'] =
            normalizeExpiryDays(patch.expiryWarningDays) ?? null;
    }
    if (patch.requiredDocTypes !== undefined) {
        update['complianceSettings.requiredDocTypes'] =
            normalizeDocTypes(patch.requiredDocTypes) ?? null;
    }
    if (patch.severityAliases !== undefined) {
        update['complianceSettings.severityAliases'] =
            normalizeAliases(patch.severityAliases) ?? null;
    }
    if (patch.standardAliases !== undefined) {
        update['complianceSettings.standardAliases'] =
            normalizeAliases(patch.standardAliases) ?? null;
    }
    if (Object.keys(update).length) {
        await Organization.updateOne({ organizationId }, { $set: update });
        clearOrgComplianceSettingsCache(organizationId);
    }
    return getOrgComplianceSettings(organizationId);
}
