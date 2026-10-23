/**
 * Golden-ish intent phrase checks (no DB).
 * Run: npm run test:analytics-intent
 */
import { detectFinanceVisualIntent, wantsVisualization } from '../services/financeChatVisualService';
import {
    questionRefersToSpecificDocument,
    extractDocumentNameTokens,
} from '../services/financeAnalyticsService';
import { parseFinanceIntent, wantsMonthlyTrendQuestion, wantsPortfolioFinanceScope } from '../services/financeIntent';

function assert(cond: boolean, msg: string) {
    if (!cond) throw new Error(msg);
}

let passed = 0;
function check(name: string, fn: () => void) {
    try {
        fn();
        passed += 1;
        console.log(`✓ ${name}`);
    } catch (e: any) {
        console.error(`✗ ${name}: ${e?.message || e}`);
        process.exitCode = 1;
    }
}

check('wantsVisualization: chart of digilog', () => {
    assert(wantsVisualization('chart of digilog'), 'expected true');
});

check('wantsVisualization: short me chart of glectronic full', () => {
    assert(wantsVisualization('short me chart of glectronic full'), 'expected true');
});

check('vendor totals intent', () => {
    const i = detectFinanceVisualIntent('vendor totals for scoped invoices', 'finance_agent', {
        hasScopedFinanceDocuments: true,
        scopedFinanceDocCount: 3,
    });
    assert(i === 'vendor_spend' || i === 'overview', `got ${i}`);
});

check('aging intent', () => {
    const i = detectFinanceVisualIntent('show aging', 'finance_agent', {
        hasScopedFinanceDocuments: true,
        scopedFinanceDocCount: 2,
    });
    assert(i === 'aging' || i === 'overview', `got ${i}`);
});

check('line items intent', () => {
    const i = detectFinanceVisualIntent('show items list and chart', 'finance_agent', {
        hasScopedFinanceDocuments: true,
        scopedFinanceDocCount: 1,
    });
    assert(i === 'line_items', `got ${i}`);
});

check('deictic + name tokens', () => {
    assert(questionRefersToSpecificDocument('give me chart of that'), 'deictic');
    assert(extractDocumentNameTokens('chart of digilog').includes('digilog'), 'digilog token');
});

check('parseFinanceIntent: trend by month', () => {
    const i = parseFinanceIntent('Chart invoice trend by month');
    assert(i === 'monthly_trend', `got ${i}`);
});

check('parseFinanceIntent: vendor before client when no trend', () => {
    const i = parseFinanceIntent('chart vendor spend');
    assert(i === 'vendor_spend', `got ${i}`);
});

check('wantsMonthlyTrendQuestion: by month', () => {
    assert(wantsMonthlyTrendQuestion('invoice trend by month'), 'by month');
});

check('detectFinanceVisualIntent: trend by month on finance agent', () => {
    const i = detectFinanceVisualIntent('Chart invoice trend by month', 'finance_agent', {
        hasScopedFinanceDocuments: true,
        scopedFinanceDocCount: 3,
    });
    assert(i === 'monthly_trend', `got ${i}`);
});

check('wantsPortfolioFinanceScope: all vendor client spend', () => {
    assert(
        wantsPortfolioFinanceScope('give me all vendor clients data what spend amount'),
        'portfolio phrase'
    );
});

check('parseFinanceIntent: vendor + client -> overview', () => {
    const i = parseFinanceIntent('give me all vendor and client spend amounts');
    assert(i === 'overview', `got ${i}`);
});

check('wantsPortfolioFinanceScope: single vendor name not portfolio', () => {
    assert(!wantsPortfolioFinanceScope('chart of bata pakistan'), 'named file');
});

check('wantsPortfolioFinanceScope: give me that data', () => {
    assert(wantsPortfolioFinanceScope('give me that data'), 'casual portfolio');
});

check('wantsPortfolioFinanceScope: all clietns lists typo', () => {
    assert(wantsPortfolioFinanceScope('all clietns lists'), 'typo list all');
});

check('wantsPortfolioFinanceScope: chart invoice trend by month', () => {
    assert(wantsPortfolioFinanceScope('Chart invoice trend by month'), 'trend portfolio');
});

console.log(`\n${passed} checks passed`);
if (process.exitCode) process.exit(1);
