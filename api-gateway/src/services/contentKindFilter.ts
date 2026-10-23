/**
 * Documents vs Integrations content split.
 * - file: uploaded / pulled files (PDF, DOCX, images) — Path 1
 * - record: structured API/JSON ingest — Path 2 (metadata.ingestKind === 'structured_record')
 * - all: both
 */
export type ContentKind = 'file' | 'record' | 'all';

export function parseContentKind(raw: unknown, fallback: ContentKind = 'file'): ContentKind {
    const v = String(raw || '')
        .trim()
        .toLowerCase();
    if (v === 'file' || v === 'files' || v === 'document' || v === 'documents') return 'file';
    if (v === 'record' || v === 'records' || v === 'synced' || v === 'integration') return 'record';
    if (v === 'all' || v === 'both') return 'all';
    return fallback;
}

/** Mongo filter fragment for contentKind. Safe to Object.assign onto existing filters. */
export function contentKindMongoFilter(kind: ContentKind): Record<string, unknown> {
    if (kind === 'record') {
        return { 'metadata.ingestKind': 'structured_record' };
    }
    if (kind === 'file') {
        // $ne also matches missing field — correct for legacy file uploads
        return { 'metadata.ingestKind': { $ne: 'structured_record' } };
    }
    return {};
}

export function isStructuredRecordMeta(metadata: unknown): boolean {
    if (!metadata || typeof metadata !== 'object') return false;
    return (metadata as { ingestKind?: string }).ingestKind === 'structured_record';
}
