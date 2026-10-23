import type { ChatVisualSpec } from "@/types/chatVisuals";

function escapeCsvCell(value: string | number): string {
    const s = String(value);
    if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
    return s;
}

/** Export all chart series to a single CSV (one section per chart). */
export function downloadVisualsCsv(visuals: ChatVisualSpec[], filename = "analytics-export.csv") {
    const lines: string[] = [];
    for (const spec of visuals) {
        lines.push(`# ${spec.title}`);
        const metricKey = spec.series[0]?.key;
        if (!metricKey) continue;
        const cat = spec.categoryKey;
        lines.push([cat, metricKey, "document_ids"].map(escapeCsvCell).join(","));
        for (const row of spec.data) {
            const ids = row._documentIds != null ? String(row._documentIds) : "";
            lines.push(
                [row[cat] ?? "", row[metricKey] ?? "", ids].map((c) => escapeCsvCell(c as string | number)).join(",")
            );
        }
        lines.push("");
    }
    const blob = new Blob([lines.join("\n")], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
}

export function parseRowDocumentIds(row: Record<string, string | number>): string[] {
    const raw = row._documentIds;
    if (raw == null || raw === "") return [];
    return String(raw)
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
}
