"use client";

import React from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import FilterSelect from "@/components/FilterSelect";

type LibraryPaginationProps = {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
    onPageChange: (page: number) => void;
    onLimitChange: (limit: number) => void;
    borderClass?: string;
    textMutedClass?: string;
};

const PAGE_SIZE_OPTIONS = [
    { value: "10", label: "10 / page" },
    { value: "20", label: "20 / page" },
    { value: "50", label: "50 / page" },
];

export default function LibraryPagination({
    page,
    limit,
    total,
    totalPages,
    onPageChange,
    onLimitChange,
    borderClass = "border-white/10",
    textMutedClass = "text-slate-400",
}: LibraryPaginationProps) {
    const safeTotalPages = Math.max(totalPages, 1);
    const start = total === 0 ? 0 : (page - 1) * limit + 1;
    const end = total === 0 ? 0 : Math.min(page * limit, total);

    return (
        <div className={`px-5 py-4 border-t ${borderClass} flex flex-wrap items-center justify-between gap-3`}>
            <div className={`text-sm ${textMutedClass}`}>
                Showing {start}–{end} of {total}
            </div>

            <div className="flex flex-wrap items-center gap-3">
                <FilterSelect
                    label="Per page"
                    hideLabel
                    menuPlacement="top"
                    value={String(limit)}
                    onChange={(v) => onLimitChange(parseInt(v, 10) || 10)}
                    options={PAGE_SIZE_OPTIONS}
                    minWidth="min-w-[120px]"
                />

                <div className="flex items-center gap-2">
                    <button
                        type="button"
                        disabled={page <= 1}
                        onClick={() => onPageChange(page - 1)}
                        className="btn-secondary rounded-lg px-3 py-2 text-sm flex items-center gap-1 disabled:opacity-40"
                    >
                        <ChevronLeft size={14} /> Prev
                    </button>
                    <span className={`text-sm min-w-[88px] text-center ${textMutedClass}`}>
                        Page {page} / {safeTotalPages}
                    </span>
                    <button
                        type="button"
                        disabled={page >= safeTotalPages || total === 0}
                        onClick={() => onPageChange(page + 1)}
                        className="btn-secondary rounded-lg px-3 py-2 text-sm flex items-center gap-1 disabled:opacity-40"
                    >
                        Next <ChevronRight size={14} />
                    </button>
                </div>
            </div>
        </div>
    );
}
