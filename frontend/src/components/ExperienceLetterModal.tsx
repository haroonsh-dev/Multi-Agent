"use client";

import React, { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import Link from "next/link";
import { FileText, Loader2, X } from "lucide-react";
import { apiRequest, ApiError } from "@/lib/apiClient";

export type ExperienceLetterForm = {
    employee_name: string;
    company_name: string;
    company_address: string;
    job_title: string;
    department: string;
    cnic: string;
    employment_from: string;
    employment_to: string;
    duties_summary: string;
    reason_for_leaving: string;
    letter_date: string;
    signatory_name: string;
    signatory_title: string;
};

const emptyForm = (): ExperienceLetterForm => ({
    employee_name: "",
    company_name: "Company",
    company_address: "",
    job_title: "",
    department: "",
    cnic: "",
    employment_from: "",
    employment_to: "",
    duties_summary: "",
    reason_for_leaving: "",
    letter_date: new Date().toISOString().slice(0, 10),
    signatory_name: "Human Resources",
    signatory_title: "Authorized Signatory",
});

function formatSubmitError(e: unknown): string {
    if (e instanceof ApiError) {
        const d = e.data as { detail?: unknown; message?: string } | undefined;
        if (d?.message && typeof d.message === "string") return d.message;
        const detail = d?.detail;
        if (typeof detail === "string") return detail;
        if (Array.isArray(detail)) {
            return detail
                .map((item) =>
                    typeof item === "object" && item && "msg" in item
                        ? String((item as { msg: string }).msg)
                        : String(item)
                )
                .join("; ");
        }
        return e.message;
    }
    return e instanceof Error ? e.message : "Failed to generate experience certificate";
}

function parseLocalDate(iso: string): Date | null {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso.trim());
    if (!m) return null;
    const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    return Number.isNaN(d.getTime()) ? null : d;
}

function todayLocalIso(): string {
    const t = new Date();
    const y = t.getFullYear();
    const m = String(t.getMonth() + 1).padStart(2, "0");
    const d = String(t.getDate()).padStart(2, "0");
    return `${y}-${m}-${d}`;
}

function canSubmitForm(saving: boolean): boolean {
    return !saving;
}

function validateDates(form: ExperienceLetterForm): string | null {
    const letter = form.letter_date ? parseLocalDate(form.letter_date) : null;
    const from = form.employment_from ? parseLocalDate(form.employment_from) : null;
    const to = form.employment_to ? parseLocalDate(form.employment_to) : null;
    const today = parseLocalDate(todayLocalIso());
    if (letter && today && letter > today) {
        return "Letter date cannot be in the future.";
    }
    if (from && to && to < from) {
        return "Employment end date must be on or after the start date.";
    }
    return null;
}

type Props = {
    documentId: string;
    /** Prefer `open` (same as offer letter). `isOpen` kept for older call sites. */
    open?: boolean;
    isOpen?: boolean;
    onClose: () => void;
    resumeFilename?: string;
    onCreated?: (documentId: string) => void;
    presentation?: "modal" | "page";
};

export default function ExperienceLetterModal({
    documentId,
    open,
    isOpen,
    onClose,
    resumeFilename,
    onCreated,
    presentation = "page",
}: Props) {
    const visible = open ?? isOpen ?? true;

    const [form, setForm] = useState<ExperienceLetterForm>(emptyForm);
    const [loading, setLoading] = useState(false);
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [createdId, setCreatedId] = useState<string | null>(null);

    const loadPrefill = useCallback(async () => {
        if (!documentId) return;
        setLoading(true);
        setError(null);
        setCreatedId(null);
        try {
            const res = await apiRequest(`/docs/documents/${documentId}/experience-letter/prefill`);
            const prefill = res?.data?.prefill || {};
            const orgName = (res?.data?.organizationName as string | undefined)?.trim();
            const letterDate = todayLocalIso();
            setForm({
                employee_name: prefill.candidate_name || prefill.employee_name || "",
                company_name: orgName || prefill.company_name || "Company",
                company_address: prefill.company_address || "",
                job_title: prefill.job_title || prefill.current_title || "",
                department: prefill.department || "",
                cnic: prefill.cnic || "",
                employment_from: prefill.employment_from || "",
                employment_to: prefill.employment_to || "",
                duties_summary: prefill.duties_summary || "",
                reason_for_leaving: prefill.reason_for_leaving || "",
                letter_date: letterDate,
                signatory_name: "Human Resources",
                signatory_title: "Authorized Signatory",
            });
        } catch (e: unknown) {
            setError(formatSubmitError(e));
        } finally {
            setLoading(false);
        }
    }, [documentId]);

    useEffect(() => {
        if (!visible && presentation === "modal") return;
        setForm(emptyForm());
        void loadPrefill();
    }, [visible, loadPrefill, presentation, documentId]);

    useEffect(() => {
        if (presentation !== "modal" || !visible) return;
        const onKeyDown = (e: KeyboardEvent) => {
            if (e.key === "Escape") onClose();
        };
        window.addEventListener("keydown", onKeyDown);
        return () => window.removeEventListener("keydown", onKeyDown);
    }, [presentation, visible, onClose]);

    const update = (key: keyof ExperienceLetterForm, value: string) => {
        setForm((f) => ({ ...f, [key]: value }));
    };

    const submit = async () => {
        const dateErr = validateDates(form);
        if (dateErr) {
            setError(dateErr);
            return;
        }
        const employeeName = form.employee_name.trim();
        if (!employeeName) {
            setError("Employee name is required (fill manually if resume prefill failed).");
            return;
        }
        const payload: ExperienceLetterForm = {
            ...form,
            employee_name: employeeName,
            job_title: form.job_title.trim() || "Employee",
            company_name: form.company_name.trim() || "Company",
            letter_date: form.letter_date || todayLocalIso(),
        };
        setSaving(true);
        setError(null);
        try {
            const res = await apiRequest(`/docs/documents/${documentId}/experience-letter/generate`, {
                method: "POST",
                body: JSON.stringify({ experience: payload }),
                timeoutMs: 90_000,
            });
            const newId =
                (res?.data?.document?.documentId as string | undefined) ||
                (res?.data?.documentId as string | undefined);
            if (newId) {
                setCreatedId(newId);
                onCreated?.(newId);
            } else {
                setError(
                    "Server did not return the new document. Check api-gateway and ai-backend are running, then try again."
                );
            }
        } catch (e: unknown) {
            setError(formatSubmitError(e));
        } finally {
            setSaving(false);
        }
    };

    if (!visible && presentation === "modal") return null;

    const detailsHref = (docId: string) => `/documents/${encodeURIComponent(docId)}`;

    const field = (
        label: string,
        key: keyof ExperienceLetterForm,
        opts?: { type?: string; placeholder?: string; required?: boolean; className?: string }
    ) => (
        <label className={`block space-y-1 ${opts?.className || ""}`}>
            <span className="text-xs font-semibold uppercase tracking-wide text-foreground-secondary">
                {label}
                {opts?.required ? " *" : ""}
            </span>
            <input
                type={opts?.type || "text"}
                value={String(form[key])}
                onChange={(e) => update(key, e.target.value)}
                placeholder={opts?.placeholder}
                className="w-full rounded-xl border border-border bg-background px-3 py-2 text-sm text-foreground"
            />
        </label>
    );

    const formBody = createdId ? (
        <div className="space-y-3 text-sm">
            <p className="text-(--vb-blue-bright)">
                Experience certificate saved.
            </p>
            <Link
                href={detailsHref(createdId)}
                className="btn-gradient inline-flex rounded-xl px-4 py-2 text-sm"
                onClick={onClose}
            >
                {form.employee_name.trim()
                    ? `Experience letter — ${form.employee_name.trim()}`
                    : "Open experience letter"}
            </Link>
        </div>
    ) : (
        <>
            {loading && (
                <p className="text-sm text-foreground-secondary inline-flex items-center gap-2">
                    <Loader2 size={14} className="animate-spin" />
                    Loading fields from resume…
                </p>
            )}
            {error && (
                <p className="text-sm text-rose-400" role="alert">
                    {error}
                </p>
            )}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                {field("Employee name", "employee_name", { required: true })}
                {field("CNIC", "cnic", { placeholder: "12345-1234567-1" })}
                {field("Job title", "job_title", {
                    required: true,
                    placeholder: "e.g. Software Engineer",
                })}
                {field("Company", "company_name", { required: true, className: "sm:col-span-2" })}
                {field("Company address", "company_address", {
                    className: "sm:col-span-2",
                    placeholder: "City, Pakistan",
                })}
                {field("Department", "department")}
                {field("Employment from", "employment_from", { type: "date" })}
                {field("Employment to", "employment_to", { type: "date" })}
                {field("Letter date", "letter_date", { type: "date" })}
                {field("Signatory name", "signatory_name")}
                {field("Signatory title", "signatory_title")}
            </div>
            <label className="block space-y-1">
                <span className="text-xs font-semibold uppercase tracking-wide text-foreground-secondary">
                    Duties summary
                </span>
                <textarea
                    value={form.duties_summary}
                    onChange={(e) => update("duties_summary", e.target.value)}
                    rows={3}
                    className="w-full rounded-xl border border-border bg-background px-3 py-2 text-sm text-foreground resize-y"
                    placeholder="Key responsibilities from resume or HR notes…"
                />
            </label>
            <label className="block space-y-1">
                <span className="text-xs font-semibold uppercase tracking-wide text-foreground-secondary">
                    Reason for leaving (optional)
                </span>
                <input
                    type="text"
                    value={form.reason_for_leaving}
                    onChange={(e) => update("reason_for_leaving", e.target.value)}
                    className="w-full rounded-xl border border-border bg-background px-3 py-2 text-sm text-foreground"
                    placeholder="e.g. Resignation / end of contract"
                />
            </label>
            <div className="flex flex-col items-end gap-2 pt-1">
                {loading && (
                    <p className="text-xs text-foreground-secondary w-full text-left">
                        Prefill still loading — you can edit fields and generate anytime.
                    </p>
                )}
                <div className="flex flex-wrap gap-2 justify-end w-full">
                    <button type="button" onClick={onClose} className="btn-secondary rounded-xl px-4 py-2 text-sm">
                        Cancel
                    </button>
                    <button
                        type="button"
                        onClick={() => void submit()}
                        disabled={!canSubmitForm(saving)}
                        className="btn-gradient rounded-xl px-4 py-2 text-sm inline-flex items-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                        {saving ? <Loader2 size={14} className="animate-spin" /> : <FileText size={14} />}
                        {saving ? "Saving…" : "Generate & save"}
                    </button>
                </div>
            </div>
        </>
    );

    const card = (
        <>
            <div className="flex items-start justify-between gap-3">
                <div>
                    <h2 id="experience-letter-modal-title" className="text-lg font-semibold text-foreground flex items-center gap-2">
                        <FileText size={18} className="text-(--vb-blue-bright)" />
                        Experience certificate (Pakistan · 1 page)
                    </h2>
                    {resumeFilename && (
                        <p className="text-xs text-foreground-secondary mt-1 truncate">
                            From resume: {resumeFilename}
                        </p>
                    )}
                </div>
                {presentation === "modal" ? (
                    <button
                        type="button"
                        onClick={onClose}
                        className="btn-ghost rounded-lg p-2 min-h-10 min-w-10 flex items-center justify-center"
                    >
                        <X size={18} />
                    </button>
                ) : null}
            </div>
            {formBody}
        </>
    );

    if (presentation === "page") {
        return (
            <div className="w-full max-w-2xl mx-auto surface-card border border-border rounded-2xl shadow-xl p-5 sm:p-6 space-y-4">
                {card}
            </div>
        );
    }

    return createPortal(
        <div className="fixed inset-0 z-200 flex items-center justify-center p-4">
            <button
                type="button"
                className="absolute inset-0 bg-black/60"
                aria-label="Close"
                onClick={onClose}
            />
            <div
                className="relative z-10 w-full max-w-lg max-h-[90vh] overflow-y-auto surface-card border border-border rounded-2xl shadow-xl p-5 sm:p-6 space-y-4"
                role="dialog"
                aria-modal="true"
                aria-labelledby="experience-letter-modal-title"
            >
                {card}
            </div>
        </div>,
        document.body
    );
}
