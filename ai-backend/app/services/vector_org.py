"""Resolve Pinecone namespace / DB org partition for vector search."""

import logging

logger = logging.getLogger("visibility-docs")


def resolve_vector_namespace(organization_id: str, document_ids: list[str] | None = None) -> str:
    """
    Pick the namespace used for Pinecone upsert/query.

    When the client scopes specific documents, use the org id stored on those
    documents in the AI DB if they agree; otherwise keep the request org id.
    """
    if not organization_id:
        return organization_id or ""
    if not document_ids:
        return organization_id

    ids = [d for d in document_ids if d][:80]
    if not ids:
        return organization_id

    orgs: set[str] = set()
    try:
        from ..database import SupabaseDB

        for did in ids:
            result = SupabaseDB.select(
                "documents",
                columns="organization_id",
                filters={"id": did},
                limit=1,
            )
            data = getattr(result, "data", result if isinstance(result, list) else [])
            if isinstance(data, list) and data:
                oid = data[0].get("organization_id") if isinstance(data[0], dict) else None
                if isinstance(oid, str) and oid.strip():
                    orgs.add(oid.strip())
    except Exception as e:
        logger.debug("resolve_vector_namespace lookup failed: %s", e)

    if len(orgs) == 1:
        resolved = next(iter(orgs))
        if resolved != organization_id:
            logger.info(
                "Vector namespace aligned to document org %s (request was %s)",
                resolved,
                organization_id,
            )
        return resolved

    if len(orgs) > 1:
        logger.warning(
            "Scoped documents span multiple vector orgs %s; using request org %s",
            orgs,
            organization_id,
        )
    return organization_id
