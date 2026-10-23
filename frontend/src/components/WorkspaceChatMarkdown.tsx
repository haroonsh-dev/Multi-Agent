"use client";

import React from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

type Props = {
    content: string;
    className?: string;
};

export default function WorkspaceChatMarkdown({ content, className }: Props) {
    return (
        <div className={className}>
            <ReactMarkdown
                remarkPlugins={[remarkGfm]}
                components={{
                    p: ({ children }) => <p className="mb-2 last:mb-0 leading-relaxed">{children}</p>,
                    strong: ({ children }) => <strong className="font-semibold text-inherit">{children}</strong>,
                    ul: ({ children }) => <ul className="list-disc pl-4 my-2 space-y-1">{children}</ul>,
                    ol: ({ children }) => <ol className="list-decimal pl-4 my-2 space-y-1">{children}</ol>,
                    li: ({ children }) => <li className="leading-relaxed">{children}</li>,
                    table: ({ children }) => (
                        <div className="my-2 overflow-x-auto rounded-lg border border-border bg-background/50">
                            <table className="min-w-max w-full border-collapse text-[11px]">{children}</table>
                        </div>
                    ),
                    thead: ({ children }) => <thead className="bg-surface-2/80">{children}</thead>,
                    th: ({ children }) => (
                        <th className="border-b border-border px-2.5 py-1.5 text-left text-[10px] font-semibold whitespace-nowrap text-foreground-muted">
                            {children}
                        </th>
                    ),
                    td: ({ children }) => (
                        <td className="border-b border-border/60 px-2.5 py-1.5 align-top text-[11px] leading-snug whitespace-nowrap">
                            {children}
                        </td>
                    ),
                    code: ({ children, className: codeClass }) => {
                        const isBlock = Boolean(codeClass);
                        if (isBlock) return <code className={codeClass}>{children}</code>;
                        return (
                            <code className="rounded px-1 py-0.5 text-[10px] font-mono bg-surface-2 text-foreground">
                                {children}
                            </code>
                        );
                    },
                    pre: ({ children }) => (
                        <pre className="my-2 overflow-x-auto rounded-lg border border-border bg-surface-2 p-2 text-[10px] leading-relaxed font-mono whitespace-pre-wrap">
                            {children}
                        </pre>
                    ),
                    a: ({ href, children }) => (
                        <a
                            href={href}
                            className="font-medium text-accent underline underline-offset-2"
                            target={href?.startsWith("/") ? undefined : "_blank"}
                            rel={href?.startsWith("/") ? undefined : "noopener noreferrer"}
                        >
                            {children}
                        </a>
                    ),
                }}
            >
                {content}
            </ReactMarkdown>
        </div>
    );
}
