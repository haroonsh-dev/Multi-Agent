import os
import re
import logging

import pdfplumber
import pandas as pd
import cv2
import numpy as np

logger = logging.getLogger("visibility-docs")


def _camelot_available() -> bool:
    try:
        import camelot
        return True
    except ImportError:
        return False


def _extract_pdfplumber(pdf_path: str) -> list[dict]:
    tables = []
    try:
        with pdfplumber.open(pdf_path) as pdf:
            for page_idx, page in enumerate(pdf.pages):
                tbls = page.extract_tables()
                for t in tbls:
                    if not t or all(all(c is None or str(c).strip() == "" for c in row) for row in t):
                        continue
                    header = t[0] if t else []
                    rows = []
                    for row in t[1:]:
                        rows.append([str(c).strip() if c else "" for c in row])
                    headers = [str(h).strip() if h else "" for h in header]
                    md = _to_markdown(headers, rows)
                    if md:
                        tables.append({"page": page_idx + 1, "markdown": md, "source": "pdfplumber"})
    except Exception as e:
        logger.warning(f"pdfplumber error: {e}")
    return tables


def _extract_camelot(pdf_path: str) -> list[dict]:
    if not _camelot_available():
        return []
    import camelot
    tables = []
    for flavor in ("lattice", "stream"):
        try:
            result = camelot.read_pdf(pdf_path, flavor=flavor, pages="all", suppress_stdout=True)
            for t in result:
                df: pd.DataFrame = t.df
                if df.empty or df.size == 0:
                    continue
                if df.shape[1] <= 1 and all(str(v).strip() == "" for v in df.values.flatten()):
                    continue
                header = [str(h).strip() for h in df.iloc[0].tolist()]
                rows = []
                for _, row in df.iloc[1:].iterrows():
                    rows.append([str(c).strip() for c in row.tolist()])
                md = _to_markdown(header, rows)
                if md:
                    tables.append({"page": t.page, "markdown": md, "source": f"camelot_{flavor}"})
        except Exception as e:
            logger.debug(f"Camelot {flavor} error: {e}")
    return tables


def _extract_opencv(pdf_path: str) -> list[dict]:
    try:
        import fitz
    except ImportError:
        return []
    tables = []
    try:
        doc = fitz.open(pdf_path)
        for page_idx, page in enumerate(doc):
            pix = page.get_pixmap(dpi=200)
            img_data = pix.tobytes("png")
            img = cv2.imdecode(np.frombuffer(img_data, np.uint8), cv2.IMREAD_GRAYSCALE)
            if img is None:
                continue
            binary = cv2.adaptiveThreshold(img, 255, cv2.ADAPTIVE_THRESH_GAUSSIAN_C, cv2.THRESH_BINARY_INV, 15, 3)
            hor_kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (40, 1))
            ver_kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (1, 40))
            hor_lines = cv2.morphologyEx(binary, cv2.MORPH_OPEN, hor_kernel)
            ver_lines = cv2.morphologyEx(binary, cv2.MORPH_OPEN, ver_kernel)
            grid = cv2.bitwise_or(hor_lines, ver_lines)
            contours, _ = cv2.findContours(grid, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
            min_area = img.shape[0] * img.shape[1] * 0.01
            cell_boxes = []
            for c in contours:
                x, y, w, h = cv2.boundingRect(c)
                if w * h > min_area and w > 30 and h > 15:
                    cell_boxes.append((x, y, w, h))
            if len(cell_boxes) < 4:
                continue
            cell_boxes.sort(key=lambda b: (b[1], b[0]))
            rows_map = {}
            for bx, by, bw, bh in cell_boxes:
                row_key = round(by / 10)
                rows_map.setdefault(row_key, []).append((bx, by, bw, bh))
            sorted_rows = sorted(rows_map.values(), key=lambda r: r[0][1])
            text_rows = []
            for row_cells in sorted_rows:
                row_cells.sort(key=lambda c: c[0])
                text_row = []
                for cx, cy, cw, ch in row_cells:
                    roi = img[cy : cy + ch, cx : cx + cw]
                    mean_val = cv2.mean(roi)[0]
                    text_row.append("" if mean_val > 240 else "[data]")
                text_rows.append(text_row)
            if len(text_rows) >= 2:
                md_rows = []
                for tr in text_rows:
                    md_rows.append("| " + " | ".join(tr) + " |")
                tables.append({"page": page_idx + 1, "markdown": "\n".join(md_rows), "source": "opencv"})
        doc.close()
    except Exception as e:
        logger.warning(f"OpenCV table extraction error: {e}")
    return tables


def _to_markdown(headers: list[str], rows: list[list[str]]) -> str:
    if not headers and not rows:
        return ""
    n = max(len(headers), max((len(r) for r in rows), default=0))
    h = [headers[i] if i < len(headers) else "" for i in range(n)]
    separator = "| " + " | ".join(["---"] * n) + " |"
    lines = ["| " + " | ".join(h) + " |", separator]
    for row in rows:
        cells = [row[i] if i < len(row) else "" for i in range(n)]
        lines.append("| " + " | ".join(cells) + " |")
    return "\n".join(lines)


def _dedup_merge(all_tables: list[dict]) -> list[dict]:
    seen = set()
    unique = []
    for t in all_tables:
        key = t["markdown"][:100]
        if key not in seen:
            seen.add(key)
            unique.append(t)
    return unique


def extract_tables(pdf_path: str) -> list[dict]:
    tables = []
    try:
        tables.extend(_extract_pdfplumber(pdf_path))
    except Exception as e:
        logger.warning(f"pdfplumber table extraction failed: {e}")

    # Fast path: if pdfplumber already extracted tables, return immediately to avoid slow Camelot hangs
    if tables:
        return _dedup_merge(tables)

    import concurrent.futures
    with concurrent.futures.ThreadPoolExecutor(max_workers=1) as pool:
        try:
            fut = pool.submit(_extract_camelot, pdf_path)
            tables.extend(fut.result(timeout=10))
        except Exception:
            logger.warning("Camelot table extraction timed out or failed")

    if not tables:
        try:
            tables.extend(_extract_opencv(pdf_path))
        except Exception:
            pass

    return _dedup_merge(tables)


def tables_to_text(tables: list[dict]) -> str:
    parts = []
    for t in tables:
        parts.append(f"[TABLE from page {t['page']} ({t['source']})]\n{t['markdown']}\n[/TABLE]")
    return "\n\n".join(parts)
