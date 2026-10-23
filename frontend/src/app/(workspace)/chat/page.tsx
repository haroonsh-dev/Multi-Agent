"use client";

import React, { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
    Sparkles, ChevronLeft, ChevronRight, FileText,
    Plus, Trash2, Pencil, Check, X, MessageSquare, MessageCircle, Copy, Upload, Loader2,
    ThumbsUp, ThumbsDown, Search, Download, RotateCcw, PanelLeft, PanelLeftClose, MoreHorizontal,
    BarChart3,
} from "lucide-react";
import ChatComposer from "@/components/ChatComposer";
import ChatScopePanel, {
    type ChatScope,
    type DocStatusFilter,
    type ScopeLibraryDoc,
} from "@/components/ChatScopePanel";
import { useTheme } from "@/context/ColorContext";
import { apiRequest, ApiError } from "@/lib/apiClient";
import { getRequestErrorMessage, CHAT_PROXY_TIMEOUT_MESSAGE, isChatProxyDrop } from "@/lib/apiErrors";
import { usePermissions } from "@/context/PermissionsContext";
import { resolveDocAgent, agentLabel } from "@/lib/documentAgents";
import { agentWorkspacePath } from "@/lib/agentWorkspace";
import { usePlanAgents } from "@/hooks/usePlanAgents";
import { useToast } from "@/components/Toast";
import ChatAnalyticsSidePanel, {
    WORKSPACE_SPLIT_HEADER,
    type AnalyticsPanelView,
} from "@/components/ChatAnalyticsSidePanel";
import type { ChatVisualSpec, FinanceAnalyticsCoverage } from "@/types/chatVisuals";
import {
    isFinanceAnalyticsDoc,
    listFinanceReadyDocIds,
    wantsFinanceListAllScope,
    wantsPortfolioFinanceScope,
} from "@/lib/financeAnalyticsScope";
import {
    filterComplianceAnalyticsDocIds,
    isComplianceAnalyticsDoc,
} from "@/lib/complianceAnalyticsScope";
import { filterAnalyticsScopeDocIds, filterDocIdsForAgent } from "@/lib/analyticsScope";
import {
    generatedPreviewHref,
    parseGeneratedPreviewDocumentId,
} from "@/lib/generatedDocuments";
import ChatGraphRenderer, { type ChartDataPayload } from "@/components/ChatGraphRenderer";

type ChatMessage = {
    id: string;
    role: "user" | "assistant";
    content: string;
    agentId?: string;
    aiProvider?: string;
    aiModel?: string;
    chartData?: ChartDataPayload;
    citations?: Array<{
        documentId?: string;
        filename?: string;
        pageNumber?: number;
        snippet?: string;
        score?: number;
        documentType?: string;
        phase3Agent?: string;
    }>;
    visuals?: ChatVisualSpec[];
};

type LibraryDoc = ScopeLibraryDoc;

type ChatSessionSummary = {
    id: string;
    title: string;
    document_ids?: string[];
    updated_at?: string;
    created_at?: string;
};

type ChatModelOption = {
    provider: string;
    label: string;
    model: string;
    baseUrl?: string | null;
};

const ANALYTICS_AGENT_IDS = new Set([
    "finance_agent",
    "hr_agent",
    "compliance_agent",
    "procurement_agent",
    "legal_agent",
    "other_agent",
]);

/** Text-only explain/overview — never auto-open Analytics. */
function messageIsTextExplainAsk(message: string, agentId?: string | null): boolean {
    const q = message.toLowerCase();
    if (/\b(chart|graph|visual|plot|ranking chart|analytics panel)\b/.test(q)) return false;

    const generic =
        /\b(explain|overview|summary|summarize|describe|profile|tell me about|what is|what are|break down)\b/.test(
            q
        );
    const compare = /\b(comparison|compare|comparision|versus|\bvs\.?\b)\b/.test(q) && !/\btable\b/.test(q);
    const single = /\b(only|not others|single|full overview)\b/.test(q);

    if (agentId === "hr_agent" || /\b(cv|resume|candidate)\b/.test(q)) {
        if ((generic || compare || single) && /\b(cv|resume|candidate|hiring)\b/.test(q)) return true;
    }
    if (agentId === "legal_agent" || /\b(contract|agreement|nda|legal|clause)\b/.test(q)) {
        if (generic || compare) return true;
    }
    if (agentId === "finance_agent" || /\b(invoice|vendor|payable|finance|expense)\b/.test(q)) {
        if (generic || compare) return true;
    }
    if (agentId === "compliance_agent" || /\b(compliance|certificate|audit|sop|iso|finding)\b/.test(q)) {
        if (generic || compare) return true;
    }
    if (agentId === "procurement_agent" || /\b(purchase order|\bpo\b|rfq|quotation|procurement|supplier)\b/.test(q)) {
        if (generic || compare) return true;
    }
    if (agentId === "other_agent" || /\b(document|file|pdf)\b/.test(q)) {
        if (generic || compare || single) return true;
    }
    return false;
}

/** Analytics/chart-related asks — open Analytics when backend returns visuals. */
function messageWantsAnalyticsPanel(message: string, agentId?: string | null): boolean {
    if (messageIsTextExplainAsk(message, agentId)) return false;
    const q = message.toLowerCase();
    if (/\b(chart|graph|graphs|visuali[sz]e|visual|plot|analytics|dashboard|breakdown)\b/.test(q)) {
        return true;
    }
    if (/\b(show me|give me|show a)\b.*\b(chart|graph|visual|analytics|ranking|scores|breakdown)\b/.test(q)) {
        return true;
    }
    if (agentId === "hr_agent" || /\b(cv|resume|candidate)\b/.test(q)) {
        if (/\b(rank|ranking|top \d+|score|scores|distribution|histogram)\b/.test(q)) return true;
    }
    if (agentId === "finance_agent" || /\b(invoice|vendor|finance|payable|receivable)\b/.test(q)) {
        if (/\b(vendor spend|spend by|aging|overdue|monthly trend|line[\s-]?items?|client spend)\b/.test(q)) {
            return true;
        }
    }
    if (agentId === "compliance_agent" || /\b(compliance|certificate|audit|finding)\b/.test(q)) {
        if (/\b(expiry|findings|severity|cert status|status mix)\b/.test(q)) {
            if (/\b(chart|graph|visual|timeline|mix|dashboard)\b/.test(q)) return true;
            if (/\b(show|list|top)\b/.test(q)) return true;
        }
    }
    if (agentId === "legal_agent" || /\b(contract|agreement|legal|risk|clause)\b/.test(q)) {
        if (/\b(risk|clause|party value)\b/.test(q) && /\b(chart|graph|visual|mix)\b/.test(q)) return true;
    }
    if (agentId === "procurement_agent" || /\b(purchase order|\bpo\b|supplier|procurement|rfq)\b/.test(q)) {
        if (/\b(supplier spend|po vs invoice|spend by)\b/.test(q)) return true;
        if (/\b(supplier|spend|\bpo\b)\b/.test(q) && /\b(chart|graph|visual)\b/.test(q)) return true;
    }
    return false;
}

function messageMayUseAnalytics(message: string, agentId?: string | null): boolean {
    return messageWantsAnalyticsPanel(message, agentId);
}

const WELCOME_MSG: ChatMessage = {
    id: "welcome",
    role: "assistant",
    content:
        "Ask about your uploaded documents — summaries, expiries, invoice fields, and more. Start a **New chat**, or open a past conversation from the left.",
};

const LAST_SESSION_KEY = "docs_ai_last_chat_session";

const AI_BACKEND_DOWN_HINT =
    "AI backend is not running. Start it with: cd ai-backend && python run.py (port 8000).";

function formatChatError(error: unknown): string {
    if (isChatProxyDrop(error)) return CHAT_PROXY_TIMEOUT_MESSAGE;
    if (error instanceof ApiError) {
        if (error.status === 502 || error.status === 503) {
            const detail = String(error.data?.error || error.message || "");
            if (/timeout|too long/i.test(detail)) return CHAT_PROXY_TIMEOUT_MESSAGE;
            if (/ECONNREFUSED|connect|unavailable|8000/i.test(detail)) {
                return AI_BACKEND_DOWN_HINT;
            }
            return error.message || AI_BACKEND_DOWN_HINT;
        }
    }
    return getRequestErrorMessage(error, "Chat failed");
}

async function revealStreamText(
    assistantId: string,
    fullText: string,
    onUpdate: (id: string, content: string) => void,
    cancelRef: { cancelled: boolean },
    signal?: AbortSignal
): Promise<void> {
    // Short replies: show instantly (no fake typing delay after the API already finished).
    if (fullText.length <= 280) {
        onUpdate(assistantId, fullText);
        return;
    }
    const step = Math.max(24, Math.ceil(fullText.length / 24));
    for (let i = 0; i < fullText.length; i += step) {
        if (cancelRef.cancelled || signal?.aborted) {
            onUpdate(assistantId, fullText.slice(0, i));
            return;
        }
        onUpdate(assistantId, fullText.slice(0, Math.min(i + step, fullText.length)));
        await new Promise((r) => setTimeout(r, 4));
    }
    onUpdate(assistantId, fullText);
}

function isChitchatMessage(text: string): boolean {
    const q = text.trim().toLowerCase();
    if (!q || q.length > 80) return false;
    const docHints = [
        "resume", "cv", "invoice", "document", "file", "score", "candidate",
        "pdf", "contract", "find", "show", "list", "who", "what is", "kitne",
        "kitna", "batao", "tell me", "search", "summar", "extract",
        "chart", "graph", "visualize", "visualise", "vendor", "spend", "invoice", "aging",
    ];
    if (docHints.some((h) => q.includes(h))) return false;
    return /^(hi|hii+|hello|hey|hy|helo|hola|salam|assalam|aoa|slm|good\s*(morning|afternoon|evening|night)|gm|gn|how are you|how's it going|how r u|whats? up|sup|thanks?|thank you|thx|ty|shukriya|ok|okay|k|cool|great|nice|bye|goodbye|yes|no|yep|yup|nope|yeah|help|who are you|what can you do)\b/i.test(
        q
    );
}

function dedupeCitations(
    items: Array<{ documentId?: string; filename?: string; pageNumber?: number; snippet?: string; score?: number; documentType?: string }>
) {
    const seen = new Set<string>();
    const out: typeof items = [];
    for (const c of items) {
        const key = String(c.documentId || c.filename || "");
        if (!key || seen.has(key)) continue;
        seen.add(key);
        out.push(c);
        if (out.length >= 8) break;
    }
    return out;
}

function looksLikeRawId(value?: string | null) {
    if (!value) return true;
    const v = value.trim();
    if (!v) return true;
    // Mongo doc ids, UUIDs, or long hex blobs — not a real filename
    if (/^doc_[a-z0-9]+$/i.test(v)) return true;
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v)) return true;
    if (/^[0-9a-f]{16,}$/i.test(v) && !v.includes(".")) return true;
    return false;
}

function shortFileLabel(name: string, max = 28) {
    if (name.length <= max) return name;
    const extMatch = name.match(/(\.[a-z0-9]{1,8})$/i);
    const ext = extMatch?.[1] || "";
    const base = ext ? name.slice(0, -ext.length) : name;
    const keep = Math.max(8, max - ext.length - 1);
    return `${base.slice(0, keep)}…${ext}`;
}

/** Map AI / python source ids → Mongo documentId + real filename from the library. */
function resolveCitations(
    raw: Array<{
        documentId?: string;
        pythonDocumentId?: string;
        filename?: string;
        pageNumber?: number;
        snippet?: string;
        score?: number;
        documentType?: string;
    }>,
    libraryDocs: Array<{
        documentId: string;
        originalFilename?: string;
        pythonDocumentId?: string | null;
        classification?: string | null;
        metadata?: { phase3Agent?: string } | null;
    }>,
    allowedAgentIds?: string[] | null
) {
    const byNode = new Map(libraryDocs.map((d) => [d.documentId, d]));
    const byPython = new Map(
        libraryDocs.filter((d) => d.pythonDocumentId).map((d) => [d.pythonDocumentId as string, d])
    );
    const allowed = allowedAgentIds?.length ? new Set(allowedAgentIds) : null;

    const mapped = (raw || []).map((c) => {
        const id = String(c.documentId || c.pythonDocumentId || "");
        const hit = byNode.get(id) || byPython.get(id) || byPython.get(String(c.pythonDocumentId || ""));
        const filename =
            (hit?.originalFilename && !looksLikeRawId(hit.originalFilename) ? hit.originalFilename : null) ||
            (!looksLikeRawId(c.filename) ? c.filename : null) ||
            hit?.originalFilename ||
            c.filename ||
            "Document";
        const agent = hit ? resolveDocAgent(hit) : "other_agent";
        return {
            documentId: hit?.documentId || (id.startsWith("doc_") ? id : undefined),
            filename,
            pageNumber: c.pageNumber,
            snippet: c.snippet,
            score: c.score,
            documentType: c.documentType || hit?.classification || undefined,
            agentId: agent,
        };
    });

    const filtered = allowed
        ? mapped.filter((c) => !c.agentId || allowed.has(c.agentId))
        : mapped;

    return dedupeCitations(filtered).filter((c) => c.documentId || c.filename);
}

/** Turn fenced JSON objects into Field|Value markdown tables when possible. */
function formatAssistantMarkdown(content: string): string {
    if (!content) return content;
    return content.replace(/```json\s*([\s\S]*?)```/gi, (_full, body: string) => {
        try {
            const data = JSON.parse(String(body).trim());
            if (!data || typeof data !== "object" || Array.isArray(data)) return _full;
            const rows: string[] = ["| Field | Value |", "| --- | --- |"];
            const skip = new Set(["order_details", "additional_information", "vendor_address", "billing_contact"]);
            for (const [key, val] of Object.entries(data)) {
                if (skip.has(key)) continue;
                if (val != null && typeof val === "object") continue;
                const label = key.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
                rows.push(`| **${label}** | ${val == null ? "—" : String(val)} |`);
            }
            if (Array.isArray((data as any).order_details) && (data as any).order_details.length) {
                rows.push("");
                rows.push("**Line items**");
                rows.push("");
                rows.push("| Product | SKU | Qty | Rate | Amount |");
                rows.push("| --- | --- | ---: | ---: | ---: |");
                for (const item of (data as any).order_details) {
                    rows.push(
                        `| ${item.product || "—"} | ${item.sku || "—"} | ${item.quantity ?? "—"} | ${item.rate ?? "—"} | ${item.amount ?? "—"} |`
                    );
                }
            }
            return rows.join("\n");
        } catch {
            return _full;
        }
    });
}

function citationMeta(c: { pageNumber?: number; score?: number }) {
    if (c.pageNumber != null && c.pageNumber !== undefined) return `p.${c.pageNumber}`;
    if (c.score != null && !Number.isNaN(Number(c.score))) return `${Math.round(Number(c.score) * 100)}%`;
    return null;
}

function stampForFilename(d = new Date()) {
    const p = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

function formatChatThreadAsText(msgs: ChatMessage[]): string {
    return msgs
        .filter((m) => m.id !== "welcome")
        .map((m) => `[${m.role}]\n${(m.content || "").trim()}`)
        .filter((block) => block.length > 0)
        .join("\n\n");
}

function mapSessionMessages(
    raw: any[],
    libraryDocs: Array<{
        documentId: string;
        originalFilename?: string;
        pythonDocumentId?: string | null;
        classification?: string | null;
        metadata?: { phase3Agent?: string } | null;
    }>,
    allowedAgentIds?: string[] | null
): ChatMessage[] {
    return raw.map((m, i) => ({
        id: `m_${m.id || i}`,
        role: m.role === "user" ? "user" : "assistant",
        content: m.content || "",
        citations: Array.isArray(m.sources)
            ? resolveCitations(
                  m.sources.map((s: any) => ({
                      documentId: s.document_id || s.documentId,
                      pythonDocumentId: s.document_id || s.pythonDocumentId,
                      filename: s.document_title || s.title || s.filename,
                      pageNumber: s.page_number ?? s.pageNumber,
                      score: s.score,
                      snippet: s.snippet || s.chunk_text,
                  })),
                  libraryDocs,
                  allowedAgentIds
              )
            : undefined,
    }));
}

function ChatContent() {
    const { theme } = useTheme();
    const colors = theme.colors;
    const isDark = theme.name === "dark";
    const { canChat } = usePermissions();
    const { isAgentAllowed, allowedIds } = usePlanAgents();
    const { showToast } = useToast();
    const pathname = usePathname();

    const [messages, setMessages] = useState<ChatMessage[]>([WELCOME_MSG]);
    const [input, setInput] = useState("");
    const [sending, setSending] = useState(false);
    const [sidebarOpen, setSidebarOpen] = useState(false);
    const [documentsPanelOpen, setDocumentsPanelOpen] = useState(false);
    const [analyticsPanelOpen, setAnalyticsPanelOpen] = useState(false);
    const [headerMenuOpen, setHeaderMenuOpen] = useState(false);
    const [isLg, setIsLg] = useState(false);
    const [chatScope, setChatScope] = useState<ChatScope>("all");
    const [libraryDocs, setLibraryDocs] = useState<LibraryDoc[]>([]);
    const [selectedDocIds, setSelectedDocIds] = useState<string[]>([]);
    const [sessionId, setSessionId] = useState<string | undefined>();
    const [sessions, setSessions] = useState<ChatSessionSummary[]>([]);
    const [sessionsLoading, setSessionsLoading] = useState(false);
    const [renamingId, setRenamingId] = useState<string | null>(null);
    const [renameDraft, setRenameDraft] = useState("");
    const [renameSaving, setRenameSaving] = useState(false);
    const renameInputRef = useRef<HTMLInputElement>(null);
    const headerMenuRef = useRef<HTMLDivElement>(null);
    const [docSearch, setDocSearch] = useState("");
    const [docStatusFilter, setDocStatusFilter] = useState<DocStatusFilter>("");
    const [focusedExcerpt, setFocusedExcerpt] = useState("");
    const [selPopover, setSelPopover] = useState<{ text: string; x: number; y: number } | null>(null);
    const [copiedId, setCopiedId] = useState<string | null>(null);
    const [expandedCitation, setExpandedCitation] = useState<string | null>(null);
    const [feedbackState, setFeedbackState] = useState<Record<string, 'like' | 'dislike' | null>>({});
    const [sessionSearch, setSessionSearch] = useState("");
    const [uploadingTxtId, setUploadingTxtId] = useState<string | null>(null);
    const [modelOptions, setModelOptions] = useState<ChatModelOption[]>([]);
    const [selectedModelKey, setSelectedModelKey] = useState("");
    const bottomRef = useRef<HTMLDivElement>(null);
    const msgsContainerRef = useRef<HTMLDivElement>(null);
    const abortRef = useRef<AbortController | null>(null);
    const streamRevealRef = useRef<{ cancelled: boolean }>({ cancelled: false });
    const [analyticsVisuals, setAnalyticsVisuals] = useState<ChatVisualSpec[]>([]);
    const [analyticsAgentId, setAnalyticsAgentId] = useState<string | undefined>();
    const chatAnalyticsLockRef = useRef(false);
    const [analyticsLoading, setAnalyticsLoading] = useState(false);
    const [analyticsView, setAnalyticsView] = useState<AnalyticsPanelView>("overview");
    const [analyticsDocCount, setAnalyticsDocCount] = useState<number | undefined>();
    const [analyticsCoverage, setAnalyticsCoverage] = useState<FinanceAnalyticsCoverage | null>(null);
    const [analyticsScopeMode, setAnalyticsScopeMode] = useState<"all" | "selected">("all");
    const [chatContextDocIds, setChatContextDocIds] = useState<string[]>([]);
    const lastPromptRef = useRef<string>("");
    const prevAgentUrlRef = useRef<string | null>(null);
    const prevPathRef = useRef<string | null>(null);
    const deepLinkAppliedRef = useRef(false);

    // Render-safe mirror of lastPromptRef: whether the last exchange has a user
    // prompt to replay. Derives from state so the UI never reads a ref during render.
    const hasRegenerablePrompt = useMemo(() => {
        if (!messages.length) return false;
        const last = messages[messages.length - 1];
        if (!last) return false;
        if (last.role === "user") return Boolean((last.content || "").trim());
        const priorUser = [...messages]
            .slice(0, -1)
            .reverse()
            .find((m) => m.role === "user");
        return Boolean(priorUser && (priorUser.content || "").trim());
    }, [messages]);

    const pythonToNode = new Map(
        libraryDocs.filter((d) => d.pythonDocumentId).map((d) => [d.pythonDocumentId as string, d.documentId])
    );

    const loadDocs = useCallback(() => {
        apiRequest("/docs/documents?limit=100")
            .then((data) => {
                const docs = (data?.data?.documents || []).map((d: any) => ({
                    documentId: d.documentId,
                    originalFilename: d.originalFilename,
                    status: d.status,
                    pythonDocumentId: d.pythonDocumentId,
                    classification: d.classification,
                    mimeType: d.mimeType,
                    metadata: d.metadata
                        ? {
                              phase3Agent: d.metadata.phase3Agent,
                              cvScore: d.metadata.cvScore,
                          }
                        : null,
                }));
                setLibraryDocs(docs);
            })
            .catch(() => setLibraryDocs([]));
    }, []);

    const loadSessions = useCallback(async () => {
        setSessionsLoading(true);
        try {
            const data = await apiRequest("/docs/chat/sessions");
            setSessions(data?.data?.sessions || []);
        } catch {
            setSessions([]);
        } finally {
            setSessionsLoading(false);
        }
    }, []);

    const loadModels = useCallback(async () => {
        try {
            const data = await apiRequest("/docs/chat/models");
            const models = Array.isArray(data?.data?.models) ? data.data.models : [];
            const primary = data?.data?.primary;
            setModelOptions(models);
            const primaryKey =
                primary?.provider && primary?.model ? `${primary.provider}::${primary.model}` : "";
            setSelectedModelKey((current) =>
                current && models.some((m: ChatModelOption) => `${m.provider}::${m.model}` === current)
                    ? current
                    : primaryKey
            );
        } catch {
            setModelOptions([]);
        }
    }, []);

    useEffect(() => {
        loadDocs();
        loadSessions();
        loadModels();
    }, [loadDocs, loadSessions, loadModels]);

    // Refresh library when returning to chat (uploads finish on Documents page)
    useEffect(() => {
        const onFocus = () => loadDocs();
        const onVis = () => {
            if (document.visibilityState === "visible") loadDocs();
        };
        window.addEventListener("focus", onFocus);
        document.addEventListener("visibilitychange", onVis);
        return () => {
            window.removeEventListener("focus", onFocus);
            document.removeEventListener("visibilitychange", onVis);
        };
    }, [loadDocs]);

    // While anything is still processing, re-list so phase3Agent heal + ready status show up
    useEffect(() => {
        const pending = libraryDocs.some((d) => {
            if (!d.pythonDocumentId) return false;
            if (d.status === "processing" || d.status === "uploaded") return true;
            // Classified but missing clamped agent → chat may wrongly hide as off-plan
            return Boolean(d.classification) && !d.metadata?.phase3Agent;
        });
        if (!pending) return;
        const t = window.setInterval(() => loadDocs(), 8000);
        return () => window.clearInterval(t);
    }, [libraryDocs, loadDocs]);

    const searchParams = useSearchParams();
    const agentUrlParam = searchParams?.get("agent");

    const showDocumentsRail = documentsPanelOpen;
    const showAnalyticsRail =
        analyticsPanelOpen &&
        (ANALYTICS_AGENT_IDS.has(analyticsAgentId || "") ||
            ANALYTICS_AGENT_IDS.has(agentUrlParam || ""));

    const chatColumnMax = showAnalyticsRail ? "max-w-none w-full" : "max-w-3xl";

    const closeDocumentsPanel = useCallback(() => setDocumentsPanelOpen(false), []);

    const toggleDocumentsRail = useCallback(() => {
        setDocumentsPanelOpen((open) => {
            const next = !open;
            if (next) setAnalyticsPanelOpen(false);
            if (next && typeof window !== "undefined" && !window.matchMedia("(min-width: 1024px)").matches) {
                setSidebarOpen(false);
            }
            return next;
        });
    }, []);

    const openDocumentsRail = useCallback(() => {
        setDocumentsPanelOpen(true);
        setAnalyticsPanelOpen(false);
        if (typeof window !== "undefined" && !window.matchMedia("(min-width: 1024px)").matches) {
            setSidebarOpen(false);
        }
    }, []);

    useEffect(() => {
        if (!agentUrlParam || !ANALYTICS_AGENT_IDS.has(agentUrlParam)) return;
        setAnalyticsAgentId(agentUrlParam);
        const prev = prevAgentUrlRef.current;
        prevAgentUrlRef.current = agentUrlParam;
        if (prev !== null && prev !== agentUrlParam) {
            setAnalyticsView("overview");
            setAnalyticsVisuals([]);
            chatAnalyticsLockRef.current = false;
            setChatContextDocIds([]);
        }
    }, [agentUrlParam]);

    // Dashboard fetch only when user changes tab or hits Refresh — not on panel open / agent entry.
    const loadAgentAnalytics = useCallback(
        async (agentId: string, view: AnalyticsPanelView = "overview", scopeDocIds?: string[]) => {
            if (!ANALYTICS_AGENT_IDS.has(agentId)) return;
            setAnalyticsLoading(true);
            try {
                const params = new URLSearchParams({ agent: agentId });
                if (agentId === "finance_agent" && view !== "overview") {
                    params.set("view", view);
                }
                if (agentId === "hr_agent" && view !== "overview") {
                    params.set("view", view);
                }
                if (agentId === "compliance_agent" && view !== "overview") {
                    params.set("view", view);
                }
                if (
                    (agentId === "legal_agent" ||
                        agentId === "procurement_agent" ||
                        agentId === "other_agent") &&
                    view !== "overview"
                ) {
                    params.set("view", view);
                }
                if (scopeDocIds?.length) {
                    params.set("documentIds", scopeDocIds.join(","));
                }
                const data = await apiRequest(`/docs/chat/analytics?${params.toString()}`);
                const visuals = Array.isArray(data?.data?.visuals)
                    ? (data.data.visuals as ChatVisualSpec[])
                    : [];
                setAnalyticsVisuals(visuals);
                setAnalyticsAgentId(agentId);
                const count = data?.data?.documentCount;
                setAnalyticsDocCount(typeof count === "number" ? count : undefined);
                const cov = data?.data?.coverage;
                setAnalyticsCoverage(cov && typeof cov === "object" ? (cov as FinanceAnalyticsCoverage) : null);
                const mode = data?.data?.scopeMode;
                setAnalyticsScopeMode(mode === "selected" ? "selected" : "all");
            } catch {
                setAnalyticsVisuals([]);
                setAnalyticsDocCount(undefined);
            } finally {
                setAnalyticsLoading(false);
            }
        },
        []
    );

    const analyticsScopeDocIds = useMemo(() => {
        const selected =
            chatScope === "selected" && selectedDocIds.length
                ? filterAnalyticsScopeDocIds(libraryDocs, selectedDocIds)
                : [];
        const cited = chatContextDocIds.filter(
            (id) => filterAnalyticsScopeDocIds(libraryDocs, [id]).length > 0
        );
        let merged = [...new Set([...selected, ...cited])];
        if (agentUrlParam) {
            merged = filterDocIdsForAgent(libraryDocs, merged, agentUrlParam);
        }
        return merged.length ? merged : undefined;
    }, [chatScope, selectedDocIds, libraryDocs, chatContextDocIds, agentUrlParam]);

    const openAnalyticsPanel = useCallback(
        (fetchDashboard = false) => {
            setAnalyticsPanelOpen(true);
            setDocumentsPanelOpen(false);
            if (fetchDashboard && !chatAnalyticsLockRef.current) {
                const aid = analyticsAgentId || agentUrlParam;
                if (aid && ANALYTICS_AGENT_IDS.has(aid)) {
                    void loadAgentAnalytics(aid, analyticsView, analyticsScopeDocIds);
                }
            }
        },
        [agentUrlParam, analyticsAgentId, analyticsView, analyticsScopeDocIds, loadAgentAnalytics]
    );

    const handleAnalyticsViewChange = useCallback(
        (view: AnalyticsPanelView) => {
            chatAnalyticsLockRef.current = false;
            setAnalyticsView(view);
            const aid = analyticsAgentId || agentUrlParam;
            if (aid && ANALYTICS_AGENT_IDS.has(aid)) {
                void loadAgentAnalytics(aid, view, analyticsScopeDocIds);
            }
        },
        [agentUrlParam, analyticsAgentId, analyticsScopeDocIds, loadAgentAnalytics]
    );
    const isNewChatReq = searchParams?.get("new") === "1" || searchParams?.get("new") === "true";

    useEffect(() => {
        if (isNewChatReq) {
            setSessionId(undefined);
            setMessages([WELCOME_MSG]);
            setFocusedExcerpt("");
        }
    }, [isNewChatReq, agentUrlParam]);

    useEffect(() => {
        if (isNewChatReq) return;
        if (!agentUrlParam) return;
        const financeWelcome: ChatMessage = {
            id: "welcome",
            role: "assistant",
            content:
                "I analyze finance files in scope as **AP (vendors)** and **AR (clients)** — spend, aging, trends, line items. Ask me to **generate a finance report** for a printable PDF. Name a file to focus on one invoice. Configure aliases/FX in Admin → Settings → Finance analytics.",
        };
        const hrWelcome: ChatMessage = {
            id: "welcome",
            role: "assistant",
            content:
                "Ask me any **HR work** in plain language — leave, certificates, onboarding, payroll, attendance, performance, hiring/CVs, or letters (joining, internship, training certificate, offer, promotion). I’ll pick the right skill from your scoped documents.",
        };
        const complianceWelcome: ChatMessage = {
            id: "welcome",
            role: "assistant",
            content:
                "Ask any **compliance work** in plain language — expiry, findings, status, missing docs, or generate a **compliance report** / certificate report / NCR·CAPA letter. Upload files, wait until **ready**, select them in scope, then ask.",
        };
        const procurementWelcome: ChatMessage = {
            id: "welcome",
            role: "assistant",
            content:
                "Select POs, quotations, or RFQs in scope. I can chart supplier amounts and **PO vs invoice** totals when those fields are extracted.",
        };
        const legalWelcome: ChatMessage = {
            id: "welcome",
            role: "assistant",
            content:
                "Select contracts in scope. I can chart **risk flags**, **clause type mix**, and values by party when extractions include those fields.",
        };
        const byAgent: Record<string, ChatMessage> = {
            finance_agent: financeWelcome,
            hr_agent: hrWelcome,
            compliance_agent: complianceWelcome,
            procurement_agent: procurementWelcome,
            legal_agent: legalWelcome,
        };
        const next = byAgent[agentUrlParam];
        if (!next) return;
        setMessages((prev) => {
            if (prev.length !== 1 || prev[0].id !== "welcome") return prev;
            return [next];
        });
    }, [agentUrlParam, isNewChatReq]);

    // Drop off-agent selections when switching agents
    useEffect(() => {
        if (!agentUrlParam) return;
        setSelectedDocIds((prev) => {
            const next = filterDocIdsForAgent(libraryDocs, prev, agentUrlParam);
            return next.length === prev.length && next.every((id, i) => id === prev[i]) ? prev : next;
        });
    }, [agentUrlParam, libraryDocs]);

    useEffect(() => {
        if (!agentUrlParam || !libraryDocs.length) return;
        const matchingDocs = libraryDocs.filter((d) => resolveDocAgent(d) === agentUrlParam);
        const scoped =
            agentUrlParam === "finance_agent"
                ? matchingDocs.filter((d) => isFinanceAnalyticsDoc(d))
                : agentUrlParam === "compliance_agent"
                  ? matchingDocs.filter((d) => isComplianceAnalyticsDoc(d))
                  : matchingDocs;
        if (scoped.length > 0) {
            setSelectedDocIds(scoped.map((d) => d.documentId));
            setChatScope("selected");
        } else {
            setSelectedDocIds([]);
            setChatScope("selected");
        }
    }, [agentUrlParam, libraryDocs]);

    useEffect(() => {
        const mq = window.matchMedia("(min-width: 1024px)");
        const apply = () => setIsLg(mq.matches);
        apply();
        mq.addEventListener("change", apply);
        return () => mq.removeEventListener("change", apply);
    }, []);

    useEffect(() => {
        if (!sidebarOpen) return;
        const onKey = (e: KeyboardEvent) => {
            if (e.key === "Escape") setSidebarOpen(false);
        };
        document.addEventListener("keydown", onKey);
        return () => document.removeEventListener("keydown", onKey);
    }, [sidebarOpen]);

    useEffect(() => {
        if (!showDocumentsRail) return;
        const onKey = (e: KeyboardEvent) => {
            if (e.key === "Escape") closeDocumentsPanel();
        };
        document.addEventListener("keydown", onKey);
        return () => document.removeEventListener("keydown", onKey);
    }, [showDocumentsRail, closeDocumentsPanel]);

    useEffect(() => {
        const el = msgsContainerRef.current;
        if (!el) return;
        const behavior = sending ? "auto" : "smooth";
        const frame = window.requestAnimationFrame(() => {
            el.scrollTo({ top: el.scrollHeight, behavior });
        });
        return () => window.cancelAnimationFrame(frame);
    }, [messages, sending]);

    useEffect(() => {
        return () => abortRef.current?.abort();
    }, []);

    const isInsideAssistant = (node: Node | null): boolean => {
        while (node) {
            if ((node as HTMLElement).dataset?.role === "assistant") return true;
            node = node.parentNode;
        }
        return false;
    };

    const handleSelection = () => {
        const sel = window.getSelection();
        if (!sel || sel.isCollapsed) {
            setSelPopover(null);
            return;
        }
        const text = sel.toString().trim();
        if (!text) {
            setSelPopover(null);
            return;
        }
        if (!isInsideAssistant(sel.anchorNode) || !isInsideAssistant(sel.focusNode)) {
            setSelPopover(null);
            return;
        }
        const rect = sel.getRangeAt(0).getBoundingClientRect();
        setSelPopover({ text, x: rect.left + rect.width / 2, y: rect.top - 8 });
    };

    const startExcerptQuestion = () => {
        if (!selPopover) return;
        setFocusedExcerpt(selPopover.text);
        setSelPopover(null);
        window.getSelection()?.removeAllRanges();
    };

    useEffect(() => {
        if (!selPopover) return;
        const handler = (e: MouseEvent) => {
            const t = e.target as HTMLElement;
            if (t?.closest?.("[data-popover-btn]")) return;
            if (msgsContainerRef.current && !msgsContainerRef.current.contains(t)) {
                setSelPopover(null);
            }
        };
        document.addEventListener("mousedown", handler);
        return () => document.removeEventListener("mousedown", handler);
    }, [selPopover]);

    useEffect(() => {
        if (!headerMenuOpen) return;
        const handler = (e: MouseEvent) => {
            if (headerMenuRef.current?.contains(e.target as Node)) return;
            setHeaderMenuOpen(false);
        };
        const onKey = (e: KeyboardEvent) => {
            if (e.key === "Escape") setHeaderMenuOpen(false);
        };
        document.addEventListener("mousedown", handler);
        document.addEventListener("keydown", onKey);
        return () => {
            document.removeEventListener("mousedown", handler);
            document.removeEventListener("keydown", onKey);
        };
    }, [headerMenuOpen]);

    // Only docs processed by AI AND covered by the user's plan agents
    const selectableDocs = useMemo(
        () =>
            libraryDocs.filter((d) => {
                if (!d.pythonDocumentId) return false;
                return isAgentAllowed(resolveDocAgent(d));
            }),
        [libraryDocs, isAgentAllowed]
    );

    // Drop selections that are no longer on-plan (e.g. after entitlement load)
    useEffect(() => {
        setSelectedDocIds((prev) => {
            const allowed = new Set(selectableDocs.map((d) => d.documentId));
            const next = prev.filter((id) => allowed.has(id));
            return next.length === prev.length ? prev : next;
        });
    }, [selectableDocs]);

    const agentIdFromScope = useMemo(() => {
        if (chatScope === "selected" && selectedDocIds.length) {
            const selected = libraryDocs.filter((d) => selectedDocIds.includes(d.documentId));
            const agents = new Set(selected.map((d) => resolveDocAgent(d)));
            if (agents.size === 1) {
                const only = [...agents][0];
                if (only && only !== "other_agent" && isAgentAllowed(only)) return only;
            }
        }
        return null;
    }, [chatScope, selectedDocIds, libraryDocs, isAgentAllowed]);

    const filteredDocs = selectableDocs.filter((doc) => {
        if (agentUrlParam && resolveDocAgent(doc) !== agentUrlParam) return false;
        // Extra guard: never list files for agents outside plan
        if (!isAgentAllowed(resolveDocAgent(doc))) return false;
        const q = docSearch.trim().toLowerCase();
        if (q && !doc.originalFilename.toLowerCase().includes(q)) return false;
        if (docStatusFilter === "ready" && doc.status !== "ready") return false;
        if (docStatusFilter === "processing" && doc.status !== "processing" && doc.status !== "uploaded") return false;
        if (docStatusFilter === "failed" && doc.status !== "failed") return false;
        return true;
    });

    const visibleSessions = agentUrlParam
        ? sessions.filter((s) => {
              const docIds = s.document_ids || [];
              if (!docIds.length) return true;
              return docIds.some((id) => {
                  const doc = libraryDocs.find((d) => d.pythonDocumentId === id || d.documentId === id);
                  return doc ? resolveDocAgent(doc) === agentUrlParam : true;
              });
          })
        : sessions;

    const unprocessedCount = libraryDocs.filter((d) => !d.pythonDocumentId).length;
    const offPlanCount = libraryDocs.filter(
        (d) => d.pythonDocumentId && !isAgentAllowed(resolveDocAgent(d))
    ).length;

    const toggleDoc = (id: string) => {
        setSelectedDocIds((prev) =>
            prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]
        );
    };

    const toggleFolder = (ids: string[]) => {
        setSelectedDocIds((prev) => {
            const set = new Set(prev);
            const allSelected = ids.every((id) => set.has(id));
            if (allSelected) {
                ids.forEach((id) => set.delete(id));
            } else {
                ids.forEach((id) => set.add(id));
            }
            return [...set];
        });
    };

    const selectAllFiltered = () => {
        setSelectedDocIds(filteredDocs.map((d) => d.documentId));
    };

    const clearSelection = () => setSelectedDocIds([]);

    const focusScopeDoc = (id: string) => {
        setChatScope("selected");
        setSelectedDocIds([id]);
    };

    const startNewChat = () => {
        setSessionId(undefined);
        setMessages([WELCOME_MSG]);
        setFocusedExcerpt("");
        setAnalyticsVisuals([]);
        chatAnalyticsLockRef.current = false;
        localStorage.removeItem(LAST_SESSION_KEY);
    };

    // New chat when entering AI Chat from another app section (not when remounting on /chat)
    useEffect(() => {
        if (!pathname?.startsWith("/chat")) {
            prevPathRef.current = pathname;
            return;
        }
        const from = prevPathRef.current;
        prevPathRef.current = pathname;
        // ChatGPT-style: history sidebar starts closed; open via panel icon
        setSidebarOpen(false);
        void loadSessions();
        if (from === null || !from.startsWith("/chat")) {
            setSessionId(undefined);
            setMessages([WELCOME_MSG]);
            setFocusedExcerpt("");
            localStorage.removeItem(LAST_SESSION_KEY);
        }
    }, [pathname, loadSessions]);

    useEffect(() => {
        if (deepLinkAppliedRef.current || typeof window === "undefined") return;
        const targetId = new URLSearchParams(window.location.search).get("documentId");
        if (!targetId) return;
        if (!libraryDocs.length) return;

        deepLinkAppliedRef.current = true;
        const applyTarget = async () => {
            let target = libraryDocs.find((doc) => doc.documentId === targetId);
            if (!target) {
                try {
                    const response = await apiRequest(`/docs/documents/${targetId}`);
                    const raw = response?.data?.document || response?.data;
                    if (raw?.documentId) {
                        target = {
                            documentId: raw.documentId,
                            originalFilename: raw.originalFilename,
                            status: raw.status,
                            pythonDocumentId: raw.pythonDocumentId,
                            classification: raw.classification,
                            mimeType: raw.mimeType,
                            metadata: raw.metadata
                                ? {
                                      phase3Agent: raw.metadata.phase3Agent,
                                      cvScore: raw.metadata.cvScore,
                                  }
                                : null,
                        };
                        setLibraryDocs((current) =>
                            current.some((doc) => doc.documentId === raw.documentId)
                                ? current
                                : [target as LibraryDoc, ...current]
                        );
                    }
                } catch {
                    target = undefined;
                }
            }

            if (!target) {
                showToast("This document is not available in your chat library.", "error");
                return;
            }
            if (!target.pythonDocumentId) {
                showToast(
                    `"${target.originalFilename}" is still processing. Chat will be available when processing finishes.`,
                    "error"
                );
                return;
            }

            setSessionId(undefined);
            setMessages([WELCOME_MSG]);
            setFocusedExcerpt("");
            localStorage.removeItem(LAST_SESSION_KEY);
            setChatScope("selected");
            setSelectedDocIds([target.documentId]);
            setDocSearch("");
            setDocStatusFilter("");
            setDocumentsPanelOpen(false);
            showToast(`Chat is focused on "${target.originalFilename}".`, "success");
        };

        applyTarget();
    }, [libraryDocs, showToast]);

    const loadSession = async (id: string) => {
        try {
            const data = await apiRequest(`/docs/chat/sessions/${id}`);
            const session = data?.data?.session;
            if (!session) return;

            setSessionId(session.id);
            localStorage.setItem(LAST_SESSION_KEY, session.id);

            const pythonIds: string[] = session.document_ids || [];
            if (pythonIds.length) {
                setChatScope("selected");
                const nodeIds = pythonIds
                    .map((pid) => pythonToNode.get(pid))
                    .filter(Boolean) as string[];
                setSelectedDocIds(nodeIds);
            } else {
                setChatScope("all");
                setSelectedDocIds([]);
            }

            const msgs = mapSessionMessages(session.messages || [], libraryDocs, allowedIds);
            setMessages(msgs.length ? msgs : [WELCOME_MSG]);
            setFocusedExcerpt("");
        } catch (e: any) {
            setMessages([
                {
                    id: `e_${crypto.randomUUID()}`,
                    role: "assistant",
                    content: `Could not load chat: ${e.message || "unknown error"}`,
                },
            ]);
        }
    };

    const deleteSession = async (id: string, e: React.MouseEvent) => {
        e.stopPropagation();
        if (!confirm("Delete this chat permanently?")) return;
        try {
            await apiRequest(`/docs/chat/sessions/${id}`, { method: "DELETE" });
            if (sessionId === id) startNewChat();
            await loadSessions();
        } catch {
            /* ignore */
        }
    };

    const beginRename = (s: ChatSessionSummary, e?: React.MouseEvent) => {
        e?.stopPropagation();
        setRenamingId(s.id);
        setRenameDraft(s.title || "New Chat");
        setTimeout(() => {
            renameInputRef.current?.focus();
            renameInputRef.current?.select();
        }, 0);
    };

    const cancelRename = () => {
        setRenamingId(null);
        setRenameDraft("");
        setRenameSaving(false);
    };

    const saveRename = async (id: string) => {
        const title = renameDraft.trim();
        if (!title) {
            cancelRename();
            return;
        }
        const current = sessions.find((s) => s.id === id);
        if (current && (current.title || "New Chat") === title) {
            cancelRename();
            return;
        }
        setRenameSaving(true);
        try {
            const data = await apiRequest(`/docs/chat/sessions/${id}`, {
                method: "PATCH",
                body: JSON.stringify({ title }),
            });
            const nextTitle = data?.data?.session?.title || title;
            setSessions((prev) =>
                prev.map((s) => (s.id === id ? { ...s, title: nextTitle, updated_at: new Date().toISOString() } : s))
            );
            cancelRename();
        } catch {
            setRenameSaving(false);
        }
    };

    const sendWithText = async (text: string) => {
        const trimmed = text.trim();
        if (!trimmed || sending) return;
        if (chatScope === "selected" && !selectedDocIds.length && !isChitchatMessage(trimmed)) {
            setMessages((m) => [
                ...m,
                {
                    id: `e_${Date.now()}`,
                    role: "assistant",
                    content: "Select at least one processed document in Document scope before chatting.",
                },
            ]);
            openDocumentsRail();
            return;
        }

        lastPromptRef.current = trimmed;

        const userMsg: ChatMessage = {
            id: `u_${Date.now()}`,
            role: "user",
            content: focusedExcerpt
                ? `Regarding: “${focusedExcerpt.slice(0, 120)}${focusedExcerpt.length > 120 ? "…" : ""}”\n\n${trimmed}`
                : trimmed,
        };
        const assistantId = `a_${Date.now()}`;
        setMessages((m) => [
            ...m,
            userMsg,
            { id: assistantId, role: "assistant", content: "" },
        ]);
        setInput("");
        setSending(true);
        streamRevealRef.current = { cancelled: false };
        const controller = new AbortController();
        abortRef.current = controller;

        const patchAssistant = (id: string, patch: Partial<ChatMessage>) => {
            setMessages((m) => m.map((msg) => (msg.id === id ? { ...msg, ...patch } : msg)));
        };

        try {
            const activeProvider = localStorage.getItem("active_ai_provider") || undefined;
            const activeModel = localStorage.getItem("active_ai_model") || undefined;

            const body: Record<string, unknown> = {
                message: trimmed,
                chatScope,
                sessionId,
                provider: activeProvider,
                model: activeModel,
            };
            if (agentUrlParam && isAgentAllowed(agentUrlParam)) {
                body.phase3Agent = agentUrlParam;
            }
            if (chatScope === "selected") {
                const scopedIds = agentUrlParam
                    ? filterDocIdsForAgent(libraryDocs, selectedDocIds, agentUrlParam)
                    : selectedDocIds;
                body.documentIds = scopedIds;
                if (!agentUrlParam) {
                    const selected = libraryDocs.filter((d) => scopedIds.includes(d.documentId));
                    const agents = new Set(selected.map((d) => resolveDocAgent(d)));
                    if (agents.size === 1) {
                        const only = [...agents][0];
                        if (only && only !== "other_agent" && isAgentAllowed(only)) {
                            body.phase3Agent = only;
                        }
                    }
                }
                const selected = libraryDocs.filter((d) => scopedIds.includes(d.documentId));
                const types = new Set(
                    selected.map((d) => d.classification).filter((t): t is string => Boolean(t))
                );
                if (types.size === 1) body.documentType = [...types][0];
            }
            if (focusedExcerpt) body.selected_text = focusedExcerpt;
            const chosenModel = modelOptions.find(
                (m) => `${m.provider}::${m.model}` === selectedModelKey
            );
            if (chosenModel) {
                body.provider = chosenModel.provider;
                body.model = chosenModel.model;
            }
            const portfolioAsk =
                wantsPortfolioFinanceScope(trimmed) || wantsFinanceListAllScope(trimmed);
            const effectiveAgent =
                (typeof body.phase3Agent === "string" ? body.phase3Agent : undefined) || agentUrlParam;
            const financePortfolioIds =
                effectiveAgent === "finance_agent" ? listFinanceReadyDocIds(libraryDocs) : [];
            if (portfolioAsk && financePortfolioIds.length) {
                body.analyticsDocumentIds = financePortfolioIds;
            } else if (analyticsScopeDocIds?.length) {
                body.analyticsDocumentIds = analyticsScopeDocIds;
            }
            let focusFromLastTurn: string[] = [];
            for (const m of [...messages].reverse()) {
                if (m.role !== "assistant") continue;
                const ids = (m.citations || [])
                    .map((c) => c.documentId)
                    .filter((id): id is string => Boolean(id));
                if (ids.length) {
                    focusFromLastTurn = ids;
                    break;
                }
            }
            const focusIds = portfolioAsk
                ? []
                : [...new Set([...focusFromLastTurn, ...chatContextDocIds])]
                      .filter((id) => {
                          if (!effectiveAgent) return true;
                          const doc = libraryDocs.find((d) => d.documentId === id);
                          return doc ? resolveDocAgent(doc) === effectiveAgent : false;
                      })
                      .filter(Boolean);
            if (focusIds.length) {
                body.focusDocumentIds = focusIds.slice(0, 3);
            }

            if (messageMayUseAnalytics(trimmed, effectiveAgent)) {
                // Keep any existing chart visible; show loading over it.
                // Lock stays engaged so the dashboard effect doesn't overwrite
                // the response we're about to receive.
                chatAnalyticsLockRef.current = true;
                setAnalyticsLoading(true);
            }

            const data = await apiRequest("/docs/chat", {
                method: "POST",
                body: JSON.stringify(body),
                signal: controller.signal,
            });
            setFocusedExcerpt("");
            if (data?.data?.sessionId) {
                setSessionId(data.data.sessionId);
                localStorage.setItem(LAST_SESSION_KEY, data.data.sessionId);
                loadSessions();
                const firstMsg = trimmed.slice(0, 60);
                apiRequest(`/docs/chat/sessions/${data.data.sessionId}`, {
                    method: "PATCH",
                    body: JSON.stringify({ title: firstMsg }),
                }).catch(() => {});
            }

            const fullReply = data?.data?.reply || "No response.";
            const nextVisuals = Array.isArray(data?.data?.visuals) ? (data.data.visuals as ChatVisualSpec[]) : [];
            const userAskedForCharts = messageWantsAnalyticsPanel(trimmed, effectiveAgent);
            setAnalyticsLoading(false);
            if (
                userAskedForCharts &&
                data?.data?.model === "agent-analytics" &&
                effectiveAgent &&
                ANALYTICS_AGENT_IDS.has(effectiveAgent)
            ) {
                setAnalyticsPanelOpen(true);
                setDocumentsPanelOpen(false);
                setAnalyticsAgentId(effectiveAgent);
            }
            if (nextVisuals.length && userAskedForCharts) {
                chatAnalyticsLockRef.current = true;
                setAnalyticsVisuals(nextVisuals);
                setAnalyticsPanelOpen(true);
                setDocumentsPanelOpen(false);
                if (effectiveAgent && ANALYTICS_AGENT_IDS.has(effectiveAgent)) {
                    setAnalyticsAgentId(effectiveAgent);
                }
                const respView = data?.data?.analyticsView;
                if (typeof respView === "string") {
                    const allowed = new Set([
                        "overview",
                        "vendors",
                        "clients",
                        "trend",
                        "aging",
                        "mix",
                        "expiry",
                        "findings",
                        "cert_status",
                        "status_mix",
                        "scores",
                        "score_dist",
                        "onboarding",
                        "leave",
                        "payroll",
                        "attendance",
                        "directory",
                        "performance",
                        "transcript",
                        "risk",
                        "clauses",
                        "obligations",
                        "po_spend",
                        "po_status",
                        "doc_mix",
                        "missing",
                    ]);
                    if (allowed.has(respView)) {
                        setAnalyticsView(respView as AnalyticsPanelView);
                    }
                }
                const respCoverage = data?.data?.coverage;
                if (respCoverage && typeof respCoverage === "object") {
                    setAnalyticsCoverage(respCoverage as FinanceAnalyticsCoverage);
                }
                const respDocCount = data?.data?.documentCount;
                if (typeof respDocCount === "number") {
                    setAnalyticsDocCount(respDocCount);
                }
                const citIds = (data?.data?.citations || [])
                    .map((c: { documentId?: string }) => c.documentId)
                    .filter((id: string | undefined): id is string => Boolean(id));
                if (citIds.length) setChatContextDocIds(citIds);
            } else if (data?.data?.model === "agent-analytics") {
                // Handled by analytics router but returned no chart — release lock
                // so panel can refetch overview / respect subsequent asks.
                chatAnalyticsLockRef.current = false;
            }
            patchAssistant(assistantId, {
                agentId: data?.data?.agentId,
                visuals: nextVisuals.length ? nextVisuals : undefined,
            });
            const replyForChat =
                nextVisuals.length && userAskedForCharts
                    ? fullReply
                    : fullReply;
            await revealStreamText(
                assistantId,
                replyForChat,
                (id, content) => patchAssistant(id, { content }),
                streamRevealRef.current,
                controller.signal
            );
            let citations = resolveCitations(data?.data?.citations || [], libraryDocs, allowedIds);
            // If AI omitted sources but user asked with selected files, still show those files
            if (!citations.length && chatScope === "selected" && selectedDocIds.length) {
                citations = resolveCitations(
                    selectedDocIds.map((id) => ({ documentId: id })),
                    libraryDocs,
                    allowedIds
                );
            }
            patchAssistant(assistantId, {
                citations,
                agentId: data?.data?.agentId,
                aiProvider: data?.data?.aiProvider,
                aiModel: data?.data?.aiModel,
                chartData: userAskedForCharts ? data?.data?.chartData : undefined,
            });
            // Track only what this turn discussed — never the full scope (breaks "chart of that")
            if (citations.length) {
                const fromCitations = citations
                    .map((c) => c.documentId)
                    .filter((id): id is string => Boolean(id));
                if (fromCitations.length) setChatContextDocIds(fromCitations);
            }
        } catch (e: unknown) {
            if (e instanceof Error && e.name === "AbortError") {
                patchAssistant(assistantId, { content: "Response stopped." });
                return;
            }
            patchAssistant(assistantId, {
                content: `Error: ${formatChatError(e)}`,
            });
        } finally {
            abortRef.current = null;
            setSending(false);
            setAnalyticsLoading(false);
        }
    };

    const send = () => sendWithText(input);

    const regenerateLast = () => {
        const prompt = lastPromptRef.current;
        if (!prompt || sending) return;
        setMessages((m) => {
            const copy = [...m];
            if (copy.length && copy[copy.length - 1].role === "assistant") copy.pop();
            if (copy.length && copy[copy.length - 1].role === "user") copy.pop();
            return copy;
        });
        void sendWithText(prompt);
    };

    const stopSending = () => {
        streamRevealRef.current.cancelled = true;
        abortRef.current?.abort();
    };

    const copyReply = async (msg: ChatMessage) => {
        try {
            await navigator.clipboard.writeText(msg.content || "");
            setCopiedId(msg.id);
            window.setTimeout(() => {
                setCopiedId((current) => (current === msg.id ? null : current));
            }, 1800);
        } catch {
            /* ignore */
        }
    };

    const toggleFeedback = async (msg: ChatMessage, msgIndex: number, newType: 'like' | 'dislike') => {
        const current = feedbackState[msg.id];
        const type = current === newType ? null : newType;
        setFeedbackState((prev) => ({ ...prev, [msg.id]: type }));
        try {
            await apiRequest("/docs/chat/feedback", {
                method: "POST",
                body: JSON.stringify({ sessionId, messageIndex: msgIndex, type: newType }),
            });
        } catch {
            setFeedbackState((prev) => ({ ...prev, [msg.id]: current }));
        }
    };

    const exportToPdf = () => {
        const lines: string[] = [];
        lines.push(`DocuGemma AI — Chat Export`);
        lines.push(`Date: ${new Date().toLocaleString()}`);
        const s = sessions.find((x) => x.id === sessionId);
        if (s?.title) lines.push(`Session: ${s.title}`);
        lines.push("");
        for (const m of messages) {
            if (m.id === "welcome") continue;
            lines.push(`[${m.role === "user" ? "You" : "AI"}]:`);
            lines.push((m.content || "").trim());
            lines.push("");
        }
        const text = lines.join("\n");
        const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `chat-export-${s?.title || "session"}-${new Date().toISOString().slice(0, 10)}.txt`;
        a.click();
        URL.revokeObjectURL(url);
    };

    const agentColorMap: Record<string, string> = {
        finance_agent: "bg-emerald-100 text-emerald-700 border-emerald-200",
        procurement_agent: "bg-amber-100 text-amber-700 border-amber-200",
        hr_agent: "bg-purple-100 text-purple-700 border-purple-200",
        legal_agent: "bg-indigo-100 text-indigo-700 border-indigo-200",
        compliance_agent: "bg-rose-100 text-rose-700 border-rose-200",
        other_agent: "bg-slate-100 text-slate-600 border-slate-200",
    };

    const uploadTxtToIntegration = async (text: string, filename: string, trackId: string) => {
        const body = text.trim();
        if (!body) {
            showToast("Nothing to send", "error");
            return;
        }
        setUploadingTxtId(trackId);
        try {
            const connRes = await apiRequest("/docs/integrations");
            const connections = (connRes?.data?.connections || []).filter(
                (c: any) => c.isActive
            );
            const drive =
                connections.find((c: any) => c.providerId === "google_drive" && c.supportsFolderSend) ||
                connections.find((c: any) => c.providerId === "google_drive") ||
                connections.find((c: any) => c.hasOutboundWebhook) ||
                connections[0];
            if (!drive?.connectionId) {
                showToast(
                    "No active integration. Connect Google Drive under Integrations first.",
                    "error"
                );
                return;
            }

            const file = new File([body], filename, { type: "text/plain" });
            const form = new FormData();
            form.append("file", file);
            if (drive.supportsFolderSend || drive.providerId === "google_drive") {
                form.append("folder", "true");
            }
            if (drive.hasOutboundWebhook) {
                form.append("webhook", "true");
            }

            const data = await apiRequest(`/docs/integrations/${drive.connectionId}/upload`, {
                method: "POST",
                body: form,
            });
            showToast(
                data?.message || `Sent ${filename} to ${drive.label || "integration"}`,
                "success"
            );
        } catch (e: any) {
            showToast(e?.message || "Send to integration failed", "error");
        } finally {
            setUploadingTxtId(null);
        }
    };

    const uploadReplyAsFile = (msg: ChatMessage) => {
        const stamp = stampForFilename();
        void uploadTxtToIntegration(msg.content || "", `chat-reply-${stamp}.txt`, msg.id);
    };

    const uploadFullChatAsFile = () => {
        const text = formatChatThreadAsText(messages);
        if (!text.trim()) {
            showToast("No chat messages to send yet", "error");
            return;
        }
        const stamp = stampForFilename();
        void uploadTxtToIntegration(text, `chat-full-${stamp}.txt`, "full-chat");
    };

    const scopeLabel =
        chatScope === "all"
            ? agentUrlParam
                ? `All ${agentLabel(agentUrlParam)} docs (${filteredDocs.length})`
                : `All documents (${selectableDocs.length})`
            : `Selected (${selectedDocIds.length} of ${agentUrlParam ? filteredDocs.length : selectableDocs.length})`;

    const documentsBadge =
        chatScope === "selected" ? selectedDocIds.length : selectableDocs.length;

    const documentsHeaderButton = (
        <button
            type="button"
            onClick={() => {
                setHeaderMenuOpen(false);
                toggleDocumentsRail();
            }}
            aria-expanded={showDocumentsRail}
            aria-label="Documents"
            title="Choose documents for this chat"
            className={`inline-flex items-center gap-2 rounded-full border px-3 py-2 text-xs sm:text-sm transition-colors min-h-10 ${
                showDocumentsRail
                    ? "border-accent bg-accent-muted"
                    : "border-border bg-surface hover:border-[rgba(56,182,255,0.4)] hover:bg-accent-muted"
            }`}
        >
            <FileText size={14} className="text-accent shrink-0" />
            <span className={`hidden sm:inline font-medium ${colors.textPrimary}`}>Documents</span>
            <span className="inline-flex items-center justify-center min-w-5 h-5 px-1.5 rounded-full bg-accent/15 text-[10px] font-bold text-accent tabular-nums">
                {documentsBadge}
            </span>
        </button>
    );

    const documentsScopePanelProps = {
        open: true as const,
        onClose: closeDocumentsPanel,
        chatScope,
        onChatScopeChange: setChatScope,
        filteredDocs,
        selectedDocIds,
        onToggleDoc: toggleDoc,
        onToggleFolder: toggleFolder,
        onSelectAll: selectAllFiltered,
        onClearSelection: clearSelection,
        onFocusDoc: focusScopeDoc,
        docSearch,
        onDocSearchChange: setDocSearch,
        docStatusFilter,
        onDocStatusFilterChange: setDocStatusFilter,
        unprocessedCount,
        libraryCount: selectableDocs.length,
        selectableCount: selectableDocs.length,
        offPlanCount,
        textPrimary: colors.textPrimary,
        textMuted: colors.textMuted,
        textSecondary: colors.textSecondary,
        bgHover: colors.bgHover,
    };

    const isWelcomeOnly = messages.length === 1 && messages[0].id === "welcome";
    const canUploadChat = !isWelcomeOnly && messages.some((m) => m.id !== "welcome");
    const uploadingBusy = uploadingTxtId !== null;

    if (!canChat()) {
        return (
            <div className="h-full flex items-center justify-center p-8">
                <div className={`surface-card max-w-md p-6 text-center space-y-2 ${colors.textPrimary}`}>
                    <p className="text-lg font-semibold">Chat not available</p>
                    <p className={`text-sm ${colors.textMuted}`}>
                        You do not have Chat permission. Ask your admin to enable it for your account.
                    </p>
                </div>
            </div>
        );
    }

    return (
        <div className="h-full min-h-0 flex relative overflow-hidden">
            <button
                type="button"
                className={`lg:hidden fixed inset-0 z-30 bg-black/50 backdrop-blur-sm transition-opacity ${
                    sidebarOpen ? "opacity-100 pointer-events-auto" : "opacity-0 pointer-events-none"
                }`}
                aria-label="Close chats"
                onClick={() => setSidebarOpen(false)}
                tabIndex={sidebarOpen && !isLg ? 0 : -1}
            />

            <aside
                className={`w-[min(280px,85vw)] border-r border-border flex flex-col z-40
                    fixed inset-y-0 left-0 transition-transform duration-200 ease-out
                    lg:static lg:z-auto lg:shrink-0 lg:w-70
                    ${sidebarOpen ? "translate-x-0" : "-translate-x-full pointer-events-none lg:hidden lg:w-0 lg:border-0"}
                    ${
                        isDark
                            ? "bg-linear-to-b from-surface to-[rgba(12,20,30,0.95)]"
                            : "bg-linear-to-b from-white to-slate-50"
                    }`}
                aria-hidden={!sidebarOpen}
            >
                <div className="px-4 py-4 border-b border-border">
                    <div className="flex items-center justify-between gap-2">
                        <div className="flex items-center gap-1.5 min-w-0">
                            <button
                                type="button"
                                onClick={() => setSidebarOpen(false)}
                                className="btn-ghost rounded-lg p-2 min-h-9 min-w-9 flex items-center justify-center shrink-0"
                                aria-label="Close chats sidebar"
                                title="Close sidebar"
                            >
                                <PanelLeftClose size={18} />
                            </button>
                            <h2 className={`text-sm font-semibold tracking-tight ${colors.textPrimary}`}>Chats</h2>
                        </div>
                        <button
                            type="button"
                            onClick={() => {
                                startNewChat();
                            }}
                            className="btn-gradient rounded-lg px-2.5 py-1.5 text-xs inline-flex items-center gap-1 min-h-9"
                        >
                            <Plus size={12} /> New
                        </button>
                    </div>
                </div>
                <div className="px-4 pb-2">
                    <div className="relative">
                        <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-foreground-muted" />
                        <input
                            type="text"
                            placeholder="Search conversations…"
                            value={sessionSearch}
                            onChange={(e) => setSessionSearch(e.target.value)}
                            className="w-full rounded-lg border border-border bg-surface pl-8 pr-3 py-1.5 text-xs outline-none focus:border-accent text-foreground"
                        />
                    </div>
                </div>
                <div className="flex-1 min-h-0 overflow-y-auto py-2">
                    <button
                        type="button"
                        onClick={() => {
                            startNewChat();
                        }}
                        className={`mx-2 mb-2 flex w-[calc(100%-16px)] items-center gap-2 rounded-xl px-3 py-2.5 text-left text-sm font-medium transition-colors ${
                            !sessionId
                                ? "bg-accent-muted border border-[rgba(56,182,255,0.25)] text-accent"
                                : isDark
                                  ? "border border-transparent text-foreground-secondary hover:bg-white/4"
                                  : "border border-transparent text-foreground-secondary hover:bg-slate-100/80"
                        }`}
                    >
                        <Plus size={14} className="shrink-0" />
                        New chat
                    </button>
                    {sessionsLoading ? (
                        <p className={`px-4 py-3 text-xs ${colors.textMuted}`}>Loading chats…</p>
                    ) : visibleSessions.length === 0 ? (
                        <div className="px-4 py-8 text-center">
                            <MessageSquare size={22} className="mx-auto mb-2 text-accent opacity-60" />
                            <p className={`text-xs ${colors.textMuted}`}>No chats for this agent.</p>
                            <p className={`text-[11px] mt-1 ${colors.textMuted}`}>Start typing to create one.</p>
                        </div>
                    ) : (
                        visibleSessions
                            .filter((s) =>
                                !sessionSearch ||
                                (s.title || "New Chat").toLowerCase().includes(sessionSearch.toLowerCase())
                            )
                            .map((s) => {
                                const active = sessionId === s.id;
                                const isRenaming = renamingId === s.id;
                                return (
                                <div
                                    key={s.id}
                                    className={`group mx-2 mb-1 flex items-start gap-1 rounded-xl px-2 py-2 transition-colors ${
                                        active
                                            ? "bg-accent-muted border border-[rgba(56,182,255,0.25)]"
                                            : isDark
                                              ? "border border-transparent hover:bg-white/4"
                                              : "border border-transparent hover:bg-slate-100/80"
                                    }`}
                                >
                                    {isRenaming ? (
                                        <div className="flex-1 min-w-0 flex items-center gap-1 px-1">
                                            <MessageSquare
                                                size={14}
                                                className={`shrink-0 ${active ? "text-accent" : "text-foreground-muted"}`}
                                            />
                                            <input
                                                ref={renameInputRef}
                                                value={renameDraft}
                                                onChange={(e) => setRenameDraft(e.target.value)}
                                                maxLength={120}
                                                disabled={renameSaving}
                                                onClick={(e) => e.stopPropagation()}
                                                onKeyDown={(e) => {
                                                    if (e.key === "Enter") {
                                                        e.preventDefault();
                                                        void saveRename(s.id);
                                                    } else if (e.key === "Escape") {
                                                        e.preventDefault();
                                                        cancelRename();
                                                    }
                                                }}
                                                className="flex-1 min-w-0 rounded-lg border border-accent bg-surface px-2 py-1 text-xs font-medium outline-none ring-2 ring-(--accent-ring)"
                                                aria-label="Rename chat"
                                            />
                                            <button
                                                type="button"
                                                onClick={() => void saveRename(s.id)}
                                                disabled={renameSaving || !renameDraft.trim()}
                                                className="btn-ghost p-1.5 text-(--vb-blue) hover:text-(--vb-blue-bright) shrink-0 rounded-lg disabled:opacity-40"
                                                aria-label="Save name"
                                            >
                                                {renameSaving ? <Loader2 size={12} className="animate-spin" /> : <Check size={12} />}
                                            </button>
                                            <button
                                                type="button"
                                                onClick={cancelRename}
                                                disabled={renameSaving}
                                                className="btn-ghost p-1.5 text-foreground-muted hover:text-foreground shrink-0 rounded-lg"
                                                aria-label="Cancel rename"
                                            >
                                                <X size={12} />
                                            </button>
                                        </div>
                                    ) : (
                                        <>
                                            <button
                                                type="button"
                                                onClick={() => loadSession(s.id)}
                                                onDoubleClick={(e) => beginRename(s, e)}
                                                className="flex-1 flex items-start gap-2 min-w-0 text-left px-1 py-0.5"
                                            >
                                                <MessageSquare
                                                    size={14}
                                                    className={`shrink-0 mt-0.5 ${active ? "text-accent" : "text-foreground-muted"}`}
                                                />
                                                <div className="flex-1 min-w-0">
                                                    <p className={`${colors.textPrimary} line-clamp-2 text-xs font-medium leading-snug`}>
                                                        {s.title || "New Chat"}
                                                    </p>
                                                    <p className={`${colors.textMuted} mt-0.5 text-[10px]`}>
                                                        {s.updated_at || s.created_at
                                                            ? new Date(s.updated_at || s.created_at!).toLocaleString()
                                                            : ""}
                                                    </p>
                                                </div>
                                            </button>
                                            <button
                                                type="button"
                                                onClick={(e) => beginRename(s, e)}
                                                className="btn-ghost p-1.5 text-foreground-muted hover:text-accent shrink-0 rounded-lg opacity-70 sm:opacity-0 sm:group-hover:opacity-100 transition-opacity"
                                                aria-label="Rename chat"
                                                title="Rename"
                                            >
                                                <Pencil size={12} />
                                            </button>
                                            <button
                                                type="button"
                                                onClick={(e) => deleteSession(s.id, e)}
                                                className="btn-ghost p-1.5 text-rose-400/80 hover:text-rose-300 shrink-0 rounded-lg opacity-70 sm:opacity-0 sm:group-hover:opacity-100 transition-opacity"
                                                aria-label="Delete chat"
                                                title="Delete"
                                            >
                                                <Trash2 size={12} />
                                            </button>
                                        </>
                                    )}
                                </div>
                                );
                            })
                    )}
                </div>
            </aside>

            <div
                className={`flex-1 min-w-0 min-h-0 h-full flex flex-col overflow-hidden bg-linear-to-br from-transparent via-[rgba(56,182,255,0.02)] to-blue-600/4`}
            >
            {showAnalyticsRail && (
                <div className={`${WORKSPACE_SPLIT_HEADER} justify-between`}>
                    <button
                        type="button"
                        onClick={() => setSidebarOpen((o) => !o)}
                        className="btn-ghost rounded-lg p-2.5 min-h-11 min-w-11 flex items-center justify-center"
                        aria-label={sidebarOpen ? "Hide chats" : "Show chats"}
                        title={sidebarOpen ? "Hide chats" : "Show chats"}
                    >
                        {sidebarOpen ? <PanelLeftClose size={18} /> : <PanelLeft size={18} />}
                    </button>
                    <div
                        className={`h-9 w-9 sm:h-10 sm:w-10 rounded-xl flex items-center justify-center shrink-0 ${
                            isDark ? "bg-[rgba(56,182,255,0.15)] text-(--vb-blue-bright)" : "bg-[rgba(56,182,255,0.14)] text-(--vb-blue-dark)"
                        }`}
                    >
                        <Sparkles size={18} />
                    </div>
                    <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                            <h1 className={`text-base sm:text-xl font-bold tracking-tight ${colors.textPrimary}`}>
                                AI Chat
                            </h1>
                            {agentUrlParam && (
                                <>
                                    <span className="inline-flex items-center gap-1.5 rounded-full border border-[rgba(56,182,255,0.3)] bg-[rgba(56,182,255,0.1)] px-2.5 py-0.5 text-xs text-(--vb-blue-bright) font-semibold shrink-0">
                                        <span>{agentLabel(agentUrlParam)}</span>
                                        <button
                                            type="button"
                                            onClick={() => {
                                                const url = new URL(window.location.href);
                                                url.searchParams.delete("agent");
                                                url.searchParams.delete("new");
                                                window.history.replaceState({}, "", url.toString());
                                                window.dispatchEvent(new Event("popstate"));
                                            }}
                                            className="hover:text-rose-400 text-slate-400 p-0.5"
                                            title="Clear agent filter"
                                        >
                                            <X size={12} />
                                        </button>
                                    </span>
                                    {ANALYTICS_AGENT_IDS.has(agentUrlParam) && (
                                        <Link
                                            href={agentWorkspacePath(agentUrlParam)}
                                            className="hidden sm:inline-flex items-center gap-1 rounded-full border border-border bg-surface px-2.5 py-0.5 text-[11px] font-medium text-foreground-muted hover:text-accent hover:border-accent/40 transition-colors shrink-0"
                                        >
                                            <BarChart3 size={11} /> Insights
                                        </Link>
                                    )}
                                </>
                            )}
                        </div>
                        <p className={`text-xs sm:text-sm ${colors.textMuted} truncate hidden sm:block`}>
                            {showAnalyticsRail
                                ? "Charts follow your last analytics question or panel tabs"
                                : "Ask for a chart to open analytics"}
                        </p>
                    </div>
                    {documentsHeaderButton}
                    <button
                        type="button"
                        onClick={() => setAnalyticsPanelOpen(false)}
                        className="hidden sm:inline-flex items-center gap-1.5 rounded-full border border-accent bg-accent-muted px-3 py-2 text-xs sm:text-sm shrink-0 min-h-10 text-accent"
                        title="Hide analytics panel"
                    >
                        <BarChart3 size={14} className="shrink-0" />
                        <span className="font-medium">Analytics</span>
                    </button>
                    <button
                        type="button"
                        onClick={() => {
                            setHeaderMenuOpen(false);
                            setDocumentsPanelOpen(false);
                            startNewChat();
                        }}
                        className="inline-flex items-center gap-1.5 rounded-full border border-border bg-surface px-3 py-2 text-xs sm:text-sm shrink-0 min-h-10 transition-colors hover:border-[rgba(56,182,255,0.4)] hover:bg-accent-muted"
                    >
                        <Plus size={14} className="text-accent shrink-0" />
                        <span className={`hidden sm:inline font-medium ${colors.textPrimary}`}>New chat</span>
                    </button>
                    <div className="relative shrink-0" ref={headerMenuRef}>
                        <button
                            type="button"
                            onClick={() => {
                                setDocumentsPanelOpen(false);
                                setHeaderMenuOpen((o) => !o);
                            }}
                            aria-expanded={headerMenuOpen}
                            aria-haspopup="menu"
                            aria-label="More actions"
                            title="More actions"
                            className={`inline-flex items-center justify-center rounded-xl border min-h-10 min-w-10 transition-colors ${
                                headerMenuOpen
                                    ? "border-accent bg-accent-muted text-accent"
                                    : "border-border bg-surface text-foreground-muted hover:bg-accent-muted hover:text-accent"
                            }`}
                        >
                            <MoreHorizontal size={18} />
                        </button>
                        {headerMenuOpen && (
                            <div
                                role="menu"
                                className="absolute right-0 top-full mt-2 z-40 w-48 rounded-xl border border-border bg-surface shadow-xl py-1 animate-fade-in-up"
                            >
                                <button
                                    type="button"
                                    role="menuitem"
                                    disabled={!canUploadChat || uploadingBusy}
                                    onClick={() => {
                                        setHeaderMenuOpen(false);
                                        uploadFullChatAsFile();
                                    }}
                                    className={`w-full flex items-center gap-2.5 px-3 py-2.5 text-left text-sm transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${colors.textPrimary} hover:bg-accent-muted`}
                                    title="Send this chat as a .txt to the connected integration (Drive)"
                                >
                                    {uploadingTxtId === "full-chat" ? (
                                        <Loader2 size={14} className="animate-spin text-accent shrink-0" />
                                    ) : (
                                        <Upload size={14} className="text-accent shrink-0" />
                                    )}
                                    Send chat
                                </button>
                                <button
                                    type="button"
                                    role="menuitem"
                                    disabled={isWelcomeOnly}
                                    onClick={() => {
                                        setHeaderMenuOpen(false);
                                        exportToPdf();
                                    }}
                                    className={`w-full flex items-center gap-2.5 px-3 py-2.5 text-left text-sm transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${colors.textPrimary} hover:bg-accent-muted`}
                                    title="Export conversation as text file"
                                >
                                    <Download size={14} className="text-accent shrink-0" />
                                    Export
                                </button>
                            </div>
                        )}
                    </div>
                </div>
            )}
            <div
                className={`flex-1 min-h-0 grid overflow-hidden min-w-0 ${
                    showAnalyticsRail ? "lg:grid-cols-[minmax(0,1fr)_minmax(320px,42%)]" : "grid-cols-1"
                }`}
            >
            <div className="min-w-0 min-h-0 flex flex-col overflow-hidden border-border lg:border-r">
                {!showAnalyticsRail && (
                <div className="px-3 sm:px-6 lg:px-8 py-3 sm:py-4 border-b border-border shrink-0 flex flex-wrap items-center gap-2 sm:gap-3">
                    <button
                        type="button"
                        onClick={() => setSidebarOpen((o) => !o)}
                        className="btn-ghost rounded-lg p-2.5 min-h-11 min-w-11 flex items-center justify-center"
                        aria-label={sidebarOpen ? "Hide chats" : "Show chats"}
                        title={sidebarOpen ? "Hide chats" : "Show chats"}
                    >
                        {sidebarOpen ? <PanelLeftClose size={18} /> : <PanelLeft size={18} />}
                    </button>
                    <div
                        className={`h-9 w-9 sm:h-10 sm:w-10 rounded-xl flex items-center justify-center shrink-0 ${
                            isDark ? "bg-[rgba(56,182,255,0.15)] text-(--vb-blue-bright)" : "bg-[rgba(56,182,255,0.14)] text-(--vb-blue-dark)"
                        }`}
                    >
                        <Sparkles size={18} />
                    </div>
                    <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                            <h1 className={`text-base sm:text-xl font-bold tracking-tight ${colors.textPrimary}`}>AI Chat</h1>
                            {agentUrlParam && (
                                <>
                                    <span className="inline-flex items-center gap-1.5 rounded-full border border-[rgba(56,182,255,0.3)] bg-[rgba(56,182,255,0.1)] px-2.5 py-0.5 text-xs text-(--vb-blue-bright) font-semibold shrink-0">
                                        <span>Agent: {agentLabel(agentUrlParam)}</span>
                                        <button
                                            type="button"
                                            onClick={() => {
                                                const url = new URL(window.location.href);
                                                url.searchParams.delete("agent");
                                                url.searchParams.delete("new");
                                                window.history.replaceState({}, "", url.toString());
                                                window.dispatchEvent(new Event("popstate"));
                                            }}
                                            className="hover:text-rose-400 text-slate-400 p-0.5"
                                            title="Clear agent filter"
                                        >
                                            <X size={12} />
                                        </button>
                                    </span>
                                    {ANALYTICS_AGENT_IDS.has(agentUrlParam) && (
                                        <Link
                                            href={agentWorkspacePath(agentUrlParam)}
                                            className="hidden sm:inline-flex items-center gap-1 rounded-full border border-border bg-surface px-2.5 py-0.5 text-[11px] font-medium text-foreground-muted hover:text-accent hover:border-accent/40 transition-colors shrink-0"
                                        >
                                            <BarChart3 size={11} /> Insights
                                        </Link>
                                    )}
                                </>
                            )}
                        </div>
                        <p className={`text-xs sm:text-sm ${colors.textMuted} truncate hidden sm:block`}>
                            {agentUrlParam ? `Chatting with ${agentLabel(agentUrlParam)} documents` : "Ask questions across your document library"}
                        </p>
                    </div>
                    {documentsHeaderButton}
                    {(ANALYTICS_AGENT_IDS.has(agentUrlParam || "") || analyticsVisuals.length > 0) && (
                        <button
                            type="button"
                            onClick={() => {
                                if (showAnalyticsRail) setAnalyticsPanelOpen(false);
                                else openAnalyticsPanel(analyticsVisuals.length > 0);
                            }}
                            className={`hidden sm:inline-flex items-center gap-1.5 rounded-full border px-3 py-2 text-xs sm:text-sm shrink-0 min-h-10 transition-colors ${
                                showAnalyticsRail
                                    ? "border-accent bg-accent-muted text-accent"
                                    : "border-border bg-surface hover:border-[rgba(56,182,255,0.4)] hover:bg-accent-muted"
                            }`}
                            title={showAnalyticsRail ? "Hide analytics panel" : "Show analytics panel"}
                        >
                            <BarChart3 size={14} className="shrink-0" />
                            <span className="font-medium">Analytics</span>
                        </button>
                    )}
                    <button
                        type="button"
                        onClick={() => {
                            setHeaderMenuOpen(false);
                            setDocumentsPanelOpen(false);
                            startNewChat();
                        }}
                        className="inline-flex items-center gap-1.5 rounded-full border border-border bg-surface px-3 py-2 text-xs sm:text-sm shrink-0 min-h-10 transition-colors hover:border-[rgba(56,182,255,0.4)] hover:bg-accent-muted"
                    >
                        <Plus size={14} className="text-accent shrink-0" />
                        <span className={`hidden sm:inline font-medium ${colors.textPrimary}`}>New chat</span>
                    </button>
                    <div className="relative shrink-0" ref={headerMenuRef}>
                        <button
                            type="button"
                            onClick={() => {
                                setDocumentsPanelOpen(false);
                                setHeaderMenuOpen((o) => !o);
                            }}
                            aria-expanded={headerMenuOpen}
                            aria-haspopup="menu"
                            aria-label="More actions"
                            title="More actions"
                            className={`inline-flex items-center justify-center rounded-xl border min-h-10 min-w-10 transition-colors ${
                                headerMenuOpen
                                    ? "border-accent bg-accent-muted text-accent"
                                    : "border-border bg-surface text-foreground-muted hover:bg-accent-muted hover:text-accent"
                            }`}
                        >
                            <MoreHorizontal size={18} />
                        </button>
                        {headerMenuOpen && (
                            <div
                                role="menu"
                                className="absolute right-0 top-full mt-2 z-40 w-48 rounded-xl border border-border bg-surface shadow-xl py-1 animate-fade-in-up"
                            >
                                <button
                                    type="button"
                                    role="menuitem"
                                    disabled={!canUploadChat || uploadingBusy}
                                    onClick={() => {
                                        setHeaderMenuOpen(false);
                                        uploadFullChatAsFile();
                                    }}
                                    className={`w-full flex items-center gap-2.5 px-3 py-2.5 text-left text-sm transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${colors.textPrimary} hover:bg-accent-muted`}
                                    title="Send this chat as a .txt to the connected integration (Drive)"
                                >
                                    {uploadingTxtId === "full-chat" ? (
                                        <Loader2 size={14} className="animate-spin text-accent shrink-0" />
                                    ) : (
                                        <Upload size={14} className="text-accent shrink-0" />
                                    )}
                                    Send chat
                                </button>
                                <button
                                    type="button"
                                    role="menuitem"
                                    disabled={isWelcomeOnly}
                                    onClick={() => {
                                        setHeaderMenuOpen(false);
                                        exportToPdf();
                                    }}
                                    className={`w-full flex items-center gap-2.5 px-3 py-2.5 text-left text-sm transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${colors.textPrimary} hover:bg-accent-muted`}
                                    title="Export conversation as text file"
                                >
                                    <Download size={14} className="text-accent shrink-0" />
                                    Export
                                </button>
                            </div>
                        )}
                    </div>
                </div>
                )}

                <div className="flex-1 min-h-0 flex overflow-hidden min-w-0 relative">
                    <div className="flex-1 min-h-0 flex flex-col overflow-hidden min-w-0">
                <div
                    className="flex-1 min-h-0 overflow-y-auto"
                    ref={msgsContainerRef}
                    onMouseUp={handleSelection}
                >
                    <div className={`${chatColumnMax} mx-auto w-full px-4 sm:px-6 py-8 space-y-8 min-h-full flex flex-col ${!isWelcomeOnly ? "justify-end" : ""}`}>
                        {isWelcomeOnly ? (
                            <div className="flex-1 flex flex-col items-center justify-center text-center px-4 py-12 animate-fade-in-up">
                                <div className="h-14 w-14 rounded-2xl bg-accent-muted border border-[rgba(56,182,255,0.25)] flex items-center justify-center text-accent mb-4">
                                    <Sparkles size={26} />
                                </div>
                                <h2 className={`text-xl font-bold tracking-tight ${colors.textPrimary}`}>
                                    Ask your documents
                                </h2>
                                <p className={`text-sm mt-2 max-w-md ${colors.textMuted} leading-relaxed`}>
                                    Summaries, fields, comparisons — scoped to all files or a selection you choose.
                                </p>
                                <button
                                    type="button"
                                    onClick={openDocumentsRail}
                                    className="mt-5 btn-secondary rounded-full px-4 py-2 text-sm inline-flex items-center gap-2"
                                >
                                    <FileText size={14} className="text-accent" />
                                    Choose documents · {documentsBadge}
                                </button>
                                {agentUrlParam === "finance_agent" && !showAnalyticsRail && (
                                    <div className="mt-6 flex flex-wrap justify-center gap-2 max-w-lg">
                                        {[
                                            "Show AP vendor spend",
                                            "Chart invoice trend by month",
                                            "Generate finance report",
                                        ].map((prompt) => (
                                            <button
                                                key={prompt}
                                                type="button"
                                                onClick={() => {
                                                    setInput(prompt);
                                                    void sendWithText(prompt);
                                                }}
                                                className="rounded-full border border-border bg-surface px-3.5 py-1.5 text-xs font-medium text-foreground hover:border-accent hover:bg-accent-muted transition-colors"
                                            >
                                                {prompt}
                                            </button>
                                        ))}
                                    </div>
                                )}
                                {agentUrlParam === "hr_agent" && !showAnalyticsRail && (
                                    <div className="mt-6 flex flex-wrap justify-center gap-2 max-w-lg">
                                        {[
                                            "Score CVs in scope",
                                            "Generate HR report",
                                            "Generate certificate report",
                                            "Generate transcript report",
                                            "Any certificates expiring soon?",
                                            "Who's on leave?",
                                        ].map((prompt) => (
                                            <button
                                                key={prompt}
                                                type="button"
                                                onClick={() => {
                                                    setInput(prompt);
                                                    void sendWithText(prompt);
                                                }}
                                                className="rounded-full border border-border bg-surface px-3.5 py-1.5 text-xs font-medium text-foreground hover:border-accent hover:bg-accent-muted transition-colors"
                                            >
                                                {prompt}
                                            </button>
                                        ))}
                                    </div>
                                )}
                                {(agentUrlParam === "procurement_agent" ||
                                    agentUrlParam === "legal_agent" ||
                                    agentUrlParam === "compliance_agent") &&
                                    !showAnalyticsRail && (
                                    <div className="mt-6 flex flex-wrap justify-center gap-2 max-w-lg">
                                        {(agentUrlParam === "compliance_agent"
                                            ? [
                                                  "Chart certificate expiry",
                                                  "Show audit findings by severity",
                                                  "Generate compliance report",
                                              ]
                                            : agentUrlParam === "procurement_agent"
                                              ? ["Chart spend by supplier", "Document type mix in scope"]
                                              : ["Chart contract values by party", "Document type mix in scope"]
                                        ).map((prompt) => (
                                            <button
                                                key={prompt}
                                                type="button"
                                                onClick={() => {
                                                    setInput(prompt);
                                                    void sendWithText(prompt);
                                                }}
                                                className="rounded-full border border-border bg-surface px-3.5 py-1.5 text-xs font-medium text-foreground hover:border-accent hover:bg-accent-muted transition-colors"
                                            >
                                                {prompt}
                                            </button>
                                        ))}
                                    </div>
                                )}
                            </div>
                        ) : (
                            messages.map((msg, msgIdx) => {
                                const isLastMsg = messages[messages.length - 1]?.id === msg.id;
                                const hasText = Boolean((msg.content || "").trim());
                                const priorUserMsg = [...messages.slice(0, msgIdx)]
                                    .reverse()
                                    .find((m) => m.role === "user");
                                const showInlineChart =
                                    Boolean(msg.chartData) &&
                                    Boolean(
                                        priorUserMsg &&
                                            messageWantsAnalyticsPanel(
                                                priorUserMsg.content,
                                                msg.agentId
                                            )
                                    );
                                const isThinking =
                                    msg.role === "assistant" &&
                                    !hasText &&
                                    sending &&
                                    isLastMsg &&
                                    msg.id !== "welcome";
                                return (
                                <div
                                    key={msg.id}
                                    className={`flex w-full ${msg.role === "user" ? "justify-end" : "justify-start"}`}
                                >
                                    {msg.role === "assistant" ? (
                                        !(hasText || isThinking) ? null : (
                                        <div className="flex w-full min-w-0 gap-3 sm:gap-4">
                                            <div
                                                className={`mt-1 h-8 w-8 shrink-0 rounded-full flex items-center justify-center ${
                                                    isDark
                                                        ? "bg-[rgba(56,182,255,0.15)] text-(--vb-blue-bright)"
                                                        : "bg-[rgba(56,182,255,0.12)] text-(--vb-blue-dark)"
                                                }`}
                                                aria-hidden
                                            >
                                                <Sparkles size={15} />
                                            </div>
                                            <div className="flex flex-col items-start flex-1 min-w-0 gap-1.5">
                                            <div
                                                data-role="assistant"
                                                className={`w-full min-w-0 rounded-2xl border shadow-sm ${
                                                    isDark
                                                        ? "bg-(--vb-dark-3) border-(--vb-hairline) shadow-black/20"
                                                        : "bg-(--vb-paper) border-(--vb-line) shadow-(--vb-shadow-sm)"
                                                }`}
                                            >
                                                <div className={`chat-assistant-prose max-w-none px-4 sm:px-5 py-4 ${isDark ? "is-dark text-(--vb-color-fg-inverse)" : "text-(--vb-ink)"}`}>
                                                {isThinking ? (
                                                    <p className="text-slate-400 text-[15px] animate-pulse m-0">
                                                        Thinking…
                                                    </p>
                                                ) : (
                                                    <ReactMarkdown
                                                    remarkPlugins={[remarkGfm]}
                                                    components={{
                                                        p: ({ children }) => (
                                                            <p className="mb-3.5 last:mb-0 text-[14px] sm:text-[15px] leading-7">{children}</p>
                                                        ),
                                                        strong: ({ children }) => (
                                                            <strong className="font-semibold text-inherit">{children}</strong>
                                                        ),
                                                        h1: ({ children }) => (
                                                            <h1 className="text-lg font-bold mt-5 mb-3 leading-snug">{children}</h1>
                                                        ),
                                                        h2: ({ children }) => (
                                                            <h2 className="text-base font-bold mt-5 mb-2.5 leading-snug">{children}</h2>
                                                        ),
                                                        h3: ({ children }) => (
                                                            <h3 className="text-[15px] font-bold mt-4 mb-2 leading-snug">{children}</h3>
                                                        ),
                                                        hr: () => (
                                                            <hr className={`my-4 border-0 border-t ${isDark ? "border-white/10" : "border-slate-200"}`} />
                                                        ),
                                                        table: ({ children }) => (
                                                            <div className={`my-4 overflow-x-auto rounded-xl border ${isDark ? "border-white/10" : "border-slate-200"}`}>
                                                                <table className="min-w-full border-collapse text-sm">
                                                                    {children}
                                                                </table>
                                                            </div>
                                                        ),
                                                        thead: ({ children }) => (
                                                            <thead className={isDark ? "bg-white/8" : "bg-slate-100"}>{children}</thead>
                                                        ),
                                                        th: ({ children }) => (
                                                            <th className={`border-b px-3.5 py-2.5 text-left text-xs font-semibold ${isDark ? "border-white/10 text-slate-200" : "border-slate-200 text-slate-700"}`}>
                                                                {children}
                                                            </th>
                                                        ),
                                                        td: ({ children }) => (
                                                            <td className={`border-b px-3.5 py-2.5 align-top text-[13px] leading-relaxed ${isDark ? "border-white/8 text-slate-200" : "border-slate-100 text-slate-700"}`}>
                                                                {children}
                                                            </td>
                                                        ),
                                                        ul: ({ children }) => (
                                                            <ul className="list-disc pl-5 my-3 space-y-1.5 text-[14px] sm:text-[15px]">{children}</ul>
                                                        ),
                                                        ol: ({ children }) => (
                                                            <ol className="list-decimal pl-5 my-3 space-y-2 text-[14px] sm:text-[15px]">{children}</ol>
                                                        ),
                                                        li: ({ children }) => (
                                                            <li className="leading-7 pl-0.5 marker:text-slate-400">{children}</li>
                                                        ),
                                                        blockquote: ({ children }) => (
                                                            <blockquote className={`border-l-4 pl-4 my-4 italic ${isDark ? "border-amber-400/40 text-slate-300" : "border-amber-300 text-slate-600"}`}>
                                                                {children}
                                                            </blockquote>
                                                        ),
                                                        code: ({ children, className }) => {
                                                            const isBlock = Boolean(className);
                                                            if (isBlock) {
                                                                return <code className={className}>{children}</code>;
                                                            }
                                                            return (
                                                                <code
                                                                    className={`rounded-md px-1.5 py-0.5 text-[0.88em] font-mono ${
                                                                        isDark ? "bg-white/10 text-slate-100" : "bg-slate-100 text-slate-800"
                                                                    }`}
                                                                >
                                                                    {children}
                                                                </code>
                                                            );
                                                        },
                                                        pre: ({ children }) => (
                                                            <pre className={`overflow-x-auto rounded-xl border p-3.5 my-3 text-[12px] sm:text-[13px] leading-relaxed font-mono whitespace-pre-wrap wrap-break-word ${
                                                                isDark
                                                                    ? "bg-slate-950/50 border-white/10 text-slate-200"
                                                                    : "bg-slate-50 border-slate-200 text-slate-700"
                                                            }`}>
                                                                {children}
                                                            </pre>
                                                        ),
                                                        a: ({ href, children }) => {
                                                            const previewDocId = parseGeneratedPreviewDocumentId(href);
                                                            if (previewDocId) {
                                                                const previewUrl = generatedPreviewHref(previewDocId);
                                                                return (
                                                                    <a
                                                                        href={previewUrl}
                                                                        target="_blank"
                                                                        rel="noopener noreferrer"
                                                                        className={`underline underline-offset-2 font-semibold ${
                                                                            isDark
                                                                                ? "text-(--vb-blue-bright) hover:text-white"
                                                                                : "text-(--vb-blue-dark) hover:text-(--vb-blue)"
                                                                        }`}
                                                                        title="Open PDF in new tab"
                                                                    >
                                                                        {children}
                                                                    </a>
                                                                );
                                                            }
                                                            const isInternal = Boolean(href && href.startsWith("/"));
                                                            return (
                                                                <a
                                                                    href={href}
                                                                    className={`underline underline-offset-2 font-semibold ${
                                                                        isDark
                                                                            ? "text-(--vb-blue-bright) hover:text-white"
                                                                            : "text-(--vb-blue-dark) hover:text-(--vb-blue)"
                                                                    }`}
                                                                    {...(isInternal
                                                                        ? {}
                                                                        : { target: "_blank", rel: "noopener noreferrer" })}
                                                                >
                                                                    {children}
                                                                </a>
                                                            );
                                                        },
                                                    }}
                                                >
                                                    {formatAssistantMarkdown(msg.content)}
                                                </ReactMarkdown>
                                                )}
                                                {showInlineChart && msg.chartData && (
                                                    <ChatGraphRenderer chartData={msg.chartData} />
                                                )}
                                                {msg.agentId && (
                                                    <div className="mt-3">
                                                        <span className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-semibold ${agentColorMap[msg.agentId] || agentColorMap.other_agent}`}>
                                                            {agentLabel(msg.agentId)}
                                                        </span>
                                                    </div>
                                                )}
                                                {msg.aiProvider && (
                                                    <div className="mt-2 text-[10px] flex items-center gap-1 font-mono text-accent opacity-80">
                                                        <Sparkles size={10} /> Powered by {msg.aiProvider.toUpperCase()}{msg.aiModel ? ` (${msg.aiModel})` : ""}
                                                    </div>
                                                )}
                                                {msg.citations && msg.citations.length > 0 && (
                                                    <div className={`mt-5 pt-4 border-t ${isDark ? "border-white/10" : "border-slate-200"}`}>
                                                        <p className={`text-[10px] font-semibold uppercase tracking-[0.14em] mb-2.5 ${isDark ? "text-slate-400" : "text-slate-500"}`}>
                                                            Sources
                                                        </p>
                                                        <div className="flex flex-wrap gap-2">
                                                            {msg.citations.map((c, i) => {
                                                                const label = shortFileLabel(c.filename || "Document");
                                                                const fullName = c.filename || "Document";
                                                                const meta = citationMeta(c);
                                                                const generatedType = String(c.documentType || "").toLowerCase();
                                                                const generatedName = String(c.filename || "").toLowerCase();
                                                                const isGeneratedPdf =
                                                                    [
                                                                        "compliance_report",
                                                                        "finance_report",
                                                                        "hr_report",
                                                                        "hr_shortlist",
                                                                        "offer_letter",
                                                                        "experience_letter",
                                                                        "joining_letter",
                                                                        "internship_letter",
                                                                        "training_certificate",
                                                                        "promotion_letter",
                                                                        "warning_letter",
                                                                        "relieving_letter",
                                                                        "ncr_letter",
                                                                        "capa_letter",
                                                                        "certificate_of_compliance",
                                                                    ].includes(generatedType) ||
                                                                    /compliance[\s_-]?report/i.test(generatedName) ||
                                                                    /finance[\s_-]?report/i.test(generatedName) ||
                                                                    /offer[\s_-]?letter/i.test(generatedName) ||
                                                                    /experience[\s_-]?letter/i.test(generatedName) ||
                                                                    /joining[\s_-]?letter/i.test(generatedName) ||
                                                                    /internship[\s_-]?letter/i.test(generatedName);
                                                                const href = c.documentId
                                                                    ? isGeneratedPdf
                                                                        ? generatedPreviewHref(c.documentId)
                                                                        : `/documents/details?doc=${encodeURIComponent(c.documentId)}`
                                                                    : null;
                                                                const citeKey = `${msg.id}-${i}`;
                                                                const expanded = expandedCitation === citeKey;
                                                                const chipClass = `inline-flex items-center gap-1.5 text-[11px] rounded-lg px-2.5 py-1.5 border transition-colors ${
                                                                    href
                                                                        ? isDark
                                                                            ? "bg-white/5 border-white/10 text-slate-200 hover:border-(--vb-blue)/50 hover:bg-[rgba(56,182,255,0.1)] hover:text-(--vb-blue-bright)"
                                                                            : "bg-slate-50 border-slate-200 text-slate-700 hover:border-(--vb-blue) hover:bg-[rgba(56,182,255,0.1)] hover:text-(--vb-blue-dark)"
                                                                        : isDark
                                                                          ? "bg-white/5 border-white/10 text-slate-400 opacity-80"
                                                                          : "bg-slate-50 border-slate-200 text-slate-500 opacity-80"
                                                                }`;

                                                                const inner = (
                                                                    <>
                                                                        <FileText size={12} className="shrink-0 opacity-70" />
                                                                        <span className="truncate max-w-44 font-medium">{label}</span>
                                                                        {meta && (
                                                                            <span className="text-[10px] shrink-0 opacity-60">{meta}</span>
                                                                        )}
                                                                    </>
                                                                );

                                                                return (
                                                                    <div key={citeKey} className="flex flex-col max-w-full">
                                                                        {href ? (
                                                                            isGeneratedPdf ? (
                                                                                <a
                                                                                    href={href}
                                                                                    target="_blank"
                                                                                    rel="noopener noreferrer"
                                                                                    className={`${chipClass} cursor-pointer`}
                                                                                    title={`Open ${fullName} in new tab`}
                                                                                >
                                                                                    {inner}
                                                                                </a>
                                                                            ) : (
                                                                                <Link
                                                                                    href={href}
                                                                                    className={`${chipClass} cursor-pointer`}
                                                                                    title={`Open ${fullName}`}
                                                                                >
                                                                                    {inner}
                                                                                </Link>
                                                                            )
                                                                        ) : (
                                                                            <span className={chipClass} title={fullName}>
                                                                                {inner}
                                                                            </span>
                                                                        )}
                                                                        {c.snippet && (
                                                                            <button
                                                                                type="button"
                                                                                className="mt-1 ml-1 text-[10px] text-left text-accent hover:underline"
                                                                                onClick={() => setExpandedCitation(expanded ? null : citeKey)}
                                                                            >
                                                                                {expanded ? "Hide snippet" : "Show snippet"}
                                                                            </button>
                                                                        )}
                                                                        {expanded && c.snippet && (
                                                                            <div className={`mt-1.5 rounded-xl border p-3 text-xs leading-relaxed max-w-105 ${
                                                                                isDark ? "border-white/10 bg-white/5 text-slate-200" : "border-slate-200 bg-slate-50 text-slate-600"
                                                                            }`}>
                                                                                <p className="line-clamp-4 italic">&quot;{c.snippet}&quot;</p>
                                                                                {href && (
                                                                                    <Link href={href} className="inline-flex items-center gap-1 mt-2 text-[10px] text-accent hover:underline">
                                                                                        <FileText size={10} /> Open {shortFileLabel(fullName, 36)}
                                                                                    </Link>
                                                                                )}
                                                                            </div>
                                                                        )}
                                                                    </div>
                                                                );
                                                            })}
                                                        </div>
                                                    </div>
                                                )}
                                                </div>
                                            </div>
                                            {hasText &&
                                            msg.id !== "welcome" &&
                                            !isThinking ? (
                                            <div className="flex items-center flex-nowrap gap-0.5 h-8 shrink-0 -ml-1">
                                                    {messages[messages.length - 1]?.id === msg.id && (
                                                        <button
                                                            type="button"
                                                            onClick={regenerateLast}
                                                            disabled={sending || !hasRegenerablePrompt}
                                                            className={`group relative h-8 w-8 min-h-8 min-w-8 inline-flex items-center justify-center rounded-lg transition-colors disabled:opacity-40 ${
                                                                isDark
                                                                    ? "text-slate-400 hover:bg-white/10 hover:text-slate-200"
                                                                    : "text-slate-500 hover:bg-slate-100 hover:text-slate-700"
                                                            }`}
                                                            aria-label="Regenerate response"
                                                            title="Regenerate"
                                                        >
                                                            <RotateCcw size={15} className="shrink-0" />
                                                            <span className="pointer-events-none absolute left-1/2 top-full z-20 mt-1 -translate-x-1/2 whitespace-nowrap rounded-md bg-slate-900 px-2 py-1 text-[10px] font-medium text-white opacity-0 shadow-sm transition-opacity group-hover:opacity-100">
                                                                Regenerate
                                                            </span>
                                                        </button>
                                                    )}
                                                    <button
                                                        type="button"
                                                        onClick={() => copyReply(msg)}
                                                        className={`group relative h-8 w-8 min-h-8 min-w-8 inline-flex items-center justify-center rounded-lg transition-colors ${
                                                            isDark
                                                                ? "text-slate-400 hover:bg-white/10 hover:text-slate-200"
                                                                : "text-slate-500 hover:bg-slate-100 hover:text-slate-700"
                                                        }`}
                                                        aria-label="Copy reply"
                                                        title={copiedId === msg.id ? "Copied" : "Copy"}
                                                    >
                                                        {copiedId === msg.id ? <Check size={15} className="shrink-0" /> : <Copy size={15} className="shrink-0" />}
                                                        <span className="pointer-events-none absolute left-1/2 top-full z-20 mt-1 -translate-x-1/2 whitespace-nowrap rounded-md bg-slate-900 px-2 py-1 text-[10px] font-medium text-white opacity-0 shadow-sm transition-opacity group-hover:opacity-100">
                                                            {copiedId === msg.id ? "Copied" : "Copy"}
                                                        </span>
                                                    </button>
                                                    <button
                                                        type="button"
                                                        onClick={() => uploadReplyAsFile(msg)}
                                                        disabled={uploadingBusy || !(msg.content || "").trim()}
                                                        className={`group relative h-8 w-8 min-h-8 min-w-8 inline-flex items-center justify-center rounded-lg transition-colors disabled:opacity-50 ${
                                                            isDark
                                                                ? "text-slate-400 hover:bg-white/10 hover:text-slate-200"
                                                                : "text-slate-500 hover:bg-slate-100 hover:text-slate-700"
                                                        }`}
                                                        aria-label="Send reply to integration"
                                                        title="Send to integration"
                                                    >
                                                        {uploadingTxtId === msg.id ? (
                                                            <Loader2 size={15} className="shrink-0 animate-spin" />
                                                        ) : (
                                                            <Upload size={15} className="shrink-0" />
                                                        )}
                                                        <span className="pointer-events-none absolute left-1/2 top-full z-20 mt-1 -translate-x-1/2 whitespace-nowrap rounded-md bg-slate-900 px-2 py-1 text-[10px] font-medium text-white opacity-0 shadow-sm transition-opacity group-hover:opacity-100">
                                                            {uploadingTxtId === msg.id ? "Sending…" : "Send"}
                                                        </span>
                                                    </button>
                                                    <button
                                                        type="button"
                                                        onClick={() => toggleFeedback(msg, msgIdx, "like")}
                                                        className={`group relative h-8 w-8 min-h-8 min-w-8 inline-flex items-center justify-center rounded-lg transition-colors ${
                                                            feedbackState[msg.id] === "like"
                                                                ? "text-emerald-600 bg-emerald-50"
                                                                : isDark
                                                                  ? "text-slate-400 hover:bg-white/10 hover:text-slate-200"
                                                                  : "text-slate-500 hover:bg-slate-100 hover:text-slate-700"
                                                        }`}
                                                        aria-label="Thumbs up"
                                                        title="Good response"
                                                    >
                                                        <ThumbsUp size={15} fill={feedbackState[msg.id] === "like" ? "currentColor" : "none"} />
                                                        <span className="pointer-events-none absolute left-1/2 top-full z-20 mt-1 -translate-x-1/2 whitespace-nowrap rounded-md bg-slate-900 px-2 py-1 text-[10px] font-medium text-white opacity-0 shadow-sm transition-opacity group-hover:opacity-100">
                                                            Good response
                                                        </span>
                                                    </button>
                                                    <button
                                                        type="button"
                                                        onClick={() => toggleFeedback(msg, msgIdx, "dislike")}
                                                        className={`group relative h-8 w-8 min-h-8 min-w-8 inline-flex items-center justify-center rounded-lg transition-colors ${
                                                            feedbackState[msg.id] === "dislike"
                                                                ? "text-rose-600 bg-rose-50"
                                                                : isDark
                                                                  ? "text-slate-400 hover:bg-white/10 hover:text-slate-200"
                                                                  : "text-slate-500 hover:bg-slate-100 hover:text-slate-700"
                                                        }`}
                                                        aria-label="Thumbs down"
                                                        title="Bad response"
                                                    >
                                                        <ThumbsDown size={15} fill={feedbackState[msg.id] === "dislike" ? "currentColor" : "none"} />
                                                        <span className="pointer-events-none absolute left-1/2 top-full z-20 mt-1 -translate-x-1/2 whitespace-nowrap rounded-md bg-slate-900 px-2 py-1 text-[10px] font-medium text-white opacity-0 shadow-sm transition-opacity group-hover:opacity-100">
                                                            Bad response
                                                        </span>
                                                    </button>
                                            </div>
                                            ) : null}
                                        </div>
                                        </div>
                                        )
                                    ) : (
                                        <div
                                            className="max-w-[85%] sm:max-w-[75%] min-w-13 rounded-2xl rounded-br-md px-4 py-2.5 text-[15px] leading-relaxed font-medium"
                                            style={{
                                                background: "rgba(56,182,255,0.12)",
                                                color: "var(--vb-ink)",
                                                border: "1px solid rgba(56,182,255,0.28)",
                                                boxShadow: "var(--vb-shadow-sm)",
                                            }}
                                        >
                                            {msg.content}
                                        </div>
                                    )}
                                </div>
                                );
                            })
                        )}
                        {sending &&
                            (() => {
                                const last = messages[messages.length - 1];
                                // Inline Thinking… card already covers the empty assistant placeholder
                                if (last?.role === "assistant" && last.id !== "welcome" && !(last.content || "").trim()) {
                                    return null;
                                }
                                // While text is streaming in, don't show a second Thinking row
                                if (last?.role === "assistant" && (last.content || "").trim()) {
                                    return null;
                                }
                                return (
                            <div className="flex w-full min-w-0 gap-3 sm:gap-4" aria-live="polite" aria-label="Assistant is thinking">
                                <div
                                    className={`mt-0.5 h-8 w-8 shrink-0 rounded-full flex items-center justify-center ${
                                        isDark
                                            ? "bg-[rgba(56,182,255,0.15)] text-(--vb-blue-bright)"
                                            : "bg-[rgba(56,182,255,0.12)] text-(--vb-blue-dark)"
                                    }`}
                                    aria-hidden
                                >
                                    <Sparkles size={15} />
                                </div>
                                <div
                                    className={`rounded-2xl border px-4 py-3 shadow-sm ${
                                        isDark
                                            ? "bg-(--vb-dark-3) border-(--vb-hairline)"
                                            : "bg-(--vb-paper) border-(--vb-line) shadow-(--vb-shadow-sm)"
                                    }`}
                                >
                                    <p className={`text-[15px] m-0 animate-pulse ${isDark ? "text-(--vb-color-fg-inverse-muted)" : "text-(--vb-muted)"}`}>
                                        {agentIdFromScope ? `${agentLabel(agentIdFromScope)} Agent is thinking…` : "Thinking…"}
                                    </p>
                                </div>
                            </div>
                                );
                            })()}
                        <div ref={bottomRef} />
                    </div>
                </div>

                {focusedExcerpt && (
                    <div className="shrink-0 px-4 sm:px-6 lg:px-8 pt-2">
                        <div className={`${chatColumnMax} mx-auto flex items-start gap-2 p-2.5 rounded-xl bg-amber-500/10 border border-amber-500/25`}>
                            <MessageCircle size={14} className="text-amber-400 shrink-0 mt-0.5" />
                            <div className="min-w-0 flex-1">
                                <div className="text-[10px] font-semibold text-amber-400 uppercase tracking-wider mb-0.5">
                                    Asking about this selection
                                </div>
                                <div className={`text-xs line-clamp-2 italic ${colors.textMuted}`}>
                                    “{focusedExcerpt}”
                                </div>
                            </div>
                            <button
                                type="button"
                                onClick={() => setFocusedExcerpt("")}
                                className="shrink-0 text-amber-400 hover:text-rose-400 transition-colors"
                                aria-label="Clear selection"
                            >
                                <Trash2 size={13} />
                            </button>
                        </div>
                    </div>
                )}

                {selPopover && (
                    <button
                        type="button"
                        data-popover-btn
                        onClick={startExcerptQuestion}
                        style={{
                            position: "fixed",
                            left: selPopover.x,
                            top: selPopover.y,
                            transform: "translate(-50%, -100%)",
                        }}
                        className="z-50 px-3 py-1.5 rounded-lg bg-slate-900 text-white text-xs font-medium shadow-lg hover:bg-slate-800 transition-colors flex items-center gap-1.5"
                    >
                        <MessageCircle size={13} />
                        Ask about this
                    </button>
                )}

                <div className="px-4 sm:px-6 lg:px-8 py-4 border-t border-border shrink-0 bg-surface/80 backdrop-blur-sm">
                    <div className={`${chatColumnMax} mx-auto w-full space-y-2`}>
                        <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5">
                            <button
                                type="button"
                                onClick={toggleDocumentsRail}
                                className={`text-[11px] ${colors.textMuted} hover:text-accent inline-flex items-center gap-1.5 transition-colors`}
                            >
                                <FileText size={11} />
                                Searching: {scopeLabel}
                            </button>
                            <div className="flex flex-wrap items-center gap-2 sm:gap-3">
                                <label className={`inline-flex items-center gap-1.5 text-[11px] ${colors.textMuted}`}>
                                    <Sparkles size={11} className="text-accent shrink-0" />
                                    <span className="hidden sm:inline">Model:</span>
                                    <select
                                        value={selectedModelKey}
                                        onChange={(e) => setSelectedModelKey(e.target.value)}
                                        className={`rounded-lg border border-border bg-surface px-2 py-1 text-[11px] outline-none max-w-35 sm:max-w-50 truncate ${colors.textPrimary}`}
                                    >
                                        {modelOptions.length === 0 ? (
                                            <option value="">Default model</option>
                                        ) : (
                                            modelOptions.map((option) => (
                                                <option
                                                    key={`${option.provider}::${option.model}`}
                                                    value={`${option.provider}::${option.model}`}
                                                >
                                                    {option.label} · {option.model}
                                                </option>
                                            ))
                                        )}
                                    </select>
                                </label>
                                <Link
                                    href="/admin/settings"
                                    className="inline-flex items-center gap-1 text-[11px] text-accent hover:underline transition-colors"
                                >
                                    <Plus size={11} />
                                    Add model
                                </Link>
                            </div>
                        </div>
                        <ChatComposer
                            key="composer-v2-blue"
                            value={input}
                            onChange={setInput}
                            onSend={send}
                            onStop={stopSending}
                            sending={sending}
                            placeholder={
                                chatScope === "selected" && !selectedDocIds.length
                                    ? "Select documents in scope first…"
                                    : focusedExcerpt
                                      ? "Ask about the selected text…"
                                      : "Ask about your documents…"
                            }
                        />
                    </div>
                </div>
                    </div>

                    {showDocumentsRail && (
                        <>
                            <button
                                type="button"
                                className={`lg:hidden absolute inset-0 z-20 bg-black/40 backdrop-blur-[1px] transition-opacity ${
                                    !isLg ? "opacity-100 pointer-events-auto" : "opacity-0 pointer-events-none"
                                }`}
                                aria-label="Close documents"
                                onClick={closeDocumentsPanel}
                                tabIndex={!isLg ? 0 : -1}
                            />
                            <aside
                                className="hidden lg:flex flex-col min-h-0 h-full w-[280px] max-w-[30vw] shrink-0 overflow-hidden bg-surface border-l border-border"
                                aria-label="Documents"
                            >
                                <ChatScopePanel {...documentsScopePanelProps} />
                            </aside>
                            <aside
                                className="lg:hidden absolute inset-y-0 right-0 z-30 flex flex-col min-h-0 h-full w-[min(280px,85vw)] max-w-full overflow-hidden bg-surface border-l border-border shadow-xl"
                                aria-label="Documents"
                            >
                                <ChatScopePanel {...documentsScopePanelProps} />
                            </aside>
                        </>
                    )}
                </div>
            </div>

            <ChatAnalyticsSidePanel
                open={showAnalyticsRail}
                onClose={() => setAnalyticsPanelOpen(false)}
                agentId={analyticsAgentId || agentUrlParam}
                visuals={analyticsVisuals}
                isDark={isDark}
                onRunPrompt={(p) => void sendWithText(p)}
                loading={analyticsLoading}
                onRefresh={() => {
                    chatAnalyticsLockRef.current = false;
                    const aid = analyticsAgentId || agentUrlParam;
                    if (aid) void loadAgentAnalytics(aid, analyticsView, analyticsScopeDocIds);
                }}
                view={analyticsView}
                onViewChange={
                    agentUrlParam && ANALYTICS_AGENT_IDS.has(agentUrlParam)
                        ? handleAnalyticsViewChange
                        : undefined
                }
                visualsKey={analyticsVisuals.map((v) => v.id).join("|") || "empty"}
                documentCount={analyticsDocCount}
                unifiedHeader={showAnalyticsRail}
                scopeMode={analyticsScopeMode}
                coverage={analyticsCoverage}
                resolveFilename={(id) =>
                    libraryDocs.find((d) => d.documentId === id)?.originalFilename || id
                }
                scopeDocCount={analyticsScopeDocIds?.length}
                onApplyChatScope={(ids) => {
                    setChatScope("selected");
                    setSelectedDocIds(ids);
                    setChatContextDocIds(ids);
                    setDocumentsPanelOpen(false);
                }}
                onVisualAction={async (action) => {
                    if (action.kind === "open_document" && action.documentId) {
                        window.open(`/documents/${action.documentId}`, "_blank", "noopener,noreferrer");
                        return;
                    }
                    if (action.kind === "reprocess" && action.documentId) {
                        try {
                            await apiRequest(`/docs/documents/${action.documentId}/reprocess`, {
                                method: "POST",
                            });
                            void sendWithText(
                                `Reprocessing started for that invoice — I'll wait, then chart it again when ready.`
                            );
                        } catch (e: unknown) {
                            const msg = e instanceof Error ? e.message : "Reprocess failed";
                            void sendWithText(`Could not reprocess: ${msg}`);
                        }
                        return;
                    }
                    if (action.kind === "ask" && action.prompt) {
                        void sendWithText(action.prompt);
                    }
                }}
            />
            </div>
            </div>
        </div>
    );
}

export default function ChatPage() {
    return (
        <Suspense fallback={<div className="p-6 text-slate-400 font-medium">Loading AI Assistant...</div>}>
            <ChatContent />
        </Suspense>
    );
}
