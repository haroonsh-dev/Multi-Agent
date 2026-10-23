/**
 * Unit checks for integration ingest URL safety (SSRF guard).
 * Run: npm run test:integration-ingest-url
 */
import { assertIngestUrlSafe, resolveIngestPhase3Agent } from '../services/integrationIngestService';

async function expectBlock(url: string, label: string) {
    try {
        await assertIngestUrlSafe(url);
        console.error(`FAIL ${label}: expected block, got allow for ${url}`);
        process.exitCode = 1;
    } catch (e: any) {
        console.log(`OK block ${label}: ${e.message}`);
    }
}

function resolvePhase3(agent: string | undefined, connAgent: string, allowed: string[]) {
    const mockConn = { config: { phase3Agent: connAgent } } as any;
    return resolveIngestPhase3Agent(mockConn, agent, allowed);
}

async function expectAllow(url: string, label: string) {
    try {
        const u = await assertIngestUrlSafe(url);
        console.log(`OK allow ${label}: ${u.hostname}`);
    } catch (e: any) {
        console.error(`FAIL ${label}: expected allow, got ${e.message}`);
        process.exitCode = 1;
    }
}

async function main() {
    await expectBlock('http://127.0.0.1/file.pdf', 'localhost');
    await expectBlock('http://192.168.1.10/file.pdf', 'private literal ip');
    await expectBlock('http://169.254.169.254/latest/meta-data/', 'metadata');
    await expectBlock('ftp://example.com/a.pdf', 'ftp');
    await expectBlock('not-a-url', 'invalid');
    await expectAllow('https://example.com/invoices/inv.pdf', 'public https');

    if (resolvePhase3('finance_agent', 'hr_agent', ['finance_agent', 'hr_agent']) !== 'finance_agent') {
        console.error('FAIL phase3 override');
        process.exitCode = 1;
    } else {
        console.log('OK phase3 override respects allowed list');
    }
    if (resolvePhase3('legal_agent', 'finance_agent', ['finance_agent']) !== undefined) {
        console.error('FAIL phase3 blocked agent should be undefined');
        process.exitCode = 1;
    } else {
        console.log('OK phase3 blocks agent not on plan');
    }
    if (resolvePhase3(undefined, 'finance_agent', ['finance_agent']) !== 'finance_agent') {
        console.error('FAIL phase3 connection default');
        process.exitCode = 1;
    } else {
        console.log('OK phase3 connection default');
    }

    console.log(process.exitCode ? 'Some checks failed' : 'All integration ingest URL checks passed');
}

main();
