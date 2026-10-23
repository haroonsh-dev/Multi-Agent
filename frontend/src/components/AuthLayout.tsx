"use client";

import React from "react";
import Image from "next/image";
import { motion } from "framer-motion";
import { ArrowLeft } from "lucide-react";
import DocuGemmaLogo from "./DocuGemmaLogo";

interface AuthLayoutProps {
    children: React.ReactNode;
    onBack?: () => void;
    showBack?: boolean;
    wide?: boolean;
}

export default function AuthLayout({ children, onBack, showBack = false, wide = false }: AuthLayoutProps) {
    return (
        <div className="min-h-screen w-full flex flex-col p-4 sm:p-6 lg:p-8 relative overflow-x-hidden overflow-y-auto app-shell text-foreground">
            <div className="absolute inset-0 overflow-hidden pointer-events-none">
                <motion.div
                    animate={{ opacity: [0.12, 0.22, 0.12], scale: [1, 1.08, 1] }}
                    transition={{ duration: 14, repeat: Infinity, ease: "easeInOut" }}
                    className="absolute top-[-20%] left-1/2 -translate-x-1/2 w-[70%] h-[45%] rounded-full blur-[100px] bg-[rgba(56,182,255,0.2)]"
                />
                <motion.div
                    animate={{ opacity: [0.06, 0.14, 0.06] }}
                    transition={{ duration: 18, repeat: Infinity, ease: "easeInOut" }}
                    className="absolute bottom-[-8%] right-[-3%] w-[40%] h-[40%] rounded-full blur-[80px] bg-blue-500/15"
                />
                <div className="absolute inset-0 opacity-[0.03]"
                    style={{ backgroundImage: "linear-gradient(rgba(15,23,42,0.3) 1px, transparent 1px), linear-gradient(90deg, rgba(15,23,42,0.3) 1px, transparent 1px)", backgroundSize: "48px 48px" }}
                />
            </div>

            <div className={`w-full relative z-10 m-auto py-4 ${wide ? "max-w-7xl" : "max-w-md"}`}>
                {showBack && (
                    <motion.button
                        initial={{ opacity: 0, x: -8 }}
                        animate={{ opacity: 1, x: 0 }}
                        onClick={onBack}
                        className="mb-3 text-foreground-muted hover:text-accent transition-colors group inline-flex items-center gap-2"
                    >
                        <div className="h-8 w-8 rounded-lg border border-border flex items-center justify-center group-hover:border-accent group-hover:bg-accent-muted">
                            <ArrowLeft size={14} />
                        </div>
                        <span className="text-[9px] font-bold uppercase tracking-[0.2em] hidden sm:block">Back</span>
                    </motion.button>
                )}

                <div className="mb-4 text-center">
                    <motion.p
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        transition={{ delay: 0.1 }}
                        className="text-[10px] font-bold uppercase tracking-[0.2em] text-accent"
                    >
                        DocuGemma AI
                    </motion.p>
                    <motion.p
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        transition={{ delay: 0.18 }}
                        className="mt-1 text-xs text-foreground-muted"
                    >
                        Open-Weight Intelligence · Search · Automate
                    </motion.p>
                </div>

                <motion.div
                    initial={{ opacity: 0, y: 14 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ duration: 0.45, ease: [0.22, 1, 0.36, 1], delay: 0.05 }}
                    className="p-5 sm:p-7 sm:pt-6 rounded-2xl border border-slate-200 bg-white/90 backdrop-blur-xl shadow-[0_16px_48px_rgba(15,23,42,0.08)]"
                >
                    <div className="flex justify-center mb-4 sm:mb-5 -mt-1">
                        <DocuGemmaLogo variant="light" size="lg" />
                    </div>
                    {children}
                </motion.div>

                <motion.div
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    transition={{ delay: 0.4 }}
                    className="mt-5 text-center text-foreground-muted font-medium text-[9px] uppercase tracking-[0.2em]"
                >
                    DocuGemma — Open-Weight Document Intelligence © 2026
                </motion.div>
            </div>
        </div>
    );
}
