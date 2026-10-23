import Organization from '../models/Organization';

export type OrgFinanceSettings = {
    baseCurrency?: string;
    /** Map typo/alias → canonical vendor label (e.g. glectronic → Digilog). */
    vendorAliases?: Record<string, string>;
    /** Map typo/alias → canonical client label. */
    clientAliases?: Record<string, string>;
    /** 1–12; 1 = calendar year. */
    fyStartMonth?: number;
    /** ISO currency code → units per 1 baseCurrency (e.g. USD: 280 for PKR base). */
    fxRates?: Record<string, number>;
};

const cache = new Map<string, { settings: OrgFinanceSettings; at: number }>();
const CACHE_MS = 5 * 60 * 1000;

export async function getOrgFinanceSettings(
    organizationId: string | null | undefined
): Promise<OrgFinanceSettings> {
    if (!organizationId) return {};
    const hit = cache.get(organizationId);
    if (hit && Date.now() - hit.at < CACHE_MS) return hit.settings;

    try {
        const org = await Organization.findOne({ organizationId })
            .select('financeSettings')
            .lean();
        const raw = (org as { financeSettings?: OrgFinanceSettings } | null)?.financeSettings;
        const settings: OrgFinanceSettings = {
            baseCurrency: raw?.baseCurrency?.toUpperCase().slice(0, 3),
            vendorAliases: normalizeAliases(raw?.vendorAliases),
            clientAliases: normalizeAliases(raw?.clientAliases),
            fyStartMonth: normalizeFyStart(raw?.fyStartMonth),
            fxRates: normalizeFxRates(raw?.fxRates),
        };
        cache.set(organizationId, { settings, at: Date.now() });
        return settings;
    } catch {
        return {};
    }
}

export function clearOrgFinanceSettingsCache(organizationId?: string) {
    if (organizationId) cache.delete(organizationId);
    else cache.clear();
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

function normalizeFyStart(raw: unknown): number | undefined {
    const n = Number(raw);
    if (!Number.isFinite(n)) return undefined;
    const m = Math.round(n);
    return m >= 1 && m <= 12 ? m : undefined;
}

function normalizeFxRates(raw: unknown): Record<string, number> | undefined {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
    const out: Record<string, number> = {};
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
        const key = String(k).trim().toUpperCase().slice(0, 3);
        const rate = Number(v);
        if (!key || !Number.isFinite(rate) || rate <= 0) continue;
        out[key] = rate;
        if (Object.keys(out).length >= 50) break;
    }
    return Object.keys(out).length ? out : undefined;
}

export async function updateOrgFinanceSettings(
    organizationId: string,
    patch: OrgFinanceSettings
): Promise<OrgFinanceSettings> {
    const update: Record<string, unknown> = {};
    if (patch.baseCurrency !== undefined) {
        update['financeSettings.baseCurrency'] = patch.baseCurrency?.trim().toUpperCase().slice(0, 3) || null;
    }
    if (patch.vendorAliases !== undefined) {
        update['financeSettings.vendorAliases'] = normalizeAliases(patch.vendorAliases) ?? null;
    }
    if (patch.clientAliases !== undefined) {
        update['financeSettings.clientAliases'] = normalizeAliases(patch.clientAliases) ?? null;
    }
    if (patch.fyStartMonth !== undefined) {
        update['financeSettings.fyStartMonth'] = normalizeFyStart(patch.fyStartMonth) ?? null;
    }
    if (patch.fxRates !== undefined) {
        update['financeSettings.fxRates'] = normalizeFxRates(patch.fxRates) ?? null;
    }

    await Organization.findOneAndUpdate({ organizationId }, { $set: update }, { new: true });
    clearOrgFinanceSettingsCache(organizationId);
    return getOrgFinanceSettings(organizationId);
}

/** Convert `amount` in `from` currency into `baseCurrency` using org fxRates.
 *  Returns { amount: base, converted: true|false, rate }. */
export function convertToBaseCurrency(
    amount: number,
    from: string,
    settings: OrgFinanceSettings,
): { amount: number; converted: boolean; rate: number | null } {
    const base = settings.baseCurrency;
    const src = (from || '').toUpperCase();
    if (!base || !src || src === base) return { amount, converted: false, rate: null };
    const rate = settings.fxRates?.[src];
    if (!rate || rate <= 0) return { amount, converted: false, rate: null };
    // fxRates convention: units of src per 1 base. So base = src / rate.
    return { amount: amount / rate, converted: true, rate };
}
