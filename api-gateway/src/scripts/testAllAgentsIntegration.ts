/**
 * Verify integration playbook + structured-record detect across all agents.
 * Run: npx tsx --tsconfig tsconfig.json src/scripts/testAllAgentsIntegration.ts
 */
import { ANALYTICS_AGENT_IDS } from '../constants/agentCatalog';
import {
    __resetPlaybookStoreForTests,
    detectPlaybookAsk,
    tryIntegrationTaskPlaybookCommand,
} from '../services/integrationTaskPlaybookService';
import {
    detectStructuredRecordAsk,
    inferRecordTypeFromQuestion,
} from '../services/structuredRecordChatService';

function assert(cond: boolean, msg: string) {
    if (!cond) throw new Error(msg);
}

const AGENTS = [...ANALYTICS_AGENT_IDS];

const DOMAIN_ASKS: Record<string, { ask: string; recordType?: string }> = {
    hr_agent: { ask: 'show synced candidates', recordType: 'candidate' },
    finance_agent: { ask: 'show synced invoices', recordType: 'invoice' },
    procurement_agent: { ask: 'show purchase orders', recordType: 'purchase_order' },
    legal_agent: { ask: 'list contracts', recordType: 'contract' },
    compliance_agent: { ask: 'how many certificates synced', recordType: 'certificate' },
    other_agent: { ask: 'show synced records', recordType: undefined },
};

async function main() {
    console.log(`Agents under test: ${AGENTS.join(', ')}\n`);

    // 1) Structured-record detection per agent domain
    console.log('=== Structured record detect (per agent fields) ===');
    for (const agent of AGENTS) {
        const spec = DOMAIN_ASKS[agent];
        assert(Boolean(spec), `missing domain ask for ${agent}`);
        const detected = detectStructuredRecordAsk(spec.ask, agent);
        const inferred = inferRecordTypeFromQuestion(spec.ask);
        assert(detected, `${agent}: detect failed for "${spec.ask}"`);
        if (spec.recordType) {
            assert(
                inferred === spec.recordType,
                `${agent}: expected type ${spec.recordType}, got ${inferred}`
            );
        }
        console.log(`✓ ${agent}: "${spec.ask}" → type=${inferred || 'any'}`);
    }

    // 2) Playbook detect is agent-agnostic
    console.log('\n=== Playbook detect (same for every agent) ===');
    const playbookQ = 'process open tasks until done';
    assert(detectPlaybookAsk(playbookQ), 'playbook detect');
    console.log(`✓ detectPlaybookAsk("${playbookQ}")`);

    // 3) Mocked plan → yes for each agent (isolated pending keys)
    console.log('\n=== Playbook plan → yes (mocked) per agent ===');
    const chat = require('../services/integrationTaskChatService');
    const bridge = require('../services/clickupBridgeService');

    chat.resolveTaskIntegrationConnection = async () => ({
        organizationId: 'org1',
        secrets: { apiToken: 'pk_test' },
        config: { listId: '123' },
    });
    chat.connectionCreds = () => ({ apiToken: 'pk_test', listId: '123' });
    chat.loadIntegrationTaskRows = async () => [
        {
            documentId: 'd1',
            taskId: 't1',
            name: 'Open A',
            status: 'to do',
            assignees: 'Unassigned',
            dueDate: '—',
            listName: 'L',
            url: '',
            updatedAt: '—',
        },
        {
            documentId: 'd2',
            taskId: 't2',
            name: 'Open B',
            status: 'in progress',
            assignees: 'Ali',
            dueDate: '—',
            listName: 'L',
            url: '',
            updatedAt: '—',
        },
    ];
    chat.isOpenIntegrationTask = (row: { status: string }) =>
        !/complete|closed|done/i.test(row.status);
    chat.matchTaskMembers = (_m: unknown, needle: string) =>
        /ahmed/i.test(needle)
            ? [{ id: 42, username: 'Ahmed', email: 'a@x.com', label: 'Ahmed' }]
            : [];
    bridge.listClickUpAssignableMembers = async () => [
        { id: 42, username: 'Ahmed', email: 'a@x.com', label: 'Ahmed' },
    ];
    bridge.resolveClickUpCompleteStatus = async () => 'complete';
    bridge.assignClickUpTask = async () => ({});
    bridge.updateClickUpTaskStatus = async () => ({});
    bridge.ingestAttachmentsFromTask = async () => ({});

    // Reload playbook after patches
    delete require.cache[require.resolve('../services/integrationTaskPlaybookService')];
    const pb = require('../services/integrationTaskPlaybookService');
    pb.__resetPlaybookStoreForTests();

    const user = { userId: 'u-all', role: 'admin', organizationId: 'org1' };

    for (const agent of AGENTS) {
        const sessionId = `sess-${agent}`;
        const plan = await pb.tryIntegrationTaskPlaybookCommand({
            user,
            question: 'process open tasks to Ahmed until done',
            phase3Agent: agent,
            sessionId,
        });
        assert(plan.handled, `${agent}: plan not handled`);
        assert(/Playbook plan/i.test(plan.answer || ''), `${agent}: missing plan heading`);
        assert(
            new RegExp(agent.split('_')[0], 'i').test(plan.answer || '') ||
                /HR|Finance|Legal|Compliance|Procurement|General/i.test(plan.answer || ''),
            `${agent}: missing agent label in plan`
        );
        assert(/Open A/i.test(plan.answer || ''), `${agent}: checklist missing Open A`);
        assert(
            (plan.citations || []).every(
                (c: { phase3Agent?: string }) => c.phase3Agent === agent
            ),
            `${agent}: citations must carry phase3Agent`
        );

        const run = await pb.tryIntegrationTaskPlaybookCommand({
            user,
            question: 'yes',
            phase3Agent: agent,
            sessionId,
        });
        assert(run.handled, `${agent}: execute not handled`);
        assert(/Playbook finished|succeeded/i.test(run.answer || ''), `${agent}: finish summary`);
        console.log(`✓ ${agent}: plan → yes → finished`);
    }

    // 4) Agent pending isolation: HR pending must not confirm from Finance
    console.log('\n=== Pending isolation across agents ===');
    pb.__resetPlaybookStoreForTests();
    const hrPlan = await pb.tryIntegrationTaskPlaybookCommand({
        user,
        question: 'close all open tasks',
        phase3Agent: 'hr_agent',
        sessionId: 'shared-sess',
    });
    assert(hrPlan.handled, 'hr plan');
    const financeYes = await pb.tryIntegrationTaskPlaybookCommand({
        user,
        question: 'yes',
        phase3Agent: 'finance_agent',
        sessionId: 'shared-sess',
    });
    assert(!financeYes.handled, 'finance yes must NOT steal HR pending');
    const hrYes = await pb.tryIntegrationTaskPlaybookCommand({
        user,
        question: 'yes',
        phase3Agent: 'hr_agent',
        sessionId: 'shared-sess',
    });
    assert(hrYes.handled, 'hr yes should run HR pending');
    console.log('✓ HR pending isolated from Finance confirm');

    console.log(`\nAll ${AGENTS.length} agents verified for integration playbook + record detect.`);
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
