/**
 * Test automated agent workflow execution rules across agents.
 * Run: npx tsx --tsconfig tsconfig.json src/scripts/testAgentWorkflowExecution.ts
 */
import Document from '../models/Document';
import Organization from '../models/Organization';
import { runAgentDocumentWorkflow, getOrgWorkflowSummary } from '../services/agentWorkflowExecutionService';

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
    console.log('=== Automated Agent Workflow Execution Tests ===\n');

    // Stub Organization.findOne
    (Organization as any).findOne = () => ({
        select: () => ({
            lean: async () => null,
        }),
    });

    // Stub Document.findOne
    let mockExistingPo: any = null;
    let mockDuplicateDoc: any = null;
    (Document as any).findOne = (query: any) => ({
        lean: async () => {
            if (query.classification?.$in?.includes('purchase_order') && mockExistingPo) {
                return mockExistingPo;
            }
            if (query.$or && mockDuplicateDoc) {
                return mockDuplicateDoc;
            }
            return null;
        },
    });

    await check('Finance Agent: Auto-approves invoice within $1,000 threshold when PO matched', async () => {
        mockExistingPo = { documentId: 'po-doc-123', originalFilename: 'PO-8842.pdf' };
        mockDuplicateDoc = null;

        const fakeDoc: any = {
            documentId: 'inv-doc-1',
            classification: 'invoice',
            originalFilename: 'INV-2024-001.pdf',
            metadata: {
                phase3Agent: 'finance_agent',
                extracted_data: {
                    invoice_number: 'INV-2024-001',
                    po_number: 'PO-8842',
                    total_amount: 450,
                    currency: 'USD',
                    vendor_name: 'Acme Supplies',
                },
            },
            markModified: () => {},
            save: async () => fakeDoc,
        };

        const result = await runAgentDocumentWorkflow(fakeDoc, 'org-test');
        assert(Boolean(result), 'result should not be null');
        assert(result!.stage === 'auto_approved', `expected auto_approved, got ${result!.stage}`);
        assert(/Auto-Approved/i.test(result!.verdict), 'verdict should mention auto-approved');
        assert(result!.actionsTaken.includes('auto_approved_within_threshold'), 'actions should include auto approval');
        assert(result!.details.matchedPoDocId === 'po-doc-123', 'matched PO id matches');
    });

    await check('Finance Agent: Routes high-value invoice (> $1,000) to manager approval', async () => {
        mockExistingPo = { documentId: 'po-doc-123', originalFilename: 'PO-8842.pdf' };
        mockDuplicateDoc = null;

        const fakeDoc: any = {
            documentId: 'inv-doc-2',
            classification: 'invoice',
            originalFilename: 'INV-2024-002.pdf',
            metadata: {
                phase3Agent: 'finance_agent',
                extracted_data: {
                    invoice_number: 'INV-2024-002',
                    po_number: 'PO-8842',
                    total_amount: 5400,
                    currency: 'USD',
                    vendor_name: 'Industrial Heavy Equip',
                },
            },
            markModified: () => {},
            save: async () => fakeDoc,
        };

        const result = await runAgentDocumentWorkflow(fakeDoc, 'org-test');
        assert(result!.stage === 'pending_approval', `expected pending_approval, got ${result!.stage}`);
        assert(/Manager Approval/i.test(result!.verdict), 'verdict should mention manager approval');
        assert(result!.actionsTaken.includes('routed_to_manager_approval'), 'actions should include manager routing');
    });

    await check('Finance Agent: Flags duplicate invoice numbers', async () => {
        mockExistingPo = null;
        mockDuplicateDoc = { documentId: 'inv-original-99' };

        const fakeDoc: any = {
            documentId: 'inv-doc-3',
            classification: 'invoice',
            originalFilename: 'INV-2024-DUP.pdf',
            metadata: {
                phase3Agent: 'finance_agent',
                extracted_data: {
                    invoice_number: 'INV-DUP-1',
                    total_amount: 100,
                },
            },
            markModified: () => {},
            save: async () => fakeDoc,
        };

        const result = await runAgentDocumentWorkflow(fakeDoc, 'org-test');
        assert(result!.stage === 'flagged', `expected flagged, got ${result!.stage}`);
        assert(/Potential Duplicate/i.test(result!.verdict), 'verdict should flag duplicate');
        assert(result!.actionsTaken.includes('flagged_duplicate'), 'actions should include duplicate flag');
    });

    await check('Compliance Agent: Detects expired and critical expiry certificates', async () => {
        // Expired date
        const expiredDoc: any = {
            documentId: 'cert-1',
            classification: 'certificate',
            originalFilename: 'ISO_Expired.pdf',
            metadata: {
                phase3Agent: 'compliance_agent',
                extracted_data: {
                    standard: 'ISO 9001',
                    expiry_date: '2023-01-01',
                },
            },
            markModified: () => {},
            save: async () => expiredDoc,
        };

        const res1 = await runAgentDocumentWorkflow(expiredDoc, 'org-test');
        assert(res1!.stage === 'flagged', 'expired should be flagged');
        assert(/Expired/i.test(res1!.verdict), 'verdict should mention expired');

        // Valid future date
        const validDoc: any = {
            documentId: 'cert-2',
            classification: 'certificate',
            originalFilename: 'ISO_Valid.pdf',
            metadata: {
                phase3Agent: 'compliance_agent',
                extracted_data: {
                    standard: 'ISO 27001',
                    expiry_date: '2028-12-31',
                },
            },
            markModified: () => {},
            save: async () => validDoc,
        };

        const res2 = await runAgentDocumentWorkflow(validDoc, 'org-test');
        assert(res2!.stage === 'completed', 'valid cert should be completed');
        assert(/Valid Compliance Certificate/i.test(res2!.verdict), 'verdict should confirm valid');
    });

    await check('Compliance Agent: Flags NCR requirement when audit findings fail', async () => {
        const auditDoc: any = {
            documentId: 'audit-1',
            classification: 'audit_report',
            originalFilename: 'Q4_Audit.pdf',
            metadata: {
                phase3Agent: 'compliance_agent',
                extracted_data: {
                    audit_findings: [
                        { severity: 'Major', description: 'Calibration gauge failed test' },
                    ],
                },
            },
            markModified: () => {},
            save: async () => auditDoc,
        };

        const result = await runAgentDocumentWorkflow(auditDoc, 'org-test');
        assert(result!.stage === 'flagged', 'failed audit should be flagged');
        assert(/NCR \/ CAPA required/i.test(result!.verdict), 'verdict should mention NCR required');
        assert(result!.actionsTaken.includes('auto_generated_ncr_flag'), 'should log NCR flag action');
    });

    await check('HR Agent: Auto-shortlists candidate CVs with score >= 75', async () => {
        const cvDoc: any = {
            documentId: 'cv-1',
            classification: 'resume',
            originalFilename: 'Jane_Doe_Resume.pdf',
            metadata: {
                phase3Agent: 'hr_agent',
                cvScore: 88,
                extracted_data: {
                    candidate_name: 'Jane Doe',
                },
            },
            markModified: () => {},
            save: async () => cvDoc,
        };

        const result = await runAgentDocumentWorkflow(cvDoc, 'org-test');
        assert(result!.stage === 'shortlisted', 'score 88 should be shortlisted');
        assert(/Auto-Shortlisted/i.test(result!.verdict), 'verdict should confirm shortlisted');
        assert(result!.actionsTaken.includes('auto_shortlisted_candidate'), 'should record auto shortlist action');
    });

    await check('Legal Agent: Flags contracts with high-risk unlimited liability clauses', async () => {
        const contractDoc: any = {
            documentId: 'contract-1',
            classification: 'contract',
            originalFilename: 'Vendor_Agreement.pdf',
            metadata: {
                phase3Agent: 'legal_agent',
                extracted_data: {
                    clauses: 'Party B assumes unlimited liability for all damages',
                },
            },
            markModified: () => {},
            save: async () => contractDoc,
        };

        const result = await runAgentDocumentWorkflow(contractDoc, 'org-test');
        assert(result!.stage === 'flagged', 'unlimited liability should be flagged');
        assert(/Legal Risk Alert/i.test(result!.verdict), 'verdict should mention risk alert');
        assert(result!.actionsTaken.includes('flagged_high_risk_clause'), 'should record risk flag');
    });

    console.log(`\n${passed} checks passed.`);
    if (process.exitCode) process.exit(1);
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
