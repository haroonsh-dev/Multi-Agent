/**
 * Unit checks for chart document targeting (no DB).
 * Run: npm run test:document-name-match
 */
import {
    expandNameToken,
    extractDocumentNameTokens,
    matchDocumentIdsByNameTokens,
    enrichSearchTextForDoc,
    questionRefersToSpecificDocument,
} from '../services/financeAnalyticsService';

function assert(cond: boolean, msg: string) {
    if (!cond) throw new Error(msg);
}

const docs = [
    {
        documentId: 'bata',
        originalFilename: 'bata_pakistan_invoice.pdf',
        searchText: enrichSearchTextForDoc('bata_pakistan_invoice.pdf', 'Bata Pakistan'),
    },
    {
        documentId: 'digilog',
        originalFilename: '246910_digilog_invoice.pdf',
        searchText: enrichSearchTextForDoc('246910_digilog_invoice.pdf', 'Digilog Electronics'),
    },
    {
        documentId: 'other',
        originalFilename: 'random_receipt.pdf',
        searchText: '',
    },
];

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

check('glectronic expands to digilog', () => {
    const expanded = expandNameToken('glectronic');
    assert(expanded.includes('digilog'), `expected digilog in ${expanded.join(',')}`);
});

check('glectronics expands to digilog', () => {
    assert(expandNameToken('glectronics').includes('digilog'), 'glectronics → digilog');
});

check('typo glectronix still maps via edit distance / family', () => {
    const tokens = extractDocumentNameTokens('chart of glectronix');
    assert(tokens.includes('digilog') || tokens.some((t) => t.startsWith('glectroni')), `tokens=${tokens}`);
});

check('question "short me chart of glectronic full" tokens include digilog', () => {
    const tokens = extractDocumentNameTokens('short me chart of glectronic full');
    assert(tokens.includes('digilog'), `expected digilog, got ${tokens.join(',')}`);
    assert(!tokens.includes('short'), 'short should be stop word');
    assert(!tokens.includes('full'), 'full should be stop word');
});

check('glectronic matches Digilog file only', () => {
    const hit = matchDocumentIdsByNameTokens(docs, 'short me chart of glectronic full');
    assert(hit.length === 1, `expected 1 hit, got ${hit.length}`);
    assert(hit[0] === 'digilog', `expected digilog, got ${hit[0]}`);
});

check('digilog name matches Digilog file only', () => {
    const hit = matchDocumentIdsByNameTokens(docs, 'give me chart of digilog');
    assert(hit[0] === 'digilog', `got ${hit[0]}`);
});

check('bata matches Bata only', () => {
    const hit = matchDocumentIdsByNameTokens(docs, 'chart of bata');
    assert(hit[0] === 'bata', `got ${hit[0]}`);
});

check('invoice number 246910 matches Digilog', () => {
    const hit = matchDocumentIdsByNameTokens(docs, 'chart for 246910');
    assert(hit[0] === 'digilog', `got ${hit[0]}`);
});

check('deictic "chart of that" detected', () => {
    assert(questionRefersToSpecificDocument('give me chart of that'), 'should detect');
});

check('casual "give me that data" is portfolio not single-file', () => {
    assert(!questionRefersToSpecificDocument('give me that data'), 'not deictic file');
});

check('portfolio question does not falsely name-match all', () => {
    const hit = matchDocumentIdsByNameTokens(docs, 'show me vendor spend chart');
    assert(hit.length === 0, `expected no name hits, got ${hit.join(',')}`);
});

check('vendor searchText alone can match Digilog without digilog in filename token path', () => {
    const weird = [
        {
            documentId: 'x',
            originalFilename: 'scan_001.pdf',
            searchText: enrichSearchTextForDoc('scan_001.pdf', 'GLECTRONICS'),
        },
        docs[0],
    ];
    const hit = matchDocumentIdsByNameTokens(weird, 'chart of glectronic');
    assert(hit[0] === 'x', `expected scan/glectronic doc, got ${hit[0]}`);
});

console.log(`\n${passed} checks passed`);
if (process.exitCode) process.exit(1);
