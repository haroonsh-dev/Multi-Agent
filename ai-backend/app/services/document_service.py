import os
import json
import asyncio
import logging
from concurrent.futures import ThreadPoolExecutor
from ..database import SupabaseDB
from ..config import settings
from ..models.schemas import DocumentStatus
from .orchestrator_service import orchestrator

logger = logging.getLogger("visibility-docs")
_pool = ThreadPoolExecutor(max_workers=8)


class DocumentService:
    async def create_document(self, organization_id: str, title: str, file_info: dict, uploaded_by: str = None, phase3_agent: str = None, allowed_agents: str = None) -> dict:
        import datetime
        now = datetime.datetime.utcnow().isoformat()
        doc_id = __import__("uuid").uuid4().hex
        doc_data = {
            "id": doc_id,
            "organization_id": organization_id,
            "title": title,
            "status": DocumentStatus.UPLOADED.value,
            "original_file_url": file_info["file_path"],
            "file_size": file_info["file_size"],
            "file_hash": file_info.get("file_hash", ""),
            "uploaded_by": uploaded_by or "",
            "created_at": now,
            "updated_at": now,
        }
        if phase3_agent:
            doc_data["phase3_agent"] = phase3_agent
        if allowed_agents:
            doc_data["allowed_agents"] = allowed_agents

        result = SupabaseDB.insert("documents", doc_data)
        if hasattr(result, "data") and result.data:
            return result.data[0]
        return doc_data

    async def process_document(self, document_id: str, organization_id: str) -> dict:
        SupabaseDB.update("documents", {"status": DocumentStatus.PROCESSING.value}, "id", document_id)
        def _safe_run(did, oid):
            import concurrent.futures
            with concurrent.futures.ThreadPoolExecutor(max_workers=1) as runner:
                fut = runner.submit(orchestrator.run_pipeline, did, oid)
                try:
                    return fut.result(timeout=1800)
                except concurrent.futures.TimeoutError:
                    logger.error(f"Pipeline timed out (>30 min) for {did}")
                    try:
                        SupabaseDB.update("documents", {"status": "failed", "error_message": "Pipeline timed out"}, "id", did)
                    except Exception:
                        pass
                    return {"status": "failed"}
                except Exception as e:
                    logger.error(f"Pipeline crashed for {did}: {e}")
                    import traceback
                    traceback.print_exc()
                    try:
                        SupabaseDB.update("documents", {"status": "failed", "error_message": str(e)}, "id", did)
                    except Exception:
                        pass
                    return {"status": "failed"}
        fut = _pool.submit(_safe_run, document_id, organization_id)
        def _log_err(f):
            try:
                exc = f.exception()
                if exc:
                    logger.error(f"Pipeline background failed for {document_id}: {exc}")
            except:
                pass
        fut.add_done_callback(_log_err)
        return {"document_id": document_id, "status": "processing", "message": "Pipeline started in background"}

    async def process_document_await(self, document_id: str, organization_id: str) -> dict:
        SupabaseDB.update("documents", {"status": DocumentStatus.PROCESSING.value}, "id", document_id)
        loop = asyncio.get_event_loop()
        result = await loop.run_in_executor(_pool, orchestrator.run_pipeline, document_id, organization_id)
        return result

    def _fetch_document_row(self, document_id: str, organization_id: str = "") -> dict | None:
        filters: dict = {"id": document_id}
        if organization_id:
            filters["organization_id"] = organization_id
        result = SupabaseDB.select("documents", filters=filters)
        data = getattr(result, "data", result if isinstance(result, list) else [])
        if isinstance(data, list) and data:
            return data[0]
        if organization_id:
            result = SupabaseDB.select("documents", filters={"id": document_id})
            data = getattr(result, "data", result if isinstance(result, list) else [])
            if isinstance(data, list) and data:
                return data[0]
        return None

    def _infer_document_type(self, doc: dict) -> None:
        if doc.get("document_type") and doc.get("document_type") not in ("other", "unknown"):
            return
        title = (doc.get("title") or "").lower()
        hints = ["cv", "resume", "curriculum vitae", "invoice", "contract", "purchase order", "po "]
        if any(h in title for h in ["cv", "resume", "curriculum"]):
            doc["document_type"] = "resume"
            doc.setdefault("phase3_agent", "hr_agent")
        elif "invoice" in title:
            doc["document_type"] = "invoice"
            doc.setdefault("phase3_agent", "finance_agent")
        elif "contract" in title:
            doc["document_type"] = "contract"
            doc.setdefault("phase3_agent", "legal_agent")

    def _attach_cv_extraction(self, doc: dict, organization_id: str, full_data: bool = False):
        org_id = organization_id or doc.get("organization_id") or ""
        is_resume = doc.get("document_type") == "resume"
        if not is_resume:
            title = (doc.get("title") or "").lower()
            is_resume = any(x in title for x in ["cv", "resume", "curriculum"])

        def _apply_cv(ev: dict):
            if not ev:
                return
            score = ev.get("overall_score")
            if score is not None:
                doc["cv_score"] = float(score)
            if full_data and ev:
                doc["cv_extraction_data"] = ev

        def _apply_score_from_parsed(parsed: dict):
            if not isinstance(parsed, dict):
                return False
            # Resume skill stores top-level cv_score (current schema).
            direct = parsed.get("cv_score")
            if direct is not None:
                try:
                    doc["cv_score"] = float(direct)
                    return True
                except (TypeError, ValueError):
                    pass
            ev = parsed.get("cv_evaluation") or {}
            if isinstance(ev, dict) and ev.get("overall_score") is not None:
                _apply_cv(ev)
                return True
            return False

        if is_resume:
            try:
                ext_result = SupabaseDB.select(
                    "document_extractions",
                    columns="extracted_data",
                    filters={"document_id": doc["id"], "organization_id": org_id},
                )
                ext_data = getattr(ext_result, "data", ext_result if isinstance(ext_result, list) else [])
                if isinstance(ext_data, list) and ext_data:
                    for row in ext_data:
                        raw = row.get("extracted_data", "{}")
                        if isinstance(raw, str):
                            import json
                            parsed = json.loads(raw)
                        else:
                            parsed = raw or {}
                        if _apply_score_from_parsed(parsed):
                            return
            except Exception:
                pass

        extracted = doc.get("extracted_data") or {}
        if isinstance(extracted, dict):
            _apply_score_from_parsed(extracted)

    def _attach_metadata(self, doc: dict, organization_id: str):
        org_id = organization_id or doc.get("organization_id") or ""
        try:
            meta_result = SupabaseDB.select(
                "documents_metadata",
                filters={"document_id": doc["id"], "organization_id": org_id},
            )
            meta_data = getattr(meta_result, "data", meta_result if isinstance(meta_result, list) else [])
            if not isinstance(meta_data, list) or not meta_data:
                meta_result = SupabaseDB.select(
                    "documents_metadata",
                    filters={"document_id": doc["id"]},
                )
                meta_data = getattr(meta_result, "data", meta_result if isinstance(meta_result, list) else [])
            if isinstance(meta_data, list) and meta_data:
                meta = meta_data[0]
                extracted = meta.get("extracted_data", {})
                if isinstance(extracted, str):
                    import json
                    extracted = json.loads(extracted) if extracted else {}
                doc["extracted_data"] = extracted or {}
                fc = meta.get("field_confidence", {})
                if isinstance(fc, str):
                    import json
                    fc = json.loads(fc) if fc else {}
                doc["field_confidence"] = fc or {}
                if meta.get("overall_confidence") is not None:
                    doc["extraction_confidence"] = meta.get("overall_confidence")
        except Exception:
            pass

    def get_document(self, document_id: str, organization_id: str) -> dict:
        doc = self._fetch_document_row(document_id, organization_id)
        if not doc:
            return None
        org_id = organization_id or doc.get("organization_id") or ""
        self._infer_document_type(doc)
        self._attach_metadata(doc, org_id)
        self._attach_cv_extraction(doc, org_id, full_data=True)
        if not doc.get("page_count") and doc.get("raw_text"):
            doc["page_count"] = max(1, len(doc["raw_text"]) // 2000)
        return doc

    def _batch_attach_extractions(self, docs: list[dict], organization_id: str):
        """Batch-fetch document_extractions for all docs in one query, attach cv_score to resumes."""
        resume_ids = [
            d["id"]
            for d in docs
            if d.get("document_type") == "resume"
            or any(x in (d.get("title") or "").lower() for x in ("cv", "resume", "curriculum"))
        ]
        if not resume_ids:
            return
        try:
            import json
            from ..database import _local_select_in, _get_supabase, _use_supabase
            unique_ids = list(set(resume_ids))
            client = _get_supabase()
            if _use_supabase and client:
                r = client.table("document_extractions") \
                    .select("document_id, extracted_data") \
                    .in_("document_id", unique_ids) \
                    .eq("organization_id", organization_id) \
                    .execute()
                rows = getattr(r, "data", [])
            else:
                rows = _local_select_in(
                    "document_extractions",
                    columns="document_id, extracted_data",
                    filters={"organization_id": organization_id},
                    in_column="document_id",
                    in_values=unique_ids,
                )
            scores = {}
            for row in rows:
                raw = row.get("extracted_data", "{}")
                parsed = json.loads(raw) if isinstance(raw, str) else (raw or {})
                if not isinstance(parsed, dict):
                    continue
                score = parsed.get("cv_score")
                if score is None:
                    ev = parsed.get("cv_evaluation") or {}
                    if isinstance(ev, dict):
                        score = ev.get("overall_score")
                if score is not None:
                    try:
                        scores[row["document_id"]] = float(score)
                    except (TypeError, ValueError):
                        pass
            for d in docs:
                if d["id"] in scores:
                    d["cv_score"] = scores[d["id"]]
        except Exception:
            pass

    def list_documents(self, organization_id: str, limit: int = 50, offset: int = 0, search: str = "", phase3_agent: str = "") -> list[dict]:
        filters = {"organization_id": organization_id}
        if phase3_agent:
            filters["phase3_agent"] = phase3_agent
        like = {"title": search} if search else None
        result = SupabaseDB.select("documents", filters=filters, like=like, limit=limit, offset=offset)
        data = getattr(result, "data", result if isinstance(result, list) else [])
        docs = data if isinstance(data, list) else []

        # Batch-attach cv_score for resume documents (single query instead of N queries)
        self._batch_attach_extractions(docs, organization_id)

        return docs

    def delete_document(self, document_id: str, organization_id: str):
        doc = self.get_document(document_id, organization_id)
        if doc:
            file_path = doc.get("original_file_url", "")
            if file_path and os.path.exists(file_path):
                try:
                    os.remove(file_path)
                except Exception:
                    pass
            supabase_url = doc.get("supabase_url") or ""
            if supabase_url:
                try:
                    filename = supabase_url.rsplit("/", 1)[-1]
                    SupabaseDB.delete_file("documents", filename)
                except Exception:
                    pass
        SupabaseDB.delete_document_cascade(document_id)
        try:
            from .pinecone_service import pinecone_service
            pinecone_service.delete_by_document(document_id, namespace=organization_id)
        except Exception:
            pass
        return {"message": "Document deleted successfully"}


document_service = DocumentService()
