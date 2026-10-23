/**
 * Universal structured record ingest — Path 2 for all integrations.
 * Stores JSON records directly (no OCR) while file ingest remains separate.
 */
import fs from 'fs';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import type { Request } from 'express';
import type { IIntegrationConnection } from '../models/IntegrationConnection';
import Document from '../models/Document';
import {
    DOC_TYPE_TO_AGENT,
    ensureUploadDir,
    getDocumentDir,
    normalizeDocumentType,
    resolveOrgFolder,
} from './documentStorage';
import { recordActivity } from './activityLog';
import {
    assertIngestOrgAllowed,
    resolveIngestAdminUser,
    resolveIngestEntitlementAgents,
    resolveIngestPhase3Agent,
} from './integrationIngestService';

export type StructuredRecordInput = {
    recordType: string;
    data: Record<string, unknown>;
    externalId?: string;
    title?: string;
    phase3Agent?: string;
    externalRef?: Record<string, unknown>;
};

export type StructuredRecordIngestResult = {
    documentId: string;
    title: string;
    recordType: string;
    status: string;
    providerId: string;
    ingestMode: 'structured_record';
    updated: boolean;
};

const RECORD_TYPE_TO_CLASSIFICATION: Record<string, string> = {
    // HR
    candidate: 'employee_record',
    employee: 'employee_record',
    resume: 'resume',
    payroll: 'payroll',
    leave: 'leave_application',
    attendance: 'attendance',
    performance: 'performance_review',
    // Finance
    invoice: 'invoice',
    expense: 'expense_report',
    payment: 'payment_receipt',
    tax: 'tax_document',
    bank_statement: 'bank_statement',
    budget: 'budget',
    finance_report: 'finance_report',
    // Procurement
    purchase_order: 'purchase_order',
    po: 'purchase_order',
    quotation: 'quotation',
    rfq: 'rfq',
    supplier: 'vendor_list',
    delivery_note: 'delivery_note',
    procurement_request: 'procurement_request',
    // Compliance
    certificate: 'certificate',
    compliance: 'compliance_form',
    audit: 'audit_report',
    inspection: 'inspection_report',
    capa: 'capa_letter',
    sop: 'sop',
    iso: 'iso_document',
    // Legal
    contract: 'contract',
    nda: 'nda',
    agreement: 'agreement',
    lease: 'lease_agreement',
    vendor_contract: 'vendor_contract',
    // Generic / PM
    task: 'integration_record',
    generic: 'integration_record',
};

function resolvePhase3AgentForStructuredRecord(
    connection: IIntegrationConnection,
    input: StructuredRecordInput,
    classification: string,
    allowedAgents: string[]
): string | undefined {
    if (input.phase3Agent) {
        return resolveIngestPhase3Agent(connection, input.phase3Agent, allowedAgents);
    }
    const fromClassification = DOC_TYPE_TO_AGENT[classification];
    if (fromClassification && fromClassification !== 'other_agent') {
        const resolved = resolveIngestPhase3Agent(connection, fromClassification, allowedAgents);
        if (resolved) return resolved;
    }
    return resolveIngestPhase3Agent(connection, undefined, allowedAgents);
}

function normalizeRecordType(raw: string): string {
    return String(raw || 'generic')
        .trim()
        .toLowerCase()
        .replace(/[\s-]+/g, '_');
}

function resolveClassification(recordType: string): string {
    const key = normalizeRecordType(recordType);
    return normalizeDocumentType(RECORD_TYPE_TO_CLASSIFICATION[key] || 'integration_record');
}

function resolveRecordTitle(input: StructuredRecordInput): string {
    if (input.title?.trim()) return input.title.trim();
    const d = input.data;
    const candidates = [
        d.title,
        d.name,
        d.candidateName,
        d.full_name,
        d.fullName,
        d.invoice_number,
        d.invoiceNumber,
        d.po_number,
        d.poNumber,
        d.id,
        d.externalId,
    ];
    for (const c of candidates) {
        const s = String(c || '').trim();
        if (s) return s.slice(0, 200);
    }
    return `${normalizeRecordType(input.recordType)} record`;
}

function resolveExternalRecordId(input: StructuredRecordInput): string {
    const fromInput = String(input.externalId || '').trim();
    if (fromInput) return fromInput;
    const d = input.data;
    const candidates = [d.externalId, d.id, d.recordId, d.taskId, d.invoiceId, d.poId];
    for (const c of candidates) {
        const s = String(c || '').trim();
        if (s) return s;
    }
    return uuidv4();
}

/** Map common HR / finance fields from structured payloads into document metadata. */
function enrichMetadataFromStructuredData(
    recordType: string,
    data: Record<string, unknown>
): Record<string, unknown> {
    const meta: Record<string, unknown> = {};
    const type = normalizeRecordType(recordType);

    const email =
        data.email ??
        data.candidateEmail ??
        data.candidate_email ??
        data['Email'] ??
        data['Candidate Email'];
    if (email != null && String(email).trim()) {
        meta.candidateEmail = String(email).trim();
        meta.outreachEmail = String(email).trim();
    }

    const scoreRaw =
        data.cvScore ?? data.cv_score ?? data.score ?? data['CV Score'] ?? data['cv score'];
    const score = Number(scoreRaw);
    if (Number.isFinite(score) && score > 0) {
        meta.cvScore = score;
    }

    if (type === 'candidate' || type === 'employee' || type === 'resume' || type === 'payroll' || type === 'leave' || type === 'attendance' || type === 'performance') {
        meta.structuredHrRecord = true;
    }
    if (
        type === 'invoice' ||
        type === 'expense' ||
        type === 'payment' ||
        type === 'tax' ||
        type === 'bank_statement' ||
        type === 'budget' ||
        type === 'finance_report'
    ) {
        meta.structuredFinanceRecord = true;
    }
    if (type === 'certificate' || type === 'audit' || type === 'inspection' || type === 'capa' || type === 'compliance' || type === 'sop' || type === 'iso') {
        meta.structuredComplianceRecord = true;
    }
    if (type === 'contract' || type === 'nda' || type === 'agreement' || type === 'lease' || type === 'vendor_contract') {
        meta.structuredLegalRecord = true;
    }
    if (
        type === 'purchase_order' ||
        type === 'quotation' ||
        type === 'rfq' ||
        type === 'supplier' ||
        type === 'delivery_note' ||
        type === 'procurement_request' ||
        type === 'po'
    ) {
        meta.structuredProcurementRecord = true;
    }
    if (type === 'task' || type === 'generic') {
        meta.structuredOtherRecord = true;
    }

    return meta;
}

async function findExistingStructuredRecord(
    organizationId: string,
    connectionId: string,
    recordId: string
) {
    const clickupTaskId = String(recordId || '')
        .replace(/^clickup:task:/i, '')
        .trim();

    return Document.findOne({
        organizationId,
        'metadata.integrationConnectionId': connectionId,
        'metadata.ingestKind': 'structured_record',
        $or: [
            { 'metadata.integrationExternalRef.recordId': recordId },
            ...(clickupTaskId
                ? [
                      { 'metadata.integrationExternalRef.clickupTaskId': clickupTaskId },
                      { 'metadata.integrationExternalRef.recordId': `clickup:task:${clickupTaskId}` },
                  ]
                : []),
        ],
    });
}

export async function ingestStructuredRecordForConnection(opts: {
    connection: IIntegrationConnection;
    input: StructuredRecordInput;
    ingestMode?: 'structured_record' | 'provider_sync';
}): Promise<StructuredRecordIngestResult> {
    const { connection, input } = opts;
    const recordType = normalizeRecordType(input.recordType);
    if (!recordType) {
        throw Object.assign(new Error('recordType is required'), { statusCode: 400 });
    }
    if (!input.data || typeof input.data !== 'object' || Array.isArray(input.data)) {
        throw Object.assign(new Error('data must be a JSON object'), { statusCode: 400 });
    }

    const classification = resolveClassification(recordType);

    await assertIngestOrgAllowed(connection.organizationId);
    const allowedAgents = await resolveIngestEntitlementAgents(connection.organizationId);
    const adminUser = await resolveIngestAdminUser(connection);
    if (!adminUser) {
        throw Object.assign(new Error('No active admin user for organization'), { statusCode: 500 });
    }

    const phase3Agent = resolvePhase3AgentForStructuredRecord(
        connection,
        input,
        classification,
        allowedAgents
    );
    if (input.phase3Agent && !phase3Agent) {
        throw Object.assign(
            new Error('phase3Agent is not enabled on this organization plan'),
            { statusCode: 403, code: 'AGENT_NOT_ALLOWED' }
        );
    }

    const recordId = resolveExternalRecordId(input);
    const title = resolveRecordTitle(input);
    const enriched = enrichMetadataFromStructuredData(recordType, input.data);

    const existing = await findExistingStructuredRecord(
        connection.organizationId,
        connection.connectionId,
        recordId
    );

    const externalRef = {
        recordId,
        recordType,
        ...(input.externalRef || {}),
    };

    const payloadJson = JSON.stringify(
        {
            recordType,
            title,
            data: input.data,
            providerId: connection.providerId,
            connectionId: connection.connectionId,
            externalRef,
            ingestedAt: new Date().toISOString(),
        },
        null,
        2
    );

    if (existing) {
        existing.metadata = {
            ...(existing.metadata || {}),
            source: connection.providerId,
            integrationConnectionId: connection.connectionId,
            integrationLabel: connection.label,
            ingestKind: 'structured_record',
            recordType,
            structuredData: input.data,
            structuredRecordUpdatedAt: new Date().toISOString(),
            integrationExternalRef: externalRef,
            phase3Agent: phase3Agent || (existing.metadata as { phase3Agent?: string })?.phase3Agent,
            ...enriched,
        };
        existing.classification = classification;
        existing.status = 'ready';
        existing.aiProcessingStatus = 'structured_record';
        await existing.save();

        const storagePath = existing.storagePath;
        if (storagePath && fs.existsSync(storagePath)) {
            fs.writeFileSync(storagePath, payloadJson, 'utf8');
        }

        connection.lastSyncAt = new Date();
        connection.lastStatus = 'record_updated';
        await connection.save();

        return {
            documentId: existing.documentId,
            title: existing.originalFilename,
            recordType,
            status: existing.status,
            providerId: connection.providerId,
            ingestMode: 'structured_record',
            updated: true,
        };
    }

    ensureUploadDir();
    const documentId = uuidv4();
    const orgFolder = resolveOrgFolder(connection.organizationId, adminUser.userId);
    const docDir = getDocumentDir(orgFolder, documentId, {
        documentType: classification,
        createdAt: new Date(),
    });
    fs.mkdirSync(docDir, { recursive: true });

    const storedFilename = `${documentId}.json`;
    const storagePath = path.join(docDir, storedFilename);
    fs.writeFileSync(storagePath, payloadJson, 'utf8');

    const doc = await Document.create({
        documentId,
        organizationId: connection.organizationId,
        uploadedBy: adminUser.userId,
        originalFilename: `${title}.json`,
        storedFilename,
        mimeType: 'application/json',
        sizeBytes: Buffer.byteLength(payloadJson, 'utf8'),
        storagePath,
        status: 'ready',
        classification,
        visibilityScope: 'personal',
        aiProcessingStatus: 'structured_record',
        metadata: {
            source: connection.providerId,
            integrationConnectionId: connection.connectionId,
            integrationLabel: connection.label,
            ingestKind: 'structured_record',
            ingestMode: opts.ingestMode || 'structured_record',
            recordType,
            structuredData: input.data,
            structuredRecordCreatedAt: new Date().toISOString(),
            integrationExternalRef: externalRef,
            phase3Agent,
            ...enriched,
        },
    });

    connection.lastSyncAt = new Date();
    connection.lastStatus = 'record_ingest_ok';
    await connection.save();

    recordActivity({
        organizationId: connection.organizationId,
        actorUserId: adminUser.userId,
        actorEmail: adminUser.email,
        actorRole: adminUser.role,
        action: 'integrations.record_ingest',
        category: 'document',
        resourceType: 'document',
        resourceId: doc.documentId,
        message: `Structured record (${connection.providerId}/${recordType}): ${title}`,
        metadata: {
            providerId: connection.providerId,
            connectionId: connection.connectionId,
            recordType,
            externalId: recordId,
        },
    });

    return {
        documentId: doc.documentId,
        title: doc.originalFilename,
        recordType,
        status: doc.status,
        providerId: connection.providerId,
        ingestMode: 'structured_record',
        updated: false,
    };
}

export function parseStructuredRecordFromBody(body: unknown): StructuredRecordInput | null {
    if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
    const b = body as Record<string, unknown>;
    const recordType = String(b.recordType || b.record_type || '').trim();
    const data = b.data;
    if (!recordType || !data || typeof data !== 'object' || Array.isArray(data)) return null;

    const externalRefRaw = b.externalRef || b.external_ref;
    const externalRef =
        externalRefRaw && typeof externalRefRaw === 'object' && !Array.isArray(externalRefRaw)
            ? (externalRefRaw as Record<string, unknown>)
            : undefined;

    return {
        recordType,
        data: data as Record<string, unknown>,
        externalId: String(b.externalId || b.external_id || '').trim() || undefined,
        title: String(b.title || b.name || '').trim() || undefined,
        phase3Agent: String(b.phase3Agent || b.phase3_agent || '').trim() || undefined,
        externalRef,
    };
}

/** Normalize ClickUp task API payload into universal structured record. */
export function clickUpTaskToStructuredRecord(task: Record<string, unknown>): StructuredRecordInput {
    const taskId = String(task.id || '').trim();
    const customFields = Array.isArray(task.custom_fields)
        ? (task.custom_fields as Array<Record<string, unknown>>).map((f) => ({
              id: f.id,
              name: f.name,
              type: f.type,
              value: f.value,
          }))
        : [];

    const statusObj = task.status as { status?: string } | undefined;
    const listObj = task.list as { id?: string; name?: string } | undefined;

    const data: Record<string, unknown> = {
        taskId,
        name: task.name,
        description: task.description,
        status: statusObj?.status,
        priority: task.priority,
        due_date: task.due_date,
        start_date: task.start_date,
        date_created: task.date_created,
        date_updated: task.date_updated,
        url: task.url,
        assignees: task.assignees,
        tags: task.tags,
        custom_fields: customFields,
        list: listObj ? { id: listObj.id, name: listObj.name } : undefined,
        attachment_count: Array.isArray(task.attachments) ? task.attachments.length : 0,
    };

    for (const field of customFields) {
        const name = String(field.name || '')
            .trim()
            .toLowerCase()
            .replace(/[\s-]+/g, '_');
        if (name && field.value != null && data[name] == null) {
            data[name] = field.value;
        }
    }

    return {
        recordType: 'task',
        title: String(task.name || `ClickUp task ${taskId}`),
        externalId: taskId ? `clickup:task:${taskId}` : undefined,
        data,
        externalRef: {
            recordId: taskId ? `clickup:task:${taskId}` : undefined,
            clickupTaskId: taskId,
            clickupTaskName: task.name,
            clickupListId: listObj?.id,
            clickupListName: listObj?.name,
        },
    };
}

export async function ingestClickUpTaskRecord(
    connection: IIntegrationConnection,
    task: Record<string, unknown>
) {
    const input = clickUpTaskToStructuredRecord(task);
    return ingestStructuredRecordForConnection({
        connection,
        input,
        ingestMode: 'provider_sync',
    });
}
