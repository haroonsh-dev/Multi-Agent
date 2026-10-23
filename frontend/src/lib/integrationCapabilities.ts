/** Keep in sync with api-gateway/src/constants/integrationCapabilities.ts */

export type IntegrationProviderCapabilities = {
    pullSchedule: boolean;
    pullManual: boolean;
    pushIngest: boolean;
    recordIngest: boolean;
    remoteTest: boolean;
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

export const PROVIDER_CAPABILITIES: Record<string, IntegrationProviderCapabilities> = {
    google_drive: {
        pullSchedule: true,
        pullManual: true,
        pushIngest: true,
        recordIngest: true,
        remoteTest: true,
        middlewarePush: false,
    },
    sharepoint: { ...DEFAULT },
    onedrive: { ...DEFAULT },
    shared_folder_sftp: { ...DEFAULT },
    email_inbox: { ...DEFAULT },
    dynamics365: { ...DEFAULT, remoteTest: true },
    sap: { ...DEFAULT, remoteTest: true },
    odoo: { ...DEFAULT, remoteTest: true },
    ignition: { ...DEFAULT },
    mastercontrol: { ...DEFAULT },
    fiix_upkeep: { ...DEFAULT },
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
    sql_csv_drop: { ...DEFAULT },
};

export function getProviderCapabilities(providerId: string): IntegrationProviderCapabilities {
    return PROVIDER_CAPABILITIES[providerId] || DEFAULT;
}

export const SCHEDULE_FIELD_KEYS = new Set([
    "intervalMinutes",
    "syncMode",
    "dailyAt",
    "autoSyncEnabled",
    "intervalAutoUpload",
]);

export function isErpProvider(providerId: string): boolean {
    return providerId === "sap" || providerId === "dynamics365" || providerId === "odoo";
}
