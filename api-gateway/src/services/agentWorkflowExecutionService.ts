import Document, { IDocument } from '../models/Document';
import { getAiDocument, isAiServiceEnabled } from './aiServiceClient';
import { resolveCanonicalAgent } from './documentStorage';
import { getOrgWorkflowSettings, OrgWorkflowSettings } from './orgWorkflowSettingsService';
import { dispatchWorkflowAlert } from './workflowNotificationService';
import logger from '../utils/logger';

export type WorkflowStage =
    | 'auto_approved'
    | 'pending_approval'
    | 'shortlisted'
    | 'flagged'
    | 'completed'
    | 'failed';

export type WorkflowExecutionResult = {
    documentId: string;
    agentId: string;
    workflowType: string;
    stage: WorkflowStage;
    verdict: string;
    actionsTaken: string[];
    details: Record<string, unknown>;
    executedAt: string;
};

const AUTO_APPROVE_THRESHOLD_USD = 1000;

function parseDateSafe(val: unknown): Date | null {
    if (!val) return null;
    const d = new Date(String(val));
    return isNaN(d.getTime()) ? null : d;
}

function parseNumberSafe(val: unknown): number {
    if (typeof val === 'number') return val;
    if (!val) return 0;
    const clean = String(val).replace(/[^0-9.-]/g, '');
    const num = parseFloat(clean);
    return isNaN(num) ? 0 : num;
}

/**
 * Execute automated domain workflow for a newly ready document based on its assigned agent.
 */
export async function runAgentDocumentWorkflow(
    doc: IDocument,
    orgId: string
): Promise<WorkflowExecutionResult | null> {
    try {
        const agentId = (doc.metadata?.phase3Agent as string) || resolveCanonicalAgent(doc);
        const classification = String(doc.classification || '').toLowerCase();
        const now = new Date().toISOString();

        let aiDoc: Record<string, unknown> | null = null;
        if (isAiServiceEnabled() && doc.pythonDocumentId) {
            const aiOrgId = orgId || (doc.organizationId as string) || '';
            aiDoc = await getAiDocument(doc.pythonDocumentId, aiOrgId);
        }

        const rawData = (aiDoc?.extracted_data || doc.metadata?.extracted_data || {}) as Record<string, unknown>;
        const effectiveOrgId = orgId || (doc.organizationId as string) || '';
        const settings = await getOrgWorkflowSettings(effectiveOrgId);

        let result: WorkflowExecutionResult;

        switch (agentId) {
            case 'finance_agent': {
                result = await executeFinanceWorkflow(doc, rawData, effectiveOrgId, settings);
                break;
            }
            case 'compliance_agent': {
                result = await executeComplianceWorkflow(doc, rawData, settings);
                break;
            }
            case 'hr_agent': {
                result = await executeHrWorkflow(doc, rawData, settings);
                break;
            }
            case 'legal_agent': {
                result = await executeLegalWorkflow(doc, rawData);
                break;
            }
            case 'procurement_agent': {
                result = await executeProcurementWorkflow(doc, rawData, effectiveOrgId);
                break;
            }
            default: {
                result = {
                    documentId: doc.documentId,
                    agentId: agentId || 'other_agent',
                    workflowType: 'general_indexing',
                    stage: 'completed',
                    verdict: '📄 Document classified and indexed into knowledge vault',
                    actionsTaken: ['indexed_content', 'rag_embedded'],
                    details: { classification },
                    executedAt: now,
                };
                break;
            }
        }

        doc.metadata = {
            ...(doc.metadata || {}),
            workflowExecution: result,
        };
        doc.markModified('metadata');
        await doc.save();

        logger.info(`[AgentWorkflow] Executed ${agentId} workflow for ${doc.documentId} -> ${result.stage} (${result.verdict})`);

        // Dispatch asynchronous outbound Slack and/or Email notification
        void dispatchWorkflowAlert(effectiveOrgId, {
            documentId: doc.documentId,
            filename: doc.originalFilename,
            agentId,
            workflowType: result.workflowType,
            stage: result.stage,
            verdict: result.verdict,
            details: result.details,
        });

        return result;
    } catch (err: any) {
        logger.error(`[AgentWorkflow] Error executing workflow for ${doc.documentId}: ${err?.message || err}`);
        return null;
    }
}

async function executeFinanceWorkflow(
    doc: IDocument,
    data: Record<string, unknown>,
    orgId: string,
    settings?: OrgWorkflowSettings
): Promise<WorkflowExecutionResult> {
    const now = new Date().toISOString();
    const invoiceNumber = String(data.invoice_number || data.invoiceNumber || '').trim();
    const totalAmount = parseNumberSafe(data.total_amount || data.totalAmount || data.amount || data.total);
    const currency = String(data.currency || 'USD').toUpperCase();
    const poNumber = String(data.po_number || data.poNumber || data.purchase_order_number || '').trim();
    const vendor = String(data.vendor_name || data.vendor || '').trim();
    const actionsTaken: string[] = ['extracted_financial_fields'];

    const autoApprovalLimit =
        typeof settings?.autoApprovalThreshold === 'number'
            ? settings.autoApprovalThreshold
            : AUTO_APPROVE_THRESHOLD_USD;
    const duplicateCheck = settings?.duplicateCheckEnabled !== false;
    const requirePo = settings?.requirePoMatchForAutoApproval !== false;

    // 1. Duplicate check within organization
    let duplicateDocId: string | null = null;
    if (duplicateCheck && invoiceNumber && orgId) {
        const existing = await Document.findOne({
            organizationId: orgId,
            documentId: { $ne: doc.documentId },
            $or: [
                { 'metadata.extracted_data.invoice_number': invoiceNumber },
                { 'metadata.workflowExecution.details.invoiceNumber': invoiceNumber },
            ],
        }).lean();
        if (existing) {
            duplicateDocId = existing.documentId;
        }
    }

    if (duplicateDocId) {
        actionsTaken.push('flagged_duplicate');
        return {
            documentId: doc.documentId,
            agentId: 'finance_agent',
            workflowType: 'invoice_verification',
            stage: 'flagged',
            verdict: `⚠️ Potential Duplicate Invoice: Matches invoice #${invoiceNumber} in document ${duplicateDocId}`,
            actionsTaken,
            details: { invoiceNumber, totalAmount, currency, vendor, duplicateDocId },
            executedAt: now,
        };
    }

    // 2. Check for PO Match
    let matchedPoDocId: string | null = null;
    if (poNumber && orgId) {
        const poDoc = await Document.findOne({
            organizationId: orgId,
            documentId: { $ne: doc.documentId },
            classification: { $in: ['purchase_order', 'po'] },
            $or: [
                { 'metadata.extracted_data.po_number': poNumber },
                { 'metadata.workflowExecution.details.poNumber': poNumber },
                { originalFilename: new RegExp(poNumber, 'i') },
            ],
        }).lean();
        if (poDoc) {
            matchedPoDocId = poDoc.documentId;
            actionsTaken.push(`matched_po:${poNumber}`);
        }
    }

    // 3. Auto-Approval evaluation
    const poSatisfied = requirePo ? Boolean(matchedPoDocId) : true;
    if (poSatisfied && totalAmount > 0 && totalAmount <= autoApprovalLimit) {
        actionsTaken.push('auto_approved_within_threshold');
        return {
            documentId: doc.documentId,
            agentId: 'finance_agent',
            workflowType: 'invoice_approval',
            stage: 'auto_approved',
            verdict: `⚡ Auto-Approved: ${matchedPoDocId ? `Matched PO #${poNumber} ` : ''}under $${autoApprovalLimit.toLocaleString()} limit (${currency} ${totalAmount.toLocaleString()})`,
            actionsTaken,
            details: { invoiceNumber, totalAmount, currency, poNumber, matchedPoDocId, vendor, autoApprovalLimit },
            executedAt: now,
        };
    }

    if (totalAmount > autoApprovalLimit) {
        actionsTaken.push('routed_to_manager_approval');
        return {
            documentId: doc.documentId,
            agentId: 'finance_agent',
            workflowType: 'invoice_approval',
            stage: 'pending_approval',
            verdict: `⏳ High-Value Invoice: Routed to Manager Approval Queue (${currency} ${totalAmount.toLocaleString()} > $${autoApprovalLimit.toLocaleString()})`,
            actionsTaken,
            details: { invoiceNumber, totalAmount, currency, poNumber, matchedPoDocId, vendor, autoApprovalLimit },
            executedAt: now,
        };
    }

    // No PO number provided
    actionsTaken.push('queued_for_ap_review');
    return {
        documentId: doc.documentId,
        agentId: 'finance_agent',
        workflowType: 'invoice_verification',
        stage: 'pending_approval',
        verdict: `📋 Unpaired Invoice: Missing Purchase Order reference (${currency} ${totalAmount.toLocaleString()})`,
        actionsTaken,
        details: { invoiceNumber, totalAmount, currency, vendor },
        executedAt: now,
    };
}

async function executeComplianceWorkflow(
    doc: IDocument,
    data: Record<string, unknown>,
    settings?: OrgWorkflowSettings
): Promise<WorkflowExecutionResult> {
    const now = new Date();
    const expiryRaw = data.expiry_date || data.expiration_date || data.valid_until;
    const expiryDate = parseDateSafe(expiryRaw);
    const standard = String(data.standard || data.regulation || data.standardOrRegulation || data.certificate_type || '').trim();
    const actionsTaken: string[] = ['extracted_compliance_metadata'];

    const criticalDays = typeof settings?.criticalExpiryDays === 'number' ? settings.criticalExpiryDays : 30;
    const warningDays = typeof settings?.warningExpiryDays === 'number' ? settings.warningExpiryDays : 90;

    // Check expiry
    if (expiryDate) {
        const msPerDay = 1000 * 60 * 60 * 24;
        const daysLeft = Math.round((expiryDate.getTime() - now.getTime()) / msPerDay);

        if (daysLeft < 0) {
            actionsTaken.push('flagged_expired');
            return {
                documentId: doc.documentId,
                agentId: 'compliance_agent',
                workflowType: 'expiry_tracking',
                stage: 'flagged',
                verdict: `🚨 Expired Certificate: Expired ${Math.abs(daysLeft)} days ago (${expiryDate.toISOString().slice(0, 10)})`,
                actionsTaken,
                details: { expiryDate: expiryDate.toISOString(), daysLeft, standard },
                executedAt: now.toISOString(),
            };
        }

        if (daysLeft <= criticalDays) {
            actionsTaken.push('flagged_critical_expiry');
            return {
                documentId: doc.documentId,
                agentId: 'compliance_agent',
                workflowType: 'expiry_tracking',
                stage: 'flagged',
                verdict: `⚠️ Critical Expiry Alert: Certificate expires in ${daysLeft} days (${expiryDate.toISOString().slice(0, 10)})`,
                actionsTaken,
                details: { expiryDate: expiryDate.toISOString(), daysLeft, standard, criticalDays },
                executedAt: now.toISOString(),
            };
        }

        if (daysLeft <= warningDays) {
            actionsTaken.push('flagged_warning_expiry');
            return {
                documentId: doc.documentId,
                agentId: 'compliance_agent',
                workflowType: 'expiry_tracking',
                stage: 'flagged',
                verdict: `ℹ️ Renewal Notice: Certificate expires in ${daysLeft} days (${expiryDate.toISOString().slice(0, 10)})`,
                actionsTaken,
                details: { expiryDate: expiryDate.toISOString(), daysLeft, standard, warningDays },
                executedAt: now.toISOString(),
            };
        }

        actionsTaken.push('verified_active_status');
        return {
            documentId: doc.documentId,
            agentId: 'compliance_agent',
            workflowType: 'certificate_monitoring',
            stage: 'completed',
            verdict: `✅ Valid Compliance Certificate: Active for ${daysLeft} days (${standard || 'Compliance Standard'})`,
            actionsTaken,
            details: { expiryDate: expiryDate.toISOString(), daysLeft, standard },
            executedAt: now.toISOString(),
        };
    }

    // Findings check
    const findings = Array.isArray(data.audit_findings || data.findings) ? (data.audit_findings || data.findings) as any[] : [];
    const hasFailures = findings.some((f) => /fail|major|non-conformance|critical/i.test(String(f.severity || f.status || f.description || '')));
    if (hasFailures) {
        actionsTaken.push('auto_generated_ncr_flag');
        return {
            documentId: doc.documentId,
            agentId: 'compliance_agent',
            workflowType: 'audit_findings_analysis',
            stage: 'flagged',
            verdict: `⚠️ Audit Deficiencies Detected: NCR / CAPA required for ${findings.length} findings`,
            actionsTaken,
            details: { findingsCount: findings.length },
            executedAt: now.toISOString(),
        };
    }

    actionsTaken.push('compliance_baseline_verified');
    return {
        documentId: doc.documentId,
        agentId: 'compliance_agent',
        workflowType: 'compliance_assessment',
        stage: 'completed',
        verdict: `✅ Compliance Document Verified: Compliant posture`,
        actionsTaken,
        details: { standard },
        executedAt: now.toISOString(),
    };
}

async function executeHrWorkflow(
    doc: IDocument,
    data: Record<string, unknown>,
    settings?: OrgWorkflowSettings
): Promise<WorkflowExecutionResult> {
    const now = new Date().toISOString();
    const candidateName = String(data.candidate_name || data.name || data.candidateName || '').trim();
    const score = parseNumberSafe(doc.metadata?.cvScore || data.cv_score || data.overall_score || data.score);
    const minShortlistScore = typeof settings?.autoShortlistMinScore === 'number' ? settings.autoShortlistMinScore : 75;
    const actionsTaken: string[] = ['parsed_hr_profile'];

    if (score >= minShortlistScore) {
        actionsTaken.push('auto_shortlisted_candidate');
        return {
            documentId: doc.documentId,
            agentId: 'hr_agent',
            workflowType: 'candidate_screening',
            stage: 'shortlisted',
            verdict: `🌟 Auto-Shortlisted: High-fit candidate ${candidateName ? `(${candidateName})` : ''} score ${score}/100`,
            actionsTaken,
            details: { candidateName, score, minShortlistScore },
            executedAt: now,
        };
    }

    if (score > 0) {
        actionsTaken.push('indexed_in_talent_pool');
        return {
            documentId: doc.documentId,
            agentId: 'hr_agent',
            workflowType: 'candidate_screening',
            stage: 'completed',
            verdict: `📋 Candidate Profile Evaluated: Score ${score}/100 in talent repository`,
            actionsTaken,
            details: { candidateName, score },
            executedAt: now,
        };
    }

    actionsTaken.push('indexed_hr_document');
    return {
        documentId: doc.documentId,
        agentId: 'hr_agent',
        workflowType: 'workforce_document',
        stage: 'completed',
        verdict: `✅ HR Document Processed and Indexed`,
        actionsTaken,
        details: {},
        executedAt: now,
    };
}

async function executeLegalWorkflow(
    doc: IDocument,
    data: Record<string, unknown>
): Promise<WorkflowExecutionResult> {
    const now = new Date().toISOString();
    const parties = data.parties || data.contract_parties;
    const actionsTaken: string[] = ['extracted_contract_clauses'];

    // Scan text or data for high risk keywords
    const textToScan = JSON.stringify(data).toLowerCase();
    const hasUnlimitedLiability = /unlimited\s+liability|no\s+cap\s+on\s+liability/i.test(textToScan);
    const hasBroadIndemnity = /indemnify.*against\s+all.*damages/i.test(textToScan);

    if (hasUnlimitedLiability || hasBroadIndemnity) {
        actionsTaken.push('flagged_high_risk_clause');
        return {
            documentId: doc.documentId,
            agentId: 'legal_agent',
            workflowType: 'contract_risk_analysis',
            stage: 'flagged',
            verdict: `⚠️ Legal Risk Alert: Non-standard high-risk indemnity / liability terms detected`,
            actionsTaken,
            details: { hasUnlimitedLiability, hasBroadIndemnity, parties },
            executedAt: now,
        };
    }

    actionsTaken.push('contract_clauses_approved');
    return {
        documentId: doc.documentId,
        agentId: 'legal_agent',
        workflowType: 'contract_risk_analysis',
        stage: 'completed',
        verdict: `✅ Contract Terms Verified: Standard legal provisions confirmed`,
        actionsTaken,
        details: { parties },
        executedAt: now,
    };
}

async function executeProcurementWorkflow(
    doc: IDocument,
    data: Record<string, unknown>,
    orgId: string
): Promise<WorkflowExecutionResult> {
    const now = new Date().toISOString();
    const poNumber = String(data.po_number || data.poNumber || '').trim();
    const totalAmount = parseNumberSafe(data.total_amount || data.totalAmount || data.amount);
    const actionsTaken: string[] = ['indexed_purchase_order'];

    // Check if there are existing un-matched invoices waiting for this PO
    let matchedInvoiceId: string | null = null;
    if (poNumber && orgId) {
        const invoiceDoc = await Document.findOne({
            organizationId: orgId,
            documentId: { $ne: doc.documentId },
            classification: { $in: ['invoice', 'receipt'] },
            $or: [
                { 'metadata.extracted_data.po_number': poNumber },
                { 'metadata.workflowExecution.details.poNumber': poNumber },
            ],
        }).lean();
        if (invoiceDoc) {
            matchedInvoiceId = invoiceDoc.documentId;
            actionsTaken.push(`paired_with_invoice:${matchedInvoiceId}`);
        }
    }

    if (matchedInvoiceId) {
        return {
            documentId: doc.documentId,
            agentId: 'procurement_agent',
            workflowType: 'po_verification',
            stage: 'completed',
            verdict: `⚡ Auto-Matched: Purchase Order #${poNumber} linked to pending invoice ${matchedInvoiceId}`,
            actionsTaken,
            details: { poNumber, totalAmount, matchedInvoiceId },
            executedAt: now,
        };
    }

    return {
        documentId: doc.documentId,
        agentId: 'procurement_agent',
        workflowType: 'po_verification',
        stage: 'completed',
        verdict: `📦 Purchase Order #${poNumber || 'Record'} Indexed & Ready for Inbound Matching`,
        actionsTaken,
        details: { poNumber, totalAmount },
        executedAt: now,
    };
}

/**
 * Aggregates organization-wide automated agent workflow statistics and recent verdicts.
 */
export async function getOrgWorkflowSummary(organizationId: string) {
    const docs = await Document.find({
        organizationId,
        'metadata.workflowExecution': { $exists: true },
    })
        .select('documentId originalFilename classification metadata updatedAt')
        .sort({ updatedAt: -1 })
        .limit(100)
        .lean();

    let autoApprovedInvoices = 0;
    let pendingApprovals = 0;
    let expiringCertificates = 0;
    let shortlistedCandidates = 0;
    let flaggedRisks = 0;

    const recentExecutions: Array<{
        documentId: string;
        filename: string;
        agentId: string;
        workflowType: string;
        stage: string;
        verdict: string;
        executedAt: string;
    }> = [];

    for (const doc of docs) {
        const wf = doc.metadata?.workflowExecution as WorkflowExecutionResult | undefined;
        if (!wf) continue;

        if (wf.stage === 'auto_approved') autoApprovedInvoices += 1;
        if (wf.stage === 'pending_approval') pendingApprovals += 1;
        if (wf.stage === 'flagged' && wf.agentId === 'compliance_agent') expiringCertificates += 1;
        if (wf.stage === 'shortlisted') shortlistedCandidates += 1;
        if (wf.stage === 'flagged' && (wf.agentId === 'legal_agent' || wf.agentId === 'finance_agent')) flaggedRisks += 1;

        if (recentExecutions.length < 15) {
            recentExecutions.push({
                documentId: doc.documentId,
                filename: doc.originalFilename,
                agentId: wf.agentId,
                workflowType: wf.workflowType,
                stage: wf.stage,
                verdict: wf.verdict,
                executedAt: wf.executedAt,
            });
        }
    }

    return {
        totalExecuted: docs.length,
        autoApprovedInvoices,
        pendingApprovals,
        expiringCertificates,
        shortlistedCandidates,
        flaggedRisks,
        recentExecutions,
    };
}
