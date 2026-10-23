/**
 * Integration task playbook fixtures (no HTTP / DB).
 * Run: npx tsx --tsconfig tsconfig.json src/scripts/testIntegrationTaskPlaybook.ts
 */
import {
    __resetPlaybookStoreForTests,
    detectPlaybookAsk,
    detectPlaybookCancel,
    detectPlaybookConfirm,
    parsePlaybookAssigneeNeedle,
    parsePlaybookKind,
} from '../services/integrationTaskPlaybookService';
import { isOpenIntegrationTask, type IntegrationTaskRow } from '../services/integrationTaskChatService';

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

__resetPlaybookStoreForTests();

check('detect playbook asks', () => {
    assert(detectPlaybookAsk('process open tasks until done'), 'process until done');
    assert(detectPlaybookAsk('close all open tasks'), 'close open');
    assert(detectPlaybookAsk('assign all open tasks to Ahmed'), 'assign all');
    assert(detectPlaybookAsk('run task playbook'), 'playbook');
    assert(detectPlaybookAsk('work through open tasks'), 'work through');
    assert(!detectPlaybookAsk('show synced tasks'), 'not plain list');
    assert(!detectPlaybookAsk('create task hello'), 'not create');
});

check('detect confirm / cancel', () => {
    assert(detectPlaybookConfirm('yes'), 'yes');
    assert(detectPlaybookConfirm('go ahead'), 'go ahead');
    assert(detectPlaybookConfirm('confirm'), 'confirm');
    assert(!detectPlaybookConfirm('yes please assign Ahmed to everything forever'), 'long no');
    assert(detectPlaybookCancel('cancel'), 'cancel');
    assert(detectPlaybookCancel('no'), 'no');
    assert(!detectPlaybookCancel('now show tasks'), 'not cancel');
});

check('parse kind + assignee', () => {
    assert(parsePlaybookKind('close all open tasks') === 'close_open', 'close kind');
    assert(parsePlaybookKind('assign all open tasks to Ahmed') === 'assign_open', 'assign kind');
    assert(parsePlaybookKind('process open tasks to Sara until done') === 'process_open', 'process kind');
    assert(parsePlaybookAssigneeNeedle('assign all open tasks to Ahmed') === 'Ahmed', 'assignee Ahmed');
    assert(
        /sara/i.test(parsePlaybookAssigneeNeedle('process open tasks to Sara until done') || ''),
        'assignee Sara'
    );
});

check('open task filter', () => {
    const open: IntegrationTaskRow = {
        documentId: 'd1',
        taskId: 't1',
        name: 'A',
        status: 'to do',
        assignees: 'Unassigned',
        dueDate: '—',
        listName: 'List',
        url: '',
        updatedAt: '—',
    };
    const done: IntegrationTaskRow = { ...open, taskId: 't2', status: 'complete' };
    assert(isOpenIntegrationTask(open), 'open');
    assert(!isOpenIntegrationTask(done), 'done closed');
});

console.log(`\n${passed} checks passed`);
