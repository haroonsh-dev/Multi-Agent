/**
 * Test autonomous task playbook execution (no confirmation pause).
 * Run: npx tsx --tsconfig tsconfig.json src/scripts/testAutonomousPlaybook.ts
 */
import {
    __playbookHooks,
    __resetPlaybookStoreForTests,
    detectPlaybookAsk,
    detectPlaybookAutoExecute,
    tryIntegrationTaskPlaybookCommand,
} from '../services/integrationTaskPlaybookService';

function assert(cond: boolean, msg: string) {
    if (!cond) throw new Error(msg);
}

let passed = 0;
function check(name: string, fn: () => void | Promise<void>) {
    return Promise.resolve()
        .then(() => fn())
        .then(() => {
            passed += 1;
            console.log(`✓ ${name}`);
        })
        .catch((e: unknown) => {
            const err = e as { message?: string };
            console.error(`✗ ${name}: ${err?.message || e}`);
            process.exitCode = 1;
        });
}

async function main() {
    console.log('=== Autonomous Playbook Detection & Execution Tests ===\n');

    await check('detectPlaybookAutoExecute detection rules', () => {
        assert(detectPlaybookAutoExecute('auto process open tasks until done'), 'auto prefix');
        assert(detectPlaybookAutoExecute('automatically close open tasks'), 'automatically prefix');
        assert(detectPlaybookAutoExecute('process open tasks auto'), 'auto suffix');
        assert(detectPlaybookAutoExecute('autonomous task playbook'), 'autonomous keyword');
        assert(detectPlaybookAutoExecute('process open tasks without confirmation'), 'without confirmation phrase');
        assert(detectPlaybookAutoExecute('run task playbook auto-execute'), 'auto-execute keyword');

        // Standard interactive asks must NOT be auto
        assert(!detectPlaybookAutoExecute('process open tasks until done'), 'standard interactive not auto');
        assert(!detectPlaybookAutoExecute('close all open tasks'), 'standard close not auto');
        assert(!detectPlaybookAutoExecute('assign all open tasks to Ahmed'), 'standard assign not auto');
    });

    await check('detectPlaybookAsk detects both interactive and auto requests', () => {
        assert(detectPlaybookAsk('process open tasks until done'), 'interactive ask');
        assert(detectPlaybookAsk('auto process open tasks until done'), 'auto ask');
        assert(detectPlaybookAsk('automatically close all open tasks'), 'automatically close');
    });

    await check('Autonomous execution executes end-to-end in 1 step without confirmation', async () => {
        __resetPlaybookStoreForTests();

        let executionStepCalled = 0;
        let assignCalled = 0;
        let completeCalled = 0;

        (__playbookHooks as any).resolveTaskIntegrationConnection = async () => ({
            organizationId: 'org-auto',
            secrets: { apiToken: 'pk_auto' },
            config: { listId: '123' },
        });
        (__playbookHooks as any).connectionCreds = () => ({ apiToken: 'pk_auto', listId: '123' });
        (__playbookHooks as any).loadIntegrationTaskRows = async () => [
            {
                documentId: 'doc-1',
                taskId: 'task-1',
                name: 'Auto Task Alpha',
                status: 'to do',
                assignees: 'Unassigned',
                dueDate: '—',
                listName: 'Sprint',
                url: '',
                updatedAt: '—',
            },
            {
                documentId: 'doc-2',
                taskId: 'task-2',
                name: 'Auto Task Beta',
                status: 'in progress',
                assignees: 'Unassigned',
                dueDate: '—',
                listName: 'Sprint',
                url: '',
                updatedAt: '—',
            },
        ];
        (__playbookHooks as any).isOpenIntegrationTask = () => true;
        (__playbookHooks as any).resolveCompleteStatusForConnection = async () => 'complete';
        (__playbookHooks as any).assignTaskForConnection = async () => {
            assignCalled += 1;
        };
        (__playbookHooks as any).completeTaskForConnection = async () => {
            completeCalled += 1;
            return 'complete';
        };
        (__playbookHooks as any).refreshTaskRecordAfterWrite = async () => {
            executionStepCalled += 1;
        };

        const user = { userId: 'u-auto', role: 'admin', organizationId: 'org-auto' };

        const autoRes = await tryIntegrationTaskPlaybookCommand({
            user,
            question: 'auto process open tasks until done',
            phase3Agent: 'finance_agent',
            sessionId: 'sess-auto-1',
        });

        assert(autoRes.handled, 'auto playbook must be handled');
        assert(!/confirm to run|Reply yes to run/i.test(autoRes.answer || ''), 'must NOT ask for confirmation');
        assert(/Playbook finished|2 succeeded/i.test(autoRes.answer || ''), 'must contain execution summary');
        assert(executionStepCalled === 2, `expected 2 execution steps, got ${executionStepCalled}`);
        assert(completeCalled === 2, `expected 2 completed tasks, got ${completeCalled}`);
        assert(autoRes.citations?.length === 2, 'expected 2 citations');
    });

    console.log(`\n${passed} checks passed.`);
    if (process.exitCode) process.exit(1);
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
