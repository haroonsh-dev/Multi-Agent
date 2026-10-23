import Document from '../models/Document';
import { AuthUser, buildDocumentFilter } from './accessScope';
import { getOrgEntitlement } from './planService';
import { ANALYTICS_AGENT_IDS, docTypesForAgent } from '../constants/agentCatalog';

const READY_STATUSES = ['ready', 'review'] as const;

export type AgentFleetRow = {
    agentId: string;
    documentCount: number;
    readyCount: number;
    healthScore: number;
    healthLabel: 'Ready' | 'Partial' | 'Empty' | 'Needs work';
};

export async function getAgentFleetSnapshot(user: AuthUser): Promise<{
    timestamp: string;
    agents: AgentFleetRow[];
    allowedAgentIds: string[];
}> {
    const uploadedBy = user.role === 'team' ? user.userId : undefined;
    const filter = await buildDocumentFilter(user, uploadedBy ? { uploadedBy } : {});

    let allowedAgentIds: string[] = [...ANALYTICS_AGENT_IDS];
    if (user.organizationId && user.role !== 'superAdmin') {
        try {
            const ent = await getOrgEntitlement(user.organizationId);
            if (ent.agentIds?.length) {
                allowedAgentIds = ent.agentIds.filter((id) =>
                    (ANALYTICS_AGENT_IDS as readonly string[]).includes(id)
                );
            }
        } catch {
            allowedAgentIds = ['other_agent'];
        }
    }

    const rows = await Promise.all(
        allowedAgentIds.map(async (agentId) => {
            const types = docTypesForAgent(agentId);
            const orClause: Record<string, unknown>[] = [{ 'metadata.phase3Agent': agentId }];
            if (types.length) orClause.push({ classification: { $in: types } });
            const documentCount = await Document.countDocuments({ ...filter, $or: orClause });
            const readyCount = await Document.countDocuments({
                ...filter,
                $or: orClause,
                status: { $in: ['ready', 'review'] as const },
            });
            let healthScore = 0;
            let healthLabel: AgentFleetRow['healthLabel'] = 'Empty';
            if (documentCount === 0) {
                healthScore = 0;
                healthLabel = 'Empty';
            } else {
                healthScore = Math.round((readyCount / documentCount) * 100);
                if (healthScore >= 85) healthLabel = 'Ready';
                else if (healthScore >= 45) healthLabel = 'Partial';
                else healthLabel = 'Needs work';
            }
            return { agentId, documentCount, readyCount, healthScore, healthLabel };
        })
    );

    return {
        timestamp: new Date().toISOString(),
        agents: rows,
        allowedAgentIds,
    };
}
