/**
 * Test configurable admin workflow rules, custom threshold limits, and notification dispatch.
 * Run: npx tsx --tsconfig tsconfig.json src/scripts/testConfigurableWorkflowRules.ts
 */
import Document from '../models/Document';
import { runAgentDocumentWorkflow } from '../services/agentWorkflowExecutionService';
import {
    defaultWorkflowSettings,
    getOrgWorkflowSettings,
    updateOrgWorkflowSettings,
    clearOrgWorkflowSettingsCache,
} from '../services/orgWorkflowSettingsService';
import Organization from '../models/Organization';

function assert(cond: boolean, msg: string) {
    if (!cond) throw new Error(msg);
}

let passed = 0;
function check(name: string, fn: () => void | Promise<void>) {
    return Promise.resolve()
        .then(() => fn())
        .then(() => {
            passed += 1;
            console.log(`✓ ${name}`);
        })
        .catch((e: unknown) => {
            const err = e as { message?: string };
            console.error(`✗ ${name}: ${err?.message || e}`);
            process.exitCode = 1;
        });
}

async function main() {
    console.log('=== Configurable Workflow Rules & Dynamic Threshold Tests ===\n');

    // 1. Test Default Settings
    await check('Default workflow settings initialization', () => {
        const def = defaultWorkflowSettings();
        assert(def.autoApprovalThreshold === 1000, 'default threshold is 1000');
        assert(def.requirePoMatchForAutoApproval === true, 'default require PO match');
        assert(def.duplicateCheckEnabled === true, 'default duplicate check enabled');
        assert(def.criticalExpiryDays === 30, 'default critical expiry 30');
        assert(def.warningExpiryDays === 90, 'default warning expiry 90');
        assert(def.autoShortlistMinScore === 75, 'default shortlist min score 75');
    });

    // 2. Test In-Memory Organization Workflow Settings Mocking
    let mockOrgDb: any = {};
    (Organization as any).findOne = (query: any) => ({
        select: () => ({
            lean: async () => mockOrgDb[query.organizationId] || null,
        }),
    });
    (Organization as any).updateOne = async (query: any, update: any) => {
        mockOrgDb[query.organizationId] = {
            ...mockOrgDb[query.organizationId],
            workflowSettings: {
                ...(mockOrgDb[query.organizationId]?.workflowSettings || {}),
                ...(update.$set || {}),
            },
        };
        // Normalize dotted paths
        for (const [k, v] of Object.entries(update.$set || {})) {
            if (k.startsWith('workflowSettings.')) {
                const subKey = k.replace('workflowSettings.', '');
                mockOrgDb[query.organizationId].workflowSettings[subKey] = v;
            }
        }
        return { modifiedCount: 1 };
    };

    const orgId = 'org-custom-rules-test';
    clearOrgWorkflowSettingsCache();

    await check('Get settings falls back to defaults when no org record exists', async () => {
        const s = await getOrgWorkflowSettings(orgId);
        assert(s.autoApprovalThreshold === 1000, 'fallback to 1000');
    });

    await check('Update workflow settings updates org limits and notification targets', async () => {
        const updated = await updateOrgWorkflowSettings(orgId, {
            autoApprovalThreshold: 3500,
            requirePoMatchForAutoApproval: false,
            duplicateCheckEnabled: true,
            criticalExpiryDays: 14,
            warningExpiryDays: 60,
            autoShortlistMinScore: 85,
            slackWebhookUrl: 'https://hooks.slack.com/services/T00/B00/X00',
            alertEmail: 'ap-alerts@testcorp.com',
        });

        assert(updated.autoApprovalThreshold === 3500, 'updated threshold to 3500');
        assert(updated.requirePoMatchForAutoApproval === false, 'updated requirePoMatch to false');
        assert(updated.criticalExpiryDays === 14, 'updated critical expiry to 14');
        assert(updated.autoShortlistMinScore === 85, 'updated min score to 85');
        assert(updated.slackWebhookUrl === 'https://hooks.slack.com/services/T00/B00/X00', 'slack webhook set');
        assert(updated.alertEmail === 'ap-alerts@testcorp.com', 'alert email set');
    });

    // 3. Test Dynamic Threshold Enforcement in Workflows
    // Mock Document.findOne for PO matching & duplicate check
    let mockExistingPo: any = null;
    (Document as any).findOne = (query: any) => ({
        lean: async () => {
            if (query.classification?.$in?.includes('purchase_order') && mockExistingPo) {
                return mockExistingPo;
            }
            return null;
        },
    });

    await check('Finance Agent respects custom threshold ($3,500) and auto-approves invoice of $2,400', async () => {
        mockExistingPo = { documentId: 'po-custom-1', originalFilename: 'PO-999.pdf' };

        const invoiceDoc: any = {
            documentId: 'inv-high-threshold-1',
            organizationId: orgId,
            classification: 'invoice',
            originalFilename: 'INV-MidValue.pdf',
            metadata: {
                phase3Agent: 'finance_agent',
                extracted_data: {
                    invoice_number: 'INV-MV-101',
                    po_number: 'PO-999',
                    total_amount: 2400,
                    currency: 'USD',
                },
            },
            markModified: () => {},
            save: async () => invoiceDoc,
        };

        const result = await runAgentDocumentWorkflow(invoiceDoc, orgId);
        assert(Boolean(result), 'workflow result returned');
        // Under default $1,000 threshold this would be pending_approval. Under custom $3,500 it is auto_approved!
        assert(result!.stage === 'auto_approved', `expected auto_approved under $3,500 limit, got ${result!.stage}`);
        assert(/Auto-Approved/i.test(result!.verdict), 'verdict mentions auto-approved');
        assert(result!.details.autoApprovalLimit === 3500, 'details record custom threshold 3500');
    });

    await check('Finance Agent auto-approves unpaired invoice when requirePoMatchForAutoApproval is false', async () => {
        mockExistingPo = null; // No PO match

        const unpairedDoc: any = {
            documentId: 'inv-unpaired-1',
            organizationId: orgId,
            classification: 'invoice',
            originalFilename: 'INV-NoPO.pdf',
            metadata: {
                phase3Agent: 'finance_agent',
                extracted_data: {
                    invoice_number: 'INV-NOPO-1',
                    total_amount: 800,
                    currency: 'USD',
                },
            },
            markModified: () => {},
            save: async () => unpairedDoc,
        };

        const result = await runAgentDocumentWorkflow(unpairedDoc, orgId);
        assert(result!.stage === 'auto_approved', `expected auto_approved when PO not required, got ${result!.stage}`);
    });

    await check('Compliance Agent respects custom critical window (14 days instead of 30)', async () => {
        // Document expiring in 20 days
        const futureDate = new Date();
        futureDate.setDate(futureDate.getDate() + 20);

        const certDoc: any = {
            documentId: 'cert-custom-1',
            organizationId: orgId,
            classification: 'certificate',
            originalFilename: 'ISO_20d.pdf',
            metadata: {
                phase3Agent: 'compliance_agent',
                extracted_data: {
                    standard: 'ISO 14001',
                    expiry_date: futureDate.toISOString(),
                },
            },
            markModified: () => {},
            save: async () => certDoc,
        };

        const result = await runAgentDocumentWorkflow(certDoc, orgId);
        // With default criticalDays=30, 20 days is flagged_critical_expiry.
        // With custom criticalDays=14, 20 days is flagged_warning_expiry!
        assert(result!.actionsTaken.includes('flagged_warning_expiry'), '20 days is warning window when critical is 14');
    });

    await check('HR Agent respects custom shortlist threshold (85 score instead of 75)', async () => {
        // Candidate with score 80 (below custom threshold 85)
        const cvDoc: any = {
            documentId: 'cv-custom-1',
            organizationId: orgId,
            classification: 'resume',
            originalFilename: 'Candidate_Score80.pdf',
            metadata: {
                phase3Agent: 'hr_agent',
                cvScore: 80,
                extracted_data: { candidate_name: 'Alex Developer' },
            },
            markModified: () => {},
            save: async () => cvDoc,
        };

        const result = await runAgentDocumentWorkflow(cvDoc, orgId);
        // With custom min score 85, score 80 is NOT shortlisted
        assert(result!.stage === 'completed', `score 80 is completed not shortlisted under 85 threshold, got ${result!.stage}`);
        assert(!result!.actionsTaken.includes('auto_shortlisted_candidate'), 'should not auto-shortlist');
    });

    console.log(`\n${passed} checks passed.`);
    if (process.exitCode) process.exit(1);
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
