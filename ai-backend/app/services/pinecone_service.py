from ..config import settings
import json
import logging

logger = logging.getLogger("visibility-docs")


def _normalize_metadata(meta):
    """Legacy Pinecone records can store metadata as a JSON string. Normalize to dict."""
    if isinstance(meta, dict):
        return meta
    if isinstance(meta, str):
        try:
            parsed = json.loads(meta)
            return parsed if isinstance(parsed, dict) else {}
        except Exception:
            return {}
    return {}


class PineconeService:
    def __init__(self):
        self._client = None
        self._index = None
        self._index_name = None
        self._dimension = 1024
        self._available = False
        self._init()

    def _init(self):
        api_key = settings.PINECONE_API_KEY
        # Hardcoded to 'visibilitydocsai' as requested by the user to prevent any -1024 suffix issues
        index_name = "visibilitydocsai"
        if not api_key:
            logger.warning("Pinecone not configured (missing API key)")
            return
        try:
            from pinecone import Pinecone, ServerlessSpec
            self._client = Pinecone(api_key=api_key)
            existing = [i.name for i in self._client.list_indexes()]
            if index_name not in existing:
                self._client.create_index(
                    name=index_name,
                    dimension=self._dimension,
                    metric="cosine",
                    spec=ServerlessSpec(cloud="aws", region="us-east-1"),
                )
                logger.info(f"Created Pinecone index: {index_name}")
            self._index = self._client.Index(index_name)
            self._index_name = index_name
            self._available = True
            logger.info(f"Pinecone connected: {index_name}")
        except Exception as e:
            logger.error(f"Pinecone init failed: {e}")

    def upsert(self, vectors: list[tuple[str, list[float], dict]], namespace: str = ""):
        if not self._available:
            print(f"[PINECONE] Not available - skipping upsert of {len(vectors)} vectors")
            return
        try:
            print(f"[PINECONE] Upserting {len(vectors)} vectors (ns='{namespace}')...")
            t0 = __import__("time").time()
            self._index.upsert(vectors=vectors, namespace=namespace)
            print(f"[PINECONE] Upsert done in {__import__('time').time()-t0:.2f}s")
        except Exception as e:
            logger.error(f"Pinecone upsert error: {e}")
            print(f"[PINECONE] Upsert FAILED: {e}")

    def query(self, embedding: list[float], top_k: int = 10, filter: dict = None, namespace: str = "", include_metadata: bool = True) -> list[dict]:
        if not self._available:
            print(f"[PINECONE] Not available - skipping query")
            return []
        try:
            print(f"[PINECONE] Query: top_k={top_k}, filter={filter}, ns='{namespace}'")
            t0 = __import__("time").time()
            result = self._index.query(
                vector=embedding,
                top_k=top_k,
                include_metadata=include_metadata,
                filter=filter,
                namespace=namespace,
            )
            duration = __import__("time").time() - t0
            matches = result.matches
            print(f"[PINECONE] Query returned {len(matches)} matches in {duration:.2f}s")
            return [
                {
                    "id": m.id,
                    "score": m.score,
                    "metadata": _normalize_metadata(m.metadata) if include_metadata else {},
                }
                for m in matches
            ]
        except Exception as e:
            logger.error(f"Pinecone query error: {e}")
            print(f"[PINECONE] Query FAILED: {e}")
            return []

    def delete_by_document(self, document_id: str, namespace: str = ""):
        if not self._available:
            return
        try:
            print(f"[PINECONE] Delete vectors for document: {document_id} (ns='{namespace}')")
            self._index.delete(filter={"document_id": document_id}, namespace=namespace)
            print(f"[PINECONE] Document vectors deleted")
        except Exception as e:
            logger.error(f"Pinecone delete_by_document error: {e}")

    @property
    def available(self):
        return self._available


pinecone_service = PineconeService()
