import { Request, Response, NextFunction } from 'express';
import { recordActivityFromReq } from '../services/activityLog';
import {
    getOrCreateEmailReportConfig,
    publicEmailReportConfig,
    sendOrgEmailReportNow,
    updateEmailReportConfig,
} from '../services/emailReportService';

async function requireOrgAdmin(req: Request, res: Response): Promise<string | null> {
    if (!req.user || req.user.role !== 'admin') {
        res.status(403).json({
            success: false,
            message: 'Only organization admins can manage email reports',
        });
        return null;
    }
    const orgId = req.user.organizationId;
    if (!orgId) {
        res.status(400).json({ success: false, message: 'organizationId required' });
        return null;
    }
    return orgId;
}

export const getEmailReportConfig = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const orgId = await requireOrgAdmin(req, res);
        if (!orgId) return;

        const doc = await getOrCreateEmailReportConfig(orgId);
        res.json({
            success: true,
            data: {
                config: publicEmailReportConfig(doc, orgId),
                adminEmail: req.user?.email || null,
            },
        });
    } catch (error) {
        next(error);
    }
};

export const saveEmailReportConfig = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const orgId = await requireOrgAdmin(req, res);
        if (!orgId) return;

        const doc = await updateEmailReportConfig(orgId, req.body || {});
        recordActivityFromReq(req, {
            action: 'email_reports.save',
            category: 'admin',
            resourceType: 'email_report',
            resourceId: orgId,
            message: `Updated email report schedule (enabled=${doc.enabled})`,
        });

        res.json({
            success: true,
            message: 'Email report settings saved',
            data: { config: publicEmailReportConfig(doc, orgId) },
        });
    } catch (error: any) {
        const status = error?.statusCode || 400;
        return res.status(status).json({
            success: false,
            message: error?.message || 'Failed to save email report settings',
        });
    }
};

export const sendEmailReportNow = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const orgId = await requireOrgAdmin(req, res);
        if (!orgId) return;

        const override = Array.isArray(req.body?.recipients)
            ? req.body.recipients
            : undefined;
        const result = await sendOrgEmailReportNow(orgId, override);

        recordActivityFromReq(req, {
            action: 'email_reports.send_now',
            category: 'admin',
            resourceType: 'email_report',
            resourceId: orgId,
            message: `Sent email report to ${result.recipients.length} recipient(s)`,
            metadata: { stats: result.stats },
        });

        res.json({
            success: true,
            message: `Report sent to ${result.recipients.join(', ')}`,
            data: result,
        });
    } catch (error: any) {
        const status = error?.statusCode || 400;
        return res.status(status).json({
            success: false,
            message: error?.message || 'Failed to send email report',
        });
    }
};
