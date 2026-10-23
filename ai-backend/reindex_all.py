"""
One-off script: re-index ALL documents using the improved field-label heading detection.
Run from ai-backend/ directory:
    python reindex_all.py
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from app.database import SupabaseDB, _get_supabase
from app.services import rag_service
from app.services.pinecone_service import pinecone_service

# index_document is a method on the RAGService singleton instance
rag = rag_service.rag_service


def delete_old_chunks(document_id: str, organization_id: str):
    # Pinecone
    if pinecone_service.available:
        try:
            pinecone_service.delete_by_document(document_id, namespace=organization_id)
        except Exception as e:
            print(f"  [WARN] Pinecone delete failed: {e}")
    # Supabase
    try:
        client = _get_supabase()
        if client:
            client.table("document_chunks").delete().eq("document_id", document_id).execute()
            client.table("document_embeddings").delete().eq("document_id", document_id).execute()
    except Exception as e:
        print(f"  [WARN] Supabase delete failed: {e}")


def main():
    print("[REINDEX] Fetching all documents...")
    docs = []
    try:
        client = _get_supabase()
        if client:
            res = client.table("documents").select(
                "id, organization_id, raw_text, document_type, status"
            ).execute()
            docs = getattr(res, "data", []) or []
    except Exception as e:
        print(f"[REINDEX] Supabase fetch failed: {e}")
        return

    if not docs:
        print("[REINDEX] No documents found.")
        return

    print(f"[REINDEX] Found {len(docs)} documents.")
    done = 0
    skipped = 0
    for d in docs:
        doc_id = d.get("id")
        org_id = d.get("organization_id")
        raw_text = d.get("raw_text") or ""
        doc_type = d.get("document_type")
        if not doc_id or not org_id or not raw_text.strip():
            skipped += 1
            continue
        print(f"\n[REINDEX] ({done + 1}/{len(docs)}) doc={doc_id[:12]} type={doc_type} chars={len(raw_text)}")
        try:
            delete_old_chunks(doc_id, org_id)
            rag.index_document(
                doc_id, org_id, raw_text, None,
                document_type=doc_type,
            )
            done += 1
        except Exception as e:
            print(f"  [ERROR] index failed: {e}")
            skipped += 1

    print(f"\n[REINDEX] DONE. reindexed={done}, skipped={skipped}")


if __name__ == "__main__":
    main()
