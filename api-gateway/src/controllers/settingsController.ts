import { Request, Response, NextFunction } from 'express';
import { v4 as uuidv4 } from 'uuid';
import ApiKey, { AIProvider } from '../models/ApiKey';
import { PERMISSIONS } from '../types/permissions';
import { hasPermission } from '../services/accessScope';
import { recordActivityFromReq } from '../services/activityLog';
import {
    getOrgFinanceSettings,
    updateOrgFinanceSettings,
    type OrgFinanceSettings,
} from '../services/orgFinanceSettingsService';

export const PROVIDER_DEFAULTS: Record<AIProvider, { label: string; model: string; baseUrl?: string }> = {
    gemini: { label: 'Google Gemma (Open-Weight)', model: 'gemma-2-2b-it', baseUrl: 'https://generativelanguage.googleapis.com/v1beta' },
    groq: { label: 'Groq (Gemma / LLaMA)', model: 'gemma2-9b-it', baseUrl: 'https://api.groq.com/openai/v1' },
    openai: { label: 'OpenAI', model: 'gpt-4o', baseUrl: 'https://api.openai.com/v1' },
    anthropic: { label: 'Claude', model: 'claude-3-5-sonnet-20241022', baseUrl: 'https://api.anthropic.com/v1' },
    custom: { label: 'Custom (Ollama gemma2:2b / Local)', model: 'gemma2:2b', baseUrl: 'http://localhost:11434/v1' },
};

function requireOrg(req: Request): string | null {
    if (req.user.role === 'superAdmin') {
        return (req.query.organizationId as string) || req.body?.organizationId || req.user.organizationId || null;
    }
    return req.user.organizationId || null;
}

/** List all API keys for the organization */
export const listApiKeys = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const orgId = requireOrg(req);
        if (!orgId && req.user.role !== 'superAdmin') {
            return res.status(400).json({ success: false, message: 'organizationId required' });
        }

        const filter: Record<string, unknown> = {};
        if (orgId) filter.organizationId = orgId;

        const keys = await ApiKey.find(filter).sort({ provider: 1, createdAt: -1 }).lean();

        // Mask the API keys for security
        const masked = keys.map((k) => ({
            ...k,
            apiKey: maskKey(k.apiKey),
            model: k.aiModel,
            hasKey: k.apiKey.length > 0,
        }));

        res.json({ success: true, data: { keys: masked, providerDefaults: PROVIDER_DEFAULTS } });
    } catch (error) {
        next(error);
    }
};

/** Create or update an API key for a provider */
export const saveApiKey = async (req: Request, res: Response, next: NextFunction) => {
    try {
        if (!hasPermission(req.user, PERMISSIONS.PAGE_SETTINGS)) {
            return res.status(403).json({ success: false, message: 'Missing permission: page.settings' });
        }

        const orgId = requireOrg(req);
        if (!orgId && req.user.role !== 'superAdmin') {
            return res.status(400).json({ success: false, message: 'organizationId required' });
        }

        const { provider, apiKey, label, model, baseUrl, keyId } = req.body || {};

        if (!provider || !Object.keys(PROVIDER_DEFAULTS).includes(provider)) {
            return res.status(400).json({ success: false, message: 'Invalid provider. Must be groq, openai, gemini, anthropic, or custom' });
        }
        if (!apiKey || typeof apiKey !== 'string' || apiKey.trim().length < 8) {
            return res.status(400).json({ success: false, message: 'API key is required (min 8 characters)' });
        }

        const defaults = PROVIDER_DEFAULTS[provider as AIProvider];
        const finalLabel = label || defaults.label;
        const finalModel = model || defaults.model;
        const finalBaseUrl = baseUrl || defaults.baseUrl || null;

        // Org-scope the key only when the caller belongs to an org (super admin keys are org-agnostic)
        const orgFilter = orgId ? { organizationId: orgId } : {};

        // Check if incoming key is masked (contains asterisks)
        const isMasked = apiKey.includes('*');

        let keyDoc;
        if (keyId) {
            keyDoc = await ApiKey.findOne({ keyId, ...orgFilter });
        }
        if (!keyDoc) {
            keyDoc = await ApiKey.findOne({ provider, ...orgFilter });
        }

        const finalApiKey = (isMasked && keyDoc) ? keyDoc.apiKey : apiKey.trim();

        if (keyDoc) {
            keyDoc.apiKey = finalApiKey;
            keyDoc.label = finalLabel;
            keyDoc.aiModel = finalModel;
            keyDoc.baseUrl = finalBaseUrl;
            keyDoc.isActive = true;
            await keyDoc.save();
        } else {
            keyDoc = await ApiKey.create({
                keyId: `key_${uuidv4()}`,
                organizationId: orgId || 'global',
                provider,
                apiKey: finalApiKey,
                label: finalLabel,
                aiModel: finalModel,
                baseUrl: finalBaseUrl,
                isActive: true,
                createdBy: req.user.userId,
            });
        }

        // Sync to AI backend
        await syncKeyToAIBackend(provider, finalApiKey, finalModel, finalBaseUrl);

        recordActivityFromReq(req, {
            action: 'settings.api_key.save',
            category: 'admin',
            resourceType: 'api_key',
            resourceId: keyDoc.keyId,
            message: `Saved ${finalLabel} API key`,
            metadata: { provider, label: finalLabel },
        });

        res.status(201).json({
            success: true,
            data: {
                key: {
                    ...keyDoc.toObject(),
                    apiKey: maskKey(keyDoc.apiKey),
                    model: keyDoc.aiModel,
                    hasKey: true,
                },
            },
        });
    } catch (error) {
        next(error);
    }
};

/** Toggle API key active status */
export const toggleApiKey = async (req: Request, res: Response, next: NextFunction) => {
    try {
        if (!hasPermission(req.user, PERMISSIONS.PAGE_SETTINGS)) {
            return res.status(403).json({ success: false, message: 'Missing permission: page.settings' });
        }

        const orgId = requireOrg(req);
        const key = await ApiKey.findOne({
            keyId: req.params.keyId,
            ...(orgId ? { organizationId: orgId } : {}),
        });
        if (!key) return res.status(404).json({ success: false, message: 'API key not found' });

        key.isActive = !key.isActive;
        await key.save();

        res.json({ success: true, data: { key: { ...key.toObject(), apiKey: maskKey(key.apiKey), model: key.aiModel } } });
    } catch (error) {
        next(error);
    }
};

/** Delete an API key */
export const deleteApiKey = async (req: Request, res: Response, next: NextFunction) => {
    try {
        if (!hasPermission(req.user, PERMISSIONS.PAGE_SETTINGS)) {
            return res.status(403).json({ success: false, message: 'Missing permission: page.settings' });
        }

        const orgId = requireOrg(req);
        const key = await ApiKey.findOne({
            keyId: req.params.keyId,
            ...(orgId ? { organizationId: orgId } : {}),
        });
        if (!key) return res.status(404).json({ success: false, message: 'API key not found' });

        const provider = key.provider;
        await ApiKey.deleteOne({ keyId: key.keyId });

        // Check if any keys remain for this org
        const remainingCount = await ApiKey.countDocuments(orgId ? { organizationId: orgId } : {});

        // Sync provider deletion to Python AI backend
        try {
            const aiUrl = process.env.AI_SERVICE_URL || 'http://localhost:8000';
            await fetch(`${aiUrl}/api/v1/settings/providers/${provider}`, { method: 'DELETE' });
            if (remainingCount === 0) {
                await fetch(`${aiUrl}/api/v1/settings/providers`, { method: 'DELETE' });
            }
        } catch (e) {
            console.warn(`[SETTINGS] Failed to sync provider deletion '${provider}' to AI backend:`, e);
        }

        recordActivityFromReq(req, {
            action: 'settings.api_key.delete',
            category: 'admin',
            resourceType: 'api_key',
            resourceId: key.keyId,
            message: `Deleted ${key.label} API key`,
            metadata: { provider },
        });

        res.json({ success: true, message: 'API key deleted' });
    } catch (error) {
        next(error);
    }
};

/** Get active provider configuration (for AI backend consumption) */
export const getProviderConfig = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const orgId = req.query.organizationId as string || req.user.organizationId || null;
        if (!orgId && req.user.role !== 'superAdmin') {
            return res.status(400).json({ success: false, message: 'organizationId required' });
        }

        const filter: Record<string, unknown> = { isActive: true };
        if (orgId) filter.organizationId = orgId;

        const activeKeys = await ApiKey.find(filter).lean();
        const providers = activeKeys.map((k) => ({
            provider: k.provider,
            apiKey: k.apiKey,
            model: k.aiModel,
            baseUrl: k.baseUrl,
            label: k.label,
        }));

        // Determine primary provider (first active one, preferring groq)
        const primary = providers.find((p) => p.provider === 'groq') || providers[0] || null;

        res.json({
            success: true,
            data: {
                primary: primary ? { provider: primary.provider, apiKey: primary.apiKey, model: primary.model, baseUrl: primary.baseUrl } : null,
                providers,
            },
        });
    } catch (error) {
        next(error);
    }
};

/** Set the primary active provider */
export const setPrimaryProvider = async (req: Request, res: Response, next: NextFunction) => {
    try {
        if (!hasPermission(req.user, PERMISSIONS.PAGE_SETTINGS)) {
            return res.status(403).json({ success: false, message: 'Missing permission: page.settings' });
        }

        const orgId = requireOrg(req);
        const { provider } = req.body || {};
        if (!provider || !Object.keys(PROVIDER_DEFAULTS).includes(provider)) {
            return res.status(400).json({ success: false, message: 'Invalid provider' });
        }

        const targetKey = await ApiKey.findOne({ organizationId: orgId || undefined, provider });
        if (!targetKey || !targetKey.apiKey) {
            return res.status(400).json({ success: false, message: `No API key configured for provider ${provider}` });
        }

        // Set targetKey as primary in MongoDB
        await ApiKey.updateMany({ organizationId: orgId || undefined }, { isActive: true });
        
        // Sync primary choice to AI backend
        try {
            const aiUrl = process.env.AI_SERVICE_URL || 'http://localhost:8001';
            await fetch(`${aiUrl}/api/v1/settings/providers/primary`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    provider,
                    apiKey: targetKey.apiKey,
                    model: targetKey.aiModel,
                    baseUrl: targetKey.baseUrl,
                }),
            });
        } catch {
            // Best effort
        }

        recordActivityFromReq(req, {
            action: 'settings.api_key.set_primary',
            category: 'admin',
            resourceType: 'api_key',
            resourceId: targetKey.keyId,
            message: `Set ${provider} as primary AI provider`,
            metadata: { provider },
        });

        res.json({ success: true, message: `Primary provider set to ${provider}` });
    } catch (error) {
        next(error);
    }
};

/** Finance analytics defaults for the organization (vendor aliases, reporting currency). */
export const getFinanceSettings = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const orgId = requireOrg(req);
        // Match listApiKeys/getProviderConfig: a superAdmin has no organizationId
        // by design (org-agnostic), so don't 400 the whole settings page for them —
        // just hand back empty/default finance settings. getOrgFinanceSettings
        // already returns {} for a null org.
        if (!orgId && req.user.role !== 'superAdmin') {
            return res.status(400).json({ success: false, message: 'organizationId required' });
        }
        const settings = await getOrgFinanceSettings(orgId);
        res.json({ success: true, data: { financeSettings: settings } });
    } catch (error) {
        next(error);
    }
};

export const patchFinanceSettings = async (req: Request, res: Response, next: NextFunction) => {
    try {
        if (!hasPermission(req.user, PERMISSIONS.PAGE_SETTINGS)) {
            return res.status(403).json({ success: false, message: 'Missing permission: page.settings' });
        }
        const orgId = requireOrg(req);
        if (!orgId) {
            return res.status(400).json({ success: false, message: 'organizationId required' });
        }
        const body = (req.body || {}) as OrgFinanceSettings;
        const patch: OrgFinanceSettings = {};
        if (body.baseCurrency !== undefined) {
            patch.baseCurrency = typeof body.baseCurrency === 'string' ? body.baseCurrency : '';
        }
        if (body.vendorAliases !== undefined) {
            patch.vendorAliases =
                body.vendorAliases && typeof body.vendorAliases === 'object' && !Array.isArray(body.vendorAliases)
                    ? body.vendorAliases
                    : {};
        }
        if (body.clientAliases !== undefined) {
            patch.clientAliases =
                body.clientAliases && typeof body.clientAliases === 'object' && !Array.isArray(body.clientAliases)
                    ? body.clientAliases
                    : {};
        }
        if (body.fyStartMonth !== undefined) {
            patch.fyStartMonth = body.fyStartMonth as number;
        }
        if (body.fxRates !== undefined) {
            patch.fxRates =
                body.fxRates && typeof body.fxRates === 'object' && !Array.isArray(body.fxRates)
                    ? (body.fxRates as Record<string, number>)
                    : {};
        }
        const settings = await updateOrgFinanceSettings(orgId, patch);
        recordActivityFromReq(req, {
            action: 'settings.finance.update',
            category: 'admin',
            resourceType: 'organization',
            resourceId: orgId,
            message: 'Updated finance analytics settings',
        });
        res.json({ success: true, data: { financeSettings: settings } });
    } catch (error) {
        next(error);
    }
};

// ── Helpers ──────────────────────────────────────────────

function maskKey(key: string): string {
    if (!key || key.length < 8) return '****';
    return key.slice(0, 4) + '****' + key.slice(-4);
}

async function syncKeyToAIBackend(provider: string, apiKey: string, model: string, baseUrl: string | null) {
    try {
        const aiUrl = process.env.AI_SERVICE_URL || 'http://localhost:8000';
        await fetch(`${aiUrl}/api/v1/settings/providers`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ provider, apiKey, model, baseUrl }),
        });
    } catch {
        // Best effort - AI backend may not be running
    }
}
