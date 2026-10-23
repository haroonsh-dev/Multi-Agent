import os
import sys

sys.path.append(os.path.dirname(__file__))
from app.database import _get_supabase
from app.services.pinecone_service import pinecone_service

def clean_orphaned_chunks():
    client = _get_supabase()
    if not client:
        print("Supabase client not initialized.")
        return

    print("Fetching active document IDs from Supabase 'documents' table...")
    active_docs_res = client.table("documents").select("id").execute()
    active_ids = set(doc["id"] for doc in active_docs_res.data)
    print(f"Found {len(active_ids)} active documents.")

    print("Fetching all chunk document IDs...")
    chunks_res = client.table("document_chunks").select("document_id").execute()
    chunk_ids = set(chunk["document_id"] for chunk in chunks_res.data)
    print(f"Found chunks for {len(chunk_ids)} distinct documents.")

    orphaned_ids = chunk_ids - active_ids
    print(f"Found {len(orphaned_ids)} orphaned document IDs: {orphaned_ids}")

    if not orphaned_ids:
        print("No orphaned files found. Your database is clean!")
        return

    for doc_id in orphaned_ids:
        print(f"Deleting orphaned chunks for document: {doc_id}")
        try:
            ns = ""
            chunk_org = (
                client.table("document_chunks")
                .select("organization_id")
                .eq("document_id", doc_id)
                .limit(1)
                .execute()
            )
            if chunk_org.data and chunk_org.data[0].get("organization_id"):
                ns = chunk_org.data[0]["organization_id"]
            if pinecone_service.available:
                pinecone_service.delete_by_document(doc_id, namespace=ns)
                print(f"  - Deleted from Pinecone (namespace={ns!r})")
            
            # Delete from Supabase
            client.table("document_chunks").delete().eq("document_id", doc_id).execute()
            client.table("document_embeddings").delete().eq("document_id", doc_id).execute()
            client.table("document_extractions").delete().eq("document_id", doc_id).execute()
            print(f"  - Deleted from Supabase")
        except Exception as e:
            print(f"  [ERROR] Failed to delete {doc_id}: {e}")

    print("Cleanup complete!")

if __name__ == "__main__":
    clean_orphaned_chunks()
