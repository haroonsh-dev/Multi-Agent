import { Request, Response, NextFunction } from 'express';
import Plan from '../models/Plan';
import PlanRequest from '../models/PlanRequest';
import OrgSubscription from '../models/OrgSubscription';
import Organization from '../models/Organization';
import User from '../models/User';
import { PLAN_AGENT_IDS } from '../models/AgentStoragePricing';
import { recordActivityFromReq } from '../services/activityLog';
import {
    activateSubscription,
    generatePlanId,
    generateRequestId,
    getActiveSubscription,
    getOrCreatePricing,
    getOrgEntitlement,
    getOrgStorageUsedBytes,
    getEffectiveAllowedAgentIds,
    quoteFromPricing,
    resolvePlanAgentLabels,
} from '../services/planService';

function asNumber(v: unknown, fallback = 0): number {
    const n = Number(v);
    return Number.isFinite(n) ? n : fallback;
}

function normalizeAgentIds(raw: unknown, allowed?: Iterable<string> | Set<string>): string[] {
    if (!Array.isArray(raw)) return [];
    const allow = allowed ? new Set<string>(allowed) : new Set<string>(PLAN_AGENT_IDS);
    return [...new Set(raw.map((x) => String(x)).filter((id) => allow.has(id)))];
}

// ── Super Admin: Pricing ──────────────────────────────────────

export const getPricing = async (_req: Request, res: Response, next: NextFunction) => {
    try {
        const [pricing, agentLabels] = await Promise.all([
            getOrCreatePricing(),
            resolvePlanAgentLabels(),
        ]);
        res.json({
            success: true,
            data: {
                pricing,
                agentLabels,
            },
        });
    } catch (error) {
        next(error);
    }
};

export const updatePricing = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const pricing = await getOrCreatePricing();
        const body = req.body || {};

        if (body.currency) pricing.currency = String(body.currency).slice(0, 8);
        if (body.pricePerGbMonthly != null) pricing.pricePerGbMonthly = asNumber(body.pricePerGbMonthly);
        if (body.pricePerGbYearly != null) pricing.pricePerGbYearly = asNumber(body.pricePerGbYearly);
        if (body.freeStorageGb != null) pricing.freeStorageGb = asNumber(body.freeStorageGb, 1);
        // The pricing doc is seeded from the registry catalog, so its rows are
        // the runtime allowlist — agents added upstream appear here automatically.
        const catalogIds = pricing.agents.map((a) => a.agentId);
        if (Array.isArray(body.freeAgentIds)) {
            pricing.freeAgentIds = normalizeAgentIds(body.freeAgentIds, catalogIds);
            if (!pricing.freeAgentIds.length) pricing.freeAgentIds = ['other_agent'];
        }
        if (Array.isArray(body.agents)) {
            const byId = new Map(pricing.agents.map((a) => [a.agentId, a]));
            for (const row of body.agents) {
                const agentId = String(row.agentId || '');
                if (!catalogIds.includes(agentId)) continue;
                const existing = byId.get(agentId);
                if (existing) {
                    if (row.monthlyPrice != null) existing.monthlyPrice = asNumber(row.monthlyPrice);
                    if (row.yearlyPrice != null) existing.yearlyPrice = asNumber(row.yearlyPrice);
                    if (typeof row.enabled === 'boolean') existing.enabled = row.enabled;
                } else {
                    pricing.agents.push({
                        agentId,
                        monthlyPrice: asNumber(row.monthlyPrice, 29),
                        yearlyPrice: asNumber(row.yearlyPrice, 290),
                        enabled: row.enabled !== false,
                    });
                }
            }
        }

        await pricing.save();
        recordActivityFromReq(req, {
            action: 'plans.pricing.update',
            category: 'admin',
            resourceType: 'pricing',
            message: 'Updated agent/storage pricing catalog',
        });
        res.json({ success: true, data: { pricing } });
    } catch (error) {
        next(error);
    }
};

// ── Super Admin: Named Plans ──────────────────────────────────

export const listPlansAdmin = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const includeArchived = req.query.includeArchived === 'true';
        const filter: { status?: 'active' | 'archived' } = includeArchived ? {} : { status: 'active' };
        const plans = await Plan.find(filter).sort({ createdAt: -1 }).lean();
        res.json({ success: true, data: { plans } });
    } catch (error) {
        next(error);
    }
};

export const createPlan = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const { name, description, billingCycle, agentIds, storageGb, price } = req.body || {};
        if (!name || !billingCycle) {
            return res.status(400).json({ success: false, message: 'name and billingCycle are required' });
        }
        if (billingCycle !== 'monthly' && billingCycle !== 'yearly') {
            return res.status(400).json({ success: false, message: 'billingCycle must be monthly or yearly' });
        }
        const agents = normalizeAgentIds(agentIds);
        if (!agents.length) {
            return res.status(400).json({ success: false, message: 'Select at least one agent' });
        }
        const gb = asNumber(storageGb, 0);
        if (gb < 0) {
            return res.status(400).json({ success: false, message: 'storageGb must be >= 0' });
        }

        const plan = await Plan.create({
            planId: generatePlanId(),
            name: String(name).trim(),
            description: description ? String(description).trim() : '',
            billingCycle,
            agentIds: agents,
            storageGb: gb,
            price: asNumber(price, 0),
            status: 'active',
        });

        recordActivityFromReq(req, {
            action: 'plans.create',
            category: 'admin',
            resourceType: 'plan',
            resourceId: plan.planId,
            message: `Created plan ${plan.name}`,
        });

        res.status(201).json({ success: true, data: { plan } });
    } catch (error) {
        next(error);
    }
};

export const updatePlan = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const plan = await Plan.findOne({ planId: req.params.planId });
        if (!plan) return res.status(404).json({ success: false, message: 'Plan not found' });

        const { name, description, billingCycle, agentIds, storageGb, price, status } = req.body || {};
        if (name != null) plan.name = String(name).trim();
        if (description != null) plan.description = String(description).trim();
        if (billingCycle === 'monthly' || billingCycle === 'yearly') plan.billingCycle = billingCycle;
        if (agentIds != null) {
            const agents = normalizeAgentIds(agentIds);
            if (!agents.length) {
                return res.status(400).json({ success: false, message: 'Select at least one agent' });
            }
            plan.agentIds = agents;
        }
        if (storageGb != null) plan.storageGb = asNumber(storageGb, plan.storageGb);
        if (price != null) plan.price = asNumber(price, plan.price);
        if (status === 'active' || status === 'archived') plan.status = status;

        await plan.save();
        recordActivityFromReq(req, {
            action: 'plans.update',
            category: 'admin',
            resourceType: 'plan',
            resourceId: plan.planId,
            message: `Updated plan ${plan.name}`,
        });
        res.json({ success: true, data: { plan } });
    } catch (error) {
        next(error);
    }
};

export const deletePlan = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const plan = await Plan.findOne({ planId: req.params.planId });
        if (!plan) return res.status(404).json({ success: false, message: 'Plan not found' });
        plan.status = 'archived';
        await plan.save();
        recordActivityFromReq(req, {
            action: 'plans.archive',
            category: 'admin',
            resourceType: 'plan',
            resourceId: plan.planId,
            message: `Archived plan ${plan.name}`,
        });
        res.json({ success: true, message: 'Plan archived' });
    } catch (error) {
        next(error);
    }
};

// ── Super Admin: Requests ─────────────────────────────────────

export const listPlanRequests = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const status = (req.query.status as string) || '';
        const filter: Record<string, unknown> = {};
        if (status) filter.status = status;

        const requests = await PlanRequest.find(filter).sort({ createdAt: -1 }).limit(200).lean();
        const orgIds = [...new Set(requests.map((r) => r.organizationId))];
        const userIds = [...new Set(requests.map((r) => r.requestedBy))];
        const [orgs, users] = await Promise.all([
            Organization.find({ organizationId: { $in: orgIds } }).lean(),
            User.find({ userId: { $in: userIds } })
                .select('userId fullName email')
                .lean(),
        ]);
        const orgMap = Object.fromEntries(orgs.map((o) => [o.organizationId, o]));
        const userMap = Object.fromEntries(users.map((u) => [u.userId, u]));

        res.json({
            success: true,
            data: {
                requests: requests.map((r) => ({
                    ...r,
                    organization: orgMap[r.organizationId] || null,
                    requester: userMap[r.requestedBy] || null,
                })),
            },
        });
    } catch (error) {
        next(error);
    }
};

export const approvePlanRequest = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const request = await PlanRequest.findOne({ requestId: req.params.id });
        if (!request) return res.status(404).json({ success: false, message: 'Request not found' });
        if (request.status !== 'pending') {
            return res.status(400).json({ success: false, message: `Request is already ${request.status}` });
        }

        // Super admin may selectively adjust which agent modules get granted.
        const body = req.body || {};
        let agentIds = request.agentIds;
        let storageGb = request.storageGb;
        if (body.agentIds != null) {
            const agents = normalizeAgentIds(body.agentIds);
            if (!agents.length) {
                return res.status(400).json({ success: false, message: 'Select at least one agent to grant' });
            }
            agentIds = agents;
        }
        if (body.storageGb != null) {
            storageGb = Math.max(0, asNumber(body.storageGb, request.storageGb));
        }

        let price = body.price != null ? asNumber(body.price, request.quotedPrice) : request.quotedPrice;
        if (body.price == null && (body.agentIds != null || body.storageGb != null)) {
            // Recompute the quote from the adjusted agent/storage selection
            const pricing = await getOrCreatePricing();
            price = quoteFromPricing(pricing, agentIds, storageGb, request.billingCycle);
        }

        const sub = await activateSubscription({
            organizationId: request.organizationId,
            planId: request.planId,
            planName: request.planName || 'Custom',
            agentIds,
            storageGb,
            billingCycle: request.billingCycle,
            price,
            activatedBy: req.user.userId,
            requestId: request.requestId,
        });

        // Persist what was actually granted so the request record mirrors the subscription
        request.agentIds = agentIds;
        request.storageGb = storageGb;
        request.quotedPrice = price;
        request.status = 'approved';
        request.reviewedBy = req.user.userId;
        request.reviewNote = body.note ? String(body.note) : null;
        await request.save();

        recordActivityFromReq(req, {
            action: 'plans.request.approve',
            category: 'admin',
            resourceType: 'plan_request',
            resourceId: request.requestId,
            message: `Approved plan request for ${request.organizationId}`,
        });

        res.json({ success: true, data: { request, subscription: sub } });
    } catch (error) {
        next(error);
    }
};

export const rejectPlanRequest = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const request = await PlanRequest.findOne({ requestId: req.params.id });
        if (!request) return res.status(404).json({ success: false, message: 'Request not found' });
        if (request.status !== 'pending') {
            return res.status(400).json({ success: false, message: `Request is already ${request.status}` });
        }
        request.status = 'rejected';
        request.reviewedBy = req.user.userId;
        request.reviewNote = req.body?.note ? String(req.body.note) : null;
        await request.save();

        recordActivityFromReq(req, {
            action: 'plans.request.reject',
            category: 'admin',
            resourceType: 'plan_request',
            resourceId: request.requestId,
            message: `Rejected plan request ${request.requestId}`,
        });

        res.json({ success: true, data: { request } });
    } catch (error) {
        next(error);
    }
};

// ── Super Admin: Subscriptions ────────────────────────────────

export const listSubscriptions = async (_req: Request, res: Response, next: NextFunction) => {
    try {
        const subs = await OrgSubscription.find().sort({ createdAt: -1 }).limit(300).lean();
        const orgIds = [...new Set(subs.map((s) => s.organizationId))];
        const orgs = await Organization.find({ organizationId: { $in: orgIds } }).lean();
        const orgMap = Object.fromEntries(orgs.map((o) => [o.organizationId, o]));

        res.json({
            success: true,
            data: {
                subscriptions: subs.map((s) => ({
                    ...s,
                    organization: orgMap[s.organizationId] || null,
                })),
            },
        });
    } catch (error) {
        next(error);
    }
};

export const createSubscriptionDirect = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const {
            organizationId,
            planId,
            agentIds,
            storageGb,
            billingCycle,
            price,
            planName,
        } = req.body || {};

        if (!organizationId) {
            return res.status(400).json({ success: false, message: 'organizationId is required' });
        }
        const org = await Organization.findOne({ organizationId });
        if (!org) return res.status(404).json({ success: false, message: 'Organization not found' });

        let agents = normalizeAgentIds(agentIds);
        let gb = asNumber(storageGb, 0);
        let cycle: 'monthly' | 'yearly' =
            billingCycle === 'yearly' ? 'yearly' : 'monthly';
        let finalPrice = asNumber(price, 0);
        let name = planName ? String(planName) : 'Custom';
        let resolvedPlanId: string | null = planId || null;

        if (planId) {
            const plan = await Plan.findOne({ planId, status: 'active' });
            if (!plan) return res.status(404).json({ success: false, message: 'Plan not found' });
            agents = plan.agentIds;
            gb = plan.storageGb;
            cycle = plan.billingCycle;
            if (price == null) finalPrice = plan.price;
            name = plan.name;
            resolvedPlanId = plan.planId;
        }

        if (!agents.length) {
            return res.status(400).json({ success: false, message: 'Select at least one agent' });
        }

        const sub = await activateSubscription({
            organizationId,
            planId: resolvedPlanId,
            planName: name,
            agentIds: agents,
            storageGb: gb,
            billingCycle: cycle,
            price: finalPrice,
            activatedBy: req.user.userId,
        });

        recordActivityFromReq(req, {
            action: 'plans.subscription.activate',
            category: 'admin',
            resourceType: 'subscription',
            resourceId: sub.subscriptionId,
            message: `Activated ${name} for ${organizationId}`,
        });

        res.status(201).json({ success: true, data: { subscription: sub } });
    } catch (error) {
        next(error);
    }
};

export const patchSubscription = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const sub = await OrgSubscription.findOne({ subscriptionId: req.params.id });
        if (!sub) return res.status(404).json({ success: false, message: 'Subscription not found' });

        const body = req.body || {};
        const action = String(body.action || '').toLowerCase();
        const { addBillingPeriod } = await import('../services/planService');

        // ── Field updates (can combine with action, or action=update) ──
        const applyFieldUpdates = () => {
            if (body.agentIds != null) {
                const agents = normalizeAgentIds(body.agentIds);
                if (!agents.length) {
                    throw Object.assign(new Error('Select at least one agent'), { statusCode: 400 });
                }
                sub.agentIds = agents;
            }
            if (body.storageGb != null) sub.storageGb = asNumber(body.storageGb, sub.storageGb);
            if (body.price != null) sub.price = asNumber(body.price, sub.price);
            if (body.planName != null) sub.planName = String(body.planName).trim() || sub.planName;
            if (body.billingCycle === 'monthly' || body.billingCycle === 'yearly') {
                sub.billingCycle = body.billingCycle;
            }
            if (body.endsAt) {
                const d = new Date(body.endsAt);
                if (!Number.isNaN(d.getTime())) sub.endsAt = d;
            }
            if (body.startsAt) {
                const d = new Date(body.startsAt);
                if (!Number.isNaN(d.getTime())) sub.startsAt = d;
            }
            if (body.planId !== undefined) {
                sub.planId = body.planId ? String(body.planId) : null;
            }
        };

        if (action === 'deactivate' || action === 'pause') {
            if (sub.status === 'cancelled') {
                return res.status(400).json({ success: false, message: 'Cancelled subscriptions cannot be deactivated — create a new one' });
            }
            sub.status = 'inactive';
            await sub.save();
            const stillActive = await getActiveSubscription(sub.organizationId);
            if (!stillActive) {
                await Organization.updateOne(
                    { organizationId: sub.organizationId },
                    { $set: { subscriptionPlan: 'free' } }
                );
            }
            recordActivityFromReq(req, {
                action: 'plans.subscription.deactivate',
                category: 'admin',
                resourceType: 'subscription',
                resourceId: sub.subscriptionId,
                message: `Deactivated subscription ${sub.subscriptionId}`,
            });
            return res.json({ success: true, data: { subscription: sub }, message: 'Subscription deactivated' });
        }

        if (action === 'activate' || action === 'reactivate') {
            // Only one active sub per org — deactivate others
            await OrgSubscription.updateMany(
                {
                    organizationId: sub.organizationId,
                    status: 'active',
                    subscriptionId: { $ne: sub.subscriptionId },
                },
                { $set: { status: 'inactive' } }
            );
            if (sub.endsAt <= new Date()) {
                // Auto-extend one period if already expired
                sub.endsAt = addBillingPeriod(new Date(), sub.billingCycle);
            }
            applyFieldUpdates();
            sub.status = 'active';
            await sub.save();
            await Organization.updateOne(
                { organizationId: sub.organizationId },
                { $set: { subscriptionPlan: sub.planName || 'Custom' } }
            );
            recordActivityFromReq(req, {
                action: 'plans.subscription.activate',
                category: 'admin',
                resourceType: 'subscription',
                resourceId: sub.subscriptionId,
                message: `Activated subscription ${sub.subscriptionId}`,
            });
            return res.json({ success: true, data: { subscription: sub }, message: 'Subscription activated' });
        }

        if (action === 'cancel') {
            sub.status = 'cancelled';
            await sub.save();
            const stillActive = await getActiveSubscription(sub.organizationId);
            if (!stillActive) {
                await Organization.updateOne(
                    { organizationId: sub.organizationId },
                    { $set: { subscriptionPlan: 'free' } }
                );
            }
            recordActivityFromReq(req, {
                action: 'plans.subscription.cancel',
                category: 'admin',
                resourceType: 'subscription',
                resourceId: sub.subscriptionId,
                message: `Cancelled subscription ${sub.subscriptionId}`,
            });
            return res.json({ success: true, data: { subscription: sub }, message: 'Subscription cancelled' });
        }

        if (action === 'extend') {
            const periods = Math.max(1, Math.min(24, asNumber(body.periods, 1)));
            let from = sub.endsAt > new Date() ? new Date(sub.endsAt) : new Date();
            for (let i = 0; i < periods; i += 1) {
                from = addBillingPeriod(from, sub.billingCycle);
            }
            sub.endsAt = from;
            if (sub.status === 'expired' || sub.status === 'inactive') {
                sub.status = 'active';
            }
            await sub.save();
            if (sub.status === 'active') {
                await Organization.updateOne(
                    { organizationId: sub.organizationId },
                    { $set: { subscriptionPlan: sub.planName || 'Custom' } }
                );
            }
            recordActivityFromReq(req, {
                action: 'plans.subscription.extend',
                category: 'admin',
                resourceType: 'subscription',
                resourceId: sub.subscriptionId,
                message: `Extended subscription ${sub.subscriptionId} by ${periods} period(s)`,
                metadata: { periods },
            });
            return res.json({
                success: true,
                data: { subscription: sub },
                message: `Extended by ${periods} ${sub.billingCycle === 'yearly' ? 'year(s)' : 'month(s)'}`,
            });
        }

        if (action === 'update' || !action) {
            try {
                applyFieldUpdates();
            } catch (e: any) {
                if (e.statusCode === 400) {
                    return res.status(400).json({ success: false, message: e.message });
                }
                throw e;
            }
            // If endsAt moved into the future and was expired, optionally leave status as-is unless activate requested
            if (sub.status === 'expired' && sub.endsAt > new Date() && body.reactivate === true) {
                sub.status = 'active';
            }
            await sub.save();
            if (sub.status === 'active') {
                await Organization.updateOne(
                    { organizationId: sub.organizationId },
                    { $set: { subscriptionPlan: sub.planName || 'Custom' } }
                );
            }
            recordActivityFromReq(req, {
                action: 'plans.subscription.update',
                category: 'admin',
                resourceType: 'subscription',
                resourceId: sub.subscriptionId,
                message: `Updated subscription ${sub.subscriptionId}`,
            });
            return res.json({ success: true, data: { subscription: sub }, message: 'Subscription updated' });
        }

        return res.status(400).json({
            success: false,
            message: 'action must be activate, deactivate, cancel, extend, or update',
        });
    } catch (error) {
        next(error);
    }
};

// ── Admin-facing ──────────────────────────────────────────────

export const listPlansPublic = async (_req: Request, res: Response, next: NextFunction) => {
    try {
        const [plans, pricing, agentLabels] = await Promise.all([
            Plan.find({ status: 'active' }).sort({ price: 1 }).lean(),
            getOrCreatePricing(),
            resolvePlanAgentLabels(),
        ]);
        res.json({
            success: true,
            data: {
                plans,
                pricing: {
                    currency: pricing.currency,
                    agents: pricing.agents.filter((a) => a.enabled),
                    pricePerGbMonthly: pricing.pricePerGbMonthly,
                    pricePerGbYearly: pricing.pricePerGbYearly,
                    freeAgentIds: pricing.freeAgentIds,
                    freeStorageGb: pricing.freeStorageGb,
                },
                agentLabels,
            },
        });
    } catch (error) {
        next(error);
    }
};

export const createPlanRequest = async (req: Request, res: Response, next: NextFunction) => {
    try {
        if (req.user.role !== 'admin' && req.user.role !== 'superAdmin') {
            return res.status(403).json({ success: false, message: 'Only organization admins can request plans' });
        }
        const organizationId = req.user.organizationId;
        if (!organizationId) {
            return res.status(400).json({ success: false, message: 'No organization on account' });
        }

        const pending = await PlanRequest.findOne({ organizationId, status: 'pending' });
        if (pending) {
            return res.status(400).json({
                success: false,
                message: 'You already have a pending plan request. Wait for Super Admin review.',
                data: { request: pending },
            });
        }

        const { planId, agentIds, storageGb, billingCycle, message, requestType } = req.body || {};
        const isChange = String(requestType || '').toLowerCase() === 'change';
        const pricing = await getOrCreatePricing();

        let agents = normalizeAgentIds(agentIds);
        let gb = asNumber(storageGb, 0);
        let cycle: 'monthly' | 'yearly' =
            billingCycle === 'yearly' ? 'yearly' : 'monthly';
        let planName: string | null = null;
        let resolvedPlanId: string | null = null;
        let quotedPrice = 0;
        let previousAgentIds: string[] = [];

        if (isChange) {
            // Swap the agent modules on the org's current subscription
            const current = await getActiveSubscription(organizationId);
            if (!current) {
                return res.status(400).json({
                    success: false,
                    message: 'No active subscription to change — request a plan first.',
                });
            }
            if (!agents.length) {
                return res.status(400).json({ success: false, message: 'Select at least one agent' });
            }
            planName = current.planName || 'Custom';
            resolvedPlanId = current.planId || null;
            gb = current.storageGb;
            cycle = current.billingCycle;
            previousAgentIds = current.agentIds || [];
            quotedPrice = quoteFromPricing(pricing, agents, gb, cycle);
        } else if (planId) {
            const plan = await Plan.findOne({ planId, status: 'active' });
            if (!plan) return res.status(404).json({ success: false, message: 'Plan not found' });
            agents = plan.agentIds;
            gb = plan.storageGb;
            cycle = plan.billingCycle;
            planName = plan.name;
            resolvedPlanId = plan.planId;
            quotedPrice = plan.price;
        } else {
            if (!agents.length) {
                return res.status(400).json({ success: false, message: 'Select at least one agent' });
            }
            if (gb < 0) {
                return res.status(400).json({ success: false, message: 'storageGb must be >= 0' });
            }
            planName = 'Custom';
            quotedPrice = quoteFromPricing(pricing, agents, gb, cycle);
        }

        const request = await PlanRequest.create({
            requestId: generateRequestId(),
            organizationId,
            requestedBy: req.user.userId,
            requestType: isChange ? 'change' : 'new',
            previousAgentIds,
            planId: resolvedPlanId,
            planName,
            agentIds: agents,
            storageGb: gb,
            billingCycle: cycle,
            quotedPrice,
            message: message ? String(message).slice(0, 2000) : '',
            status: 'pending',
        });

        recordActivityFromReq(req, {
            action: 'plans.request.create',
            category: 'admin',
            resourceType: 'plan_request',
            resourceId: request.requestId,
            message: `Requested ${isChange ? 'agent change for' : 'plan'} ${planName}`,
        });

        res.status(201).json({ success: true, data: { request } });
    } catch (error) {
        next(error);
    }
};

export const listMyPlanRequests = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const organizationId = req.user.organizationId;
        if (!organizationId) {
            return res.json({ success: true, data: { requests: [] } });
        }
        const requests = await PlanRequest.find({ organizationId }).sort({ createdAt: -1 }).limit(50).lean();
        res.json({ success: true, data: { requests } });
    } catch (error) {
        next(error);
    }
};

export const getMySubscription = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const organizationId = req.user.organizationId;
        if (!organizationId) {
            return res.json({
                success: true,
                data: {
                    entitlement: {
                        agentIds: ['other_agent'],
                        storageGb: 1,
                        planLabel: 'free',
                        isFreeTier: true,
                        subscription: null,
                    },
                    storageUsedBytes: 0,
                },
            });
        }
        const [orgEntitlement, storageUsedBytes, effective, agentLabels] = await Promise.all([
            getOrgEntitlement(organizationId),
            getOrgStorageUsedBytes(organizationId),
            getEffectiveAllowedAgentIds(req.user),
            resolvePlanAgentLabels(),
        ]);
        res.json({
            success: true,
            data: {
                entitlement: {
                    ...orgEntitlement,
                    agentIds: effective.agentIds,
                    orgAgentIds: effective.orgAgentIds,
                    departmentId: effective.departmentId,
                },
                storageUsedBytes,
                agentLabels,
            },
        });
    } catch (error) {
        next(error);
    }
};

export const quotePlan = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const pricing = await getOrCreatePricing();
        const agentIds = normalizeAgentIds(req.body?.agentIds);
        const storageGb = asNumber(req.body?.storageGb, 0);
        const billingCycle = req.body?.billingCycle === 'yearly' ? 'yearly' : 'monthly';
        const price = quoteFromPricing(pricing, agentIds, storageGb, billingCycle);
        res.json({
            success: true,
            data: { price, currency: pricing.currency, agentIds, storageGb, billingCycle },
        });
    } catch (error) {
        next(error);
    }
};
