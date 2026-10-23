/**
 * Universal integration task chat fixtures (no HTTP).
 * Run: npx tsx --tsconfig tsconfig.json src/scripts/testIntegrationTaskChat.ts
 */
import {
    detectIntegrationTaskAsk,
    detectTaskWriteIntent,
    formatTaskAssignees,
    matchTaskMembers,
    parseAssignCommand,
    parseIntegrationTaskFromDoc,
    parseCreateTaskCommand,
} from '../services/integrationTaskChatService';

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

check('detect: synced tasks', () => {
    assert(detectIntegrationTaskAsk('check what are synced tasks'), 'detect');
    assert(detectIntegrationTaskAsk('Show ClickUp tasks and assignees'), 'provider keyword still ok');
});

check('detect: negative generic HR', () => {
    assert(!detectIntegrationTaskAsk('Generate offer letter for Ali'), 'no false positive');
});

check('format assignees array', () => {
    const s = formatTaskAssignees([
        { username: 'Ahmed', email: 'a@test.com' },
        { username: 'Sara' },
    ]);
    assert(s.includes('Ahmed') && s.includes('Sara'), s);
});

check('parse task from doc metadata', () => {
    const row = parseIntegrationTaskFromDoc({
        documentId: 'doc_1',
        originalFilename: 'Fix login bug.json',
        metadata: {
            source: 'clickup',
            ingestKind: 'structured_record',
            structuredData: {
                taskId: 'abc123',
                name: 'Fix login bug',
                status: 'in progress',
                assignees: [{ username: 'Dev', email: 'dev@co.com' }],
                due_date: 1735689600000,
                list: { name: 'Engineering' },
            },
            integrationExternalRef: { clickupTaskId: 'abc123' },
        },
    });
    assert(row?.name === 'Fix login bug', 'name');
    assert(Boolean(row?.assignees?.includes('Dev')), 'assignee');
    assert(row?.listName === 'Engineering', 'list');
});

check('detect write assign / create', () => {
    assert(detectTaskWriteIntent('assign Test Candidate to Ahmed'), 'assign write');
    assert(!detectTaskWriteIntent('tasks assigned to Ahmed'), 'query not write');
    assert(detectTaskWriteIntent('create task Screen Ali assigned to Sara'), 'create');
    assert(detectTaskWriteIntent('assign it haroon shahid'), 'assign it');
    const a = parseAssignCommand('assign Test Candidate — Engineer to Ahmed');
    assert(Boolean(a?.left.includes('Candidate') && a?.right === 'Ahmed'), 'parse assign');
    const a2 = parseAssignCommand('assign it haroon shahid');
    assert(Boolean(a2?.left === '__focus__' && /haroon/i.test(a2.right)), 'parse assign it');
    const c = parseCreateTaskCommand('create task Interview Ali assigned to Sara');
    assert(Boolean(c?.name === 'Interview Ali' && c?.assigneeNeedle === 'Sara'), 'parse create');
    const messy = parseCreateTaskCommand(
        'show me haroon sahhid all task list and also assign new task like json format data'
    );
    assert(Boolean(messy?.name === 'json format data'), `messy name got ${messy?.name}`);
    assert(Boolean(/haroon/i.test(messy?.assigneeNeedle || '')), `messy assignee ${messy?.assigneeNeedle}`);
    const members = matchTaskMembers(
        [
            { id: 1, username: 'Ahmed', email: 'a@co.com', label: 'Ahmed (a@co.com)' },
            { id: 2, username: 'Sara', email: 's@co.com', label: 'Sara (s@co.com)' },
        ],
        'ahmed'
    );
    assert(members.length === 1 && members[0].id === 1, 'member match');
});

console.log(`\n${passed} checks passed`);
