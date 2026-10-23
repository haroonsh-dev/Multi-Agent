/**
 * Canonical keys for vendor/client rollups (Digilog / M/s Digilog Pvt Ltd → same bucket).
 */
export function canonicalizePartyName(name: string): string {
    let s = name.trim().toLowerCase();
    if (!s) return '';
    s = s.replace(/^m\/s\.?\s+/i, '');
    s = s.replace(/^messers?\s+/i, '');
    s = s.replace(/\b(private|pvt|ltd|limited|llc|inc|corp|corporation|plc)\b\.?/gi, ' ');
    s = s.replace(/\b(the)\b/gi, ' ');
    s = s.replace(/[.,'"]/g, ' ');
    s = s.replace(/\s+/g, ' ').trim();
    return s;
}

/** Apply org alias map (e.g. glectronic → digilog) for rollup keys. */
export function partyRollupKey(name: string, aliases?: Record<string, string>): string {
    const c = canonicalizePartyName(name);
    if (!aliases || !c) return c;
    for (const [alias, target] of Object.entries(aliases)) {
        const a = canonicalizePartyName(alias);
        const t = canonicalizePartyName(target);
        if (!a || !t) continue;
        if (c === a || c.includes(a) || a.includes(c)) return t;
    }
    return c;
}

export function resolveVendorDisplayName(
    rawVendor: string,
    aliases?: Record<string, string>
): string {
    if (!rawVendor.trim() || !aliases) return rawVendor.trim() || rawVendor;
    const key = partyRollupKey(rawVendor, aliases);
    for (const [, target] of Object.entries(aliases)) {
        const t = canonicalizePartyName(target);
        if (t && (canonicalizePartyName(target) === key || key.includes(t) || t.includes(key))) {
            return target.trim();
        }
    }
    for (const [alias, target] of Object.entries(aliases)) {
        if (canonicalizePartyName(alias) === canonicalizePartyName(rawVendor)) return target.trim();
    }
    return rawVendor.trim();
}
