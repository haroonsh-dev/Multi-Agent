import { Request, Response, NextFunction } from 'express';
import bcrypt from 'bcrypt';
import User, { defaultPermissionsForRole } from '../models/User';
import Organization from '../models/Organization';
import Document from '../models/Document';
import ApiKey, { AIProvider } from '../models/ApiKey';
import OrgSubscription from '../models/OrgSubscription';
import { PLAN_AGENT_IDS } from '../models/AgentStoragePricing';
import {
    activateSubscription,
    generateSubscriptionId,
    getOrgEntitlement,
    syncOrgSubscriptionLabel,
} from '../services/planService';
import { syncProviderToAIBackend } from '../services/aiServiceClient';
import { PROVIDER_DEFAULTS } from './settingsController';
import {
    annotateDuplicateCounts,
    getDuplicateDocumentIds,
    getDuplicateGroupSizes,
} from '../services/duplicateDetection';
import { recordActivityFromReq } from '../services/activityLog';
import openRemoteService from '../services/openRemoteService';
import { ensureDefaultOrgRoles } from '../services/orgRoleSeed';
import logger from '../utils/logger';

function normalizeAgentIds(raw: unknown): string[] {
    if (!Array.isArray(raw)) return [];
    const valid = new Set<string>(PLAN_AGENT_IDS);
    return [...new Set(raw.map((x) => String(x)).filter((id) => valid.has(id)))];
}

const SORT_FIELDS: Record<string, string> = {
    createdAt: 'createdAt',
    name: 'originalFilename',
    size: 'sizeBytes',
    status: 'status',
    score: 'metadata.cvScore',
};

function generateUserId() {
    return `usr_${Date.now()}_${Math.floor(Math.random() * 10000)}`;
}

async function buildUniqueUsername(email: string): Promise<string> {
    const base = email.split('@')[0].toLowerCase().replace(/[^a-z0-9_]/g, '_').slice(0, 24) || 'admin';
    let candidate = base;
    let i = 0;
    while (await User.findOne({ username: candidate })) {
        i += 1;
        candidate = `${base}_${i}`;
    }
    return candidate;
}

function deriveRealm(organizationName: string) {
    return (
        organizationName
            .toLowerCase()
            .trim()
            .replace(/[^a-z0-9_]/g, '_')
            .replace(/_+/g, '_')
            .slice(0, 40) || 'enterprise'
    );
}

function maskApiKey(key?: string | null): string | null {
    if (!key || typeof key !== 'string') return null;
    const trimmed = key.trim();
    if (!trimmed) return null;
    if (trimmed.length <= 8) return '••••••••';
    return `${trimmed.slice(0, 6)}...${trimmed.slice(-4)}`;
}

const maskGroqApiKey = maskApiKey;

export const listAdmins = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const admins = await User.find({ role: 'admin' })
            .select('-passwordHash -openRemoteSecret')
            .sort({ createdAt: -1 })
            .lean();

        const orgIds = [
            ...new Set(admins.map((a) => a.organizationId).filter(Boolean) as string[]),
        ];

        const [orgs, teamMembers, docCounts, subscriptions, apiKeys] = await Promise.all([
            orgIds.length
                ? Organization.find({ organizationId: { $in: orgIds } }).lean()
                : Promise.resolve([]),
            orgIds.length
                ? User.find({
                      role: 'team',
                      organizationId: { $in: orgIds },
                  })
                      .select('-passwordHash -openRemoteSecret')
                      .sort({ fullName: 1 })
                      .lean()
                : Promise.resolve([]),
            orgIds.length
                ? Document.aggregate([
                      { $match: { organizationId: { $in: orgIds } } },
                      { $group: { _id: '$organizationId', totalDocs: { $sum: 1 } } },
                  ])
                : Promise.resolve([]),
            orgIds.length
                ? OrgSubscription.find({
                      organizationId: { $in: orgIds },
                      status: 'active',
                      endsAt: { $gt: new Date() },
                  })
                      .sort({ endsAt: -1 })
                      .lean()
                : Promise.resolve([]),
            orgIds.length
                ? ApiKey.find({
                      organizationId: { $in: orgIds },
                      isActive: true,
                  }).lean()
                : Promise.resolve([]),
        ]);

        const orgMap = new Map(orgs.map((o) => [o.organizationId, o]));
        const docCountMap = new Map(docCounts.map((d) => [d._id, d.totalDocs]));
        const subMap = new Map<string, (typeof subscriptions)[0]>();
        for (const s of subscriptions) {
            if (!subMap.has(s.organizationId)) {
                subMap.set(s.organizationId, s);
            }
        }
        const membersByOrg = new Map<string, typeof teamMembers>();
        for (const m of teamMembers) {
            const key = m.organizationId || '';
            if (!key) continue;
            const list = membersByOrg.get(key) || [];
            list.push(m);
            membersByOrg.set(key, list);
        }
        const keysByOrg = new Map<string, typeof apiKeys>();
        for (const k of apiKeys) {
            const orgId = k.organizationId;
            if (!orgId) continue;
            const list = keysByOrg.get(orgId) || [];
            list.push(k);
            keysByOrg.set(orgId, list);
        }

        const enriched = admins.map((admin) => {
            const org = admin.organizationId ? orgMap.get(admin.organizationId) : null;
            const sub = admin.organizationId ? subMap.get(admin.organizationId) : null;
            const members = admin.organizationId
                ? membersByOrg.get(admin.organizationId) || []
                : [];
            const documentCount = admin.organizationId ? docCountMap.get(admin.organizationId) || 0 : 0;
            const agentIds: string[] = sub?.agentIds?.length
                ? sub.agentIds
                : ((org as any)?.allowedAgents?.length
                    ? (org as any).allowedAgents
                    : ['other_agent']);

            const orgKeys = admin.organizationId ? keysByOrg.get(admin.organizationId) || [] : [];
            const primaryKey = orgKeys[0] || null;
            const effectiveKey = primaryKey?.apiKey || org?.groqApiKey || null;
            const effectiveProvider = primaryKey?.provider || (org?.groqApiKey ? 'groq' : null);
            const maskedKey = maskApiKey(effectiveKey);

            return {
                ...admin,
                agentIds,
                organization: org
                    ? {
                          organizationId: org.organizationId,
                          organizationName: org.organizationName,
                          status: org.status,
                          subscriptionPlan: org.subscriptionPlan,
                          contactEmail: org.contactEmail,
                          hasAiApiKey: !!effectiveKey,
                          aiProvider: effectiveProvider,
                          aiProviderLabel: primaryKey?.label || null,
                          aiBaseUrl: primaryKey?.baseUrl || null,
                          aiModel: primaryKey?.aiModel || null,
                          aiKeyMasked: maskedKey,
                          hasGroqApiKey: !!effectiveKey,
                          groqApiKeyMasked: maskedKey,
                          configuredProviders: orgKeys.map((k) => k.provider),
                          agentIds,
                      }
                    : null,
                teamMembers: members,
                teamMemberCount: members.length,
                documentCount,
            };
        });

        res.json({ success: true, data: { admins: enriched } });
    } catch (error) {
        next(error);
    }
};

/** SuperAdmin creates a company admin (+ organization). */
export const createAdmin = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const {
            fullName,
            email,
            password,
            contactNumber,
            organizationName,
            status = 'active',
            aiProvider,
            apiKey,
            groqApiKey,
            providerName,
            label,
            baseUrl,
            model,
            aiModel,
            agentIds,
        } = req.body;

        const normalizedEmail = (email || '').toString().trim().toLowerCase();
        const orgName = (organizationName || '').toString().trim();
        if (!normalizedEmail || !password || !fullName || !orgName) {
            return res.status(400).json({
                success: false,
                message: 'fullName, email, password and organizationName are required',
            });
        }
        if (String(password).length < 8) {
            return res.status(400).json({ success: false, message: 'Password must be at least 8 characters' });
        }
        if (!['active', 'blocked', 'pending'].includes(status)) {
            return res.status(400).json({ success: false, message: 'status must be active, blocked, or pending' });
        }

        const rawKey = (apiKey || groqApiKey || '').toString().trim();
        const chosenProvider: AIProvider = (aiProvider && Object.keys(PROVIDER_DEFAULTS).includes(aiProvider))
            ? (aiProvider as AIProvider)
            : (rawKey.startsWith('gsk_') ? 'groq' : 'openai');

        let initialKey: string | null = null;
        if (rawKey) {
            if (rawKey.length < 6) {
                return res.status(400).json({ success: false, message: 'API key is too short (min 6 characters)' });
            }
            initialKey = rawKey;
        }

        const existing = await User.findOne({ email: normalizedEmail });
        if (existing) {
            return res.status(409).json({ success: false, message: 'Email already exists' });
        }

        const username = await buildUniqueUsername(normalizedEmail);
        const userId = generateUserId();
        const orgId = `org_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
        const realm = deriveRealm(orgName);
        const passwordHash = await bcrypt.hash(String(password), 12);

        let openRemoteUserId: string | undefined;
        let openRemoteSecret: string | undefined;
        let openRemoteRealm = realm;
        let openRemoteSynced = false;

        const openRemoteEnabled = process.env.OPENREMOTE_ENABLED !== 'false';
        const allowLocal = process.env.ALLOW_LOCAL_SEED === 'true' || process.env.NODE_ENV !== 'production';

        if (openRemoteEnabled) {
            try {
                await openRemoteService.ensureRealmExists(realm, orgName);
                const or = await openRemoteService.createUser({
                    username,
                    email: normalizedEmail,
                    fullName: String(fullName).trim(),
                    role: 'admin',
                    realm,
                });
                openRemoteUserId = or.userId || undefined;
                openRemoteSecret = or.openRemoteSecret || undefined;
                openRemoteRealm = or.realm || realm;
                openRemoteSynced = !!openRemoteUserId;
            } catch (e: any) {
                if (!allowLocal) {
                    return res.status(502).json({
                        success: false,
                        message: `OpenRemote user create failed: ${e.message || e}`,
                    });
                }
                logger.warn(`OpenRemote skipped for admin ${normalizedEmail}: ${e.message}`);
            }
        }

        const initialAgents = Array.isArray(agentIds)
            ? normalizeAgentIds(agentIds)
            : [...PLAN_AGENT_IDS];
        const orgAgents = initialAgents.length ? initialAgents : ['other_agent'];

        const org = await Organization.create({
            organizationId: orgId,
            organizationName: orgName,
            contactEmail: normalizedEmail,
            status: 'active',
            subscriptionPlan: 'Enterprise',
            openRemoteRealm,
            groqApiKey: chosenProvider === 'groq' ? initialKey : null,
            allowedAgents: orgAgents,
        });

        const now = new Date();
        const endsAt = new Date(now);
        endsAt.setFullYear(endsAt.getFullYear() + 5);
        await OrgSubscription.create({
            subscriptionId: generateSubscriptionId(),
            organizationId: orgId,
            planName: 'Enterprise',
            agentIds: orgAgents,
            storageGb: 100,
            billingCycle: 'yearly',
            price: 0,
            status: 'active',
            startsAt: now,
            endsAt,
            activatedBy: req.user?.userId || 'superadmin',
        });

        if (initialKey) {
            const defaults = PROVIDER_DEFAULTS[chosenProvider] || PROVIDER_DEFAULTS.openai;
            const finalModel = model || aiModel || defaults.model;
            const finalBaseUrl = baseUrl !== undefined ? baseUrl : (defaults.baseUrl || null);
            const finalLabel = (label || providerName)?.trim() || defaults.label;

            await ApiKey.findOneAndUpdate(
                { organizationId: orgId, provider: chosenProvider },
                {
                    keyId: `key_${chosenProvider}_${orgId}`,
                    organizationId: orgId,
                    provider: chosenProvider,
                    apiKey: initialKey,
                    label: finalLabel,
                    aiModel: finalModel,
                    baseUrl: finalBaseUrl,
                    isActive: true,
                    createdBy: req.user.userId,
                },
                { upsert: true, new: true }
            );
            await syncProviderToAIBackend({
                provider: chosenProvider,
                apiKey: initialKey,
                model: finalModel,
                baseUrl: finalBaseUrl || undefined,
            });
        }

        try {
            await ensureDefaultOrgRoles(orgId);
        } catch (e: any) {
            logger.warn(`Org roles seed failed for ${orgId}: ${e.message}`);
        }

        const admin = await User.create({
            userId,
            username,
            fullName: String(fullName).trim(),
            email: normalizedEmail,
            contactNumber: contactNumber ? String(contactNumber).trim() : undefined,
            passwordHash,
            role: 'admin',
            accountType: 'enterprise',
            organizationId: orgId,
            createdBy: req.user.userId,
            permissions: defaultPermissionsForRole('admin'),
            status,
            emailVerified: true,
            openRemoteRealm,
            openRemoteSynced,
            openRemoteSyncedAt: openRemoteSynced ? new Date() : undefined,
            openRemoteUserId,
            openRemoteSecret,
        });

        recordActivityFromReq(req, {
            action: 'admin.create',
            category: 'admin',
            resourceType: 'user',
            resourceId: admin.userId,
            message: `Created admin ${admin.email} for org ${orgName}`,
            metadata: { organizationId: orgId },
        });

        const safe = await User.findById(admin._id).select('-passwordHash -openRemoteSecret').lean();
        const masked = maskApiKey(initialKey);
        res.status(201).json({
            success: true,
            data: {
                admin: {
                    ...safe,
                    agentIds: orgAgents,
                    organization: {
                        organizationId: org.organizationId,
                        organizationName: org.organizationName,
                        status: org.status,
                        subscriptionPlan: org.subscriptionPlan,
                        contactEmail: org.contactEmail,
                        hasAiApiKey: !!initialKey,
                        aiProvider: initialKey ? chosenProvider : null,
                        aiProviderLabel: initialKey ? ((label || providerName)?.trim() || (PROVIDER_DEFAULTS[chosenProvider] || PROVIDER_DEFAULTS.openai).label) : null,
                        aiBaseUrl: initialKey ? (baseUrl !== undefined ? baseUrl : ((PROVIDER_DEFAULTS[chosenProvider] || PROVIDER_DEFAULTS.openai).baseUrl || null)) : null,
                        aiModel: initialKey ? (model || aiModel || (PROVIDER_DEFAULTS[chosenProvider] || PROVIDER_DEFAULTS.openai).model) : null,
                        aiKeyMasked: masked,
                        hasGroqApiKey: !!initialKey,
                        groqApiKeyMasked: masked,
                        configuredProviders: initialKey ? [chosenProvider] : [],
                        agentIds: orgAgents,
                    },
                    teamMembers: [],
                    teamMemberCount: 0,
                },
            },
        });
    } catch (error) {
        next(error);
    }
};

export const updateAdminStatus = async (req: Request, res: Response, next: NextFunction) => {
    try {
        if (req.params.userId === req.user.userId) {
            return res.status(400).json({ success: false, message: 'Cannot change your own status' });
        }
        const { status } = req.body;
        if (!['active', 'blocked'].includes(status)) {
            return res.status(400).json({ success: false, message: 'status must be active or blocked' });
        }
        const admin = await User.findOneAndUpdate(
            { userId: req.params.userId, role: 'admin' },
            { status },
            { new: true }
        ).select('-passwordHash -openRemoteSecret');
        if (!admin) return res.status(404).json({ success: false, message: 'Admin not found' });
        recordActivityFromReq(req, {
            action: 'admin.status',
            category: 'admin',
            resourceType: 'user',
            resourceId: admin.userId,
            message: `Set admin ${admin.email} status to ${status}`,
            metadata: { status },
        });
        res.json({ success: true, data: { admin } });
    } catch (error) {
        next(error);
    }
};

export const updateAdmin = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const admin = await User.findOne({ userId: req.params.userId, role: 'admin' });
        if (!admin) return res.status(404).json({ success: false, message: 'Admin not found' });

        const {
            fullName,
            email,
            contactNumber,
            password,
            organizationName,
            status,
            aiProvider,
            apiKey,
            groqApiKey,
            providerName,
            label,
            baseUrl,
            model,
            aiModel,
            agentIds,
        } = req.body;
        if (fullName) admin.fullName = String(fullName).trim();
        if (contactNumber !== undefined) {
            admin.contactNumber = contactNumber ? String(contactNumber).trim() : undefined;
        }
        if (email) {
            const normalized = email.toString().trim().toLowerCase();
            const dup = await User.findOne({ email: normalized, userId: { $ne: admin.userId } });
            if (dup) return res.status(409).json({ success: false, message: 'Email already in use' });
            admin.email = normalized;
        }
        if (password) {
            if (String(password).length < 8) {
                return res.status(400).json({ success: false, message: 'Password must be at least 8 characters' });
            }
            admin.passwordHash = await bcrypt.hash(String(password), 12);
        }
        if (status && ['active', 'blocked', 'pending'].includes(status)) {
            if (req.params.userId === req.user.userId) {
                return res.status(400).json({ success: false, message: 'Cannot change your own status' });
            }
            admin.status = status;
        }
        await admin.save();

        let effectiveAgentIds: string[] | undefined;
        if (agentIds !== undefined && admin.organizationId) {
            const parsedAgents = normalizeAgentIds(agentIds);
            effectiveAgentIds = parsedAgents.length ? parsedAgents : ['other_agent'];
            const activeSub = await OrgSubscription.findOne({
                organizationId: admin.organizationId,
                status: 'active',
                endsAt: { $gt: new Date() },
            }).sort({ endsAt: -1 });

            if (activeSub) {
                activeSub.agentIds = effectiveAgentIds;
                await activeSub.save();
            } else {
                const now = new Date();
                const endsAt = new Date(now);
                endsAt.setFullYear(endsAt.getFullYear() + 5);
                await OrgSubscription.create({
                    subscriptionId: generateSubscriptionId(),
                    organizationId: admin.organizationId,
                    planName: 'Enterprise',
                    agentIds: effectiveAgentIds,
                    storageGb: 100,
                    billingCycle: 'yearly',
                    price: 0,
                    status: 'active',
                    startsAt: now,
                    endsAt,
                    activatedBy: req.user?.userId || 'superadmin',
                });
            }
        }

        const rawKeyInput = apiKey !== undefined ? apiKey : groqApiKey;
        if (rawKeyInput !== undefined && admin.organizationId) {
            const trimmedKey = typeof rawKeyInput === 'string' ? rawKeyInput.trim() : '';
            const chosenProvider: AIProvider = (aiProvider && Object.keys(PROVIDER_DEFAULTS).includes(aiProvider))
                ? (aiProvider as AIProvider)
                : (trimmedKey.startsWith('gsk_') ? 'groq' : 'openai');

            if (trimmedKey) {
                if (trimmedKey.length < 6) {
                    return res.status(400).json({ success: false, message: 'API key is too short (min 6 characters)' });
                }
                const defaults = PROVIDER_DEFAULTS[chosenProvider] || PROVIDER_DEFAULTS.openai;
                const finalModel = model || aiModel || defaults.model;
                const finalBaseUrl = baseUrl !== undefined ? baseUrl : (defaults.baseUrl || null);
                const finalLabel = (label || providerName)?.trim() || defaults.label;

                await ApiKey.findOneAndUpdate(
                    { organizationId: admin.organizationId, provider: chosenProvider },
                    {
                        keyId: `key_${chosenProvider}_${admin.organizationId}`,
                        organizationId: admin.organizationId,
                        provider: chosenProvider,
                        apiKey: trimmedKey,
                        label: finalLabel,
                        aiModel: finalModel,
                        baseUrl: finalBaseUrl,
                        isActive: true,
                        createdBy: req.user.userId,
                    },
                    { upsert: true, new: true }
                );
                await syncProviderToAIBackend({
                    provider: chosenProvider,
                    apiKey: trimmedKey,
                    model: finalModel,
                    baseUrl: finalBaseUrl || undefined,
                });
                if (chosenProvider === 'groq') {
                    await Organization.findOneAndUpdate(
                        { organizationId: admin.organizationId },
                        { groqApiKey: trimmedKey }
                    );
                }
            } else {
                await ApiKey.deleteMany({ organizationId: admin.organizationId });
                await Organization.findOneAndUpdate(
                    { organizationId: admin.organizationId },
                    { groqApiKey: null }
                );
            }
        } else if (admin.organizationId && (model || aiModel || aiProvider || baseUrl || label || providerName)) {
            const existingKey = await ApiKey.findOne({ organizationId: admin.organizationId, isActive: true }).sort({ createdAt: -1 });
            if (existingKey) {
                const chosenProvider: AIProvider = (aiProvider && Object.keys(PROVIDER_DEFAULTS).includes(aiProvider))
                    ? (aiProvider as AIProvider)
                    : (existingKey.provider as AIProvider);
                const defaults = PROVIDER_DEFAULTS[chosenProvider] || PROVIDER_DEFAULTS.openai;
                const finalModel = model || aiModel || existingKey.aiModel || defaults.model;
                const finalBaseUrl = baseUrl !== undefined ? baseUrl : (existingKey.baseUrl || defaults.baseUrl || null);
                const finalLabel = (label || providerName)?.trim() || existingKey.label || defaults.label;

                existingKey.provider = chosenProvider;
                existingKey.aiModel = finalModel;
                existingKey.baseUrl = finalBaseUrl;
                existingKey.label = finalLabel;
                await existingKey.save();

                await syncProviderToAIBackend({
                    provider: chosenProvider,
                    apiKey: existingKey.apiKey,
                    model: finalModel,
                    baseUrl: finalBaseUrl || undefined,
                });
            }
        }

        if (admin.organizationId) {
            const updates: Record<string, unknown> = {};
            if (organizationName) updates.organizationName = String(organizationName).trim();
            if (effectiveAgentIds) {
                updates.allowedAgents = effectiveAgentIds;
                updates.subscriptionPlan = 'Enterprise';
            }
            if (Object.keys(updates).length > 0) {
                await Organization.findOneAndUpdate(
                    { organizationId: admin.organizationId },
                    updates
                );
            }
        }

        recordActivityFromReq(req, {
            action: 'admin.update',
            category: 'admin',
            resourceType: 'user',
            resourceId: admin.userId,
            message: `Updated admin ${admin.email}`,
        });

        const updatedUser = await User.findById(admin._id).select('-passwordHash -openRemoteSecret').lean();
        const updatedOrg = admin.organizationId
            ? await Organization.findOne({ organizationId: admin.organizationId }).lean()
            : null;
        const currentSub = admin.organizationId
            ? await OrgSubscription.findOne({
                  organizationId: admin.organizationId,
                  status: 'active',
                  endsAt: { $gt: new Date() },
              }).sort({ endsAt: -1 }).lean()
            : null;

        const resolvedAgentIds: string[] = currentSub?.agentIds?.length
            ? currentSub.agentIds
            : ((updatedOrg as any)?.allowedAgents?.length
                ? (updatedOrg as any).allowedAgents
                : (effectiveAgentIds || ['other_agent']));

        const activeKeys = admin.organizationId
            ? await ApiKey.find({ organizationId: admin.organizationId, isActive: true }).lean()
            : [];
        const primaryKey = activeKeys[0] || null;
        const effectiveKey = primaryKey?.apiKey || updatedOrg?.groqApiKey || null;
        const effectiveProvider = primaryKey?.provider || (updatedOrg?.groqApiKey ? 'groq' : null);
        const maskedKey = maskApiKey(effectiveKey);

        res.json({
            success: true,
            data: {
                admin: {
                    ...updatedUser,
                    agentIds: resolvedAgentIds,
                    organization: updatedOrg
                        ? {
                              organizationId: updatedOrg.organizationId,
                              organizationName: updatedOrg.organizationName,
                              status: updatedOrg.status,
                              subscriptionPlan: updatedOrg.subscriptionPlan,
                              contactEmail: updatedOrg.contactEmail,
                              hasAiApiKey: !!effectiveKey,
                              aiProvider: effectiveProvider,
                              aiProviderLabel: primaryKey?.label || null,
                              aiBaseUrl: primaryKey?.baseUrl || null,
                              aiModel: primaryKey?.aiModel || null,
                              aiKeyMasked: maskedKey,
                              hasGroqApiKey: !!effectiveKey,
                              groqApiKeyMasked: maskedKey,
                              configuredProviders: activeKeys.map((k) => k.provider),
                              agentIds: resolvedAgentIds,
                          }
                        : null,
                },
            },
        });
    } catch (error) {
        next(error);
    }
};

export const deleteAdmin = async (req: Request, res: Response, next: NextFunction) => {
    try {
        if (req.params.userId === req.user.userId) {
            return res.status(400).json({ success: false, message: 'Cannot delete yourself' });
        }
        const admin = await User.findOne({ userId: req.params.userId, role: 'admin' });
        if (!admin) return res.status(404).json({ success: false, message: 'Admin not found' });

        const result = await User.deleteOne({ userId: req.params.userId, role: 'admin' });
        if (!result.deletedCount) return res.status(404).json({ success: false, message: 'Admin not found' });

        recordActivityFromReq(req, {
            action: 'admin.delete',
            category: 'admin',
            resourceType: 'user',
            resourceId: String(req.params.userId),
            message: `Deleted admin ${admin.email}`,
        });
        res.json({ success: true, message: 'Admin deleted' });
    } catch (error) {
        next(error);
    }
};

export const listOrganizations = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const orgs = await Organization.find().sort({ createdAt: -1 }).lean();
        const orgIds = orgs.map((o) => o.organizationId).filter(Boolean);
        const keys = await ApiKey.find({ organizationId: { $in: orgIds }, isActive: true }).lean();
        const keysByOrg = new Map<string, (typeof keys)[0]>();
        for (const k of keys) {
            if (!keysByOrg.has(k.organizationId)) {
                keysByOrg.set(k.organizationId, k);
            }
        }
        const enriched = orgs.map((o) => {
            const primaryKey = keysByOrg.get(o.organizationId);
            const effectiveKey = primaryKey?.apiKey || o.groqApiKey || null;
            const effectiveProvider = primaryKey?.provider || (o.groqApiKey ? 'groq' : null);
            const masked = maskApiKey(effectiveKey);
            return {
                ...o,
                hasAiApiKey: !!effectiveKey,
                aiProvider: effectiveProvider,
                aiKeyMasked: masked,
                hasGroqApiKey: !!effectiveKey,
                groqApiKeyMasked: masked,
            };
        });
        res.json({ success: true, data: { organizations: enriched } });
    } catch (error) {
        next(error);
    }
};

export const updateOrganizationAiKey = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const { orgId } = req.params;
        const provider = (req.body?.provider || req.body?.aiProvider || 'openai') as AIProvider;
        const apiKey = String(req.body?.apiKey || req.body?.groqApiKey || req.body?.api_key || '').trim();
        const model = req.body?.model || req.body?.aiModel;
        const baseUrl = req.body?.baseUrl;
        const label = req.body?.label || req.body?.providerName;

        if (!apiKey) {
            return res.status(400).json({ success: false, message: 'API key is required' });
        }
        if (apiKey.length < 6) {
            return res.status(400).json({ success: false, message: 'API key is too short (min 6 characters)' });
        }
        if (!Object.keys(PROVIDER_DEFAULTS).includes(provider)) {
            return res.status(400).json({ success: false, message: 'Invalid AI provider' });
        }

        const org = await Organization.findOne({ organizationId: orgId });
        if (!org) {
            return res.status(404).json({ success: false, message: 'Organization not found' });
        }

        const defaults = PROVIDER_DEFAULTS[provider] || PROVIDER_DEFAULTS.openai;
        const finalModel = model || defaults.model;
        const finalBaseUrl = baseUrl !== undefined ? baseUrl : (defaults.baseUrl || null);
        const finalLabel = (label || '').trim() || defaults.label;

        // Upsert into ApiKey collection so chat/RAG find this active provider key for the org
        await ApiKey.findOneAndUpdate(
            { organizationId: orgId, provider },
            {
                keyId: `key_${provider}_${orgId}`,
                organizationId: orgId,
                provider,
                apiKey,
                label: finalLabel,
                aiModel: finalModel,
                baseUrl: finalBaseUrl,
                isActive: true,
                createdBy: req.user.userId,
            },
            { upsert: true, new: true }
        );

        if (provider === 'groq') {
            await Organization.findOneAndUpdate({ organizationId: orgId }, { groqApiKey: apiKey });
        }

        // Sync with AI backend
        await syncProviderToAIBackend({
            provider,
            apiKey,
            model: finalModel,
            baseUrl: finalBaseUrl || undefined,
        });

        recordActivityFromReq(req, {
            action: 'organization.ai_key_update',
            category: 'admin',
            resourceType: 'organization',
            resourceId: org.organizationId,
            message: `Updated ${finalLabel} API key for organization ${org.organizationName}`,
        });

        res.json({
            success: true,
            message: `${finalLabel} API key updated for organization ${org.organizationName}`,
            data: {
                organizationId: org.organizationId,
                organizationName: org.organizationName,
                hasAiApiKey: true,
                aiProvider: provider,
                aiProviderLabel: finalLabel,
                aiBaseUrl: finalBaseUrl,
                aiModel: finalModel,
                aiKeyMasked: maskApiKey(apiKey),
                hasGroqApiKey: true,
                groqApiKeyMasked: maskApiKey(apiKey),
            },
        });
    } catch (error) {
        next(error);
    }
};

export const deleteOrganizationAiKey = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const { orgId } = req.params;
        const provider = (req.body?.provider || req.query?.provider) as AIProvider | undefined;

        const org = await Organization.findOne({ organizationId: orgId });
        if (!org) {
            return res.status(404).json({ success: false, message: 'Organization not found' });
        }

        if (provider) {
            await ApiKey.deleteMany({ organizationId: orgId, provider });
            if (provider === 'groq') {
                await Organization.findOneAndUpdate({ organizationId: orgId }, { groqApiKey: null });
            }
        } else {
            await ApiKey.deleteMany({ organizationId: orgId });
            await Organization.findOneAndUpdate({ organizationId: orgId }, { groqApiKey: null });
        }

        recordActivityFromReq(req, {
            action: 'organization.ai_key_delete',
            category: 'admin',
            resourceType: 'organization',
            resourceId: org.organizationId,
            message: `Deleted API key(s) for organization ${org.organizationName}`,
        });

        res.json({
            success: true,
            message: `API key deleted for organization ${org.organizationName}`,
            data: {
                organizationId: org.organizationId,
                organizationName: org.organizationName,
                hasAiApiKey: false,
                aiProvider: null,
                aiKeyMasked: null,
                hasGroqApiKey: false,
                groqApiKeyMasked: null,
            },
        });
    } catch (error) {
        next(error);
    }
};

export const updateOrganizationGroqKey = updateOrganizationAiKey;
export const deleteOrganizationGroqKey = deleteOrganizationAiKey;

export const listAllDocuments = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const page = Math.max(1, parseInt((req.query.page as string) || '1', 10));
        const limit = Math.min(100, Math.max(1, parseInt((req.query.limit as string) || '20', 10)));
        const q = ((req.query.q as string) || '').trim();
        const sortBy = SORT_FIELDS[(req.query.sortBy as string) || 'createdAt'] || 'createdAt';
        const sortOrder = (req.query.sortOrder as string) === 'asc' ? 1 : -1;
        const status = (req.query.status as string) || '';
        const mimeType = (req.query.mimeType as string) || '';
        const organizationId = (req.query.organizationId as string) || undefined;
        const duplicatesOnly = (req.query.duplicatesOnly as string) === 'true';
        const scoreFilter = ((req.query.scoreFilter as string) || '').trim();

        const filter: Record<string, unknown> = {};
        if (organizationId) filter.organizationId = organizationId;
        if (status) filter.status = status;
        if (mimeType) {
            filter.mimeType = new RegExp(mimeType.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
        }
        if (q) {
            filter.$or = [
                { originalFilename: { $regex: q, $options: 'i' } },
                { classification: { $regex: q, $options: 'i' } },
                { documentId: { $regex: q, $options: 'i' } },
            ];
        }
        if (scoreFilter === 'high') {
            filter['metadata.cvScore'] = { $gte: 70 };
        } else if (scoreFilter === 'medium') {
            filter['metadata.cvScore'] = { $gte: 40, $lt: 70 };
        } else if (scoreFilter === 'low') {
            filter['metadata.cvScore'] = { $gte: 0, $lt: 40 };
        } else if (scoreFilter === 'scored') {
            filter['metadata.cvScore'] = { $exists: true, $ne: null };
        }

        let queryFilter = filter;
        if (duplicatesOnly) {
            const duplicateIds = await getDuplicateDocumentIds(filter);
            if (!duplicateIds.length) {
                return res.json({
                    success: true,
                    data: {
                        documents: [],
                        pagination: { page: 1, limit, total: 0, totalPages: 0 },
                    },
                });
            }
            queryFilter = { ...filter, documentId: { $in: duplicateIds } };
        }

        const [documents, total, duplicateSizes] = await Promise.all([
            Document.find(queryFilter)
                .sort({ [sortBy]: sortOrder })
                .skip((page - 1) * limit)
                .limit(limit)
                .lean(),
            Document.countDocuments(queryFilter),
            getDuplicateGroupSizes(filter),
        ]);

        res.json({
            success: true,
            data: {
                documents: annotateDuplicateCounts(documents, duplicateSizes),
                pagination: { page, limit, total, totalPages: Math.ceil(total / limit) || 0 },
            },
        });
    } catch (error) {
        next(error);
    }
};

export const listAllTeams = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const members = await User.find({ role: 'team' })
            .select('-passwordHash -openRemoteSecret')
            .sort({ createdAt: -1 })
            .lean();
        res.json({ success: true, data: { members } });
    } catch (error) {
        next(error);
    }
};
