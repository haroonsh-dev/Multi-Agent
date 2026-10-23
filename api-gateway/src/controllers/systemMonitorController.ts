import { Request, Response, NextFunction } from 'express';
import { hasPermission } from '../services/accessScope';
import { PERMISSIONS } from '../types/permissions';
import { getSystemMonitorSnapshot } from '../services/systemMonitorService';

export const getSystemMonitor = async (req: Request, res: Response, next: NextFunction) => {
    try {
        if (!req.user || !hasPermission(req.user, PERMISSIONS.PAGE_DASHBOARD)) {
            return res.status(403).json({ success: false, message: 'Forbidden' });
        }
        const data = await getSystemMonitorSnapshot(req.user);
        res.json({ success: true, data });
    } catch (err) {
        next(err);
    }
};
