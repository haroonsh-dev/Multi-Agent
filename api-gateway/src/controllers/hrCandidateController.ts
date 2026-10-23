import { Request, Response, NextFunction } from 'express';
import {
    approveCandidatesToShortlist,
    listCandidatesForOutreach,
    listHrCandidateShortlist,
    previewOutreachEmail,
    saveCandidateEmailOverride,
    sendCandidateOutreachEmails,
    type OutreachTemplateId,
} from '../services/hrCandidateEmailService';
import {
    executeHrReportAction,
    HR_STRUCTURED_ACTION_IDS,
    type HrLetterContext,
    type HrStructuredActionId,
} from '../services/hrChatReportService';
import { requireAllowedAgent } from '../services/planService';
import { HR_AGENT } from '../services/offerLetterGenerationService';
import { isEmailConfigured } from '../services/emailService';

export const listHrCandidatesOutreach = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const check = await requireAllowedAgent(req.user, HR_AGENT);
        if (!check.ok) {
            return res.status(403).json({ success: false, message: check.message });
        }

        const limit = Math.min(100, Math.max(1, parseInt(String(req.query.limit || '50'), 10) || 50));
        const minScore = req.query.minScore != null ? Number(req.query.minScore) : undefined;
        const documentIds = req.query.documentIds
            ? String(req.query.documentIds)
                  .split(',')
                  .map((s) => s.trim())
                  .filter(Boolean)
            : undefined;

        const candidates = await listCandidatesForOutreach(req.user!, {
            limit,
            minScore: Number.isFinite(minScore) ? minScore : undefined,
            documentIds,
        });

        return res.json({
            success: true,
            data: {
                candidates,
                emailConfigured: isEmailConfigured(),
                withEmail: candidates.filter((c) => c.email).length,
            },
        });
    } catch (e) {
        next(e);
    }
};

export const listHrCandidatesShortlist = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const check = await requireAllowedAgent(req.user, HR_AGENT);
        if (!check.ok) {
            return res.status(403).json({ success: false, message: check.message });
        }

        const limit = Math.min(100, Math.max(1, parseInt(String(req.query.limit || '25'), 10) || 25));
        const documentIds = req.query.documentIds
            ? String(req.query.documentIds)
                  .split(',')
                  .map((s) => s.trim())
                  .filter(Boolean)
            : undefined;

        const payload = await listHrCandidateShortlist(req.user!, { limit, documentIds });

        return res.json({ success: true, data: payload });
    } catch (e) {
        next(e);
    }
};

export const approveHrCandidatesShortlist = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const documentIds = Array.isArray(req.body?.documentIds)
            ? req.body.documentIds.map(String).filter(Boolean)
            : req.body?.documentId
              ? [String(req.body.documentId)]
              : [];

        const result = await approveCandidatesToShortlist(req.user!, documentIds, req);

        return res.json({ success: true, data: result });
    } catch (e) {
        next(e);
    }
};

export const sendHrCandidateEmail = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const check = await requireAllowedAgent(req.user, HR_AGENT);
        if (!check.ok) {
            return res.status(403).json({ success: false, message: check.message });
        }

        const {
            documentIds,
            template,
            subject,
            bodyHtml,
            senderName,
            companyName,
            interviewDetails,
            emailOverrides,
        } = req.body || {};

        if (!Array.isArray(documentIds) || !documentIds.length) {
            return res.status(400).json({ success: false, message: 'documentIds array is required' });
        }

        const allowedTemplates: OutreachTemplateId[] = [
            'interview_invite',
            'screening_next_steps',
            'rejection',
            'custom',
        ];
        const tpl = allowedTemplates.includes(template) ? template : 'interview_invite';

        const result = await sendCandidateOutreachEmails(
            req.user!,
            {
                documentIds,
                template: tpl,
                subject,
                bodyHtml,
                senderName,
                companyName,
                interviewDetails,
                emailOverrides:
                    emailOverrides && typeof emailOverrides === 'object'
                        ? (emailOverrides as Record<string, string>)
                        : undefined,
            },
            req
        );

        return res.json({ success: true, data: result });
    } catch (e) {
        next(e);
    }
};

export const patchHrCandidateEmail = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const documentId = String(req.params.documentId || '').trim();
        const email = String(req.body?.email || '').trim();
        if (!documentId) {
            return res.status(400).json({ success: false, message: 'documentId is required' });
        }
        const result = await saveCandidateEmailOverride(req.user!, documentId, email);
        return res.json({ success: true, data: result });
    } catch (e) {
        next(e);
    }
};

export const previewHrCandidateEmail = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const check = await requireAllowedAgent(req.user, HR_AGENT);
        if (!check.ok) {
            return res.status(403).json({ success: false, message: check.message });
        }

        const {
            documentId,
            template,
            senderName,
            companyName,
            interviewDetails,
            emailOverride,
        } = req.body || {};

        if (!documentId) {
            return res.status(400).json({ success: false, message: 'documentId is required' });
        }

        const allowedTemplates: OutreachTemplateId[] = [
            'interview_invite',
            'screening_next_steps',
            'rejection',
            'custom',
        ];
        const tpl = allowedTemplates.includes(template) ? template : 'interview_invite';

        const preview = await previewOutreachEmail(req.user!, {
            documentId: String(documentId),
            template: tpl,
            senderName,
            companyName,
            interviewDetails,
            emailOverride,
        });

        return res.json({ success: true, data: preview });
    } catch (e) {
        next(e);
    }
};

export const generateHrStructuredReport = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const actionId = String(req.body?.actionId || '').trim() as HrStructuredActionId;
        if (!HR_STRUCTURED_ACTION_IDS.includes(actionId)) {
            return res.status(400).json({ success: false, message: 'Invalid actionId' });
        }

        const documentIds = Array.isArray(req.body?.documentIds)
            ? req.body.documentIds.map(String).filter(Boolean)
            : undefined;
        const shortlistLimit =
            req.body?.shortlistLimit != null ? Number(req.body.shortlistLimit) : undefined;
        const letterContext =
            req.body?.letterContext && typeof req.body.letterContext === 'object'
                ? (req.body.letterContext as HrLetterContext)
                : undefined;

        const result = await executeHrReportAction({
            user: req.user!,
            actionId,
            documentIds,
            shortlistLimit: Number.isFinite(shortlistLimit) ? shortlistLimit : undefined,
            letterContext,
        });

        return res.status(result.ok ? 200 : 422).json({
            success: result.ok,
            message: result.message,
            data: result,
        });
    } catch (e) {
        next(e);
    }
};
