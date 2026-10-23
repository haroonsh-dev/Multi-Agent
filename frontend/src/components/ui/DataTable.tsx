import React from "react";
import { cn } from "@/lib/utils";

export function DataTable({
    children,
    className,
}: {
    children: React.ReactNode;
    className?: string;
}) {
    return (
        <div className={cn("overflow-x-auto", className)}>
            <table className="w-full text-sm border-collapse">{children}</table>
        </div>
    );
}

export function THead({ children }: { children: React.ReactNode }) {
    return (
        <thead>
            <tr className="border-b border-border bg-surface-2/60">
                {children}
            </tr>
        </thead>
    );
}

export function Th({
    children,
    className,
}: {
    children?: React.ReactNode;
    className?: string;
}) {
    return (
        <th
            className={cn(
                "text-left text-[11px] font-semibold uppercase tracking-wider text-foreground-muted px-4 py-3",
                className
            )}
        >
            {children}
        </th>
    );
}

export function TBody({ children }: { children: React.ReactNode }) {
    return <tbody className="divide-y divide-border">{children}</tbody>;
}

export function Tr({
    children,
    className,
    onClick,
}: {
    children: React.ReactNode;
    className?: string;
    onClick?: () => void;
}) {
    return (
        <tr
            onClick={onClick}
            className={cn(
                "transition-colors duration-150 hover:bg-accent-muted/40",
                onClick && "cursor-pointer",
                className
            )}
        >
            {children}
        </tr>
    );
}

export function Td({
    children,
    className,
}: {
    children?: React.ReactNode;
    className?: string;
}) {
    return (
        <td className={cn("px-4 py-3.5 text-foreground-secondary align-middle", className)}>
            {children}
        </td>
    );
}
