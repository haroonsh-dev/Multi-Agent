"use client";

import React from "react";

interface DocuGemmaLogoProps {
    variant?: "dark" | "light" | "auto";
    size?: "sm" | "md" | "lg";
    iconOnly?: boolean;
    className?: string;
}

export default function DocuGemmaLogo({
    variant = "auto",
    size = "md",
    iconOnly = false,
    className = "",
}: DocuGemmaLogoProps) {
    const isLight = variant === "light";
    const height = size === "sm" ? 28 : size === "lg" ? 44 : 36;

    return (
        <div className={`flex items-center gap-2.5 select-none ${className}`}>
            {/* Gemma Neural Diamond Emblem */}
            <svg
                width={height}
                height={height}
                viewBox="0 0 48 48"
                fill="none"
                xmlns="http://www.w3.org/2000/svg"
                className="shrink-0 transition-transform hover:scale-105 duration-200"
            >
                <defs>
                    <linearGradient id="gemmaGrad1" x1="0%" y1="0%" x2="100%" y2="100%">
                        <stop offset="0%" stopColor="#38bdf8" />
                        <stop offset="50%" stopColor="#6366f1" />
                        <stop offset="100%" stopColor="#a855f7" />
                    </linearGradient>
                    <linearGradient id="gemmaGrad2" x1="100%" y1="0%" x2="0%" y2="100%">
                        <stop offset="0%" stopColor="#34d399" />
                        <stop offset="100%" stopColor="#38bdf8" />
                    </linearGradient>
                    <linearGradient id="gemInner" x1="0%" y1="100%" x2="100%" y2="0%">
                        <stop offset="0%" stopColor="#1e1b4b" stopOpacity="0.8" />
                        <stop offset="100%" stopColor="#312e81" stopOpacity="0.4" />
                    </linearGradient>
                    <filter id="glow" x="-20%" y="-20%" width="140%" height="140%">
                        <feGaussianBlur stdDeviation="2.5" result="blur" />
                        <feComposite in="SourceGraphic" in2="blur" operator="over" />
                    </filter>
                </defs>

                {/* Outer Facets */}
                <path
                    d="M24 4 L42 16 L42 32 L24 44 L6 32 L6 16 Z"
                    fill="url(#gemInner)"
                    stroke="url(#gemmaGrad1)"
                    strokeWidth="2"
                    strokeLinejoin="round"
                />

                {/* Internal Gem Facet Structure */}
                <path
                    d="M24 4 L24 44 M6 16 L42 16 M6 32 L42 32 M24 16 L42 32 M24 16 L6 32 M6 16 L24 44 M42 16 L24 44"
                    stroke="url(#gemmaGrad1)"
                    strokeWidth="1"
                    strokeOpacity="0.5"
                />

                {/* Center Core Neural Star */}
                <circle cx="24" cy="24" r="5" fill="url(#gemmaGrad2)" filter="url(#glow)" />
                <circle cx="24" cy="4" r="2.5" fill="#38bdf8" />
                <circle cx="42" cy="16" r="2.5" fill="#6366f1" />
                <circle cx="42" cy="32" r="2.5" fill="#a855f7" />
                <circle cx="24" cy="44" r="2.5" fill="#34d399" />
                <circle cx="6" cy="32" r="2.5" fill="#38bdf8" />
                <circle cx="6" cy="16" r="2.5" fill="#34d399" />
            </svg>

            {/* Typography */}
            {!iconOnly && (
                <div className="flex flex-col leading-none">
                    <div className="flex items-center gap-1.5">
                        <span
                            className={`font-black tracking-tight ${
                                size === "sm"
                                    ? "text-base"
                                    : size === "lg"
                                    ? "text-2xl"
                                    : "text-xl"
                            } ${
                                isLight
                                    ? "text-slate-900"
                                    : "text-white"
                            }`}
                            style={{ letterSpacing: "-0.03em" }}
                        >
                            Docu<span className="text-transparent bg-clip-text bg-gradient-to-r from-sky-400 via-indigo-400 to-emerald-400">Gemma</span>
                        </span>
                        <span className="text-[10px] font-extrabold uppercase px-1.5 py-0.5 rounded-md bg-gradient-to-r from-indigo-500/20 to-sky-500/20 text-sky-400 border border-sky-400/30 tracking-wider">
                            AI
                        </span>
                    </div>
                    <span className="text-[9px] font-semibold text-slate-400 tracking-wider uppercase mt-0.5">
                        Open-Weight Intelligence
                    </span>
                </div>
            )}
        </div>
    );
}
