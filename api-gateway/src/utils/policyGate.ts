/**
 * Policy-decision helpers shared by gateway controllers that gate outbound /
 * high-risk actions against the ai-backend policy service.
 *
 * Decisions that must STOP an outbound send (or any Tier-3 action):
 *   - "approval_required"  Tier-3 needs a human approval the caller doesn't hold
 *   - "blocked"            tool unknown to the registry, or audit could not be
 *                          written — risk cannot be assessed, so never proceed
 */
export function policyBlocksSend(decision?: string): boolean {
    return decision === 'approval_required' || decision === 'blocked';
}
