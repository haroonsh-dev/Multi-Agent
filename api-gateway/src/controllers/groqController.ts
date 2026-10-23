import { Request, Response, NextFunction } from 'express';
import {
    getGroqStatus,
    setGroqApiKey,
    formatAiError,
    isAiServiceEnabled,
} from '../services/aiServiceClient';

export const groqStatusHandler = async (req: Request, res: Response, next: NextFunction) => {
    try {
        if (!isAiServiceEnabled()) {
            return res.json({
                success: true,
                data: {
                    limited: false,
                    configured: false,
                    retry_after_seconds: 0,
                    console_url: 'https://console.groq.com/keys',
                    billing_url: 'https://console.groq.com/settings/billing',
                },
            });
        }
        const status = await getGroqStatus();
        res.json({ success: true, data: status });
    } catch (error) {
        next(error);
    }
};

export const setGroqKeyHandler = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const apiKey = String(req.body?.api_key || req.body?.apiKey || '').trim();
        if (!apiKey) {
            return res.status(400).json({ success: false, message: 'api_key is required' });
        }
        if (!apiKey.startsWith('gsk_')) {
            return res.status(400).json({
                success: false,
                message: 'Groq API keys usually start with gsk_',
            });
        }
        if (!isAiServiceEnabled()) {
            return res.status(503).json({ success: false, message: 'AI service offline' });
        }
        const result = await setGroqApiKey(apiKey);
        res.json({
            success: true,
            message: result?.message || 'Groq API key updated',
            data: result,
        });
    } catch (error: any) {
        const msg = formatAiError(error);
        return res.status(400).json({ success: false, message: msg });
    }
};
