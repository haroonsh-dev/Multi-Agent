import numpy as np
import threading
import logging
import hashlib
from .pinecone_service import pinecone_service
from ..config import settings

logger = logging.getLogger("visibility-docs")


class EmbeddingService:
    def __init__(self):
        self.model = None
        self.model_loaded = False
        self.dimension = 1024
        self._lock = threading.Lock()
        self._cache = {}
        self._cache_max = 256

    def _load_model(self):
        if self.model_loaded:
            return
        with self._lock:
            if self.model_loaded:
                return
            model_name = getattr(settings, "EMBEDDING_MODEL", "BAAI/bge-large-en-v1.5") or "BAAI/bge-large-en-v1.5"
            import os as _os
            _os.environ["USE_SHARED_MEMORY"] = "0"
            base_dir = _os.path.dirname(_os.path.dirname(_os.path.abspath(__file__)))
            safe_name = model_name.replace("/", "_").replace("-", "_")
            local_model_dir = _os.path.join(base_dir, "data", "local_models", safe_name)
            try:
                from sentence_transformers import SentenceTransformer
                if _os.path.exists(local_model_dir) and _os.path.isdir(local_model_dir) and any(_os.scandir(local_model_dir)):
                    logger.info(f"Loading 1024-dim embedding model directly from local project folder: {local_model_dir}...")
                    self.model = SentenceTransformer(local_model_dir, device="cpu")
                else:
                    logger.info(f"Loading 1024-dim embedding model '{model_name}'...")
                    self.model = SentenceTransformer(model_name, device="cpu")
                    _os.makedirs(local_model_dir, exist_ok=True)
                    self.model.save(local_model_dir)
                    logger.info(f"Saved model locally at: {local_model_dir}")
                self.dimension = self.model.get_sentence_embedding_dimension()
                self.model_loaded = True
                logger.info(f"Embedding model '{model_name}' loaded successfully (dimension={self.dimension})")
            except Exception as e:
                logger.warning(f"Embedding model load warning: {e}")
                try:
                    from sentence_transformers import SentenceTransformer
                    self.model = SentenceTransformer(model_name, device="cpu")
                    self.dimension = self.model.get_sentence_embedding_dimension()
                    self.model_loaded = True
                except Exception as e2:
                    logger.error(f"Embedding model fallback error: {e2}")
                    self.model_loaded = True
                    self.model = None

    def load(self):
        """Eager-load the model. Call at startup."""
        if not self.model_loaded:
            self._load_model()

    def embed_text(self, text: str) -> list[float]:
        key = hashlib.md5(text.encode()).hexdigest()
        cached = self._cache.get(key)
        if cached is not None:
            return cached
        self._load_model()
        if self.model is None:
            print(f"[EMBED] Model not available, returning zero vector")
            return [0.0] * self.dimension
        try:
            t0 = __import__("time").time()
            embedding = self.model.encode(text, normalize_embeddings=True, show_progress_bar=False)
            result = embedding.tolist()
            duration = __import__("time").time() - t0
            if len(self._cache) >= self._cache_max:
                self._cache.clear()
            self._cache[key] = result
            print(f"[EMBED] Text embedded: dim={len(result)}, time={duration:.2f}s")
            return result
        except Exception as e:
            logger.error(f"embed_text failed: {e}")
            return [0.0] * self.dimension

    def embed_chunks(self, chunks: list[str], document_id: str = None, organization_id: str = None,
                     chunk_metadata: list[dict] = None) -> list[list[float]]:
        print(f"[EMBED] Processing {len(chunks)} chunks for doc {document_id[:12] if document_id else '?'}...")
        # Prepend heading/section context to chunk text for better embedding
        enriched = []
        for i, chunk in enumerate(chunks):
            prefix = ""
            if chunk_metadata and i < len(chunk_metadata):
                meta = chunk_metadata[i]
                parts = []
                if meta.get("section_number"):
                    parts.append(f"Section {meta['section_number']}")
                if meta.get("heading"):
                    parts.append(meta["heading"])
                if meta.get("section"):
                    parts.append(meta["section"])
                if parts:
                    prefix = " | ".join(parts) + " | "
            enriched.append(prefix + chunk)

        uncached = []
        uncached_idx = []
        results = [None] * len(chunks)
        for i, chunk in enumerate(enriched):
            key = hashlib.md5(chunk.encode()).hexdigest()
            cached = self._cache.get(key)
            if cached is not None:
                results[i] = cached
            else:
                uncached.append(chunk)
                uncached_idx.append(i)
        print(f"[EMBED] Cache hits: {len(results) - len(uncached)}/{len(chunks)}, to encode: {len(uncached)}")
        if uncached:
            self._load_model()
            if self.model is None:
                for idx in uncached_idx:
                    results[idx] = [0.0] * self.dimension
                return results
            try:
                t0 = __import__("time").time()
                embeddings = self.model.encode(uncached, normalize_embeddings=True, show_progress_bar=False)
                duration = __import__("time").time() - t0
                print(f"[EMBED] Encoded {len(uncached)} chunks in {duration:.2f}s")
                for idx, emb in zip(uncached_idx, embeddings):
                    val = emb.tolist()
                    results[idx] = val
                    if len(self._cache) >= self._cache_max:
                        self._cache.clear()
                    self._cache[hashlib.md5(enriched[idx].encode()).hexdigest()] = val
            except Exception as e:
                logger.error(f"embed_chunks encode failed: {e}")
                for idx in uncached_idx:
                    results[idx] = [0.0] * self.dimension

        if document_id and organization_id and pinecone_service.available:
            try:
                vectors = []
                for i, (chunk, emb) in enumerate(zip(chunks, results)):
                    vid = f"{document_id}_{hashlib.md5(chunk.encode()).hexdigest()}"
                    meta = {
                        "document_id": document_id,
                        "organization_id": organization_id,
                        "chunk_index": i,
                        "chunk_text": chunk[:32000],
                    }
                    if chunk_metadata and i < len(chunk_metadata):
                        cm = chunk_metadata[i]
                        if cm.get("heading"):
                            meta["heading"] = cm["heading"]
                        if cm.get("page_number"):
                            meta["page_number"] = cm["page_number"]
                        if cm.get("document_type"):
                            meta["document_type"] = cm["document_type"]
                        if cm.get("phase3_agent"):
                            meta["phase3_agent"] = cm["phase3_agent"]
                        if cm.get("section"):
                            meta["section"] = cm["section"]
                        if cm.get("section_number"):
                            meta["section_number"] = cm["section_number"]
                        if cm.get("machine_id"):
                            meta["machine_id"] = cm["machine_id"]
                        if cm.get("filename"):
                            meta["filename"] = cm["filename"]
                    vectors.append((vid, emb, meta))
                print(f"[EMBED] Upserting {len(vectors)} vectors to Pinecone (namespace={organization_id})...")
                t0 = __import__("time").time()
                pinecone_service.upsert(vectors, namespace=organization_id)
                print(f"[EMBED] Pinecone upsert done in {__import__('time').time()-t0:.2f}s")
            except Exception as e:
                logger.error(f"embed_chunks pinecone upsert failed: {e}")
                print(f"[EMBED] Pinecone upsert FAILED: {e}")
        return results

    def embed_query(self, query: str) -> list[float]:
        return self.embed_text(query)

embedding_service = EmbeddingService()
