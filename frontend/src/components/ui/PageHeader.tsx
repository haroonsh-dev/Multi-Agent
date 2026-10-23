import React from "react";
import { cn } from "@/lib/utils";

export function PageHeader({
    title, subtitle, actions, className,
}: {
    title: string; subtitle?: string; actions?: React.ReactNode; className?: string;
}) {
    return (
        <div className={cn("flex flex-wrap items-end justify-between gap-4", className)}>
            <div className="min-w-0">
                <h1 className="font-display text-xl font-bold tracking-tight text-(--vb-ink)">{title}</h1>
                {subtitle && (
                    <p className="text-[13px] mt-1 text-(--vb-muted) leading-relaxed">{subtitle}</p>
                )}
            </div>
            {actions && <div className="flex flex-wrap items-center gap-2 shrink-0">{actions}</div>}
        </div>
    );
}

export function EmptyState({
    icon, title, description, action, className,
}: {
    icon?: React.ReactNode; title: string; description?: string; action?: React.ReactNode; className?: string;
}) {
    return (
        <div className={cn("flex flex-col items-center justify-center text-center py-16 px-6", className)}>
            {icon && (
                <div className="mb-4 w-12 h-12 rounded-2xl bg-accent-muted border border-[rgba(56,182,255,0.12)] flex items-center justify-center text-accent">
                    {icon}
                </div>
            )}
            <p className="text-base font-semibold text-foreground">{title}</p>
            {description && (
                <p className="text-[13px] mt-1.5 max-w-sm text-foreground-muted leading-relaxed">{description}</p>
            )}
            {action && <div className="mt-5">{action}</div>}
        </div>
    );
}

export function Toolbar({ children, className }: { children: React.ReactNode; className?: string }) {
    return (
        <div className={cn("flex flex-wrap items-center gap-2.5 p-4 border-b border-border", className)}>
            {children}
        </div>
    );
}
