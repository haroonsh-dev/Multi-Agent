import { Request, Response, NextFunction } from 'express';
import { hasPermission } from '../services/accessScope';
import { PERMISSIONS } from '../types/permissions';
import { getAgentFleetSnapshot } from '../services/agentFleetService';

export const getAgentFleet = async (req: Request, res: Response, next: NextFunction) => {
    try {
        if (!req.user || !hasPermission(req.user, PERMISSIONS.PAGE_DASHBOARD)) {
            return res.status(403).json({ success: false, message: 'Forbidden' });
        }
        const data = await getAgentFleetSnapshot(req.user);
        res.json({ success: true, data });
    } catch (err) {
        next(err);
    }
};
