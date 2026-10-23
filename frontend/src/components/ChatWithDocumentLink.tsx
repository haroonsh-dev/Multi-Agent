"use client";

import Link from "next/link";
import { Loader2, MessageCircle } from "lucide-react";
import { usePermissions } from "@/context/PermissionsContext";
import { cn } from "@/lib/utils";

type Props = {
    documentId: string;
    ready?: boolean;
    /** Hide entirely for generated PDFs (reports/letters) that never get AI indexing. */
    hidden?: boolean;
    compact?: boolean;
    className?: string;
};

export default function ChatWithDocumentLink({
    documentId,
    ready = true,
    hidden = false,
    compact = false,
    className,
}: Props) {
    const { canChat, canAccessPage } = usePermissions();
    if (hidden) return null;
    if (!canChat() || !canAccessPage("chat")) return null;

    const baseClass = cn(
        "rounded-lg px-3 py-2 text-xs inline-flex items-center justify-center gap-1.5 min-h-[36px] transition-colors",
        ready
            ? "border border-violet-200 bg-violet-50 text-violet-700 hover:bg-violet-100 hover:border-violet-300"
            : "border border-slate-200 bg-slate-50 text-slate-400 cursor-not-allowed",
        className
    );

    if (!ready) {
        return (
            <span
                className={baseClass}
                title="Chat will be available after this document finishes processing"
                aria-disabled="true"
            >
                <Loader2 size={13} className="animate-spin" />
                {!compact && "Processing"}
            </span>
        );
    }

    return (
        <Link
            href={`/chat?documentId=${encodeURIComponent(documentId)}`}
            className={baseClass}
            title="Chat with this document"
        >
            <MessageCircle size={13} />
            {!compact && "Chat"}
        </Link>
    );
}
