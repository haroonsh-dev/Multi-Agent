/** Normalize typos / casual phrasing before finance intent + name-token routing. */
export function normalizeFinanceUserQuestion(question: string): string {
    return question
        .toLowerCase()
        .replace(/\bclietns?\b/g, 'clients')
        .replace(/\bcleints?\b/g, 'clients')
        .replace(/\bvenodrs?\b/g, 'vendors')
        .replace(/\bcustmers?\b/g, 'customers');
}

/** User wants a full list across the library — not one named file. */
export function wantsFinanceListAllScope(question: string): boolean {
    if (/\b[a-z0-9][a-z0-9._-]{1,120}\.(?:xlsx?|xls|csv|tsv|ods|pdf)\b/i.test(question)) {
        return false;
    }
    const q = normalizeFinanceUserQuestion(question);
    if (/\b(all|every|full|entire)\b/.test(q) && /\b(lists?|listings?)\b/.test(q)) {
        return true;
    }
    if (/\b(all|every|full)\s+(clients?|customers?|vendors?|suppliers?)\b/.test(q)) {
        return true;
    }
    if (/\b(clients?|customers?|vendors?)\s+(lists?|listings?)\b/.test(q)) {
        return true;
    }
    return false;
}

/** Trend / aging charts need dates + amounts across invoices — use library scope, not one file. */
export function wantsFinanceMultiDocCharts(question: string): boolean {
    const q = normalizeFinanceUserQuestion(question);
    if (/\b(aging|overdue|outstanding)\b/.test(q)) return true;
    if (/\b(trend|monthly|by month|per month|over time|timeline|history)\b/.test(q)) {
        return /\b(chart|graph|visual|invoice|spend|volume|trend)\b/.test(q) || /\bby month\b/.test(q);
    }
    return false;
}
