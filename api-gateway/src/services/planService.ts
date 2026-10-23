import AgentStoragePricing, {
    PLAN_AGENT_IDS,
    PLAN_AGENT_LABELS,
    type IAgentStoragePricing,
} from '../models/AgentStoragePricing';
import OrgSubscription, { type IOrgSubscription } from '../models/OrgSubscription';
import Document from '../models/Document';
import Organization from '../models/Organization';
import Department from '../models/Department';
import { loadUserDeptContext, type AuthUser } from './accessScope';
import { getAiAgentCatalog } from './aiServiceClient';
import logger from '../utils/logger';

/** Agents this org may use, resolved from the ai-backend registry when reachable.
 *  Falls back to the bundled PLAN_AGENT_IDS list when the AI service is down. */
export async function resolvePlanAgentIds(): Promise<string[]> {
    try {
        const catalog = await getAiAgentCatalog();
        if (catalog?.agent_ids?.length) {
            // Preserve bundled ordering (finance, procurement, hr, legal, compliance, other)
            // while picking up any new agents the registry knows about.
            const bundledSet = new Set<string>(PLAN_AGENT_IDS);
            const bundled = PLAN_AGENT_IDS.filter((id) => catalog.agent_ids.includes(id));
            const extra = catalog.agent_ids.filter((id) => !bundledSet.has(id));
            if (extra.length) {
                logger.info(`Registry catalog added agent(s) to plan entitlements: ${extra.join(', ')}`);
            }
            return [...bundled, ...extra];
        }
    } catch (e: any) {
        logger.warn(`Failed to resolve plan agent ids from AI registry: ${e?.message || e}`);
    }
    return [...PLAN_AGENT_IDS];
}

/** Display labels for the catalog, resolved from the registry when reachable. */
export async function resolvePlanAgentLabels(): Promise<Record<string, string>> {
    try {
        const catalog = await getAiAgentCatalog();
        if (catalog?.agent_labels && Object.keys(catalog.agent_labels).length) {
            return catalog.agent_labels;
        }
    } catch (e: any) {
        logger.warn(`Failed to resolve plan agent labels from AI registry: ${e?.message || e}`);
    }
    return { ...PLAN_AGENT_LABELS };
}

function id() {
    return `${Date.now()}_${Math.floor(Math.random() * 100000)}`;
}

export function generatePlanId() {
    return `plan_${id()}`;
}

export function generateRequestId() {
    return `preq_${id()}`;
}

export function generateSubscriptionId() {
    return `sub_${id()}`;
}

export async function getOrCreatePricing(): Promise<IAgentStoragePricing> {
    const agentIds = await resolvePlanAgentIds();
    let doc = await AgentStoragePricing.findOne({ configId: 'default' });
    if (!doc) {
        doc = await AgentStoragePricing.create({
            configId: 'default',
            currency: 'USD',
            agents: agentIds.map((agentId) => ({
                agentId,
                monthlyPrice: agentId === 'other_agent' ? 0 : 29,
                yearlyPrice: agentId === 'other_agent' ? 0 : 290,
                enabled: true,
            })),
            pricePerGbMonthly: 2,
            pricePerGbYearly: 20,
            freeAgentIds: ['other_agent'],
            freeStorageGb: 1,
        });
    } else {
        // Ensure all known agents exist in catalog
        const existing = new Set(doc.agents.map((a) => a.agentId));
        let changed = false;
        for (const agentId of agentIds) {
            if (!existing.has(agentId)) {
                doc.agents.push({
                    agentId,
                    monthlyPrice: 29,
                    yearlyPrice: 290,
                    enabled: true,
                });
                changed = true;
            }
        }
        if (changed) await doc.save();
    }
    return doc;
}

export function quoteFromPricing(
    pricing: IAgentStoragePricing,
    agentIds: string[],
    storageGb: number,
    billingCycle: 'monthly' | 'yearly'
): number {
    const agentSet = new Set(agentIds);
    let total = 0;
    for (const row of pricing.agents) {
        if (!agentSet.has(row.agentId) || !row.enabled) continue;
        total += billingCycle === 'yearly' ? row.yearlyPrice : row.monthlyPrice;
    }
    const perGb = billingCycle === 'yearly' ? pricing.pricePerGbYearly : pricing.pricePerGbMonthly;
    total += Math.max(0, storageGb) * perGb;
    return Math.round(total * 100) / 100;
}

export function addBillingPeriod(from: Date, cycle: 'monthly' | 'yearly'): Date {
    const d = new Date(from);
    if (cycle === 'yearly') {
        d.setFullYear(d.getFullYear() + 1);
    } else {
        d.setMonth(d.getMonth() + 1);
    }
    return d;
}

export async function getActiveSubscription(
    organizationId: string | null | undefined
): Promise<IOrgSubscription | null> {
    if (!organizationId) return null;
    const now = new Date();
    const sub = await OrgSubscription.findOne({
        organizationId,
        status: 'active',
        endsAt: { $gt: now },
    })
        .sort({ endsAt: -1 })
        .lean();

    if (!sub) {
        // Mark expired leftovers
        await OrgSubscription.updateMany(
            { organizationId, status: 'active', endsAt: { $lte: now } },
            { $set: { status: 'expired' } }
        );
        return null;
    }
    return sub as IOrgSubscription;
}

export type OrgEntitlement = {
    agentIds: string[];
    storageGb: number;
    subscription: IOrgSubscription | null;
    planLabel: string;
    isFreeTier: boolean;
};

export async function getOrgEntitlement(
    organizationId: string | null | undefined
): Promise<OrgEntitlement> {
    // Independent lookups — parallelize to cut Atlas round-trip latency.
    const [pricing, sub] = await Promise.all([
        getOrCreatePricing(),
        getActiveSubscription(organizationId),
    ]);
    if (sub) {
        return {
            agentIds: sub.agentIds?.length ? sub.agentIds : [...pricing.freeAgentIds],
            storageGb: sub.storageGb,
            subscription: sub,
            planLabel: sub.planName || 'Custom',
            isFreeTier: false,
        };
    }
    if (organizationId) {
        const org = await Organization.findOne({ organizationId }).select('allowedAgents subscriptionPlan').lean();
        if (org?.allowedAgents?.length) {
            const agentSet = new Set(org.allowedAgents);
            agentSet.add('other_agent');
            return {
                agentIds: Array.from(agentSet),
                storageGb: pricing.freeStorageGb ?? 10,
                subscription: null,
                planLabel: org.subscriptionPlan || 'Custom',
                isFreeTier: false,
            };
        }
    }
    return {
        agentIds: pricing.freeAgentIds?.length ? pricing.freeAgentIds : ['other_agent'],
        storageGb: pricing.freeStorageGb ?? 1,
        subscription: null,
        planLabel: 'free',
        isFreeTier: true,
    };
}

export async function getOrgStorageUsedBytes(organizationId: string): Promise<number> {
    const result = await Document.aggregate([
        { $match: { organizationId } },
        { $group: { _id: null, total: { $sum: '$sizeBytes' } } },
    ]);
    return result[0]?.total || 0;
}

export async function assertStorageAvailable(
    organizationId: string | null | undefined,
    additionalBytes: number
): Promise<{ ok: true } | { ok: false; message: string; usedBytes: number; limitBytes: number }> {
    if (!organizationId) {
        return { ok: false, message: 'Organization required', usedBytes: 0, limitBytes: 0 };
    }
    const entitlement = await getOrgEntitlement(organizationId);
    const limitBytes = entitlement.storageGb * 1024 * 1024 * 1024;
    const usedBytes = await getOrgStorageUsedBytes(organizationId);
    if (usedBytes + additionalBytes > limitBytes) {
        const usedGb = (usedBytes / (1024 * 1024 * 1024)).toFixed(2);
        return {
            ok: false,
            message: `Storage limit exceeded (${usedGb} GB used of ${entitlement.storageGb} GB). Upgrade your plan.`,
            usedBytes,
            limitBytes,
        };
    }
    return { ok: true };
}

export function isAgentAllowed(entitlement: OrgEntitlement, agentId: string | null | undefined): boolean {
    if (!agentId || agentId === 'other_agent') return true;
    return entitlement.agentIds.includes(agentId);
}

/** Pick a safe agent from the org plan (prefer requested, else other_agent, else first allowed). */
export function clampAgentToEntitlement(
    entitlement: OrgEntitlement,
    agentId: string | null | undefined
): string | undefined {
    if (!agentId) return undefined;
    if (entitlement.agentIds.includes(agentId)) return agentId;
    if (entitlement.agentIds.includes('other_agent')) return 'other_agent';
    return entitlement.agentIds[0];
}

export async function getAllowedAgentsForOrg(
    organizationId: string | null | undefined
): Promise<string[]> {
    const entitlement = await getOrgEntitlement(organizationId);
    return entitlement.agentIds;
}

/** Agent ids from raw input, limited to the org plan. The org plan is itself
 *  registry-derived (getOrCreatePricing resolves from the ai-backend catalog),
 *  so filtering against it alone keeps a new registry agent settable for a
 *  department without needing a frontend/bundled-list update. */
export function normalizeAgentsToOrgPlan(raw: unknown, orgAgentIds: string[]): string[] {
    if (!Array.isArray(raw)) return [];
    const orgSet = new Set(orgAgentIds);
    return [...new Set(raw.map((x) => String(x)).filter((id) => orgSet.has(id)))];
}

/** When department list is empty, members get full org plan agents. */
export function intersectDeptAgents(deptAgents: string[], orgAgentIds: string[]): string[] {
    if (!deptAgents.length) return orgAgentIds;
    const effective = deptAgents.filter((id) => orgAgentIds.includes(id));
    return effective.length > 0 ? effective : orgAgentIds;
}

export type EffectiveAgentContext = {
    agentIds: string[];
    orgAgentIds: string[];
    departmentId: string | null;
};

/**
 * Org admin → full org plan.
 * Team → org plan ∩ department.allowedAgents (empty dept list = full org plan).
 */
export async function getEffectiveAllowedAgentIds(
    user: Pick<AuthUser, 'role' | 'organizationId' | 'userId'>
): Promise<EffectiveAgentContext> {
    if (user.role === 'superAdmin') {
        // Super admins see the full registry catalog (not just the bundled fallback list).
        const all = await resolvePlanAgentIds();
        return {
            agentIds: all,
            orgAgentIds: all,
            departmentId: null,
        };
    }

    const orgEntitlement = await getOrgEntitlement(user.organizationId);
    const orgAgentIds = orgEntitlement.agentIds;

    if (user.role === 'admin') {
        return { agentIds: orgAgentIds, orgAgentIds, departmentId: null };
    }

    const ctx = await loadUserDeptContext(user as AuthUser);
    if (!ctx.departmentId) {
        return { agentIds: orgAgentIds, orgAgentIds, departmentId: null };
    }

    const dept = await Department.findOne({ departmentId: ctx.departmentId }).lean();
    const deptAgents = dept?.allowedAgents || [];
    return {
        agentIds: intersectDeptAgents(deptAgents, orgAgentIds),
        orgAgentIds,
        departmentId: ctx.departmentId,
    };
}

export async function getAllowedAgentsForUser(
    user: Pick<AuthUser, 'role' | 'organizationId' | 'userId'>
): Promise<string[]> {
    const effective = await getEffectiveAllowedAgentIds(user);
    return effective.agentIds;
}

/**
 * Reject if user requests an agent outside their effective entitlement
 * (org plan ∩ department for team members).
 */
export async function requireAllowedAgent(
    user: Pick<AuthUser, 'role' | 'organizationId' | 'userId'>,
    agentId: string | null | undefined
): Promise<
    | { ok: true; entitlement: OrgEntitlement; agentId?: string; orgAgentIds: string[] }
    | { ok: false; message: string; entitlement: OrgEntitlement; code: string; orgAgentIds: string[] }
> {
    const orgEntitlement = await getOrgEntitlement(user.organizationId);
    const effective = await getEffectiveAllowedAgentIds(user);
    const entitlement: OrgEntitlement = {
        ...orgEntitlement,
        agentIds: effective.agentIds,
    };
    const orgAgentIds = effective.orgAgentIds;

    if (user.role === 'superAdmin') {
        return { ok: true, entitlement, agentId: agentId || undefined, orgAgentIds };
    }
    if (!agentId) {
        return { ok: true, entitlement, orgAgentIds };
    }
    if (!isAgentAllowed(entitlement, agentId)) {
        const scope =
            effective.departmentId && effective.agentIds.length < orgAgentIds.length
                ? 'your department'
                : 'your plan';
        return {
            ok: false,
            code: 'AGENT_NOT_IN_PLAN',
            message: `Agent "${agentId}" is not included in ${scope}. Allowed agents: ${entitlement.agentIds.join(', ') || 'none'}.`,
            entitlement,
            orgAgentIds,
        };
    }
    return { ok: true, entitlement, agentId, orgAgentIds };
}

export async function syncOrgSubscriptionLabel(
    organizationId: string,
    planLabel: string
): Promise<void> {
    await Organization.updateOne(
        { organizationId },
        { $set: { subscriptionPlan: planLabel || 'free' } }
    );
}

export async function activateSubscription(params: {
    organizationId: string;
    planId?: string | null;
    planName?: string | null;
    agentIds: string[];
    storageGb: number;
    billingCycle: 'monthly' | 'yearly';
    price: number;
    activatedBy: string;
    requestId?: string | null;
}): Promise<IOrgSubscription> {
    const now = new Date();
    // Cancel previous active subs
    await OrgSubscription.updateMany(
        { organizationId: params.organizationId, status: 'active' },
        { $set: { status: 'cancelled' } }
    );

    const planLabel = params.planName || 'Custom';
    const sub = await OrgSubscription.create({
        subscriptionId: generateSubscriptionId(),
        organizationId: params.organizationId,
        planId: params.planId || null,
        planName: planLabel,
        agentIds: params.agentIds,
        storageGb: params.storageGb,
        billingCycle: params.billingCycle,
        price: params.price,
        status: 'active',
        startsAt: now,
        endsAt: addBillingPeriod(now, params.billingCycle),
        activatedBy: params.activatedBy,
        requestId: params.requestId || null,
    });

    await syncOrgSubscriptionLabel(params.organizationId, planLabel);
    return sub;
}
