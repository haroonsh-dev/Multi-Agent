/**
 * HR analytics unit fixtures (no DB).
 * Run: npx tsx --tsconfig tsconfig.json src/scripts/testHrGolden.ts
 */
import {
    parseHrDocIntoBundle,
    buildCertExpiryVisual,
    buildOnboardingVisual,
    detectHrVisualIntent,
} from '../services/hrAnalyticsService';
import {
    detectHrReportCommand,
    detectHrShortlistExport,
    detectHrExtraLetter,
    detectHrDirectoryCommand,
} from '../services/hrChatReportService';
import { classifyHrWorkIntent } from '../services/hrIntentRouter';
import { HR_AGENT } from '../services/offerLetterGenerationService';
import { parseCandidateNameFromMessage } from '../services/hrChatActionService';

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

check('parse employee_record → directory row', () => {
    const b = parseHrDocIntoBundle(
        { documentId: 'e1', originalFilename: 'emp.pdf', classification: 'employee_record' },
        {
            employee_name: 'Sara Ali',
            employee_id: 'EMP-1',
            department: 'Engineering',
            designation: 'Engineer',
            employment_status: 'Permanent',
        }
    );
    assert(b.employees?.length === 1, 'employees');
    assert(b.employees![0].employeeName === 'Sara Ali', 'name');
});

check('parse certificates array → cert rows', () => {
    const b = parseHrDocIntoBundle(
        { documentId: 'c1', originalFilename: 'certs.pdf', classification: 'training_certificate' },
        {
            employee_name: 'Omar',
            certificates: [
                {
                    certificate_name: 'First Aid',
                    expiry_date: '2020-01-01',
                    status: 'EXPIRED',
                    days_until_expiry: -100,
                },
            ],
        }
    );
    assert(b.certs?.length === 1, 'certs');
    assert(b.certs![0].status === 'EXPIRED', 'status');
    const viz = buildCertExpiryVisual(b.certs!);
    assert(viz.data.some((r) => Number(r.count) > 0), 'chart has counts');
});

check('parse onboarding completeness', () => {
    const b = parseHrDocIntoBundle(
        { documentId: 'o1', originalFilename: 'pack.pdf', classification: 'hr_document' },
        {
            employee_name: 'Ali',
            completeness_percentage: 50,
            onboarding_status: 'INCOMPLETE',
            missing_documents: ['NDA', 'tax_form'],
        }
    );
    assert(b.onboarding?.[0].completeness === 50, 'pct');
    const viz = buildOnboardingVisual(b.onboarding!);
    assert(viz.data[0].pct === 50, 'viz');
});

check('parse leave + payroll + attendance', () => {
    const leave = parseHrDocIntoBundle(
        { documentId: 'l1', originalFilename: 'leave.pdf', classification: 'leave_application' },
        { employee_name: 'A', leave_type: 'Annual', total_days: 3, department: 'Ops' }
    );
    assert(leave.leave?.[0].totalDays === 3, 'leave');
    const pay = parseHrDocIntoBundle(
        { documentId: 'p1', originalFilename: 'pay.pdf', classification: 'payroll' },
        { employee_name: 'A', net_salary: 1000, payslip_period: '2024-03', currency: 'USD' }
    );
    assert(pay.payroll?.[0].netSalary === 1000, 'pay');
    const att = parseHrDocIntoBundle(
        { documentId: 'a1', originalFilename: 'att.pdf', classification: 'attendance' },
        { employee_name: 'A', days_present: 18, total_working_days: 20 }
    );
    assert(att.attendance?.[0].presentPct === 90, `pct=${att.attendance?.[0].presentPct}`);
});

check('detect intents + commands', () => {
    assert(detectHrVisualIntent('Chart certificate expiry', HR_AGENT) === 'certs', 'certs');
    assert(detectHrVisualIntent('Show onboarding completeness', HR_AGENT) === 'onboarding', 'onb');
    assert(detectHrVisualIntent('Chart leave summary', HR_AGENT) === 'leave', 'leave');
    assert(detectHrVisualIntent('Chart payroll by period', HR_AGENT) === 'payroll', 'pay');
    assert(detectHrVisualIntent('Chart attendance %', HR_AGENT) === 'attendance', 'att');
    assert(detectHrReportCommand('Generate HR report', HR_AGENT), 'report');
    assert(detectHrShortlistExport('Export shortlist top 10', HR_AGENT), 'shortlist');
    assert(detectHrExtraLetter('Generate promotion letter for Ali', HR_AGENT) === 'promotion', 'promo');
    assert(detectHrExtraLetter('Generate warning letter for Ali', HR_AGENT) === 'warning', 'warn');
    assert(detectHrExtraLetter('Generate relieving letter for Ali', HR_AGENT) === 'relieving', 'rel');
    assert(detectHrExtraLetter('Generate joining letter for Sharjeel', HR_AGENT) === 'joining', 'join');
    assert(detectHrExtraLetter('joining letter of Sharjeel I want to hire', HR_AGENT) === 'joining', 'join2');
    assert(detectHrExtraLetter('Generate internship letter for Sara', HR_AGENT) === 'internship', 'intern');
    assert(
        detectHrExtraLetter('Generate training certificate for Ali', HR_AGENT) === 'training_certificate',
        'train cert'
    );
    assert(detectHrDirectoryCommand('Show employee directory', HR_AGENT), 'dir');
});

check('dynamic router: plain-language HR work', () => {
    assert(classifyHrWorkIntent("Any certificates expiring soon?", HR_AGENT)?.tool === 'certs', 'soft certs');
    assert(classifyHrWorkIntent("Who's on leave?", HR_AGENT)?.tool === 'leave', 'soft leave');
    assert(classifyHrWorkIntent('Show performance reviews', HR_AGENT)?.tool === 'performance', 'perf');
    assert(classifyHrWorkIntent('How do transcripts look?', HR_AGENT)?.tool === 'transcript', 'tr');
    assert(classifyHrWorkIntent('Show onboarding gaps', HR_AGENT)?.tool === 'onboarding', 'onb soft');
    assert(classifyHrWorkIntent('what does this document say about leave', HR_AGENT)?.tool === 'qa', 'qa');
    assert(
        classifyHrWorkIntent(
            'can you create a joining letter of sharjeel i want to hire so generate me joining letter',
            HR_AGENT
        )?.tool === 'joining_letter',
        'join route'
    );
    assert(
        classifyHrWorkIntent('Generate internship letter for Sara Ali', HR_AGENT)?.tool ===
            'internship_letter',
        'intern route'
    );
    assert(
        classifyHrWorkIntent('Generate training certificate for Ali', HR_AGENT)?.tool ===
            'training_certificate',
        'train route'
    );
});

check('parse performance + transcript', () => {
    const perf = parseHrDocIntoBundle(
        { documentId: 'pr1', originalFilename: 'review.pdf', classification: 'performance_review' },
        {
            employee_name: 'Ahmed',
            overall_rating: 'Exceeds',
            rating_score: 4.5,
            promotion_recommended: true,
            review_period: '2024',
        }
    );
    assert(perf.performance?.[0].ratingScore === 4.5, 'score');
    const tr = parseHrDocIntoBundle(
        { documentId: 't1', originalFilename: 'marks.pdf', classification: 'transcript' },
        { student_name: 'Sara', institution_name: 'NUST', degree_program: 'CS', gpa_cgpa: 3.7 }
    );
    assert(tr.transcripts?.[0].gpa === 3.7, 'gpa');
});

check('parseCandidateName accepts of/for', () => {
    assert(
        parseCandidateNameFromMessage('generate offer letter of Haroon Shahid') === 'Haroon Shahid',
        'of'
    );
    assert(
        parseCandidateNameFromMessage(
            'Generate offer letter for Ahmed Khan. Company Visibility Bots, title AI Engineer'
        ) === 'Ahmed Khan',
        'for'
    );
});

console.log(`\n${passed} checks passed`);
if (process.exitCode) process.exit(1);
