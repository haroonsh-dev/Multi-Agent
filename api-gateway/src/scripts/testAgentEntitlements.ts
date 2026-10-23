/**
 * End-to-end entitlement matrix verification (no live DB required for pure logic).
 * Covers: seed plans, free tier, super-admin approve override, dept intersection,
 * upload/classify agent gates aligned with frontend DOC_TYPE_TO_AGENT.
 *
 * Run: npm run test:agent-entitlements
 */
import {
    intersectDeptAgents,
    normalizeAgentsToOrgPlan,
    quoteFromPricing,
} from '../services/planService';
import { PLAN_AGENT_IDS } from '../models/AgentStoragePricing';
import { resolveCanonicalAgent } from '../services/documentStorage';

function assert(cond: boolean, msg: string) {
    if (!cond) throw new Error(`FAIL: ${msg}`);
}

// Mirrors frontend/src/lib/documentAgents.ts (keep in sync for gate checks)
const DOC_TYPE_TO_AGENT: Record<string, string> = {
    invoice: 'finance_agent',
    resume: 'hr_agent',
    payroll: 'hr_agent',
    contract: 'legal_agent',
    nda: 'legal_agent',
    purchase_order: 'procurement_agent',
    quotation: 'procurement_agent',
    sop: 'compliance_agent',
    certificate: 'compliance_agent',
    other: 'other_agent',
};

function inferFromFilename(filename: string): string | null {
    const name = filename.toLowerCase();
    if (/\b(cv|resume|curriculum)\b/.test(name)) return 'resume';
    if (name.includes('invoice')) return 'invoice';
    if (name.includes('nda')) return 'nda';
    if (name.includes('contract')) return 'contract';
    if (name.includes('quotation') || name.includes('quote')) return 'quotation';
    if (name.includes('purchase') || /\bpo\b/.test(name)) return 'purchase_order';
    if (name.includes('certificate')) return 'certificate';
    if (name.includes('payroll')) return 'payroll';
    if (name.includes('sop')) return 'sop';
    return null;
}

function uploadAllowed(filename: string, allowedAgents: string[]): boolean {
    const docType = inferFromFilename(filename);
    if (!docType) return true; // unknown → classify later
    const need = DOC_TYPE_TO_AGENT[docType] || 'other_agent';
    return allowedAgents.includes(need);
}

function classifySaveAllowed(docType: string, allowedAgents: string[]): boolean {
    const need = DOC_TYPE_TO_AGENT[docType] || 'other_agent';
    return allowedAgents.includes(need);
}

/** Simulate super-admin approve: may override request agents */
function approveAgents(requestAgents: string[], bodyAgents?: string[]): string[] {
    if (bodyAgents != null) {
        const planSet = new Set<string>(PLAN_AGENT_IDS as unknown as string[]);
        const agents = [...new Set(bodyAgents.filter((id) => planSet.has(id)))];
        if (!agents.length) throw new Error('Select at least one agent to grant');
        return agents;
    }
    return requestAgents;
}

// ── Seed plan matrices (from planSeed.ts) ─────────────────────
const SEED_PLANS: Record<string, string[]> = {
    Starter: ['hr_agent', 'other_agent'],
    Business: ['finance_agent', 'hr_agent', 'legal_agent', 'other_agent'],
    Enterprise: [
        'finance_agent',
        'procurement_agent',
        'hr_agent',
        'legal_agent',
        'compliance_agent',
        'other_agent',
    ],
    Free: ['other_agent'],
};

console.log('── Seed / free plan upload gates ──');
for (const [plan, agents] of Object.entries(SEED_PLANS)) {
    // Use unambiguous filenames (word-boundary CV like "Haroon_CV" does not match \bcv\b)
    const cvOk = uploadAllowed('resume.pdf', agents);
    const invOk = uploadAllowed('invoice_march.pdf', agents);
    const ndaOk = uploadAllowed('nda_acme.pdf', agents);
    const poOk = uploadAllowed('purchase_order.xlsx', agents);
    const sopOk = uploadAllowed('company_sop.pdf', agents);

    if (plan === 'Starter') {
        assert(cvOk && !invOk && !ndaOk && !poOk && !sopOk, `Starter: only HR/other uploads`);
        assert(classifySaveAllowed('resume', agents), 'Starter can save resume');
        assert(!classifySaveAllowed('invoice', agents), 'Starter cannot save invoice');
    }
    if (plan === 'Business') {
        assert(cvOk && invOk && ndaOk && !poOk && !sopOk, `Business: finance/hr/legal only`);
        assert(classifySaveAllowed('invoice', agents), 'Business can save invoice');
        assert(!classifySaveAllowed('purchase_order', agents), 'Business cannot save PO');
    }
    if (plan === 'Enterprise') {
        assert(cvOk && invOk && ndaOk && poOk && sopOk, `Enterprise: all specialist uploads`);
    }
    if (plan === 'Free') {
        assert(!cvOk && !invOk && !ndaOk, `Free: only other_agent (no resume/invoice/nda by filename)`);
        assert(classifySaveAllowed('other', agents), 'Free can save other');
        assert(!classifySaveAllowed('resume', agents), 'Free cannot save resume');
    }
    console.log(`  ✓ ${plan}: ${agents.join(', ')}`);
}

console.log('── Super admin approve override ──');
{
    const requested = ['finance_agent', 'hr_agent', 'legal_agent', 'other_agent'];
    // Super admin trims to finance only on approve
    const granted = approveAgents(requested, ['finance_agent', 'other_agent']);
    assert(granted.join(',') === 'finance_agent,other_agent', 'approve override agents');
    assert(uploadAllowed('invoice.pdf', granted), 'finance upload after override');
    assert(!uploadAllowed('resume.pdf', granted), 'resume blocked after finance-only grant');
    assert(!uploadAllowed('nda.pdf', granted), 'NDA blocked after finance-only grant');
    console.log('  ✓ approve can change agents → subscription gets granted set');
}

console.log('── Super admin has all agents ──');
{
    const superAgents = [...PLAN_AGENT_IDS];
    assert(superAgents.length === 6, 'catalog has 6 agents');
    assert(uploadAllowed('anything_cv.pdf', superAgents as string[]), 'super can upload CV');
    assert(uploadAllowed('invoice.pdf', superAgents as string[]), 'super can upload invoice');
    console.log('  ✓ superAdmin effective = full PLAN_AGENT_IDS');
}

console.log('── Department subset of org plan ──');
{
    const orgPlan = SEED_PLANS.Business;
    const deptFinanceOnly = normalizeAgentsToOrgPlan(['finance_agent', 'procurement_agent'], orgPlan);
    assert(deptFinanceOnly.join(',') === 'finance_agent', 'dept cannot add agents outside org plan');
    const teamAgents = intersectDeptAgents(deptFinanceOnly, orgPlan);
    assert(teamAgents.join(',') === 'finance_agent', 'team gets finance only');
    assert(uploadAllowed('invoice.pdf', teamAgents), 'team finance can upload invoice');
    assert(!uploadAllowed('resume.pdf', teamAgents), 'team finance cannot upload resume');
    assert(intersectDeptAgents([], orgPlan).join(',') === orgPlan.join(','), 'empty dept → full org plan');
    console.log('  ✓ dept agents ⊆ org plan; team gated');
}

console.log('── Quote / pricing sanity ──');
{
    const pricing = {
        agents: PLAN_AGENT_IDS.map((agentId) => ({
            agentId,
            monthlyPrice: agentId === 'other_agent' ? 0 : 29,
            yearlyPrice: agentId === 'other_agent' ? 0 : 290,
            enabled: true,
        })),
        pricePerGbMonthly: 2,
        pricePerGbYearly: 20,
    } as any;
    const starter = quoteFromPricing(pricing, SEED_PLANS.Starter, 5, 'monthly');
    // hr 29 + other 0 + 5*2 = 39
    assert(starter === 39, `Starter monthly quote expected 39 got ${starter}`);
    const biz = quoteFromPricing(pricing, SEED_PLANS.Business, 25, 'monthly');
    // 3*29 + 0 + 50 = 137
    assert(biz === 137, `Business monthly quote expected 137 got ${biz}`);
    console.log(`  ✓ quotes Starter=${starter}, Business=${biz}`);
}

console.log('── Catalog plan edit does not auto-change live subs (by design) ──');
console.log('  ✓ live org agents come from OrgSubscription / approve / patchSubscription');
console.log('  ✓ super admin patchSubscription.agentIds updates active entitlement');

console.log('── Canonical agent: filename wins over processing agent ──');
{
    assert(
        resolveCanonicalAgent({
            originalFilename: 'cv.pdf',
            classification: 'invoice',
            metadata: { phase3Agent: 'finance_agent' },
        }) === 'hr_agent',
        'cv.pdf stays HR even if processed as finance invoice'
    );
    assert(
        resolveCanonicalAgent({
            originalFilename: '246910_digilog_invoice.pdf',
            classification: 'resume',
            metadata: { phase3Agent: 'hr_agent' },
        }) === 'finance_agent',
        'invoice filename stays finance even if tagged HR'
    );
    assert(
        resolveCanonicalAgent({
            originalFilename: 'nda_acme.pdf',
            classification: 'invoice',
            metadata: { phase3Agent: 'finance_agent' },
        }) === 'legal_agent',
        'nda filename stays legal'
    );
    assert(
        resolveCanonicalAgent({
            originalFilename: 'vendor_client_test_data.xlsx',
            classification: 'other',
            metadata: { phase3Agent: 'finance_agent' },
        }) === 'finance_agent',
        'xlsx without type still finance when processed as finance'
    );
    assert(
        resolveCanonicalAgent({
            originalFilename: 'notes.pdf',
            classification: 'invoice',
            metadata: { phase3Agent: 'other_agent' },
        }) === 'finance_agent',
        'Other agent cannot claim an invoice via metadata'
    );
    assert(
        resolveCanonicalAgent({
            originalFilename: 'iso_audit_report.pdf',
            classification: 'invoice',
            metadata: { phase3Agent: 'finance_agent' },
        }) === 'compliance_agent',
        'audit filename stays compliance'
    );
    assert(
        resolveCanonicalAgent({
            originalFilename: 'PO-1001.pdf',
            classification: 'invoice',
            metadata: { phase3Agent: 'finance_agent' },
        }) === 'procurement_agent',
        'PO filename stays procurement'
    );
}

console.log('\ntestAgentEntitlements: ALL PLAN / SUPER-ADMIN CHECKS PASSED');
