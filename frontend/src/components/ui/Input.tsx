import React from "react";
import { cn } from "@/lib/utils";

type InputProps = React.InputHTMLAttributes<HTMLInputElement> & {
    label?: string;
    hint?: string;
};

export function Input({ className, label, hint, id, ...props }: InputProps) {
    const inputId = id || label?.toLowerCase().replace(/\s+/g, "-");
    return (
        <div className="space-y-1.5">
            {label && (
                <label htmlFor={inputId} className="block text-xs font-medium text-foreground-secondary">
                    {label}
                </label>
            )}
            <input
                id={inputId}
                className={cn(
                    "premium-input w-full h-10 px-3.5 text-sm",
                    className
                )}
                {...props}
            />
            {hint && <p className="text-[11px] text-foreground-muted">{hint}</p>}
        </div>
    );
}

type TextareaProps = React.TextareaHTMLAttributes<HTMLTextAreaElement> & {
    label?: string;
};

export function Textarea({ className, label, id, ...props }: TextareaProps) {
    const inputId = id || label?.toLowerCase().replace(/\s+/g, "-");
    return (
        <div className="space-y-1.5">
            {label && (
                <label htmlFor={inputId} className="block text-xs font-medium text-foreground-secondary">
                    {label}
                </label>
            )}
            <textarea
                id={inputId}
                className={cn("premium-input w-full px-3.5 py-2.5 text-sm min-h-[88px] resize-y", className)}
                {...props}
            />
        </div>
    );
}
