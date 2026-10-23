import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import { v4 as uuidv4 } from 'uuid';
import Document, { IDocument } from '../models/Document';
import DocumentChunk from '../models/DocumentChunk';
import type { AIProvider } from '../models/ApiKey';
import { isAllowedFile, sanitizeFilename } from '../utils/fileValidation';
import { AuthUser, canDeleteDocument } from './accessScope';
import { invalidateDuplicateCache } from './duplicateDetection';
import {
    AiUploadResult,
    deleteDocumentFromAi,
    isAiServiceEnabled,
    resolveAiOrganizationId,
    resolveDocumentAiOrgId,
    setAiPrimaryProvider,
    uploadDocumentToAi,
} from './aiServiceClient';
import logger from '../utils/logger';

const VM_MAIN_ROOT = path.resolve(process.cwd(), '..');

/** Shared folder used by Node api-gateway and Python ai-backend */
export const UPLOAD_ROOT = process.env.SHARED_STORAGE_PATH
    ? path.resolve(process.env.SHARED_STORAGE_PATH)
    : path.join(VM_MAIN_ROOT, 'shared-storage');

/** Known document types → by-type/{type}/… folders */
export const KNOWN_DOCUMENT_TYPES = new Set([
    // Finance
    'invoice',
    'financial_statement',
    'expense_report',
    'payment_receipt',
    'tax_document',
    'bank_statement',
    'budget',
    // HR
    'employee_record',
    'hr_document',
    'offer_letter',
    'experience_letter',
    'employment_contract',
    'leave_application',
    'payroll',
    'attendance',
    'performance_review',
    'training_certificate',
    'resume',
    'transcript',
    // Legal
    'contract',
    'agreement',
    'nda',
    'service_agreement',
    'lease_agreement',
    'vendor_contract',
    // Procurement
    'purchase_order',
    'quotation',
    'supplier_agreement',
    'vendor_list',
    'rfq',
    'delivery_note',
    'procurement_request',
    // Compliance
    'sop',
    'audit_report',
    'quality_report',
    'certificate',
    'maintenance_report',
    'engineering_drawing',
    'inspection_report',
    'safety_manual',
    'iso_document',
    'compliance_form',
    'regulatory_document',
    'compliance_report',
    'ncr_letter',
    'capa_letter',
    'certificate_of_compliance',
    'finance_report',
    'integration_record',
    'other',
]);

/** Document type → specialist agent (keep in sync with frontend documentAgents.ts) */
export const DOC_TYPE_TO_AGENT: Record<string, string> = {
    invoice: 'finance_agent',
    financial_statement: 'finance_agent',
    expense_report: 'finance_agent',
    payment_receipt: 'finance_agent',
    tax_document: 'finance_agent',
    bank_statement: 'finance_agent',
    budget: 'finance_agent',
    employee_record: 'hr_agent',
    hr_document: 'hr_agent',
    offer_letter: 'hr_agent',
    experience_letter: 'hr_agent',
    employment_contract: 'hr_agent',
    leave_application: 'hr_agent',
    payroll: 'hr_agent',
    attendance: 'hr_agent',
    performance_review: 'hr_agent',
    training_certificate: 'hr_agent',
    resume: 'hr_agent',
    transcript: 'hr_agent',
    contract: 'legal_agent',
    agreement: 'legal_agent',
    nda: 'legal_agent',
    service_agreement: 'legal_agent',
    lease_agreement: 'legal_agent',
    vendor_contract: 'legal_agent',
    purchase_order: 'procurement_agent',
    po: 'procurement_agent',
    quotation: 'procurement_agent',
    supplier_agreement: 'procurement_agent',
    vendor_list: 'procurement_agent',
    rfq: 'procurement_agent',
    delivery_note: 'procurement_agent',
    procurement_request: 'procurement_agent',
    sop: 'compliance_agent',
    audit_report: 'compliance_agent',
    quality_report: 'compliance_agent',
    certificate: 'compliance_agent',
    maintenance_report: 'compliance_agent',
    engineering_drawing: 'compliance_agent',
    inspection_report: 'compliance_agent',
    safety_manual: 'compliance_agent',
    iso_document: 'compliance_agent',
    compliance_form: 'compliance_agent',
    regulatory_document: 'compliance_agent',
    compliance_report: 'compliance_agent',
    ncr_letter: 'compliance_agent',
    capa_letter: 'compliance_agent',
    certificate_of_compliance: 'compliance_agent',
    finance_report: 'finance_agent',
    other: 'other_agent',
    integration_record: 'other_agent',
};

/**
 * Agent that owns a file for chat/analytics scope.
 * Filename + classification win over metadata.phase3Agent so a CV processed
 * with Finance Agent is still an HR file (and vice versa).
 */
export function resolveCanonicalAgent(doc: {
    originalFilename?: string | null;
    classification?: string | null;
    metadata?: { phase3Agent?: string; naturalAgent?: string } | null;
    phase3Agent?: string | null;
}): string {
    const fromName = inferDocumentTypeFromFilename(doc.originalFilename || '');
    if (fromName && DOC_TYPE_TO_AGENT[fromName] && DOC_TYPE_TO_AGENT[fromName] !== 'other_agent') {
        return DOC_TYPE_TO_AGENT[fromName];
    }
    const raw = String(doc.classification || '')
        .trim()
        .toLowerCase()
        .replace(/[\s-]+/g, '_');
    const cls = raw === 'cv' || raw === 'curriculum_vitae' ? 'resume' : raw;
    if (cls && cls !== 'other' && DOC_TYPE_TO_AGENT[cls]) return DOC_TYPE_TO_AGENT[cls];
    if (doc.metadata?.naturalAgent) return String(doc.metadata.naturalAgent);
    if (doc.metadata?.phase3Agent) return String(doc.metadata.phase3Agent);
    if (doc.phase3Agent) return String(doc.phase3Agent);
    if (/\.(xlsx?|csv|tsv|ods)$/i.test(doc.originalFilename || '')) return 'finance_agent';
    return 'other_agent';
}

export function docBelongsToAgent(
    doc: Parameters<typeof resolveCanonicalAgent>[0],
    agentId: string
): boolean {
    return resolveCanonicalAgent(doc) === agentId;
}

export function filterDocsByAgent<T extends Parameters<typeof resolveCanonicalAgent>[0]>(
    docs: T[],
    agentId: string
): T[] {
    return docs.filter((d) => docBelongsToAgent(d, agentId));
}

/** Doc types an org may assign to departments, limited to agents on their plan. */
export function documentTypesForAgents(agentIds: string[]): string[] {
    const allowed = new Set(agentIds);
    // Always allow "other" vault type when other_agent is on plan (or when plan is empty → free other)
    return Array.from(KNOWN_DOCUMENT_TYPES).filter((t) => {
        const agent = DOC_TYPE_TO_AGENT[t] || 'other_agent';
        return allowed.has(agent);
    });
}

export function normalizeDocumentTypesToOrgPlan(
    raw: unknown,
    orgAgentIds: string[]
): string[] {
    if (!Array.isArray(raw)) return [];
    const allowedTypes = new Set(documentTypesForAgents(orgAgentIds));
    return [
        ...new Set(
            raw
                .map((t) => normalizeDocumentType(String(t)))
                .filter((t) => allowedTypes.has(t))
        ),
    ];
}

export function ensureUploadDir() {
    if (!fs.existsSync(UPLOAD_ROOT)) {
        fs.mkdirSync(UPLOAD_ROOT, { recursive: true });
    }
}

export function resolveOrgFolder(organizationId?: string | null, userId?: string | null): string {
    if (organizationId) return organizationId;
    if (userId) return `personal_${userId}`;
    return 'personal_unknown';
}

export function normalizeDocumentType(raw?: string | null): string {
    if (!raw) return 'other';
    let t = String(raw).trim().toLowerCase().replace(/[\s-]+/g, '_');
    if (t === 'cv' || t === 'curriculum_vitae' || t === 'curriculum') t = 'resume';
    if (t === 'po') t = 'purchase_order';
    if (t === 'hr') t = 'hr_document';
    if (t === 'non_disclosure' || t === 'non_disclosure_agreement') t = 'nda';
    if (t === 'request_for_quotation') t = 'rfq';
    if (!KNOWN_DOCUMENT_TYPES.has(t)) return 'other';
    return t;
}

export function inferDocumentTypeFromFilename(filename: string): string | null {
    const name = filename.toLowerCase();
    if (/\b(cv|cvs|resume|curriculum|biodata|bio[\s_-]?data)\b/.test(name)) return 'resume';
    if (name.includes('invoice')) return 'invoice';
    if (name.includes('nda') || name.includes('non-disclosure') || name.includes('non_disclosure')) return 'nda';
    if (name.includes('service') && name.includes('agreement')) return 'service_agreement';
    if (name.includes('lease') && name.includes('agreement')) return 'lease_agreement';
    if (name.includes('vendor') && name.includes('contract')) return 'vendor_contract';
    if (name.includes('contract') || name.includes('agreement')) return 'contract';
    if (name.includes('quotation') || name.includes('quote')) return 'quotation';
    if (name.includes('purchase') || /\bpo\b/.test(name)) return 'purchase_order';
    if (name.includes('rfq')) return 'rfq';
    if (name.includes('audit')) return 'audit_report';
    if (name.includes('certificate')) return 'certificate';
    if (name.includes('transcript')) return 'transcript';
    if (name.includes('sop')) return 'sop';
    if (name.includes('payroll')) return 'payroll';
    if (name.includes('offer') && name.includes('letter')) return 'offer_letter';
    if (name.includes('experience') && name.includes('letter')) return 'experience_letter';
    if (name.includes('joining') && name.includes('letter')) return 'joining_letter';
    if (name.includes('internship') && name.includes('letter')) return 'internship_letter';
    if (name.includes('promotion') && name.includes('letter')) return 'promotion_letter';
    if (name.includes('relieving') && name.includes('letter')) return 'relieving_letter';
    if (name.includes('warning') && name.includes('letter')) return 'warning_letter';
    return null;
}

function yyyyMm(date: Date = new Date()): { yyyy: string; mm: string } {
    const yyyy = String(date.getUTCFullYear());
    const mm = String(date.getUTCMonth() + 1).padStart(2, '0');
    return { yyyy, mm };
}

/**
 * Layout:
 *   orgs/{orgId}/by-type/{documentType}/{yyyy}/{mm}/{documentId}/
 * Unclassified inbox:
 *   orgs/{orgId}/by-type/other/inbox/{documentId}/
 */
export function getDocumentDir(
    orgFolder: string,
    documentId: string,
    options?: {
        documentType?: string | null;
        createdAt?: Date | string | null;
        inbox?: boolean;
    }
): string {
    if (options?.inbox) {
        return path.join(UPLOAD_ROOT, 'orgs', orgFolder, 'by-type', 'other', 'inbox', documentId);
    }

    const type = normalizeDocumentType(options?.documentType);
    const when = options?.createdAt ? new Date(options.createdAt) : new Date();
    const { yyyy, mm } = yyyyMm(Number.isNaN(when.getTime()) ? new Date() : when);
    return path.join(UPLOAD_ROOT, 'orgs', orgFolder, 'by-type', type, yyyy, mm, documentId);
}

/** @deprecated Prefer getDocumentDir with type options — kept for callers expecting old signature */
export function getLegacyDocumentDir(orgFolder: string, documentId: string) {
    return path.join(UPLOAD_ROOT, 'orgs', orgFolder, 'documents', documentId);
}

export function deleteDocumentFolder(storagePath: string) {
    const dir = path.dirname(storagePath);
    if (fs.existsSync(dir)) {
        fs.rmSync(dir, { recursive: true, force: true });
    }
    // Clean empty parent month/year folders (best-effort)
    try {
        let parent = path.dirname(dir);
        for (let i = 0; i < 3; i++) {
            if (!fs.existsSync(parent)) break;
            const entries = fs.readdirSync(parent);
            if (entries.length > 0) break;
            fs.rmdirSync(parent);
            parent = path.dirname(parent);
        }
    } catch {
        /* ignore */
    }
}

/**
 * Move document folder into by-type/{type}/{yyyy}/{mm}/{documentId}/ and return new storagePath.
 * No-op if already at the correct location.
 */
export function relocateDocumentOnDisk(
    doc: {
        documentId: string;
        storagePath: string;
        storedFilename: string;
        organizationId?: string | null;
        uploadedBy: string;
        createdAt?: Date | string;
        classification?: string | null;
    },
    documentType: string
): { storagePath: string; moved: boolean; destDir: string } {
    const type = normalizeDocumentType(documentType);
    const orgFolder = resolveOrgFolder(doc.organizationId, doc.uploadedBy);
    const destDir = getDocumentDir(orgFolder, doc.documentId, {
        documentType: type,
        createdAt: doc.createdAt || new Date(),
        inbox: false,
    });

    const currentDir = path.dirname(doc.storagePath);
    const newStoragePath = path.join(destDir, doc.storedFilename || path.basename(doc.storagePath));

    if (path.resolve(currentDir) === path.resolve(destDir)) {
        return { storagePath: doc.storagePath, moved: false, destDir };
    }

    fs.mkdirSync(destDir, { recursive: true });

    if (fs.existsSync(doc.storagePath)) {
        // Move whole document directory contents if currentDir is the doc folder
        if (path.basename(currentDir) === doc.documentId && fs.existsSync(currentDir)) {
            // Move each entry into destDir (handles original + any derived files)
            for (const name of fs.readdirSync(currentDir)) {
                const from = path.join(currentDir, name);
                const to = path.join(destDir, name);
                if (fs.existsSync(to)) {
                    fs.rmSync(to, { recursive: true, force: true });
                }
                fs.renameSync(from, to);
            }
            try {
                fs.rmSync(currentDir, { recursive: true, force: true });
            } catch {
                /* ignore */
            }
        } else {
            fs.renameSync(doc.storagePath, newStoragePath);
        }
    } else if (!fs.existsSync(newStoragePath)) {
        logger.warn(`relocateDocumentOnDisk: source missing ${doc.storagePath}`);
        return { storagePath: doc.storagePath, moved: false, destDir };
    }

    // Clean empty old parents
    try {
        let parent = currentDir;
        for (let i = 0; i < 4; i++) {
            if (!fs.existsSync(parent)) break;
            if (fs.readdirSync(parent).length > 0) break;
            fs.rmdirSync(parent);
            parent = path.dirname(parent);
        }
    } catch {
        /* ignore */
    }

    const finalPath = fs.existsSync(newStoragePath)
        ? newStoragePath
        : path.join(destDir, doc.storedFilename || path.basename(doc.storagePath));

    logger.info(`Relocated document ${doc.documentId} → ${finalPath}`);
    return { storagePath: finalPath, moved: true, destDir };
}

/** Apply type-based folder layout and persist storagePath on the mongoose doc (caller may save). */
export async function applyDocumentTypeStorage(
    doc: InstanceType<typeof Document>,
    documentType: string
): Promise<boolean> {
    const type = normalizeDocumentType(documentType);
    if (!type) return false;

    const result = relocateDocumentOnDisk(
        {
            documentId: doc.documentId,
            storagePath: doc.storagePath,
            storedFilename: doc.storedFilename,
            organizationId: doc.organizationId,
            uploadedBy: doc.uploadedBy,
            createdAt: doc.createdAt,
            classification: doc.classification,
        },
        type
    );

    if (result.moved) {
        doc.storagePath = result.storagePath;
        doc.metadata = {
            ...(doc.metadata || {}),
            storageLayout: 'by-type',
            storageType: type,
        };
    }
    return result.moved;
}

export async function deleteDocumentFully(
    documentId: string,
    storagePath: string,
    options?: { pythonDocumentId?: string | null; aiOrgId?: string }
) {
    deleteDocumentFolder(storagePath);
    await Promise.all([
        DocumentChunk.deleteMany({ documentId }),
        Document.deleteOne({ documentId }),
    ]);
    invalidateDuplicateCache();

    // Non-blocking: clean up AI backend and Pinecone vectors in background so user doesn't wait
    if (options?.pythonDocumentId && options.aiOrgId && isAiServiceEnabled()) {
        deleteDocumentFromAi(options.pythonDocumentId, options.aiOrgId).catch((e: any) => {
            logger.warn(`AI delete failed for ${documentId}: ${e.message}`);
        });
    }
}

export interface UploadFileInput {
    path: string;
    originalname: string;
    mimetype: string;
    size: number;
}

export type SaveUploadResult = {
    doc: IDocument;
    aiModelResponse: AiUploadResult | null;
    /** Automatic dedup / rename — no user "replace" prompt. */
    uploadNotes?: {
        replacedContentDuplicateId?: string;
        replacedContentDuplicateFilename?: string;
        renamedFrom?: string;
    };
};

function hashFileAtPath(filePath: string): string {
    const hash = crypto.createHash('sha256');
    const fd = fs.openSync(filePath, 'r');
    try {
        const buf = Buffer.alloc(1024 * 1024);
        let bytesRead = 0;
        while ((bytesRead = fs.readSync(fd, buf, 0, buf.length, null)) > 0) {
            hash.update(bytesRead === buf.length ? buf : buf.subarray(0, bytesRead));
        }
    } finally {
        fs.closeSync(fd);
    }
    return hash.digest('hex');
}

function escapeRegexLiteral(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function caseInsensitiveFilenameFilter(filename: string): Record<string, unknown> {
    const escaped = escapeRegexLiteral(filename.trim());
    return { originalFilename: { $regex: new RegExp(`^${escaped}$`, 'i') } };
}

/** Same display name, different bytes → auto `name (2).ext` (no UI). */
async function ensureUniqueDisplayFilename(
    scope: Record<string, unknown>,
    desired: string,
    contentHash: string
): Promise<{ name: string; renamedFrom?: string }> {
    let name = (desired || 'document').trim();
    const original = name;
    let suffix = 2;
    for (;;) {
        const collision = await Document.findOne({
            ...scope,
            ...caseInsensitiveFilenameFilter(name),
            contentHash: { $ne: contentHash },
        }).lean();
        if (!collision) {
            return name === original ? { name } : { name, renamedFrom: original };
        }
        const parsed = path.parse(name);
        const ext = parsed.ext || '';
        name = `${parsed.name} (${suffix})${ext}`;
        suffix += 1;
        if (suffix > 200) {
            throw Object.assign(new Error('Could not allocate a unique filename in your library'), {
                statusCode: 409,
                code: 'DUPLICATE_NAME',
            });
        }
    }
}

/**
 * The AI backend keeps a single active provider, so an upload-time choice has to be
 * applied right before the file is forwarded. Returns the provider actually applied.
 */
async function applyRequestedAiProvider(
    organizationId: string | null | undefined,
    provider?: string
): Promise<string | null> {
    const wanted = (provider || '').trim().toLowerCase();
    if (!wanted || !organizationId) return null;

    const { default: ApiKey } = await import('../models/ApiKey');
    const key = await ApiKey.findOne({ organizationId, provider: wanted as AIProvider }).lean();
    if (!key?.apiKey) {
        logger.warn(`Requested AI provider "${wanted}" has no API key for org ${organizationId} — using current provider`);
        return null;
    }

    await setAiPrimaryProvider({
        provider: wanted,
        apiKey: key.apiKey,
        model: key.aiModel || '',
        baseUrl: key.baseUrl || '',
    });
    return wanted;
}

export async function saveUploadedFile(
    user: AuthUser,
    file: UploadFileInput,
    phase3Agent?: string,
    aiProvider?: string
): Promise<SaveUploadResult> {
    const validation = isAllowedFile(file.originalname, file.mimetype);
    if (!validation.ok) {
        if (fs.existsSync(file.path)) fs.unlinkSync(file.path);
        throw Object.assign(new Error(validation.reason), { statusCode: 415 });
    }

    const contentHash = hashFileAtPath(file.path);

    // Content duplicates are organization-wide, regardless of whether the
    // first copy came from manual upload, Drive, webhook, or AI sync status.
    const duplicateScope = user.organizationId
        ? { organizationId: user.organizationId }
        : { uploadedBy: user.userId };

    const uploadNotes: SaveUploadResult['uploadNotes'] = {};

    const existingDup = await Document.findOne({
        ...duplicateScope,
        contentHash,
    }).lean();

    if (existingDup) {
        const mayRemove = await canDeleteDocument(user, existingDup);
        if (!mayRemove) {
            if (fs.existsSync(file.path)) fs.unlinkSync(file.path);
            throw Object.assign(
                new Error(
                    `This file is already in the library as "${existingDup.originalFilename}". You do not have permission to replace it.`
                ),
                {
                    statusCode: 409,
                    code: 'DUPLICATE_CONTENT',
                    existingDocumentId: existingDup.documentId,
                }
            );
        }
        await deleteDocumentFully(existingDup.documentId, existingDup.storagePath, {
            pythonDocumentId: existingDup.pythonDocumentId,
            aiOrgId: resolveDocumentAiOrgId(existingDup, user),
        });
        uploadNotes.replacedContentDuplicateId = existingDup.documentId;
        uploadNotes.replacedContentDuplicateFilename = existingDup.originalFilename;
        logger.info(
            `Content-duplicate upload: removed ${existingDup.documentId}, new bytes from "${file.originalname}"`
        );
    }

    const uniqueName = await ensureUniqueDisplayFilename(duplicateScope, file.originalname, contentHash);
    file.originalname = uniqueName.name;
    if (uniqueName.renamedFrom) {
        uploadNotes.renamedFrom = uniqueName.renamedFrom;
    }

    const documentId = `doc_${uuidv4()}`;
    const orgFolder = resolveOrgFolder(user.organizationId, user.userId);

    // Always land in inbox — filename is unreliable; AI/manual classify moves to by-type/{type}/…
    const destDir = getDocumentDir(orgFolder, documentId, { inbox: true });

    fs.mkdirSync(destDir, { recursive: true });

    const storedFilename = sanitizeFilename(file.originalname);
    const storagePath = path.join(destDir, storedFilename);
    fs.renameSync(file.path, storagePath);

    let pythonDocumentId: string | null = null;
    let aiProcessingStatus: string | null = null;
    let aiErrorMessage: string | null = null;
    let status: 'uploaded' | 'processing' | 'failed' = 'uploaded';
    let aiModelResponse: AiUploadResult | null = null;
    let aiOrgId: string | null = null;
    let appliedProvider: string | null = null;

    if (isAiServiceEnabled()) {
        try {
            aiOrgId = resolveAiOrganizationId(user);
            appliedProvider = await applyRequestedAiProvider(user.organizationId, aiProvider);
            let allowedAgents: string[] | undefined;
            if (user.role !== 'superAdmin' && user.organizationId) {
                const { getAllowedAgentsForUser } = await import('./planService');
                allowedAgents = await getAllowedAgentsForUser(user);
            }
            const aiResult = await uploadDocumentToAi({
                filePath: storagePath,
                originalFilename: file.originalname,
                mimeType: file.mimetype,
                organizationId: aiOrgId,
                title: file.originalname,
                phase3Agent: phase3Agent || undefined,
                uploadedBy: user.userId,
                allowedAgents,
            });
            pythonDocumentId = aiResult.id;
            aiProcessingStatus = aiResult.status;
            status = 'processing';
            aiModelResponse = aiResult;
        } catch (e: any) {
            const { extractGroqLimitError } = await import('./aiServiceClient');
            const groq = extractGroqLimitError(e);
            if (groq) {
                deleteDocumentFolder(storagePath);
                throw Object.assign(new Error(groq.message), {
                    statusCode: 429,
                    code: 'GROQ_RATE_LIMIT',
                    groq,
                });
            }
            aiErrorMessage = e.message || 'AI upload failed';
            status = 'failed';
            logger.warn(`AI forward failed for ${documentId}: ${aiErrorMessage}`);
        }
    }

    const doc = await Document.create({
        documentId,
        organizationId: user.organizationId || null,
        uploadedBy: user.userId,
        openRemoteUserId: (user as any).openRemoteUserId || null,
        originalFilename: file.originalname,
        storedFilename,
        mimeType: file.mimetype,
        sizeBytes: file.size,
        storagePath,
        contentHash,
        pythonDocumentId,
        aiProcessingStatus,
        aiErrorMessage,
        status,
        classification: null,
        metadata: {
            source: 'web_upload',
            aiSynced: !!pythonDocumentId,
            storageLayout: 'by-type',
            storageType: 'inbox',
            ...(phase3Agent ? { phase3Agent } : {}),
            ...(appliedProvider ? { aiProvider: appliedProvider } : {}),
            ...(pythonDocumentId && aiOrgId ? { aiOrgId } : {}),
            ...(uploadNotes.replacedContentDuplicateId
                ? {
                      replacedContentDuplicateId: uploadNotes.replacedContentDuplicateId,
                      replacedContentDuplicateFilename: uploadNotes.replacedContentDuplicateFilename,
                  }
                : {}),
            ...(uploadNotes.renamedFrom ? { renamedFrom: uploadNotes.renamedFrom } : {}),
        },
    });

    try {
        const { applyDocumentVisibilityScope } = await import('./documentVisibility');
        await applyDocumentVisibilityScope(doc, null);
        await doc.save();
    } catch (e: any) {
        logger.warn(`Initial visibility assignment failed for ${doc.documentId}: ${e?.message || e}`);
    }

    invalidateDuplicateCache();
    const hasNotes =
        uploadNotes.replacedContentDuplicateId || uploadNotes.renamedFrom ? uploadNotes : undefined;
    return { doc, aiModelResponse, uploadNotes: hasNotes };
}
