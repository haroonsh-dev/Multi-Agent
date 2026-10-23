import type { IntegrationProviderId } from './integrations';

/** Keep in sync with frontend/src/lib/integrationCapabilities.ts */
export type IntegrationProviderCapabilities = {
    /** Visibility can poll/list remote files on a schedule */
    pullSchedule: boolean;
    /** Manual "Sync now" in admin or agent workspace */
    pullManual: boolean;
    /** Accept inbound HTTP push (multipart / fileUrl) */
    pushIngest: boolean;
    /** Accept JSON structured records (recordType + data) without OCR */
    recordIngest: boolean;
    /** Run test validates remote credentials (not just "form filled") */
    remoteTest: boolean;
    /** ERP / middleware — documents arrive via customer push job */
    middlewarePush: boolean;
};

const DEFAULT: IntegrationProviderCapabilities = {
    pullSchedule: false,
    pullManual: false,
    pushIngest: true,
    recordIngest: true,
    remoteTest: false,
    middlewarePush: true,
};

export const PROVIDER_CAPABILITIES: Record<IntegrationProviderId, IntegrationProviderCapabilities> = {
    google_drive: {
        pullSchedule: true,
        pullManual: true,
        pushIngest: true,
        recordIngest: true,
        remoteTest: true,
        middlewarePush: false,
    },
    sharepoint: { ...DEFAULT, remoteTest: false },
    onedrive: { ...DEFAULT, remoteTest: false },
    shared_folder_sftp: { ...DEFAULT, remoteTest: false },
    email_inbox: { ...DEFAULT, remoteTest: false },
    dynamics365: { ...DEFAULT, remoteTest: true, middlewarePush: true },
    sap: { ...DEFAULT, remoteTest: true, middlewarePush: true },
    odoo: { ...DEFAULT, remoteTest: true, middlewarePush: true },
    ignition: { ...DEFAULT, remoteTest: false },
    mastercontrol: { ...DEFAULT, remoteTest: false },
    fiix_upkeep: { ...DEFAULT, remoteTest: false },
    clickup: {
        pullSchedule: true,
        pullManual: true,
        pushIngest: true,
        recordIngest: true,
        remoteTest: true,
        middlewarePush: false,
    },
    slack: {
        pullSchedule: true,
        pullManual: true,
        pushIngest: true,
        recordIngest: true,
        remoteTest: true,
        middlewarePush: false,
    },
    custom_webhook: {
        pullSchedule: false,
        pullManual: false,
        pushIngest: true,
        recordIngest: true,
        remoteTest: false,
        middlewarePush: false,
    },
    sql_csv_drop: { ...DEFAULT, remoteTest: false },
};

export function getProviderCapabilities(providerId: string): IntegrationProviderCapabilities {
    const id = providerId as IntegrationProviderId;
    return PROVIDER_CAPABILITIES[id] || DEFAULT;
}

export const SCHEDULE_FIELD_KEYS = new Set([
    'intervalMinutes',
    'syncMode',
    'dailyAt',
    'autoSyncEnabled',
    'intervalAutoUpload',
]);
