/**
 * Compliance analytics unit fixtures (no DB).
 * Run: npx tsx --tsconfig tsconfig.json src/scripts/testComplianceGolden.ts
 */
import {
    parseComplianceExtraction,
    deriveCertStatus,
    normalizeOverallStatus,
    extractComplianceFindings,
    analyzeMissingComplianceDocs,
    COMPLIANCE_AGENT,
} from '../services/complianceAnalyticsService';
import {
    detectComplianceReportCommand,
    detectComplianceSectionPdf,
    detectComplianceLetter,
    detectComplianceExpiryAsk,
    detectComplianceMissingDocsAsk,
} from '../services/complianceChatActionService';
import { classifyComplianceWorkIntent } from '../services/complianceIntentRouter';
import { detectComplianceVisualIntent } from '../services/complianceChatVisualService';

function assert(cond: boolean, msg: string) {
    if (!cond) throw new Error(msg);
}

let passed = 0;
function check(name: string, fn: () => void) {
    try {
        fn();
        passed += 1;
        console.log(`✓ ${name}`);
    } catch (e: unknown) {
        const err = e as { message?: string };
        console.error(`✗ ${name}: ${err?.message || e}`);
        process.exitCode = 1;
    }
}

check('certificate field aliases → standard + expiry', () => {
    const snap = parseComplianceExtraction(
        {
            certificate_number: 'ISO-1',
            certification_standard: 'ISO 14001:2015',
            expiry_date: '2099-01-01',
            issued_to: 'Acme',
        },
        { documentId: 'c1', filename: 'cert.pdf', classification: 'certificate' }
    );
    assert(snap.standardOrRegulation === 'ISO 14001:2015', 'standard alias');
    assert(snap.certificateNumber === 'ISO-1', 'cert #');
    assert(snap.certStatus === 'VALID', `status=${snap.certStatus}`);
});

check('regulatory expiration_date alias', () => {
    const snap = parseComplianceExtraction(
        {
            license_permit_number: 'LIC-1',
            expiration_date: '2020-01-01',
            mandatory_conditions: ['Keep ETP running'],
        },
        { documentId: 'r1', filename: 'permit.pdf', classification: 'regulatory_document' }
    );
    assert(snap.certStatus === 'EXPIRED', `status=${snap.certStatus}`);
    assert(snap.certificateNumber === 'LIC-1', 'license #');
    assert(snap.findings.length >= 1, 'conditions as findings when no other findings');
});

check('inspection FAIL rows → findings + status normalize', () => {
    const snap = parseComplianceExtraction(
        {
            overall_rating: 'Needs Improvement',
            inspected_items: [
                { area_item: 'Panel', status: 'FAIL', remarks: 'Exposed wiring' },
                { area_item: 'Floor', status: 'PASS', remarks: 'OK' },
            ],
        },
        { documentId: 'i1', filename: 'insp.pdf', classification: 'inspection_report' }
    );
    assert(snap.findings.length === 1, `findings=${snap.findings.length}`);
    assert(snap.findings[0].severity === 'CRITICAL', snap.findings[0].severity);
    assert(snap.normalizedStatus === 'partially_compliant', snap.normalizedStatus);
});

check('deriveCertStatus warning window', () => {
    const future = new Date();
    future.setDate(future.getDate() + 45);
    const { status } = deriveCertStatus(future, undefined, null, 30);
    assert(status === 'VALID', `45d with 30d window should VALID, got ${status}`);
    const { status: soon } = deriveCertStatus(future, undefined, null, 90);
    assert(soon === 'EXPIRING_SOON', `45d with 90d window should EXPIRING_SOON, got ${soon}`);
});

check('normalizeOverallStatus vocabulary', () => {
    assert(normalizeOverallStatus('Fully Compliant') === 'compliant', 'fully');
    assert(normalizeOverallStatus('Non-Compliant') === 'non_compliant', 'non');
    assert(normalizeOverallStatus('Conditional Pass') === 'partially_compliant', 'partial');
});

check('extractComplianceFindings from audit_findings', () => {
    const f = extractComplianceFindings({
        audit_findings: [{ severity: 'Major', description: 'Missing SOP' }],
    });
    assert(f[0].severity === 'MAJOR', f[0].severity);
});

check('missing docs analysis', () => {
    const snaps = [
        parseComplianceExtraction(
            { certificate_number: 'C1', expiry_date: '2099-01-01' },
            { documentId: 'a', filename: 'a.pdf', classification: 'certificate' }
        ),
    ];
    const m = analyzeMissingComplianceDocs(snaps, [
        'certificate',
        'audit_report',
        'sop',
    ]);
    assert(m.present.includes('certificate'), 'present cert');
    assert(m.missing.includes('audit_report'), 'missing audit');
    assert(m.missing.includes('sop'), 'missing sop');
});

check('detect commands', () => {
    assert(detectComplianceReportCommand('Generate compliance report', COMPLIANCE_AGENT), 'report');
    assert(detectComplianceSectionPdf('Generate certificate report', COMPLIANCE_AGENT) === 'certificates', 'sec');
    assert(detectComplianceSectionPdf('Export findings report', COMPLIANCE_AGENT) === 'findings', 'find');
    assert(detectComplianceLetter('Generate NCR letter for Acme', COMPLIANCE_AGENT) === 'ncr', 'ncr');
    assert(detectComplianceLetter('Draft CAPA for Line 2', COMPLIANCE_AGENT) === 'capa', 'capa');
    assert(
        detectComplianceLetter('Generate certificate of compliance for Acme', COMPLIANCE_AGENT) ===
            'certificate_of_compliance',
        'coc'
    );
    assert(detectComplianceExpiryAsk('What is expiring soon?', COMPLIANCE_AGENT), 'expiry ask');
    assert(detectComplianceMissingDocsAsk('What compliance docs are missing?', COMPLIANCE_AGENT), 'missing');
});

check('visual + dynamic router', () => {
    assert(detectComplianceVisualIntent('Show findings by severity', COMPLIANCE_AGENT) === 'findings', 'viz');
    assert(
        classifyComplianceWorkIntent('Generate compliance report', COMPLIANCE_AGENT)?.tool === 'report',
        'route report'
    );
    assert(
        classifyComplianceWorkIntent('What is expiring soon?', COMPLIANCE_AGENT)?.tool === 'expiry',
        'route expiry'
    );
    assert(
        classifyComplianceWorkIntent('What documents are missing?', COMPLIANCE_AGENT)?.tool ===
            'missing_docs',
        'route missing'
    );
    assert(
        classifyComplianceWorkIntent('Generate NCR letter for Acme Vendor', COMPLIANCE_AGENT)?.tool ===
            'ncr_letter',
        'route ncr'
    );
    assert(
        classifyComplianceWorkIntent('what does this document say about ISO', COMPLIANCE_AGENT)?.tool ===
            'qa',
        'qa'
    );
});

console.log(`\n${passed} checks passed`);
if (process.exitCode) process.exit(1);
