/**
 * Golden extraction fixtures (no DB / no AI).
 * Run: npm run test:finance-golden
 */
import {
    buildFinanceRecordsFromExtraction,
    buildVendorSpendVisual,
    findDuplicateInvoiceWarnings,
    dedupeFinanceRecords,
    pairPurchaseOrdersWithInvoices,
    convertRecordsToBase,
    applyPaymentsToInvoices,
    buildAgingVisual,
    extractInvoiceRefFromText,
    matchDocumentIdsByNameTokens,
    matchDocumentsByExplicitFilename,
    type FinanceRecord,
} from '../services/financeAnalyticsService';
import { canonicalizePartyName, partyRollupKey } from '../services/financePartyNormalize';
import { detectFinanceSpreadsheetTotalAsk } from '../services/financeChatActionService';
import { cleanAgentMarkdown } from '../services/agentResponseFormat';

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

check('canonicalize: M/s Digilog Pvt Ltd = DIGILOG', () => {
    const a = canonicalizePartyName('M/s Digilog Pvt. Ltd.');
    const b = canonicalizePartyName('DIGILOG');
    assert(a === b, `${a} !== ${b}`);
});

check('fixture: standard invoice → one row + total', () => {
    const rows = buildFinanceRecordsFromExtraction(
        { documentId: 'd1', originalFilename: '246910_digilog_invoice.pdf' },
        {
            invoice_number: '246910',
            vendor_name: 'M/s Digilog Electronics Pvt. Ltd.',
            total_amount: 125_000,
            currency: 'PKR',
            customer_name: 'Metro Cash & Carry',
            invoice_date: '2024-06-15',
        }
    );
    assert(rows.length === 1, `rows=${rows.length}`);
    assert(rows[0].total === 125_000, `total=${rows[0].total}`);
    assert(/digilog/i.test(rows[0].vendor), rows[0].vendor);
    assert(rows[0].client.includes('Metro'), rows[0].client);
});

check('fixture: line items sum fallback when no invoice_number', () => {
    const rows = buildFinanceRecordsFromExtraction(
        { documentId: 'd2', originalFilename: 'misc_bill.pdf' },
        {
            vendor_name: 'Acme Supplies',
            line_items: [
                { description: 'Widget', total: 50 },
                { description: 'Gadget', total: 75 },
            ],
            currency: 'USD',
        }
    );
    assert(rows.length >= 1, 'expected rows');
    const sum = rows.reduce((s, r) => s + r.total, 0);
    assert(sum === 125, `sum=${sum}`);
});

check('vendor chart merges alias vendor names', () => {
    const r1 = buildFinanceRecordsFromExtraction(
        { documentId: 'a', originalFilename: 'a.pdf' },
        {
            invoice_number: '1',
            vendor_name: 'DIGILOG',
            total_amount: 100,
            currency: 'PKR',
        }
    );
    const r2 = buildFinanceRecordsFromExtraction(
        { documentId: 'b', originalFilename: 'b.pdf' },
        {
            invoice_number: '2',
            vendor_name: 'M/s Digilog Pvt Ltd',
            total_amount: 200,
            currency: 'PKR',
        }
    );
    const viz = buildVendorSpendVisual([...r1, ...r2]);
    assert(viz.data.length === 1, `bars=${viz.data.length}`);
    assert(Number(viz.data[0].amount) === 300, `amount=${viz.data[0].amount}`);
});

check('duplicate warnings when same vendor amount date', () => {
    const rows = [
        ...buildFinanceRecordsFromExtraction(
            { documentId: 'x1', originalFilename: 'inv_a.pdf' },
            {
                invoice_number: 'A',
                vendor_name: 'Digilog',
                total_amount: 500,
                currency: 'PKR',
                invoice_date: '2024-01-10',
            }
        ),
        ...buildFinanceRecordsFromExtraction(
            { documentId: 'x2', originalFilename: 'inv_b.pdf' },
            {
                invoice_number: 'B',
                vendor_name: 'M/s Digilog Pvt Ltd',
                total_amount: 500,
                currency: 'PKR',
                invoice_date: '2024-01-10',
            }
        ),
    ];
    const w = findDuplicateInvoiceWarnings(rows);
    assert(w.length === 1, `warnings=${w.length}`);
});

check('org vendor alias merges glectronic → Digilog', () => {
    const aliases = { glectronic: 'Digilog' };
    const r1 = buildFinanceRecordsFromExtraction(
        { documentId: 'a', originalFilename: 'a.pdf' },
        {
            invoice_number: '1',
            vendor_name: 'glectronic',
            total_amount: 100,
            currency: 'PKR',
        },
        aliases
    );
    const r2 = buildFinanceRecordsFromExtraction(
        { documentId: 'b', originalFilename: 'b.pdf' },
        {
            invoice_number: '2',
            vendor_name: 'Digilog',
            total_amount: 200,
            currency: 'PKR',
        },
        aliases
    );
    assert(r1[0].vendor === 'Digilog', r1[0].vendor);
    const viz = buildVendorSpendVisual([...r1, ...r2], { vendorAliases: aliases });
    assert(viz.data.length === 1, `bars=${viz.data.length}`);
    assert(Number(viz.data[0].amount) === 300, `amount=${viz.data[0].amount}`);
});

check('partyRollupKey alias', () => {
    assert(
        partyRollupKey('Glectronic', { glectronic: 'Digilog' }) === canonicalizePartyName('Digilog'),
        'rollup'
    );
});

check('dedupe drops second copy with same invoice_number + vendor', () => {
    const rows = [
        ...buildFinanceRecordsFromExtraction(
            { documentId: 'd1', originalFilename: 'inv_a.pdf' },
            { invoice_number: 'INV-100', vendor_name: 'Digilog', total_amount: 500, currency: 'PKR' }
        ),
        ...buildFinanceRecordsFromExtraction(
            { documentId: 'd2', originalFilename: 'inv_a_copy.pdf' },
            { invoice_number: 'INV-100', vendor_name: 'Digilog', total_amount: 500, currency: 'PKR' }
        ),
    ];
    const { records, droppedDocumentIds } = dedupeFinanceRecords(rows);
    assert(records.length === 1, `kept=${records.length}`);
    assert(droppedDocumentIds.length === 1, `dropped=${droppedDocumentIds.length}`);
    assert(droppedDocumentIds[0] === 'd2', droppedDocumentIds[0]);
});

check('dedupe keeps distinct invoice numbers with same amount', () => {
    const rows = [
        ...buildFinanceRecordsFromExtraction(
            { documentId: 'a', originalFilename: 'a.pdf' },
            { invoice_number: 'A1', vendor_name: 'Digilog', total_amount: 500, currency: 'PKR', invoice_date: '2024-01-01' }
        ),
        ...buildFinanceRecordsFromExtraction(
            { documentId: 'b', originalFilename: 'b.pdf' },
            { invoice_number: 'A2', vendor_name: 'Digilog', total_amount: 500, currency: 'PKR', invoice_date: '2024-01-01' }
        ),
    ];
    const { records } = dedupeFinanceRecords(rows);
    assert(records.length === 2, `kept=${records.length}`);
});

check('PO pairing: matched when PO and invoice share po_number', () => {
    const poRecord: FinanceRecord[] = buildFinanceRecordsFromExtraction(
        { documentId: 'po1', originalFilename: 'PO-500.pdf' },
        { po_number: 'PO-500', vendor_name: 'Digilog', total_amount: 1000, currency: 'PKR' }
    ).map((r) => ({ ...r, classification: 'purchase_order' }));
    const invRecord: FinanceRecord[] = buildFinanceRecordsFromExtraction(
        { documentId: 'inv1', originalFilename: 'inv_500.pdf' },
        { invoice_number: 'INV-500', po_number: 'PO-500', vendor_name: 'Digilog', total_amount: 1000, currency: 'PKR' }
    ).map((r) => ({ ...r, classification: 'invoice' }));
    const pairs = pairPurchaseOrdersWithInvoices([...poRecord, ...invRecord]);
    assert(pairs.length === 1, `pairs=${pairs.length}`);
    assert(pairs[0].status === 'matched', `status=${pairs[0].status}`);
    assert(pairs[0].variance === 0, `variance=${pairs[0].variance}`);
});

check('name match: explicit xlsx wins over "all clients" portfolio phrase', () => {
    const docs = [
        { documentId: 'sheet3', originalFilename: 'vendor_client_test_data.xlsx' },
        { documentId: 'inv1', originalFilename: 'invoice_50_rows_pdf_ready.pdf' },
    ];
    const q =
        'in pkr vendor_client_test_data.xlsx only that file total sum of all clients';
    const hit = matchDocumentIdsByNameTokens(docs, q);
    assert(hit.length === 1 && hit[0] === 'sheet3', `hit=${hit.join(',')}`);
    const explicit = matchDocumentsByExplicitFilename(docs, q);
    assert(explicit.length === 1 && explicit[0] === 'sheet3', `explicit=${explicit.join(',')}`);
});

check('spreadsheet: Total Amount (PKR) column stays PKR not USD', () => {
    const rows = buildFinanceRecordsFromExtraction(
        { documentId: 'sheet-pkr', originalFilename: 'vendor_client_test_data.xlsx' },
        {
            rows: [
                { 'Vendor Name': 'Bata Pakistan', 'Total Amount (PKR)': 230051.86, Status: 'Cancelled' },
                { 'Vendor Name': 'Nishat Mills Ltd', 'Total Amount (PKR)': 785833.22, Status: 'Pending' },
            ],
        }
    );
    assert(rows.length === 2, `rows=${rows.length}`);
    assert(rows.every((r) => r.currency === 'PKR'), `currency=${rows.map((r) => r.currency).join(',')}`);
    const visual = buildVendorSpendVisual(rows, { baseCurrency: 'USD' });
    assert(visual.currency === 'PKR', `visual.currency=${visual.currency}`);
    const total = visual.data.reduce((s, row) => s + Number(row.amount || 0), 0);
    assert(Math.abs(total - 1015885.08) < 0.02, `chartTotal=${total}`);
});

check('spreadsheet: PKR amount column used when USD column also exists', () => {
    const rows = buildFinanceRecordsFromExtraction(
        { documentId: 'sheet-both', originalFilename: 'vendor_client_test_data.xlsx' },
        {
            rows: [
                {
                    'Vendor Name': 'CLECTRONICS',
                    'Total Amount (USD)': 150850,
                    'Total Amount (PKR)': 41916300,
                },
                {
                    'Vendor Name': 'Lahore Electronics Co',
                    'Total Amount (USD)': 18543.66,
                    'Total Amount (PKR)': 5155137.8,
                },
            ],
        }
    );
    assert(rows.length === 2, `rows=${rows.length}`);
    assert(rows.every((r) => r.currency === 'PKR'), `currency=${rows.map((r) => r.currency).join(',')}`);
    const clectronics = rows.find((r) => r.vendor === 'CLECTRONICS');
    assert(clectronics != null && Math.abs(clectronics.total - 41916300) < 0.02, `clectronics=${clectronics?.total}`);
    const visual = buildVendorSpendVisual(rows);
    assert(visual.currency === 'PKR', `visual.currency=${visual.currency}`);
    const top = visual.data[0];
    assert(String(top.vendor).includes('CLECTRONICS'), `top=${top.vendor}`);
    assert(Number(top.amount) > 1_000_000, `topAmount=${top.amount} (must be PKR not USD)`);
});

check('convert USD invoice to PKR instead of relabeling', () => {
    const visual = buildVendorSpendVisual(
        [
            {
                documentId: 'd1',
                filename: 'clectronics.pdf',
                vendor: 'CLECTRONICS',
                client: 'Digilog',
                total: 150850,
                currency: 'USD',
                invoiceDate: null,
                dueDate: null,
            },
        ],
        { preferredCurrency: 'PKR', fxRates: { USD: 1, PKR: 278 } }
    );
    assert(visual.currency === 'PKR', `currency=${visual.currency}`);
    const amt = Number(visual.data[0]?.amount || 0);
    assert(Math.abs(amt - 150850 * 278) < 1, `converted=${amt}`);
});

check('spreadsheet: client name + spend amount columns', () => {
    const rows = buildFinanceRecordsFromExtraction(
        { documentId: 'sheet3', originalFilename: 'vendor_client_test_data.xlsx' },
        {
            rows: [
                { 'Client Name': 'Metro Cash & Carry', 'Vendor Name': 'Bata Pakistan', 'Spend Amount': 100000, Currency: 'PKR' },
                { 'Client Name': 'K-Mart', 'Vendor Name': 'Digilog Electronics', 'Spend Amount': 50000, Currency: 'PKR' },
                { 'Client Name': 'Hyperstar', 'Vendor Name': 'Bata Pakistan', 'Spend Amount': 75000, Currency: 'PKR' },
            ],
        }
    );
    assert(rows.length === 3, `rows=${rows.length}`);
    const clients = new Set(rows.map((r) => r.client));
    assert(clients.size === 3, `clients=${clients.size}`);
});

check('spreadsheet: parses markdown table rows into records', () => {
    const rows = buildFinanceRecordsFromExtraction(
        { documentId: 'sheet1', originalFilename: 'vendor_client_data.xlsx' },
        {
            _raw_text: [
                '## Sheet: Sales',
                '| Vendor | Customer | Amount | Date |',
                '| --- | --- | --- | --- |',
                '| Acme | Metro | 100 | 2024-01-05 |',
                '| Bata | K-Mart | 250 | 2024-01-06 |',
                '| Digilog | Metro | 75 | 2024-01-07 |',
            ].join('\n'),
        }
    );
    assert(rows.length === 3, `rows=${rows.length}`);
    const total = rows.reduce((s, r) => s + r.total, 0);
    assert(total === 425, `total=${total}`);
});

check('spreadsheet: uses table_extraction "tables" payload when present', () => {
    const rows = buildFinanceRecordsFromExtraction(
        { documentId: 'sheet2', originalFilename: 'inv.csv' },
        {
            _tables: [
                {
                    headers: ['Vendor', 'Amount', 'Currency'],
                    rows: [
                        ['Acme', '500', 'USD'],
                        ['Bata', '1000', 'USD'],
                    ],
                },
            ],
        }
    );
    assert(rows.length === 2, `rows=${rows.length}`);
    assert(rows.every((r) => r.currency === 'USD'), 'currency');
});

check('client heuristic: parses "Bill To:" from raw_text', () => {
    const rows = buildFinanceRecordsFromExtraction(
        { documentId: 'inv3', originalFilename: 'invoice_x.pdf' },
        {
            invoice_number: '999',
            vendor_name: 'Digilog',
            total_amount: 500,
            currency: 'PKR',
            _raw_text: 'Invoice #999\nVendor: Digilog\nBill To: Metro Cash & Carry\nAmount Due 500',
        }
    );
    assert(rows.length === 1, `rows=${rows.length}`);
    assert(/metro/i.test(rows[0].client), `client=${rows[0].client}`);
});

check('FX conversion: USD → PKR via org rate', () => {
    const rows: FinanceRecord[] = [
        {
            documentId: 'a',
            filename: 'a.pdf',
            vendor: 'Acme',
            client: '',
            total: 100,
            currency: 'USD',
            invoiceDate: null,
            dueDate: null,
        },
        {
            documentId: 'b',
            filename: 'b.pdf',
            vendor: 'Digilog',
            client: '',
            total: 5000,
            currency: 'PKR',
            invoiceDate: null,
            dueDate: null,
        },
    ];
    const out = convertRecordsToBase(rows, { baseCurrency: 'PKR', fxRates: { USD: 280 } });
    assert(out.converted === 1, `converted=${out.converted}`);
    assert(out.records[0].currency === 'PKR', out.records[0].currency);
    assert(Math.round(out.records[0].total) === Math.round(100 / 280), `usd→pkr=${out.records[0].total}`);
});

check('FX conversion: no rate leaves record + reports unconverted', () => {
    const rows: FinanceRecord[] = [
        {
            documentId: 'a',
            filename: 'a.pdf',
            vendor: 'X',
            client: '',
            total: 100,
            currency: 'EUR',
            invoiceDate: null,
            dueDate: null,
        },
    ];
    const out = convertRecordsToBase(rows, { baseCurrency: 'PKR', fxRates: { USD: 280 } });
    assert(out.converted === 0, 'converted');
    assert(out.unconvertedCurrencies.includes('EUR'), 'EUR reported');
    assert(out.records[0].currency === 'EUR', 'kept EUR');
});

check('PO pairing: over-invoiced when invoice > PO', () => {
    const poRecord: FinanceRecord[] = buildFinanceRecordsFromExtraction(
        { documentId: 'po2', originalFilename: 'PO-501.pdf' },
        { po_number: 'PO-501', vendor_name: 'Acme', total_amount: 1000, currency: 'USD' }
    ).map((r) => ({ ...r, classification: 'purchase_order' }));
    const invRecord: FinanceRecord[] = buildFinanceRecordsFromExtraction(
        { documentId: 'inv2', originalFilename: 'inv_501.pdf' },
        { invoice_number: 'INV-501', po_number: 'PO-501', vendor_name: 'Acme', total_amount: 1200, currency: 'USD' }
    ).map((r) => ({ ...r, classification: 'invoice' }));
    const pairs = pairPurchaseOrdersWithInvoices([...poRecord, ...invRecord]);
    assert(pairs[0].status === 'over_invoiced', `status=${pairs[0].status}`);
    assert(pairs[0].variance === 200, `variance=${pairs[0].variance}`);
});

check('payment receipt: parses as payment, not invoice spend', () => {
    const rows = buildFinanceRecordsFromExtraction(
        { documentId: 'pay1', originalFilename: 'receipt.pdf', classification: 'payment_receipt' },
        {
            amount_paid: 450_000,
            currency: 'PKR',
            payer_name: 'Nexus Global',
            payee_name: 'Visibility Telecom',
            payment_for: 'Payment against Invoice # INV-2024-102',
            receipt_number: 'RCT-1',
        }
    );
    assert(rows.length === 1, `rows=${rows.length}`);
    assert(rows[0].recordKind === 'payment', `kind=${rows[0].recordKind}`);
    assert(rows[0].amountPaid === 450_000, `paid=${rows[0].amountPaid}`);
    assert(/INV-2024-102/i.test(rows[0].paysInvoiceNumber || ''), `pays=${rows[0].paysInvoiceNumber}`);
});

check('payment settlement: outstanding = invoice − matched payment', () => {
    const inv = buildFinanceRecordsFromExtraction(
        { documentId: 'inv-pay', originalFilename: 'inv.pdf', classification: 'invoice' },
        {
            invoice_number: 'INV-2024-102',
            vendor_name: 'Visibility Telecom',
            total_amount: 500_000,
            currency: 'PKR',
            customer_name: 'Nexus Global',
        }
    );
    const pay = buildFinanceRecordsFromExtraction(
        { documentId: 'pay-match', originalFilename: 'rct.pdf', classification: 'payment_receipt' },
        {
            amount_paid: 200_000,
            currency: 'PKR',
            payee_name: 'Visibility Telecom',
            payer_name: 'Nexus Global',
            payment_for: 'Payment against Invoice # INV-2024-102',
        }
    );
    const settled = applyPaymentsToInvoices([...inv, ...pay]);
    assert(settled.appliedPayments === 1, `applied=${settled.appliedPayments}`);
    assert(settled.records.length === 1, `invRows=${settled.records.length}`);
    assert(settled.records[0].outstanding === 300_000, `out=${settled.records[0].outstanding}`);
    assert(settled.records[0].paidApplied === 200_000, `paidApplied=${settled.records[0].paidApplied}`);
    const aging = buildAgingVisual(settled.records);
    const sum = aging.data.reduce((s, r) => s + Number(r.amount || 0), 0);
    assert(sum === 300_000, `agingSum=${sum}`);
});

check('payment settlement: unmatched payment leaves gross outstanding', () => {
    const inv = buildFinanceRecordsFromExtraction(
        { documentId: 'inv-u', originalFilename: 'inv.pdf', classification: 'invoice' },
        { invoice_number: 'INV-9', vendor_name: 'Acme', total_amount: 1000, currency: 'USD' }
    );
    const pay = buildFinanceRecordsFromExtraction(
        { documentId: 'pay-u', originalFilename: 'rct.pdf', classification: 'payment_receipt' },
        {
            amount_paid: 400,
            currency: 'USD',
            payee_name: 'Acme',
            payment_for: 'Misc deposit',
        }
    );
    const settled = applyPaymentsToInvoices([...inv, ...pay]);
    assert(settled.appliedPayments === 0, 'no apply');
    assert(settled.unmatchedPayments === 1, `unmatched=${settled.unmatchedPayments}`);
    assert(settled.records[0].outstanding === 1000, `out=${settled.records[0].outstanding}`);
});

check('extractInvoiceRefFromText: Invoice # INV-2024-102', () => {
    assert(
        /INV-2024-102/i.test(extractInvoiceRefFromText('Payment against Invoice # INV-2024-102')),
        'ref'
    );
});

check('gran total typo uses computed totals path', () => {
    assert(detectFinanceSpreadsheetTotalAsk('give me only gran total', 'finance_agent'), 'gran total');
    assert(detectFinanceSpreadsheetTotalAsk('grand total', 'finance_agent'), 'grand total');
    assert(detectFinanceSpreadsheetTotalAsk('now that file total amount with clients', 'finance_agent'), 'total amount');
});

check('cleanAgentMarkdown keeps headings and tables on separate lines', () => {
    const md = cleanAgentMarkdown(
        '**Grand total:** PKR 32,482,872.59\n\n### By status\n| Status | Total |\n| --- | --- |\n| Paid | PKR 1 |\n'
    );
    assert(md.includes('\n### By status\n'), `headings collapsed: ${JSON.stringify(md)}`);
    assert(!/\*\*Grand total:[^*]+\*\* ### By status/.test(md), 'heading must not sit on the grand-total line');
});

console.log(`\n${passed} checks passed`);
if (process.exitCode) process.exit(1);
