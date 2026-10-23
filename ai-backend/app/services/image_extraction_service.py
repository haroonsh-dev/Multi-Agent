import os
import base64
import io
import time
import json
import logging
import uuid
from concurrent.futures import ThreadPoolExecutor, as_completed
from ..config import settings
from ..database import SupabaseDB

logger = logging.getLogger("visibility-docs")

VISION_IMAGE_PROMPT = """You are analyzing a single image extracted from a document page.

Extract the following if present:
- Every visible word, number, label, callout
- Figure title / caption
- Component names, part numbers, serial numbers
- Dimensions, units, symbols
- Warnings, notes, annotations
- Table text if present

If this is a machine diagram, engineering drawing, or technical illustration:
- Provide a concise factual description of what the image represents
- List every visible component label
- Do NOT hallucinate or guess

Output format:
## Figure Title
[figure title or caption if found, otherwise "Untitled Figure"]

## OCR
[every visible word and number]

## Components
[comma-separated list of detected component names and labels]

## Description
[concise factual description — only if diagram/engineering]

## Labels
[comma-separated list of all labels, callouts, annotations]

## Warnings
[any warning, caution, note text found]

Return ONLY clean Markdown. No explanations, no summaries, no questions."""


def _get_image_dir(document_id: str) -> str:
    image_dir = os.path.join(settings.UPLOAD_DIR, "images", document_id)
    os.makedirs(image_dir, exist_ok=True)
    return image_dir


def _extract_pdf_images(file_path: str) -> list[dict]:
    import fitz
    doc = fitz.open(file_path)

    # Track xrefs we've already seen (duplicate layout images)
    seen_xrefs: set[int] = set()
    extracted = []

    for page_num, page in enumerate(doc, 1):
        page_text = page.get_text().strip()
        image_list = page.get_images(full=True)

        is_scanned_page = not image_list and len(page_text) < 50
        if is_scanned_page:
            pix = page.get_pixmap(dpi=150)
            img_bytes = pix.tobytes("jpeg")
            w, h = pix.width, pix.height
            if w >= 200 and h >= 200:
                extracted.append({
                    "image_id": f"{uuid.uuid4().hex[:12]}",
                    "page_num": page_num,
                    "image_index": 0,
                    "width": w, "height": h, "format": "full_page",
                    "bytes": img_bytes, "page_text": page_text,
                })
            continue

        for img_idx, img_info in enumerate(image_list):
            xref = img_info[0]
            if xref in seen_xrefs:
                continue
            seen_xrefs.add(xref)

            try:
                base_image = doc.extract_image(xref)
            except Exception:
                continue
            w = base_image.get("width", 0)
            h = base_image.get("height", 0)
            if w < 150 or h < 150:
                continue
            if w * h < 40000:
                continue
            if _is_blank_image(base_image["image"]):
                continue

            extracted.append({
                "image_id": f"{uuid.uuid4().hex[:12]}",
                "page_num": page_num,
                "image_index": img_idx,
                "width": w, "height": h,
                "format": base_image.get("ext", "png"),
                "bytes": base_image["image"],
                "page_text": page_text,
            })

    doc.close()
    return extracted


def _is_blank_image(img_bytes: bytes, threshold: float = 10.0) -> bool:
    try:
        from PIL import Image
        import io
        pil = Image.open(io.BytesIO(img_bytes)).convert("L")
        pixels = list(pil.getdata())
        if len(pixels) < 100:
            return True
        avg = sum(pixels) / len(pixels)
        variance = sum((p - avg) ** 2 for p in pixels) / len(pixels)
        return variance ** 0.5 < threshold
    except Exception:
        return False


def _save_image_file(image_data: dict, document_id: str) -> dict:
    image_dir = _get_image_dir(document_id)
    filename = f"page{image_data['page_num']:04d}_img{image_data['image_index']:03d}.jpg"
    filepath = os.path.join(image_dir, filename)
    with open(filepath, "wb") as f:
        f.write(image_data["bytes"])
    rel_path = os.path.relpath(filepath, settings.UPLOAD_DIR).replace("\\", "/")
    image_data["image_path"] = rel_path
    image_data["image_full_path"] = filepath
    return image_data


def _image_to_b64(image_data: dict) -> str:
    from PIL import Image
    buf = io.BytesIO(image_data["bytes"])
    img = Image.open(buf)
    if img.mode != "RGB":
        img = img.convert("RGB")
    target_w = 768
    w_percent = target_w / float(img.width)
    h_size = int(float(img.height) * float(w_percent))
    img = img.resize((target_w, h_size), Image.LANCZOS)
    out = io.BytesIO()
    img.save(out, format="JPEG", quality=80, optimize=True)
    return base64.b64encode(out.getvalue()).decode("utf-8")


def _call_vision(image_b64: str) -> dict:
    from .vision_provider import vision_provider
    return vision_provider.analyze(image_b64)


def _find_surrounding_text(page_text: str, image_index: int, total_images: int) -> tuple[str, str]:
    paragraphs = [p.strip() for p in page_text.split("\n\n") if p.strip()]
    if not paragraphs:
        return "", ""
    mid = len(paragraphs) // 2
    if image_index == 0:
        before = ""
        after = "\n\n".join(paragraphs[:3]) if paragraphs else ""
    elif image_index == total_images - 1:
        before = "\n\n".join(paragraphs[-3:]) if len(paragraphs) > 3 else "\n\n".join(paragraphs)
        after = ""
    else:
        split = min(len(paragraphs) - 1, max(1, len(paragraphs) * (image_index + 1) // (total_images + 1)))
        before = "\n\n".join(paragraphs[:split])
        after = "\n\n".join(paragraphs[split:])

    before = before[:300]
    after = after[:300]
    return before, after


def process_pdf_images(file_path: str, document_id: str, organization_id: str, max_images: int = 50) -> list[dict]:
    logger.info(f"[ImageExtraction] Starting for doc {document_id[:12]}...")

    raw_images = _extract_pdf_images(file_path)
    logger.info(f"[ImageExtraction] Found {len(raw_images)} images in PDF")

    if not raw_images:
        logger.info("[ImageExtraction] No images found")
        return []

    images = raw_images[:max_images]
    results = []

    # Step 1: Save all images to disk first (sequential, fast)
    for img_data in images:
        _save_image_file(img_data, document_id)

    # Step 2: Process Vision API calls in parallel (biggest bottleneck)
    def _process_one(img_data: dict) -> dict | None:
        try:
            t0 = time.time()
            b64 = _image_to_b64(img_data)
            vision_result = _call_vision(b64)
            elapsed = time.time() - t0

            if not vision_result or not vision_result.get("markdown"):
                logger.warning(f"[ImageExtraction] Vision failed for {img_data['image_id']}, skipping")
                return None

            before_text, after_text = _find_surrounding_text(
                img_data["page_text"], img_data["image_index"], len(images)
            )

            return {
                "img_data": img_data,
                "vision_result": vision_result,
                "vision_md": vision_result["markdown"],
                "before_text": before_text,
                "after_text": after_text,
                "elapsed": elapsed,
            }
        except Exception as e:
            logger.error(f"[ImageExtraction] Failed to process image {img_data.get('image_id', '?')}: {e}")
            return None

    max_workers = min(3, len(images))
    processed = []
    with ThreadPoolExecutor(max_workers=max_workers) as pool:
        futures = {pool.submit(_process_one, img): img for img in images}
        for fut in as_completed(futures, timeout=600):
            result = fut.result()
            if result:
                processed.append(result)

    # Step 3: Build markdown + metadata (sequential in main thread)
    for p in processed:
        img_data = p["img_data"]
        vision_result = p["vision_result"]
        vision_md = p["vision_md"]
        before_text = p["before_text"]
        after_text = p["after_text"]

        image_md = f"# Figure (Page {img_data['page_num']})\n\n"
        image_md += f"**Image ID:** {img_data['image_id']}\n\n"
        image_md += f"**Page:** {img_data['page_num']}\n\n"
        if before_text:
            image_md += f"**Preceding Context:**\n{before_text}\n\n"
        image_md += vision_md.strip() + "\n\n"
        if after_text:
            image_md += f"**Following Context:**\n{after_text}\n\n"

        meta = {
            "document_id": document_id,
            "organization_id": organization_id,
            "image_id": img_data["image_id"],
            "page_number": img_data["page_num"],
            "image_index": img_data["image_index"],
            "image_path": img_data.get("image_path", ""),
            "image_width": img_data.get("width", 0),
            "image_height": img_data.get("height", 0),
            "vision_title": vision_result.get("title", ""),
            "vision_ocr_text": vision_result.get("ocr_text", ""),
            "vision_components": vision_result.get("components", []),
            "vision_labels": vision_result.get("labels", []),
            "vision_warnings": vision_result.get("warnings", []),
            "vision_description": vision_result.get("description", ""),
        }

        results.append({
            "markdown": image_md,
            "metadata": meta,
            "vision_time_ms": int(p["elapsed"] * 1000),
        })

    # Save all descriptions to a text file alongside the images
    if results:
        try:
            image_dir = _get_image_dir(document_id)
            desc_path = os.path.join(image_dir, "descriptions.txt")
            with open(desc_path, "w", encoding="utf-8") as f:
                f.write(f"Image Descriptions for Document {document_id}\n")
                f.write("=" * 60 + "\n\n")
                for i, r in enumerate(results):
                    meta = r["metadata"]
                    f.write(f"--- Image {i+1}: Page {meta['page_number']} ---\n")
                    f.write(r["markdown"])
                    f.write("\n\n")
            logger.info(f"[ImageExtraction] Saved descriptions to {desc_path}")
        except Exception as e:
            logger.warning(f"[ImageExtraction] Failed to save descriptions file: {e}")

    logger.info(f"[ImageExtraction] Completed: {len(results)}/{len(images)} images processed")
    return results


image_extraction_service = type("ImageExtractionService", (), {
    "process_pdf_images": staticmethod(process_pdf_images)
})()
