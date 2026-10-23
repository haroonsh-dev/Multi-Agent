import { getAuthValue } from './authSession';

const API_BASE = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:5100/api';

export function getDocumentPreviewUrl(documentId: string): string {
    const token = getAuthValue('accessToken') || getAuthValue('token');
    const base = `${API_BASE}/docs/documents/${documentId}/preview`;
    return token ? `${base}?token=${encodeURIComponent(token)}` : base;
}

export function getDocumentDownloadUrl(documentId: string): string {
    const token = getAuthValue('accessToken') || getAuthValue('token');
    const base = `${API_BASE}/docs/documents/${documentId}/download`;
    return token ? `${base}?token=${encodeURIComponent(token)}` : base;
}

export function appendAuthToken(url: string): string {
    const token = getAuthValue('accessToken') || getAuthValue('token');
    if (!token || url.includes('token=')) return url;
    return `${url}${url.includes('?') ? '&' : '?'}token=${encodeURIComponent(token)}`;
}

export function getDocumentAiAssetUrl(documentId: string, assetPath: string): string {
    const base = `${API_BASE}/docs/documents/${documentId}/ai-file?path=${encodeURIComponent(assetPath)}`;
    return appendAuthToken(base);
}

export function getDocumentAiImageUrl(documentId: string, imagePath: string): string {
    return getDocumentAiAssetUrl(documentId, imagePath);
}

export function canPreviewMime(mime: string): boolean {
    return (
        mime.startsWith('image/') ||
        mime.startsWith('text/') ||
        mime.startsWith('audio/') ||
        mime.startsWith('video/') ||
        mime === 'application/pdf' ||
        mime === 'text/csv' ||
        mime === 'application/json' ||
        mime === 'application/xml' ||
        mime === 'text/xml' ||
        mime === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
        mime === 'application/msword' ||
        mime === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' ||
        mime === 'application/vnd.ms-excel' ||
        mime === 'application/vnd.openxmlformats-officedocument.presentationml.presentation' ||
        mime === 'application/vnd.ms-powerpoint'
    );
}
