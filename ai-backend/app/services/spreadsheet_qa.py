"""
Programmatic spreadsheet / ledger Q&A (pandas).

Used for vendor–client invoice exports so sums, grouping, and invoice
assignment never rely on LLM arithmetic or row inventing.
"""
from __future__ import annotations

import re
from typing import Any, Optional

import pandas as pd

# Canonical column aliases → internal names
_COL_ALIASES: dict[str, tuple[str, ...]] = {
    "vendor_name": ("vendor name", "vendor", "supplier", "supplier name", "seller"),
    "vendor_city": ("vendor city", "supplier city"),
    "client_name": ("client name", "client", "customer", "customer name", "buyer", "bill to"),
    "client_city": ("client city", "customer city", "buyer city"),
    "invoice_no": (
        "invoice no",
        "invoice number",
        "invoice #",
        "inv no",
        "inv#",
        "invoice",
        "inv",
    ),
    "order_date": ("order date", "date", "invoice date"),
    "delivery_date": ("delivery date", "due date"),
    "category": ("category", "product category"),
    "quantity": ("quantity", "qty", "qnty"),
    "unit_price": ("unit price", "unit price (pkr)", "rate", "price"),
    "total_amount": (
        "total amount",
        "total amount (pkr)",
        "amount",
        "line total",
        "net amount",
        "total",
    ),
    "payment_mode": ("payment mode", "payment method", "payment"),
    "status": ("status", "payment status"),
    "remarks": ("remarks", "notes", "comment"),
}


def _norm_header(h: str) -> str:
    return re.sub(r"\s+", " ", (h or "").strip().lower().replace("_", " "))


def _map_columns(df: pd.DataFrame) -> pd.DataFrame:
    rename: dict[str, str] = {}
    used: set[str] = set()
    for col in df.columns:
        nh = _norm_header(str(col))
        for canon, aliases in _COL_ALIASES.items():
            if canon in used:
                continue
            if nh == canon.replace("_", " ") or nh in aliases:
                rename[col] = canon
                used.add(canon)
                break
    out = df.rename(columns=rename)
    return out


def _parse_number(val: Any) -> Optional[float]:
    if val is None or (isinstance(val, float) and pd.isna(val)):
        return None
    if isinstance(val, (int, float)):
        return float(val)
    s = str(val).strip()
    if not s or s in ("-", "—", "nan", "None"):
        return None
    s = s.replace(",", "").replace("PKR", "").replace("Rs", "").replace("rs", "").strip()
    s = re.sub(r"[^\d.\-]", "", s)
    if not s or s in (".", "-", "-."):
        return None
    try:
        return float(s)
    except ValueError:
        return None


def parse_markdown_tables(text: str) -> list[pd.DataFrame]:
    """Extract markdown pipe-tables from OCR / xlsx text."""
    if not text:
        return []
    lines = text.splitlines()
    tables: list[pd.DataFrame] = []
    i = 0
    while i < len(lines):
        line = lines[i].strip()
        if not (line.startswith("|") and line.endswith("|") and line.count("|") >= 3):
            i += 1
            continue
        block = [line]
        i += 1
        while i < len(lines):
            nxt = lines[i].strip()
            if nxt.startswith("|") and nxt.endswith("|"):
                block.append(nxt)
                i += 1
            else:
                break
        if len(block) < 2:
            continue
        # Drop separator row(s)
        data_lines = []
        for idx, row in enumerate(block):
            cells = [c.strip() for c in row.strip("|").split("|")]
            if idx == 1 and all(re.fullmatch(r":?-{3,}:?", c.replace(" ", "")) for c in cells if c):
                continue
            if all(re.fullmatch(r":?-{3,}:?", c.replace(" ", "")) for c in cells if c):
                continue
            data_lines.append(cells)
        if len(data_lines) < 2:
            continue
        header = data_lines[0]
        rows = []
        for cells in data_lines[1:]:
            # Pad / trim to header width
            if len(cells) < len(header):
                cells = cells + [""] * (len(header) - len(cells))
            rows.append(cells[: len(header)])
        try:
            df = pd.DataFrame(rows, columns=header)
            df = _map_columns(df)
            if len(df) > 0:
                tables.append(df)
        except Exception:
            continue
    return tables


def is_invoice_ledger(df: pd.DataFrame) -> bool:
    cols = set(df.columns)
    has_inv = "invoice_no" in cols
    has_party = "client_name" in cols or "vendor_name" in cols
    has_amt = "total_amount" in cols
    return bool(has_inv and has_party and (has_amt or "quantity" in cols))


def _prepare_ledger(df: pd.DataFrame) -> pd.DataFrame:
    out = df.copy()
    if "invoice_no" in out.columns:
        out["invoice_no"] = out["invoice_no"].astype(str).str.strip()
        # Deduplicate by invoice number — keep first occurrence only
        out = out[out["invoice_no"].astype(bool)]
        out = out.drop_duplicates(subset=["invoice_no"], keep="first")
    if "total_amount" in out.columns:
        out["_amount"] = out["total_amount"].map(_parse_number)
    else:
        out["_amount"] = None
    for c in ("vendor_name", "vendor_city", "client_name", "client_city"):
        if c in out.columns:
            out[c] = out[c].astype(str).str.strip()
    return out.reset_index(drop=True)


def _fmt_money(n: float) -> str:
    if n is None or (isinstance(n, float) and pd.isna(n)):
        return "—"
    if abs(n - round(n)) < 1e-9:
        return f"{int(round(n)):,}"
    return f"{n:,.2f}"


def _escape_cell(v: Any) -> str:
    s = "" if v is None or (isinstance(v, float) and pd.isna(v)) else str(v).strip()
    return s.replace("|", "/").replace("\n", " ")


def _df_to_md(df: pd.DataFrame, cols: list[str], money_cols: set[str] | None = None) -> str:
    money_cols = money_cols or set()
    use = [c for c in cols if c in df.columns]
    if not use:
        return ""
    labels = {
        "vendor_name": "Vendor Name",
        "vendor_city": "Vendor City",
        "client_name": "Client Name",
        "client_city": "Client City",
        "invoice_no": "Invoice No",
        "order_date": "Order Date",
        "delivery_date": "Delivery Date",
        "category": "Category",
        "quantity": "Quantity",
        "unit_price": "Unit Price",
        "total_amount": "Total Amount",
        "_amount": "Total Amount",
        "payment_mode": "Payment Mode",
        "status": "Status",
        "subtotal": "Subtotal",
        "invoice_count": "Invoices",
    }
    header = "| " + " | ".join(labels.get(c, c) for c in use) + " |"
    sep = "| " + " | ".join("---" for _ in use) + " |"
    rows = [header, sep]
    for _, r in df.iterrows():
        cells = []
        for c in use:
            val = r.get(c)
            if c in money_cols or c == "_amount":
                num = _parse_number(val) if c != "_amount" else val
                cells.append(_fmt_money(float(num)) if num is not None else _escape_cell(val))
            else:
                cells.append(_escape_cell(val))
        rows.append("| " + " | ".join(cells) + " |")
    return "\n".join(rows)


def _extract_entity_filter(question: str, df: pd.DataFrame) -> pd.DataFrame:
    """Filter rows when question mentions a vendor/client name present in the data."""
    q = (question or "").lower()
    out = df
    for col in ("vendor_name", "client_name"):
        if col not in df.columns:
            continue
        names = sorted(
            {str(x).strip() for x in df[col].dropna().unique() if str(x).strip()},
            key=len,
            reverse=True,
        )
        for name in names:
            if len(name) < 3:
                continue
            if name.lower() in q:
                out = out[out[col].str.lower() == name.lower()]
                break
    # Invoice number pin
    m = re.search(r"\b(INV[-\s]?\d+)\b", question or "", flags=re.I)
    if m and "invoice_no" in out.columns:
        inv = re.sub(r"\s+", "", m.group(1).upper()).replace("INV", "INV-")
        if not inv.startswith("INV-"):
            inv = "INV-" + re.sub(r"^INV-?", "", inv)
        matched = out[out["invoice_no"].str.upper().str.replace(" ", "") == inv]
        if matched.empty:
            matched = out[out["invoice_no"].str.contains(m.group(1), case=False, regex=False)]
        if not matched.empty:
            out = matched
    return out


def _wants_sum(q: str) -> bool:
    return bool(
        re.search(
            r"\b(sum|total|grand total|subtotal|add up|sum up|aggregate|how much|kitna|amount)\b",
            q,
            flags=re.I,
        )
    )


def _wants_group_by_client(q: str) -> bool:
    ql = q.lower()
    if "group" in ql and "client" in ql:
        return True
    if "by client" in ql or "per client" in ql or "each client" in ql:
        return True
    if "client" in ql and any(w in ql for w in ("sum", "total", "breakdown", "report")):
        return True
    return False


def _wants_full_table(q: str) -> bool:
    ql = q.lower()
    return any(
        p in ql
        for p in (
            "all data",
            "all information",
            "full table",
            "all rows",
            "all invoices",
            "entire table",
            "complete data",
            "all vendor",
            "all client",
        )
    )


def answer_ledger_question(question: str, df: pd.DataFrame, source_title: str = "") -> Optional[str]:
    """
    Return a grounded markdown answer using pandas math, or None if not applicable.
    """
    if df is None or df.empty or not is_invoice_ledger(df):
        return None

    ledger = _prepare_ledger(df)
    if ledger.empty:
        return None

    filtered = _extract_entity_filter(question, ledger)
    q = question or ""
    title = source_title or "source spreadsheet"

    detail_cols = [
        c
        for c in (
            "invoice_no",
            "vendor_name",
            "vendor_city",
            "client_name",
            "client_city",
            "order_date",
            "delivery_date",
            "category",
            "quantity",
            "unit_price",
            "total_amount",
            "payment_mode",
            "status",
        )
        if c in filtered.columns
    ]

    # Single invoice lookup
    if re.search(r"\bINV[-\s]?\d+\b", q, flags=re.I) and len(filtered) <= 3:
        table = _df_to_md(filtered, detail_cols, money_cols={"total_amount", "unit_price"})
        return (
            f"From **{title}** (values copied from the source row; no inferred fields):\n\n"
            f"{table}"
        )

    # Group by client name + city
    if _wants_group_by_client(q) and "client_name" in filtered.columns:
        group_cols = ["client_name"]
        if "client_city" in filtered.columns:
            group_cols.append("client_city")
        # Strict row-level mapping: group only by columns on the same row
        work = filtered.copy()
        work["_amount"] = work["_amount"].fillna(0.0)
        # Unique invoices already enforced in _prepare_ledger
        if "invoice_no" in work.columns:
            grouped = (
                work.groupby(group_cols, dropna=False, sort=True)
                .agg(invoice_count=("invoice_no", "nunique"), subtotal=("_amount", "sum"))
                .reset_index()
            )
        else:
            grouped = (
                work.groupby(group_cols, dropna=False, sort=True)
                .agg(invoice_count=("_amount", "count"), subtotal=("_amount", "sum"))
                .reset_index()
            )
        # Deduplicate company/city groups (groupby already unique)
        grouped = grouped.drop_duplicates(subset=group_cols, keep="first")
        grand = float(grouped["subtotal"].sum())
        table = _df_to_md(
            grouped,
            group_cols + ["invoice_count", "subtotal"],
            money_cols={"subtotal"},
        )
        # Also list invoices under each client without cross-posting
        inv_sections = []
        for _, g in grouped.iterrows():
            mask = work["client_name"] == g["client_name"]
            if "client_city" in group_cols:
                mask = mask & (work["client_city"] == g["client_city"])
            rows = work.loc[mask]
            inv_list = ", ".join(sorted({str(x) for x in rows["invoice_no"].tolist()}))
            label = g["client_name"]
            if "client_city" in group_cols:
                label = f"{g['client_name']} ({g['client_city']})"
            inv_sections.append(
                f"- **{label}** — invoices: {inv_list or '—'}; "
                f"subtotal: **{_fmt_money(float(g['subtotal']))}** "
                f"(pandas sum of {_escape_cell(g.get('invoice_count'))} unique invoice(s))"
            )
        return (
            f"Client breakdown from **{title}** "
            f"(grouped by exact Client Name"
            f"{' + Client City' if 'client_city' in group_cols else ''} on each row; "
            f"each invoice counted once; totals via pandas):\n\n"
            f"{table}\n\n"
            f"**Grand total (pandas):** {_fmt_money(grand)}\n\n"
            f"**Invoice assignment (no cross-posting):**\n"
            + "\n".join(inv_sections)
        )

    # Sum / total
    if _wants_sum(q) and filtered["_amount"].notna().any():
        amounts = filtered["_amount"].dropna()
        total = float(amounts.sum())
        count = int(filtered["invoice_no"].nunique()) if "invoice_no" in filtered.columns else len(filtered)
        scope = ""
        if len(filtered) < len(ledger):
            # Describe filter
            bits = []
            if "vendor_name" in filtered.columns and filtered["vendor_name"].nunique() == 1:
                bits.append(f"vendor **{filtered['vendor_name'].iloc[0]}**")
            if "client_name" in filtered.columns and filtered["client_name"].nunique() == 1:
                bits.append(f"client **{filtered['client_name'].iloc[0]}**")
            if bits:
                scope = " for " + " / ".join(bits)
        table = _df_to_md(
            filtered.head(50),
            [c for c in ("invoice_no", "vendor_name", "client_name", "client_city", "total_amount") if c in filtered.columns],
            money_cols={"total_amount"},
        )
        more = ""
        if len(filtered) > 50:
            more = f"\n\n_(Showing first 50 of {len(filtered)} rows; sum uses all {count} unique invoices.)_"
        return (
            f"**Sum{scope}** from **{title}** "
            f"(pandas `sum` over unique invoices — no LLM math):\n\n"
            f"- Unique invoices: **{count}**\n"
            f"- **Total amount: {_fmt_money(total)}**\n\n"
            f"{table}{more}"
        )

    # Vendor / client detail table (filtered)
    if len(filtered) < len(ledger) and len(filtered) > 0:
        table = _df_to_md(filtered, detail_cols, money_cols={"total_amount", "unit_price"})
        total = float(filtered["_amount"].dropna().sum()) if filtered["_amount"].notna().any() else None
        footer = ""
        if total is not None:
            footer = f"\n\n**Row total (pandas):** {_fmt_money(total)} across {filtered['invoice_no'].nunique() if 'invoice_no' in filtered.columns else len(filtered)} unique invoice(s)."
        return (
            f"Matching rows from **{title}** "
            f"(exact source values; each invoice once):\n\n{table}{footer}"
        )

    # Full table request
    if _wants_full_table(q):
        table = _df_to_md(ledger, detail_cols, money_cols={"total_amount", "unit_price"})
        total = float(ledger["_amount"].dropna().sum()) if ledger["_amount"].notna().any() else None
        footer = f"\n\n**Grand total (pandas):** {_fmt_money(total)}" if total is not None else ""
        return (
            f"All unique invoice rows from **{title}** "
            f"({ledger['invoice_no'].nunique() if 'invoice_no' in ledger.columns else len(ledger)} invoices):\n\n"
            f"{table}{footer}"
        )

    return None


def try_spreadsheet_qa(
    question: str,
    documents: list[dict],
) -> Optional[dict]:
    """
    documents: [{id, title, raw_text}, ...]
    Returns {answer, sources} or None.
    """
    q = (question or "").strip()
    if not q or not documents:
        return None

    # Prefer ledger-like tables; try each document
    best: Optional[tuple[str, str, str]] = None  # answer, doc_id, title
    for doc in documents:
        raw = doc.get("raw_text") or ""
        if not raw or "|" not in raw:
            continue
        title = doc.get("title") or doc.get("id") or "document"
        doc_id = doc.get("id") or ""
        for df in parse_markdown_tables(raw):
            if not is_invoice_ledger(df):
                continue
            ans = answer_ledger_question(q, df, source_title=title)
            if ans:
                best = (ans, doc_id, title)
                break
        if best:
            break

    if not best:
        return None

    answer, doc_id, title = best
    sources = []
    if doc_id:
        sources.append(
            {
                "document_id": doc_id,
                "document_title": title,
                "page_number": 1,
                "score": 1.0,
            }
        )
    return {"answer": answer, "sources": sources}
