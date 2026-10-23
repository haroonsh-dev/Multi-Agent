"use client";

import React, { useEffect, useRef } from "react";
import { ArrowUp } from "lucide-react";

type ChatComposerProps = {
    value: string;
    onChange: (value: string) => void;
    onSend: () => void;
    onStop?: () => void;
    sending?: boolean;
    placeholder?: string;
    className?: string;
};

/** Chat composer — light professional send / stop with hover motion. */
export default function ChatComposer({
    value,
    onChange,
    onSend,
    onStop,
    sending = false,
    placeholder = "Ask about your documents…",
    className = "",
}: ChatComposerProps) {
    const textareaRef = useRef<HTMLTextAreaElement>(null);
    const shellRef = useRef<HTMLDivElement>(null);
    const canSend = Boolean(value.trim()) && !sending;

    useEffect(() => {
        const el = textareaRef.current;
        if (!el) return;
        el.style.height = "auto";
        el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
    }, [value]);

    const setShellFocus = (on: boolean) => {
        const shell = shellRef.current;
        if (!shell) return;
        shell.style.borderColor = on ? "#94a3b8" : "#e2e8f0";
        shell.style.boxShadow = on
            ? "0 6px 22px rgba(15,23,42,0.09)"
            : "0 4px 18px rgba(15,23,42,0.05)";
    };

    const btnBase: React.CSSProperties = {
        width: 36,
        height: 36,
        marginBottom: 2,
        borderRadius: 999,
        flexShrink: 0,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        transition:
            "background 0.18s ease, border-color 0.18s ease, color 0.18s ease, box-shadow 0.18s ease, transform 0.18s ease",
    };

    return (
        <div
            ref={shellRef}
            data-composer="v4-light"
            className={className}
            style={{
                display: "flex",
                alignItems: "flex-end",
                gap: 10,
                borderRadius: 26,
                border: "1px solid #e2e8f0",
                background: "#ffffff",
                padding: "10px 10px 10px 16px",
                boxShadow: "0 4px 18px rgba(15,23,42,0.05)",
                transition: "border-color 0.2s ease, box-shadow 0.2s ease",
            }}
        >
            <textarea
                ref={textareaRef}
                value={value}
                onChange={(e) => onChange(e.target.value)}
                onFocus={() => setShellFocus(true)}
                onBlur={() => setShellFocus(false)}
                onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey) {
                        e.preventDefault();
                        if (!canSend) return;
                        onSend();
                    }
                }}
                rows={1}
                placeholder={placeholder}
                style={{
                    flex: 1,
                    minHeight: 40,
                    maxHeight: 160,
                    resize: "none",
                    border: "none",
                    outline: "none",
                    background: "transparent",
                    padding: "8px 0",
                    fontSize: 15,
                    lineHeight: "24px",
                    color: "#0f172a",
                }}
            />

            {sending ? (
                <button
                    type="button"
                    onClick={onStop}
                    aria-label="Stop generating"
                    title="Stop generating"
                    onMouseEnter={(e) => {
                        const b = e.currentTarget;
                        b.style.background = "#f8fafc";
                        b.style.borderColor = "#94a3b8";
                        b.style.boxShadow = "0 4px 12px rgba(15,23,42,0.12)";
                        b.style.transform = "scale(1.06)";
                    }}
                    onMouseLeave={(e) => {
                        const b = e.currentTarget;
                        b.style.background = "#ffffff";
                        b.style.borderColor = "#cbd5e1";
                        b.style.boxShadow = "0 1px 3px rgba(15,23,42,0.08)";
                        b.style.transform = "scale(1)";
                    }}
                    onMouseDown={(e) => {
                        e.currentTarget.style.transform = "scale(0.94)";
                    }}
                    onMouseUp={(e) => {
                        e.currentTarget.style.transform = "scale(1.06)";
                    }}
                    style={{
                        ...btnBase,
                        border: "1px solid #cbd5e1",
                        cursor: "pointer",
                        background: "#ffffff",
                        boxShadow: "0 1px 3px rgba(15,23,42,0.08)",
                    }}
                >
                    <span
                        aria-hidden
                        style={{
                            display: "block",
                            width: 11,
                            height: 11,
                            borderRadius: 2,
                            background: "#334155",
                            transition: "background 0.18s ease",
                        }}
                    />
                </button>
            ) : (
                <button
                    type="button"
                    onClick={onSend}
                    disabled={!canSend}
                    aria-label="Send message"
                    title={canSend ? "Send message" : "Type a message to send"}
                    onMouseEnter={(e) => {
                        if (!canSend) return;
                        const b = e.currentTarget;
                        b.style.background = "#f8fafc";
                        b.style.borderColor = "#64748b";
                        b.style.color = "#020617";
                        b.style.boxShadow = "0 4px 12px rgba(15,23,42,0.12)";
                        b.style.transform = "scale(1.06)";
                    }}
                    onMouseLeave={(e) => {
                        const b = e.currentTarget;
                        b.style.background = canSend ? "#ffffff" : "#f8fafc";
                        b.style.borderColor = canSend ? "#cbd5e1" : "#e2e8f0";
                        b.style.color = canSend ? "#0f172a" : "#cbd5e1";
                        b.style.boxShadow = canSend ? "0 1px 3px rgba(15,23,42,0.08)" : "none";
                        b.style.transform = "scale(1)";
                    }}
                    onMouseDown={(e) => {
                        if (!canSend) return;
                        e.currentTarget.style.transform = "scale(0.94)";
                    }}
                    onMouseUp={(e) => {
                        if (!canSend) return;
                        e.currentTarget.style.transform = "scale(1.06)";
                    }}
                    style={{
                        ...btnBase,
                        border: canSend ? "1px solid #cbd5e1" : "1px solid #e2e8f0",
                        cursor: canSend ? "pointer" : "not-allowed",
                        background: canSend ? "#ffffff" : "#f8fafc",
                        color: canSend ? "#0f172a" : "#cbd5e1",
                        boxShadow: canSend ? "0 1px 3px rgba(15,23,42,0.08)" : "none",
                        transform: canSend ? "scale(1)" : "scale(0.98)",
                        opacity: canSend ? 1 : 0.85,
                    }}
                >
                    <ArrowUp size={18} strokeWidth={2.75} color="currentColor" />
                </button>
            )}
        </div>
    );
}
