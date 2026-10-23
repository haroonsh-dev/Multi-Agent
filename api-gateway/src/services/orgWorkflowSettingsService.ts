import Organization from '../models/Organization';

export type OrgWorkflowSettings = {
    autoApprovalThreshold?: number;
    requirePoMatchForAutoApproval?: boolean;
    duplicateCheckEnabled?: boolean;
    criticalExpiryDays?: number;
    warningExpiryDays?: number;
    autoShortlistMinScore?: number;
    slackWebhookUrl?: string | null;
    alertEmail?: string | null;
};

const cache = new Map<string, { settings: OrgWorkflowSettings; at: number }>();
const CACHE_MS = 5 * 60 * 1000;

export function defaultWorkflowSettings(): Required<OrgWorkflowSettings> {
    return {
        autoApprovalThreshold: 1000,
        requirePoMatchForAutoApproval: true,
        duplicateCheckEnabled: true,
        criticalExpiryDays: 30,
        warningExpiryDays: 90,
        autoShortlistMinScore: 75,
        slackWebhookUrl: null,
        alertEmail: null,
    };
}

export async function getOrgWorkflowSettings(
    organizationId: string | null | undefined
): Promise<Required<OrgWorkflowSettings>> {
    const defaults = defaultWorkflowSettings();
    if (!organizationId) return defaults;

    const hit = cache.get(organizationId);
    if (hit && Date.now() - hit.at < CACHE_MS) {
        return { ...defaults, ...hit.settings };
    }

    try {
        const org = await Organization.findOne({ organizationId })
            .select('workflowSettings')
            .lean();
        const raw = (org as { workflowSettings?: OrgWorkflowSettings } | null)?.workflowSettings;
        const settings: Required<OrgWorkflowSettings> = {
            autoApprovalThreshold:
                typeof raw?.autoApprovalThreshold === 'number' && raw.autoApprovalThreshold >= 0
                    ? raw.autoApprovalThreshold
                    : defaults.autoApprovalThreshold,
            requirePoMatchForAutoApproval:
                typeof raw?.requirePoMatchForAutoApproval === 'boolean'
                    ? raw.requirePoMatchForAutoApproval
                    : defaults.requirePoMatchForAutoApproval,
            duplicateCheckEnabled:
                typeof raw?.duplicateCheckEnabled === 'boolean'
                    ? raw.duplicateCheckEnabled
                    : defaults.duplicateCheckEnabled,
            criticalExpiryDays:
                typeof raw?.criticalExpiryDays === 'number' && raw.criticalExpiryDays > 0
                    ? raw.criticalExpiryDays
                    : defaults.criticalExpiryDays,
            warningExpiryDays:
                typeof raw?.warningExpiryDays === 'number' && raw.warningExpiryDays > 0
                    ? raw.warningExpiryDays
                    : defaults.warningExpiryDays,
            autoShortlistMinScore:
                typeof raw?.autoShortlistMinScore === 'number' && raw.autoShortlistMinScore >= 0
                    ? raw.autoShortlistMinScore
                    : defaults.autoShortlistMinScore,
            slackWebhookUrl: raw?.slackWebhookUrl || null,
            alertEmail: raw?.alertEmail || null,
        };

        cache.set(organizationId, { settings, at: Date.now() });
        return settings;
    } catch {
        return defaults;
    }
}

export function clearOrgWorkflowSettingsCache(organizationId?: string) {
    if (organizationId) cache.delete(organizationId);
    else cache.clear();
}

export async function updateOrgWorkflowSettings(
    organizationId: string,
    patch: OrgWorkflowSettings
): Promise<Required<OrgWorkflowSettings>> {
    const update: Record<string, unknown> = {};

    if (patch.autoApprovalThreshold !== undefined) {
        update['workflowSettings.autoApprovalThreshold'] = Math.max(0, Number(patch.autoApprovalThreshold) || 0);
    }
    if (patch.requirePoMatchForAutoApproval !== undefined) {
        update['workflowSettings.requirePoMatchForAutoApproval'] = Boolean(patch.requirePoMatchForAutoApproval);
    }
    if (patch.duplicateCheckEnabled !== undefined) {
        update['workflowSettings.duplicateCheckEnabled'] = Boolean(patch.duplicateCheckEnabled);
    }
    if (patch.criticalExpiryDays !== undefined) {
        update['workflowSettings.criticalExpiryDays'] = Math.max(1, Number(patch.criticalExpiryDays) || 30);
    }
    if (patch.warningExpiryDays !== undefined) {
        update['workflowSettings.warningExpiryDays'] = Math.max(1, Number(patch.warningExpiryDays) || 90);
    }
    if (patch.autoShortlistMinScore !== undefined) {
        update['workflowSettings.autoShortlistMinScore'] = Math.min(100, Math.max(0, Number(patch.autoShortlistMinScore) || 75));
    }
    if (patch.slackWebhookUrl !== undefined) {
        const url = String(patch.slackWebhookUrl || '').trim();
        update['workflowSettings.slackWebhookUrl'] = url || null;
    }
    if (patch.alertEmail !== undefined) {
        const email = String(patch.alertEmail || '').trim();
        update['workflowSettings.alertEmail'] = email || null;
    }

    await Organization.updateOne({ organizationId }, { $set: update });
    clearOrgWorkflowSettingsCache(organizationId);
    return getOrgWorkflowSettings(organizationId);
}
