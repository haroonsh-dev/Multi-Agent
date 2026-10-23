import React from "react";
import { cn } from "@/lib/utils";

type BadgeVariant = "default" | "accent" | "success" | "warning" | "error" | "muted";

const variants: Record<BadgeVariant, string> = {
    default: "bg-surface-3 text-foreground-secondary border-border",
    accent: "bg-accent-muted text-(--vb-blue-dark) border-[rgba(56,182,255,0.28)]",
    success: "bg-(--success-muted) text-(--success) border-[rgba(52,211,153,0.25)]",
    warning: "bg-(--warning-muted) text-(--warning) border-[rgba(251,191,36,0.25)]",
    error: "bg-error-muted text-error border-[rgba(248,113,113,0.25)]",
    muted: "bg-white/[0.04] text-foreground-muted border-border",
};

export function Badge({
    className,
    variant = "default",
    children,
}: {
    className?: string;
    variant?: BadgeVariant;
    children: React.ReactNode;
}) {
    return (
        <span
            className={cn(
                "inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[11px] font-medium border whitespace-nowrap",
                variants[variant],
                className
            )}
        >
            {children}
        </span>
    );
}

export function StatusBadge({
    status,
    className,
}: {
    status: string;
    className?: string;
}) {
    const s = status.toLowerCase();
    let variant: BadgeVariant = "muted";
    if (s === "ready" || s === "processed" || s === "completed" || s === "complete" || s === "active") {
        variant = "success";
    } else if (s === "processing" || s === "uploaded" || s === "queued" || s === "running" || s === "pending") {
        variant = "warning";
    } else if (s === "failed" || s.includes("fail") || s.includes("error") || s === "inactive") {
        variant = "error";
    }
    return (
        <Badge variant={variant} className={className}>
            {status}
        </Badge>
    );
}
