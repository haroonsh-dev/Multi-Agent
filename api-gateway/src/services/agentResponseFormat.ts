/**
 * Shared ChatGPT-style markdown helpers for agent chat responses.
 * Plain text labels only — no emoji.
 */

const EMOJI_RE =
    /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE00}-\u{FE0F}\u{200D}\u{20E3}\u{E0020}-\u{E007F}]/gu;

export function stripEmojis(text: string): string {
    return text.replace(EMOJI_RE, '');
}

export function formatAgentHeading(title: string, level: 2 | 3 = 2): string {
    const hashes = level === 2 ? '##' : '###';
    return `${hashes} ${stripEmojis(title).replace(/\s+/g, ' ').trim()}`;
}

export function formatAgentDivider(): string {
    return '---';
}

export function formatLabeledBullets(pairs: Array<{ label: string; value: string }>): string {
    return pairs
        .filter((p) => p.value && p.value.trim())
        .map((p) => `- **${p.label}:** ${p.value.trim()}`)
        .join('\n');
}

export function formatSection(title: string, body: string): string {
    const trimmed = body.trim();
    if (!trimmed) return '';
    return `**${title}**\n\n${trimmed}`;
}

export function formatSkillCategoryBullet(raw: string): string {
    const trimmed = raw.trim();
    const colonIdx = trimmed.indexOf(':');
    if (colonIdx > 0 && colonIdx < 48) {
        const label = trimmed.slice(0, colonIdx).trim();
        const detail = trimmed.slice(colonIdx + 1).trim();
        if (detail) return `- **${label}:** ${detail}`;
    }
    return `- ${trimmed}`;
}

export function parseSkillBullets(skills: string[]): string[] {
    if (!skills.length) return [];
    const flat = skills.join(', ').trim();
    if (!flat) return [];

    const categorized = flat.split(/,\s*(?=[A-Za-z][A-Za-z0-9\s/&-]{0,36}:)/).map((s) => s.trim());
    if (categorized.length > 1) return categorized.slice(0, 10);

    if (skills.length > 1) return skills.slice(0, 12);

    if (flat.length > 120) {
        return flat
            .split(/,\s+/)
            .map((s) => s.trim())
            .filter(Boolean)
            .slice(0, 8);
    }

    return [flat];
}

export function formatSkillsSection(skills: string[]): string {
    const bullets = parseSkillBullets(skills);
    if (!bullets.length) return '';
    return ['**Key skills**', '', ...bullets.map(formatSkillCategoryBullet)].join('\n');
}

export function formatStatusLabel(status: string): string {
    const s = stripEmojis(status).replace(/_/g, ' ').trim();
    if (!s) return 'Unknown';
    return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
}

export function formatRiskLabel(level: string): string {
    const u = level.toUpperCase();
    if (u === 'HIGH') return 'High';
    if (u === 'MEDIUM') return 'Medium';
    if (u === 'LOW') return 'Low';
    return formatStatusLabel(level);
}

export function formatMoney(amount: number, currency = 'USD'): string {
    if (!Number.isFinite(amount)) return '—';
    const code = String(currency || 'USD')
        .toUpperCase()
        .replace(/₹/g, 'PKR')
        .replace(/INR/g, 'PKR')
        .replace(/[^A-Z]/g, '')
        .slice(0, 3) || 'USD';
    return `${code} ${amount.toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
}

export function formatDate(d: Date | null | undefined): string {
    if (!d || Number.isNaN(d.getTime())) return 'Not specified';
    return d.toISOString().slice(0, 10);
}

export function formatAgentIntro(lines: string[]): string {
    return lines.filter(Boolean).join('\n\n');
}

export function formatAgentFooter(hint: string): string {
    return `\n\n_${hint}_`;
}

export function cleanAgentMarkdown(md: string): string {
    return stripEmojis(md)
        .replace(/[^\S\n]{2,}/g, ' ')
        .replace(/\n{4,}/g, '\n\n\n')
        .trim();
}

type InsightVisual = {
    kind?: string;
    title?: string;
    currency?: string;
    categoryKey?: string;
    series?: Array<{ key: string; label?: string }>;
    data?: Array<Record<string, string | number>>;
};

/** One-line takeaway from chart data — never a generic “Chart for X”. */
export function insightFromVisuals(visuals: InsightVisual[]): string {
    const chart = visuals.find((v) => v.kind !== 'table' && (v.data?.length || 0) > 0 && v.series?.[0]?.key);
    if (!chart?.series?.[0] || !chart.data?.length || !chart.categoryKey) return '';
    const key = chart.series[0].key;
    const numeric = chart.data
        .map((row) => ({
            label: String(row[chart.categoryKey!] ?? '').trim() || 'Unknown',
            value: Number(row[key]),
        }))
        .filter((x) => Number.isFinite(x.value) && x.value !== 0);
    if (!numeric.length) return '';
    const sum = numeric.reduce((acc, x) => acc + x.value, 0);
    if (!sum) return '';
    const top = [...numeric].sort((a, b) => b.value - a.value)[0];
    const pct = Math.round((top.value / sum) * 100);
    const valueLabel = chart.currency ? formatMoney(top.value, chart.currency) : String(top.value);
    const title = (chart.title || 'this chart').replace(/^Accounts payable — /i, '').toLowerCase();
    return `**${top.label}** leads ${title} at **${valueLabel}** (${pct}% of the scoped total).`;
}
