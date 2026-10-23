"use client";

import React, {
    createContext,
    useCallback,
    useContext,
    useEffect,
    useMemo,
    useState,
    ReactNode,
} from "react";
import { AlertTriangle, ExternalLink, KeyRound, Timer } from "lucide-react";
import { apiRequest, ApiError, setGroqLimitHandler } from "@/lib/apiClient";

type GroqLimitInfo = {
    message?: string;
    retry_after_seconds?: number;
    until_ts?: number;
    console_url?: string;
    billing_url?: string;
};

type GroqLimitContextValue = {
    limited: boolean;
    openLimitModal: (info?: GroqLimitInfo) => void;
    clearLimit: () => void;
    secondsLeft: number;
};

const GroqLimitContext = createContext<GroqLimitContextValue | null>(null);

const STORAGE_KEY = "groq_rate_limit_until";

function formatCountdown(totalSeconds: number): string {
    const s = Math.max(0, totalSeconds);
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
}

export function GroqLimitProvider({ children }: { children: ReactNode }) {
    const [open, setOpen] = useState(false);
    const [info, setInfo] = useState<GroqLimitInfo>({});
    const [untilTs, setUntilTs] = useState<number>(0);
    const [secondsLeft, setSecondsLeft] = useState(0);
    const [apiKey, setApiKey] = useState("");
    const [saving, setSaving] = useState(false);
    const [saveError, setSaveError] = useState<string | null>(null);
    const [saveOk, setSaveOk] = useState<string | null>(null);

    const applyUntil = useCallback((until: number, nextInfo?: GroqLimitInfo) => {
        const ts = until > 0 ? until : Date.now() / 1000 + 24 * 3600;
        setUntilTs(ts);
        localStorage.setItem(STORAGE_KEY, String(ts));
        if (nextInfo) setInfo(nextInfo);
        setOpen(true);
        setSaveOk(null);
        setSaveError(null);
    }, []);

    const openLimitModal = useCallback(
        (next?: GroqLimitInfo) => {
            const until =
                next?.until_ts ||
                (next?.retry_after_seconds
                    ? Date.now() / 1000 + next.retry_after_seconds
                    : Date.now() / 1000 + 24 * 3600);
            applyUntil(until, next);
        },
        [applyUntil]
    );

    const clearLimit = useCallback(() => {
        setUntilTs(0);
        setSecondsLeft(0);
        localStorage.removeItem(STORAGE_KEY);
        setOpen(false);
        setApiKey("");
        setSaveError(null);
        setSaveOk(null);
    }, []);

    useEffect(() => {
        setGroqLimitHandler((payload) => {
            openLimitModal(payload);
        });
        return () => setGroqLimitHandler(null);
    }, [openLimitModal]);

    useEffect(() => {
        const stored = localStorage.getItem(STORAGE_KEY);
        if (stored) {
            const ts = parseFloat(stored);
            if (ts > Date.now() / 1000) {
                setUntilTs(ts);
                setOpen(true);
            } else {
                localStorage.removeItem(STORAGE_KEY);
            }
        }
        // Sync from server
        apiRequest("/docs/groq/status")
            .then((data) => {
                const st = data?.data;
                if (st?.limited) {
                    applyUntil(
                        st.until_ts || Date.now() / 1000 + (st.retry_after_seconds || 24 * 3600),
                        {
                            message: st.message,
                            retry_after_seconds: st.retry_after_seconds,
                            until_ts: st.until_ts,
                            console_url: st.console_url,
                            billing_url: st.billing_url,
                        }
                    );
                }
            })
            .catch(() => {
                /* ignore offline */
            });
    }, [applyUntil]);

    useEffect(() => {
        if (!untilTs) return;
        const tick = () => {
            const left = Math.max(0, Math.ceil(untilTs - Date.now() / 1000));
            setSecondsLeft(left);
            if (left <= 0) {
                clearLimit();
            }
        };
        tick();
        const id = setInterval(tick, 1000);
        return () => clearInterval(id);
    }, [untilTs, clearLimit]);

    const submitKey = async () => {
        setSaving(true);
        setSaveError(null);
        setSaveOk(null);
        try {
            await apiRequest("/docs/groq/api-key", {
                method: "POST",
                body: JSON.stringify({ api_key: apiKey.trim() }),
            });
            setSaveOk("API key saved. Groq is ready again.");
            clearLimit();
        } catch (e: any) {
            if (e instanceof ApiError && e.code === "GROQ_RATE_LIMIT") {
                setSaveError("That key may also be limited. Try another key.");
            } else {
                setSaveError(e.message || "Failed to save key");
            }
        } finally {
            setSaving(false);
        }
    };

    const value = useMemo(
        () => ({
            limited: open && secondsLeft > 0,
            openLimitModal,
            clearLimit,
            secondsLeft,
        }),
        [open, secondsLeft, openLimitModal, clearLimit]
    );

    const consoleUrl = info.console_url || "https://console.groq.com/keys";
    const billingUrl = info.billing_url || "https://console.groq.com/settings/billing";

    return (
        <GroqLimitContext.Provider value={value}>
            {children}
            {open && (
                <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm">
                    <div
                        className="w-full max-w-lg surface-card border border-border p-5 sm:p-6 space-y-4 shadow-2xl"
                        role="dialog"
                        aria-modal="true"
                        aria-labelledby="groq-limit-title"
                    >
                        <div className="flex items-start gap-3">
                            <div className="h-11 w-11 rounded-xl bg-amber-500/15 border border-amber-500/30 flex items-center justify-center text-amber-300 shrink-0">
                                <AlertTriangle size={20} />
                            </div>
                            <div className="min-w-0">
                                <h2
                                    id="groq-limit-title"
                                    className="text-lg font-bold text-foreground"
                                >
                                    Groq limit reached
                                </h2>
                                <p className="text-sm text-foreground-muted mt-1 leading-relaxed">
                                    Daily token limit for the AI model is finished. Upload, chat, and
                                    other Groq features are paused until you add a new API key or the
                                    cooldown ends.
                                </p>
                            </div>
                        </div>

                        <div className="rounded-xl border border-border bg-surface-2/60 px-4 py-3 flex items-center gap-3">
                            <Timer size={18} className="text-accent shrink-0" />
                            <div>
                                <p className="text-[10px] uppercase tracking-wider font-semibold text-foreground-muted">
                                    Try again in
                                </p>
                                <p className="text-2xl font-mono font-bold tabular-nums text-foreground">
                                    {formatCountdown(secondsLeft)}
                                </p>
                            </div>
                        </div>

                        <div className="space-y-2 text-sm">
                            <p className="text-foreground-secondary">
                                Create a Groq account, generate an API key, then paste it below:
                            </p>
                            <a
                                href={consoleUrl}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="inline-flex items-center gap-1.5 text-accent hover:underline font-medium"
                            >
                                Open Groq Console <ExternalLink size={14} />
                            </a>
                            <a
                                href={billingUrl}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="block text-xs text-foreground-muted hover:underline"
                            >
                                Or upgrade billing / Dev Tier
                            </a>
                        </div>

                        <div className="space-y-2">
                            <label className="text-[10px] uppercase tracking-wider font-semibold text-foreground-muted flex items-center gap-1.5">
                                <KeyRound size={12} /> New Groq API key
                            </label>
                            <input
                                type="password"
                                value={apiKey}
                                onChange={(e) => setApiKey(e.target.value)}
                                placeholder="gsk_…"
                                className="w-full premium-input rounded-xl px-4 py-2.5 text-sm font-mono"
                                autoComplete="off"
                            />
                            {saveError && <p className="text-sm text-rose-400">{saveError}</p>}
                            {saveOk && <p className="text-sm text-emerald-400">{saveOk}</p>}
                        </div>

                        <div className="flex flex-col sm:flex-row gap-2 pt-1">
                            <button
                                type="button"
                                onClick={submitKey}
                                disabled={saving || apiKey.trim().length < 10}
                                className="btn-gradient flex-1 rounded-xl py-2.5 text-sm disabled:opacity-50"
                            >
                                {saving ? "Saving…" : "Save key & unlock AI"}
                            </button>
                            <button
                                type="button"
                                onClick={() => setOpen(false)}
                                className="btn-secondary flex-1 rounded-xl py-2.5 text-sm"
                            >
                                Dismiss (timer keeps running)
                            </button>
                        </div>
                        <p className="text-[11px] text-foreground-muted">
                            Closing this dialog does not unlock AI. Any chat/upload using Groq will
                            show this screen again until the timer ends or a valid key is saved.
                        </p>
                    </div>
                </div>
            )}
        </GroqLimitContext.Provider>
    );
}

export function useGroqLimit() {
    const ctx = useContext(GroqLimitContext);
    if (!ctx) throw new Error("useGroqLimit must be used within GroqLimitProvider");
    return ctx;
}
