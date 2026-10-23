/**
 * Unit checks for Agent API helpers (token generate/mask, agent id normalize).
 * Run: npm run test:agent-api
 */
import assert from 'assert';
import crypto from 'crypto';

function generateAgentApiKey(): string {
    return `vdag_${crypto.randomBytes(24).toString('hex')}`;
}

function maskToken(token: string): string {
    const t = String(token || '');
    if (t.length < 12) return '••••';
    return `${t.slice(0, 6)}****${t.slice(-4)}`;
}

function normalizeAgentId(raw: string, allowed: string[]): string {
    let agentId = String(raw || '')
        .trim()
        .toLowerCase()
        .replace(/-/g, '_');
    if (agentId && !allowed.includes(agentId) && !agentId.endsWith('_agent')) {
        const withSuffix = `${agentId}_agent`;
        if (allowed.includes(withSuffix)) agentId = withSuffix;
    }
    return agentId;
}

const key = generateAgentApiKey();
assert.ok(key.startsWith('vdag_'), 'key prefix');
assert.ok(key.length > 20, 'key length');
const masked = maskToken(key);
assert.ok(masked.includes('****'), 'masked');
assert.ok(!masked.includes(key.slice(10, 20)), 'secret not in mask');

const allowed = ['compliance_agent', 'hr_agent', 'finance_agent'];
assert.strictEqual(normalizeAgentId('compliance', allowed), 'compliance_agent');
assert.strictEqual(normalizeAgentId('hr_agent', allowed), 'hr_agent');
assert.strictEqual(normalizeAgentId('HR-Agent', allowed), 'hr_agent');
assert.strictEqual(normalizeAgentId('legal', allowed), 'legal'); // not on plan → unchanged for entitlement reject

console.log('OK agent API token + agentId normalize checks passed');
