/**
 * Document accuracy eval harness — measures real classification + extraction
 * accuracy against a labeled ground-truth set, instead of trusting the
 * model's own self-reported confidence.
 *
 * This is NOT part of the CI-blocking test suite (unlike test:*): every other
 * script under src/scripts runs with no DB and no live server, because CI has
 * neither Mongo nor ai-backend's model weights available. This one needs a
 * real running stack (api-gateway + ai-backend + Mongo, with a working AI
 * provider key) — run it manually against local dev or a deployed environment.
 *
 * Run:
 *   API_BASE_URL=http://localhost:5100/api EVAL_EMAIL=admin@x.com EVAL_PASSWORD=... \
 *     npm run eval:accuracy
 *
 * What it does, per fixture in eval-fixtures/manifest.json:
 *   1. Uploads the fixture file through the real /docs/documents endpoint
 *      (exercises the full pipeline: OCR/text extraction, classification,
 *      field extraction — not a mocked shortcut).
 *   2. Polls until the document reaches a terminal status.
 *   3. Compares the returned document_type/agent against expected.
 *   4. Checks each expected field's value appears somewhere in the extracted
 *      data (a substring/fuzzy check, not exact key-path matching — we don't
 *      assert on ai-backend's internal field-naming schema here, only on
 *      whether the right values came out).
 *   5. Deletes the uploaded eval document afterward (keeps the library clean).
 *
 * Extending this: add a fixture file + a manifest entry. Real (anonymized)
 * customer documents belong here far more than synthetic ones — the fixtures
 * shipped with this script are a starter set to prove the harness works, not
 * a claim about real-world accuracy. Track the printed accuracy % over time
 * as the actual measurement this product has been missing.
 */
import fs from 'fs';
import path from 'path';

const API_BASE_URL = process.env.API_BASE_URL || 'http://localhost:5100/api';
const EVAL_EMAIL = process.env.EVAL_EMAIL;
const EVAL_PASSWORD = process.env.EVAL_PASSWORD;
const FIXTURES_DIR = path.join(__dirname, '..', '..', 'eval-fixtures');
const POLL_INTERVAL_MS = 4000;
const POLL_MAX_TRIES = 60; // 4 minutes — matches the frontend's fast-poll budget

type ManifestEntry = {
    file: string;
    expectedDocumentType: string;
    expectedAgent: string;
    expectedFields?: Record<string, string>;
};

type FixtureResult = {
    file: string;
    typeMatch: boolean;
    agentMatch: boolean;
    actualType: string;
    actualAgent: string;
    fieldResults: Array<{ field: string; expected: string; found: boolean }>;
    error?: string;
};

async function login(): Promise<string> {
    if (!EVAL_EMAIL || !EVAL_PASSWORD) {
        throw new Error('Set EVAL_EMAIL and EVAL_PASSWORD (any user with document upload + view permission).');
    }
    const res = await fetch(`${API_BASE_URL}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ identifier: EVAL_EMAIL, password: EVAL_PASSWORD }),
    });
    const body = await res.json();
    if (!res.ok || !body?.data?.accessToken) {
        throw new Error(`Login failed: ${body?.message || res.status}`);
    }
    return body.data.accessToken as string;
}

async function uploadFixture(token: string, filePath: string): Promise<string> {
    const buf = fs.readFileSync(filePath);
    const form = new FormData();
    form.append('file', new Blob([buf], { type: 'text/plain' }), path.basename(filePath));
    const res = await fetch(`${API_BASE_URL}/docs/documents`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: form,
    });
    const body = await res.json();
    const documentId = body?.data?.document?.documentId;
    if (!res.ok || !documentId) {
        throw new Error(`Upload failed: ${body?.message || res.status}`);
    }
    return documentId;
}

async function pollUntilReady(token: string, documentId: string): Promise<'ready' | 'failed' | 'timeout'> {
    for (let i = 0; i < POLL_MAX_TRIES; i++) {
        const res = await fetch(`${API_BASE_URL}/docs/documents/${documentId}/processing`, {
            headers: { Authorization: `Bearer ${token}` },
        });
        const body = await res.json();
        const status = body?.data?.status;
        if (status === 'ready') return 'ready';
        if (status === 'failed') return 'failed';
        await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    }
    return 'timeout';
}

async function getIntelligence(token: string, documentId: string): Promise<Record<string, any>> {
    const res = await fetch(`${API_BASE_URL}/docs/documents/${documentId}/intelligence`, {
        headers: { Authorization: `Bearer ${token}` },
    });
    const body = await res.json();
    return body?.data || {};
}

async function deleteDocument(token: string, documentId: string): Promise<void> {
    await fetch(`${API_BASE_URL}/docs/documents/${documentId}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
    }).catch(() => {});
}

function fieldPresent(extractedData: unknown, expectedValue: string): boolean {
    const haystack = JSON.stringify(extractedData || {}).toLowerCase();
    return haystack.includes(expectedValue.toLowerCase());
}

async function runFixture(token: string, entry: ManifestEntry): Promise<FixtureResult> {
    const filePath = path.join(FIXTURES_DIR, entry.file);
    let documentId: string | null = null;
    try {
        documentId = await uploadFixture(token, filePath);
        const outcome = await pollUntilReady(token, documentId);
        if (outcome !== 'ready') {
            return {
                file: entry.file,
                typeMatch: false,
                agentMatch: false,
                actualType: '',
                actualAgent: '',
                fieldResults: [],
                error: `Processing ${outcome}`,
            };
        }

        const { document, aiDocument } = await getIntelligence(token, documentId);
        const actualType = String(aiDocument?.document_type || document?.classification || '').toLowerCase();
        const actualAgent = String(document?.metadata?.phase3Agent || '').toLowerCase();
        const extracted = aiDocument?.extracted_data;

        const fieldResults = Object.entries(entry.expectedFields || {}).map(([field, expected]) => ({
            field,
            expected,
            found: fieldPresent(extracted, expected),
        }));

        return {
            file: entry.file,
            typeMatch: actualType === entry.expectedDocumentType.toLowerCase(),
            agentMatch: actualAgent === entry.expectedAgent.toLowerCase(),
            actualType,
            actualAgent,
            fieldResults,
        };
    } finally {
        if (documentId) await deleteDocument(token, documentId);
    }
}

async function main() {
    const manifest: ManifestEntry[] = JSON.parse(fs.readFileSync(path.join(FIXTURES_DIR, 'manifest.json'), 'utf8'));
    console.log(`Eval: ${manifest.length} fixture(s) against ${API_BASE_URL}\n`);

    const token = await login();
    const results: FixtureResult[] = [];
    for (const entry of manifest) {
        process.stdout.write(`  ${entry.file} ... `);
        const result = await runFixture(token, entry);
        results.push(result);
        console.log(result.error ? `ERROR: ${result.error}` : result.typeMatch && result.agentMatch ? 'ok' : 'MISMATCH');
    }

    console.log('\n─── Results ───────────────────────────────────────────────');
    let typeCorrect = 0;
    let agentCorrect = 0;
    let fieldsCorrect = 0;
    let fieldsTotal = 0;
    for (const r of results) {
        if (r.error) {
            console.log(`✗ ${r.file}: ${r.error}`);
            continue;
        }
        if (r.typeMatch) typeCorrect += 1;
        else console.log(`✗ ${r.file}: document_type expected match, got "${r.actualType}"`);
        if (r.agentMatch) agentCorrect += 1;
        else console.log(`✗ ${r.file}: agent expected match, got "${r.actualAgent}"`);
        for (const f of r.fieldResults) {
            fieldsTotal += 1;
            if (f.found) fieldsCorrect += 1;
            else console.log(`✗ ${r.file}: field "${f.field}" (expected to contain "${f.expected}") not found in extracted data`);
        }
    }

    const n = results.length;
    console.log('\n─── Accuracy ──────────────────────────────────────────────');
    console.log(`Classification: ${typeCorrect}/${n} (${n ? Math.round((typeCorrect / n) * 100) : 0}%)`);
    console.log(`Agent routing:  ${agentCorrect}/${n} (${n ? Math.round((agentCorrect / n) * 100) : 0}%)`);
    console.log(`Field extraction: ${fieldsCorrect}/${fieldsTotal} (${fieldsTotal ? Math.round((fieldsCorrect / fieldsTotal) * 100) : 0}%)`);

    if (typeCorrect < n || agentCorrect < n || fieldsCorrect < fieldsTotal) {
        process.exitCode = 1;
    }
}

main().catch((err) => {
    console.error(`Eval run failed: ${err?.message || err}`);
    process.exitCode = 1;
});
