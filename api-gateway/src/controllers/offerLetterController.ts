import { Request, Response, NextFunction } from 'express';
import Document from '../models/Document';
import Organization from '../models/Organization';
import { canAccessDocument, hasPermission } from '../services/accessScope';
import { inferDocumentTypeFromFilename } from '../services/documentStorage';
import { createOfferLetterFromResume, HR_AGENT } from '../services/offerLetterGenerationService';
import {
    getOfferLetterPrefill,
    isAiServiceEnabled,
    resolveDocumentAiOrgId,
} from '../services/aiServiceClient';
import { PERMISSIONS } from '../types/permissions';

function isResumeSource(doc: InstanceType<typeof Document>): boolean {
    const classification = String(doc.classification || '').toLowerCase();
    if (classification === 'resume' || classification === 'cv') return true;
    const inferred = inferDocumentTypeFromFilename(doc.originalFilename || '');
    if (inferred === 'resume') return true;
    return /\b(cv|cvs|resume|curriculum|biodata|bio[\s_-]?data)\b/i.test(doc.originalFilename || '');
}

export const getOfferLetterPrefillForDocument = async (
    req: Request,
    res: Response,
    next: NextFunction
) => {
    try {
        if (!hasPermission(req.user, PERMISSIONS.DOCUMENT_VIEW)) {
            return res.status(403).json({ success: false, message: 'Forbidden' });
        }
        if (!isAiServiceEnabled()) {
            return res.status(503).json({ success: false, message: 'AI service is not available' });
        }

        const doc = await Document.findOne({ documentId: req.params.id });
        if (!doc) {
            return res.status(404).json({ success: false, message: 'Document not found' });
        }
        if (!(await canAccessDocument(req.user, doc))) {
            return res.status(403).json({ success: false, message: 'Forbidden' });
        }
        if (!isResumeSource(doc)) {
            return res.status(400).json({
                success: false,
                message: 'Offer letters can only be generated from resume or CV documents',
            });
        }
        if (!doc.pythonDocumentId) {
            return res.status(400).json({
                success: false,
                message: 'Resume is not linked to AI processing yet. Wait for analysis to finish.',
            });
        }

        if (req.user.role !== 'superAdmin') {
            const { requireAllowedAgent } = await import('../services/planService');
            const check = await requireAllowedAgent(req.user, HR_AGENT);
            if (!check.ok) {
                return res.status(403).json({
                    success: false,
                    code: check.code,
                    message: check.message,
                    data: { allowedAgents: check.entitlement.agentIds },
                });
            }
        }

        const orgId = resolveDocumentAiOrgId(doc, req.user);
        const result = await getOfferLetterPrefill(doc.pythonDocumentId, orgId);
        if (!result) {
            return res.status(502).json({
                success: false,
                message:
                    'Could not load resume fields from AI (timeout or AI busy). Ensure ai-backend is running and retry in a few seconds.',
            });
        }

        let organizationName: string | undefined;
        if (req.user.organizationId) {
            const org = await Organization.findOne({ organizationId: req.user.organizationId })
                .select('organizationName')
                .lean();
            organizationName = org?.organizationName;
        }

        res.json({
            success: true,
            data: {
                ...result,
                organizationName,
            },
        });
    } catch (error) {
        next(error);
    }
};

export const generateOfferLetterFromResume = async (
    req: Request,
    res: Response,
    next: NextFunction
) => {
    try {
        if (!hasPermission(req.user, PERMISSIONS.DOCUMENT_UPLOAD)) {
            return res.status(403).json({ success: false, message: 'Forbidden' });
        }
        if (!isAiServiceEnabled()) {
            return res.status(503).json({ success: false, message: 'AI service is not available' });
        }

        const source = await Document.findOne({ documentId: req.params.id });
        if (!source) {
            return res.status(404).json({ success: false, message: 'Document not found' });
        }
        if (!(await canAccessDocument(req.user, source))) {
            return res.status(403).json({ success: false, message: 'Forbidden' });
        }
        if (!isResumeSource(source)) {
            return res.status(400).json({
                success: false,
                message: 'Offer letters can only be generated from resume or CV documents',
            });
        }
        if (!source.pythonDocumentId) {
            return res.status(400).json({
                success: false,
                message: 'Resume is not linked to AI processing yet',
            });
        }

        if (req.user.role !== 'superAdmin') {
            const { requireAllowedAgent } = await import('../services/planService');
            const check = await requireAllowedAgent(req.user, HR_AGENT);
            if (!check.ok) {
                return res.status(403).json({
                    success: false,
                    code: check.code,
                    message: check.message,
                    data: { allowedAgents: check.entitlement.agentIds },
                });
            }
        }

        const offer = req.body?.offer;
        if (!offer || typeof offer !== 'object') {
            return res.status(400).json({ success: false, message: 'offer object is required' });
        }

        const { offerDoc } = await createOfferLetterFromResume(req.user, source.documentId, offer);

        res.status(201).json({
            success: true,
            data: {
                document: offerDoc,
                sourceDocumentId: source.documentId,
            },
        });
    } catch (error) {
        next(error);
    }
};
