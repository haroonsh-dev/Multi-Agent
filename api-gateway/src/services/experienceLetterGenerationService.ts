import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import { v4 as uuidv4 } from 'uuid';
import Document from '../models/Document';
import { AuthUser } from './accessScope';
import {
    applyDocumentTypeStorage,
    ensureUploadDir,
    getDocumentDir,
    resolveOrgFolder,
} from './documentStorage';
import { sanitizeFilename } from '../utils/fileValidation';
import {
    generateExperienceLetterPdf,
    resolveDocumentAiOrgId,
} from './aiServiceClient';
import { decodeOfferLetterPdfBase64, HR_AGENT } from './offerLetterGenerationService';
import logger from '../utils/logger';

export type ExperiencePayload = Record<string, unknown>;

/**
 * Generate experience certificate PDF and save as a ready artifact (no AI reprocess).
 * Same pattern as compliance/HR chat-generated PDFs so Open/Print works immediately.
 */
export async function createExperienceLetterFromResume(
    user: AuthUser,
    sourceDocumentId: string,
    experience: ExperiencePayload
): Promise<{ source: InstanceType<typeof Document>; letterDoc: InstanceType<typeof Document> }> {
    const source = await Document.findOne({ documentId: sourceDocumentId });
    if (!source) {
        throw Object.assign(new Error('Source resume not found'), { statusCode: 404 });
    }
    if (!source.pythonDocumentId) {
        throw Object.assign(new Error('Resume is not linked to AI processing yet'), { statusCode: 400 });
    }

    const aiOrgId = resolveDocumentAiOrgId(source, user);
    const generated = await generateExperienceLetterPdf({
        pythonDocumentId: source.pythonDocumentId,
        organizationId: aiOrgId,
        experience,
    });

    const buf = decodeOfferLetterPdfBase64(generated);
    ensureUploadDir();

    const documentId = `doc_${uuidv4()}`;
    const orgFolder = resolveOrgFolder(user.organizationId, user.userId);
    const destDir = getDocumentDir(orgFolder, documentId, { inbox: true });
    fs.mkdirSync(destDir, { recursive: true });

    const originalFilename = sanitizeFilename(
        generated.filename || `Experience_Letter_${Date.now()}.pdf`
    );
    const storagePath = path.join(destDir, originalFilename);
    fs.writeFileSync(storagePath, buf);

    const contentHash = crypto.createHash('sha256').update(buf).digest('hex');

    const letterDoc = await Document.create({
        documentId,
        organizationId: user.organizationId || null,
        uploadedBy: user.userId,
        openRemoteUserId: (user as { openRemoteUserId?: string | null }).openRemoteUserId || null,
        originalFilename,
        storedFilename: originalFilename,
        mimeType: generated.mime_type || 'application/pdf',
        sizeBytes: buf.length,
        storagePath,
        contentHash,
        pythonDocumentId: null,
        aiProcessingStatus: null,
        aiErrorMessage: null,
        status: 'ready',
        classification: 'experience_letter',
        metadata: {
            source: 'hr_chat',
            phase3Agent: HR_AGENT,
            generatedVia: 'experience_letter',
            generatedFromDocumentId: source.documentId,
            generatedFromFilename: source.originalFilename,
            storageLayout: 'by-type',
            storageType: 'inbox',
            aiSynced: false,
        },
    });

    try {
        const { applyDocumentVisibilityScope } = await import('./documentVisibility');
        await applyDocumentVisibilityScope(letterDoc, null);
        await letterDoc.save();
    } catch (e: any) {
        logger.warn(`Experience letter visibility failed for ${letterDoc.documentId}: ${e?.message || e}`);
    }

    try {
        await applyDocumentTypeStorage(letterDoc, 'experience_letter');
        await letterDoc.save();
    } catch (e: any) {
        logger.warn(`Experience letter storage relocate failed for ${letterDoc.documentId}: ${e?.message || e}`);
    }

    return { source, letterDoc };
}
