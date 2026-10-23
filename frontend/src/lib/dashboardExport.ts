/** Rich Excel-friendly HTML report for dashboard exports. */

export type ExportDoc = {
    documentId?: string;
    originalFilename?: string;
    mimeType?: string;
    sizeBytes?: number;
    status?: string;
    classification?: string | null;
    departmentId?: string | null;
    departmentName?: string | null;
    visibilityScope?: string | null;
    uploadedBy?: string | null;
    uploaderName?: string | null;
    createdAt?: string;
    updatedAt?: string;
    shareCount?: number;
    isDuplicate?: boolean;
    duplicateCount?: number;
    aiProcessingStatus?: string | null;
    metadata?: { phase3Agent?: string; cvScore?: number } | null;
};

export type ExportOptions = {
    title?: string;
    dateFrom?: string;
    dateTo?: string;
    departmentNames?: Record<string, string>;
};

function esc(v: unknown): string {
    return String(v ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
}

function formatBytes(n: number) {
    if (!n || n < 0) return "—";
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(2)} MB`;
    return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function formatDate(iso?: string) {
    if (!iso) return "—";
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return "—";
    return d.toLocaleString("en-GB", {
        year: "numeric",
        month: "short",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
    });
}

function formatDay(iso?: string) {
    if (!iso) return "—";
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return "—";
    return d.toLocaleDateString("en-CA");
}

function displayStatus(doc: ExportDoc): string {
    const s = (doc.status || "").toLowerCase();
    if (["ready", "processed", "completed", "done"].includes(s)) return "Ready";
    if (["processing", "uploaded", "queued"].includes(s)) return "Processing";
    if (s === "failed" || s.includes("fail") || s.includes("error")) return "Failed";
    return doc.status || "Unknown";
}

function statusBucket(doc: ExportDoc): "ready" | "processing" | "failed" | "other" {
    const label = displayStatus(doc);
    if (label === "Ready") return "ready";
    if (label === "Processing") return "processing";
    if (label === "Failed") return "failed";
    return "other";
}

function statusStyle(status: string): string {
    const s = status.toLowerCase();
    if (s === "ready") return "background:#d1fae5;color:#065f46;font-weight:700;";
    if (s === "processing") return "background:#fef3c7;color:#92400e;font-weight:700;";
    if (s === "failed") return "background:#ffe4e6;color:#9f1239;font-weight:700;";
    return "background:#f1f5f9;color:#475569;font-weight:600;";
}

function mimeLabel(mime?: string) {
    if (!mime) return "—";
    if (mime.includes("pdf")) return "PDF";
    if (mime.includes("word") || mime.includes("msword") || mime.includes("officedocument.word"))
        return "Word";
    if (mime.includes("sheet") || mime.includes("excel") || mime.includes("csv")) return "Spreadsheet";
    if (mime.includes("image")) return "Image";
    if (mime.includes("text")) return "Text";
    return mime.split("/").pop()?.toUpperCase() || mime;
}

function agentLabel(id?: string | null) {
    if (!id) return "—";
    return id
        .replace(/_agent$/, "")
        .replace(/_/g, " ")
        .replace(/\b\w/g, (c) => c.toUpperCase());
}

function filterDocsByDate(docs: ExportDoc[], from?: string, to?: string) {
    if (!from && !to) return docs;
    return docs.filter((d) => {
        if (!d.createdAt) return false;
        const t = new Date(d.createdAt).getTime();
        if (from) {
            const f = new Date(from);
            f.setHours(0, 0, 0, 0);
            if (t < f.getTime()) return false;
        }
        if (to) {
            const end = new Date(to);
            end.setHours(23, 59, 59, 999);
            if (t > end.getTime()) return false;
        }
        return true;
    });
}

function deptName(doc: ExportDoc, map?: Record<string, string>) {
    if (doc.departmentName) return doc.departmentName;
    const id = doc.departmentId;
    if (!id) return "Unassigned";
    if (map?.[id]) return map[id];
    return id;
}

function th(cells: string[]) {
    return `<tr>${cells.map((c) => `<th>${esc(c)}</th>`).join("")}</tr>`;
}

function td(value: unknown, extraStyle = "", align: "left" | "center" | "right" = "left") {
    return `<td style="text-align:${align};${extraStyle}">${esc(value)}</td>`;
}

function dataRow(cells: { v: unknown; style?: string; align?: "left" | "center" | "right" }[], alt = false) {
    return `<tr class="${alt ? "alt" : ""}">${cells
        .map((c) => td(c.v, c.style || "", c.align || "left"))
        .join("")}</tr>`;
}

function sectionBlock(title: string, subtitle: string, inner: string) {
    return `
  <div class="block">
    <div class="block-head">
      <div class="block-title">${esc(title)}</div>
      <div class="block-sub">${esc(subtitle)}</div>
    </div>
    <table class="grid">${inner}</table>
  </div>`;
}

function kpiCard(label: string, value: unknown, accent: string) {
    return `
    <td class="kpi" style="border-top:6px solid ${accent};">
      <div class="kpi-label">${esc(label)}</div>
      <div class="kpi-value" style="color:${accent};">${esc(value)}</div>
    </td>`;
}

export function buildDashboardReportHtml(docs: ExportDoc[], options: ExportOptions = {}) {
    const filtered = filterDocsByDate(docs, options.dateFrom, options.dateTo);
    const title = options.title || "Visibility Docs — Dashboard Report";
    const generatedAt = new Date().toLocaleString();
    const rangeLabel =
        options.dateFrom || options.dateTo
            ? `${options.dateFrom || "start"} → ${options.dateTo || "today"}`
            : "All time";

    const total = filtered.length;
    const ready = filtered.filter((d) => statusBucket(d) === "ready").length;
    const processing = filtered.filter((d) => statusBucket(d) === "processing").length;
    const failed = filtered.filter((d) => statusBucket(d) === "failed").length;
    const totalBytes = filtered.reduce((s, d) => s + (Number(d.sizeBytes) || 0), 0);
    const scored = filtered.filter((d) => d.metadata?.cvScore != null);
    const avgScore =
        scored.length > 0
            ? (
                  scored.reduce((s, d) => s + Number(d.metadata?.cvScore || 0), 0) / scored.length
              ).toFixed(1)
            : "—";
    const duplicates = filtered.filter((d) => d.isDuplicate || (d.duplicateCount || 0) > 1).length;
    const successRate = total ? `${Math.round((ready / total) * 100)}%` : "—";

    const byDay: Record<
        string,
        { uploads: number; ready: number; processing: number; failed: number; bytes: number }
    > = {};
    for (const d of filtered) {
        const day = formatDay(d.createdAt);
        if (!byDay[day]) byDay[day] = { uploads: 0, ready: 0, processing: 0, failed: 0, bytes: 0 };
        byDay[day].uploads += 1;
        const bucket = statusBucket(d);
        if (bucket === "ready") byDay[day].ready += 1;
        else if (bucket === "failed") byDay[day].failed += 1;
        else byDay[day].processing += 1;
        byDay[day].bytes += Number(d.sizeBytes) || 0;
    }
    const dayRows = Object.entries(byDay).sort(([a], [b]) => a.localeCompare(b));

    const byDept: Record<
        string,
        { count: number; ready: number; processing: number; failed: number; bytes: number }
    > = {};
    for (const d of filtered) {
        const name = deptName(d, options.departmentNames);
        if (!byDept[name]) byDept[name] = { count: 0, ready: 0, processing: 0, failed: 0, bytes: 0 };
        byDept[name].count += 1;
        const b = statusBucket(d);
        if (b !== "other") byDept[name][b] += 1;
        byDept[name].bytes += Number(d.sizeBytes) || 0;
    }
    const deptRows = Object.entries(byDept).sort((a, b) => b[1].count - a[1].count);

    const byType: Record<string, number> = {};
    for (const d of filtered) {
        const t = (d.classification || "Unclassified").replace(/_/g, " ");
        byType[t] = (byType[t] || 0) + 1;
    }
    const typeRows = Object.entries(byType).sort((a, b) => b[1] - a[1]);

    const byAgent: Record<string, number> = {};
    for (const d of filtered) {
        const a = agentLabel(d.metadata?.phase3Agent);
        byAgent[a] = (byAgent[a] || 0) + 1;
    }
    const agentRows = Object.entries(byAgent).sort((a, b) => b[1] - a[1]);

    const byMime: Record<string, number> = {};
    for (const d of filtered) {
        const m = mimeLabel(d.mimeType);
        byMime[m] = (byMime[m] || 0) + 1;
    }
    const mimeRows = Object.entries(byMime).sort((a, b) => b[1] - a[1]);

    const fileHeaders = [
        "#",
        "Filename",
        "Status",
        "Type",
        "AI Agent",
        "Score",
        "Format",
        "Size",
        "Department",
        "Visibility",
        "Uploaded",
    ];

    const fileBody = filtered
        .slice()
        .sort((a, b) => new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime())
        .map((d, i) => {
            const st = displayStatus(d);
            return dataRow(
                [
                    { v: i + 1, align: "center" },
                    { v: d.originalFilename || "—", style: "font-weight:600;" },
                    { v: st, style: statusStyle(st), align: "center" },
                    { v: (d.classification || "—").toString().replace(/_/g, " ") },
                    { v: agentLabel(d.metadata?.phase3Agent) },
                    {
                        v: d.metadata?.cvScore != null ? d.metadata.cvScore : "—",
                        align: "center",
                        style: "font-weight:700;",
                    },
                    { v: mimeLabel(d.mimeType), align: "center" },
                    { v: formatBytes(Number(d.sizeBytes) || 0), align: "right" },
                    { v: deptName(d, options.departmentNames) },
                    { v: d.visibilityScope || "—", align: "center" },
                    { v: formatDate(d.createdAt) },
                ],
                i % 2 === 1
            );
        })
        .join("");

    const dayBody = dayRows.length
        ? dayRows
              .map(([day, s], i) =>
                  dataRow(
                      [
                          { v: day, style: "font-weight:600;" },
                          { v: s.uploads, align: "center", style: "font-weight:700;" },
                          { v: s.ready, align: "center", style: statusStyle("Ready") },
                          { v: s.processing, align: "center", style: statusStyle("Processing") },
                          { v: s.failed, align: "center", style: statusStyle("Failed") },
                          { v: formatBytes(s.bytes), align: "right" },
                      ],
                      i % 2 === 1
                  )
              )
              .join("")
        : dataRow([{ v: "No upload activity in this range" }]);

    const deptBody = deptRows.length
        ? deptRows
              .map(([name, s], i) =>
                  dataRow(
                      [
                          { v: name, style: "font-weight:600;" },
                          { v: s.count, align: "center", style: "font-weight:700;" },
                          { v: s.ready, align: "center", style: statusStyle("Ready") },
                          { v: s.processing, align: "center", style: statusStyle("Processing") },
                          { v: s.failed, align: "center", style: statusStyle("Failed") },
                          {
                              v: total ? `${Math.round((s.count / total) * 100)}%` : "0%",
                              align: "center",
                          },
                          { v: formatBytes(s.bytes), align: "right" },
                      ],
                      i % 2 === 1
                  )
              )
              .join("")
        : dataRow([{ v: "No department data" }]);

    const shareBody = (rows: [string, number][]) =>
        rows.length
            ? rows
                  .map(([name, count], i) =>
                      dataRow(
                          [
                              { v: name, style: "font-weight:600;" },
                              { v: count, align: "center", style: "font-weight:700;" },
                              {
                                  v: total ? `${Math.round((count / total) * 100)}%` : "0%",
                                  align: "center",
                              },
                          ],
                          i % 2 === 1
                      )
                  )
                  .join("")
            : dataRow([{ v: "—" }]);

    return `<!DOCTYPE html>
<html xmlns:o="urn:schemas-microsoft-com:office:office"
      xmlns:x="urn:schemas-microsoft-com:office:excel">
<head>
<meta charset="UTF-8" />
<!--[if gte mso 9]><xml><x:ExcelWorkbook><x:ExcelWorksheets>
<x:ExcelWorksheet><x:Name>Dashboard Report</x:Name>
<x:WorksheetOptions><x:DisplayGridlines/></x:WorksheetOptions>
</x:ExcelWorksheet></x:ExcelWorksheets></x:ExcelWorkbook></xml><![endif]-->
<style>
  * { box-sizing: border-box; }
  body {
    font-family: "Segoe UI", Calibri, Arial, sans-serif;
    color: #0f172a;
    background: #f1f5f9;
    margin: 0;
    padding: 28px;
    font-size: 14px;
    line-height: 1.45;
  }
  .cover {
    background: linear-gradient(135deg, #2499e0 0%, #0891b2 100%);
    color: #fff;
    padding: 28px 32px;
    border-radius: 16px;
    margin-bottom: 22px;
  }
  .brand {
    font-size: 13px;
    font-weight: 700;
    letter-spacing: 0.12em;
    text-transform: uppercase;
    opacity: 0.85;
    margin-bottom: 8px;
  }
  .cover h1 {
    margin: 0;
    font-size: 28px;
    font-weight: 800;
    letter-spacing: -0.02em;
  }
  .cover-meta {
    margin-top: 14px;
    font-size: 14px;
    opacity: 0.95;
  }
  .cover-meta span {
    display: inline-block;
    margin-right: 18px;
    background: rgba(255,255,255,0.15);
    padding: 6px 12px;
    border-radius: 999px;
    font-weight: 600;
  }
  .block {
    background: #fff;
    border: 1px solid #e2e8f0;
    border-radius: 14px;
    padding: 18px 18px 8px;
    margin-bottom: 20px;
    box-shadow: 0 1px 2px rgba(15,23,42,0.04);
  }
  .block-head { margin-bottom: 14px; padding: 0 4px; }
  .block-title {
    font-size: 18px;
    font-weight: 800;
    color: #0f172a;
    letter-spacing: -0.01em;
  }
  .block-sub {
    font-size: 13px;
    color: #64748b;
    margin-top: 4px;
  }
  table.grid {
    border-collapse: collapse;
    width: 100%;
  }
  table.grid th {
    background: #2499e0;
    color: #fff;
    font-weight: 700;
    font-size: 13px;
    text-align: left;
    padding: 12px 14px;
    border: 1px solid #38b6ff;
    white-space: nowrap;
  }
  table.grid td {
    padding: 11px 14px;
    border: 1px solid #e2e8f0;
    font-size: 14px;
    vertical-align: middle;
    color: #1e293b;
  }
  table.grid tr.alt td { background: #f8fafc; }
  table.kpis {
    width: 100%;
    border-collapse: separate;
    border-spacing: 12px;
    margin: -4px -12px 8px;
  }
  td.kpi {
    background: #fff;
    border: 1px solid #e2e8f0;
    border-radius: 12px;
    padding: 16px 18px;
    width: 25%;
    vertical-align: top;
  }
  .kpi-label {
    font-size: 12px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: #64748b;
    margin-bottom: 8px;
  }
  .kpi-value {
    font-size: 28px;
    font-weight: 800;
    letter-spacing: -0.03em;
    line-height: 1.1;
  }
  table.facts { width: 100%; border-collapse: collapse; }
  table.facts td {
    padding: 12px 14px;
    border: 1px solid #e2e8f0;
    font-size: 14px;
  }
  table.facts td.fkey {
    width: 40%;
    background: #f8fafc;
    font-weight: 700;
    color: #334155;
  }
  table.facts td.fval {
    font-weight: 600;
    color: #0f172a;
  }
  .footer {
    margin-top: 8px;
    color: #94a3b8;
    font-size: 12px;
    text-align: center;
  }
</style>
</head>
<body>
  <div class="cover">
    <div class="brand">Visibility Docs AI</div>
    <h1>${esc(title)}</h1>
    <div class="cover-meta">
      <span>Generated ${esc(generatedAt)}</span>
      <span>Range: ${esc(rangeLabel)}</span>
      <span>${total} files</span>
    </div>
  </div>

  <div class="block">
    <div class="block-head">
      <div class="block-title">Overview</div>
      <div class="block-sub">Key numbers for this report</div>
    </div>
    <table class="kpis">
      <tr>
        ${kpiCard("Total Documents", total, "#2499e0")}
        ${kpiCard("Ready", ready, "#059669")}
        ${kpiCard("Processing", processing, "#d97706")}
        ${kpiCard("Failed", failed, "#e11d48")}
      </tr>
      <tr>
        ${kpiCard("Success Rate", successRate, "#0891b2")}
        ${kpiCard("Total Storage", formatBytes(totalBytes), "#0e7490")}
        ${kpiCard("Avg CV Score", avgScore, "#7c3aed")}
        ${kpiCard("Duplicates", duplicates, "#475569")}
      </tr>
    </table>
    <table class="facts">
      <tr>
        <td class="fkey">Date range</td>
        <td class="fval">${esc(rangeLabel)}</td>
        <td class="fkey">Departments</td>
        <td class="fval">${deptRows.length}</td>
      </tr>
      <tr>
        <td class="fkey">Document types</td>
        <td class="fval">${typeRows.length}</td>
        <td class="fkey">Scored documents</td>
        <td class="fval">${scored.length}</td>
      </tr>
    </table>
  </div>

  ${sectionBlock(
      "Uploads by Day",
      "Daily activity with status mix and storage",
      `${th(["Date", "Uploads", "Ready", "Processing", "Failed", "Total Size"])}${dayBody}`
  )}

  ${sectionBlock(
      "Documents by Department",
      "Where files sit and how they are processing",
      `${th(["Department", "Documents", "Ready", "Processing", "Failed", "Share %", "Total Size"])}${deptBody}`
  )}

  <table style="width:100%;border-collapse:separate;border-spacing:12px 0;margin:0 -12px 8px;">
    <tr>
      <td style="width:33%;vertical-align:top;padding:0;">
        ${sectionBlock(
            "Document Types",
            "Classification mix",
            `${th(["Type", "Count", "Share"])}${shareBody(typeRows)}`
        )}
      </td>
      <td style="width:33%;vertical-align:top;padding:0;">
        ${sectionBlock(
            "AI Agents",
            "Agent assignment mix",
            `${th(["Agent", "Count", "Share"])}${shareBody(agentRows)}`
        )}
      </td>
      <td style="width:34%;vertical-align:top;padding:0;">
        ${sectionBlock(
            "File Formats",
            "PDF, Word, images…",
            `${th(["Format", "Count", "Share"])}${shareBody(mimeRows)}`
        )}
      </td>
    </tr>
  </table>

  ${sectionBlock(
      "Full File List",
      `${total} file(s) · newest first · status cells are color-coded`,
      `${th(fileHeaders)}${fileBody || dataRow([{ v: "No files in this range" }])}`
  )}

  <div class="footer">Visibility Docs AI · Dashboard export · Open in Excel / Google Sheets for filters</div>
</body>
</html>`;
}

export function downloadDashboardReport(
    docs: ExportDoc[],
    options: ExportOptions & { filename?: string } = {}
) {
    const html = buildDashboardReportHtml(docs, options);
    const blob = new Blob(["\ufeff", html], { type: "application/vnd.ms-excel;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    const stamp = new Date().toISOString().slice(0, 10);
    const from = options.dateFrom || "all";
    const to = options.dateTo || "all";
    a.download =
        options.filename || `visibility-dashboard-report_${from}_${to}_${stamp}.xls`;
    a.click();
    URL.revokeObjectURL(url);
}
