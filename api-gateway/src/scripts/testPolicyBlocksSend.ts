/**
 * Regression test for the gateway's outbound policy-decision mapping.
 *
 * sendViaIntegration must stop when the ai-backend returns approval_required
 * OR blocked (unknown tool / audit could not be written). A regression where
 * "blocked" falls through would send data outward on a fail-open — this script
 * pins the mapping so that can't silently come back.
 *
 *   npm run test:policy-blocks-send
 */
import { policyBlocksSend } from '../utils/policyGate';

let ok = 0;
let fail = 0;
function check(name: string, cond: boolean) {
    if (cond) {
        ok += 1;
        console.log(`PASS  ${name}`);
    } else {
        fail += 1;
        console.log(`FAIL  ${name}`);
    }
}

// Decisions that must stop an outbound send.
check('approval_required blocks send', policyBlocksSend('approval_required') === true);
check('blocked blocks send', policyBlocksSend('blocked') === true);

// Decisions that must NOT stop it.
check('allow does not block send', policyBlocksSend('allow') === false);
check('allow_with_audit does not block send', policyBlocksSend('allow_with_audit') === false);
check('undefined decision does not block send', policyBlocksSend(undefined) === false);
check('null decision does not block send', policyBlocksSend(null as any) === false);
check('missing decision does not block send', policyBlocksSend() === false);

console.log(`\n${ok}/${ok + fail} passed`);
process.exit(fail ? 1 : 0);
