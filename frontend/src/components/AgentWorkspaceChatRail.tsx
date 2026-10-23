"use client";

import React, { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";
import Link from "next/link";
import { ExternalLink, Loader2, RotateCcw, Sparkles } from "lucide-react";
import WorkspaceChatMarkdown from "@/components/WorkspaceChatMarkdown";
import ChatComposer from "@/components/ChatComposer";
import type { AnalyticsAgentId } from "@/lib/documentAgents";
import { agentChatPath } from "@/lib/documentAgents";
import { AGENT_QUICK_ASKS } from "@/lib/agentWorkspace";
import { apiRequest } from "@/lib/apiClient";
import { cn } from "@/lib/utils";

type ChatMsg = { id: string; role: "user" | "assistant"; content: string };

type StoredSession = { sessionId: string | null; messages: ChatMsg[] };

type Props = {
    agentId: AnalyticsAgentId;
    shortName: string;
    accent: string;
    onAnalyticsReply?: () => void;
    className?: string;
};

export type AgentWorkspaceChatRailHandle = {
    sendPrompt: (text: string) => Promise<void>;
};

function storageKey(agentId: string) {
    return `vb-workspace-chat:${agentId}`;
}

const FOLLOW_UPS: Partial<Record<AnalyticsAgentId, string[]>> = {
    finance_agent: ["Show AP aging", "Break down by vendor", "Generate finance report"],
    hr_agent: ["Who is on leave?", "Certificates expiring?", "Generate HR report"],
    compliance_agent: ["Chart cert expiry", "Show critical findings"],
    legal_agent: ["Summarize risk flags", "Show missing clauses"],
    procurement_agent: ["Chart spend by supplier", "Unmatched POs"],
};

export default forwardRef<AgentWorkspaceChatRailHandle, Props>(function AgentWorkspaceChatRail(
    { agentId, shortName, accent, onAnalyticsReply, className },
    ref
) {
    const [messages, setMessages] = useState<ChatMsg[]>([]);
    const [input, setInput] = useState("");
    const [sending, setSending] = useState(false);
    const [sessionId, setSessionId] = useState<string | null>(null);
    const [hydrated, setHydrated] = useState(false);
    const scrollRef = useRef<HTMLDivElement>(null);
    const abortRef = useRef<AbortController | null>(null);

    useEffect(() => {
        try {
            const raw = sessionStorage.getItem(storageKey(agentId));
            if (raw) {
                const parsed = JSON.parse(raw) as StoredSession;
                setMessages(parsed.messages || []);
                setSessionId(parsed.sessionId || null);
            }
        } catch {
            /* ignore */
        }
        setHydrated(true);
    }, [agentId]);

    useEffect(() => {
        if (!hydrated) return;
        const payload: StoredSession = { sessionId, messages };
        sessionStorage.setItem(storageKey(agentId), JSON.stringify(payload));
    }, [agentId, sessionId, messages, hydrated]);

    const send = useCallback(
        async (text: string) => {
            const trimmed = text.trim();
            if (!trimmed || sending) return;
            setInput("");
            const userMsg: ChatMsg = { id: `u-${Date.now()}`, role: "user", content: trimmed };
            setMessages((m) => [...m, userMsg]);
            setSending(true);
            abortRef.current?.abort();
            abortRef.current = new AbortController();
            try {
                const body: Record<string, unknown> = {
                    message: trimmed,
                    phase3Agent: agentId,
                };
                if (sessionId) body.sessionId = sessionId;
                const data = await apiRequest("/docs/chat", {
                    method: "POST",
                    body: JSON.stringify(body),
                    signal: abortRef.current.signal,
                });
                if (data?.data?.sessionId) setSessionId(data.data.sessionId);
                const reply = String(data?.data?.reply || "No response.");
                setMessages((m) => [
                    ...m,
                    { id: `a-${Date.now()}`, role: "assistant", content: reply },
                ]);
                const shouldRefreshAnalytics =
                    data?.data?.model === "agent-analytics" ||
                    (Array.isArray(data?.data?.visuals) && data.data.visuals.length > 0) ||
                    (agentId === "hr_agent" &&
                        /\b(cv|resume|shortlist|rank|score|candidate|reprocess)/i.test(
                            `${trimmed} ${reply}`
                        ));
                if (shouldRefreshAnalytics) {
                    onAnalyticsReply?.();
                }
            } catch (e: unknown) {
                if (e instanceof Error && e.name === "AbortError") return;
                setMessages((m) => [
                    ...m,
                    {
                        id: `e-${Date.now()}`,
                        role: "assistant",
                        content: "Something went wrong. Try again or open full chat.",
                    },
                ]);
            } finally {
                setSending(false);
                requestAnimationFrame(() => {
                    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
                });
            }
        },
        [agentId, sending, sessionId, onAnalyticsReply]
    );

    useImperativeHandle(ref, () => ({ sendPrompt: send }), [send]);

    const clearChat = () => {
        setMessages([]);
        setSessionId(null);
        sessionStorage.removeItem(storageKey(agentId));
    };

    const suggestions = AGENT_QUICK_ASKS[agentId]?.slice(0, 3) || [];
    const followUps = FOLLOW_UPS[agentId] || [];
    const showFollowUps = messages.length > 0 && messages[messages.length - 1]?.role === "assistant" && !sending;

    return (
        <div
            className={cn(
                "flex flex-col h-full min-h-0 rounded-2xl border border-border overflow-hidden bg-surface/80 backdrop-blur-sm",
                className
            )}
        >
            <div className="shrink-0 px-3 py-2 border-b border-border flex items-center justify-between gap-2">
                <div className="flex items-center gap-2 min-w-0">
                    <Sparkles size={16} style={{ color: accent }} />
                    <div className="min-w-0">
                        <p className="text-xs font-bold text-foreground">Ask {shortName}</p>
                        <p className="text-[10px] text-foreground-muted truncate">Portfolio scope · session saved</p>
                    </div>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                    {messages.length > 0 && (
                        <button
                            type="button"
                            onClick={clearChat}
                            className="p-1.5 rounded-lg text-foreground-muted hover:text-foreground hover:bg-surface-2"
                            title="Clear chat"
                        >
                            <RotateCcw size={13} />
                        </button>
                    )}
                    <Link
                        href={sessionId ? `/chat?agent=${agentId}&session=${sessionId}` : agentChatPath(agentId)}
                        className="text-[10px] font-medium text-accent hover:underline inline-flex items-center gap-0.5"
                    >
                        Full chat <ExternalLink size={10} />
                    </Link>
                </div>
            </div>

            <div ref={scrollRef} className="flex-1 min-h-0 overflow-y-auto px-3 py-3 space-y-3">
                {!hydrated ? (
                    <div className="flex justify-center py-8">
                        <Loader2 size={20} className="animate-spin text-foreground-muted" />
                    </div>
                ) : messages.length === 0 ? (
                    <div className="text-center py-4 px-2">
                        <p className="text-xs text-foreground-muted mb-4">
                            Ask about your {shortName.toLowerCase()} documents, synced records, or open
                            tasks — charts refresh when you request analytics.
                        </p>
                        <div className="flex flex-col gap-1.5">
                            {suggestions.map((s) => (
                                <button
                                    key={s}
                                    type="button"
                                    onClick={() => void send(s)}
                                    className="text-left rounded-xl border border-border bg-background/60 px-3 py-2 text-[11px] font-medium hover:border-accent/40 hover:bg-accent-muted/20 transition-colors"
                                >
                                    {s}
                                </button>
                            ))}
                        </div>
                    </div>
                ) : (
                    messages.map((m) => (
                        <div
                            key={m.id}
                            className={cn(
                                "rounded-xl px-3 py-2 text-xs leading-relaxed min-w-0",
                                m.role === "user"
                                    ? "ml-auto max-w-[92%] bg-accent-muted text-foreground border border-accent/20"
                                    : "mr-auto w-full bg-surface-2 text-foreground border border-border"
                            )}
                        >
                            {m.role === "assistant" ? (
                                <WorkspaceChatMarkdown content={m.content} />
                            ) : (
                                m.content
                            )}
                        </div>
                    ))
                )}
                {showFollowUps && followUps.length > 0 && (
                    <div className="flex flex-wrap gap-1.5 pt-1">
                        {followUps.map((f) => (
                            <button
                                key={f}
                                type="button"
                                onClick={() => void send(f)}
                                className="rounded-full border border-border bg-background/80 px-2.5 py-1 text-[10px] font-medium hover:border-accent/40"
                            >
                                {f}
                            </button>
                        ))}
                    </div>
                )}
                {sending && (
                    <div className="flex items-center gap-2 text-xs text-foreground-muted px-2">
                        <Loader2 size={14} className="animate-spin" style={{ color: accent }} />
                        Thinking…
                    </div>
                )}
            </div>

            <div className="shrink-0 p-3 border-t border-border bg-surface/90">
                <ChatComposer
                    value={input}
                    onChange={setInput}
                    onSend={() => void send(input)}
                    sending={sending}
                    placeholder={`Ask ${shortName}…`}
                />
            </div>
        </div>
    );
});
