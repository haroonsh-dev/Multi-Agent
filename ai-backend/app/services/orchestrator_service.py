import os
import time
import logging
from datetime import datetime
from ..database import SupabaseDB
from .ocr_service import ocr_service
from .agent_orchestrator import classification_agent, category_agents, DOCUMENT_TO_PHASE3_AGENT
from .resume_transcript_disambiguation import reconcile_resume_transcript_classification
from .classification_service import classification_service
from .rag_service import rag_service
from .orchestration_logger import (OrchestrationLogger, get_logger, reset_logger, C)
from ..utils.agent_allowlist import clamp_agent, parse_allowed_agents

logger = logging.getLogger("visibility-docs")

STAGE_ORDER = [
    "queued",
    "preprocessing",
    "ocr_processing",
    "ocr_done",
    "classifying",
    "classified",
    "extracting",
    "extracted",
    "embedding",
    "embedded",
    "image_extraction",
    "completed",
]


class OrchestratorService:
    def get_or_create_job(self, document_id: str, organization_id: str) -> dict:
        existing = SupabaseDB.select("processing_jobs", filters={"document_id": document_id})
        data = getattr(existing, "data", existing if isinstance(existing, list) else [])
        if isinstance(data, list) and data:
            return data[0] if isinstance(data[0], dict) else {}
        SupabaseDB.insert("processing_jobs", {
            "organization_id": organization_id,
            "document_id": document_id,
            "job_type": "full_pipeline",
            "stage": "queued",
            "status": "queued",
            "progress": 0,
        })
        return {"stage": "queued", "status": "queued"}

    def update_stage(self, document_id: str, organization_id: str, stage: str, progress: int = None, status: str = None, error: str = None):
        update = {"stage": stage}
        if progress is not None:
            update["progress"] = progress
        if status:
            update["status"] = status
        if error:
            update["error_message"] = error
        if status == "running":
            update["started_at"] = datetime.utcnow().isoformat()
        if status in ("completed", "failed"):
            update["completed_at"] = datetime.utcnow().isoformat()
        SupabaseDB.update("processing_jobs", update, "document_id", document_id)

    def log_agent_run(self, organization_id: str, document_id: str, agent_name: str,
                      input_summary: str, output_summary: str, confidence: float,
                      duration_ms: int, status: str = "completed", error: str = None):
        SupabaseDB.insert("agent_runs", {
            "organization_id": organization_id,
            "document_id": document_id,
            "agent_name": agent_name,
            "input_summary": input_summary[:500] if input_summary else "",
            "output_summary": output_summary[:500] if output_summary else "",
            "confidence": confidence,
            "duration_ms": duration_ms,
            "status": status,
            "error_message": error,
        })

    def _find_relocated_file(self, old_path: str) -> str | None:
        """Find a file that was moved by gateway by-type relocate (inbox → by-type/{type}/…)."""
        from ..utils.file_utils import resolve_shared_storage_root

        root = resolve_shared_storage_root()
        if not root or not os.path.isdir(root):
            return None

        basename = os.path.basename(old_path or "")
        doc_folder = None
        parts = os.path.normpath(old_path or "").split(os.sep)
        for part in reversed(parts):
            if part.startswith("doc_"):
                doc_folder = part
                break

        matches: list[str] = []
        for dirpath, _dirnames, filenames in os.walk(root):
            if basename and basename in filenames:
                candidate = os.path.abspath(os.path.join(dirpath, basename))
                if doc_folder and doc_folder not in candidate:
                    continue
                if os.path.isfile(candidate):
                    matches.append(candidate)
            elif doc_folder and os.path.basename(dirpath) == doc_folder:
                for name in filenames:
                    candidate = os.path.abspath(os.path.join(dirpath, name))
                    if os.path.isfile(candidate):
                        matches.append(candidate)

        if not matches:
            return None
        # Prefer the most recently modified copy
        matches.sort(key=lambda p: os.path.getmtime(p), reverse=True)
        return matches[0]

    def _resolve_file(self, doc: dict) -> str:
        fp = doc.get("original_file_url", "")
        if not fp:
            raise FileNotFoundError("File path not found")
        if os.path.exists(fp):
            return fp
        if fp.startswith("http"):
            import tempfile, urllib.request
            resp = urllib.request.urlopen(fp, timeout=120)
            data = resp.read()
            ext = os.path.splitext(fp.split("?")[0].split("/")[-1])[1] or ".pdf"
            tmp = tempfile.NamedTemporaryFile(delete=False, suffix=ext)
            tmp.write(data)
            tmp.close()
            logger.info(f"Downloaded remote file to {tmp.name}")
            return tmp.name

        recovered = self._find_relocated_file(fp)
        if recovered:
            logger.info(f"Recovered relocated file for {doc.get('id')}: {fp} → {recovered}")
            try:
                SupabaseDB.update("documents", {"original_file_url": recovered}, "id", doc["id"])
            except Exception as e:
                logger.warning(f"Could not persist recovered path: {e}")
            return recovered

        raise FileNotFoundError(f"File not found: {fp}")

    def classify_only(self, document_id: str, organization_id: str) -> dict:
        log = reset_logger(document_id, doc_id=document_id)
        log.start("Classifying only (no extraction)")
        log.set_total_steps(3)
        try:
            doc_result = SupabaseDB.select("documents", filters={"id": document_id, "organization_id": organization_id})
            doc_data = getattr(doc_result, "data", [])
            if not doc_data or len(doc_data) == 0:
                raise ValueError("Document not found")
            doc = doc_data[0] if isinstance(doc_data, list) else doc_data
            file_path = self._resolve_file(doc)

            log.step("FILE RESOLUTION")
            log.info(f"Path: {file_path}")
            log.ok("File resolved")

            # Try direct text extraction first (fast path for PDFs)
            direct_text = self._extract_direct_text(file_path, max_pages=2)
            if direct_text.strip():
                self.update_stage(document_id, organization_id, "ocr_processing", 20, "running")
                import threading
                ocr_result = {}
                ocr_exc = [None]
                def _do_ocr():
                    try:
                        ocr_result.update(ocr_service.process_document(file_path))
                    except Exception as e:
                        ocr_exc[0] = e
                ocr_thread = threading.Thread(target=_do_ocr)
                ocr_thread.start()

                log.step("CLASSIFICATION")
                log.agent_call("classification_agent", "classification_agent.md", "Groq API")
                t0 = time.time()
                classification = classification_agent.classify(direct_text, doc.get("title", ""))
                class_duration = int((time.time() - t0) * 1000)
                log.result("Type", classification["document_type"], C.GREEN)
                log.result("Agent", classification.get("agent_type", ""), C.MAGENTA)
                log.result("Confidence", f"{classification['confidence']:.2f}")
                log.result("Duration", f"{class_duration}ms", C.DIM)

                ocr_thread.join(timeout=60)
                raw_text = ocr_result.get("text", "") or direct_text
                page_count = ocr_result.get("page_count", 0)

                log.step("OCR PROCESSING")
                log.agent_call("ocr_service", "", "PaddleOCR")
                log.ok(f"Extracted {len(raw_text)} chars, {page_count} pages")
            else:
                log.step("OCR PROCESSING")
                log.agent_call("ocr_service", "", "PaddleOCR")
                self.update_stage(document_id, organization_id, "ocr_processing", 20, "running")
                ocr_result = ocr_service.process_document(file_path)
                raw_text = ocr_result.get("text", "")
                page_count = ocr_result.get("page_count", 0)
                log.ok(f"Extracted {len(raw_text)} chars, {page_count} pages")

                log.step("CLASSIFICATION")
                log.agent_call("classification_agent", "classification_agent.md", "Groq API")
                self.update_stage(document_id, organization_id, "classifying", 50, "running")
                t0 = time.time()
                classification = classification_agent.classify(raw_text, doc.get("title", ""))
                class_duration = int((time.time() - t0) * 1000)
                log.result("Type", classification["document_type"], C.GREEN)
                log.result("Agent", classification.get("agent_type", ""), C.MAGENTA)
                log.result("Confidence", f"{classification['confidence']:.2f}")
                log.result("Duration", f"{class_duration}ms", C.DIM)

            doc_type = classification["document_type"]
            agent_type = classification.get("agent_type", "") or DOCUMENT_TO_PHASE3_AGENT.get(doc_type, "other_agent")
            if classification.get("confidence", 0) < 0.3:
                doc_type = "other"
                agent_type = "other_agent"
                log.warn(f"Low confidence ({classification['confidence']:.2f}), falling back to 'other'")

            allowed = parse_allowed_agents(doc.get("allowed_agents"))
            natural_agent = agent_type
            agent_clamped = False
            if allowed:
                clamped = clamp_agent(agent_type, allowed)
                if clamped and clamped != agent_type:
                    log.warn(f"Agent {agent_type} not in plan allowlist — clamping to {clamped}")
                    agent_type = clamped
                    agent_clamped = True
                    # Keep original document_type for library/visibility; skills follow phase3_agent only.

            SupabaseDB.update("documents", {
                "document_type": doc_type,
                "phase3_agent": agent_type,
                "language": classification.get("language", "en"),
                "status": "classified",
                "natural_agent": natural_agent,
                "agent_clamped": 1 if agent_clamped else 0,
            }, "id", document_id)
            self.update_stage(document_id, organization_id, "classified", 60, "completed")

            log.divider()
            log.end("classified")
            return {
                "document_id": document_id,
                "document_type": doc_type,
                "agent_type": agent_type,
                "natural_agent": natural_agent,
                "agent_clamped": agent_clamped,
                "confidence": classification.get("confidence", 0),
                "reasoning": classification.get("reasoning", ""),
                "language": classification.get("language", "en"),
                "page_count": page_count,
            }
        except Exception as e:
            log.fail(str(e))
            log.end("failed")
            logger.error(f"Classify-only failed for {document_id}: {e}")
            SupabaseDB.update("documents", {"status": "failed", "error_message": str(e)}, "id", document_id)
            self.update_stage(document_id, organization_id, stage="ocr_processing", status="failed", error=str(e))
            return {"document_id": document_id, "error": str(e)}

    def _extract_direct_text(self, file_path: str, max_pages: int = None) -> str:
        try:
            import fitz
            doc = fitz.open(file_path)
            text = ""
            for i, page in enumerate(doc):
                if max_pages and i >= max_pages:
                    break
                text += page.get_text()
            doc.close()
            return text
        except Exception:
            return ""

    def run_pipeline(self, document_id: str, organization_id: str) -> dict:
        status = "failed"
        classification = {"document_type": "other", "confidence": 0.0, "reasoning": ""}
        extraction = {"extracted_data": {}, "confidence": 0.0}
        page_count = 0
        job = {"stage": "queued", "status": "queued"}

        try:
            job = self.get_or_create_job(document_id, organization_id)
            doc_result = SupabaseDB.select("documents", filters={"id": document_id, "organization_id": organization_id})
            doc_data = getattr(doc_result, "data", [])
            if not doc_data or len(doc_data) == 0:
                doc_result = SupabaseDB.select("documents", filters={"id": document_id})
                doc_data = getattr(doc_result, "data", [])
            if not doc_data or len(doc_data) == 0:
                raise ValueError("Document not found")
            doc = doc_data[0] if isinstance(doc_data, list) else doc_data
            organization_id = organization_id or doc.get("organization_id") or ""
            file_path = self._resolve_file(doc)

            log = reset_logger(doc.get("title", document_id), doc_id=document_id)
            log.start()
            log.set_total_steps(8)

            # ── Step 1: File Resolution ──
            log.step("FILE RESOLUTION")
            log.info(f"Path: {file_path}")
            log.ok("File resolved")

            # ── Step 2: OCR + Step 3: Classification (parallel) ──
            self.update_stage(document_id, organization_id, "ocr_processing", 20, "running")

            import threading
            ocr_result = {}
            ocr_exc = [None]

            def _do_ocr():
                try:
                    ocr_result.update(ocr_service.process_document(file_path))
                except Exception as e:
                    ocr_exc[0] = e

            ocr_thread = threading.Thread(target=_do_ocr)
            ocr_thread.start()

            # Try direct text for fast classification while OCR runs
            direct_text = self._extract_direct_text(file_path, max_pages=2)
            if direct_text.strip():
                log.step("CLASSIFICATION")
                log.agent_call("classification_agent", "classification_agent.md", "Groq API (llama-8b)")
                log.info(f"Classifying from direct text while OCR runs in background...")
                self.update_stage(document_id, organization_id, "classifying", 50, "running")
                t0 = time.time()
                classification = classification_agent.classify(direct_text, doc.get("title", ""))
                class_duration = int((time.time() - t0) * 1000)
                log.result("Type", classification["document_type"], C.GREEN)
                log.result("Agent", classification.get("agent_type", ""), C.MAGENTA)
                log.result("Confidence", f"{classification['confidence']:.2f}")
                log.result("Reasoning", classification.get("reasoning", "")[:80], C.DIM)
                log.result("Duration", f"{class_duration}ms", C.DIM)
                self.log_agent_run(organization_id, document_id, "classification_agent",
                                   f"text_len={len(direct_text)}", f"type={classification['document_type']}, conf={classification['confidence']}",
                                   classification.get("confidence", 0), class_duration)

            # Wait for OCR
            ocr_thread.join(timeout=60)
            if ocr_exc[0]:
                raise ocr_exc[0]

            raw_text = ocr_result.get("text", "")
            page_count = ocr_result.get("page_count", 0)

            log.step("OCR PROCESSING")
            log.agent_call("ocr_service", "", "PaddleOCR")
            log.ok(f"Extracted {len(raw_text)} chars, {page_count} pages")
            log.result("Source", ocr_result.get("source", "ocr"), C.DIM)

            SupabaseDB.update("documents", {"raw_text": raw_text, "page_count": page_count, "status": "ocr_done"}, "id", document_id)
            self.update_stage(document_id, organization_id, "ocr_done", 40)

            # Classify from OCR text if direct text wasn't available
            if not direct_text.strip():
                log.step("CLASSIFICATION")
                log.agent_call("classification_agent", "classification_agent.md", "Groq API (llama-8b)")
                log.info("No direct text — classifying from OCR output")
                self.update_stage(document_id, organization_id, "classifying", 50, "running")
                t0 = time.time()
                classification = classification_agent.classify(raw_text, doc.get("title", ""))
                class_duration = int((time.time() - t0) * 1000)
                log.result("Type", classification["document_type"], C.GREEN)
                log.result("Agent", classification.get("agent_type", ""), C.MAGENTA)
                log.result("Confidence", f"{classification['confidence']:.2f}")
                log.result("Reasoning", classification.get("reasoning", "")[:80], C.DIM)
                log.result("Duration", f"{class_duration}ms", C.DIM)
                self.log_agent_run(organization_id, document_id, "classification_agent",
                                   f"text_len={len(raw_text)}", f"type={classification['document_type']}, conf={classification['confidence']}",
                                   classification.get("confidence", 0), class_duration)

            doc_type = classification["document_type"]
            agent_type = classification.get("agent_type", "") or DOCUMENT_TO_PHASE3_AGENT.get(doc_type, "other_agent")
            if classification.get("confidence", 0) < 0.3:
                doc_type = "other"
                agent_type = "other_agent"
                log.warn(f"Low confidence ({classification['confidence']:.2f}) — falling back to 'other'")

            allowed = parse_allowed_agents(doc.get("allowed_agents"))
            natural_agent = agent_type
            agent_clamped = False
            if allowed:
                clamped = clamp_agent(agent_type, allowed)
                if clamped and clamped != agent_type:
                    log.warn(f"Agent {agent_type} not in plan allowlist — clamping to {clamped}")
                    agent_type = clamped
                    agent_clamped = True
                    # Keep original document_type; extraction uses phase3_agent skills only.

            SupabaseDB.update("documents", {
                "document_type": doc_type,
                "phase3_agent": agent_type,
                "language": classification.get("language", "en"),
                "status": "classified",
                "natural_agent": natural_agent,
                "agent_clamped": 1 if agent_clamped else 0,
            }, "id", document_id)
            self.update_stage(document_id, organization_id, "classified", 60)

            log.result("Route → Phase 3 Agent", agent_type, C.MAGENTA)
            if agent_clamped:
                log.warn(f"Skills clamped: natural={natural_agent} → effective={agent_type}")

            # ── Step 4: Table Extraction (PDF only, time-boxed) ──
            log.step("TABLE EXTRACTION")
            log.agent_call("table_service", "", "Camelot / pdfplumber")
            ext = os.path.splitext(file_path)[1].lower()
            if ext == ".pdf":
                try:
                    from .table_service import extract_tables, tables_to_text
                    table_holder = {"tables": None, "err": None}

                    def _do_tables():
                        try:
                            table_holder["tables"] = extract_tables(file_path)
                        except Exception as e:
                            table_holder["err"] = e

                    t_thread = threading.Thread(target=_do_tables, daemon=True)
                    t_thread.start()
                    t_thread.join(timeout=20)
                    if t_thread.is_alive():
                        log.warn("Table extraction timed out after 20s — continuing without tables")
                    elif table_holder["err"]:
                        log.info(f"Table extraction skipped: {table_holder['err']}")
                    else:
                        detected_tables = table_holder["tables"] or []
                        if detected_tables:
                            table_text = tables_to_text(detected_tables)
                            raw_text = table_text + "\n\n" + raw_text
                            try:
                                SupabaseDB.insert("document_extractions", {
                                    "organization_id": organization_id,
                                    "document_id": document_id,
                                    "extraction_type": "table_extraction",
                                    "extracted_data": {
                                        "table_count": len(detected_tables),
                                        "table_text": table_text,
                                        "tables": detected_tables,
                                    },
                                    "confidence": 1.0,
                                })
                                SupabaseDB.update("documents", {"raw_text": raw_text}, "id", document_id)
                            except Exception as e:
                                log.warn(f"Table extraction persist failed: {e}")
                            log.ok(f"Found {len(detected_tables)} tables ({len(table_text)} chars) prepended to text")
                        else:
                            log.ok("No tables detected")
                except Exception as e:
                    log.info(f"Table extraction skipped: {e}")
            else:
                log.ok("Skipped (not a PDF)")

            # ── Stage 5 & 6: Entity Extraction + Embedding (parallel) ──
            self.update_stage(document_id, organization_id, "extracting", 70, "running")

            import concurrent.futures
            with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
                effective_agent = agent_type

                log.step("ENTITY EXTRACTION")
                log.agent_call(effective_agent, f"phase3/{effective_agent}.md", "Groq API (llama-70b)")
                log.info("Running in parallel with embedding...")

                ext_future = pool.submit(category_agents.extract, raw_text, doc_type, effective_agent)
                _filename = os.path.basename(file_path) if file_path else ""
                emb_future = pool.submit(rag_service.index_document, document_id, organization_id, raw_text, file_path,
                                         document_type=doc_type, filename=_filename, phase3_agent=effective_agent)

                t0 = time.time()
                extraction = ext_future.result(timeout=120)  # 2 min timeout
                # Repair invoice Qty/Rate/Amount confusion before persist
                try:
                    ed = extraction.get("extracted_data") or {}
                    if isinstance(ed, dict) and (
                        doc_type in ("invoice", "payment_receipt", "expense_report")
                        or isinstance(ed.get("line_items"), list)
                    ):
                        from .invoice_line_item_repair import repair_invoice_extraction

                        extraction["extracted_data"] = repair_invoice_extraction(ed)
                        log.info("Applied invoice line_item repair / total preference")
                except Exception as repair_err:
                    log.warn(f"Invoice line_item repair skipped: {repair_err}")
                ext_duration = int((time.time() - t0) * 1000)
                fields = list(extraction.get("extracted_data", {}).keys())
                log.ok(f"Extracted {len(fields)} fields: {', '.join(fields[:8])}")
                log.result("Confidence", f"{extraction.get('confidence', 0):.2f}", C.GREEN)
                log.result("Duration", f"{ext_duration}ms", C.DIM)

                log.step("EMBEDDING & VECTOR INDEXING")
                log.agent_call("rag_service", "", "BAAI/bge-large-en-v1.5 → Pinecone + Supabase")
                try:
                    emb_future.result(timeout=120)  # 2 min timeout
                    log.ok("Document indexed to vector store")
                except Exception as e:
                    log.warn(f"Embedding failed: {e}")

                self.log_agent_run(organization_id, document_id, f"{doc_type}_agent",
                                   f"type={doc_type}, text_len={len(raw_text)}",
                                   f"fields={fields[:10]}",
                                   extraction.get("confidence", 0), ext_duration)

            # ── Save extraction results ──
            SupabaseDB.insert("documents_metadata", {
                "organization_id": organization_id,
                "document_id": document_id,
                "document_type": doc_type,
                "extracted_data": extraction.get("extracted_data", {}),
                "field_confidence": extraction.get("field_confidence", {}),
                "overall_confidence": extraction.get("confidence", 0),
                "agent_version": "1.0.0",
            })
            SupabaseDB.insert("document_extractions", {
                "organization_id": organization_id,
                "document_id": document_id,
                "extraction_type": doc_type,
                "extracted_data": extraction.get("extracted_data", {}),
                "confidence": extraction.get("confidence", 0),
            })
            try:
                rag_service.index_structured_summary(
                    document_id=document_id,
                    organization_id=organization_id,
                    document_type=doc_type,
                    extracted_data=extraction.get("extracted_data", {}),
                    field_confidence=extraction.get("field_confidence", {}),
                )
            except Exception as e:
                log.warn(f"Structured summary indexing skipped: {e}")
            self.update_stage(document_id, organization_id, "extracted", 80)
            self.update_stage(document_id, organization_id, "embedded", 95)

            # Mark ready BEFORE image enrichment so the UI unblocks quickly.
            # Image Vision can take minutes and must not gate "processed".
            SupabaseDB.update("documents", {"status": "processed"}, "id", document_id)
            self.update_stage(document_id, organization_id, "completed", 100, "completed")
            status = "processed"
            log.ok("Document marked processed (image enrichment optional)")

            # ── Stage 7: Image Extraction (background, non-blocking) ──
            log.step("IMAGE EXTRACTION")
            log.agent_call("image_extraction_service", "", "Groq Vision (async)")
            if ext == ".pdf":
                def _enrich_images():
                    try:
                        from .image_extraction_service import image_extraction_service
                        doc_rec = SupabaseDB.select_one("documents", "id", document_id)
                        active_path = doc_rec.get("file_path", file_path) if doc_rec else file_path
                        if not os.path.exists(active_path) and os.path.exists(file_path):
                            active_path = file_path
                        images = image_extraction_service.process_pdf_images(active_path, document_id, organization_id)
                        if not images:
                            return
                        image_results = []
                        for img in images:
                            rag_service.index_image_content(
                                img["markdown"],
                                document_id,
                                organization_id,
                                img["metadata"],
                            )
                            image_results.append({
                                "page": img["metadata"]["page_number"],
                                "image_path": img["metadata"].get("image_path", ""),
                                "description": img["markdown"],
                            })
                        SupabaseDB.insert("document_extractions", {
                            "organization_id": organization_id,
                            "document_id": document_id,
                            "extraction_type": "image_extraction",
                            "extracted_data": {"images": image_results},
                            "confidence": 1.0,
                        })
                        image_text = "\n\n" + "=" * 50 + "\nIMAGE DESCRIPTIONS\n" + "=" * 50 + "\n\n"
                        for ir in image_results:
                            image_text += f"--- Image (Page {ir['page']}) ---\n"
                            image_text += ir["description"]
                            image_text += "\n\n"
                        current = SupabaseDB.select_one("documents", "id", document_id) or {}
                        base_text = current.get("raw_text") or raw_text or ""
                        if "IMAGE DESCRIPTIONS" not in base_text:
                            SupabaseDB.update("documents", {"raw_text": base_text + image_text}, "id", document_id)
                        logger.info(f"Async image enrichment done for {document_id}: {len(images)} images")
                    except Exception as e:
                        logger.warning(f"Async image extraction failed for {document_id}: {e}")

                threading.Thread(target=_enrich_images, daemon=True).start()
                log.ok("Image enrichment started in background")
            else:
                log.ok("Skipped (not a PDF)")

            log.end(status)

        except Exception as e:
            log = get_logger()
            log.fail(str(e))
            log.end("failed")
            import traceback as tb
            tb.print_exc()
            logger.error(f"Pipeline failed for {document_id}: {e}")
            SupabaseDB.update("documents", {"status": "failed", "error_message": str(e)}, "id", document_id)
            self.update_stage(document_id, organization_id, stage=job.get("stage", "queued"), status="failed", error=str(e))
            status = "failed"

        return {
            "document_id": document_id,
            "status": status,
            "classification": classification,
            "extraction": extraction,
            "page_count": page_count,
        }


orchestrator = OrchestratorService()
