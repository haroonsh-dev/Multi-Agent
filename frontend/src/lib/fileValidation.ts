export const ALLOWED_EXTENSIONS = [
    '.pdf', '.png', '.jpg', '.jpeg', '.tif', '.tiff', '.docx', '.xlsx', '.pptx', '.txt',
];

export function isAllowedFile(file: File): boolean {
    const name = file.name.toLowerCase();
    return ALLOWED_EXTENSIONS.some((ext) => name.endsWith(ext));
}

export function filterAllowedFiles(files: FileList | File[]): { allowed: File[]; rejected: string[] } {
    const list = Array.from(files);
    const allowed: File[] = [];
    const rejected: string[] = [];
    for (const f of list) {
        if (isAllowedFile(f)) allowed.push(f);
        else rejected.push(f.name);
    }
    return { allowed, rejected };
}

export const ACCEPT_ATTR = ALLOWED_EXTENSIONS.join(',');

export const FILE_TYPE_OPTIONS = [
    { value: '', label: 'All types' },
    { value: 'pdf', label: 'PDF' },
    { value: 'image', label: 'Images' },
    { value: 'docx', label: 'Word (DOCX)' },
    { value: 'xlsx', label: 'Excel (XLSX)' },
    { value: 'pptx', label: 'PowerPoint (PPTX)' },
    { value: 'txt', label: 'Text (TXT)' },
] as const;

export const FILE_TYPE_MIME: Record<string, string> = {
    pdf: 'application/pdf',
    image: 'image/',
    docx: 'wordprocessingml',
    xlsx: 'spreadsheetml',
    pptx: 'presentationml',
    txt: 'text/plain',
};

export function getFileTypeLabel(mimeType?: string, filename?: string): string {
    if (mimeType?.includes('pdf')) return 'PDF';
    if (mimeType?.startsWith('image/')) return 'Image';
    if (mimeType?.includes('wordprocessingml') || filename?.toLowerCase().endsWith('.docx')) return 'DOCX';
    if (mimeType?.includes('spreadsheetml') || filename?.toLowerCase().endsWith('.xlsx')) return 'XLSX';
    if (mimeType?.includes('presentationml') || filename?.toLowerCase().endsWith('.pptx')) return 'PPTX';
    if (mimeType === 'text/plain' || filename?.toLowerCase().endsWith('.txt')) return 'TXT';
    if (filename) {
        const ext = filename.slice(filename.lastIndexOf('.')).toUpperCase();
        if (ext.length > 1) return ext.slice(1);
    }
    return 'File';
}

