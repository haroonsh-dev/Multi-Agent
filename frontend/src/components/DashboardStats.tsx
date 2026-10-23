"use client";

import React, { useEffect, useState } from "react";
import { motion } from "framer-motion";
import { FileText, CheckCircle, Clock, AlertTriangle } from "lucide-react";

type StatCard = {
    label: string;
    value: number | string;
    icon: React.ElementType;
    accent: string;
    iconBg: string;
    iconColor: string;
};

function AnimatedNumber({ value }: { value: number }) {
    const [display, setDisplay] = useState(0);
    useEffect(() => {
        if (value === 0) { setDisplay(0); return; }
        const duration = 800;
        const start = performance.now();
        const from = display;
        const animate = (now: number) => {
            const progress = Math.min((now - start) / duration, 1);
            const eased = 1 - Math.pow(1 - progress, 3);
            setDisplay(Math.round(from + (value - from) * eased));
            if (progress < 1) requestAnimationFrame(animate);
        };
        requestAnimationFrame(animate);
    }, [value]);
    return <>{display}</>;
}

type DashboardStatsProps = {
    stats?: { total?: number; processed?: number; processing?: number; failed?: number };
};

export default function DashboardStats({ stats }: DashboardStatsProps) {
    const cards: StatCard[] = [
        { label: "Total Documents", value: stats?.total ?? 0, icon: FileText, accent: "blue", iconBg: "bg-linear-to-br from-[rgba(56,182,255,0.08)] to-[rgba(63,116,255,0.06)]", iconColor: "text-(--vb-blue-dark)" },
        { label: "Processed", value: stats?.processed ?? 0, icon: CheckCircle, accent: "emerald", iconBg: "bg-linear-to-br from-emerald-50 to-green-50", iconColor: "text-emerald-600" },
        { label: "Processing", value: stats?.processing ?? 0, icon: Clock, accent: "amber", iconBg: "bg-linear-to-br from-amber-50 to-orange-50", iconColor: "text-amber-600" },
        { label: "Failed", value: stats?.failed ?? 0, icon: AlertTriangle, accent: "rose", iconBg: "bg-linear-to-br from-rose-50 to-red-50", iconColor: "text-rose-600" },
    ];

    return (
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
            {cards.map((card, i) => {
                const Icon = card.icon;
                return (
                    <motion.div
                        key={card.label}
                        initial={{ opacity: 0, y: 20, scale: 0.95 }}
                        animate={{ opacity: 1, y: 0, scale: 1 }}
                        transition={{ delay: i * 0.08, duration: 0.5, ease: [0.22, 1, 0.36, 1] }}
                        className={`stat-card ${card.accent} p-5`}
                    >
                        <div className="flex items-center gap-4">
                            <div className={`icon-box ${card.accent}`}>
                                <Icon size={22} />
                            </div>
                            <div className="min-w-0">
                                <p className="text-[11px] text-(--vb-muted) font-semibold uppercase tracking-[0.14em]">{card.label}</p>
                                <p className="text-2xl font-bold tracking-tight text-(--vb-ink) mt-1">
                                    {typeof card.value === "number" ? <AnimatedNumber value={card.value} /> : card.value}
                                </p>
                            </div>
                        </div>
                    </motion.div>
                );
            })}
        </div>
    );
}
