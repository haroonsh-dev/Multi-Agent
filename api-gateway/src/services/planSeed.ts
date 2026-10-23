import Plan from '../models/Plan';
import { getOrCreatePricing, quoteFromPricing } from './planService';
import logger from '../utils/logger';

/** Stable planIds so re-seed is idempotent and does not duplicate. */
const SEED_PLANS: Array<{
    planId: string;
    name: string;
    description: string;
    billingCycle: 'monthly' | 'yearly';
    agentIds: string[];
    storageGb: number;
    /** If omitted, price is computed from pricing catalog */
    price?: number;
}> = [
    {
        planId: 'plan_seed_starter_monthly',
        name: 'Starter',
        description: 'HR + Other agents with light storage — good for small teams.',
        billingCycle: 'monthly',
        agentIds: ['hr_agent', 'other_agent'],
        storageGb: 5,
    },
    {
        planId: 'plan_seed_starter_yearly',
        name: 'Starter (Yearly)',
        description: 'Same as Starter, billed yearly.',
        billingCycle: 'yearly',
        agentIds: ['hr_agent', 'other_agent'],
        storageGb: 5,
    },
    {
        planId: 'plan_seed_business_monthly',
        name: 'Business',
        description: 'Finance, HR, and Legal agents with more storage.',
        billingCycle: 'monthly',
        agentIds: ['finance_agent', 'hr_agent', 'legal_agent', 'other_agent'],
        storageGb: 25,
    },
    {
        planId: 'plan_seed_business_yearly',
        name: 'Business (Yearly)',
        description: 'Business package billed yearly.',
        billingCycle: 'yearly',
        agentIds: ['finance_agent', 'hr_agent', 'legal_agent', 'other_agent'],
        storageGb: 25,
    },
    {
        planId: 'plan_seed_enterprise_monthly',
        name: 'Enterprise',
        description: 'All agents unlocked with large storage quota.',
        billingCycle: 'monthly',
        agentIds: [
            'finance_agent',
            'procurement_agent',
            'hr_agent',
            'legal_agent',
            'compliance_agent',
            'other_agent',
        ],
        storageGb: 100,
    },
    {
        planId: 'plan_seed_enterprise_yearly',
        name: 'Enterprise (Yearly)',
        description: 'Full agent suite + 100 GB, yearly billing.',
        billingCycle: 'yearly',
        agentIds: [
            'finance_agent',
            'procurement_agent',
            'hr_agent',
            'legal_agent',
            'compliance_agent',
            'other_agent',
        ],
        storageGb: 100,
    },
];

/**
 * Idempotent: ensures pricing catalog + starter named plans exist.
 * Does not overwrite plans that Super Admin already edited (matched by planId).
 */
export async function ensureDefaultPlansAndPricing(): Promise<{
    pricingReady: boolean;
    plansCreated: number;
    plansSkipped: number;
}> {
    const pricing = await getOrCreatePricing();
    let plansCreated = 0;
    let plansSkipped = 0;

    for (const seed of SEED_PLANS) {
        const existing = await Plan.findOne({ planId: seed.planId });
        if (existing) {
            plansSkipped += 1;
            continue;
        }
        const price =
            seed.price != null
                ? seed.price
                : quoteFromPricing(pricing, seed.agentIds, seed.storageGb, seed.billingCycle);

        await Plan.create({
            planId: seed.planId,
            name: seed.name,
            description: seed.description,
            billingCycle: seed.billingCycle,
            agentIds: seed.agentIds,
            storageGb: seed.storageGb,
            price,
            status: 'active',
        });
        plansCreated += 1;
    }

    return { pricingReady: true, plansCreated, plansSkipped };
}

/** Fire-and-forget wrapper for server boot. */
export async function seedPlansOnBoot(): Promise<void> {
    try {
        const result = await ensureDefaultPlansAndPricing();
        logger.info(
            `Plans seed: pricing ready, created=${result.plansCreated}, skipped=${result.plansSkipped}`
        );
    } catch (e: any) {
        logger.warn(`Plans seed failed: ${e.message || e}`);
    }
}
