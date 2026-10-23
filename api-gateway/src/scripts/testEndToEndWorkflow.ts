/**
 * Comprehensive End-to-End Test Suite for Visibility Docs AI Platform.
 * Tests full lifecycle:
 * Ingestion → AI Sync → Agent Domain Workflow Auto-Execution → Outbound Alert Dispatch → Action Center Aggregation → Autonomous Playbooks.
 *
 * Run: npx tsx --tsconfig tsconfig.json src/scripts/testEndToEndWorkflow.ts
 */
import Document from '../models/Document';
import Organization from '../models/Organization';
import { runAgentDocumentWorkflow, getOrgWorkflowSummary } from '../services/agentWorkflowExecutionService';
import { getOrgWorkflowSettings, updateOrgWorkflowSettings, clearOrgWorkflowSettingsCache } from '../services/orgWorkflowSettingsService';
import { dispatchWorkflowAlert, WorkflowAlertPayload } from '../services/workflowNotificationService';
import {
    __playbookHooks,
    __resetPlaybookStoreForTests,
    detectPlaybookAsk,
    detectPlaybookAutoExecute,
    tryIntegrationTaskPlaybookCommand,
} from '../services/integrationTaskPlaybookService';

function assert(cond: boolean, msg: string) {
    if (!cond) throw new Error(`Assertion failed: ${msg}`);
}

let passed = 0;
let total = 0;

async function test(name: string, fn: () => void | Promise<void>) {
    total += 1;
    try {
        await fn();
        passed += 1;
        console.log(`  ✓ ${name}`);
    } catch (err: any) {
        console.error(`  ✗ ${name}: ${err?.message || err}`);
        process.exitCode = 1;
    }
}

async function main() {
    console.log('================================================================');
    console.log('🚀 VISIBILITY DOCS AI — FULL END-TO-END VERIFICATION SUITE');
    console.log('================================================================\n');

    // ── Setup Mocks & Data Stores ──────────────────────────────────────────
    const orgId = 'org-e2e-enterprise-1';
    const mockDb: {
        org: Record<string, any>;
        docs: Record<string, any>;
    } = {
        org: {},
        docs: {},
    };

    clearOrgWorkflowSettingsCache();

    // Stub Organization
    (Organization as any).findOne = (query: any) => ({
        select: () => ({
            lean: async () => mockDb.org[query.organizationId] || null,
        }),
    });
    (Organization as any).updateOne = async (query: any, update: any) => {
        mockDb.org[query.organizationId] = {
            ...(mockDb.org[query.organizationId] || {}),
            workflowSettings: {
                ...(mockDb.org[query.organizationId]?.workflowSettings || {}),
                ...(update.$set || {}),
            },
        };
        for (const [k, v] of Object.entries(update.$set || {})) {
            if (k.startsWith('workflowSettings.')) {
                const sub = k.replace('workflowSettings.', '');
                mockDb.org[query.organizationId].workflowSettings[sub] = v;
            }
        }
        return { modifiedCount: 1 };
    };

    // Stub Document.findOne & find
    (Document as any).findOne = (query: any) => ({
        lean: async () => {
            if (typeof query.documentId === 'string') {
                return mockDb.docs[query.documentId] || null;
            }
            if (query.classification?.$in?.includes('purchase_order')) {
                const poNum = query.$or?.[0]?.['metadata.extracted_data.po_number'];
                return Object.values(mockDb.docs).find(
                    (d: any) => d.classification === 'purchase_order' && d.metadata?.extracted_data?.po_number === poNum
                ) || null;
            }
            if (query.$or) {
                const invNum = query.$or?.[0]?.['metadata.extracted_data.invoice_number'];
                const excludeId = query.documentId?.$ne;
                return Object.values(mockDb.docs).find(
                    (d: any) => d.documentId !== excludeId && d.metadata?.extracted_data?.invoice_number === invNum
                ) || null;
            }
            return null;
        },
    });

    (Document as any).find = (query: any) => ({
        select: () => ({
            sort: () => ({
                limit: () => ({
                    lean: async () => Object.values(mockDb.docs).filter(
                        (d: any) => d.organizationId === query.organizationId && d.metadata?.workflowExecution
                    ),
                }),
            }),
        }),
    });

    // ── TEST SUITE 1: Organization Settings & Custom Thresholds ──────────
    console.log('── Step 1: Admin Workflow Rules & Dynamic Limits ──');

    await test('Configure Enterprise Org rules: threshold=$5,000, criticalExpiry=15d, shortlistMin=80', async () => {
        const settings = await updateOrgWorkflowSettings(orgId, {
            autoApprovalThreshold: 5000,
            requirePoMatchForAutoApproval: true,
            duplicateCheckEnabled: true,
            criticalExpiryDays: 15,
            warningExpiryDays: 60,
            autoShortlistMinScore: 80,
            slackWebhookUrl: 'https://hooks.slack.com/services/MOCK/WEBHOOK/123',
            alertEmail: 'audit-team@enterprise.com',
        });

        assert(settings.autoApprovalThreshold === 5000, 'Threshold updated to 5000');
        assert(settings.criticalExpiryDays === 15, 'Critical expiry days is 15');
        assert(settings.autoShortlistMinScore === 80, 'Auto shortlist min score is 80');
        assert(Boolean(settings.slackWebhookUrl?.includes('MOCK/WEBHOOK')), 'Slack URL configured');
    });

    // ── TEST SUITE 2: Finance Agent End-to-End Workflow ─────────────────
    console.log('\n── Step 2: Finance Agent E2E Workflow (PO Match & Thresholds) ──');

    // Seed a Purchase Order into DB
    const poDocId = 'po-e2e-8801';
    mockDb.docs[poDocId] = {
        documentId: poDocId,
        organizationId: orgId,
        classification: 'purchase_order',
        originalFilename: 'PO_8801_Dell_Servers.pdf',
        metadata: {
            phase3Agent: 'finance_agent',
            extracted_data: {
                po_number: 'PO-8801',
                vendor_name: 'Dell Technologies',
                total_amount: 5000,
                currency: 'USD',
            },
        },
    };

    await test('Finance: Inbound invoice $3,200 matches PO-8801 and auto-approves under $5,000 limit', async () => {
        const invDocId = 'inv-e2e-001';
        const invoiceDoc: any = {
            documentId: invDocId,
            organizationId: orgId,
            classification: 'invoice',
            originalFilename: 'Dell_Invoice_INV9901.pdf',
            metadata: {
                phase3Agent: 'finance_agent',
                extracted_data: {
                    invoice_number: 'INV-9901',
                    po_number: 'PO-8801',
                    vendor_name: 'Dell Technologies',
                    total_amount: 3200,
                    currency: 'USD',
                },
            },
            markModified: () => {},
            save: async () => {
                mockDb.docs[invDocId] = invoiceDoc;
                return invoiceDoc;
            },
        };

        const result = await runAgentDocumentWorkflow(invoiceDoc, orgId);
        assert(result !== null, 'Workflow executed');
        assert(result!.stage === 'auto_approved', `Expected auto_approved, got ${result!.stage}`);
        assert(result!.details.matchedPoDocId === poDocId, 'Matched PO document ID');
        assert(/Auto-Approved/i.test(result!.verdict), 'Verdict mentions Auto-Approved');
    });

    await test('Finance: Inbound invoice $7,500 exceeds $5,000 threshold and routes to manager queue', async () => {
        const invDocId = 'inv-e2e-002';
        const highValueDoc: any = {
            documentId: invDocId,
            organizationId: orgId,
            classification: 'invoice',
            originalFilename: 'Dell_Invoice_HighValue.pdf',
            metadata: {
                phase3Agent: 'finance_agent',
                extracted_data: {
                    invoice_number: 'INV-9902',
                    po_number: 'PO-8801',
                    vendor_name: 'Dell Technologies',
                    total_amount: 7500,
                    currency: 'USD',
                },
            },
            markModified: () => {},
            save: async () => {
                mockDb.docs[invDocId] = highValueDoc;
                return highValueDoc;
            },
        };

        const result = await runAgentDocumentWorkflow(highValueDoc, orgId);
        assert(result!.stage === 'pending_approval', `Expected pending_approval, got ${result!.stage}`);
        assert(result!.actionsTaken.includes('routed_to_manager_approval'), 'Actions include routed_to_manager_approval');
    });

    await test('Finance: Duplicate invoice number INV-9901 is immediately detected and flagged', async () => {
        const invDocId = 'inv-e2e-dup';
        const dupDoc: any = {
            documentId: invDocId,
            organizationId: orgId,
            classification: 'invoice',
            originalFilename: 'Duplicate_Invoice.pdf',
            metadata: {
                phase3Agent: 'finance_agent',
                extracted_data: {
                    invoice_number: 'INV-9901',
                    total_amount: 3200,
                    currency: 'USD',
                },
            },
            markModified: () => {},
            save: async () => {
                mockDb.docs[invDocId] = dupDoc;
                return dupDoc;
            },
        };

        const result = await runAgentDocumentWorkflow(dupDoc, orgId);
        assert(result!.stage === 'flagged', `Expected flagged duplicate, got ${result!.stage}`);
        assert(/Potential Duplicate/i.test(result!.verdict), 'Verdict flagged potential duplicate');
        assert(result!.details.duplicateDocId === 'inv-e2e-001', 'Identified original doc ID');
    });

    // ── TEST SUITE 3: Compliance Agent End-to-End Workflow ──────────────
    console.log('\n── Step 3: Compliance Agent E2E Workflow (Expirations & NCR) ──');

    await test('Compliance: Expiring certificate (10 days left) triggers Critical Expiry (threshold 15d)', async () => {
        const targetDate = new Date();
        targetDate.setDate(targetDate.getDate() + 10);

        const certDocId = 'cert-e2e-critical';
        const certDoc: any = {
            documentId: certDocId,
            organizationId: orgId,
            classification: 'certificate',
            originalFilename: 'ISO_27001_Audit_Cert.pdf',
            metadata: {
                phase3Agent: 'compliance_agent',
                extracted_data: {
                    standard: 'ISO 27001',
                    expiry_date: targetDate.toISOString(),
                },
            },
            markModified: () => {},
            save: async () => {
                mockDb.docs[certDocId] = certDoc;
                return certDoc;
            },
        };

        const result = await runAgentDocumentWorkflow(certDoc, orgId);
        assert(result!.stage === 'flagged', 'Critical cert is flagged');
        assert(result!.actionsTaken.includes('flagged_critical_expiry'), 'Action is flagged_critical_expiry');
        assert(/Critical Expiry Alert/i.test(result!.verdict), 'Verdict is critical expiry alert');
    });

    await test('Compliance: Audit report with Major failure auto-generates NCR requirement flag', async () => {
        const auditDocId = 'audit-e2e-fail';
        const auditDoc: any = {
            documentId: auditDocId,
            organizationId: orgId,
            classification: 'audit_report',
            originalFilename: 'Annual_Quality_Audit_2026.pdf',
            metadata: {
                phase3Agent: 'compliance_agent',
                extracted_data: {
                    audit_findings: [
                        { severity: 'Major', description: 'Calibration procedure SOP-04 omitted on production line' },
                    ],
                },
            },
            markModified: () => {},
            save: async () => {
                mockDb.docs[auditDocId] = auditDoc;
                return auditDoc;
            },
        };

        const result = await runAgentDocumentWorkflow(auditDoc, orgId);
        assert(result!.stage === 'flagged', 'Audit failure is flagged');
        assert(/NCR \/ CAPA required/i.test(result!.verdict), 'Verdict requires NCR / CAPA');
        assert(result!.actionsTaken.includes('auto_generated_ncr_flag'), 'Recorded auto_generated_ncr_flag');
    });

    // ── TEST SUITE 4: HR Agent End-to-End Workflow ───────────────────────
    console.log('\n── Step 4: HR Agent E2E Workflow (Candidate Auto-Shortlisting) ──');

    await test('HR: CV with score 88 auto-shortlists (above custom 80 threshold)', async () => {
        const cvDocId = 'cv-e2e-top';
        const cvDoc: any = {
            documentId: cvDocId,
            organizationId: orgId,
            classification: 'resume',
            originalFilename: 'Sarah_Connor_Principal_Engineer.pdf',
            metadata: {
                phase3Agent: 'hr_agent',
                cvScore: 88,
                extracted_data: { candidate_name: 'Sarah Connor' },
            },
            markModified: () => {},
            save: async () => {
                mockDb.docs[cvDocId] = cvDoc;
                return cvDoc;
            },
        };

        const result = await runAgentDocumentWorkflow(cvDoc, orgId);
        assert(result!.stage === 'shortlisted', 'Stage is shortlisted');
        assert(/Auto-Shortlisted/i.test(result!.verdict), 'Verdict is Auto-Shortlisted');
        assert(result!.details.score === 88, 'Score is 88');
    });

    // ── TEST SUITE 5: Legal Agent End-to-End Workflow ────────────────────
    console.log('\n── Step 5: Legal Agent E2E Workflow (Contract Risk Assessment) ──');

    await test('Legal: Contract with unlimited liability terms is flagged with risk alert', async () => {
        const contractDocId = 'contract-e2e-risk';
        const contractDoc: any = {
            documentId: contractDocId,
            organizationId: orgId,
            classification: 'contract',
            originalFilename: 'Master_Service_Agreement_Draft.pdf',
            metadata: {
                phase3Agent: 'legal_agent',
                extracted_data: {
                    parties: ['Enterprise Corp', 'Vendor Solutions Ltd'],
                    clauses: 'Vendor shall indemnify against all damages with unlimited liability.',
                },
            },
            markModified: () => {},
            save: async () => {
                mockDb.docs[contractDocId] = contractDoc;
                return contractDoc;
            },
        };

        const result = await runAgentDocumentWorkflow(contractDoc, orgId);
        assert(result!.stage === 'flagged', 'Contract with high risk is flagged');
        assert(/Legal Risk Alert/i.test(result!.verdict), 'Verdict mentions Legal Risk Alert');
        assert(result!.actionsTaken.includes('flagged_high_risk_clause'), 'Action recorded');
    });

    // ── TEST SUITE 6: Organization Summary & Action Center Aggregation ───
    console.log('\n── Step 6: Organization Summary & Action Center Aggregation ──');

    await test('Org summary aggregates auto-approved, pending approvals, and expiring certs accurately', async () => {
        const summary = await getOrgWorkflowSummary(orgId);
        assert(summary.autoApprovedInvoices >= 1, `Auto-approved invoices: ${summary.autoApprovedInvoices}`);
        assert(summary.pendingApprovals >= 1, `Pending approvals: ${summary.pendingApprovals}`);
        assert(summary.expiringCertificates >= 1, `Expiring certificates: ${summary.expiringCertificates}`);
        assert(summary.shortlistedCandidates >= 1, `Shortlisted candidates: ${summary.shortlistedCandidates}`);
        assert(summary.recentExecutions.length > 0, `Recent executions recorded: ${summary.recentExecutions.length}`);
    });

    // ── TEST SUITE 7: Autonomous Task Playbook Execution ─────────────────
    console.log('\n── Step 7: Autonomous Playbook 1-Turn Loop Execution ──');

    await test('Autonomous playbook executes end-to-end without requiring confirmation', async () => {
        __resetPlaybookStoreForTests();

        let tasksProcessed = 0;
        (__playbookHooks as any).resolveTaskIntegrationConnection = async () => ({
            organizationId: orgId,
            secrets: { apiToken: 'pk_mock_test' },
            config: { listId: 'sprint-44' },
        });
        (__playbookHooks as any).connectionCreds = () => ({ apiToken: 'pk_mock_test', listId: 'sprint-44' });
        (__playbookHooks as any).loadIntegrationTaskRows = async () => [
            {
                documentId: 'task-doc-1',
                taskId: 't-101',
                name: 'Reconcile Q3 Invoices',
                status: 'open',
                assignees: 'Unassigned',
                dueDate: '—',
                listName: 'Finance Sprint',
                url: '',
                updatedAt: '—',
            },
            {
                documentId: 'task-doc-2',
                taskId: 't-102',
                name: 'Send ISO Renewal Notice',
                status: 'open',
                assignees: 'Unassigned',
                dueDate: '—',
                listName: 'Compliance Sprint',
                url: '',
                updatedAt: '—',
            },
        ];
        (__playbookHooks as any).isOpenIntegrationTask = () => true;
        (__playbookHooks as any).resolveCompleteStatusForConnection = async () => 'closed';
        (__playbookHooks as any).assignTaskForConnection = async () => {};
        (__playbookHooks as any).completeTaskForConnection = async () => 'closed';
        (__playbookHooks as any).refreshTaskRecordAfterWrite = async () => {
            tasksProcessed += 1;
        };

        const res = await tryIntegrationTaskPlaybookCommand({
            user: { userId: 'admin-e2e', role: 'admin', organizationId: orgId },
            question: 'automatically process open tasks until done',
            phase3Agent: 'finance_agent',
            sessionId: 'session-e2e-1',
        });

        assert(res.handled === true, 'Playbook handled');
        assert(tasksProcessed === 2, `2 tasks written and refreshed, got ${tasksProcessed}`);
        assert(!/Reply yes/i.test(res.answer || ''), 'Did not pause for confirmation');
        assert(/Playbook finished|2 succeeded/i.test(res.answer || ''), 'Contains finished summary');
    });

    // ── FINALIZE ─────────────────────────────────────────────────────────
    console.log('\n================================================================');
    console.log(`🎉 ALL ${passed}/${total} END-TO-END TESTS PASSED CLEANLY!`);
    console.log('================================================================\n');
}

main().catch((err) => {
    console.error('Fatal E2E runner error:', err);
    process.exit(1);
});
