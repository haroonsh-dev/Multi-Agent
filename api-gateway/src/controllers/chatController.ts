import { Request, Response, NextFunction } from 'express';
import Document from '../models/Document';
import ApiKey, { AIProvider } from '../models/ApiKey';
import Organization from '../models/Organization';
import { buildDocumentFilter, hasPermission } from '../services/accessScope';
import {
    appendChatExchange,
    chatWithAi,
    deleteChatSession,
    ensureDocumentsInAi,
    extractGroqLimitError,
    formatAiError,
    getChatSession,
    isAiServiceEnabled,
    listChatSessions,
    renameChatSession,
    resolveAiOrganizationId,
    syncProviderToAIBackend,
    type AiProviderConfig,
} from '../services/aiServiceClient';
import { PERMISSIONS } from '../types/permissions';
import logger from '../utils/logger';
import { getCapabilityReply, isCapabilityQuestion } from '../utils/chatCapability';
import { recordActivityFromReq } from '../services/activityLog';
import { DOC_TYPE_TO_AGENT, resolveCanonicalAgent } from '../services/documentStorage';
import { requireAllowedAgent } from '../services/planService';
import { tryHrDynamicAgent } from '../services/hrIntentRouter';
import { tryHrChatCommand } from '../services/hrChatActionService';
import { tryHrExtendedChatCommand } from '../services/hrChatReportService';
import { tryComplianceDynamicAgent } from '../services/complianceIntentRouter';
import { tryComplianceReportCommand } from '../services/complianceChatActionService';
import { tryFinanceReportCommand } from '../services/financeChatActionService';
import { tryFinanceDynamicAgent } from '../services/financeIntentRouter';
import { tryLegalDynamicAgent } from '../services/legalIntentRouter';
import { tryProcurementDynamicAgent } from '../services/procurementIntentRouter';
import { tryOtherDynamicAgent } from '../services/otherIntentRouter';
import { tryIntegrationTaskCommand } from '../services/integrationTaskChatService';
import { tryIntegrationTaskPlaybookCommand } from '../services/integrationTaskPlaybookService';
import { tryStructuredRecordCommand } from '../services/structuredRecordChatService';
import { getAgentAnalyticsDashboard, tryAgentChatVisual } from '../services/agentChatVisualService';
import { filterDocumentIdsForAgent } from '../services/dynamicAnalyticsEngine';
import { wantsPortfolioFinanceScope } from '../services/financeIntent';
import { wantsFinanceListAllScope } from '../services/financeQuestionNormalize';
import { FINANCE_AGENT, resolveFinancePortfolioDocumentIds } from '../services/financeAnalyticsService';
import { resolveVectorOrganizationId } from '../services/vectorOrgId';
import {
    clearSessionFocusDocumentIds,
    getSessionFocusDocumentIds,
    hydrateSessionFocus,
    setSessionFocusDocumentIds,
} from '../services/chatFocusStore';

async function resolveChatProviderConfig(
    organizationId: string,
    provider?: string,
    model?: string,
): Promise<AiProviderConfig | null> {
    const filter: { isActive: boolean; organizationId?: string; provider?: AIProvider } = {
        isActive: true,
    };
    if (organizationId) filter.organizationId = organizationId;

    if (provider) {
        filter.provider = provider as AIProvider;
        const key = await ApiKey.findOne(filter).lean();
        if (key?.apiKey) {
            return {
                provider: key.provider,
                apiKey: key.apiKey,
                model: model || key.aiModel || '',
                baseUrl: key.baseUrl || null,
            };
        }
    } else {
        const keys = await ApiKey.find(filter).sort({ createdAt: 1 }).lean();
        const primary = keys.find((k) => k.provider === 'groq') || keys[0];
        if (primary?.apiKey) {
            return {
                provider: primary.provider,
                apiKey: primary.apiKey,
                model: model || primary.aiModel || '',
                baseUrl: primary.baseUrl || null,
            };
        }
    }

    // Fallback 1: Check Organization.groqApiKey for this organization
    if (organizationId) {
        const org = await Organization.findOne({ organizationId }).lean();
        if (org?.groqApiKey) {
            return {
                provider: 'groq',
                apiKey: org.groqApiKey,
                model: model || 'llama-3.3-70b-versatile',
                baseUrl: 'https://api.groq.com/openai/v1',
            };
        }
    }

    // Fallback 2: Check global active key in ApiKey collection
    const globalKey = await ApiKey.findOne({
        isActive: true,
        ...(provider ? { provider: provider as AIProvider } : {}),
    }).sort({ createdAt: 1 }).lean();

    if (globalKey?.apiKey) {
        return {
            provider: globalKey.provider,
            apiKey: globalKey.apiKey,
            model: model || globalKey.aiModel || '',
            baseUrl: globalKey.baseUrl || null,
        };
    }

    return null;
}

export const chatWithDocuments = async (req: Request, res: Response, next: NextFunction) => {
    try {
        if (!hasPermission(req.user, PERMISSIONS.CHAT_USE)) {
            return res.status(403).json({ success: false, message: 'Forbidden' });
        }

        const message = (req.body.message || req.body.query || req.body.question || '').toString().trim();
        const documentIds: string[] = Array.isArray(req.body.documentIds) ? req.body.documentIds : [];
        const chatScope = (req.body.chatScope || 'all').toString() as 'all' | 'selected';
        const sessionId = req.body.sessionId as string | undefined;

        if (!message) {
            return res.status(400).json({ success: false, message: 'message is required' });
        }

        const phase3AgentEarly =
            (req.body.phase3_agent || req.body.phase3Agent || '').toString().trim() || undefined;

        if (isCapabilityQuestion(message)) {
            return res.json({
                success: true,
                data: {
                    reply: getCapabilityReply(phase3AgentEarly),
                    citations: [],
                    sessionId,
                    chatScope,
                    model: 'capability-help',
                    agentId: phase3AgentEarly || undefined,
                },
            });
        }

        const isChitchat = (() => {
            const q = message.toLowerCase();
            if (!q || q.length > 80) return false;
            if (isCapabilityQuestion(message)) return true;
            const docHints = [
                'resume', 'cv', 'invoice', 'document', 'file', 'score', 'candidate',
                'pdf', 'contract', 'find', 'show', 'list', 'who', 'what is', 'kitne',
                'kitna', 'batao', 'tell me', 'search', 'summar', 'extract',
            ];
            if (docHints.some((h) => q.includes(h))) return false;
            return /^(hi|hii+|hello|hey|hy|helo|hola|salam|assalam|aoa|slm|good\s*(morning|afternoon|evening|night)|gm|gn|how are you|how's it going|how r u|whats? up|sup|thanks?|thank you|thx|ty|shukriya|ok|okay|k|cool|great|nice|bye|goodbye|yes|no|yep|yup|nope|yeah|help|who are you|what can you do|what you can do)\b/i.test(
                q
            );
        })();

        if (chatScope === 'selected' && !documentIds.length && !isChitchat) {
            return res.status(400).json({
                success: false,
                message: 'Select at least one document for selected chat scope',
            });
        }

        // Chitchat: skip Mongo document scan — greetings do not need library context.
        let docs: any[] = [];
        if (!isChitchat) {
            const filter = await buildDocumentFilter(req.user, {});
            docs = await Document.find(filter).sort({ createdAt: -1 }).limit(100).lean();
        }

        if (!docs.length && !isChitchat) {
            return res.json({
                success: true,
                data: {
                    reply: "I don't see any documents in your library yet. Upload a PDF or image on the Documents page, then ask again.",
                    citations: [],
                    model: 'docs-ai',
                },
            });
        }

        if (!isAiServiceEnabled()) {
            if (isChitchat) {
                return res.json({
                    success: true,
                    data: {
                        reply: 'Hello! AI service is offline right now — start it on port 8000, then ask about your documents.',
                        citations: [],
                        model: 'docs-ai-offline',
                    },
                });
            }
            return res.json({
                success: true,
                data: {
                    reply: `AI service is offline. You have **${docs.length}** document(s) in your library. Start the Python AI service on port 8000 and try again.`,
                    citations: docs.slice(0, 3).map((d) => ({
                        documentId: d.documentId,
                        filename: d.originalFilename,
                        status: d.status,
                    })),
                    model: 'docs-ai-offline',
                },
            });
        }

        const pythonIdToDoc = new Map(
            docs.filter((d) => d.pythonDocumentId).map((d) => [d.pythonDocumentId as string, d])
        );
        const pythonDocumentIds = [...pythonIdToDoc.keys()];

        if (!pythonDocumentIds.length && !isChitchat) {
            return res.json({
                success: true,
                data: {
                    reply: `Your documents are saved but not yet processed by the AI service. Re-upload after starting the AI backend, or wait for processing to complete.`,
                    citations: docs.slice(0, 5).map((d) => ({
                        documentId: d.documentId,
                        filename: d.originalFilename,
                        status: d.status,
                        pythonDocumentId: d.pythonDocumentId,
                    })),
                    model: 'docs-ai-pending',
                },
            });
        }

        try {
            const orgId = resolveAiOrganizationId(req.user);
            let vectorOrgId = orgId;
            let scopedPythonIds: string[] | undefined;

            const phase3AgentRaw = (req.body.phase3_agent || req.body.phase3Agent || '').toString().trim() || undefined;
            const documentType = (req.body.document_type || req.body.documentType || '').toString().trim() || undefined;
            const provider = (req.body.provider || req.body.modelProvider || '').toString().trim() || undefined;
            const model = (req.body.model || req.body.aiModel || '').toString().trim() || undefined;

            let phase3Agent = phase3AgentRaw;
            let allowedAgents: string[] | undefined;
            if (!isChitchat && req.user.role !== 'superAdmin') {
                const check = await requireAllowedAgent(req.user, phase3AgentRaw);
                if (!check.ok) {
                    return res.status(403).json({
                        success: false,
                        code: check.code,
                        message: check.message,
                        data: { allowedAgents: check.entitlement.agentIds },
                    });
                }
                allowedAgents = check.entitlement.agentIds;
            }

            const orgIdEarly = resolveAiOrganizationId(req.user);
            if (!isChitchat && isAiServiceEnabled()) {
                const scopedAnalyticsDocIdsRaw =
                    chatScope === 'selected' && documentIds.length
                        ? documentIds
                        : Array.isArray(req.body.analyticsDocumentIds)
                          ? (req.body.analyticsDocumentIds as string[]).filter(Boolean)
                          : undefined;

                const portfolioAsk =
                    wantsPortfolioFinanceScope(message) || wantsFinanceListAllScope(message);
                let scopedAnalyticsDocIds =
                    portfolioAsk && (phase3Agent === FINANCE_AGENT || !phase3Agent)
                        ? await resolveFinancePortfolioDocumentIds(req.user, scopedAnalyticsDocIdsRaw)
                        : scopedAnalyticsDocIdsRaw;
                if (phase3Agent) {
                    scopedAnalyticsDocIds = await filterDocumentIdsForAgent(
                        req.user,
                        scopedAnalyticsDocIds,
                        phase3Agent
                    );
                }

                const focusFromClient = Array.isArray(req.body.focusDocumentIds)
                    ? (req.body.focusDocumentIds as string[]).filter(Boolean)
                    : Array.isArray(req.body.focus_document_ids)
                      ? (req.body.focus_document_ids as string[]).filter(Boolean)
                      : [];
                if (portfolioAsk) {
                    await clearSessionFocusDocumentIds(sessionId);
                } else {
                    await hydrateSessionFocus(sessionId);
                }
                const sessionFocus = portfolioAsk
                    ? []
                    : await getSessionFocusDocumentIds(sessionId);
                let focusDocumentIds = (
                    portfolioAsk
                        ? focusFromClient
                        : [...new Set([...focusFromClient, ...sessionFocus])]
                ).slice(0, 5);
                if (phase3Agent && focusDocumentIds.length) {
                    focusDocumentIds =
                        (await filterDocumentIdsForAgent(req.user, focusDocumentIds, phase3Agent)) ||
                        [];
                }

                const integrationPlaybook = await tryIntegrationTaskPlaybookCommand({
                    user: req.user,
                    question: message,
                    phase3Agent,
                    sessionId,
                });
                if (integrationPlaybook.handled && integrationPlaybook.answer) {
                    let persistedSessionId = sessionId;
                    try {
                        const appended = await appendChatExchange({
                            organizationId: orgIdEarly,
                            question: message,
                            answer: integrationPlaybook.answer,
                            sessionId,
                            userId: req.user.userId,
                            sources: (integrationPlaybook.citations || []).map((c) => ({
                                document_id: c.documentId,
                                document_title: c.filename,
                                phase3_agent: c.phase3Agent,
                                document_type: c.documentType,
                            })),
                        });
                        persistedSessionId = appended.session_id || sessionId;
                    } catch (appendErr: unknown) {
                        const err = appendErr as { message?: string };
                        logger.warn(
                            `Integration playbook reply ok but append-exchange failed: ${err?.message || appendErr}`
                        );
                    }
                    const playbookFocus = (integrationPlaybook.citations || [])
                        .map((c) => c.documentId)
                        .filter(Boolean) as string[];
                    if (playbookFocus.length) {
                        setSessionFocusDocumentIds(persistedSessionId, playbookFocus, {
                            organizationId: orgIdEarly,
                            userId: req.user.userId,
                        });
                    }
                    return res.json({
                        success: true,
                        data: {
                            reply: integrationPlaybook.answer,
                            citations: integrationPlaybook.citations || [],
                            sessionId: persistedSessionId,
                            chatScope,
                            model: 'integration-task-playbook',
                            agentId: phase3Agent || 'other_agent',
                            documentCount: (integrationPlaybook.citations || []).length,
                            contentKind: 'record',
                        },
                    });
                }

                const integrationTask = await tryIntegrationTaskCommand({
                    user: req.user,
                    question: message,
                    phase3Agent,
                    focusDocumentIds,
                });
                if (integrationTask.handled && integrationTask.answer) {
                    let persistedSessionId = sessionId;
                    try {
                        const appended = await appendChatExchange({
                            organizationId: orgIdEarly,
                            question: message,
                            answer: integrationTask.answer,
                            sessionId,
                            userId: req.user.userId,
                            sources: (integrationTask.citations || []).map((c) => ({
                                document_id: c.documentId,
                                document_title: c.filename,
                                phase3_agent: c.phase3Agent,
                                document_type: c.documentType,
                            })),
                        });
                        persistedSessionId = appended.session_id || sessionId;
                    } catch (appendErr: unknown) {
                        const err = appendErr as { message?: string };
                        logger.warn(
                            `Integration task reply ok but append-exchange failed: ${err?.message || appendErr}`
                        );
                    }
                    const taskFocus = (integrationTask.citations || [])
                        .map((c) => c.documentId)
                        .filter(Boolean) as string[];
                    if (taskFocus.length) {
                        setSessionFocusDocumentIds(persistedSessionId, taskFocus, {
                            organizationId: orgIdEarly,
                            userId: req.user.userId,
                        });
                    }
                    return res.json({
                        success: true,
                        data: {
                            reply: integrationTask.answer,
                            citations: integrationTask.citations || [],
                            sessionId: persistedSessionId,
                            chatScope,
                            model: 'integration-task-query',
                            agentId: phase3Agent || 'other_agent',
                            documentCount: (integrationTask.citations || []).length,
                            contentKind: 'record',
                        },
                    });
                }

                const structuredRecords = await tryStructuredRecordCommand({
                    user: req.user,
                    question: message,
                    phase3Agent,
                });
                if (structuredRecords.handled && structuredRecords.answer) {
                    let persistedSessionId = sessionId;
                    try {
                        const appended = await appendChatExchange({
                            organizationId: orgIdEarly,
                            question: message,
                            answer: structuredRecords.answer,
                            sessionId,
                            userId: req.user.userId,
                            sources: (structuredRecords.citations || []).map((c) => ({
                                document_id: c.documentId,
                                document_title: c.filename,
                                phase3_agent: c.phase3Agent,
                                document_type: c.documentType,
                            })),
                        });
                        persistedSessionId = appended.session_id || sessionId;
                    } catch (appendErr: unknown) {
                        const err = appendErr as { message?: string };
                        logger.warn(
                            `Structured-record reply ok but append-exchange failed: ${err?.message || appendErr}`
                        );
                    }
                    const recordFocus = (structuredRecords.citations || [])
                        .map((c) => c.documentId)
                        .filter(Boolean) as string[];
                    if (recordFocus.length) {
                        setSessionFocusDocumentIds(persistedSessionId, recordFocus, {
                            organizationId: orgIdEarly,
                            userId: req.user.userId,
                        });
                    }
                    return res.json({
                        success: true,
                        data: {
                            reply: structuredRecords.answer,
                            citations: structuredRecords.citations || [],
                            sessionId: persistedSessionId,
                            chatScope,
                            model: 'integration-record-query',
                            agentId: phase3Agent || 'other_agent',
                            documentCount: (structuredRecords.citations || []).length,
                            contentKind: 'record',
                        },
                    });
                }

                const hrDynamic = await tryHrDynamicAgent({
                    user: req.user,
                    question: message,
                    phase3Agent,
                    documentIds: scopedAnalyticsDocIds,
                    req,
                });
                if (hrDynamic.handled && hrDynamic.answer) {
                    let persistedSessionId = sessionId;
                    try {
                        const appended = await appendChatExchange({
                            organizationId: orgIdEarly,
                            question: message,
                            answer: hrDynamic.answer,
                            sessionId,
                            userId: req.user.userId,
                            sources: (hrDynamic.citations || []).map((c) => ({
                                document_id: c.documentId,
                                document_title: c.filename,
                                score: c.score,
                                phase3_agent: c.phase3Agent,
                                document_type: c.documentType,
                            })),
                        });
                        persistedSessionId = appended.session_id || sessionId;
                    } catch (appendErr: any) {
                        logger.warn(
                            `HR dynamic agent reply ok but append-exchange failed: ${appendErr?.message || appendErr}`
                        );
                    }
                    const hrFocus = [
                        ...new Set([
                            ...(hrDynamic.citations || []).map((c) => c.documentId).filter(Boolean),
                            ...(hrDynamic.visuals || []).flatMap((v) => v.sourceDocumentIds || []),
                        ]),
                    ] as string[];
                    if (hrFocus.length) {
                        setSessionFocusDocumentIds(persistedSessionId, hrFocus, {
                            organizationId: orgIdEarly,
                            userId: req.user.userId,
                        });
                    }
                    return res.json({
                        success: true,
                        data: {
                            reply: hrDynamic.answer,
                            citations: hrDynamic.citations || [],
                            visuals: hrDynamic.visuals || [],
                            sessionId: persistedSessionId,
                            chatScope,
                            model: 'hr-dynamic-agent',
                            agentId: phase3Agent || 'hr_agent',
                            documentCount:
                                new Set(
                                    (hrDynamic.visuals || []).flatMap((v) => v.sourceDocumentIds || [])
                                ).size || (hrDynamic.citations || []).length,
                        },
                    });
                }

                const hrExtended = await tryHrExtendedChatCommand({
                    user: req.user,
                    question: message,
                    phase3Agent,
                    documentIds: scopedAnalyticsDocIds,
                });
                if (hrExtended.handled && hrExtended.answer) {
                    let persistedSessionId = sessionId;
                    try {
                        const appended = await appendChatExchange({
                            organizationId: orgIdEarly,
                            question: message,
                            answer: hrExtended.answer,
                            sessionId,
                            userId: req.user.userId,
                            sources: (hrExtended.citations || []).map((c) => ({
                                document_id: c.documentId,
                                document_title: c.filename,
                                score: c.score,
                                phase3_agent: c.phase3Agent,
                                document_type: c.documentType,
                            })),
                        });
                        persistedSessionId = appended.session_id || sessionId;
                    } catch (appendErr: any) {
                        logger.warn(
                            `HR extended chat reply ok but append-exchange failed: ${appendErr?.message || appendErr}`
                        );
                    }
                    const hrFocus = (hrExtended.citations || [])
                        .map((c) => c.documentId)
                        .filter(Boolean) as string[];
                    if (hrFocus.length) {
                        setSessionFocusDocumentIds(persistedSessionId, hrFocus, {
                            organizationId: orgIdEarly,
                            userId: req.user.userId,
                        });
                    }
                    return res.json({
                        success: true,
                        data: {
                            reply: hrExtended.answer,
                            citations: hrExtended.citations || [],
                            sessionId: persistedSessionId,
                            chatScope,
                            model: 'hr-agent-actions',
                            agentId: phase3Agent || 'hr_agent',
                        },
                    });
                }

                const hrAction = await tryHrChatCommand({
                    user: req.user,
                    question: message,
                    phase3Agent,
                    documentIds: scopedAnalyticsDocIds,
                });
                if (hrAction.handled && hrAction.answer) {
                    let persistedSessionId = sessionId;
                    try {
                        const appended = await appendChatExchange({
                            organizationId: orgIdEarly,
                            question: message,
                            answer: hrAction.answer,
                            sessionId,
                            userId: req.user.userId,
                            sources: (hrAction.citations || []).map((c) => ({
                                document_id: c.documentId,
                                document_title: c.filename,
                                score: c.score,
                                phase3_agent: c.phase3Agent,
                                document_type: c.documentType,
                            })),
                        });
                        persistedSessionId = appended.session_id || sessionId;
                    } catch (appendErr: any) {
                        logger.warn(
                            `HR chat reply ok but append-exchange failed (restart ai-backend?): ${appendErr?.message || appendErr}`
                        );
                    }
                    const hrFocus = (hrAction.citations || [])
                        .map((c) => c.documentId)
                        .filter(Boolean) as string[];
                    if (hrFocus.length) {
                        setSessionFocusDocumentIds(persistedSessionId, hrFocus, {
                            organizationId: orgIdEarly,
                            userId: req.user.userId,
                        });
                    }
                    return res.json({
                        success: true,
                        data: {
                            reply: hrAction.answer,
                            citations: hrAction.citations || [],
                            sessionId: persistedSessionId,
                            chatScope,
                            model: 'hr-agent-actions',
                            agentId: phase3Agent || 'hr_agent',
                        },
                    });
                }

                const complianceDynamic = await tryComplianceDynamicAgent({
                    user: req.user,
                    question: message,
                    phase3Agent,
                    documentIds: scopedAnalyticsDocIds,
                });
                if (complianceDynamic.handled && complianceDynamic.answer) {
                    let persistedSessionId = sessionId;
                    try {
                        const appended = await appendChatExchange({
                            organizationId: orgIdEarly,
                            question: message,
                            answer: complianceDynamic.answer,
                            sessionId,
                            userId: req.user.userId,
                            sources: (complianceDynamic.citations || []).map((c) => ({
                                document_id: c.documentId,
                                document_title: c.filename,
                                score: c.score,
                                phase3_agent: c.phase3Agent,
                                document_type: c.documentType,
                            })),
                        });
                        persistedSessionId = appended.session_id || sessionId;
                    } catch (appendErr: any) {
                        logger.warn(
                            `Compliance dynamic agent reply ok but append-exchange failed: ${appendErr?.message || appendErr}`
                        );
                    }
                    const focusIds = [
                        ...new Set([
                            ...(complianceDynamic.citations || []).map((c) => c.documentId).filter(Boolean),
                            ...(complianceDynamic.visuals || []).flatMap((v) => v.sourceDocumentIds || []),
                        ]),
                    ] as string[];
                    if (focusIds.length) {
                        setSessionFocusDocumentIds(persistedSessionId, focusIds, {
                            organizationId: orgIdEarly,
                            userId: req.user.userId,
                        });
                    }
                    return res.json({
                        success: true,
                        data: {
                            reply: complianceDynamic.answer,
                            citations: complianceDynamic.citations || [],
                            visuals: complianceDynamic.visuals || [],
                            sessionId: persistedSessionId,
                            chatScope,
                            model: 'compliance-dynamic-agent',
                            agentId: phase3Agent || 'compliance_agent',
                            documentCount:
                                new Set(
                                    (complianceDynamic.visuals || []).flatMap(
                                        (v) => v.sourceDocumentIds || []
                                    )
                                ).size || (complianceDynamic.citations || []).length,
                        },
                    });
                }

                const complianceReportAction = await tryComplianceReportCommand({
                    user: req.user,
                    question: message,
                    phase3Agent,
                    documentIds: scopedAnalyticsDocIds,
                });
                if (complianceReportAction.handled && complianceReportAction.answer) {
                    let persistedSessionId = sessionId;
                    try {
                        const appended = await appendChatExchange({
                            organizationId: orgIdEarly,
                            question: message,
                            answer: complianceReportAction.answer,
                            sessionId,
                            userId: req.user.userId,
                            sources: (complianceReportAction.citations || []).map((c) => ({
                                document_id: c.documentId,
                                document_title: c.filename,
                                score: c.score,
                                phase3_agent: c.phase3Agent,
                                document_type: c.documentType,
                            })),
                        });
                        persistedSessionId = appended.session_id || sessionId;
                    } catch (appendErr: any) {
                        logger.warn(
                            `Compliance report reply ok but append-exchange failed (restart ai-backend?): ${appendErr?.message || appendErr}`
                        );
                    }
                    const reportFocus = (complianceReportAction.citations || [])
                        .map((c) => c.documentId)
                        .filter(Boolean) as string[];
                    if (reportFocus.length) {
                        setSessionFocusDocumentIds(persistedSessionId, reportFocus, {
                            organizationId: orgIdEarly,
                            userId: req.user.userId,
                        });
                    }
                    return res.json({
                        success: true,
                        data: {
                            reply: complianceReportAction.answer,
                            citations: complianceReportAction.citations || [],
                            sessionId: persistedSessionId,
                            chatScope,
                            model: 'compliance-agent-report',
                            agentId: phase3Agent || 'compliance_agent',
                        },
                    });
                }

                const financeDynamic = await tryFinanceDynamicAgent({
                    user: req.user,
                    question: message,
                    phase3Agent,
                    documentIds: scopedAnalyticsDocIds,
                });
                if (financeDynamic.handled && financeDynamic.answer) {
                    let persistedSessionId = sessionId;
                    try {
                        const appended = await appendChatExchange({
                            organizationId: orgIdEarly,
                            question: message,
                            answer: financeDynamic.answer,
                            sessionId,
                            userId: req.user.userId,
                            sources: (financeDynamic.citations || []).map((c) => ({
                                document_id: c.documentId,
                                document_title: c.filename,
                                score: c.score,
                                phase3_agent: c.phase3Agent,
                                document_type: c.documentType,
                            })),
                        });
                        persistedSessionId = appended.session_id || sessionId;
                    } catch (appendErr: any) {
                        logger.warn(
                            `Finance dynamic agent reply ok but append-exchange failed: ${appendErr?.message || appendErr}`
                        );
                    }
                    const financeFocus = (financeDynamic.citations || [])
                        .map((c) => c.documentId)
                        .filter(Boolean) as string[];
                    if (financeFocus.length) {
                        setSessionFocusDocumentIds(persistedSessionId, financeFocus, {
                            organizationId: orgIdEarly,
                            userId: req.user.userId,
                        });
                    }
                    return res.json({
                        success: true,
                        data: {
                            reply: financeDynamic.answer,
                            citations: financeDynamic.citations || [],
                            visuals: financeDynamic.visuals || [],
                            sessionId: persistedSessionId,
                            chatScope,
                            model: 'finance-dynamic-agent',
                            agentId: phase3Agent || 'finance_agent',
                        },
                    });
                }

                const legalDynamic = await tryLegalDynamicAgent({
                    user: req.user,
                    question: message,
                    phase3Agent,
                    documentIds: scopedAnalyticsDocIds,
                });
                if (legalDynamic.handled && legalDynamic.answer) {
                    let persistedSessionId = sessionId;
                    try {
                        const appended = await appendChatExchange({
                            organizationId: orgIdEarly,
                            question: message,
                            answer: legalDynamic.answer,
                            sessionId,
                            userId: req.user.userId,
                            sources: (legalDynamic.citations || []).map((c) => ({
                                document_id: c.documentId,
                                document_title: c.filename,
                                score: c.score,
                                phase3_agent: c.phase3Agent,
                                document_type: c.documentType,
                            })),
                        });
                        persistedSessionId = appended.session_id || sessionId;
                    } catch (appendErr: any) {
                        logger.warn(
                            `Legal dynamic agent reply ok but append-exchange failed: ${appendErr?.message || appendErr}`
                        );
                    }
                    const legalFocus = (legalDynamic.citations || [])
                        .map((c) => c.documentId)
                        .filter(Boolean) as string[];
                    if (legalFocus.length) {
                        setSessionFocusDocumentIds(persistedSessionId, legalFocus, {
                            organizationId: orgIdEarly,
                            userId: req.user.userId,
                        });
                    }
                    return res.json({
                        success: true,
                        data: {
                            reply: legalDynamic.answer,
                            citations: legalDynamic.citations || [],
                            visuals: legalDynamic.visuals || [],
                            sessionId: persistedSessionId,
                            chatScope,
                            model: 'legal-dynamic-agent',
                            agentId: phase3Agent || 'legal_agent',
                            coverage: {
                                documentsInScope: (legalDynamic.citations || []).length,
                                documentsCharted: (legalDynamic.visuals || []).length
                                    ? (legalDynamic.citations || []).length
                                    : 0,
                            },
                            documentCount: (legalDynamic.citations || []).length,
                        },
                    });
                }

                const procurementDynamic = await tryProcurementDynamicAgent({
                    user: req.user,
                    question: message,
                    phase3Agent,
                    documentIds: scopedAnalyticsDocIds,
                });
                if (procurementDynamic.handled && procurementDynamic.answer) {
                    let persistedSessionId = sessionId;
                    try {
                        const appended = await appendChatExchange({
                            organizationId: orgIdEarly,
                            question: message,
                            answer: procurementDynamic.answer,
                            sessionId,
                            userId: req.user.userId,
                            sources: (procurementDynamic.citations || []).map((c) => ({
                                document_id: c.documentId,
                                document_title: c.filename,
                                score: c.score,
                                phase3_agent: c.phase3Agent,
                                document_type: c.documentType,
                            })),
                        });
                        persistedSessionId = appended.session_id || sessionId;
                    } catch (appendErr: any) {
                        logger.warn(
                            `Procurement dynamic agent reply ok but append-exchange failed: ${appendErr?.message || appendErr}`
                        );
                    }
                    const procurementFocus = (procurementDynamic.citations || [])
                        .map((c) => c.documentId)
                        .filter(Boolean) as string[];
                    if (procurementFocus.length) {
                        setSessionFocusDocumentIds(persistedSessionId, procurementFocus, {
                            organizationId: orgIdEarly,
                            userId: req.user.userId,
                        });
                    }
                    return res.json({
                        success: true,
                        data: {
                            reply: procurementDynamic.answer,
                            citations: procurementDynamic.citations || [],
                            visuals: procurementDynamic.visuals || [],
                            sessionId: persistedSessionId,
                            chatScope,
                            model: 'procurement-dynamic-agent',
                            agentId: phase3Agent || 'procurement_agent',
                            coverage: {
                                documentsInScope: (procurementDynamic.citations || []).length,
                                documentsCharted: (procurementDynamic.visuals || []).length
                                    ? (procurementDynamic.citations || []).length
                                    : 0,
                            },
                            documentCount: (procurementDynamic.citations || []).length,
                        },
                    });
                }

                const otherDynamic = await tryOtherDynamicAgent({
                    user: req.user,
                    question: message,
                    phase3Agent,
                    documentIds: scopedAnalyticsDocIds,
                });
                if (otherDynamic.handled && otherDynamic.answer) {
                    let persistedSessionId = sessionId;
                    try {
                        const appended = await appendChatExchange({
                            organizationId: orgIdEarly,
                            question: message,
                            answer: otherDynamic.answer,
                            sessionId,
                            userId: req.user.userId,
                            sources: (otherDynamic.citations || []).map((c) => ({
                                document_id: c.documentId,
                                document_title: c.filename,
                                score: c.score,
                                phase3_agent: c.phase3Agent,
                                document_type: c.documentType,
                            })),
                        });
                        persistedSessionId = appended.session_id || sessionId;
                    } catch (appendErr: any) {
                        logger.warn(
                            `Other dynamic agent reply ok but append-exchange failed: ${appendErr?.message || appendErr}`
                        );
                    }
                    const otherFocus = (otherDynamic.citations || [])
                        .map((c) => c.documentId)
                        .filter(Boolean) as string[];
                    if (otherFocus.length) {
                        setSessionFocusDocumentIds(persistedSessionId, otherFocus, {
                            organizationId: orgIdEarly,
                            userId: req.user.userId,
                        });
                    }
                    return res.json({
                        success: true,
                        data: {
                            reply: otherDynamic.answer,
                            citations: otherDynamic.citations || [],
                            visuals: otherDynamic.visuals || [],
                            sessionId: persistedSessionId,
                            chatScope,
                            model: 'other-dynamic-agent',
                            agentId: phase3Agent || 'other_agent',
                            coverage: {
                                documentsInScope: (otherDynamic.citations || []).length,
                                documentsCharted: (otherDynamic.visuals || []).length
                                    ? (otherDynamic.citations || []).length
                                    : 0,
                            },
                            documentCount: (otherDynamic.citations || []).length,
                        },
                    });
                }

                const visualAction = await tryAgentChatVisual({
                    user: req.user,
                    question: message,
                    phase3Agent,
                    documentIds: scopedAnalyticsDocIds,
                    focusDocumentIds: focusDocumentIds.length ? focusDocumentIds : undefined,
                    sessionId,
                });
                if (visualAction.handled && visualAction.answer) {
                    let persistedSessionId = sessionId;
                    try {
                        const appended = await appendChatExchange({
                            organizationId: orgIdEarly,
                            question: message,
                            answer: visualAction.answer,
                            sessionId,
                            userId: req.user.userId,
                            sources: (visualAction.citations || []).map((c) => ({
                                document_id: c.documentId,
                                document_title: c.filename,
                                score: c.score,
                                phase3_agent: c.phase3Agent,
                                document_type: c.documentType,
                            })),
                        });
                        persistedSessionId = appended.session_id || sessionId;
                    } catch (appendErr: any) {
                        logger.warn(`Agent visual chat append failed: ${appendErr?.message || appendErr}`);
                    }
                    const vizFocus = [
                        ...new Set([
                            ...(visualAction.citations || []).map((c) => c.documentId).filter(Boolean),
                            ...(visualAction.visuals || []).flatMap((v) => v.sourceDocumentIds || []),
                        ]),
                    ] as string[];
                    if (vizFocus.length && !portfolioAsk) {
                        setSessionFocusDocumentIds(persistedSessionId, vizFocus, {
                            organizationId: orgIdEarly,
                            userId: req.user.userId,
                        });
                    }
                    return res.json({
                        success: true,
                        data: {
                            reply: visualAction.answer,
                            citations: visualAction.citations || [],
                            visuals: visualAction.visuals || [],
                            coverage: visualAction.coverage,
                            analyticsView: visualAction.analyticsView,
                            documentCount:
                                new Set(
                                    (visualAction.visuals || [])
                                        .flatMap((v) => v.sourceDocumentIds || [])
                                ).size ||
                                (visualAction.citations || []).length,
                            sessionId: persistedSessionId,
                            chatScope,
                            model: 'agent-analytics',
                            agentId: phase3Agent || visualAction.agentId,
                        },
                    });
                }
            }

            const agentAllowed = (d: any) => {
                if (!allowedAgents?.length) return true;
                const agent = resolveCanonicalAgent({
                    originalFilename: d?.originalFilename,
                    classification: d?.classification,
                    metadata: d?.metadata,
                });
                return allowedAgents.includes(agent);
            };

            if (isChitchat) {
                // Greetings skip document scope — AI replies without RAG
                scopedPythonIds = undefined;
            } else if (chatScope === 'selected') {
                const selectedMongo = await Document.find({
                    ...(await buildDocumentFilter(req.user, {})),
                    documentId: { $in: documentIds },
                })
                    .select('documentId pythonDocumentId originalFilename mimeType storagePath classification metadata')
                    .lean();
                const planSelected = selectedMongo.filter(agentAllowed).filter((d) => {
                    if (!phase3Agent) return true;
                    return (
                        resolveCanonicalAgent({
                            originalFilename: d.originalFilename,
                            classification: d.classification,
                            metadata: d.metadata as { phase3Agent?: string; naturalAgent?: string } | undefined,
                        }) === phase3Agent
                    );
                });
                if (!planSelected.length) {
                    return res.status(403).json({
                        success: false,
                        message:
                            'None of the selected documents are covered by your plan agents. Choose files for agents on your plan.',
                        data: { allowedAgents },
                    });
                }
                vectorOrgId = resolveVectorOrganizationId(req.user, planSelected as any[]);
                const healed = await ensureDocumentsInAi(planSelected as any[], vectorOrgId, req.user.userId);
                scopedPythonIds = planSelected
                    .map((d) => healed.get(d.documentId) || d.pythonDocumentId)
                    .filter(Boolean) as string[];
                if (!scopedPythonIds.length) {
                    return res.status(400).json({
                        success: false,
                        message:
                            'Selected documents are not available in the AI index yet. Open Documents → Reprocess (or re-upload) so chat can read their content.',
                    });
                }
            } else {
                // All-documents: only files whose agent is on the org/user plan
                const library = await Document.find(await buildDocumentFilter(req.user, {}))
                    .select('documentId pythonDocumentId originalFilename mimeType storagePath classification metadata')
                    .sort({ createdAt: -1 })
                    .limit(80)
                    .lean();
                let planLibrary = library.filter(agentAllowed);
                if (phase3Agent) {
                    planLibrary = planLibrary.filter(
                        (d) =>
                            resolveCanonicalAgent({
                                originalFilename: d.originalFilename,
                                classification: d.classification,
                                metadata: d.metadata as
                                    | { phase3Agent?: string; naturalAgent?: string }
                                    | undefined,
                            }) === phase3Agent
                    );
                }
                if (!planLibrary.length) {
                    return res.json({
                        success: true,
                        data: {
                            reply: phase3Agent
                                ? 'No documents for this agent are ready for chat yet. Upload files for this agent or wait for processing.'
                                : 'No documents on your plan agents are ready for chat yet. Upload files for agents included in your plan, wait for processing, then ask again.',
                            citations: [],
                            model: 'docs-ai',
                        },
                    });
                }
                vectorOrgId = resolveVectorOrganizationId(req.user, planLibrary as any[]);
                await ensureDocumentsInAi(planLibrary as any[], vectorOrgId, req.user.userId);
                scopedPythonIds = planLibrary
                    .map((d) => d.pythonDocumentId)
                    .filter(Boolean) as string[];
                if (!scopedPythonIds.length) {
                    return res.json({
                        success: true,
                        data: {
                            reply:
                                'No documents on your plan agents are ready for chat yet. Upload files for agents included in your plan, wait for processing, then ask again.',
                            citations: [],
                            model: 'docs-ai',
                        },
                    });
                }
            }

            const providerConfig = await resolveChatProviderConfig(orgId, provider, model);
            if (!providerConfig) {
                return res.status(400).json({
                    success: false,
                    message: provider
                        ? `Selected AI provider "${provider}" is not configured. Add an API key in AI Settings.`
                        : 'No active AI provider configured. Please go to AI Settings and enter your API key.',
                });
            }
            // Chitchat already sends providerConfig in the chat payload — skip extra sync round-trip.
            if (!isChitchat) {
                await syncProviderToAIBackend(providerConfig);
            }

            const result = await chatWithAi({
                organizationId: vectorOrgId,
                question: message,
                documentIds: scopedPythonIds,
                sessionId,
                chatHistory: Array.isArray(req.body.chatHistory) ? req.body.chatHistory : undefined,
                userId: req.user.userId,
                selectedText: (req.body.selected_text || req.body.selectedText || '').toString().trim() || undefined,
                phase3Agent,
                documentType,
                allowedAgents,
                provider: providerConfig?.provider || provider,
                model: providerConfig?.model || model,
                providerConfig: providerConfig || undefined,
            });

            const seenCite = new Set<string>();
            let citations = (result.sources || [])
                .map((source: any) => {
                    const pyId = String(source.document_id || source.documentId || '');
                    let nodeDoc = pythonIdToDoc.get(pyId);
                    const rawTitle = source.document_title || source.title || source.filename || '';
                    const filename =
                        nodeDoc?.originalFilename ||
                        (rawTitle && !/^[0-9a-f-]{16,}$/i.test(String(rawTitle)) ? String(rawTitle) : '') ||
                        nodeDoc?.originalFilename ||
                        undefined;
                    return {
                        documentId: nodeDoc?.documentId || pyId,
                        pythonDocumentId: pyId || undefined,
                        filename,
                        pageNumber: source.page_number,
                        score: source.score,
                        snippet: source.snippet || source.chunk_text || undefined,
                        phase3Agent: source.phase3_agent || undefined,
                        documentType: source.document_type || undefined,
                    };
                })
                .filter((c) => {
                    const key = String(c.documentId || c.filename || '');
                    if (!key || seenCite.has(key)) return false;
                    seenCite.add(key);
                    return true;
                })
                .slice(0, 8);

            // Resolve any leftover AI/python ids to Mongo documentIds so "Open" works
            const unresolved = citations
                .map((c) => c.documentId)
                .filter((id) => id && !String(id).startsWith('doc_'));
            if (unresolved.length) {
                const found = await Document.find({
                    ...(await buildDocumentFilter(req.user, {})),
                    pythonDocumentId: { $in: unresolved },
                })
                    .select('documentId pythonDocumentId originalFilename classification metadata')
                    .lean();
                const byPy = new Map(found.map((d) => [d.pythonDocumentId as string, d]));
                for (const c of citations) {
                    const mapped = byPy.get(String(c.documentId));
                    if (mapped) {
                        c.documentId = mapped.documentId;
                        c.filename = c.filename || mapped.originalFilename;
                        c.documentType = c.documentType || mapped.classification || undefined;
                        c.phase3Agent =
                            c.phase3Agent ||
                            (mapped.metadata as any)?.phase3Agent ||
                            undefined;
                    }
                }
            }

            // Only cite documents whose agent is on the user's plan
            if (allowedAgents?.length) {
                const allowed = new Set(allowedAgents);
                const mongoIds = citations
                    .map((c) => c.documentId)
                    .filter((id) => id && String(id).startsWith('doc_'));
                const metaDocs = mongoIds.length
                    ? await Document.find({ documentId: { $in: mongoIds } })
                          .select('documentId classification metadata')
                          .lean()
                    : [];
                const metaById = new Map(metaDocs.map((d) => [d.documentId, d]));
                citations = citations.filter((c) => {
                    const d = metaById.get(String(c.documentId));
                    const agent =
                        c.phase3Agent ||
                        (d?.metadata as any)?.phase3Agent ||
                        DOC_TYPE_TO_AGENT[String(c.documentType || d?.classification || '')] ||
                        'other_agent';
                    return allowed.has(agent);
                });
            }

            res.json({
                success: true,
                data: {
                    reply: result.answer,
                    citations,
                    sessionId: result.session_id,
                    chatScope,
                    model: 'visibility-ai-rag',
                    aiProvider: (result as any).provider || providerConfig?.provider || provider,
                    aiModel: (result as any).model || providerConfig?.model || model,
                    agentId: phase3Agent || undefined,
                    chartData: result.chart_data || (result as any).chartData || undefined,
                },
            });
            recordActivityFromReq(req, {
                action: 'chat.message',
                category: 'chat',
                resourceType: 'chat_session',
                resourceId: result.session_id || sessionId || undefined,
                message: `Sent chat message (${chatScope})`,
                metadata: {
                    chatScope,
                    preview: message.slice(0, 120),
                    citationCount: citations.length,
                },
            });
        } catch (aiError: any) {
            logger.error(`AI chat proxy failed: ${formatAiError(aiError)}`);
            const groq = extractGroqLimitError(aiError);
            if (groq) {
                return res.status(429).json({
                    success: false,
                    code: groq.code,
                    message: groq.message,
                    retry_after_seconds: groq.retry_after_seconds,
                    until_ts: groq.until_ts,
                    console_url: groq.console_url,
                    billing_url: groq.billing_url,
                });
            }
            return res.status(502).json({
                success: false,
                message:
                    aiError?.code === 'ECONNABORTED' || String(aiError?.message || '').includes('timeout')
                        ? 'Chat took too long. Narrow document scope or increase AI_CHAT_TIMEOUT_MS on the gateway.'
                        : 'AI backend (Python) is not reachable. Start it with: cd ai-backend && python run.py (see AI_SERVICE_URL in api-gateway/.env).',
                error: formatAiError(aiError),
            });
        }
    } catch (error) {
        next(error);
    }
};

export const listChatModelsHandler = async (req: Request, res: Response, next: NextFunction) => {
    try {
        if (!hasPermission(req.user, PERMISSIONS.CHAT_USE)) {
            return res.status(403).json({ success: false, message: 'Forbidden' });
        }
        const organizationId = req.user.organizationId || null;
        if (!organizationId && req.user.role !== 'superAdmin') {
            return res.json({ success: true, data: { models: [], primary: null } });
        }

        const keys = await ApiKey.find({
            organizationId: organizationId || undefined,
            isActive: true,
        })
            .sort({ createdAt: 1 })
            .lean();

        const models = keys.map((k) => ({
            provider: k.provider,
            label: k.label || k.provider,
            model: k.aiModel || '',
            baseUrl: k.baseUrl || null,
        }));
        const primary = models[0] || null;

        res.json({
            success: true,
            data: { models, primary },
        });
    } catch (error) {
        next(error);
    }
};

export const listChatSessionsHandler = async (req: Request, res: Response, next: NextFunction) => {
    try {
        if (!hasPermission(req.user, PERMISSIONS.CHAT_USE)) {
            return res.status(403).json({ success: false, message: 'Forbidden' });
        }
        if (!isAiServiceEnabled()) {
            return res.json({ success: true, data: { sessions: [], total: 0 } });
        }
        const orgId = resolveAiOrganizationId(req.user);
        const sessions = await listChatSessions(orgId, req.user.userId);
        res.json({ success: true, data: { sessions, total: sessions.length } });
    } catch (error) {
        next(error);
    }
};

export const getChatSessionHandler = async (req: Request, res: Response, next: NextFunction) => {
    try {
        if (!hasPermission(req.user, PERMISSIONS.CHAT_USE)) {
            return res.status(403).json({ success: false, message: 'Forbidden' });
        }
        if (!isAiServiceEnabled()) {
            return res.status(503).json({ success: false, message: 'AI service offline' });
        }
        const sessionId = String(req.params.id);
        const session = await getChatSession(sessionId);
        if (!session) {
            return res.status(404).json({ success: false, message: 'Session not found' });
        }
        const orgId = resolveAiOrganizationId(req.user);
        if (session.organization_id && session.organization_id !== orgId) {
            return res.status(403).json({ success: false, message: 'Forbidden' });
        }
        if (session.user_id && session.user_id !== req.user.userId) {
            return res.status(403).json({ success: false, message: 'Forbidden' });
        }
        res.json({ success: true, data: { session } });
    } catch (error) {
        next(error);
    }
};

export const deleteChatSessionHandler = async (req: Request, res: Response, next: NextFunction) => {
    try {
        if (!hasPermission(req.user, PERMISSIONS.CHAT_USE)) {
            return res.status(403).json({ success: false, message: 'Forbidden' });
        }
        if (!isAiServiceEnabled()) {
            return res.status(503).json({ success: false, message: 'AI service offline' });
        }
        const sessionId = String(req.params.id);
        const existing = await getChatSession(sessionId);
        if (!existing) {
            return res.status(404).json({ success: false, message: 'Session not found' });
        }
        const orgId = resolveAiOrganizationId(req.user);
        if (existing.organization_id && existing.organization_id !== orgId) {
            return res.status(403).json({ success: false, message: 'Forbidden' });
        }
        if (existing.user_id && existing.user_id !== req.user.userId) {
            return res.status(403).json({ success: false, message: 'Forbidden' });
        }
        const ok = await deleteChatSession(sessionId);
        if (!ok) {
            return res.status(502).json({ success: false, message: 'Failed to delete session' });
        }
        recordActivityFromReq(req, {
            action: 'chat.session.delete',
            category: 'chat',
            resourceType: 'chat_session',
            resourceId: sessionId,
            message: 'Deleted a chat session',
        });
        res.json({ success: true, message: 'Session deleted' });
    } catch (error) {
        next(error);
    }
};

export const renameChatSessionHandler = async (req: Request, res: Response, next: NextFunction) => {
    try {
        if (!hasPermission(req.user, PERMISSIONS.CHAT_USE)) {
            return res.status(403).json({ success: false, message: 'Forbidden' });
        }
        if (!isAiServiceEnabled()) {
            return res.status(503).json({ success: false, message: 'AI service offline' });
        }
        const sessionId = String(req.params.id);
        const title = String(req.body?.title || '').trim();
        if (!title) {
            return res.status(400).json({ success: false, message: 'Title is required' });
        }
        const existing = await getChatSession(sessionId);
        if (!existing) {
            return res.status(404).json({ success: false, message: 'Session not found' });
        }
        const orgId = resolveAiOrganizationId(req.user);
        if (existing.organization_id && existing.organization_id !== orgId) {
            return res.status(403).json({ success: false, message: 'Forbidden' });
        }
        if (existing.user_id && existing.user_id !== req.user.userId) {
            return res.status(403).json({ success: false, message: 'Forbidden' });
        }
        const session = await renameChatSession(sessionId, title);
        if (!session) {
            return res.status(502).json({ success: false, message: 'Failed to rename session' });
        }
        recordActivityFromReq(req, {
            action: 'chat.session.rename',
            category: 'chat',
            resourceType: 'chat_session',
            resourceId: sessionId,
            message: `Renamed chat to "${title.slice(0, 80)}"`,
            metadata: { title },
        });
        res.json({ success: true, message: 'Session renamed', data: { session } });
    } catch (error) {
        next(error);
    }
};

export const getChatAnalyticsHandler = async (req: Request, res: Response, next: NextFunction) => {
    try {
        if (!hasPermission(req.user, PERMISSIONS.CHAT_USE)) {
            return res.status(403).json({ success: false, message: 'Forbidden' });
        }
        const agentId = String(req.query.agent || '').trim();
        if (!agentId) {
            return res.status(400).json({ success: false, message: 'agent query parameter is required' });
        }
        const view = req.query.view != null ? String(req.query.view) : undefined;
        const limit = req.query.limit != null ? Number(req.query.limit) : undefined;
        const documentIdsRaw = req.query.documentIds;
        let documentIds: string[] | undefined;
        if (typeof documentIdsRaw === 'string' && documentIdsRaw.trim()) {
            documentIds = documentIdsRaw
                .split(',')
                .map((s) => s.trim())
                .filter(Boolean);
        }

        const dashboardMode =
            String(req.query.mode || '').toLowerCase() === 'dashboard' ||
            String(req.query.dashboard || '').toLowerCase() === 'true';

        const dashboard = await getAgentAnalyticsDashboard({
            user: req.user,
            agentId,
            view,
            limit: Number.isFinite(limit) ? limit : undefined,
            documentIds,
            dashboardMode,
        });

        res.json({
            success: true,
            data: {
                agentId: dashboard.agentId,
                visuals: dashboard.visuals,
                citations: dashboard.citations || [],
                summary: dashboard.summary,
                documentCount: dashboard.documentCount,
                coverage: dashboard.coverage,
                scopeMode: dashboard.scopeMode,
            },
        });
    } catch (error) {
        next(error);
    }
};

function generateFeedbackId(): string {
    return `fb_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

export const submitFeedback = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const { sessionId, messageIndex, type } = req.body || {};
        if (!sessionId || messageIndex == null || !type) {
            return res.status(400).json({
                success: false,
                message: 'sessionId, messageIndex, and type are required',
            });
        }
        if (!['like', 'dislike'].includes(String(type))) {
            return res.status(400).json({ success: false, message: 'type must be "like" or "dislike"' });
        }

        const idx = Number(messageIndex);
        if (Number.isNaN(idx) || idx < 0) {
            return res.status(400).json({ success: false, message: 'messageIndex must be a non-negative integer' });
        }

        const { default: MessageFeedback } = await import('../models/MessageFeedback');
        const existing = await MessageFeedback.findOne({
            sessionId,
            messageIndex: idx,
            userId: req.user.userId,
        });

        if (existing) {
            existing.type = String(type) as 'like' | 'dislike';
            await existing.save();
            return res.json({ success: true, data: { feedback: existing, updated: true } });
        }

        const fb = await MessageFeedback.create({
            feedbackId: generateFeedbackId(),
            sessionId,
            messageIndex: idx,
            userId: req.user.userId,
            organizationId: req.user.organizationId || 'personal',
            type: String(type) as 'like' | 'dislike',
        });

        res.status(201).json({ success: true, data: { feedback: fb } });
    } catch (error) {
        next(error);
    }
};
