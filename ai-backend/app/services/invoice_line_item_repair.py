"""Repair invoice line_items when OCR/LLM confuses Qty / Rate / Amount columns."""
from __future__ import annotations

import logging
from typing import Any

logger = logging.getLogger("visibility-docs")


def _num(raw: Any) -> float | None:
    if raw is None or raw == "":
        return None
    if isinstance(raw, bool):
        return None
    if isinstance(raw, (int, float)):
        return float(raw) if abs(float(raw)) < 1e15 else None
    s = (
        str(raw)
        .strip()
        .replace(",", "")
        .replace("Rs.", "")
        .replace("RS", "")
        .replace("PKR", "")
    )
    s = "".join(ch for ch in s if ch.isdigit() or ch in ".-")
    if not s or s in (".", "-", "-."):
        return None
    try:
        return float(s)
    except ValueError:
        return None


def _nearly(a: float, b: float, rel: float = 0.02, abs_tol: float = 1.0) -> bool:
    return abs(a - b) <= max(abs_tol, rel * max(abs(a), abs(b), 1.0))


def _nearly_int(x: float, tol: float = 0.05) -> int | None:
    r = round(x)
    if r >= 1 and abs(x - r) <= tol:
        return int(r)
    return None


def repair_line_item(item: dict[str, Any]) -> dict[str, Any]:
    """Normalize one line item so quantity × unit_price ≈ total_price when possible."""
    out = dict(item)
    qty = _num(out.get("quantity")) or _num(out.get("qty"))
    unit = (
        _num(out.get("unit_price"))
        or _num(out.get("price"))
        or _num(out.get("rate"))
        or _num(out.get("unit_rate"))
    )
    total = (
        _num(out.get("total_price"))
        or _num(out.get("total"))
        or _num(out.get("amount"))
        or _num(out.get("line_total"))
        or _num(out.get("line_amount"))
    )

    # Fill missing third value when two are present
    if qty is not None and unit is not None and (total is None or total <= 0):
        total = round(qty * unit, 2)
    elif qty is not None and qty > 0 and total is not None and (unit is None or unit <= 0):
        unit = round(total / qty, 2)
    elif unit is not None and unit > 0 and total is not None and (qty is None or qty <= 0):
        q_guess = _nearly_int(total / unit)
        qty = float(q_guess) if q_guess is not None else round(total / unit, 2)

    if qty is None or unit is None or total is None:
        if qty is not None:
            out["quantity"] = qty
        if unit is not None:
            out["unit_price"] = unit
        if total is not None:
            out["total_price"] = total
        return out

    if _nearly(qty * unit, total):
        out["quantity"] = qty
        out["unit_price"] = round(unit, 2)
        out["total_price"] = round(total, 2)
        return out

    # Prefer printed line total; fix qty or unit to match
    candidates: list[tuple[float, float, float, str]] = []

    if unit and abs(unit) > 1e-9:
        q_from_unit = _nearly_int(total / unit)
        if q_from_unit is not None:
            candidates.append((float(q_from_unit), unit, total, "qty_from_total_unit"))

    if qty > 0:
        candidates.append((qty, round(total / qty, 2), total, "unit_from_total_qty"))

    candidates.append((qty, unit, round(qty * unit, 2), "total_from_qty_unit"))

    # Collapsed columns: qty=1 and unit_price copied from line total — keep total, mark suspect
    if _nearly(qty, 1.0) and _nearly(unit, total):
        out["quantity"] = 1.0
        out["unit_price"] = round(total, 2)
        out["total_price"] = round(total, 2)
        out["_line_item_suspect_collapsed_qty"] = True
        return out

    best: tuple[float, float, float] | None = None
    best_err = float("inf")
    for cq, cu, ct, _tag in candidates:
        err = abs(cq * cu - ct) + abs(ct - total) * 0.5
        if err < best_err:
            best_err = err
            best = (cq, cu, ct)

    if best:
        out["quantity"] = best[0]
        out["unit_price"] = round(best[1], 2)
        out["total_price"] = round(best[2], 2)
        out["_line_item_repaired"] = True
    else:
        out["quantity"] = qty
        out["unit_price"] = round(unit, 2)
        out["total_price"] = round(total, 2)

    return out


def repair_invoice_extraction(data: dict[str, Any] | None) -> dict[str, Any]:
    """
    Post-process invoice extracted_data:
    - Repair each line_item arithmetic
    - Prefer printed total_amount / subtotal over bad line sums
    """
    if not isinstance(data, dict):
        return {}
    out = dict(data)
    items = out.get("line_items")
    if not isinstance(items, list) or not items:
        return out

    repaired: list[dict] = []
    for raw in items:
        if isinstance(raw, dict):
            repaired.append(repair_line_item(raw))
    out["line_items"] = repaired

    line_sum = 0.0
    for it in repaired:
        t = _num(it.get("total_price"))
        if t is not None:
            line_sum += t

    printed_total = (
        _num(out.get("total_amount"))
        or _num(out.get("grand_total"))
        or _num(out.get("Total Amount"))
    )
    printed_sub = _num(out.get("subtotal"))

    if printed_total is not None and line_sum > 0 and not _nearly(line_sum, printed_total):
        out["_line_items_sum"] = round(line_sum, 2)
        out["_line_items_total_mismatch"] = True
        # Keep the printed invoice total — do not overwrite with hallucinated line sum
        out["total_amount"] = printed_total
        logger.info(
            "Invoice line_items sum %.2f != printed total %.2f — keeping printed total",
            line_sum,
            printed_total,
        )
    elif printed_total is None and line_sum > 0:
        out["total_amount"] = round(line_sum, 2)

    if printed_sub is not None:
        out["subtotal"] = printed_sub
    elif line_sum > 0 and (
        printed_total is None or _nearly(line_sum, printed_total or line_sum)
    ):
        out["subtotal"] = round(line_sum, 2)

    return out
