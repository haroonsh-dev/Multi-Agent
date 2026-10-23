"use client";

import React, { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import Link from "next/link";
import { FileText, Loader2, X } from "lucide-react";
import { apiRequest, ApiError } from "@/lib/apiClient";

export type OfferLetterForm = {
    candidate_name: string;
    company_name: string;
    company_address: string;
    job_title: string;
    department: string;
    work_location: string;
    cnic: string;
    offered_salary: string;
    currency: string;
    pay_frequency: string;
    joining_date: string;
    offer_valid_until: string;
    probation_period: string;
    notice_period: string;
    letter_date: string;
    signatory_name: string;
    signatory_title: string;
    additional_notes: string;
    include_background: boolean;
};

const emptyForm = (): OfferLetterForm => ({
    candidate_name: "",
    company_name: "Company",
    company_address: "",
    job_title: "",
    department: "",
    work_location: "",
    cnic: "",
    offered_salary: "",
    currency: "PKR",
    pay_frequency: "Monthly",
    joining_date: "",
    offer_valid_until: "",
    probation_period: "3 months",
    notice_period: "30 days",
    letter_date: new Date().toISOString().slice(0, 10),
    signatory_name: "Human Resources",
    signatory_title: "Authorized Signatory",
    additional_notes: "",
    include_background: false,
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
    return e instanceof Error ? e.message : "Failed to generate offer letter";
}

function parseLocalDate(iso: string): Date | null {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso.trim());
    if (!m) return null;
    const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    return Number.isNaN(d.getTime()) ? null : d;
}

function todayLocal(): Date {
    const t = new Date();
    t.setHours(0, 0, 0, 0);
    return t;
}

function canSubmitForm(saving: boolean, loading: boolean): boolean {
    return !saving && !loading;
}

/** Fill missing dates and align joining / valid-until with letter date before submit. */
function normalizeFormDates(form: OfferLetterForm): OfferLetterForm {
    const letter = form.letter_date || new Date().toISOString().slice(0, 10);
    let joining = form.joining_date;
    let validUntil = form.offer_valid_until;
    if (!joining) joining = letter;
    if (!validUntil) validUntil = defaultValidUntil(letter);
    const letterD = parseLocalDate(letter);
    const joiningD = parseLocalDate(joining);
    const validD = parseLocalDate(validUntil);
    if (letterD && joiningD && joiningD < letterD) joining = letter;
    if (letterD && validD && validD < letterD) validUntil = defaultValidUntil(letter);
    return { ...form, letter_date: letter, joining_date: joining, offer_valid_until: validUntil };
}

/** Fill missing dates and defaults before submit. */
function normalizeFormForSubmit(form: OfferLetterForm): OfferLetterForm {
    const withDates = normalizeFormDates(form);
    return {
        ...withDates,
        company_name: withDates.company_name.trim() || "Company",
        job_title: withDates.job_title.trim() || "Role",
    };
}

function validateDates(form: OfferLetterForm): string | null {
    const letter = form.letter_date ? parseLocalDate(form.letter_date) : null;
    const joining = form.joining_date ? parseLocalDate(form.joining_date) : null;
    const validUntil = form.offer_valid_until ? parseLocalDate(form.offer_valid_until) : null;
    const today = todayLocal();
    if (letter && letter > today) {
        return "Letter date cannot be in the future.";
    }
    if (letter && joining && joining < letter) {
        return "Joining date must be on or after the letter date.";
    }
    if (letter && validUntil && validUntil < letter) {
        return "Offer valid-until must be on or after the letter date.";
    }
    return null;
}

function defaultValidUntil(letterDate: string): string {
    if (!letterDate) return "";
    const d = new Date(letterDate);
    if (Number.isNaN(d.getTime())) return "";
    d.setDate(d.getDate() + 11);
    return d.toISOString().slice(0, 10);
}

type Props = {
    open: boolean;
    onClose: () => void;
    documentId: string;
    resumeFilename?: string;
    onCreated?: (documentId: string) => void;
    /** Full-page layout (no modal overlay) */
    presentation?: "modal" | "page";
};

export default function OfferLetterModal({
    open,
    onClose,
    documentId,
    resumeFilename,
    onCreated,
    presentation = "modal",
}: Props) {
    const [form, setForm] = useState<OfferLetterForm>(emptyForm);
    const [loading, setLoading] = useState(false);
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [createdId, setCreatedId] = useState<string | null>(null);

    const loadPrefill = useCallback(async () => {
        setLoading(true);
        setError(null);
        setCreatedId(null);
        try {
            const res = await apiRequest(`/docs/documents/${documentId}/offer-letter/prefill`);
            const prefill = res?.data?.prefill || {};
            const orgName = (res?.data?.organizationName as string | undefined)?.trim();
            const letterDate = new Date().toISOString().slice(0, 10);
            setForm((prev) => ({
                ...prev,
                candidate_name: prefill.candidate_name || prev.candidate_name,
                job_title: prefill.job_title || prev.job_title,
                work_location: prefill.location || prev.work_location,
                cnic: prefill.cnic || prev.cnic,
                company_name: orgName || prev.company_name || "Company",
                letter_date: letterDate,
                joining_date: letterDate,
                offer_valid_until: defaultValidUntil(letterDate),
            }));
        } catch (e: unknown) {
            const msg = e instanceof Error ? e.message : "Could not load resume fields";
            setError(msg);
        } finally {
            setLoading(false);
        }
    }, [documentId]);

    useEffect(() => {
        if (!open && presentation === "modal") return;
        setForm(emptyForm());
        void loadPrefill();
    }, [open, loadPrefill, presentation]);

    useEffect(() => {
        if (presentation !== "modal" || !open) return;
        const onKeyDown = (e: KeyboardEvent) => {
            if (e.key === "Escape") onClose();
        };
        window.addEventListener("keydown", onKeyDown);
        return () => window.removeEventListener("keydown", onKeyDown);
    }, [presentation, open, onClose]);

    const update = (key: keyof OfferLetterForm, value: string | boolean) => {
        setForm((f) => {
            const next = { ...f, [key]: value };
            if (key === "letter_date" && typeof value === "string" && value && !f.offer_valid_until) {
                next.offer_valid_until = defaultValidUntil(value);
            }
            return next;
        });
    };

    const submit = async () => {
        const normalized = normalizeFormForSubmit(form);
        setForm(normalized);
        const dateErr = validateDates(normalized);
        if (dateErr) {
            setError(dateErr);
            return;
        }
        if (!normalized.candidate_name.trim()) {
            setError("Candidate name is required (fill manually if resume prefill failed).");
            return;
        }
        setSaving(true);
        setError(null);
        try {
            const offer: Record<string, unknown> = {
                ...normalized,
                offered_salary: normalized.offered_salary.trim()
                    ? Number(normalized.offered_salary.replace(/,/g, "")) || normalized.offered_salary
                    : null,
            };
            const res = await apiRequest(`/docs/documents/${documentId}/offer-letter/generate`, {
                method: "POST",
                body: JSON.stringify({ offer }),
            });
            const newId = res?.data?.document?.documentId as string | undefined;
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

    if (!open && presentation === "modal") return null;

    const detailsHref = (docId: string) => `/documents/${encodeURIComponent(docId)}`;

    const field = (
        label: string,
        key: keyof OfferLetterForm,
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
                Offer letter saved — open the PDF below to print or download.
            </p>
            <Link
                href={detailsHref(createdId)}
                className="btn-gradient inline-flex rounded-xl px-4 py-2 text-sm"
                onClick={onClose}
            >
                {form.candidate_name.trim()
                    ? `Offer letter — ${form.candidate_name.trim()}`
                    : "Open offer letter"}
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
            {error && <p className="text-sm text-rose-400">{error}</p>}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                {field("Candidate name", "candidate_name", { required: true })}
                {field("CNIC", "cnic", { placeholder: "12345-1234567-1" })}
                {field("Job title", "job_title", { required: true })}
                {field("Company", "company_name", { required: true, className: "sm:col-span-2" })}
                {field("Company address", "company_address", {
                    className: "sm:col-span-2",
                    placeholder: "City, Pakistan",
                })}
                {field("Department", "department")}
                {field("Work location", "work_location", { placeholder: "Lahore" })}
                {field("Gross salary", "offered_salary", { placeholder: "e.g. 150000" })}
                {field("Currency", "currency")}
                {field("Pay frequency", "pay_frequency")}
                {field("Joining date", "joining_date", { type: "date" })}
                {field("Offer valid until", "offer_valid_until", { type: "date" })}
                {field("Probation", "probation_period")}
                {field("Notice period", "notice_period")}
                {field("Letter date", "letter_date", { type: "date" })}
                {field("Signatory name", "signatory_name")}
                {field("Signatory title", "signatory_title")}
            </div>
            <label className="block space-y-1">
                <span className="text-xs font-semibold uppercase tracking-wide text-foreground-secondary">
                    Additional notes
                </span>
                <textarea
                    value={form.additional_notes}
                    onChange={(e) => update("additional_notes", e.target.value)}
                    rows={2}
                    className="w-full rounded-xl border border-border bg-background px-3 py-2 text-sm text-foreground resize-y"
                />
            </label>
            <label className="flex items-center gap-2 text-sm text-foreground-secondary">
                <input
                    type="checkbox"
                    checked={form.include_background}
                    onChange={(e) => update("include_background", e.target.checked)}
                    className="rounded border-border"
                />
                Include short resume background (may add a second page)
            </label>
            <div className="flex flex-col items-end gap-2 pt-1">
                {loading && (
                    <p className="text-xs text-foreground-secondary w-full text-left">
                        Wait for resume fields to finish loading, or fill the form manually if prefill failed.
                    </p>
                )}
                <div className="flex flex-wrap gap-2 justify-end w-full">
                    <button type="button" onClick={onClose} className="btn-secondary rounded-xl px-4 py-2 text-sm">
                        Cancel
                    </button>
                    <button
                        type="button"
                        onClick={() => void submit()}
                        disabled={!canSubmitForm(saving, loading)}
                        className="btn-gradient rounded-xl px-4 py-2 text-sm inline-flex items-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                        {saving ? <Loader2 size={14} className="animate-spin" /> : <FileText size={14} />}
                        {saving ? "Saving…" : loading ? "Loading…" : "Generate & save"}
                    </button>
                </div>
            </div>
        </>
    );

    const card = (
        <>
            <div className="flex items-start justify-between gap-3">
                <div>
                    <h2 id="offer-letter-modal-title" className="text-lg font-semibold text-foreground flex items-center gap-2">
                        <FileText size={18} className="text-(--vb-blue-bright)" />
                        Offer letter (Pakistan · 1 page)
                    </h2>
                    {resumeFilename && (
                        <p className="text-xs text-foreground-secondary mt-1 truncate">
                            From resume: {resumeFilename}
                        </p>
                    )}
                </div>
                <button
                    type="button"
                    onClick={onClose}
                    className="btn-ghost rounded-lg p-2 min-h-10 min-w-10 flex items-center justify-center"
                >
                    <X size={18} />
                </button>
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
                aria-labelledby="offer-letter-modal-title"
            >
                {card}
            </div>
        </div>,
        document.body
    );
}
