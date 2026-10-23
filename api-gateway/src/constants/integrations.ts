/** Allowed integration provider IDs — keep in sync with frontend integrationCatalog.ts */
export const INTEGRATION_PROVIDER_IDS = [
    // File & Cloud
    'google_drive',
    'sharepoint',
    'onedrive',
    'shared_folder_sftp',
    'email_inbox',
    // ERP
    'dynamics365',
    'sap',
    'odoo',
    // MES / Quality / Maintenance
    'ignition',
    'mastercontrol',
    'fiix_upkeep',
    // SaaS / Generic
    'clickup',
    'slack',
    'custom_webhook',
    'sql_csv_drop',
] as const;

export type IntegrationProviderId = (typeof INTEGRATION_PROVIDER_IDS)[number];

export const SECRET_FIELD_KEYS = new Set([
    'password',
    'clientSecret',
    'privateKey',
    'apiKey',
    'apiSecret',
    'consumerSecret',
    'tokenSecret',
    'refreshToken',
    'connectionString',
    'apiToken',
    'botToken',
    'ingestBearerToken',
    'ingestBasicPassword',
    'ingestCustomHeaderValue',
]);
