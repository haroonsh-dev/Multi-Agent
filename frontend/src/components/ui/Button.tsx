import React from "react";
import { cn } from "@/lib/utils";

type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";
type ButtonSize = "sm" | "md" | "lg";

type ButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement> & {
    variant?: ButtonVariant;
    size?: ButtonSize;
};

const variants: Record<ButtonVariant, string> = {
    primary:
        "bg-(--vb-color-primary-btn-bg) text-(--vb-color-primary-btn-fg) hover:bg-(--accent-hover) shadow-(--vb-glow) hover:shadow-(--vb-glow-strong)",
    secondary:
        "bg-(--btn-secondary-bg) border border-(--btn-secondary-border) text-(--btn-secondary-text) hover:bg-(--btn-secondary-hover-bg) hover:border-(--btn-secondary-hover-border) hover:text-(--btn-secondary-hover-text)",
    ghost:
        "bg-transparent text-foreground-muted hover:bg-accent-muted hover:text-(--vb-blue-dark)",
    danger:
        "bg-error-muted border border-[rgba(248,113,113,0.3)] text-error hover:bg-rose-500/20",
};

const sizes: Record<ButtonSize, string> = {
    sm: "h-8 px-3 text-xs gap-1.5 rounded-(--vb-radius-btn)",
    md: "h-10 px-4 text-sm gap-2 rounded-(--vb-radius-btn)",
    lg: "h-11 px-5 text-sm gap-2 rounded-(--vb-radius-btn)",
};

export function Button({
    className,
    variant = "primary",
    size = "md",
    type = "button",
    disabled,
    children,
    ...props
}: ButtonProps) {
    return (
        <button
            type={type}
            disabled={disabled}
            className={cn(
                "inline-flex items-center justify-center font-semibold tracking-tight transition-all duration-200 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed disabled:shadow-none",
                variants[variant],
                sizes[size],
                className
            )}
            {...props}
        >
            {children}
        </button>
    );
}
