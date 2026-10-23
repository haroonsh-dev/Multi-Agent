/**
 * Catalog drift check — binds the FRONTEND's documentAgents.ts to the ai-backend
 * agent registry.
 *
 * The ai-backend registry (agent_registry.AGENT_CATALOG + DOCUMENT_TO_PHASE3_AGENT)
 * is the single source of truth for agent ids and the doc_type -> agent map. This
 * script re-reads that canonical catalog from the Python source and compares it
 * against the FRONTEND copy (documentAgents.ts) and the GATEWAY bundled fallback
 * (PLAN_AGENT_IDS), so a new agent or doc_type added upstream is noticed instead
 * of silently missing from the UI / mislabeled / dropped from the fallback list.
 *
 *   npm run test:catalog-drift
 *
 * Exit 0 = in sync. Exit 1 = drift found:
 *   - MISSING   : registry agent / doc_type absent from the frontend copy
 *   - MISMATCH  : frontend maps a doc_type to a different agent than the registry
 *   - STALE     : gateway PLAN_AGENT_IDS lists an agent the registry doesn't know
 * Frontend-only extras (letter/report types the UI renders but the classifier
 * doesn't emit) and gateway fallback gaps (runtime still serves the agent when the
 * registry is up) are reported as WARN and do not fail the check.
 */
import { execFileSync } from 'child_process';
import path from 'path';
import { pathToFileURL } from 'url';
import { PLAN_AGENT_IDS } from '../models/AgentStoragePricing';

const repoRoot = path.resolve(__dirname, '../../../');
const aiBackendDir = path.join(repoRoot, 'ai-backend');
const frontendModulePath = path.join(repoRoot, 'frontend/src/lib/documentAgents.ts');

type CanonicalCatalog = {
    agent_ids: string[];
    agent_labels: Record<string, string>;
    doc_type_to_agent: Record<string, string>;
    tool_count: number;
};

type FrontendCatalog = {
    docTypeToAgent: Record<string, string>;
    agentOptions: Array<{ value: string; label: string }>;
};

function canonicalCatalogFromPython(): CanonicalCatalog {
    const snippet = [
        'import json',
        'from app.services.agent_registry import catalog_consistency_report',
        'print(json.dumps(catalog_consistency_report()))',
    ].join('\n');
    const out = execFileSync('python3', ['-c', snippet], { cwd: aiBackendDir, encoding: 'utf-8' });
    return JSON.parse(out.trim()) as CanonicalCatalog;
}

async function frontendCatalog(): Promise<FrontendCatalog> {
    const mod = (await import(pathToFileURL(frontendModulePath).href)) as {
        DOC_TYPE_TO_AGENT: Record<string, string>;
        AGENT_OPTIONS: Array<{ value: string; label: string }>;
    };
    return {
        docTypeToAgent: mod.DOC_TYPE_TO_AGENT,
        agentOptions: mod.AGENT_OPTIONS.filter((o) => o.value),
    };
}

async function main() {
    const problems: string[] = [];
    const warnings: string[] = [];

    let catalog: CanonicalCatalog;
    try {
        catalog = canonicalCatalogFromPython();
    } catch (e: any) {
        console.error(`✗ Could not read the ai-backend registry: ${e?.message || e}`);
        console.error(`  (is python3 + the ai-backend app importable from ${aiBackendDir}?)`);
        process.exit(1);
    }

    let frontend: FrontendCatalog;
    try {
        frontend = await frontendCatalog();
    } catch (e: any) {
        console.error(`✗ Could not import ${frontendModulePath}: ${e?.message || e}`);
        process.exit(1);
    }

    const feAgents = new Set(frontend.agentOptions.map((o) => o.value));
    const feDocTypes = new Set(Object.keys(frontend.docTypeToAgent));

    // 1. Registry agents must exist in the frontend options.
    for (const agentId of catalog.agent_ids) {
        if (!feAgents.has(agentId)) {
            problems.push(
                `MISSING agent "${agentId}" in AGENT_OPTIONS (registry: "${catalog.agent_labels[agentId] || agentId}")`
            );
        }
    }
    // 2. Frontend-only agents are allowed (e.g. future UI-only buckets) — just warn.
    for (const { value } of frontend.agentOptions) {
        if (!catalog.agent_ids.includes(value)) {
            warnings.push(`frontend lists agent "${value}" that the registry does not know`);
        }
    }

    // 2b. Gateway bundled fallback (PLAN_AGENT_IDS). Runtime entitlements resolve
    // from the registry and pick up new agents automatically, so a missing entry
    // here only degrades the fallback path (AI backend down) — warn. A stale entry
    // the registry no longer knows is a problem.
    const gatewayAgentSet = new Set<string>(PLAN_AGENT_IDS);
    for (const agentId of [...PLAN_AGENT_IDS]) {
        if (!catalog.agent_ids.includes(agentId)) {
            problems.push(`gateway PLAN_AGENT_IDS lists "${agentId}" that the registry does not know`);
        }
    }
    for (const agentId of catalog.agent_ids) {
        if (!gatewayAgentSet.has(agentId)) {
            warnings.push(
                `registry agent "${agentId}" missing from gateway PLAN_AGENT_IDS fallback (runtime still serves it; add it so the fallback stays complete when the AI backend is down)`
            );
        }
    }

    // 3. Every registry doc_type must map to the SAME agent in the frontend.
    for (const [docType, agentId] of Object.entries(catalog.doc_type_to_agent)) {
        const feAgent = frontend.docTypeToAgent[docType];
        if (feAgent === undefined) {
            problems.push(`MISSING doc_type "${docType}" in DOC_TYPE_TO_AGENT (registry routes it to "${agentId}")`);
        } else if (feAgent !== agentId) {
            problems.push(`MISMATCH doc_type "${docType}": frontend → "${feAgent}", registry → "${agentId}"`);
        }
    }
    // 4. Frontend-only doc types (letter/report UI types) — warn, not fail.
    for (const docType of feDocTypes) {
        if (!(docType in catalog.doc_type_to_agent)) {
            warnings.push(`frontend lists doc_type "${docType}" not emitted by the classifier`);
        }
    }

    console.log(
        `Registry: ${catalog.agent_ids.length} agents, ${Object.keys(catalog.doc_type_to_agent).length} doc types, ${catalog.tool_count} tools`
    );
    console.log(`Frontend: ${feAgents.size} agent options, ${feDocTypes.size} doc types`);
    console.log(`Gateway: ${PLAN_AGENT_IDS.length} bundled fallback agents`);
    console.log('');

    for (const w of warnings) console.log(`⚠  ${w}`);
    for (const p of problems) console.log(`✗ ${p}`);

    if (problems.length) {
        console.error(`\nDrift found (${problems.length}). Update frontend/src/lib/documentAgents.ts to match the registry, then re-run.`);
        process.exit(1);
    }
    console.log(
        warnings.length
            ? `\nOK — in sync with the registry (${warnings.length} warnings, non-blocking).`
            : '\nOK — frontend catalog is in sync with the registry.'
    );
}

void main();
