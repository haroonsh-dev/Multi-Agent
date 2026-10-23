export type IntegrationCategory =
    | "file_cloud"
    | "erp"
    | "mes"
    | "quality"
    | "maintenance"
    | "generic";

export type IntegrationDirection = "inbound" | "outbound" | "both";

export type IntegrationFieldType = "text" | "password" | "url" | "number" | "select";

export type IntegrationField = {
    key: string;
    label: string;
    type: IntegrationFieldType;
    required?: boolean;
    placeholder?: string;
    secret?: boolean;
    options?: Array<{ value: string; label: string }>;
    help?: string;
};

export type IntegrationCatalogItem = {
    id: string;
    name: string;
    category: IntegrationCategory;
    description: string;
    directions: IntegrationDirection;
    fields: IntegrationField[];
    guideSteps: string[];
    setupNotes: string;
};

export const INTEGRATION_CATEGORIES: Array<{ id: IntegrationCategory | "all"; label: string }> = [
    { id: "all", label: "All" },
    { id: "file_cloud", label: "File & Cloud" },
    { id: "erp", label: "ERP" },
    { id: "mes", label: "MES / Shop Floor" },
    { id: "quality", label: "Quality / QMS" },
    { id: "maintenance", label: "Maintenance" },
    { id: "generic", label: "Generic" },
];

const SCHEDULE_FIELD: IntegrationField = {
    key: "intervalMinutes",
    label: "Sync interval (minutes)",
    type: "number",
    required: true,
    placeholder: "15",
    help: "How often Visibility Docs should pull new files when auto-sync is enabled.",
};

const AGENT_FIELD: IntegrationField = {
    key: "phase3Agent",
    label: "Default AI agent",
    type: "select",
    options: [
        { value: "", label: "Auto-detect" },
        { value: "finance_agent", label: "Finance" },
        { value: "hr_agent", label: "HR" },
        { value: "legal_agent", label: "Legal" },
        { value: "procurement_agent", label: "Procurement" },
        { value: "compliance_agent", label: "Compliance" },
        { value: "other_agent", label: "Other" },
    ],
};

const OUTBOUND_FIELD: IntegrationField = {
    key: "outboundWebhookUrl",
    label: "Outbound results webhook URL",
    type: "url",
    placeholder: "https://factory.example.com/hooks/visibility-results",
    help: "Optional. Manual Send can POST file / summary / extracted JSON here. Not auto — only when you click Send.",
};

const USE_CASE_FIELD: IntegrationField = {
    key: "useCase",
    label: "Use case / document stream",
    type: "select",
    options: [
        { value: "", label: "General" },
        { value: "ap", label: "Finance — Accounts Payable (AP)" },
        { value: "ar", label: "Finance — Accounts Receivable (AR)" },
        { value: "gl", label: "Finance — GL / statements" },
        { value: "payroll", label: "HR — Payroll" },
        { value: "hiring", label: "HR — Hiring / CVs" },
        { value: "contracts", label: "Legal — Contracts / NDAs" },
        { value: "po", label: "Procurement — PO / RFQ" },
        { value: "qc", label: "Compliance — QC / inspection" },
        { value: "capa", label: "Compliance — CAPA / NCR" },
        { value: "maintenance", label: "Maintenance — Work orders" },
    ],
    help: "Pick the business stream — routes to the right AI agent (Finance AP vs Compliance QC, etc.).",
};

const COMMON_TAIL: IntegrationField[] = [SCHEDULE_FIELD, USE_CASE_FIELD, AGENT_FIELD, OUTBOUND_FIELD];

/** ERP / middleware connectors — no scheduled pull in Visibility today */
const PUSH_ONLY_TAIL: IntegrationField[] = [USE_CASE_FIELD, AGENT_FIELD, OUTBOUND_FIELD];

/** Default agent when user leaves “Default AI agent” on Auto-detect. */
export const CATEGORY_DEFAULT_AGENT: Record<IntegrationCategory, string> = {
    file_cloud: "other_agent",
    erp: "finance_agent",
    mes: "compliance_agent",
    quality: "compliance_agent",
    maintenance: "compliance_agent",
    generic: "other_agent",
};

export const USE_CASE_DEFAULT_AGENT: Record<string, string> = {
    ap: "finance_agent",
    ar: "finance_agent",
    gl: "finance_agent",
    payroll: "hr_agent",
    hiring: "hr_agent",
    contracts: "legal_agent",
    po: "procurement_agent",
    qc: "compliance_agent",
    capa: "compliance_agent",
    maintenance: "compliance_agent",
};

export const CATEGORY_DEFAULT_USE_CASE: Partial<Record<IntegrationCategory, string>> = {
    erp: "ap",
    quality: "qc",
    maintenance: "maintenance",
    mes: "qc",
};

export function getRecommendedAgentForIntegration(
    item: IntegrationCatalogItem,
    useCase?: string | null
): string {
    const uc = String(useCase || "").trim();
    if (uc && USE_CASE_DEFAULT_AGENT[uc]) return USE_CASE_DEFAULT_AGENT[uc];
    return CATEGORY_DEFAULT_AGENT[item.category] || "other_agent";
}

export function getRecommendedUseCaseForCategory(category: IntegrationCategory): string {
    return CATEGORY_DEFAULT_USE_CASE[category] || "";
}

export function supportsMultiConnection(_providerId: string): boolean {
    return true;
}

export function getAgentChatPath(agentId?: string | null): string {
    const agent = String(agentId || "").trim();
    if (!agent) return "/chat?new=1";
    return `/chat?agent=${encodeURIComponent(agent)}&new=1`;
}

function guide(software: string, whereKeys: string, mapHint: string, verifyHint: string): string[] {
    return [
        whereKeys,
        `Paste the required credentials and connection details into the Connect form on this page.`,
        `Set Use case (AP, QC, Hiring, …) and Default AI agent — e.g. SAP AP → Finance, MasterControl CAPA → Compliance.`,
        `Each connection gets a unique push URL + API key. Your ${software} export job or middleware POSTs PDFs/CSV there (multipart file or JSON fileUrl).`,
        `Set sync interval (suggested: every 15 minutes for production docs, or end-of-shift for batch reports).`,
        mapHint,
        `Optionally add an Outbound results webhook URL so AI summaries, extracted fields, and status can be sent back to ${software} or your middleware.`,
        `Click Save connection, then Test connection to validate required fields.`,
        verifyHint,
        `Open the matching agent chat (Finance, Compliance, HR, …) with document scope All to analyze ingested files.`,
        `After go-live, monitor last sync status on this card and check Activity for ingest events.`,
    ];
}

/** ERP / middleware — push ingest only (no scheduled pull from Visibility). */
function erpGuide(software: string, credHint: string, pushHint: string, verifyHint: string): string[] {
    return [
        credHint,
        `Set Use case (AP, AR, PO, …) and Default AI agent so files route to Finance, Procurement, or Compliance.`,
        `Save the connection, then copy the per-connection push URL + ingest key from the Status tab.`,
        pushHint,
        `Configure ${software} (or CPI / Power Automate / custom middleware) to POST invoice PDFs to that URL with the key.`,
        `Optional: add an Outbound webhook URL — after AI extraction, use Send from Documents to POST JSON back to ${software}.`,
        `Run Test connection — validates ${software} credentials when API access is configured.`,
        verifyHint,
        `Monitor Connected systems on the agent workspace and Activity for ingest events.`,
    ];
}

const outboundNote = (system: string) =>
    `Bidirectional: inbound pulls documents into Visibility Docs; outbound can POST JSON summaries (documentId, filename, status, extracted fields, AI summary) to your webhook so ${system} or middleware can update tickets, quality records, or dashboards.`;

const erpOutboundNote = (system: string) =>
    `Push ingest today: ${system} or your middleware POSTs files to the unique push URL + key. Visibility extracts and charts them. Optional outbound webhook receives AI summaries when you click Send — not automatic ledger posting.`;

/**
 * Curated catalog — factory / enterprise connectors.
 * Live inbound push (multipart + JSON fileUrl) works for every connection via unique push URL + key.
 * Live pull sync today: google_drive, clickup (list sync + webhook). Others: push from middleware/ETL.
 */
export const INTEGRATION_CATALOG: IntegrationCatalogItem[] = [
    // —— File & Cloud ——
    {
        id: "google_drive",
        name: "Google Drive",
        category: "file_cloud",
        description: "Pull files from a shared Google Drive folder — manual check or auto sync on interval/daily.",
        directions: "both",
        fields: [
            { key: "serviceAccountEmail", label: "Service account email", type: "text", required: true },
            {
                key: "privateKey",
                label: "Service account private key (JSON or PEM)",
                type: "password",
                required: true,
                secret: true,
            },
            {
                key: "folderId",
                label: "Folder ID or Drive URL",
                type: "text",
                required: true,
                placeholder: "1AbC… or https://drive.google.com/drive/folders/…",
                help: "Paste the folder ID or the full sharing link. Share that folder with the service-account email as Editor (needed for Send uploads).",
            },
            {
                key: "syncMode",
                label: "Sync mode",
                type: "select",
                required: true,
                options: [
                    { value: "interval", label: "Every N minutes — ask before upload (or enable auto)" },
                    { value: "daily", label: "Once daily — auto upload in background" },
                    { value: "manual", label: "Manual only — click to sync" },
                ],
                help: "Daily uploads in the backend even if you are offline. Interval finds files then asks you (unless auto-upload is on).",
            },
            {
                key: "intervalMinutes",
                label: "Interval (minutes)",
                type: "number",
                placeholder: "15",
                help: "Used when sync mode is “every N minutes”. Min 5, max 1440.",
            },
            {
                key: "dailyAt",
                label: "Daily time (HH:MM)",
                type: "text",
                placeholder: "09:00",
                help: "Used when sync mode is “once daily”. Server local time. Failures show as a notification when you log in.",
            },
            {
                key: "intervalAutoUpload",
                label: "Interval auto-upload (skip confirm)",
                type: "select",
                options: [
                    { value: "false", label: "No — show confirm dialog each interval" },
                    { value: "true", label: "Yes — upload automatically each interval" },
                ],
                help: "Only for interval mode. You can also turn this on from the confirm dialog.",
            },
            {
                key: "autoSyncEnabled",
                label: "Auto sync enabled",
                type: "select",
                options: [
                    { value: "true", label: "Yes — run on schedule" },
                    { value: "false", label: "No — pause auto sync" },
                ],
            },
            AGENT_FIELD,
            OUTBOUND_FIELD,
        ],
        guideSteps: [
            "In Google Cloud Console create a service account, enable Drive API, download the JSON key, and share the Drive folder with the service account email as Editor (required for Send uploads).",
            "Paste folderId from the Drive URL, choose sync mode (interval / daily / manual), and pick the default AI agent.",
            "Optionally set Outbound webhook URL — Send is always manual (document details or Status → Send from library).",
            "After connect: Status → Check Drive files to import. Use Send to push original / AI summary / extracted JSON into the same linked Drive folder and/or your webhook.",
        ],
        setupNotes: outboundNote("Apps Script / Cloud Function"),
    },
    {
        id: "sharepoint",
        name: "SharePoint",
        category: "file_cloud",
        description: "Sync document libraries from Microsoft SharePoint Online or Server.",
        directions: "both",
        fields: [
            { key: "tenantId", label: "Azure Tenant ID", type: "text", required: true },
            { key: "clientId", label: "App (client) ID", type: "text", required: true },
            { key: "clientSecret", label: "Client secret", type: "password", required: true, secret: true },
            {
                key: "siteUrl",
                label: "Site URL",
                type: "url",
                required: true,
                placeholder: "https://contoso.sharepoint.com/sites/Quality",
            },
            {
                key: "libraryPath",
                label: "Document library / folder",
                type: "text",
                required: true,
                placeholder: "Shared Documents/Incoming",
            },
            ...COMMON_TAIL,
        ],
        guideSteps: guide(
            "SharePoint",
            "In Azure Portal → App registrations, create an app, grant Sites.Read.All (and Sites.ReadWrite.All if pushing results), then create a client secret.",
            "Point libraryPath at the folder that receives factory exports; choose the matching AI agent.",
            "Upload a test file to that SharePoint folder and confirm it lands in Documents after the next sync window."
        ),
        setupNotes: outboundNote("SharePoint (via Graph webhook/middleware)"),
    },
    {
        id: "onedrive",
        name: "OneDrive",
        category: "file_cloud",
        description: "Connect a OneDrive for Business folder used by plant admins.",
        directions: "both",
        fields: [
            { key: "tenantId", label: "Azure Tenant ID", type: "text", required: true },
            { key: "clientId", label: "App (client) ID", type: "text", required: true },
            { key: "clientSecret", label: "Client secret", type: "password", required: true, secret: true },
            {
                key: "drivePath",
                label: "Folder path",
                type: "text",
                required: true,
                placeholder: "/Visibility/Inbox",
            },
            ...COMMON_TAIL,
        ],
        guideSteps: guide(
            "OneDrive",
            "Register an Azure AD app with Files.Read.All (and Files.ReadWrite.All for outbound), generate a client secret.",
            "Set drivePath to the inbox folder used by your team.",
            "Place a sample file in OneDrive and verify it appears in Documents."
        ),
        setupNotes: outboundNote("OneDrive / Power Automate"),
    },
    {
        id: "shared_folder_sftp",
        name: "Shared Folder / SFTP",
        category: "file_cloud",
        description: "Watch a network share or SFTP folder for PDFs, Excel, images, and drop them into Documents.",
        directions: "both",
        fields: [
            { key: "host", label: "Host / server", type: "text", required: true, placeholder: "files.factory.local" },
            { key: "port", label: "Port", type: "number", placeholder: "22" },
            { key: "username", label: "Username", type: "text", required: true },
            {
                key: "password",
                label: "Password / private key passphrase",
                type: "password",
                required: true,
                secret: true,
            },
            {
                key: "remotePath",
                label: "Remote folder path",
                type: "text",
                required: true,
                placeholder: "/QC/Reports",
            },
            {
                key: "protocol",
                label: "Protocol",
                type: "select",
                required: true,
                options: [
                    { value: "sftp", label: "SFTP" },
                    { value: "smb", label: "SMB / Windows share" },
                    { value: "ftp", label: "FTP" },
                ],
            },
            ...COMMON_TAIL,
        ],
        guideSteps: guide(
            "Shared Folder / SFTP",
            "Ask IT for SFTP or SMB access to the folder where factory software exports reports (e.g. \\\\server\\QC\\Reports or /exports/daily).",
            "Map the folder to a default AI agent (Compliance for QC, Finance for invoices).",
            "Drop a sample PDF into the folder (or wait for the next export), then confirm it appears under Documents with source Shared Folder."
        ),
        setupNotes: outboundNote("your factory middleware"),
    },
    {
        id: "email_inbox",
        name: "Email Inbox",
        category: "file_cloud",
        description: "Ingest email attachments (invoices, QC reports) from a dedicated mailbox.",
        directions: "both",
        fields: [
            {
                key: "imapHost",
                label: "IMAP host",
                type: "text",
                required: true,
                placeholder: "outlook.office365.com",
            },
            { key: "imapPort", label: "IMAP port", type: "number", placeholder: "993" },
            { key: "username", label: "Mailbox address", type: "text", required: true },
            {
                key: "password",
                label: "App password / IMAP password",
                type: "password",
                required: true,
                secret: true,
            },
            { key: "folder", label: "Folder", type: "text", placeholder: "INBOX" },
            ...COMMON_TAIL,
        ],
        guideSteps: guide(
            "Email Inbox",
            "Create a dedicated mailbox (e.g. docs-ingest@factory.com) and enable IMAP / app password (OAuth recommended for M365).",
            "Forward or CC vendor/plant emails that carry PDF/Excel attachments to this mailbox.",
            "Send yourself a test email with a PDF attachment and confirm it appears in Documents."
        ),
        setupNotes: outboundNote("reply email or SMTP notification"),
    },

    // —— ERP ——
    {
        id: "dynamics365",
        name: "Microsoft Dynamics 365",
        category: "erp",
        description:
            "Store Dynamics credentials + routing. Documents ingest via push URL (middleware/CPI) — OAuth test validates Azure app access.",
        directions: "both",
        fields: [
            { key: "tenantId", label: "Azure Tenant ID", type: "text", required: true },
            { key: "clientId", label: "App (client) ID", type: "text", required: true },
            { key: "clientSecret", label: "Client secret", type: "password", required: true, secret: true },
            { key: "environmentUrl", label: "Environment URL", type: "url", required: true },
            {
                key: "entityPath",
                label: "Entity / company path",
                type: "text",
                placeholder: "companies(...)/purchaseInvoices",
            },
            ...PUSH_ONLY_TAIL,
        ],
        guideSteps: erpGuide(
            "Dynamics 365",
            "Register an Azure AD app, grant Dynamics/Business Central API permissions, and create a client secret.",
            "Use Power Automate or an export job to POST purchase invoice PDFs to your push URL.",
            "POST a sample invoice PDF, then confirm it appears under Documents and Finance → Connected systems."
        ),
        setupNotes: erpOutboundNote("Dynamics 365 / Dataverse"),
    },
    {
        id: "sap",
        name: "SAP (S/4HANA / Business One)",
        category: "erp",
        description:
            "Store SAP credentials + routing. Documents ingest via push URL from CPI, IDoc wrapper, or scheduled export — Test validates Service Layer / OData reachability.",
        directions: "both",
        fields: [
            { key: "baseUrl", label: "SAP API / Service Layer base URL", type: "url", required: true },
            { key: "companyDb", label: "Company DB / Client", type: "text", required: true },
            { key: "username", label: "Username", type: "text", required: true },
            { key: "password", label: "Password", type: "password", required: true, secret: true },
            {
                key: "exportPath",
                label: "Export path or OData entity",
                type: "text",
                placeholder: "Attachments2 or /export/pdf",
            },
            ...PUSH_ONLY_TAIL,
        ],
        guideSteps: erpGuide(
            "SAP",
            "Work with SAP Basis to enable Service Layer (B1) or OData (S/4). Create a technical user with read access.",
            "Prefer CPI or a nightly PDF export job that POSTs to your push URL. Shared Folder is an alternative if exports land on disk.",
            "Trigger one invoice export to the push URL and verify Documents + Finance workspace."
        ),
        setupNotes: erpOutboundNote("SAP"),
    },
    {
        id: "odoo",
        name: "Odoo",
        category: "erp",
        description:
            "Store Odoo credentials + routing. Documents ingest via push URL — Test validates JSON-RPC login.",
        directions: "both",
        fields: [
            { key: "baseUrl", label: "Odoo base URL", type: "url", required: true },
            { key: "database", label: "Database name", type: "text", required: true },
            { key: "username", label: "Username", type: "text", required: true },
            { key: "apiKey", label: "API key / password", type: "password", required: true, secret: true },
            ...PUSH_ONLY_TAIL,
        ],
        guideSteps: erpGuide(
            "Odoo",
            "In Odoo, create an API key for a technical user with attachment read access.",
            "Use an Odoo automated action or external script to POST accounting PDFs to your push URL.",
            "Attach a sample invoice PDF via push and confirm Documents + agent workspace."
        ),
        setupNotes: erpOutboundNote("Odoo"),
    },

    // —— MES ——
    {
        id: "ignition",
        name: "Ignition (Inductive Automation)",
        category: "mes",
        description: "MES/SCADA reports and PDF exports from Ignition Perspective / Reporting module.",
        directions: "both",
        fields: [
            { key: "baseUrl", label: "Ignition Gateway URL", type: "url", required: true },
            { key: "username", label: "API username", type: "text", required: true },
            { key: "password", label: "Password", type: "password", required: true, secret: true },
            {
                key: "reportPath",
                label: "Report / tag path",
                type: "text",
                placeholder: "Reports/ShiftSummary",
            },
            ...COMMON_TAIL,
        ],
        guideSteps: guide(
            "Ignition",
            "Enable WebDev or Reporting HTTP endpoints; create a gateway user for report download. Or schedule Ignition to write PDFs to a shared folder and use Shared Folder + this card for metadata.",
            "Enter Gateway URL and report path; map Compliance/Other agent as needed.",
            "Generate a shift report PDF and verify Documents."
        ),
        setupNotes: outboundNote("Ignition WebDev / MQTT bridge"),
    },

    // —— Quality ——
    {
        id: "mastercontrol",
        name: "MasterControl",
        category: "quality",
        description: "QMS controlled documents, CAPA, and training records.",
        directions: "both",
        fields: [
            { key: "baseUrl", label: "MasterControl URL", type: "url", required: true },
            { key: "username", label: "Username", type: "text", required: true },
            {
                key: "password",
                label: "Password / API token",
                type: "password",
                required: true,
                secret: true,
            },
            { key: "vaultPath", label: "Vault / collection", type: "text" },
            ...COMMON_TAIL,
        ],
        guideSteps: guide(
            "MasterControl",
            "Request API or export credentials from your QMS admin for the vault that holds SOPs and audit packs.",
            "Set Compliance as the default AI agent.",
            "Publish/export one controlled document and verify Documents."
        ),
        setupNotes: outboundNote("MasterControl workflow hooks"),
    },

    // —— Maintenance ——
    {
        id: "fiix_upkeep",
        name: "Fiix / UpKeep",
        category: "maintenance",
        description: "CMMS work-order photos and PDF checklists.",
        directions: "both",
        fields: [
            { key: "baseUrl", label: "API base URL", type: "url", required: true },
            { key: "apiKey", label: "API key", type: "password", required: true, secret: true },
            {
                key: "provider",
                label: "CMMS product",
                type: "select",
                required: true,
                options: [
                    { value: "fiix", label: "Fiix" },
                    { value: "upkeep", label: "UpKeep" },
                ],
            },
            ...COMMON_TAIL,
        ],
        guideSteps: guide(
            "Fiix / UpKeep",
            "In CMMS settings generate an API key with attachment read permissions.",
            "Select Fiix or UpKeep and set sync interval for closed work orders.",
            "Close a work order with an attachment and verify Documents."
        ),
        setupNotes: outboundNote("CMMS webhook / Zapier"),
    },

    // —— Generic (always useful) ——
    {
        id: "clickup",
        name: "ClickUp",
        category: "generic",
        description:
            "Connect ClickUp lists — webhooks pull task attachments into Visibility; agents analyze in chat. One connection per list + default agent.",
        directions: "both",
        fields: [
            {
                key: "label",
                label: "Connection label",
                type: "text",
                required: true,
                placeholder: "ClickUp Finance AP",
            },
            {
                key: "apiToken",
                label: "ClickUp API token",
                type: "password",
                required: true,
                secret: true,
                placeholder: "pk_…",
                help: "ClickUp → Settings → Apps → API Token. Stored encrypted server-side.",
            },
            {
                key: "listId",
                label: "ClickUp List ID",
                type: "text",
                required: true,
                placeholder: "901234567890",
                help: "Do not paste the workspace ID (first number in browser URL) or slug (e.g. 2kzmz6c0-318). After saving, use Browse lists in Edit to pick the correct numeric API list ID.",
            },
            AGENT_FIELD,
            OUTBOUND_FIELD,
        ],
        guideSteps: [
            "Create one connection per ClickUp list (Finance AP, HR hiring, Legal contracts, …).",
            "Set Default AI agent so attachments route to Finance / HR / Legal automatically.",
            "Save → Status tab → copy the ClickUp webhook URL (includes secret key).",
            "In ClickUp: Settings → Integrations → Webhooks → paste URL → subscribe to taskUpdated (and taskCreated if you want).",
            "Add an attachment to a task in that list — Visibility ingests it within seconds.",
            "Optional: click Run test, then Sync now on Status to pull all existing attachments from the list.",
            "Open the matching agent chat (Finance, HR, …) with document scope All — ask totals, summaries, charts.",
        ],
        setupNotes:
            "Live today: ClickUp webhook → auto-ingest attachments + manual list sync. Chat analytics use extracted document data. Outbound: Send from library posts summaries to your webhook.",
    },
    {
        id: "slack",
        name: "Slack",
        category: "generic",
        description:
            "Same universal task flow as ClickUp — connect a bot + channel; Sync now / Events webhook pulls messages as synced tasks; agents create, assign, and complete from chat.",
        directions: "both",
        fields: [
            {
                key: "label",
                label: "Connection label",
                type: "text",
                required: true,
                placeholder: "Slack HR hiring",
            },
            {
                key: "botToken",
                label: "Slack Bot User OAuth Token (xoxb-…)",
                type: "password",
                required: true,
                secret: true,
                placeholder: "xoxb-…",
                help: "Must start with xoxb-. api.slack.com → Your App → OAuth & Permissions → Bot User OAuth Token. Do NOT use App-Level Token (xapp-).",
            },
            {
                key: "channelId",
                label: "Slack Channel ID (C…)",
                type: "text",
                required: true,
                placeholder: "C0123456789",
                help: "Must be a Channel ID starting with C… (channel details → bottom). Do NOT use a DM (D…) or a DM URL. You can also paste a Slack channel URL. Invite the bot with /invite @YourBot first.",
            },
            AGENT_FIELD,
            OUTBOUND_FIELD,
        ],
        guideSteps: [
            "Create a Slack app at api.slack.com → Add Bot Token Scopes: channels:history, channels:read, chat:write, users:read, users:read.email, reactions:write, groups:history (private).",
            "Install to workspace → copy Bot User OAuth Token (xoxb-…).",
            "Invite the bot to your channel (/invite @Bot).",
            "In Visibility: Admin → Integrations → add Slack → paste token + Channel ID + default agent → Save.",
            "Status tab → copy Slack Events webhook URL → Slack app → Event Subscriptions → Request URL → subscribe to message.channels (and message.groups if private).",
            "Click Sync now to pull recent channel messages as synced tasks — then in any agent chat: show synced tasks / create task / assign / process open tasks.",
        ],
        setupNotes:
            "Native Slack connector (no Zapier). Uses the same universal synced-task chat + playbook as ClickUp.",
    },
    {
        id: "custom_webhook",
        name: "Custom Webhook / REST API",
        category: "generic",
        description:
            "Universal inbound HTTP — choose how your system authenticates (API key, Bearer, Basic, custom header). One connection per external system.",
        directions: "both",
        fields: [
            {
                key: "label",
                label: "Connection label",
                type: "text",
                required: true,
                placeholder: "SAP AP — Plant 1",
            },
            {
                key: "ingestAuthMode",
                label: "Inbound auth method",
                type: "select",
                options: [
                    { value: "integration_key", label: "API key header — X-Integration-Key (default)" },
                    { value: "bearer_token", label: "Bearer token — Authorization: Bearer …" },
                    { value: "basic_auth", label: "Basic auth — username + password" },
                    { value: "custom_header", label: "Custom header — you choose name + secret" },
                    { value: "query_key", label: "Query string only — ?key= on URL" },
                ],
                help: "How your ERP, middleware, or webhook sender proves identity when POSTing files.",
            },
            {
                key: "ingestBearerToken",
                label: "Bearer token (optional)",
                type: "password",
                secret: true,
                placeholder: "Leave blank to use ingest API key as Bearer token",
                help: "Your middleware sends Authorization: Bearer <this token>. Rotate from Status tab anytime.",
            },
            {
                key: "ingestBasicUsername",
                label: "Basic auth username",
                type: "text",
                placeholder: "integration_user",
            },
            {
                key: "ingestBasicPassword",
                label: "Basic auth password",
                type: "password",
                secret: true,
            },
            {
                key: "ingestCustomHeaderName",
                label: "Custom header name",
                type: "text",
                placeholder: "X-Api-Key",
                help: "Header your system sends, e.g. X-Secret-Token or X-Api-Key",
            },
            {
                key: "ingestCustomHeaderValue",
                label: "Custom header secret",
                type: "password",
                secret: true,
            },
            USE_CASE_FIELD,
            AGENT_FIELD,
            OUTBOUND_FIELD,
        ],
        guideSteps: [
            "Create one connection per external system (SAP AP, HR ATS, Legal CLM, …).",
            "Open Edit → pick Inbound auth method (API key, Bearer, Basic, custom header, or query key).",
            "Set Use case + Default AI agent so files route to Finance, HR, Procurement, etc.",
            "Save → Status tab → copy push URL and credential examples for your auth method.",
            "POST a file (multipart) or JSON fileUrl from your middleware — Visibility validates the auth you configured.",
            "Optional outbound webhook: receive AI summaries when you click Send from Documents.",
            "Rotate ingest key from Status anytime; update your middleware if you use the default API key.",
        ],
        setupNotes:
            "Like Claude connectors: pick the auth style your system already uses. Visibility accepts API key header, Bearer token, Basic auth, custom header, or URL query key on the same push endpoint.",
    },
    {
        id: "sql_csv_drop",
        name: "SQL Export / CSV Drop",
        category: "generic",
        description: "Scheduled DB export or CSV/Excel drop from legacy factory databases.",
        directions: "both",
        fields: [
            {
                key: "connectionString",
                label: "Read-only DB connection string (optional)",
                type: "password",
                secret: true,
            },
            {
                key: "queryOrView",
                label: "SQL view / query name",
                type: "text",
                placeholder: "dbo.v_daily_qc_export",
            },
            {
                key: "dropFolder",
                label: "CSV/Excel drop folder path",
                type: "text",
                placeholder: "\\\\server\\exports\\csv",
            },
            {
                key: "filePattern",
                label: "File name pattern",
                type: "text",
                placeholder: "qc_*.csv",
            },
            ...COMMON_TAIL,
        ],
        guideSteps: guide(
            "SQL Export / CSV Drop",
            "Prefer a read-only DB user or a nightly job that writes CSV/Excel into a drop folder (safer than live SQL from the app).",
            "Fill either connectionString + queryOrView, or dropFolder + filePattern (or both).",
            "Run the export job once and verify the CSV/Excel appears in Documents for AI analysis."
        ),
        setupNotes: outboundNote("your ETL / SSIS package"),
    },
];

export function getIntegrationById(id: string): IntegrationCatalogItem | undefined {
    return INTEGRATION_CATALOG.find((i) => i.id === id);
}

export function catalogProviderIds(): string[] {
    return INTEGRATION_CATALOG.map((i) => i.id);
}
