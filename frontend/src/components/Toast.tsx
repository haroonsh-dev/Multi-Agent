"use client";

import React, { createContext, useContext, useState, useCallback, useRef, useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { CheckCircle2, AlertCircle, Info, X } from "lucide-react";

type ToastType = "success" | "error" | "info";

interface Toast {
    id: string;
    message: string;
    type: ToastType;
}

interface ToastContextType {
    showToast: (message: string, type?: ToastType) => void;
}

const ToastContext = createContext<ToastContextType | undefined>(undefined);

export function useToast() {
    const ctx = useContext(ToastContext);
    if (!ctx) throw new Error("useToast must be used within ToastProvider");
    return ctx;
}

export function ToastProvider({ children }: { children: React.ReactNode }) {
    const [toasts, setToasts] = useState<Toast[]>([]);
    const [isLightTheme, setIsLightTheme] = useState(false);
    const timers = useRef<Map<string, NodeJS.Timeout>>(new Map());

    useEffect(() => {
        const updateTheme = () => {
            setIsLightTheme(document.documentElement.getAttribute("data-theme") === "light");
        };

        updateTheme();
        const observer = new MutationObserver(updateTheme);
        observer.observe(document.documentElement, {
            attributes: true,
            attributeFilter: ["data-theme"],
        });

        return () => observer.disconnect();
    }, []);

    const removeToast = useCallback((id: string) => {
        setToasts((prev) => prev.filter((t) => t.id !== id));
        const timer = timers.current.get(id);
        if (timer) {
            clearTimeout(timer);
            timers.current.delete(id);
        }
    }, []);

    const showToast = useCallback((message: string, type: ToastType = "info") => {
        const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
        setToasts((prev) => [...prev.slice(-4), { id, message, type }]);

        const timer = setTimeout(() => removeToast(id), 5000);
        timers.current.set(id, timer);
    }, [removeToast]);

    const iconColors: Record<ToastType, string> = isLightTheme
        ? {
            success: "text-emerald-700",
            error: "text-rose-700",
            info: "text-(--vb-blue-dark)",
        }
        : {
            success: "text-emerald-300",
            error: "text-rose-300",
            info: "text-(--vb-blue-bright)",
        };

    const bgColors: Record<ToastType, string> = isLightTheme
        ? {
            success: "bg-emerald-50 border-emerald-200 border-l-[4px] border-l-emerald-600",
            error: "bg-rose-50 border-rose-200 border-l-[4px] border-l-rose-600",
            info: "bg-[rgba(56,182,255,0.1)] border-[rgba(56,182,255,0.28)] border-l-[4px] border-l-[var(--vb-blue)]",
        }
        : {
            success: "bg-emerald-500/10 border-emerald-500/25 border-l-[3px] border-l-emerald-400",
            error: "bg-rose-500/10 border-rose-500/25 border-l-[3px] border-l-rose-400",
            info: "bg-[rgba(56,182,255,0.1)] border-[rgba(56,182,255,0.25)] border-l-[3px] border-l-[var(--vb-blue-bright)]",
        };

    const textColors: Record<ToastType, string> = isLightTheme
        ? {
            success: "text-emerald-900",
            error: "text-rose-900",
            info: "text-(--vb-ink)",
        }
        : {
            success: "text-emerald-100",
            error: "text-rose-100",
            info: "text-(--vb-blue-bright)",
    };

    return (
        <ToastContext.Provider value={{ showToast }}>
            {children}
            <div className="fixed top-6 right-6 z-[99999] flex flex-col gap-3 pointer-events-none">
                <AnimatePresence>
                    {toasts.map((toast) => (
                        <motion.div
                            key={toast.id}
                            initial={{ opacity: 0, x: 80, scale: 0.95 }}
                            animate={{ opacity: 1, x: 0, scale: 1 }}
                            exit={{ opacity: 0, x: 80, scale: 0.95 }}
                            transition={{ type: "spring", stiffness: 400, damping: 30 }}
                            className={`pointer-events-auto flex items-center gap-3 px-5 py-4 rounded-xl border shadow-[0_10px_40px_-10px_rgba(0,0,0,0.15)] dark:shadow-[0_20px_60px_rgba(0,0,0,0.5)] dark:backdrop-blur-2xl max-w-[380px] ${bgColors[toast.type]}`}
                        >
                            {toast.type === "success" && <CheckCircle2 size={20} className={`${iconColors.success} shrink-0`} />}
                            {toast.type === "error" && <AlertCircle size={20} className={`${iconColors.error} shrink-0`} />}
                            {toast.type === "info" && <Info size={20} className={`${iconColors.info} shrink-0`} />}
                            <p className={`text-[15px] font-semibold leading-tight flex-1 ${textColors[toast.type]}`}>
                                {toast.message}
                            </p>
                            <button
                                onClick={() => removeToast(toast.id)}
                                className={`shrink-0 transition p-1 ${isLightTheme ? "text-slate-500 hover:text-slate-900" : "text-zinc-500 hover:text-white"}`}
                            >
                                <X size={14} />
                            </button>
                        </motion.div>
                    ))}
                </AnimatePresence>
            </div>
        </ToastContext.Provider>
    );
}
