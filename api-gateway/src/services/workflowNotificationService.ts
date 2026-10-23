import axios from 'axios';
import { getOrgWorkflowSettings } from './orgWorkflowSettingsService';
import { sendHtmlEmail, isEmailConfigured } from './emailService';
import logger from '../utils/logger';

export type WorkflowAlertPayload = {
    documentId: string;
    filename: string;
    agentId: string;
    workflowType: string;
    stage: string;
    verdict: string;
    details?: Record<string, unknown>;
};

const AGENT_LABELS: Record<string, string> = {
    finance_agent: 'Finance Agent',
    compliance_agent: 'Compliance Agent',
    hr_agent: 'HR Agent',
    legal_agent: 'Legal Agent',
    procurement_agent: 'Procurement Agent',
    other_agent: 'General Agent',
};

const STAGE_EMOJIS: Record<string, string> = {
    auto_approved: '⚡',
    pending_approval: '⏳',
    shortlisted: '🌟',
    flagged: '🚨',
    completed: '✅',
};

export async function dispatchWorkflowAlert(
    organizationId: string,
    alert: WorkflowAlertPayload
): Promise<void> {
    if (!organizationId) return;

    try {
        const settings = await getOrgWorkflowSettings(organizationId);
        const agentName = AGENT_LABELS[alert.agentId] || alert.agentId;
        const emoji = STAGE_EMOJIS[alert.stage] || '🤖';

        // 1. Slack Outbound Alert
        if (settings.slackWebhookUrl) {
            try {
                const slackPayload = {
                    text: `${emoji} *[Visibility AI]* ${alert.verdict} (${alert.filename})`,
                    blocks: [
                        {
                            type: 'header',
                            text: {
                                type: 'plain_text',
                                text: `${emoji} Autonomous Agent Workflow Alert`,
                                emoji: true,
                            },
                        },
                        {
                            type: 'section',
                            fields: [
                                {
                                    type: 'mrkdwn',
                                    text: `*Document:*\n${alert.filename}`,
                                },
                                {
                                    type: 'mrkdwn',
                                    text: `*Agent:*\n${agentName}`,
                                },
                                {
                                    type: 'mrkdwn',
                                    text: `*Status:*\n\`${alert.stage.toUpperCase()}\``,
                                },
                                {
                                    type: 'mrkdwn',
                                    text: `*Workflow:*\n${alert.workflowType}`,
                                },
                            ],
                        },
                        {
                            type: 'section',
                            text: {
                                type: 'mrkdwn',
                                text: `*Verdict:*\n${alert.verdict}`,
                            },
                        },
                        {
                            type: 'context',
                            elements: [
                                {
                                    type: 'mrkdwn',
                                    text: `Document ID: \`${alert.documentId}\` · Executed at: ${new Date().toISOString()}`,
                                },
                            ],
                        },
                    ],
                };

                await axios.post(settings.slackWebhookUrl, slackPayload, { timeout: 10000 });
                logger.info(`[WorkflowNotification] Slack alert sent for ${alert.documentId} to webhook`);
            } catch (slackErr: any) {
                logger.warn(`[WorkflowNotification] Failed to send Slack alert for ${alert.documentId}: ${slackErr?.message || slackErr}`);
            }
        }

        // 2. Email Outbound Alert
        if (settings.alertEmail && isEmailConfigured()) {
            try {
                const subject = `[Visibility AI] ${emoji} ${alert.verdict.slice(0, 80)}`;
                const html = `
                <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #e5e7eb; rounded: 8px;">
                    <div style="background-color: #0f172a; padding: 16px; border-radius: 6px; margin-bottom: 20px;">
                        <h2 style="color: #ffffff; margin: 0; font-size: 18px;">${emoji} Autonomous Agent Workflow Decision</h2>
                    </div>
                    <div style="margin-bottom: 16px; padding: 12px; background-color: #f8fafc; border-left: 4px solid #3b82f6; border-radius: 4px;">
                        <p style="margin: 0; font-size: 15px; font-weight: 600; color: #1e293b;">${alert.verdict}</p>
                    </div>
                    <table style="width: 100%; border-collapse: collapse; margin-bottom: 20px;">
                        <tr>
                            <td style="padding: 8px 0; color: #64748b; font-size: 14px; width: 140px;">Document:</td>
                            <td style="padding: 8px 0; color: #0f172a; font-size: 14px; font-weight: 500;">${alert.filename}</td>
                        </tr>
                        <tr>
                            <td style="padding: 8px 0; color: #64748b; font-size: 14px;">Agent:</td>
                            <td style="padding: 8px 0; color: #0f172a; font-size: 14px;">${agentName}</td>
                        </tr>
                        <tr>
                            <td style="padding: 8px 0; color: #64748b; font-size: 14px;">Workflow:</td>
                            <td style="padding: 8px 0; color: #0f172a; font-size: 14px;">${alert.workflowType}</td>
                        </tr>
                        <tr>
                            <td style="padding: 8px 0; color: #64748b; font-size: 14px;">Stage:</td>
                            <td style="padding: 8px 0; color: #0f172a; font-size: 14px;"><strong style="text-transform: uppercase;">${alert.stage}</strong></td>
                        </tr>
                        <tr>
                            <td style="padding: 8px 0; color: #64748b; font-size: 14px;">Document ID:</td>
                            <td style="padding: 8px 0; color: #64748b; font-size: 12px; font-family: monospace;">${alert.documentId}</td>
                        </tr>
                    </table>
                    <div style="border-top: 1px solid #e5e7eb; padding-top: 16px; font-size: 12px; color: #94a3b8; text-align: center;">
                        Sent automatically by Visibility Docs AI Autonomous Workflow Engine.
                    </div>
                </div>
                `;

                await sendHtmlEmail({
                    to: settings.alertEmail,
                    subject,
                    html,
                });
                logger.info(`[WorkflowNotification] Email alert sent for ${alert.documentId} to ${settings.alertEmail}`);
            } catch (emailErr: any) {
                logger.warn(`[WorkflowNotification] Failed to send email alert for ${alert.documentId}: ${emailErr?.message || emailErr}`);
            }
        }
    } catch (err: any) {
        logger.error(`[WorkflowNotification] Error in dispatchWorkflowAlert: ${err?.message || err}`);
    }
}
