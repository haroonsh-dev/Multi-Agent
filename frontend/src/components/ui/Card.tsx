import React from "react";
import { cn } from "@/lib/utils";

type CardProps = React.HTMLAttributes<HTMLDivElement> & {
    hover?: boolean;
    padding?: "none" | "sm" | "md" | "lg";
};

const paddings = {
    none: "",
    sm: "p-3",
    md: "p-4",
    lg: "p-5",
};

export function Card({ className, hover, padding = "md", children, ...props }: CardProps) {
    return (
        <div
            className={cn(
                "surface-card overflow-hidden",
                paddings[padding],
                hover && "transition-colors duration-200 hover:border-border-strong",
                className
            )}
            {...props}
        >
            {children}
        </div>
    );
}

export function Panel({ className, children, ...props }: React.HTMLAttributes<HTMLDivElement>) {
    return (
        <div
            className={cn(
                "bg-surface border border-border rounded-(--radius-xl) overflow-hidden",
                className
            )}
            {...props}
        >
            {children}
        </div>
    );
}
