import path from 'path';
import fs from 'fs';
import { v4 as uuidv4 } from 'uuid';
import Document from '../models/Document';
import { AuthUser } from '../services/accessScope';
import {
    applyDocumentTypeStorage,
    ensureUploadDir,
    saveUploadedFile,
} from './documentStorage';
import {
    generateOfferLetterDocx,
    resolveAiOrganizationId,
    resolveDocumentAiOrgId,
    updateAiDocumentFilePath,
    updateAiDocumentSettings,
} from './aiServiceClient';
import logger from '../utils/logger';

export const HR_AGENT = 'hr_agent';

export type OfferPayload = Record<string, unknown>;

export function decodeOfferLetterPdfBase64(generated: {
    pdf_base64?: string;
    docx_base64?: string;
}): Buffer {
    const b64 = generated.pdf_base64 || generated.docx_base64;
    if (!b64) {
        throw new Error('AI did not return offer letter file data (pdf_base64 missing). Restart ai-backend.');
    }
    return Buffer.from(b64, 'base64');
}

export async function createOfferLetterFromResume(
    user: AuthUser,
    sourceDocumentId: string,
    offer: OfferPayload
): Promise<{ source: InstanceType<typeof Document>; offerDoc: InstanceType<typeof Document> }> {
    const source = await Document.findOne({ documentId: sourceDocumentId });
    if (!source) {
        throw Object.assign(new Error('Source resume not found'), { statusCode: 404 });
    }
    if (!source.pythonDocumentId) {
        throw Object.assign(new Error('Resume is not linked to AI processing yet'), { statusCode: 400 });
    }

    const aiOrgId = resolveDocumentAiOrgId(source, user);
    const generated = await generateOfferLetterDocx({
        pythonDocumentId: source.pythonDocumentId,
        organizationId: aiOrgId,
        offer,
    });

    const buf = decodeOfferLetterPdfBase64(generated);
    ensureUploadDir();
    const tmpDir = path.join(process.cwd(), 'uploads', '_tmp');
    if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });
    const tmpPath = path.join(tmpDir, `offer_${uuidv4()}.pdf`);
    fs.writeFileSync(tmpPath, buf);

    const { doc: saved } = await saveUploadedFile(
        user,
        {
            path: tmpPath,
            originalname: generated.filename,
            mimetype: generated.mime_type || 'application/pdf',
            size: buf.length,
        },
        HR_AGENT
    );

    const newDoc = await Document.findOne({ documentId: saved.documentId });
    if (!newDoc) {
        throw Object.assign(new Error('Failed to load saved offer letter'), { statusCode: 500 });
    }

    newDoc.classification = 'offer_letter';
    newDoc.metadata = {
        ...(newDoc.metadata || {}),
        phase3Agent: HR_AGENT,
        generatedFromDocumentId: source.documentId,
        generatedFromFilename: source.originalFilename,
        generatedVia: 'hr_chat',
    };

    if (newDoc.pythonDocumentId) {
        try {
            await updateAiDocumentSettings({
                pythonDocumentId: newDoc.pythonDocumentId,
                organizationId: resolveAiOrganizationId(user),
                documentType: 'offer_letter',
                phase3Agent: HR_AGENT,
            });
        } catch (e: any) {
            logger.warn(`Offer letter AI type update failed for ${newDoc.documentId}: ${e?.message || e}`);
        }
    }

    try {
        const moved = await applyDocumentTypeStorage(newDoc, 'offer_letter');
        if (moved && newDoc.pythonDocumentId && fs.existsSync(newDoc.storagePath)) {
            await updateAiDocumentFilePath({
                pythonDocumentId: newDoc.pythonDocumentId,
                organizationId: resolveAiOrganizationId(user),
                filePath: newDoc.storagePath,
            });
        }
    } catch (e: any) {
        logger.warn(`Offer letter storage relocate failed for ${newDoc.documentId}: ${e?.message || e}`);
    }

    await newDoc.save();
    return { source, offerDoc: newDoc };
}
