"use client";

import React from "react";
import { MessageSquare } from "lucide-react";
import { cn } from "@/lib/utils";

export type WorkspaceTabId = "home" | "charts" | "files" | "reports" | "fix" | "ask";

type TabDef = { id: WorkspaceTabId; label: string; icon: React.ElementType };

type Props = {
    tabs: TabDef[];
    mobileTabs?: TabDef[];
    active: WorkspaceTabId;
    accent: string;
    fixCount?: number;
    onChange: (id: WorkspaceTabId) => void;
};

function TabButton({
    id,
    label,
    icon: TabIcon,
    active,
    accent,
    fixCount,
    onChange,
}: TabDef & { active: WorkspaceTabId; accent: string; fixCount: number; onChange: (id: WorkspaceTabId) => void }) {
    const isActive = active === id;
    return (
        <button
            type="button"
            onClick={() => onChange(id)}
            className={cn(
                "relative inline-flex items-center gap-2 px-3.5 sm:px-4 py-2.5 text-sm font-medium rounded-xl transition-all shrink-0 border",
                isActive
                    ? "border-accent bg-accent-muted text-accent shadow-sm"
                    : "border-transparent text-foreground-muted hover:text-foreground hover:bg-surface-2/80"
            )}
        >
            <TabIcon size={15} className={isActive ? "opacity-100" : "opacity-70"} />
            {label}
            {id === "fix" && fixCount > 0 && (
                <span
                    className={cn(
                        "rounded-full px-1.5 py-0.5 text-[10px] font-bold tabular-nums",
                        isActive ? "bg-accent/15 text-accent" : "bg-amber-500/20 text-amber-700 dark:text-amber-400"
                    )}
                >
                    {fixCount}
                </span>
            )}
        </button>
    );
}

export default function AgentWorkspaceTabs({
    tabs,
    mobileTabs,
    active,
    accent,
    fixCount = 0,
    onChange,
}: Props) {
    const mobile = mobileTabs || tabs;

    return (
        <>
            <div className="lg:hidden flex gap-1.5 overflow-x-auto pb-1 scrollbar-none">
                {mobile.map((tab) => (
                    <TabButton
                        key={tab.id}
                        {...tab}
                        active={active}
                        accent={accent}
                        fixCount={fixCount}
                        onChange={onChange}
                    />
                ))}
            </div>
            <div className="hidden lg:flex gap-1.5 p-1 rounded-2xl border border-border/80 bg-surface/40 backdrop-blur-sm w-fit">
                {tabs.map((tab) => (
                    <TabButton
                        key={tab.id}
                        {...tab}
                        active={active}
                        accent={accent}
                        fixCount={fixCount}
                        onChange={onChange}
                    />
                ))}
            </div>
        </>
    );
}

export const MOBILE_ASK_TAB: TabDef = { id: "ask", label: "Ask", icon: MessageSquare };
